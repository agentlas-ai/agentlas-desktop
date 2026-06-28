import { app, shell } from "electron";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { GoogleGenAI, PersonGeneration } from "@google/genai";
import type {
  OberonKeyframeAsset,
  OberonKeyframeJob,
  OberonKeyframeProvider,
  OberonKeyframeRequest,
  OberonKeyframeShotInput,
} from "../../shared/types";
import { readEnvVar } from "../secrets/vault";

const DEFAULT_PROVIDER: OberonKeyframeProvider = "codex-imagegen-cli";
const DEFAULT_CODEX_MODEL = "image_gen.imagegen";
const DEFAULT_GOOGLE_MODEL = "imagen-4.0-generate-001";
const CODEX_IMAGE_BATCH_RUNNER_RELATIVE = path.join(
  ".codex",
  "plugins",
  "cache",
  "openai-curated-remote",
  "creative-production",
  "0.1.23",
  "runtime",
  "codex_exec_image_batch.py",
);

const jobs = new Map<string, OberonKeyframeJob>();
const cancelledJobs = new Set<string>();

class KeyframeCancelled extends Error {
  constructor() {
    super("Keyframe generation cancelled");
  }
}

export function startOberonKeyframes(request: OberonKeyframeRequest): OberonKeyframeJob {
  const shots = selectShots(request);
  if (!shots.length) throw new Error("Oberon keyframe generation requires at least one shot.");

  const id = randomUUID();
  const provider = request.provider ?? DEFAULT_PROVIDER;
  const model = request.model || (provider === "google-imagen" ? DEFAULT_GOOGLE_MODEL : DEFAULT_CODEX_MODEL);
  const outputDir = path.join(app.getPath("userData"), "oberon", `${safeSlug(request.title)}-${id.slice(0, 8)}`, "keyframes");
  const now = Date.now();
  const job: OberonKeyframeJob = {
    id,
    productionId: request.productionId,
    title: request.title,
    provider,
    model,
    status: "queued",
    outputDir,
    progress: {
      phase: "queued",
      totalImages: shots.length,
      completedImages: 0,
      percent: 0,
    },
    assets: [],
    message: "키프레임 준비 중",
    warnings: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
  jobs.set(id, job);
  void runKeyframeJob(id, request, shots).catch((error: unknown) => failJob(id, error));
  return snapshot(job);
}

export function getOberonKeyframeJob(id: string): OberonKeyframeJob | null {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function cancelOberonKeyframes(id: string): OberonKeyframeJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  cancelledJobs.add(id);
  job.status = "cancelled";
  job.progress.phase = "cancelled";
  job.message = "키프레임 생성 취소됨";
  job.updatedAtMs = Date.now();
  return snapshot(job);
}

export async function openOberonKeyframeOutput(id: string): Promise<{ ok: boolean; message: string }> {
  const job = jobs.get(id);
  if (!job) return { ok: false, message: "Keyframe job not found." };
  await fs.mkdir(job.outputDir, { recursive: true });
  const result = await shell.openPath(job.outputDir);
  return result ? { ok: false, message: result } : { ok: true, message: job.outputDir };
}

async function runKeyframeJob(
  id: string,
  request: OberonKeyframeRequest,
  shots: OberonKeyframeShotInput[],
): Promise<void> {
  const job = requireJob(id);
  await fs.mkdir(job.outputDir, { recursive: true });
  if (job.provider === "codex-imagegen-cli") {
    await runCodexKeyframeJob(job, request, shots);
    return;
  }

  const client = await createGoogleClient(job.provider);
  updateJob(job, "running", "Google Imagen 키프레임 생성 시작", "generating");

  for (const shot of shots) {
    assertNotCancelled(job.id);
    job.progress.currentShotId = shot.shotId;
    job.message = `${shot.shotId} 첫 프레임 생성 중`;
    job.updatedAtMs = Date.now();
    try {
      const asset = await generateKeyframe(client.ai, job, request, shot);
      job.assets.push(asset);
    } catch (error: unknown) {
      job.warnings.push(`${shot.shotId}: ${errorMessage(error)}`);
    } finally {
      job.progress.completedImages += 1;
      job.progress.percent = percent(job.progress.completedImages, job.progress.totalImages);
      job.updatedAtMs = Date.now();
    }
  }

  assertNotCancelled(job.id);
  if (!job.assets.length) throw new Error("Google Imagen did not return any usable keyframes.");
  if (job.assets.length < shots.length) {
    throw new Error(`Google Imagen generated ${job.assets.length}/${shots.length} keyframes. Retry the missing shots before video render.`);
  }
  updateJob(
    job,
    "succeeded",
    "키프레임 생성 완료",
    "complete",
  );
}

async function runCodexKeyframeJob(
  job: OberonKeyframeJob,
  request: OberonKeyframeRequest,
  shots: OberonKeyframeShotInput[],
): Promise<void> {
  const runner = codexImageBatchRunnerPath();
  await fs.access(runner);
  const jobsPath = path.join(job.outputDir, "codex-image-jobs.jsonl");
  const rows = shots.map((shot) => {
    const fileName = `${String(shot.index + 1).padStart(3, "0")}_${safeSlug(shot.shotId)}_first_frame.png`;
    return JSON.stringify({
      id: shot.shotId,
      prompt: buildImagePrompt(request, shot),
      output: fileName,
      shotId: shot.shotId,
      title: request.title,
      aspectRatio: normalizeAspect(request.aspectRatio || shot.aspectRatio),
      route: "oberon-keyframe",
    });
  });
  await fs.writeFile(jobsPath, `${rows.join("\n")}\n`, "utf8");
  updateJob(job, "running", "Codex image_gen 키프레임 생성 시작", "generating");

  const result = await runImageBatchProcess(job, jobsPath, shots.length, runner);
  const summaryPath = path.join(job.outputDir, "codex-exec-image-results.json");
  const summary = await readJsonFile<{
    results?: Array<{ id?: string; status?: string; image_path?: string; error?: string }>;
  }>(summaryPath).catch(() => null);
  if (!summary?.results?.length) {
    throw new Error(result.stderr || "Codex image_gen did not write a result summary.");
  }

  const byId = new Map(summary.results.map((item) => [String(item.id || ""), item]));
  for (const shot of shots) {
    assertNotCancelled(job.id);
    const item = byId.get(shot.shotId);
    if (item?.status === "complete" && item.image_path) {
      const prompt = buildImagePrompt(request, shot);
      job.assets.push(await makeKeyframeAsset(job, shot.shotId, prompt, item.image_path, "image/png"));
    } else {
      job.warnings.push(`${shot.shotId}: ${item?.error || "Codex image_gen did not return an image."}`);
    }
    job.progress.completedImages = job.assets.length;
    job.progress.percent = percent(job.progress.completedImages, job.progress.totalImages);
    job.updatedAtMs = Date.now();
  }

  if (!job.assets.length) throw new Error("Codex image_gen did not return any usable keyframes.");
  if (job.assets.length < shots.length) {
    throw new Error(`Codex image_gen generated ${job.assets.length}/${shots.length} keyframes. Retry the missing shots before video render.`);
  }
  updateJob(job, "succeeded", "키프레임 생성 완료", "complete");
}

async function generateKeyframe(
  ai: GoogleGenAI,
  job: OberonKeyframeJob,
  request: OberonKeyframeRequest,
  shot: OberonKeyframeShotInput,
): Promise<OberonKeyframeAsset> {
  const prompt = buildImagePrompt(request, shot);
  const response = await ai.models.generateImages({
    model: job.model,
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: normalizeAspect(request.aspectRatio || shot.aspectRatio),
      imageSize: request.imageSize ?? "1K",
      personGeneration: PersonGeneration.ALLOW_ADULT,
    },
  });
  const image = response.generatedImages?.[0]?.image;
  const bytes = image?.imageBytes;
  if (!bytes) throw new Error("Imagen returned no image bytes.");

  const fileName = `${String(shot.index + 1).padStart(3, "0")}_${safeSlug(shot.shotId)}_first_frame.png`;
  const absPath = path.join(job.outputDir, fileName);
  await fs.writeFile(absPath, Buffer.from(bytes, "base64"));
  return makeKeyframeAsset(job, shot.shotId, prompt, absPath, image?.mimeType || "image/png");
}

async function makeKeyframeAsset(
  job: OberonKeyframeJob,
  shotId: string,
  prompt: string,
  absPath: string,
  mime: string,
): Promise<OberonKeyframeAsset> {
  const stat = await fs.stat(absPath);
  return {
    id: randomUUID(),
    shotId,
    kind: "first_frame",
    provider: job.provider,
    model: job.model,
    prompt,
    absPath,
    url: pathToFileURL(absPath).href,
    mime,
    sizeBytes: stat.size,
    createdAtMs: Date.now(),
  };
}

async function createGoogleClient(provider: OberonKeyframeProvider): Promise<{ ai: GoogleGenAI; authLabel: string }> {
  if (provider !== "google-imagen") throw new Error(`Unsupported keyframe provider: ${provider}`);
  const apiKey = await readFirstSecret(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  if (apiKey?.value) {
    return {
      ai: new GoogleGenAI({ apiKey: apiKey.value }),
      authLabel: apiKey.key,
    };
  }
  throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required in the Agentlas env vault for Google Imagen keyframes.");
}

async function runImageBatchProcess(
  job: OberonKeyframeJob,
  jobsPath: string,
  shotCount: number,
  runner: string,
): Promise<{ code: number | null; stderr: string }> {
  const pythonBin = await findExecutable([
    process.env.PYTHON_BIN,
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "python3",
  ]);
  const codexBin = await findExecutable([
    process.env.CODEX_BIN,
    path.join(process.env.HOME || app.getPath("home"), ".local/bin/codex"),
    path.join(process.env.HOME || app.getPath("home"), ".codex/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "codex",
  ]);
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonBin,
      [
        runner,
        "--input",
        jobsPath,
        "--out-dir",
        job.outputDir,
        "--workspace",
        job.outputDir,
        "--codex-bin",
        codexBin,
        "--max-concurrency",
        String(Math.min(4, Math.max(1, shotCount))),
        "--max-attempts",
        "2",
        "--timeout-seconds",
        "600",
        "--preflight-timeout-seconds",
        "180",
        "--poll-interval",
        "0.5",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: stderr.trim() });
    });
  });
}

function codexImageBatchRunnerPath(): string {
  return (
    process.env.CODEX_IMAGE_BATCH_RUNNER ||
    process.env.CODEX_IMAGE_BATCH_SCRIPT ||
    path.join(app.getPath("home"), CODEX_IMAGE_BATCH_RUNNER_RELATIVE)
  );
}

async function findExecutable(candidates: Array<string | undefined>): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!candidate.includes(path.sep)) return candidate;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Required executable was not found.");
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readFirstSecret(keys: string[]): Promise<{ key: string; value: string } | null> {
  for (const key of keys) {
    const fromVault = await readEnvVar(key);
    const value = (fromVault || process.env[key] || "").trim();
    if (value) return { key, value };
  }
  return null;
}

function selectShots(request: OberonKeyframeRequest): OberonKeyframeShotInput[] {
  const maxShots = Math.max(1, Math.min(request.maxShots ?? request.shots.length, request.shots.length));
  return request.shots.slice(0, maxShots);
}

function buildImagePrompt(request: OberonKeyframeRequest, shot: OberonKeyframeShotInput): string {
  const parts = [
    shot.prompt,
    `Create one production-ready first-frame keyframe for "${request.title}".`,
    `Shot id: ${shot.shotId}. Camera size: ${shot.cameraSize || "cinematic"}.`,
    "No subtitles, no visible watermarks, no UI overlays, no distorted text.",
  ];
  if (shot.negativePrompt) parts.push(`Avoid: ${shot.negativePrompt}`);
  return parts.join("\n").slice(0, 3900);
}

function normalizeAspect(aspect: string): "1:1" | "3:4" | "4:3" | "9:16" | "16:9" {
  if (aspect === "9:16") return "9:16";
  if (aspect === "1:1") return "1:1";
  if (aspect === "4:5") return "3:4";
  if (aspect === "2.39:1") return "16:9";
  return "16:9";
}

function updateJob(
  job: OberonKeyframeJob,
  status: OberonKeyframeJob["status"],
  message: string,
  phase: OberonKeyframeJob["progress"]["phase"],
): void {
  job.status = status;
  job.message = message;
  job.progress.phase = phase;
  job.progress.percent = percent(job.progress.completedImages, job.progress.totalImages);
  job.updatedAtMs = Date.now();
}

function failJob(id: string, error: unknown): void {
  const job = jobs.get(id);
  if (!job) return;
  if (cancelledJobs.has(id) || error instanceof KeyframeCancelled) {
    job.status = "cancelled";
    job.progress.phase = "cancelled";
    job.message = "키프레임 생성 취소됨";
  } else {
    job.status = "failed";
    job.progress.phase = "failed";
    job.error = errorMessage(error);
    job.message = job.error;
  }
  job.updatedAtMs = Date.now();
}

function requireJob(id: string): OberonKeyframeJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Keyframe job not found: ${id}`);
  return job;
}

function assertNotCancelled(id: string): void {
  if (cancelledJobs.has(id)) throw new KeyframeCancelled();
}

function snapshot(job: OberonKeyframeJob): OberonKeyframeJob {
  return {
    ...job,
    progress: { ...job.progress },
    assets: job.assets.map((asset) => ({ ...asset })),
    warnings: [...job.warnings],
  };
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
