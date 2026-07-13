import { app, shell } from "electron";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
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
import { currentUiLocale } from "../ui-locale";
import { runGrokImagine } from "../multimodal/grok-imagine";
import { withPythonCacheBoundary } from "../runtime/python-cache";

const DEFAULT_PROVIDER: OberonKeyframeProvider = "codex-imagegen-cli";
const DEFAULT_CODEX_MODEL = "image_gen.imagegen";
const DEFAULT_GOOGLE_MODEL = "imagen-4.0-generate-001";
const DEFAULT_GROK_MODEL = "grok-imagine-image";
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
// 실행 중인 Codex 배치 자식 프로세스를 job id로 추적 — 취소/타임아웃 시 프로세스 그룹째 거두기 위함.
const runningChildren = new Map<string, ChildProcess>();

// detached로 띄운 자식은 프로세스 그룹 리더라 -pid로 그룹 전체에 시그널을 보낸다(자손 codex 포함).
// exec.ts terminateProbeProcess 패턴: SIGTERM 후 일정시간 뒤 SIGKILL(타이머는 unref로 종료 비차단).
function killChildGroup(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      const sigkill = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already exited
        }
      }, 1000);
      sigkill.unref?.();
      return;
    } catch {
      // fall through to direct child kill
    }
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}

class KeyframeCancelled extends Error {
  constructor() {
    super("Keyframe generation cancelled");
  }
}

export function startOberonKeyframes(request: OberonKeyframeRequest): OberonKeyframeJob {
  const ko = currentUiLocale() === "ko";
  const shots = selectShots(request);
  if (!shots.length) throw new Error("Oberon keyframe generation requires at least one shot.");

  const id = randomUUID();
  const provider = request.provider ?? DEFAULT_PROVIDER;
  const model =
    request.model ||
    (provider === "grok-cli-image"
      ? DEFAULT_GROK_MODEL
      : provider === "google-imagen"
        ? DEFAULT_GOOGLE_MODEL
        : DEFAULT_CODEX_MODEL);
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
    message: ko ? "키프레임 준비 중" : "Preparing keyframes",
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
  const ko = currentUiLocale() === "ko";
  cancelledJobs.add(id);
  job.status = "cancelled";
  job.progress.phase = "cancelled";
  job.message = ko ? "키프레임 생성 취소됨" : "Keyframe generation cancelled";
  job.updatedAtMs = Date.now();
  // 진행 중인 Codex 배치 자식이 있으면 프로세스 그룹째 종료 — 기존엔 플래그만 세워 자식이 계속 돌았다.
  const child = runningChildren.get(id);
  if (child) killChildGroup(child);
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
  const ko = currentUiLocale() === "ko";
  const job = requireJob(id);
  await fs.mkdir(job.outputDir, { recursive: true });
  if (job.provider === "codex-imagegen-cli") {
    await runCodexKeyframeJob(job, request, shots);
    return;
  }
  if (job.provider === "grok-cli-image") {
    await runGrokKeyframeJob(job, request, shots);
    return;
  }

  const client = await createGoogleClient(job.provider);
  updateJob(job, "running", ko ? "Google Imagen 키프레임 생성 시작" : "Starting Google Imagen keyframe generation", "generating");

  for (const shot of shots) {
    assertNotCancelled(job.id);
    job.progress.currentShotId = shot.shotId;
    job.progress.percent = Math.max(job.progress.percent, 1);
    job.message = ko ? `${shot.shotId} 첫 프레임 생성 중` : `Generating first frame for ${shot.shotId}`;
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
    ko ? "키프레임 생성 완료" : "Keyframe generation complete",
    "complete",
  );
}

async function runCodexKeyframeJob(
  job: OberonKeyframeJob,
  request: OberonKeyframeRequest,
  shots: OberonKeyframeShotInput[],
): Promise<void> {
  const ko = currentUiLocale() === "ko";
  const runner = codexImageBatchRunnerPath();
  await fs.access(runner);
  const jobsPath = path.join(job.outputDir, "codex-image-jobs.jsonl");
  const rows = shots.map((shot) => {
    const fileName = `${String(shot.index + 1).padStart(3, "0")}_${safeSlug(shot.shotId)}_${assetKindOf(shot)}.png`;
    return JSON.stringify({
      // 같은 샷의 first/last 두 항목이 배치 안에서 충돌하지 않게 고유 키 사용.
      id: batchRowKey(shot),
      prompt: buildImagePrompt(request, shot),
      output: fileName,
      shotId: shot.shotId,
      title: request.title,
      aspectRatio: normalizeAspect(shot.aspectRatio || request.aspectRatio),
      route: "oberon-keyframe",
    });
  });
  await fs.writeFile(jobsPath, `${rows.join("\n")}\n`, "utf8");
  updateJob(job, "running", ko ? "Codex image_gen 키프레임 생성 시작" : "Starting Codex image_gen keyframe generation", "generating");

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
    const item = byId.get(batchRowKey(shot));
    if (item?.status === "complete" && item.image_path) {
      const prompt = buildImagePrompt(request, shot);
      job.assets.push(await makeKeyframeAsset(job, shot, prompt, item.image_path, "image/png"));
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
  updateJob(job, "succeeded", ko ? "키프레임 생성 완료" : "Keyframe generation complete", "complete");
}

async function runGrokKeyframeJob(
  job: OberonKeyframeJob,
  request: OberonKeyframeRequest,
  shots: OberonKeyframeShotInput[],
): Promise<void> {
  const ko = currentUiLocale() === "ko";
  updateJob(job, "running", ko ? "Grok Imagine 컷 이미지 생성 시작" : "Starting Grok Imagine cut images", "generating");

  for (const shot of shots) {
    assertNotCancelled(job.id);
    job.progress.currentShotId = shot.shotId;
    job.message = ko ? `${shot.shotId} Grok 컷 이미지 생성 중` : `Generating Grok image for ${shot.shotId}`;
    job.updatedAtMs = Date.now();
    const prompt = buildImagePrompt(request, shot);
    const targetPath = path.join(
      job.outputDir,
      `${String(shot.index + 1).padStart(3, "0")}_${safeSlug(shot.shotId)}_${assetKindOf(shot)}.png`,
    );
    try {
      const generated = await runGrokImagine({
        prompt,
        cwd: job.outputDir,
        kind: "image",
        targetPath,
        preserveExtension: true,
        isCancelled: () => cancelledJobs.has(job.id),
      });
      if (!generated) throw new Error("Grok Imagine returned no usable image.");
      job.assets.push(await makeKeyframeAsset(job, shot, prompt, generated, await detectImageMime(generated)));
    } catch (error: unknown) {
      job.warnings.push(`${shot.shotId}: ${errorMessage(error)}`);
    } finally {
      job.progress.completedImages += 1;
      job.progress.percent = percent(job.progress.completedImages, job.progress.totalImages);
      job.updatedAtMs = Date.now();
    }
  }

  assertNotCancelled(job.id);
  if (!job.assets.length) throw new Error("Grok Imagine did not return any usable keyframes.");
  if (job.assets.length < shots.length) {
    throw new Error(`Grok Imagine generated ${job.assets.length}/${shots.length} keyframes. Retry the missing shots before video render.`);
  }
  updateJob(job, "succeeded", ko ? "Grok 컷 이미지 생성 완료" : "Grok cut images complete", "complete");
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
      // 샷별 비율 우선 — 시트(세로 바이블 등)는 프로덕션 기본 비율과 다를 수 있다.
      aspectRatio: normalizeAspect(shot.aspectRatio || request.aspectRatio),
      imageSize: request.imageSize ?? "1K",
      personGeneration: PersonGeneration.ALLOW_ADULT,
    },
  });
  const image = response.generatedImages?.[0]?.image;
  const bytes = image?.imageBytes;
  if (!bytes) throw new Error("Imagen returned no image bytes.");

  const fileName = `${String(shot.index + 1).padStart(3, "0")}_${safeSlug(shot.shotId)}_${assetKindOf(shot)}.png`;
  const absPath = path.join(job.outputDir, fileName);
  await fs.writeFile(absPath, Buffer.from(bytes, "base64"));
  return makeKeyframeAsset(job, shot, prompt, absPath, image?.mimeType || "image/png");
}

// 자산 종류: 시트 생성이면 assetKind 오버라이드, START/END 체이닝이면 frameRole 반영.
function assetKindOf(shot: OberonKeyframeShotInput): OberonKeyframeAsset["kind"] {
  if (shot.assetKind) return shot.assetKind;
  return shot.frameRole === "last" ? "last_frame" : "first_frame";
}

// Codex 배치 jsonl의 행 키 — 같은 샷의 first/last 항목을 구분한다.
function batchRowKey(shot: OberonKeyframeShotInput): string {
  return shot.frameRole === "last" ? `${shot.shotId}:last` : shot.shotId;
}

async function makeKeyframeAsset(
  job: OberonKeyframeJob,
  shot: OberonKeyframeShotInput,
  prompt: string,
  absPath: string,
  mime: string,
): Promise<OberonKeyframeAsset> {
  const stat = await fs.stat(absPath);
  return {
    id: randomUUID(),
    shotId: shot.shotId,
    kind: assetKindOf(shot),
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

async function detectImageMime(absPath: string): Promise<string> {
  const bytes = await fs.readFile(absPath);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
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
      // detached: 자기 프로세스 그룹의 리더가 되어 -pid로 자손(codex)까지 한 번에 거둘 수 있게.
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
        env: withPythonCacheBoundary(process.env),
      },
    );
    // 취소(cancelOberonKeyframes)·종료 정리가 이 자식에 도달할 수 있게 job id로 추적.
    runningChildren.set(job.id, child);
    let stderr = "";
    const progressTimer = setInterval(() => {
      void refreshCodexBatchProgress(job, shotCount);
    }, 1_000);
    progressTimer.unref?.();
    // 타임아웃 시에도 자식 단독이 아니라 프로세스 그룹째 종료(고아 codex 방지).
    const timer = setTimeout(() => killChildGroup(child), 15 * 60 * 1000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      runningChildren.delete(job.id);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      void refreshCodexBatchProgress(job, shotCount);
      runningChildren.delete(job.id);
      resolve({ code, stderr: stderr.trim() });
    });
  });
}

async function refreshCodexBatchProgress(job: OberonKeyframeJob, shotCount: number): Promise<void> {
  const summaryPath = path.join(job.outputDir, "codex-exec-image-results.json");
  const summary = await readJsonFile<{
    complete?: number;
    failed?: number;
    pending?: number;
    results?: Array<{ status?: string }>;
  }>(summaryPath).catch(() => null);
  if (!summary) return;
  const completed =
    typeof summary.complete === "number"
      ? summary.complete
      : (summary.results ?? []).filter((item) => item.status === "complete").length;
  const failed =
    typeof summary.failed === "number"
      ? summary.failed
      : (summary.results ?? []).filter((item) => item.status === "failed").length;
  const done = Math.max(0, Math.min(shotCount, completed + failed));
  job.progress.completedImages = completed;
  job.progress.percent = Math.max(job.progress.percent, done > 0 ? percent(done, shotCount) : 1);
  job.message =
    currentUiLocale() === "ko"
      ? `Codex image_gen 키프레임 생성 중 (${completed}/${shotCount})`
      : `Generating Codex image_gen keyframes (${completed}/${shotCount})`;
  job.updatedAtMs = Date.now();
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
  // 시트(마스터/콘티)는 빌더가 만든 완성 프롬프트 — 키프레임 보일러플레이트를 덧대지 않는다.
  if (shot.assetKind === "master_sheet" || shot.assetKind === "storyboard_sheet") {
    return shot.prompt.slice(0, 3900);
  }
  const role = shot.frameRole === "last" ? "last-frame (END of the action, ready for the next cut)" : "first-frame";
  const parts = [
    shot.prompt,
    `Create one production-ready ${role} keyframe for "${request.title}".`,
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
  const computedPercent = percent(job.progress.completedImages, job.progress.totalImages);
  job.progress.percent = status === "running" && computedPercent === 0 ? Math.max(job.progress.percent, 1) : computedPercent;
  job.updatedAtMs = Date.now();
}

function failJob(id: string, error: unknown): void {
  const job = jobs.get(id);
  if (!job) return;
  const ko = currentUiLocale() === "ko";
  if (cancelledJobs.has(id) || error instanceof KeyframeCancelled) {
    job.status = "cancelled";
    job.progress.phase = "cancelled";
    job.message = ko ? "키프레임 생성 취소됨" : "Keyframe generation cancelled";
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
