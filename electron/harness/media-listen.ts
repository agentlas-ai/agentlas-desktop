import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
















type Outcome = { status: "ok"; data: unknown } | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const refused = (reason: string, next?: string): Outcome => ({ status: "refused", reason, ...(next ? { next } : {}) });

export const LISTEN_THRESHOLDS = Object.freeze({ maxWordErrorRate: 0.1, maxSilenceInsideSpeechSec: 4, maxTruePeakDbfs: -0.5, minIntegratedLufs: -20, maxIntegratedLufs: -9, maxSubtitleOffsetSec: 0.75 });

export function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean);
}

/** Word-level edit alignment of the script (expected) against what was heard; differing runs with indexes into heard. */
export function compareWords(expected: string[], heard: string[]): { wer: number; substitutions: number; deletions: number; insertions: number;
  runs: Array<{ expected: string; heard: string; heardIndex: number }> } {
  const n = expected.length, m = heard.length;
  const d: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i += 1) d[i]![0] = i;
  for (let j = 0; j <= m; j += 1) d[0]![j] = j;
  for (let i = 1; i <= n; i += 1) for (let j = 1; j <= m; j += 1) {
    const cost = expected[i - 1] === heard[j - 1] ? 0 : 1;
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
  }
  let i = n, j = m, subs = 0, dels = 0, ins = 0;
  const ops: Array<{ op: "=" | "s" | "d" | "i"; e?: string; h?: string; j: number }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (expected[i - 1] === heard[j - 1] ? 0 : 1)) {
      const same = expected[i - 1] === heard[j - 1]; ops.push({ op: same ? "=" : "s", e: expected[i - 1], h: heard[j - 1], j: j - 1 }); if (!same) subs += 1; i -= 1; j -= 1;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) { ops.push({ op: "d", e: expected[i - 1], j: Math.max(0, j - 1) }); dels += 1; i -= 1; }
    else { ops.push({ op: "i", h: heard[j - 1], j: j - 1 }); ins += 1; j -= 1; }
  }
  ops.reverse();
  const runs: Array<{ expected: string; heard: string; heardIndex: number }> = [];
  let cur: { e: string[]; h: string[]; j: number } | null = null;
  for (const op of ops) {
    if (op.op === "=") { if (cur) { runs.push({ expected: cur.e.join(" "), heard: cur.h.join(" "), heardIndex: cur.j }); cur = null; } continue; }
    cur ??= { e: [], h: [], j: op.j };
    if (op.e) cur.e.push(op.e); if (op.h) cur.h.push(op.h);
  }
  if (cur) runs.push({ expected: cur.e.join(" "), heard: cur.h.join(" "), heardIndex: cur.j });
  return { wer: n === 0 ? (m === 0 ? 0 : 1) : (subs + dels + ins) / n, substitutions: subs, deletions: dels, insertions: ins, runs };
}

export async function silences(file: string): Promise<Array<{ start: number; end: number; duration: number }>> {
  try {
    // Without blocking the host (keyed-provider.ts runTool); -vn: only the audio is measured, so no video frame is decoded
    // (perf MP-02: the full decode cost 31 s CPU on a 7 min 1080p cut).
    const { runTool } = await import("./keyed-provider");
    const r = await runTool("ffmpeg", ["-v", "info", "-protocol_whitelist", "file", "-i", file, "-vn", "-af", "silencedetect=noise=-35dB:d=1.5", "-f", "null", "-"], 180_000);
    const out: Array<{ start: number; end: number; duration: number }> = []; let start: number | null = null;
    for (const line of String(r.stderr ?? "").split("\n")) {
      const s = line.match(/silence_start: (-?[\d.]+)/); if (s) start = Number(s[1]);
      const e = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/); if (e && start !== null) { out.push({ start, end: Number(e[1]), duration: Number(e[2]) }); start = null; }
    }
    return out;
  } catch { return []; }
}

export function parseCues(text: string): Array<{ start: number; text: string }> {
  const t = (h: string, m: string, s: string, ms: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const cues: Array<{ start: number; text: string }> = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => /-->/.test(l));
    if (idx < 0) continue;
    const m = lines[idx]!.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->/);
    if (!m) continue;
    cues.push({ start: t(m[1] ?? "0", m[2]!, m[3]!, m[4]!), text: lines.slice(idx + 1).join(" ") });
  }
  return cues;
}

export async function mediaListen(args: Record<string, unknown>, ctx: { chatId: string; runId: string; dryRun?: boolean; permission?: "read" | "write" | "full" }): Promise<Outcome> {
  const file = str(args.path);
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return refused("path_invalid", "an absolute path to a local audio or video file");
  let script = str(args.scriptText);
  const scriptPath = str(args.scriptPath);
  if (!script && scriptPath) {
    if (!path.isAbsolute(scriptPath)) return refused("script_path_absolute_required");
    try { script = fs.readFileSync(scriptPath, "utf8"); } catch { return refused("script_path_unreadable"); }
  }
  const subtitlePath = str(args.subtitlePath);
  if (subtitlePath && (!path.isAbsolute(subtitlePath) || !fs.existsSync(subtitlePath))) return refused("subtitle_path_invalid");
  const kp = await import("./keyed-provider");
  const routeId = str(args.routeId) || await kp.firstTranscribeRoute();
  if (!routeId) return refused("no_transcribe_route", "the owner saves a key for ElevenLabs, OpenAI or Deepgram in Settings");
  const fileSha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const outputDir = str(args.outputDir);
  if (outputDir && (!path.isAbsolute(outputDir) || outputDir.split(path.sep).includes(".."))) return refused("output_path_invalid");
  const key = `listen:${fileSha}:${routeId}:${createHash("sha256").update(script + "\0" + subtitlePath).digest("hex").slice(0, 16)}`;
  return kp.answerWithinWindow(key, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-listen-"));
    try {
      if (!kp.mediaEngineBin("ffmpeg")) return refused("media_engine_missing", "ffmpeg is not installed on this computer");
      const track = await kp.speechTrack(file, work);
      if (!track) return refused("audio_track_unavailable", "ffmpeg could not read an audio track from this file");
      const heard = await kp.transcribeFile(routeId, track, ctx, str(args.languageCode) || undefined);
      if (!heard.ok) return heard.outcome;
      const t = heard.transcript;
      const quality = await (await import("./media-quality")).mediaQualityProbe({ path: file, loudness: true });
      const report = quality.status === "ok" ? quality.data as { durationSec?: number | null; loudness?: { integratedLufs: number | null; truePeakDbfs: number | null } } : null;
      const heardWords = t.words.map((w) => normalizeWords(w.text)[0] ?? "").filter(Boolean);
      const timed = t.words.filter((w) => normalizeWords(w.text).length > 0);
      const comparison = script ? compareWords(normalizeWords(script), heardWords) : null;
      const at = (index: number) => timed[Math.min(Math.max(index, 0), timed.length - 1)]?.start ?? null;
      const speechStart = timed[0]?.start ?? null, speechEnd = timed.at(-1)?.end ?? null;
      const gaps = (await silences(file)).filter((g) => speechStart !== null && speechEnd !== null && g.start > speechStart && g.end < speechEnd);
      let subtitle: { cues: number; checked: number; maxOffsetSec: number | null; worst: Array<{ cue: string; offsetSec: number }> } | null = null;
      if (subtitlePath) {
        const cues = parseCues(fs.readFileSync(subtitlePath, "utf8"));
        const offsets: Array<{ cue: string; offsetSec: number }> = [];
        for (const cue of cues) {
          const first = normalizeWords(cue.text).slice(0, 2);
          if (first.length === 0) continue;
          const hit = timed.findIndex((w, k) => Math.abs(w.start - cue.start) <= 10 && normalizeWords(w.text)[0] === first[0]
            && (first.length < 2 || normalizeWords(timed[k + 1]?.text ?? "")[0] === first[1]));
          if (hit >= 0) offsets.push({ cue: cue.text.slice(0, 60), offsetSec: Number((timed[hit]!.start - cue.start).toFixed(3)) });
        }
        const worst = [...offsets].sort((a, b) => Math.abs(b.offsetSec) - Math.abs(a.offsetSec)).slice(0, 5);
        subtitle = { cues: cues.length, checked: offsets.length, maxOffsetSec: worst[0] ? Math.abs(worst[0].offsetSec) : null, worst };
      }
      const L = LISTEN_THRESHOLDS;
      const checks: Array<{ name: string; pass: boolean | null; actual: unknown; threshold: unknown }> = [
        { name: "speech_heard", pass: timed.length > 0, actual: timed.length, threshold: "> 0 words" },
        ...(comparison ? [{ name: "matches_script", pass: comparison.wer <= L.maxWordErrorRate, actual: Number(comparison.wer.toFixed(4)), threshold: L.maxWordErrorRate }] : []),
        { name: "no_long_silence_inside_speech", pass: gaps.every((g) => g.duration <= L.maxSilenceInsideSpeechSec), actual: gaps.reduce((mx, g) => Math.max(mx, g.duration), 0), threshold: L.maxSilenceInsideSpeechSec },
        { name: "true_peak", pass: report?.loudness?.truePeakDbfs == null ? null : report.loudness.truePeakDbfs <= L.maxTruePeakDbfs, actual: report?.loudness?.truePeakDbfs ?? null, threshold: L.maxTruePeakDbfs },
        { name: "integrated_loudness", pass: report?.loudness?.integratedLufs == null ? null : report.loudness.integratedLufs >= L.minIntegratedLufs && report.loudness.integratedLufs <= L.maxIntegratedLufs,
          actual: report?.loudness?.integratedLufs ?? null, threshold: [L.minIntegratedLufs, L.maxIntegratedLufs] },
        ...(subtitle ? [{ name: "subtitles_in_sync", pass: subtitle.maxOffsetSec === null ? null : subtitle.maxOffsetSec <= L.maxSubtitleOffsetSec, actual: subtitle.maxOffsetSec, threshold: L.maxSubtitleOffsetSec }] : []),
      ];
      const result = {
        schemaVersion: "agentlas.listening-check.v1", path: file, fileSha256: fileSha, durationSec: report?.durationSec ?? null,
        heard: { routeId: t.routeId, modelId: t.modelId, language: t.language, words: timed.length, text: t.text.slice(0, 12_000), speechStartSec: speechStart, speechEndSec: speechEnd, requestId: t.requestId },
        script: comparison ? { words: normalizeWords(script).length, wer: Number(comparison.wer.toFixed(4)), substitutions: comparison.substitutions, deletions: comparison.deletions, insertions: comparison.insertions,
          differences: comparison.runs.slice(0, 25).map((run) => ({ atSec: at(run.heardIndex), expected: run.expected.slice(0, 160), heard: run.heard.slice(0, 160) })) } : null,
        silencesInsideSpeech: gaps.slice(0, 20), loudness: report?.loudness ?? null, subtitles: subtitle, checks,
        pass: checks.every((c) => c.pass !== false), checkedAt: new Date().toISOString(),
      };
      let receiptPath: string | null = null;
      if (outputDir && (ctx.permission === "write" || ctx.permission === "full") && !ctx.dryRun) {
        fs.mkdirSync(outputDir, { recursive: true });
        receiptPath = path.join(outputDir, `${path.basename(file)}.listening-check.json`);
        fs.writeFileSync(receiptPath, JSON.stringify(result, null, 1));
      }
      try { const { appendReceipt } = await import("./capability-ports"); await appendReceipt({ operationId: "media.listen", fileSha256: fileSha, routeId: t.routeId, pass: result.pass, wer: result.script?.wer ?? null, chatId: ctx.chatId, runId: ctx.runId }); } catch { /* receipt best effort */ }
      return { status: "ok", data: { ...result, receiptPath } };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, () => ({ status: "ok", data: { state: "running", path: file, next: "the host is still listening; call media.listen again with the same arguments for the report (it is not transcribed twice)" } }));
}

/** speech.transcribe port: one file → word-timed transcript (answers within the tool window, see keyed-provider.ts). */
export async function speechTranscribePort(args: Record<string, unknown>, ctx: { chatId: string; runId: string; dryRun?: boolean; permission?: "read" | "write" | "full" }): Promise<Outcome> {
  const file = str(args.path);
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return refused("path_invalid", "an absolute path to a local audio or video file");
  const kp = await import("./keyed-provider");
  const routeId = str(args.routeId) || await kp.firstTranscribeRoute();
  if (!routeId) return refused("no_transcribe_route", "the owner saves a key for ElevenLabs, OpenAI or Deepgram in Settings");
  const fileSha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return kp.answerWithinWindow(`transcribe:${fileSha}:${routeId}`, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-transcribe-"));
    try {
      if (!kp.mediaEngineBin("ffmpeg")) return refused("media_engine_missing", "ffmpeg is not installed on this computer");
      const track = await kp.speechTrack(file, work);
      if (!track) return refused("audio_track_unavailable", "ffmpeg could not read an audio track from this file");
      const heard = await kp.transcribeFile(routeId, track, ctx, str(args.languageCode) || undefined);
      if (!heard.ok) return heard.outcome;
      return { status: "ok", data: { ...heard.transcript, fileSha256: fileSha, words: heard.transcript.words.slice(0, 4000) } };
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }, () => ({ status: "ok", data: { state: "running", path: file, next: "still transcribing in the host; call speech.transcribe again with the same arguments" } }));
}
