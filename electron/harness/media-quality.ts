/*
 * media.quality — the doc 12 F6 example: a new Agentlas capability added only by registering one FeatureModule and one
 * harness port. Every adapter reaches it through the same dispatcher (CLI runtimes via agentlas-turn harness_call, API
 * and local loops via the harness tools, UI/SDK via window.agentlas.harness), so no runtime gets its own copy.
 *
 * media.quality.probe measures one local media file (video, audio or image) with ffprobe — container, duration, video
 * size/fps, audio channels/rate — optionally integrated loudness and true peak (ffmpeg ebur128), and compares the result
 * with the caller's expectations. Read-only: an existing regular file with a media extension, local demuxers only
 * (protocol whitelist "file"), nothing is copied or written. No electron import.
 */
import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",
  ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const OUTPUT_LIMIT = 2 * 1024 * 1024;

export interface MediaQualityExpect {
  minWidth?: number; minHeight?: number; aspectRatio?: string; durationSec?: number; toleranceSec?: number;
  requireAudio?: boolean; maxIntegratedLufs?: number; minIntegratedLufs?: number; maxTruePeakDbfs?: number;
}

export interface MediaQualityReport {
  schemaVersion: "agentlas.media-quality.v1";
  sizeBytes: number;
  container: string;
  durationSec: number | null;
  video: { codec: string; width: number; height: number; fps: number | null } | null;
  audio: { codec: string; channels: number | null; sampleRate: number | null } | null;
  loudness?: { integratedLufs: number | null; truePeakDbfs: number | null };
  checks: Array<{ name: string; pass: boolean; actual: unknown; expected: unknown }>;
  pass: boolean;
}

async function engine(name: "ffprobe" | "ffmpeg"): Promise<string | null> {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of [...new Set(dirs)]) {
    const candidate = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("media_quality_timeout")); }, timeoutMs);
    // ffprobe JSON carries file names and tags; a multi-byte character split
    // between two pipe chunks must not decode as U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > OUTPUT_LIMIT) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > OUTPUT_LIMIT) stderr = stderr.slice(-OUTPUT_LIMIT); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function fps(rate: unknown): number | null {
  if (typeof rate !== "string" || !rate.includes("/")) return num(rate);
  const [a, b] = rate.split("/").map(Number);
  return b ? Math.round((a / b) * 1000) / 1000 : null;
}

/** Parse the ebur128 summary ffmpeg prints on stderr ("I: -16.0 LUFS", "Peak: -1.2 dBFS"). */
export function parseEbur128Summary(stderr: string): { integratedLufs: number | null; truePeakDbfs: number | null } {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = summary.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const peak = summary.match(/Peak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dBFS/);
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    truePeakDbfs: peak ? (peak[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(peak[1])) : null,
  };
}

export function mediaQualityChecks(report: Omit<MediaQualityReport, "checks" | "pass">, expect: MediaQualityExpect): MediaQualityReport["checks"] {
  const checks: MediaQualityReport["checks"] = [];
  const add = (name: string, pass: boolean, actual: unknown, expected: unknown) => checks.push({ name, pass, actual, expected });
  if (expect.minWidth !== undefined) add("minWidth", (report.video?.width ?? 0) >= expect.minWidth, report.video?.width ?? null, expect.minWidth);
  if (expect.minHeight !== undefined) add("minHeight", (report.video?.height ?? 0) >= expect.minHeight, report.video?.height ?? null, expect.minHeight);
  if (expect.aspectRatio !== undefined) {
    const [w, h] = expect.aspectRatio.split(":").map(Number);
    const actual = report.video ? report.video.width / report.video.height : null;
    add("aspectRatio", actual !== null && w > 0 && h > 0 && Math.abs(actual - w / h) <= 0.02, actual === null ? null : Math.round(actual * 1000) / 1000, expect.aspectRatio);
  }
  if (expect.durationSec !== undefined) {
    const tolerance = expect.toleranceSec ?? Math.max(0.25, expect.durationSec * 0.05);
    add("durationSec", report.durationSec !== null && Math.abs(report.durationSec - expect.durationSec) <= tolerance, report.durationSec, `${expect.durationSec}±${tolerance}`);
  }
  if (expect.requireAudio) add("requireAudio", Boolean(report.audio), Boolean(report.audio), true);
  const lufs = report.loudness?.integratedLufs ?? null;
  if (expect.maxIntegratedLufs !== undefined) add("maxIntegratedLufs", lufs !== null && lufs <= expect.maxIntegratedLufs, lufs, expect.maxIntegratedLufs);
  if (expect.minIntegratedLufs !== undefined) add("minIntegratedLufs", lufs !== null && lufs >= expect.minIntegratedLufs, lufs, expect.minIntegratedLufs);
  const peak = report.loudness?.truePeakDbfs ?? null;
  if (expect.maxTruePeakDbfs !== undefined) add("maxTruePeakDbfs", peak !== null && peak <= expect.maxTruePeakDbfs, peak, expect.maxTruePeakDbfs);
  return checks;
}

type Outcome = { status: "ok"; data: unknown } | { status: "refused"; reason: string; next?: string };

export async function mediaQualityProbe(args: Record<string, unknown>): Promise<Outcome> {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  if (!raw || !path.isAbsolute(raw)) return { status: "refused", reason: "path_invalid", next: "pass an absolute path to a local media file" };
  if (!MEDIA_EXTENSIONS.has(path.extname(raw).toLowerCase())) return { status: "refused", reason: "not_media", next: `extensions: ${[...MEDIA_EXTENSIONS].join(" ")}` };
  let real: string;
  try {
    real = await fs.realpath(raw);
    if (!(await fs.stat(real)).isFile()) return { status: "refused", reason: "not_a_file" };
  } catch { return { status: "refused", reason: "file_missing" }; }
  const probe = await engine("ffprobe");
  if (!probe) return { status: "refused", reason: "ffprobe_unavailable", next: "install ffmpeg (ffprobe) on this machine" };
  const result = await run(probe, ["-v", "error", "-protocol_whitelist", "file", "-show_entries",
    "format=format_name,duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,channels,sample_rate", "-of", "json", real], 60_000);
  if (result.code !== 0) return { status: "refused", reason: "probe_failed", next: result.stderr.trim().slice(0, 200) };
  const meta = JSON.parse(result.stdout || "{}") as { format?: { format_name?: string; duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; channels?: number; sample_rate?: string }> };
  const videoStream = meta.streams?.find((s) => s.codec_type === "video");
  const audioStream = meta.streams?.find((s) => s.codec_type === "audio");
  const base: Omit<MediaQualityReport, "checks" | "pass"> = {
    schemaVersion: "agentlas.media-quality.v1",
    sizeBytes: num(meta.format?.size) ?? (await fs.stat(real)).size,
    container: meta.format?.format_name ?? "unknown",
    durationSec: num(meta.format?.duration),
    video: videoStream && Number.isSafeInteger(videoStream.width) && Number.isSafeInteger(videoStream.height)
      ? { codec: videoStream.codec_name ?? "unknown", width: videoStream.width!, height: videoStream.height!, fps: fps(videoStream.avg_frame_rate) } : null,
    audio: audioStream ? { codec: audioStream.codec_name ?? "unknown", channels: num(audioStream.channels), sampleRate: num(audioStream.sample_rate) } : null,
  };
  const expect = (args.expect && typeof args.expect === "object" && !Array.isArray(args.expect) ? args.expect : {}) as MediaQualityExpect;
  const wantLoudness = args.loudness === true || expect.maxIntegratedLufs !== undefined || expect.minIntegratedLufs !== undefined || expect.maxTruePeakDbfs !== undefined;
  if (wantLoudness && base.audio) {
    const ffmpeg = await engine("ffmpeg");
    if (!ffmpeg) return { status: "refused", reason: "ffmpeg_unavailable", next: "loudness needs ffmpeg" };
    const loud = await run(ffmpeg, ["-nostdin", "-hide_banner", "-protocol_whitelist", "file", "-i", real, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], 300_000);
    base.loudness = parseEbur128Summary(loud.stderr);
  } else if (wantLoudness) base.loudness = { integratedLufs: null, truePeakDbfs: null };
  const checks = mediaQualityChecks(base, expect);
  return { status: "ok", data: { ...base, checks, pass: checks.every((check) => check.pass) } satisfies MediaQualityReport };
}
