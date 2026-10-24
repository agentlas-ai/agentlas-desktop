import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

/*
 * Keyed providers through the host: the owner's saved key is read in Main and sent only to that provider's own API host;
 * the model gets the result (a file, its digest, the provider's request id), never the key. One seam for every keyed
 * media provider (docs/2026-10-13-native-harness/17 §4 "api-adapter" transport), used by the harness ports
 * provider.request (any operation of an adapter) and speech.synthesize (typed narration).
 *
 * Why (dev replay r03 of the daily TCIagent graph, 2026-10-17): the Film teammate would not voice the long-form. The
 * step says to use the owner's saved connection through the native secure path; the harness answered
 * media.routes elevenlabs-audio = "adapter-required: no harness media job wired" and speech.synthesize = unknown
 * operation, so the only way left was the key in the shell, which the step forbids reading. Owner correction 2026-10-13:
 * this is the dead end of every tool that needs a key or a connection, not a voice problem, so the seam is generic.
 *
 * Access: the caller's run permission must allow spending (write/full) and the call is never made in a dry run; the
 * provider must be one the owner connected (its key saved in the vault, or present in Main's environment). Every call
 * appends a harness receipt without the key. The API host is fixed per adapter; a loopback override exists for gates only.
 */

export interface KeyedAdapter {
  routeId: string;
  label: string;
  base: string;
  envKey: string;
  auth: (key: string) => Record<string, string>;
  extraHeaders?: Record<string, string>;
}

/** Adapters with their provider's documented API host and auth scheme (docsUrl in shared/multimodal.ts). */
export const KEYED_ADAPTERS: Readonly<Record<string, KeyedAdapter>> = Object.freeze({
  "elevenlabs-audio": { routeId: "elevenlabs-audio", label: "ElevenLabs", base: "https://api.elevenlabs.io", envKey: "ELEVENLABS_API_KEY", auth: (key) => ({ "xi-api-key": key }) },
  "openai-audio": { routeId: "openai-audio", label: "OpenAI audio", base: "https://api.openai.com", envKey: "OPENAI_API_KEY", auth: (key) => ({ Authorization: `Bearer ${key}` }) },
  "deepgram-audio": { routeId: "deepgram-audio", label: "Deepgram", base: "https://api.deepgram.com", envKey: "DEEPGRAM_API_KEY", auth: (key) => ({ Authorization: `Token ${key}` }) },
  "stability-image": { routeId: "stability-image", label: "Stability AI", base: "https://api.stability.ai", envKey: "STABILITY_API_KEY", auth: (key) => ({ Authorization: `Bearer ${key}` }) },
  "replicate-video": { routeId: "replicate-video", label: "Replicate", base: "https://api.replicate.com", envKey: "REPLICATE_API_TOKEN", auth: (key) => ({ Authorization: `Bearer ${key}` }) },
  "runway-video": { routeId: "runway-video", label: "Runway", base: "https://api.dev.runwayml.com", envKey: "RUNWAY_API_KEY", auth: (key) => ({ Authorization: `Bearer ${key}` }), extraHeaders: { "X-Runway-Version": "2024-11-06" } },
});

/** Routes with a typed speech.synthesize adapter. */
export const SPEECH_ROUTES = Object.freeze(["elevenlabs-audio", "openai-audio"] as const);
/** Routes with a typed speech.transcribe adapter (word timings): ElevenLabs Scribe, OpenAI Whisper, Deepgram. */
export const TRANSCRIBE_ROUTES = Object.freeze(["elevenlabs-audio", "openai-audio", "deepgram-audio"] as const);

/** produced: the file this answer hands over (harness/run-produced-files.ts binds it as the run's output); never in the result. */
type Outcome = { status: "ok"; data: unknown; produced?: readonly string[] } | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };
const ok = (data: unknown): Outcome => ({ status: "ok", data });
const refused = (reason: string, next?: string): Outcome => ({ status: "refused", reason, ...(next ? { next } : {}) });
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export interface KeyedCallContext { chatId: string; runId: string; dryRun?: boolean; permission?: "read" | "write" | "full" }

/*
 * A provider call can outlast one tool request: the agentlas-turn gateway gives a call 30 s (turn-tools/mcp-server.ts).
 * Dev replay r04 (2026-10-17): a 4,901-character ElevenLabs narration took ~45 s; Main finished and wrote the file and
 * its receipt, but the teammate was told "Turn tool request timed out." So a call answers within ANSWER_WINDOW_MS: done
 * → the result; still running → state "running" and the same arguments again later return the finished result. The work
 * keeps running in Main either way, and the same request never starts a second provider call (no double spend).
 */
export const ANSWER_WINDOW_MS = 25_000;
const inflight = new Map<string, Promise<Outcome>>();
const finished = new Map<string, { outcome: Outcome; at: number }>();
const FINISHED_KEEP_MS = 6 * 60 * 60_000;
let answerWindowMs = ANSWER_WINDOW_MS;
/** Contract gates only: a short answer window. */
export function setKeyedAnswerWindowForTests(ms: number): void { answerWindowMs = Math.max(10, ms); }

async function answerWithin(key: string, start: () => Promise<Outcome>, running: () => Outcome, windowMs = answerWindowMs): Promise<Outcome> {
  const now = Date.now();
  for (const [k, v] of finished) if (now - v.at > FINISHED_KEEP_MS) finished.delete(k);
  const done = finished.get(key);
  if (done) return done.outcome;
  let job = inflight.get(key);
  if (!job) {
    job = start().then((outcome) => { if (outcome.status === "ok") finished.set(key, { outcome, at: Date.now() }); return outcome; })
      .finally(() => { inflight.delete(key); });
    inflight.set(key, job);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const windowEnd = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), windowMs); });
  const first = await Promise.race([job, windowEnd]);
  if (timer) clearTimeout(timer);
  return first ?? running();
}

/** Gate-only API host override: loopback http, read from Main's environment, never from the model. */
function apiBase(adapter: KeyedAdapter): string {
  const override = process.env.AGENTLAS_KEYED_PROVIDER_TEST_BASE?.trim();
  return override && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(override) ? override : adapter.base;
}

async function providerKey(adapter: KeyedAdapter): Promise<string | null> {
  try {
    const { readEnvVarAliased } = await import("../secrets/env-alias");
    const saved = await readEnvVarAliased(adapter.envKey);
    if (saved) return saved;
  } catch { /* no vault in this host: fall back to Main's environment */ }
  const env = process.env[adapter.envKey];
  return typeof env === "string" && env.trim() ? env.trim() : null;
}

function admit(ctx: KeyedCallContext, routeId: string): { adapter: KeyedAdapter } | Outcome {
  const adapter = KEYED_ADAPTERS[routeId];
  if (!adapter) return refused("route_not_keyed_adapter", `keyed adapters: ${Object.keys(KEYED_ADAPTERS).join(", ")}`);
  if (ctx.dryRun) return refused("dry_run");
  if (ctx.permission !== "write" && ctx.permission !== "full") return refused("spend_permission_required", "this run's permission is read; a provider call writes a file and spends the owner's credits");
  return { adapter };
}

/** Typed provider failure from the HTTP status and the provider's own error body (never the key). */
function failure(status: number, body: string): { reason: string; outcome: string; detail: string } {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { detail?: { status?: string; message?: string } | string; error?: { message?: string; code?: string } | string; message?: string };
    const d = parsed.detail; const e = parsed.error;
    detail = (typeof d === "object" && d ? [d.status, d.message] : [typeof d === "string" ? d : null, typeof e === "object" && e ? e.message : typeof e === "string" ? e : parsed.message])
      .filter(Boolean).join(": ").slice(0, 300) || detail;
  } catch { /* plain text body */ }
  const quota = /quota|credit|limit_exceeded|insufficient/i.test(detail);
  if (status === 401 || status === 403) return { reason: "provider_auth_failed", outcome: "authentication_required", detail };
  if (status === 402 || (status === 429 && quota)) return { reason: "provider_quota_exhausted", outcome: "quota_exhausted", detail };
  if (status === 429) return { reason: "provider_rate_limited", outcome: "unavailable", detail };
  if (status >= 500) return { reason: "provider_unavailable", outcome: "unavailable", detail };
  return { reason: `provider_request_rejected_${status}`, outcome: "unavailable", detail };
}

async function observe(routeId: string, outcome: string, via: string): Promise<void> {
  try { const { recordReadinessObservation } = await import("./readiness-observations"); await recordReadinessObservation({ subject: "media-route", id: routeId, outcome: outcome as "ok", via }); }
  catch { /* observation is best effort */ }
}

async function receipt(entry: Record<string, unknown>): Promise<string | null> {
  try { const { appendReceipt } = await import("./capability-ports"); return await appendReceipt(entry); }
  catch { return null; }
}

function safeOutputFile(outputDir: string, fileName: string): string | null {
  if (!path.isAbsolute(outputDir) || outputDir.split(path.sep).includes("..")) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(fileName)) return null;
  return path.join(outputDir, fileName);
}

interface SendResult { status: number; headers: Headers; body: Buffer }

/** Multipart or raw-body upload to an adapter's own host (speech.transcribe). */
async function sendBody(adapter: KeyedAdapter, key: string, input: { pathAndQuery: string; body: FormData | Buffer; contentType?: string; timeoutMs?: number }): Promise<SendResult | { networkError: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("provider_timeout")), input.timeoutMs ?? 300_000);
  try {
    const res = await fetch(`${apiBase(adapter)}${input.pathAndQuery}`, {
      method: "POST",
      headers: { ...adapter.auth(key), ...(adapter.extraHeaders ?? {}), ...(input.contentType ? { "Content-Type": input.contentType } : {}), Accept: "application/json" },
      body: input.body as BodyInit,
      signal: controller.signal,
    });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } catch (error) {
    return { networkError: error instanceof Error ? error.message.slice(0, 200) : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscriptWord { text: string; start: number; end: number }
export interface Transcript { routeId: string; modelId: string; text: string; words: TranscriptWord[]; language: string | null; requestId: string | null }

/*
 * A local media tool (ffmpeg, ffprobe) with spawnSync's { status, stdout, stderr } but without blocking the host's event
 * loop. Perf review MP-02 (2026-10-17): media.listen ran ffmpeg with spawnSync in Main or the daemon, so IPC, the control
 * socket and every timer froze for the whole run (a 7 min 1080p cut: 5.2 s per call, 8+ calls per film). Same timeout,
 * kill signal, maxBuffer and closed stdin as spawnSync; a missing tool or a kill gives status null as before.
 */
/**
 * ffmpeg/ffprobe the way media-quality and output-verification find them: PATH, then the usual install folders. The
 * Dock-launched app's PATH is /usr/bin:/bin:/usr/sbin:/sbin, so a bare "ffmpeg" never ran there and every media.listen
 * in the production app failed (reported as audio_track_unavailable, Yotube 2026-10-17: three refusals in one turn).
 */
export function mediaEngineBin(name: "ffmpeg" | "ffprobe"): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

export function runTool(bin: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (bin === "ffmpeg" || bin === "ffprobe") {
    const resolved = mediaEngineBin(bin);
    if (!resolved) return Promise.resolve({ status: null, stdout: "", stderr: "media_engine_missing" });
    bin = resolved;
  }
  return new Promise((resolve) => {
    const child = execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code: unknown = error ? (error as { code?: unknown }).code : 0;
      resolve({ status: typeof code === "number" ? code : null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.end();
  });
}

/** A compact mono speech track of any local audio/video file (ffmpeg); null when ffmpeg is missing or fails. */
export async function speechTrack(input: string, workDir: string): Promise<string | null> {
  const out = path.join(workDir, `speech-${sha(input + fs.statSync(input).mtimeMs).slice(0, 12)}.mp3`);
  try {
    const r = await runTool("ffmpeg", ["-v", "error", "-y", "-protocol_whitelist", "file", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out], 180_000);
    return r.status === 0 && fs.existsSync(out) ? out : null;
  } catch { return null; }
}

/** Word-timed transcript of one audio file through a keyed adapter (the key stays in Main). */
export async function transcribeFile(routeId: string, audioFile: string, ctx: KeyedCallContext, languageCode?: string): Promise<{ ok: true; transcript: Transcript } | { ok: false; outcome: Outcome }> {
  if (!(TRANSCRIBE_ROUTES as readonly string[]).includes(routeId)) return { ok: false, outcome: refused("route_not_transcribe_capable", `transcribe routes: ${TRANSCRIBE_ROUTES.join(", ")}`) };
  const admitted = admit(ctx, routeId);
  if (!("adapter" in admitted)) return { ok: false, outcome: admitted };
  const { adapter } = admitted;
  const key = await providerKey(adapter);
  if (!key) return { ok: false, outcome: refused("provider_key_missing", `the owner saves ${adapter.envKey} for ${adapter.label} in Settings`) };
  const bytes = fs.readFileSync(audioFile);
  let res: SendResult | { networkError: string }; let modelId: string;
  if (routeId === "deepgram-audio") {
    modelId = "nova-3";
    res = await sendBody(adapter, key, { pathAndQuery: `/v1/listen?model=${modelId}&smart_format=true&punctuate=true${languageCode ? `&language=${encodeURIComponent(languageCode)}` : ""}`, body: bytes, contentType: "audio/mpeg" });
  } else {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(audioFile));
    if (routeId === "elevenlabs-audio") {
      modelId = "scribe_v1";
      form.append("model_id", modelId); form.append("timestamps_granularity", "word"); form.append("tag_audio_events", "false");
      if (languageCode) form.append("language_code", languageCode);
      res = await sendBody(adapter, key, { pathAndQuery: "/v1/speech-to-text", body: form });
    } else {
      modelId = "whisper-1";
      form.append("model", modelId); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "word");
      if (languageCode) form.append("language", languageCode);
      res = await sendBody(adapter, key, { pathAndQuery: "/v1/audio/transcriptions", body: form });
    }
  }
  if ("networkError" in res) { await observe(routeId, "unavailable", "speech.transcribe"); return { ok: false, outcome: refused("provider_unreachable", res.networkError) }; }
  const requestId = requestIdOf(res.headers);
  if (res.status < 200 || res.status >= 300) {
    const f = failure(res.status, res.body.toString("utf8"));
    await observe(routeId, f.outcome, "speech.transcribe");
    return { ok: false, outcome: { status: "refused", reason: f.reason, next: f.detail, data: { httpStatus: res.status, requestId } } };
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>; } catch { return { ok: false, outcome: refused("provider_answer_unreadable") }; }
  let words: TranscriptWord[] = []; let text = ""; let language: string | null = null;
  const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (routeId === "deepgram-audio") {
    const alt = (((parsed.results as { channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: Array<{ word?: string; punctuated_word?: string; start?: number; end?: number }> }> }> } | undefined)?.channels ?? [])[0]?.alternatives ?? [])[0];
    text = alt?.transcript ?? ""; words = (alt?.words ?? []).map((w) => ({ text: w.punctuated_word ?? w.word ?? "", start: numOr(w.start) ?? 0, end: numOr(w.end) ?? 0 }));
  } else if (routeId === "elevenlabs-audio") {
    text = typeof parsed.text === "string" ? parsed.text : ""; language = typeof parsed.language_code === "string" ? parsed.language_code : null;
    words = ((parsed.words as Array<{ text?: string; start?: number; end?: number; type?: string }> | undefined) ?? [])
      .filter((w) => (w.type ?? "word") === "word").map((w) => ({ text: w.text ?? "", start: numOr(w.start) ?? 0, end: numOr(w.end) ?? 0 }));
  } else {
    text = typeof parsed.text === "string" ? parsed.text : ""; language = typeof parsed.language === "string" ? parsed.language : null;
    words = ((parsed.words as Array<{ word?: string; start?: number; end?: number }> | undefined) ?? []).map((w) => ({ text: w.word ?? "", start: numOr(w.start) ?? 0, end: numOr(w.end) ?? 0 }));
  }
  await observe(routeId, "ok", "speech.transcribe");
  await receipt({ operationId: "speech.transcribe", routeId, modelId, audioSha256: sha(bytes), words: words.length, requestId, chatId: ctx.chatId, runId: ctx.runId });
  return { ok: true, transcript: { routeId, modelId, text, words, language, requestId } };
}

/** The first transcribe route whose key is saved (ElevenLabs first: the YouTube team's voice account), or null. */
export async function firstTranscribeRoute(): Promise<string | null> {
  for (const routeId of TRANSCRIBE_ROUTES) if (await providerKey(KEYED_ADAPTERS[routeId]!)) return routeId;
  return null;
}

/** Shared answer window for host jobs built on this seam (media.listen). */
export function answerWithinWindow(key: string, start: () => Promise<Outcome>, running: () => Outcome): Promise<Outcome> {
  return answerWithin(key, start, running);
}

async function send(adapter: KeyedAdapter, key: string, input: { method: string; pathAndQuery: string; json?: unknown; timeoutMs?: number }): Promise<SendResult | { networkError: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("provider_timeout")), input.timeoutMs ?? 300_000);
  try {
    const res = await fetch(`${apiBase(adapter)}${input.pathAndQuery}`, {
      method: input.method,
      headers: { ...adapter.auth(key), ...(adapter.extraHeaders ?? {}), ...(input.json !== undefined ? { "Content-Type": "application/json" } : {}), Accept: "*/*" },
      ...(input.json !== undefined ? { body: JSON.stringify(input.json) } : {}),
      signal: controller.signal,
    });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } catch (error) {
    return { networkError: error instanceof Error ? error.message.slice(0, 200) : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

const requestIdOf = (headers: Headers): string | null => headers.get("request-id") ?? headers.get("x-request-id") ?? headers.get("dg-request-id") ?? null;

/** provider.request: one call to an adapter's own API host with the owner's key; binary answers are written to a file. */
export async function keyedProviderRequest(args: Record<string, unknown>, ctx: KeyedCallContext): Promise<Outcome> {
  const routeId = str(args.routeId);
  const admitted = admit(ctx, routeId);
  if (!("adapter" in admitted)) return admitted;
  const { adapter } = admitted;
  const method = (str(args.method) || "POST").toUpperCase();
  if (!["GET", "POST", "DELETE"].includes(method)) return refused("method_not_allowed", "GET, POST or DELETE");
  const apiPath = str(args.path);
  if (!/^\/[A-Za-z0-9/_.~:@%+-]*(\?[A-Za-z0-9=&_.~:@%+,-]*)?$/.test(apiPath) || apiPath.includes("..") || apiPath.startsWith("//")) {
    return refused("path_invalid", "a path on the provider's API host, e.g. /v1/audio/speech");
  }
  let outputFile: string | null = null;
  if (str(args.outputDir) || str(args.fileName)) {
    outputFile = safeOutputFile(str(args.outputDir), str(args.fileName));
    if (!outputFile) return refused("output_path_invalid", "absolute outputDir and a plain fileName");
  }
  const key = await providerKey(adapter);
  if (!key) return refused("provider_key_missing", `the owner saves ${adapter.envKey} for ${adapter.label} in Settings`);
  const requestKey = sha(JSON.stringify({ op: "provider.request", routeId, method, apiPath, json: args.json ?? null, outputFile, chatId: ctx.chatId }));
  return answerWithin(requestKey, () => keyedProviderRequestNow(adapter, key, { routeId, method, apiPath, json: args.json, outputFile }, ctx),
    () => ok({ routeId, state: "running", next: "the call is still running in the host; call provider.request again with the same arguments to get its result (it is not sent twice)" }));
}

async function keyedProviderRequestNow(adapter: KeyedAdapter, key: string, input: { routeId: string; method: string; apiPath: string; json: unknown; outputFile: string | null }, ctx: KeyedCallContext): Promise<Outcome> {
  const { routeId, method, apiPath, outputFile } = input;
  const args = { json: input.json };
  const res = await send(adapter, key, { method, pathAndQuery: apiPath, ...(args.json !== undefined ? { json: args.json } : {}) });
  if ("networkError" in res) { await observe(routeId, "unavailable", "provider.request"); return refused("provider_unreachable", res.networkError); }
  const requestId = requestIdOf(res.headers);
  if (res.status < 200 || res.status >= 300) {
    const f = failure(res.status, res.body.toString("utf8"));
    await observe(routeId, f.outcome, "provider.request");
    const receiptId = await receipt({ operationId: "provider.request", routeId, method, path: apiPath.split("?")[0], status: res.status, reason: f.reason, requestId, chatId: ctx.chatId, runId: ctx.runId });
    return { status: "refused", reason: f.reason, next: f.detail, data: { httpStatus: res.status, requestId, receiptId } };
  }
  const type = res.headers.get("content-type") ?? "";
  let data: Record<string, unknown>;
  if (/json|text\//i.test(type) && !outputFile) {
    const text = res.body.toString("utf8");
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    data = { httpStatus: res.status, contentType: type, body: typeof parsed === "string" ? parsed.slice(0, 20_000) : parsed };
  } else {
    if (!outputFile) return refused("output_path_required", "this answer is binary; give outputDir and fileName");
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, res.body);
    data = { httpStatus: res.status, contentType: type, path: outputFile, sha256: sha(res.body), bytes: res.body.length };
  }
  await observe(routeId, "ok", "provider.request");
  const receiptId = await receipt({ operationId: "provider.request", routeId, method, path: apiPath.split("?")[0], status: res.status, requestId,
    ...(outputFile ? { file: outputFile, sha256: data.sha256, bytes: data.bytes } : {}), chatId: ctx.chatId, runId: ctx.runId });
  // A binary answer written to a file is that file; a later identical call returns this same outcome (answerWithin).
  return { status: "ok", data: { routeId, requestId, receiptId, ...data }, ...(typeof data.path === "string" ? { produced: [data.path] } : {}) };
}

async function probeDurationSeconds(file: string): Promise<number | null> {
  try {
    const r = await runTool("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], 15_000);
    const n = Number(String(r.stdout ?? "").trim());
    return r.status === 0 && Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * speech.synthesize: narration through a keyed speech adapter (ElevenLabs with timing, or OpenAI audio). Idempotent on
 * the request digest: the same text, voice and model into the same file answers the existing file (no second spend).
 */
export async function speechSynthesize(args: Record<string, unknown>, ctx: KeyedCallContext): Promise<Outcome> {
  const routeId = str(args.routeId) || "elevenlabs-audio";
  if (!(SPEECH_ROUTES as readonly string[]).includes(routeId)) return refused("route_not_speech_capable", `speech routes: ${SPEECH_ROUTES.join(", ")}`);
  const admitted = admit(ctx, routeId);
  if (!("adapter" in admitted)) return admitted;
  const { adapter } = admitted;
  let text = str(args.text);
  const textPath = str(args.textPath);
  if (!text && textPath) {
    if (!path.isAbsolute(textPath)) return refused("text_path_absolute_required");
    try { text = fs.readFileSync(textPath, "utf8").trim(); } catch { return refused("text_path_unreadable"); }
  }
  if (!text) return refused("text_required", "text or an absolute textPath");
  const limit = routeId === "openai-audio" ? 4_096 : 10_000;
  if (text.length > limit) return refused("text_too_long", `at most ${limit} characters per call; split by scene and call once per part`);
  const outputDir = str(args.outputDir);
  const modelId = str(args.modelId) || (routeId === "openai-audio" ? "gpt-4o-mini-tts" : "eleven_multilingual_v2");
  let voiceId = str(args.voiceId);
  const voiceName = str(args.voiceName);
  const key = await providerKey(adapter);
  if (!key) return refused("provider_key_missing", `the owner saves ${adapter.envKey} for ${adapter.label} in Settings`);
  if (routeId === "elevenlabs-audio" && !voiceId && voiceName) {
    const listed = await send(adapter, key, { method: "GET", pathAndQuery: "/v1/voices", timeoutMs: 30_000 });
    if ("networkError" in listed) return refused("provider_unreachable", listed.networkError);
    if (listed.status !== 200) { const f = failure(listed.status, listed.body.toString("utf8")); await observe(routeId, f.outcome, "speech.synthesize"); return refused(f.reason, f.detail); }
    try {
      const voices = (JSON.parse(listed.body.toString("utf8")) as { voices?: Array<{ voice_id?: string; name?: string }> }).voices ?? [];
      voiceId = voices.find((voice) => (voice.name ?? "").toLowerCase() === voiceName.toLowerCase())?.voice_id
        ?? voices.find((voice) => (voice.name ?? "").toLowerCase().startsWith(voiceName.toLowerCase()))?.voice_id ?? "";
    } catch { voiceId = ""; }
    if (!voiceId) return refused("voice_not_found", `no voice named ${voiceName.slice(0, 60)} on this account`);
  }
  if (!voiceId) voiceId = routeId === "openai-audio" ? "alloy" : "21m00Tcm4TlvDq8ikWAM";
  const digest = sha(JSON.stringify({ routeId, text, voiceId, modelId, format: "mp3" }));
  const outputFile = safeOutputFile(outputDir, str(args.fileName) || `speech-${digest.slice(0, 12)}.mp3`);
  if (!outputFile) return refused("output_path_invalid", "absolute outputDir and a plain fileName ending in .mp3");
  const receiptFile = `${outputFile}.speech-receipt.json`;
  try {
    const prior = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
    // The narration made earlier (also one finished in the background after its run ended) is handed over again.
    if (prior.requestDigest === digest && fs.existsSync(outputFile) && sha(fs.readFileSync(outputFile)) === prior.sha256) return { status: "ok", data: { ...prior, reused: true }, produced: [outputFile] };
  } catch { /* no prior receipt */ }
  if (fs.existsSync(outputFile)) return refused("output_exists", "the file exists from another request; choose another fileName");
  return answerWithin(`speech:${digest}:${outputFile}`, () => speechSynthesizeNow(adapter, key, { routeId, text, voiceId, modelId, digest, outputFile, receiptFile }, ctx),
    () => ok({ routeId, state: "running", path: outputFile, requestDigest: digest,
      next: "narration is still being made in the host; call speech.synthesize again with the same arguments to get the file (nothing is generated twice)" }));
}

async function speechSynthesizeNow(adapter: KeyedAdapter, key: string, input: { routeId: string; text: string; voiceId: string; modelId: string; digest: string; outputFile: string; receiptFile: string }, ctx: KeyedCallContext): Promise<Outcome> {
  const { routeId, text, voiceId, modelId, digest, outputFile, receiptFile } = input;
  const res = routeId === "openai-audio"
    ? await send(adapter, key, { method: "POST", pathAndQuery: "/v1/audio/speech", json: { model: modelId, voice: voiceId, input: text, response_format: "mp3" } })
    : await send(adapter, key, { method: "POST", pathAndQuery: `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, json: { text, model_id: modelId } });
  if ("networkError" in res) { await observe(routeId, "unavailable", "speech.synthesize"); return refused("provider_unreachable", res.networkError); }
  const requestId = requestIdOf(res.headers);
  if (res.status < 200 || res.status >= 300) {
    const f = failure(res.status, res.body.toString("utf8"));
    await observe(routeId, f.outcome, "speech.synthesize");
    await receipt({ operationId: "speech.synthesize", routeId, status: res.status, reason: f.reason, requestId, textSha256: sha(text), chatId: ctx.chatId, runId: ctx.runId });
    return { status: "refused", reason: f.reason, next: f.detail, data: { httpStatus: res.status, requestId } };
  }
  let audio: Buffer; let alignmentPath: string | null = null; let alignmentEnd: number | null = null;
  if (routeId === "elevenlabs-audio") {
    let parsed: { audio_base64?: string; alignment?: { character_end_times_seconds?: number[] } };
    try { parsed = JSON.parse(res.body.toString("utf8")); } catch { return refused("provider_answer_unreadable"); }
    if (!parsed.audio_base64) return refused("provider_answer_without_audio");
    audio = Buffer.from(parsed.audio_base64, "base64");
    if (parsed.alignment) {
      alignmentPath = `${outputFile}.alignment.json`;
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(alignmentPath, JSON.stringify({ alignment: parsed.alignment }, null, 1));
      const ends = parsed.alignment.character_end_times_seconds ?? [];
      alignmentEnd = ends.length ? ends[ends.length - 1] ?? null : null;
    }
  } else {
    audio = res.body;
  }
  if (audio.length === 0) return refused("provider_answer_without_audio");
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, audio);
  const probedSeconds = await probeDurationSeconds(outputFile);
  const record = {
    schemaVersion: "agentlas.speech-receipt.v1", routeId, path: outputFile, alignmentPath, sha256: sha(audio), bytes: audio.length,
    durationSeconds: probedSeconds ?? alignmentEnd, characters: text.length, textSha256: sha(text), voiceId, modelId,
    requestId, requestDigest: digest, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(receiptFile, JSON.stringify(record, null, 1));
  await observe(routeId, "ok", "speech.synthesize");
  const receiptId = await receipt({ operationId: "speech.synthesize", ...record, chatId: ctx.chatId, runId: ctx.runId });
  // Kept by answerWithin: the same request after a "running" answer gets this outcome, file included.
  return { status: "ok", data: { ...record, receiptId, reused: false }, produced: [outputFile] };
}
