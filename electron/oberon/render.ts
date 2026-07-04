import { app, shell } from "electron";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { promisify } from "util";
import { GoogleGenAI, type GenerateVideosOperation } from "@google/genai";
import type {
  OberonRenderClip,
  OberonRenderFile,
  OberonRenderJob,
  OberonRenderProvider,
  OberonRenderRequest,
  OberonRenderShotInput,
} from "../../shared/types";
import { readEnvVar } from "../secrets/vault";
import { mergeContinuityNegative } from "../../shared/oberon-sheets";
import { composeTitledDelivery } from "./titlecards";
import { currentUiLocale } from "../main";

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "veo-3.1-lite-generate-001";
const DEFAULT_MAX_SHOTS = 3;
const DEFAULT_RESOLUTION = "720p";
const POLL_MS = 10_000;
const MAX_POLLS = 72;

const jobs = new Map<string, OberonRenderJob>();
const cancelledJobs = new Set<string>();

class RenderCancelled extends Error {
  constructor() {
    super("Render cancelled");
  }
}

export function startOberonRender(request: OberonRenderRequest): OberonRenderJob {
  const ko = currentUiLocale() === "ko";
  const shots = selectShots(request);
  if (!shots.length) throw new Error("Oberon render requires at least one shot.");

  const id = randomUUID();
  const provider = request.provider ?? "google-enterprise-veo";
  const model = request.model || DEFAULT_MODEL;
  const outputDir = path.join(app.getPath("userData"), "oberon", `${safeSlug(request.title)}-${id.slice(0, 8)}`);
  const clips = planClips(shots, provider, model, request.takesPerShot);
  const now = Date.now();
  const job: OberonRenderJob = {
    id,
    productionId: request.productionId,
    title: request.title,
    provider,
    model,
    status: "queued",
    outputDir,
    progress: {
      phase: "queued",
      totalClips: clips.length,
      completedClips: 0,
      percent: 0,
    },
    clips,
    files: [],
    message: ko ? "렌더 준비 중" : "Preparing the render",
    warnings: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
  jobs.set(id, job);
  void runRenderJob(id, request, shots).catch((error: unknown) => failJob(id, error));
  return snapshot(job);
}

export function getOberonRenderJob(id: string): OberonRenderJob | null {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function cancelOberonRenderJob(id: string): OberonRenderJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  const ko = currentUiLocale() === "ko";
  cancelledJobs.add(id);
  job.status = "cancelled";
  job.progress.phase = "cancelled";
  job.message = ko ? "렌더 취소됨" : "Render cancelled";
  job.updatedAtMs = Date.now();
  return snapshot(job);
}

export async function openOberonRenderOutput(id: string): Promise<{ ok: boolean; message: string }> {
  const job = jobs.get(id);
  if (!job) return { ok: false, message: "Render job not found." };
  await fs.mkdir(job.outputDir, { recursive: true });
  const result = await shell.openPath(job.outputDir);
  return result ? { ok: false, message: result } : { ok: true, message: job.outputDir };
}

async function runRenderJob(id: string, request: OberonRenderRequest, shots: OberonRenderShotInput[]): Promise<void> {
  const ko = currentUiLocale() === "ko";
  const job = requireJob(id);
  await fs.mkdir(job.outputDir, { recursive: true });
  const client = await createGoogleClient(job.provider);
  updateJob(job, {
    status: "running",
    message: ko ? `Google Veo 렌더 시작 (${client.authLabel})` : `Starting Google Veo render (${client.authLabel})`,
    phase: "generating",
  });

  for (const clip of job.clips) {
    assertNotCancelled(job.id);
    const shot = shots.find((s) => s.shotId === clip.shotId);
    if (!shot) continue;
    clip.status = "generating";
    job.progress.currentShotId = shot.shotId;
    job.message = ko ? `${shot.shotId} 생성 중` : `Generating ${shot.shotId}`;
    job.updatedAtMs = Date.now();

    try {
      const file = await generateClip(client.ai, job, shot, clip, request);
      clip.status = "ready";
      clip.absPath = file.absPath;
      clip.url = file.url;
      clip.mime = file.mime;
      clip.sizeBytes = file.sizeBytes;
      job.files.push(file);
    } catch (error: unknown) {
      clip.status = "failed";
      clip.error = errorMessage(error);
      job.warnings.push(`${shot.shotId}: ${clip.error}`);
    } finally {
      job.progress.completedClips += 1;
      job.progress.percent = percent(job.progress.completedClips, job.progress.totalClips);
      job.updatedAtMs = Date.now();
    }
  }

  assertNotCancelled(job.id);
  const readyClips = job.clips.filter((clip) => clip.status === "ready" && clip.absPath);
  if (!readyClips.length) throw new Error("Google Veo did not return any usable clips.");

  updateJob(job, {
    status: "running",
    message: ko ? "클립을 이어붙이고 납품 파일을 만드는 중" : "Stitching clips and building delivery files",
    phase: "assembling",
  });
  const deliveryFiles = await assembleDeliveryFiles(job, readyClips, shots, request);
  job.files.push(...deliveryFiles);
  updateJob(job, {
    status: "succeeded",
    message: ko ? "렌더 완료" : "Render complete",
    phase: "complete",
  });
}

async function generateClip(
  ai: GoogleGenAI,
  job: OberonRenderJob,
  shot: OberonRenderShotInput,
  clip: OberonRenderClip,
  request: OberonRenderRequest,
): Promise<OberonRenderFile> {
  const clipName = `${String(shot.index + 1).padStart(3, "0")}_${safeSlug(shot.shotId)}_take${clip.attempt}.mp4`;
  const clipPath = path.join(job.outputDir, clipName);
  const durationSeconds = normalizeDuration(shot.durationSec, request.resolution);
  const prompt = buildVeoPrompt(request, shot, durationSeconds);
  const firstFrame = await loadFrame(shot.firstFrame).catch((error: unknown) => {
    job.warnings.push(`${shot.shotId}: first frame skipped (${errorMessage(error)})`);
    return null;
  });
  // END 프레임 보간(START/END 체이닝) — Veo lastFrame은 image-to-video일 때만 지원되므로
  // firstFrame이 실제로 실렸을 때만 함께 싣는다.
  const lastFrame = firstFrame
    ? await loadFrame(shot.lastFrame).catch((error: unknown) => {
        job.warnings.push(`${shot.shotId}: last frame skipped (${errorMessage(error)})`);
        return null;
      })
    : null;

  const videoRequest: {
    model: string;
    prompt: string;
    image?: { imageBytes: string; mimeType: string };
    config: {
      numberOfVideos: number;
      durationSeconds: 4 | 6 | 8;
      aspectRatio: "16:9" | "9:16";
      resolution: "720p" | "1080p" | "4k";
      negativePrompt?: string;
      enhancePrompt: boolean;
      generateAudio?: boolean;
      personGeneration: "allow_adult" | "allow_all";
      seed?: number;
      lastFrame?: { imageBytes: string; mimeType: string };
    };
  } = {
    model: job.model,
    prompt,
    config: {
      numberOfVideos: 1,
      durationSeconds,
      aspectRatio: normalizeAspect(request.aspectRatio || shot.aspectRatio),
      resolution: request.resolution ?? DEFAULT_RESOLUTION,
      // 연속성 네거티브 캐논(드리프트·플리커·AI결함) 병합 — 세계가 샷 중간에 표류하는 것을 막는다.
      negativePrompt: mergeContinuityNegative(shot.negativePrompt),
      enhancePrompt: true,
      personGeneration: firstFrame ? "allow_adult" : "allow_all",
    },
  };
  if (job.provider === "google-enterprise-veo") {
    videoRequest.config.generateAudio = true;
    videoRequest.config.seed = stableSeed(`${request.productionId}:${shot.shotId}:${clip.attempt}`);
  }
  if (firstFrame) videoRequest.image = firstFrame;
  if (lastFrame) videoRequest.config.lastFrame = lastFrame;

  let operation: GenerateVideosOperation = await ai.models.generateVideos(videoRequest);

  for (let i = 0; !operation.done && i < MAX_POLLS; i += 1) {
    assertNotCancelled(job.id);
    await delay(POLL_MS);
    operation = await ai.operations.getVideosOperation({ operation });
  }
  if (!operation.done) throw new Error("Veo operation timed out before completion.");
  if (operation.error) throw new Error(JSON.stringify(operation.error));

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) {
    const reasons = operation.response?.raiMediaFilteredReasons?.join(", ");
    throw new Error(reasons ? `Veo filtered the clip: ${reasons}` : "Veo returned no video.");
  }
  if (video.videoBytes) {
    await fs.writeFile(clipPath, Buffer.from(video.videoBytes, "base64"));
  } else if (video.uri) {
    await ai.files.download({ file: video.uri, downloadPath: clipPath });
  } else {
    throw new Error("Veo returned a video without uri or videoBytes.");
  }
  return makeRenderFile("clip_mp4", `Clip ${shot.shotId}`, clipPath, "video/mp4");
}

async function assembleDeliveryFiles(
  job: OberonRenderJob,
  readyClips: OberonRenderClip[],
  shots: OberonRenderShotInput[],
  request: OberonRenderRequest,
): Promise<OberonRenderFile[]> {
  const ko = currentUiLocale() === "ko";
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    job.warnings.push("ffmpeg not found; only individual MP4 clips were saved.");
    return [];
  }

  const ordered = [...readyClips].sort((a, b) => {
    const ai = shots.find((s) => s.shotId === a.shotId)?.index ?? 0;
    const bi = shots.find((s) => s.shotId === b.shotId)?.index ?? 0;
    return ai - bi || a.attempt - b.attempt;
  });
  const masterMp4 = path.join(job.outputDir, `${safeSlug(request.title)}_master.mp4`);
  const masterMov = path.join(job.outputDir, `${safeSlug(request.title)}_master.mov`);
  const masterWav = path.join(job.outputDir, `${safeSlug(request.title)}_audio.wav`);

  if (ordered.length === 1) {
    await fs.copyFile(ordered[0].absPath!, masterMp4);
  } else {
    const listPath = path.join(job.outputDir, "concat.txt");
    await fs.writeFile(
      listPath,
      ordered.map((clip) => `file '${clip.absPath!.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8",
    );
    try {
      await runFfmpeg(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", masterMp4]);
    } catch {
      await runFfmpeg(ffmpeg, [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        masterMp4,
      ]);
    }
  }

  try {
    await runFfmpeg(ffmpeg, ["-y", "-i", masterMp4, "-c", "copy", masterMov]);
  } catch {
    await runFfmpeg(ffmpeg, ["-y", "-i", masterMp4, "-c:v", "libx264", "-c:a", "aac", masterMov]);
  }

  try {
    await runFfmpeg(ffmpeg, ["-y", "-i", masterMp4, "-vn", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", masterWav]);
  } catch {
    const fallbackDuration = Math.max(1, Math.ceil(shots.reduce((sum, shot) => sum + normalizeDuration(shot.durationSec, request.resolution), 0)));
    job.warnings.push("No audio track was available; generated a silent WAV bed.");
    await runFfmpeg(ffmpeg, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t",
      String(fallbackDuration),
      masterWav,
    ]);
  }

  const files: OberonRenderFile[] = [
    await makeRenderFile("master_mp4", "Master MP4", masterMp4, "video/mp4"),
    await makeRenderFile("master_mov", "Master MOV", masterMov, "video/quicktime"),
    await makeRenderFile("master_wav", "Audio WAV", masterWav, "audio/wav"),
  ];

  // 타이틀/로어서드/자막 결정적 번인 (스펙이 있을 때만). 실패해도 마스터는 유지.
  if (request.titles) {
    try {
      const titled = await composeTitledDelivery({
        ffmpeg,
        masterMp4,
        outDir: job.outputDir,
        baseName: safeSlug(request.title),
        spec: request.titles,
      });
      for (const w of titled.warnings) job.warnings.push(w);
      for (const f of titled.files) files.push(await makeRenderFile(f.kind, f.label, f.absPath, f.mime));
    } catch (error: unknown) {
      job.warnings.push(ko ? `타이틀 번인 건너뜀: ${errorMessage(error)}` : `Skipped title burn-in: ${errorMessage(error)}`);
    }
  }

  return files;
}

async function createGoogleClient(provider: OberonRenderProvider): Promise<{ ai: GoogleGenAI; authLabel: string }> {
  if (provider === "google-enterprise-veo") {
    const project = await readFirstSecret(["GOOGLE_CLOUD_PROJECT"]);
    const location = await readFirstSecret(["GOOGLE_CLOUD_LOCATION"]);
    const credentials = await readFirstSecret(["GOOGLE_APPLICATION_CREDENTIALS"]);
    if (credentials?.value) process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials.value;
    if (project?.value) {
      return {
        ai: new GoogleGenAI({
          enterprise: true,
          project: project.value,
          location: location?.value || "global",
        }),
        authLabel: `Agent Platform ${project.key}`,
      };
    }
  }

  const apiKey = await readFirstSecret(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  if (apiKey?.value) {
    return {
      ai: new GoogleGenAI({ apiKey: apiKey.value }),
      authLabel: apiKey.key,
    };
  }

  throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required in the Agentlas env vault for Google Veo rendering.");
}

async function readFirstSecret(keys: string[]): Promise<{ key: string; value: string } | null> {
  for (const key of keys) {
    const fromVault = await readEnvVar(key);
    const value = (fromVault || process.env[key] || "").trim();
    if (value) return { key, value };
  }
  return null;
}

function selectShots(request: OberonRenderRequest): OberonRenderShotInput[] {
  const maxShots = Math.max(1, Math.min(request.maxShots ?? DEFAULT_MAX_SHOTS, request.shots.length));
  return request.shots.slice(0, maxShots);
}

function planClips(
  shots: OberonRenderShotInput[],
  provider: OberonRenderProvider,
  model: string,
  takesPerShot?: number,
): OberonRenderClip[] {
  const count = Math.max(1, Math.min(takesPerShot ?? 1, 4));
  return shots.flatMap((shot) =>
    Array.from({ length: count }, (_, i) => ({
      shotId: shot.shotId,
      takeId: `${shot.shotId}_live${String(i + 1).padStart(2, "0")}`,
      attempt: i + 1,
      status: "queued" as const,
      provider,
      model,
      prompt: shot.prompt,
      createdAtMs: Date.now(),
    })),
  );
}

function buildVeoPrompt(request: OberonRenderRequest, shot: OberonRenderShotInput, durationSeconds: number): string {
  const parts = [
    shot.prompt,
    `Create one self-contained cinematic clip for production "${request.title}".`,
    `Target duration: ${durationSeconds} seconds. Camera moves and subject action must resolve to a clean, stable final frame for the editorial cut.`,
    "Preserve continuity with the shot description: same characters, wardrobe, lighting and screen direction.",
    // 순차 메모리 체인 — 이 샷은 직전 샷의 END 프레임에서 픽셀 단위로 이어진다.
    shot.chainedFromShotId
      ? `This shot continues DIRECTLY from where shot ${shot.chainedFromShotId} ended — same characters in the same positions, same lighting, same screen direction; do not reset the scene.`
      : "",
    shot.firstFrame ? "Use the provided first-frame image as the exact opening composition, then animate from it." : "",
    shot.lastFrame
      ? "Resolve the motion so the clip ends EXACTLY on the provided last-frame image — same framing, pose and lighting — so the next cut can continue from it."
      : "",
    // Veo 3.1은 네이티브 동기 오디오를 생성한다 — 위에 기술된 대사/앰비언스/SFX를 정확히 동기화.
    "Generate synchronized native audio (dialogue, ambience, SFX) exactly as described above; keep any dialogue precisely lip-synced.",
    // 글자는 후반 번인 — 프레임 안에 텍스트를 그리지 않는다.
    "No on-screen subtitles, titles, captions, watermarks, UI overlays, or distorted text in the frame.",
  ].filter(Boolean);
  return parts.join("\n").slice(0, 3900);
}

async function loadFrame(
  frame: OberonRenderShotInput["firstFrame"],
): Promise<{ imageBytes: string; mimeType: string } | null> {
  if (frame?.imageBytes) {
    return {
      imageBytes: frame.imageBytes,
      mimeType: frame.mimeType || "image/png",
    };
  }
  if (!frame?.absPath) return null;
  const bytes = await fs.readFile(frame.absPath);
  return {
    imageBytes: bytes.toString("base64"),
    mimeType: frame.mimeType || "image/png",
  };
}

function normalizeAspect(aspect: string): "16:9" | "9:16" {
  return aspect === "9:16" ? "9:16" : "16:9";
}

function normalizeDuration(durationSec: number, resolution?: string): 4 | 6 | 8 {
  if (resolution === "1080p" || resolution === "4k") return 8;
  if (durationSec <= 4.5) return 4;
  if (durationSec <= 6.5) return 6;
  return 8;
}

function updateJob(
  job: OberonRenderJob,
  patch: { status: OberonRenderJob["status"]; message: string; phase: OberonRenderJob["progress"]["phase"] },
): void {
  job.status = patch.status;
  job.message = patch.message;
  job.progress.phase = patch.phase;
  job.progress.percent = percent(job.progress.completedClips, job.progress.totalClips);
  job.updatedAtMs = Date.now();
}

function failJob(id: string, error: unknown): void {
  const job = jobs.get(id);
  if (!job) return;
  const ko = currentUiLocale() === "ko";
  if (cancelledJobs.has(id) || error instanceof RenderCancelled) {
    job.status = "cancelled";
    job.progress.phase = "cancelled";
    job.message = ko ? "렌더 취소됨" : "Render cancelled";
  } else {
    job.status = "failed";
    job.progress.phase = "failed";
    job.error = errorMessage(error);
    job.message = job.error;
  }
  job.updatedAtMs = Date.now();
}

function requireJob(id: string): OberonRenderJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Render job not found: ${id}`);
  return job;
}

function assertNotCancelled(id: string): void {
  if (cancelledJobs.has(id)) throw new RenderCancelled();
}

async function makeRenderFile(
  kind: OberonRenderFile["kind"],
  label: string,
  absPath: string,
  mime: string,
): Promise<OberonRenderFile> {
  const stat = await fs.stat(absPath);
  return {
    id: randomUUID(),
    kind,
    name: path.basename(absPath),
    label,
    absPath,
    url: pathToFileURL(absPath).href,
    mime,
    sizeBytes: stat.size,
  };
}

async function findFfmpeg(): Promise<string | null> {
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

async function runFfmpeg(bin: string, args: string[]): Promise<void> {
  await execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 8 });
}

function snapshot(job: OberonRenderJob): OberonRenderJob {
  return {
    ...job,
    progress: { ...job.progress },
    clips: job.clips.map((clip) => ({ ...clip })),
    files: job.files.map((file) => ({ ...file })),
    warnings: [...job.warnings],
  };
}

function stableSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function percent(done: number, total: number): number {
  return Math.round((done / Math.max(1, total)) * 100);
}

function safeSlug(value: string): string {
  return value
    .trim()
    .replace(/[^\w가-힣-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 48) || "oberon";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
