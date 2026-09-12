import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediaOutputVerification } from "../../shared/media-output";
import { envForCli } from "../runtime/exec";

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

export class MediaVerificationError extends Error {
  constructor(readonly reasonCode: string, message: string) { super(message); }
}

async function digestFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function engine(name: "ffmpeg" | "ffprobe"): Promise<string> {
  const candidates = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const directory of [...new Set(candidates)]) {
    const candidate = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      const real = await fs.realpath(candidate);
      if (!(await fs.stat(real)).isFile()) continue;
      await fs.access(real, constants.X_OK);
      return real;
    } catch { /* Try the next installed executable; never install silently. */ }
  }
  throw new MediaVerificationError("media_verifier_unavailable", `${name} is required to verify the generated video.`);
}

function execute(bin: string, args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new MediaVerificationError("media_verification_cancelled", "Video verification stopped.")); return; }
    const child = spawn(bin, args, { env: envForCli(bin), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", diagnostic = "", failure: Error | null = null;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(new MediaVerificationError("media_verification_cancelled", "Video verification stopped."));
    const timer = setTimeout(() => stop(new MediaVerificationError("media_verification_timeout", "Video verification timed out.")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > OUTPUT_LIMIT) stop(new MediaVerificationError("media_verifier_output_limit", "Video metadata exceeds the verification limit.")); });
    child.stderr.on("data", chunk => { diagnostic += chunk.toString(); if (diagnostic.length > OUTPUT_LIMIT) stop(new MediaVerificationError("media_verifier_output_limit", "Video diagnostics exceed the verification limit.")); });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || diagnostic.trim()) reject(new MediaVerificationError("media_decode_failed", "The generated file could not be fully decoded as a video."));
      else resolve(output);
    });
  });
}

/** Copy once, decode the copy, and publish those exact bytes under a digest name.
 * The caller owns allowedRoot; a provider path is never an authority to widen it. */
export async function verifyVideoOutput(input: {
  sourcePath: string;
  allowedRoot: string;
  criteria?: MediaOutputVerification["criteria"];
  signal?: AbortSignal;
}): Promise<{ path: string; verification: MediaOutputVerification }> {
  const criteria = { ...input.criteria };
  for (const value of [criteria.durationSec, criteria.minWidth, criteria.minHeight]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new MediaVerificationError("media_criteria_invalid", "The requested video dimensions or duration are invalid.");
  }
  if (criteria.aspectRatio !== undefined && !["16:9", "9:16", "1:1"].includes(criteria.aspectRatio)) throw new MediaVerificationError("media_criteria_invalid", "The requested aspect ratio is invalid.");
  const root = await fs.realpath(input.allowedRoot);
  const source = path.resolve(input.sourcePath);
  const resolved = await fs.realpath(source);
  if (!resolved.startsWith(`${root}${path.sep}`) || resolved !== source || !(await fs.lstat(source)).isFile()) {
    throw new MediaVerificationError("media_output_scope_mismatch", "The video file is outside its output folder.");
  }
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let staging: string | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_VIDEO_BYTES) throw new MediaVerificationError("media_output_size_invalid", "The video file is empty or exceeds the size limit.");
    staging = await fs.mkdtemp(path.join(root, ".media-verify-"));
    const copy = path.join(staging, "video.mp4");
    const destination = await fs.open(copy, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(256 * 1024);
      let position = 0;
      while (position < before.size) {
        if (input.signal?.aborted) throw new MediaVerificationError("media_verification_cancelled", "Video verification stopped.");
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new MediaVerificationError("media_output_changed", "The video changed while it was being copied.");
        let written = 0;
        while (written < bytesRead) written += (await destination.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
        position += bytesRead;
      }
      await destination.sync();
    } finally { await destination.close(); }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new MediaVerificationError("media_output_changed", "The video changed while it was being copied.");
    const [probe, decoder] = await Promise.all([engine("ffprobe"), engine("ffmpeg")]);
    const engines = await Promise.all(([ ["ffprobe", probe], ["ffmpeg", decoder] ] as const).map(async ([name, bin]) => ({ name, sha256: await digestFile(bin), version: (await execute(bin, ["-version"], input.signal, 10_000)).split("\n")[0].slice(0, 256) })));
    // Force a self-contained MP4/MOV demuxer. Playlist/network protocols cannot
    // turn a generated result into arbitrary fetches during verification.
    const probeArgs = ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-count_frames", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,duration,nb_read_frames,channels", "-of", "json", copy];
    const metadata = JSON.parse(await execute(probe, probeArgs, input.signal)) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; nb_read_frames?: string; channels?: number }> };
    const video = metadata.streams?.find(stream => stream.codec_type === "video");
    const audio = metadata.streams?.find(stream => stream.codec_type === "audio");
    const duration = Number(video?.duration ?? metadata.format?.duration), frames = Number(video?.nb_read_frames);
    if (!video || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width! <= 0 || video.height! <= 0
      || !Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(frames) || frames <= 0) throw new MediaVerificationError("media_video_stream_invalid", "The file contains no complete video stream.");
    const ratio = criteria.aspectRatio?.split(":").map(Number);
    if ((criteria.durationSec !== undefined && Math.abs(duration - criteria.durationSec) > Math.max(0.25, criteria.durationSec * 0.05))
      || (criteria.minWidth !== undefined && video.width! < criteria.minWidth)
      || (criteria.minHeight !== undefined && video.height! < criteria.minHeight)
      || (ratio && Math.abs(video.width! / video.height! - ratio[0] / ratio[1]) > 0.02)
      || (criteria.requireAudio && !audio)) throw new MediaVerificationError("media_output_criteria_mismatch", "The generated video does not meet the requested duration, dimensions or audio requirements.");
    await execute(decoder, ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", copy, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], input.signal);
    if (await digestFile(probe) !== engines[0].sha256 || await digestFile(decoder) !== engines[1].sha256) throw new MediaVerificationError("media_verifier_changed", "The video verification engine changed during verification.");
    if (input.signal?.aborted) throw new MediaVerificationError("media_verification_cancelled", "Video verification stopped.");
    const sha256 = await digestFile(copy);
    const verification: MediaOutputVerification = { schemaVersion: "agentlas.media-output.v1", sha256, sizeBytes: before.size, container: metadata.format?.format_name ?? "mov",
      video: { codec: video.codec_name ?? "unknown", width: video.width!, height: video.height!, durationSec: duration, decodedFrames: frames },
      audio: audio ? { present: true, codec: audio.codec_name, channels: audio.channels } : { present: false }, criteria, engines, verifiedAt: new Date().toISOString() };
    const target = path.join(root, `verified-${sha256}.mp4`);
    try { await fs.link(copy, target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await fs.lstat(target)).isFile() || await digestFile(target) !== sha256) throw error;
    }
    return { path: target, verification };
  } finally {
    await handle.close();
    if (staging) await fs.rm(staging, { recursive: true, force: true });
  }
}
