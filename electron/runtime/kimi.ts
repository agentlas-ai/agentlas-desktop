// Kimi Code CLI runtime — official Moonshot CLI (`@moonshot-ai/kimi-code`).
// Headless contract: `kimi -p <prompt> --output-format stream-json`.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import {
  agentRunCwd,
  detachedSpawnOpts,
  killCliTree,
  probeCliVersion,
  spawnCli,
  trackRunChild,
} from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";

const KIND = "kimi";
const CONNECTION_RECEIPT_VERSION = 1 as const;
const CONNECTION_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CONNECTION_RECEIPT_FILE = process.env.AGENTLAS_KIMI_CONNECTION_RECEIPT?.trim()
  || path.join(os.homedir(), ".agentlas", "runtime-connections", "kimi.v1.json");
const CONNECTION_CHECK_DIR = path.join(os.homedir(), ".agentlas", "runtime-verification", "kimi");

const CANDIDATES = [
  ...(process.platform === "win32"
    ? [
        "kimi.cmd",
        "kimi.exe",
        path.join(process.env.APPDATA ?? "", "npm", "kimi.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "kimi.cmd"),
        path.join(os.homedir(), ".agentlas", "npm", "kimi.cmd"),
      ]
    : []),
  path.join(os.homedir(), ".agentlas", "npm", "bin", "kimi"),
  path.join(os.homedir(), ".local", "bin", "kimi"),
  path.join(os.homedir(), ".kimi-code", "bin", "kimi"),
  "kimi",
  "/opt/homebrew/bin/kimi",
  "/usr/local/bin/kimi",
];

function kimiCandidates(): string[] {
  const override = process.env.AGENTLAS_KIMI_BIN?.trim();
  return override ? [override, ...CANDIDATES] : CANDIDATES;
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    if (!path.isAbsolute(candidate)) {
      if (await probeCliVersion(candidate, 2_500)) return candidate;
      continue;
    }
    try {
      await fs.access(candidate);
      if (await probeCliVersion(candidate, 2_500)) return candidate;
    } catch {
      // next candidate
    }
  }
  return null;
}

/**
 * A Kimi binary alone is not a connection. The official CLI reports
 * `No model configured` before login; a non-empty default_model is the local,
 * non-secret receipt that the login/provider setup reached a usable state.
 */
async function kimiConfigurationDigest(): Promise<string | null> {
  const root = process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), ".kimi-code");
  try {
    const config = await fs.readFile(path.join(root, "config.toml"), "utf8");
    if (!/^\s*default_model\s*=\s*["'][^"']+["']\s*$/m.test(config)) return null;
    return createHash("sha256").update(config).digest("hex");
  } catch {
    return null;
  }
}

async function hasUsableKimiConfiguration(): Promise<boolean> {
  return Boolean(await kimiConfigurationDigest());
}

interface KimiConnectionReceipt {
  version: typeof CONNECTION_RECEIPT_VERSION;
  configDigest: string;
  binaryVersion: string;
  verifiedAt: string;
}

async function readConnectionReceipt(configDigest: string, binaryVersion: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONNECTION_RECEIPT_FILE, "utf8")) as Partial<KimiConnectionReceipt>;
    return parsed.version === CONNECTION_RECEIPT_VERSION
      && parsed.configDigest === configDigest
      && parsed.binaryVersion === binaryVersion
      && typeof parsed.verifiedAt === "string"
      && Date.now() - Date.parse(parsed.verifiedAt) >= 0
      && Date.now() - Date.parse(parsed.verifiedAt) <= CONNECTION_RECEIPT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function writeConnectionReceipt(configDigest: string, binaryVersion: string): Promise<void> {
  await fs.mkdir(path.dirname(CONNECTION_RECEIPT_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(CONNECTION_RECEIPT_FILE, JSON.stringify({
    version: CONNECTION_RECEIPT_VERSION,
    configDigest,
    binaryVersion,
    verifiedAt: new Date().toISOString(),
  } satisfies KimiConnectionReceipt), { encoding: "utf8", mode: 0o600 });
}

async function clearConnectionReceipt(): Promise<void> {
  await fs.rm(CONNECTION_RECEIPT_FILE, { force: true }).catch(() => undefined);
}

let connectionVerificationInFlight: Promise<boolean> | null = null;

async function verifyKimiConnection(
  bin: string,
  configDigest: string,
  binaryVersion: string,
): Promise<boolean> {
  if (await readConnectionReceipt(configDigest, binaryVersion)) return true;
  if (connectionVerificationInFlight) return connectionVerificationInFlight;
  connectionVerificationInFlight = (async () => {
    await fs.mkdir(CONNECTION_CHECK_DIR, { recursive: true, mode: 0o700 });
    const marker = "AGENTLAS_KIMI_CONNECTED";
    const request: RunnerRequest = {
      systemPrompt: "Connection verification only.",
      history: [],
      userPrompt: `Reply with exactly ${marker}. Do not use tools.`,
      backendLabel: "Kimi Code CLI",
      locale: "en",
      permission: "read",
      cwd: CONNECTION_CHECK_DIR,
    };
    const result = await runKimiProcess(
      bin,
      ["-p", request.userPrompt, "--output-format", "stream-json"],
      request,
      { onPartial() {}, onStatus() {}, onTool() {} },
    ).catch(() => null);
    if (!result || result.code !== 0 || !result.text.includes(marker)) return false;
    await writeConnectionReceipt(configDigest, binaryVersion);
    return true;
  })().finally(() => { connectionVerificationInFlight = null; });
  return connectionVerificationInFlight;
}

export interface KimiProbe { path: string; version: string; }

/** Return only an executable, configured runtime; install-only is not connected. */
export async function probeKimi(): Promise<KimiProbe | null> {
  const found = await firstExisting(kimiCandidates());
  if (!found) return null;
  const configDigest = await kimiConfigurationDigest();
  if (!configDigest) return null;
  const version = (await probeCliVersion(found, 2_500)) ?? "unknown";
  if (!(await verifyKimiConnection(found, configDigest, version))) return null;
  return { path: found, version };
}

async function resolveKimiBinary(): Promise<string | null> {
  return firstExisting(kimiCandidates());
}

function systemFingerprint(req: RunnerRequest): string {
  if (req.sessionFingerprintSeed) {
    return createHash("sha256").update("seed.v2\0").update(req.sessionFingerprintSeed).digest("hex");
  }
  return createHash("sha256")
    .update(req.systemPrompt)
    .update("\0")
    .update(req.locale)
    .update("\0")
    .update(req.permission ?? "")
    .update("\0")
    .update(req.forceSurface ? "force-surface" : "normal")
    .update("\0")
    .update(req.model ?? "")
    .digest("hex");
}

function buildPrompt(req: RunnerRequest): string {
  const system = wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    req.userPrompt,
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
    req.untrustedAllowedMcpTools,
  );
  const turnContext = req.turnContext?.trim();
  const parts = [`[SYSTEM]\n${system}${turnContext ? `\n\n${turnContext}` : ""}`, ""];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
    parts.push(block, "");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const text = (item as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

interface KimiProcessResult {
  code: number | null;
  text: string;
  stderr: string;
  sessionId: string | null;
}

function runKimiProcess(
  bin: string,
  args: string[],
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<KimiProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: req.cwd ?? agentRunCwd(),
        env: req.env ?? process.env,
        ...detachedSpawnOpts(),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    trackRunChild(child);
    const onAbort = () => killCliTree(child);
    if (req.signal?.aborted) killCliTree(child);
    else req.signal?.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    let text = "";
    let stderr = "";
    let sessionId: string | null = null;
    const toolCalls = new Map<string, { name: string; args: string }>();

    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") {
          sessionId = event.session_id;
          return;
        }
        if (event.role === "assistant") {
          const assistantText = contentText(event.content);
          if (assistantText) {
            text += assistantText;
            events.onPartial(text);
          }
          if (Array.isArray(event.tool_calls)) {
            for (const raw of event.tool_calls) {
              if (!raw || typeof raw !== "object") continue;
              const call = raw as Record<string, unknown>;
              const fn = call.function && typeof call.function === "object"
                ? call.function as Record<string, unknown>
                : {};
              const id = typeof call.id === "string" ? call.id : undefined;
              const name = typeof fn.name === "string" ? fn.name : "tool";
              const callArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
              if (id) toolCalls.set(id, { name, args: callArgs });
              events.onTool?.(name, callArgs, undefined, id, false);
            }
          }
          return;
        }
        if (event.role === "tool") {
          const id = typeof event.tool_call_id === "string" ? event.tool_call_id : undefined;
          const call = id ? toolCalls.get(id) : undefined;
          events.onTool?.(call?.name ?? "tool", call?.args, contentText(event.content), id, false);
        }
      } catch {
        // Diagnostics and malformed lines are ignored; stderr is surfaced on failure.
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      req.signal?.removeEventListener("abort", onAbort);
      if (buffer.trim()) consume(buffer);
      resolve({ code, text: text.trim(), stderr: stderr.trim(), sessionId });
    });
  });
}

export const runKimi: Runner = async (req, events): Promise<RunnerResult> => {
  // Kimi prompt mode exposes built-in file/shell tools and currently has no
  // verified zero-tool switch. Do not widen browser or restricted-read authority.
  if (req.untrustedNoTools || req.restrictedReadBoundary) {
    throw new Error(req.locale === "ko"
      ? "Kimi Code는 현재 검증된 무도구 격리 모드를 지원하지 않습니다. Claude Code, Ollama 또는 API 런타임을 선택하세요."
      : "Kimi Code does not currently support verified tool-less isolation. Select Claude Code, Ollama, or an API runtime.");
  }
  const bin = await resolveKimiBinary();
  if (!bin) throw new Error(req.locale === "ko" ? "Kimi Code를 찾지 못했습니다." : "Kimi Code is not installed.");
  if (!(await hasUsableKimiConfiguration())) {
    throw new Error(req.locale === "ko" ? "Kimi Code 로그인이 필요합니다. 설정에서 Kimi Code 연결을 눌러주세요." : "Kimi Code login is required. Connect Kimi Code in Settings.");
  }

  const staged = await stageCliImageAttachments(req);
  const runReq = { ...req, userPrompt: staged.userPrompt };
  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const saved = runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  if (saved && fingerprint && saved.fingerprint !== fingerprint && runReq.chatId) {
    clearRuntimeSession(runReq.chatId, KIND);
  }
  const storedSessionId = saved && fingerprint && saved.fingerprint === fingerprint ? saved.sessionId : null;
  const resumeSessionId = runReq.runtimeSessionId ?? storedSessionId;
  const gapContext = resumeSessionId && !runReq.runtimeSessionId && storedSessionId && saved
    ? renderGapContext(unseenHistoryGap(runReq.history, saved.updatedAt), runReq.locale)
    : "";
  const prompt = resumeSessionId
    ? composeResumeTurnPrompt(
        runReq.userPrompt,
        [gapContext, runReq.turnContext ?? ""].filter(Boolean).join("\n\n"),
        runReq.locale,
      )
    : buildPrompt(runReq);
  const baseArgs = ["-p", prompt, "--output-format", "stream-json"];
  if (runReq.model) baseArgs.push("--model", runReq.model);
  const args = resumeSessionId ? ["--session", resumeSessionId, ...baseArgs] : baseArgs;

  events.onStatus(resumeSessionId
    ? (runReq.locale === "ko" ? "Kimi Code 대화를 이어가는 중..." : "Resuming the Kimi Code conversation...")
    : tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  const result = await runKimiProcess(bin, args, runReq, events);
  if (runReq.signal?.aborted) throw new Error(tStatus(runReq.locale, "aborted"));
  if (result.code === 0) {
    const nextSessionId = result.sessionId ?? resumeSessionId ?? undefined;
    if (runReq.chatId && fingerprint && nextSessionId) {
      if (!saveRuntimeSession(runReq.chatId, KIND, nextSessionId, fingerprint)) {
        events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
      }
    }
    events.onStatus(`[runtime-session] ${resumeSessionId ? "resumed" : "created"} kind=${KIND}`);
    return { text: result.text || (runReq.locale === "ko" ? "Kimi Code가 빈 응답을 반환했습니다." : "Kimi Code returned an empty response."), sessionId: nextSessionId };
  }

  if (resumeSessionId && runReq.unattended) {
    throw new Error("Automation runtime session resume failed for kimi; refusing to create a fresh CLI session.");
  }
  if (resumeSessionId && runReq.chatId) {
    // Interactive recovery preserves the same Agentlas chat and seeds a fresh
    // provider session from its complete durable history.
    clearRuntimeSession(runReq.chatId, KIND);
    events.onStatus(runReq.locale === "ko" ? "대화 기록을 그대로 유지해 다시 연결하는 중..." : "Reconnecting while preserving this conversation...");
    return runKimi({ ...runReq, runtimeSessionId: undefined }, events);
  }
  if (/no model configured|login|auth|unauthori[sz]ed|forbidden/i.test(result.stderr)) {
    await clearConnectionReceipt();
  }
  throw new Error(`Kimi Code exit ${result.code ?? "unknown"}${result.stderr ? `\n${result.stderr.slice(0, 500)}` : ""}`);
};
