// Oberon 애니메이션 스튜디오 — image-to-video 엔진.
//   키프레임 이미지 1장 + 모션 프롬프트 → 짧은 영상(mp4). BYOK 키(Environment Keys).
//   provider: runway(로컬 이미지 base64 data-uri 직접) | luma(공개 HTTPS URL만).
//   ⚠️ no-fallback: 키 미설정/입력 부적합이면 조용히 떨어지지 않고 명시적으로 실패 보고한다.
import { app, shell } from "electron";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { readEnvVar, hasEnvVar } from "../secrets/vault";
import { currentUiLocale } from "../main";
import type {
  OberonAnimateFile,
  OberonAnimateJob,
  OberonAnimateKeyStatus,
  OberonAnimateProvider,
  OberonAnimateRequest,
} from "../../shared/types";

const RUNWAY_KEY = "RUNWAYML_API_SECRET";
const LUMA_KEY = "LUMAAI_API_KEY";
const RUNWAY_BASE = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";
const LUMA_BASE = "https://api.lumalabs.ai";
const POLL_MS = 5_000;
const MAX_POLLS = 120; // ~10분

const jobs = new Map<string, OberonAnimateJob>();
const cancelledJobs = new Set<string>();

export async function animateKeyStatus(): Promise<OberonAnimateKeyStatus> {
  const [runway, luma] = await Promise.all([hasEnvVar(RUNWAY_KEY), hasEnvVar(LUMA_KEY)]);
  return { runway, luma };
}

export function startOberonAnimate(request: OberonAnimateRequest): OberonAnimateJob {
  const ko = currentUiLocale() === "ko";
  const id = randomUUID();
  const provider: OberonAnimateProvider = request.provider ?? "runway";
  const model = request.model || (provider === "runway" ? "gen4_turbo" : "ray-2");
  const title = request.title || "Oberon Animation";
  const outputDir = path.join(app.getPath("userData"), "oberon-animate", `${safeSlug(title)}-${id.slice(0, 8)}`);
  const now = Date.now();
  const job: OberonAnimateJob = {
    id,
    productionId: request.productionId,
    title,
    provider,
    model,
    status: "queued",
    outputDir,
    progress: { phase: "queued", percent: 0 },
    files: [],
    message: ko ? "준비 중" : "Preparing",
    warnings: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
  jobs.set(id, job);
  void runAnimateJob(id, request).catch((error: unknown) => failJob(id, error));
  return snapshot(job);
}

export function getOberonAnimateJob(id: string): OberonAnimateJob | null {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function cancelOberonAnimate(id: string): OberonAnimateJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  const ko = currentUiLocale() === "ko";
  cancelledJobs.add(id);
  job.status = "cancelled";
  job.progress.phase = "cancelled";
  job.message = ko ? "취소됨" : "Cancelled";
  job.updatedAtMs = Date.now();
  return snapshot(job);
}

export async function openOberonAnimateOutput(id: string): Promise<{ ok: boolean; message: string }> {
  const job = jobs.get(id);
  if (!job) return { ok: false, message: "Animate job not found." };
  await fs.mkdir(job.outputDir, { recursive: true });
  const result = await shell.openPath(job.outputDir);
  return result ? { ok: false, message: result } : { ok: true, message: job.outputDir };
}

async function runAnimateJob(id: string, request: OberonAnimateRequest): Promise<void> {
  const ko = currentUiLocale() === "ko";
  const job = requireJob(id);
  const prompt = (request.prompt || "").trim();
  if (!prompt) {
    throw new Error(
      ko
        ? "모션 프롬프트가 비어 있습니다. 무엇을 어떻게 움직일지 적어주세요."
        : "The motion prompt is empty. Describe what should move and how.",
    );
  }

  const keyName = job.provider === "runway" ? RUNWAY_KEY : LUMA_KEY;
  const key = await readEnvVar(keyName);
  if (!key) {
    // no-fallback: 키 없으면 명시적으로 막는다(다른 provider로 몰래 떨어지지 않음).
    throw new Error(
      ko
        ? `${keyName} 미설정 — Environment Keys에 ${job.provider.toUpperCase()} API 키를 추가하세요.`
        : `${keyName} is not set — add a ${job.provider.toUpperCase()} API key in Environment Keys.`,
    );
  }

  await fs.mkdir(job.outputDir, { recursive: true });
  updateJob(job, {
    status: "running",
    phase: "submitting",
    message: ko ? `${job.provider} 제출 중` : `Submitting to ${job.provider}`,
    percent: 5,
  });
  assertNotCancelled(id);

  const videoUrl =
    job.provider === "runway"
      ? await runRunway(job, request, key, prompt)
      : await runLuma(job, request, key, prompt);

  assertNotCancelled(id);
  updateJob(job, { phase: "downloading", message: ko ? "결과 영상 다운로드 중" : "Downloading the result video", percent: 92 });
  const file = await downloadVideo(job, videoUrl);
  job.files.push(file);
  updateJob(job, { status: "succeeded", phase: "complete", message: ko ? "애니메이션 완료" : "Animation complete", percent: 100 });
}

// ── Runway (gen4_turbo, image_to_video) ──────────────────────
async function runRunway(job: OberonAnimateJob, request: OberonAnimateRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const promptImage = await resolveRunwayImage(request);
  const headers = {
    Authorization: `Bearer ${key}`,
    "X-Runway-Version": RUNWAY_VERSION,
    "Content-Type": "application/json",
  };
  const body = {
    model: job.model,
    promptImage,
    promptText: prompt,
    ratio: runwayRatio(request.aspectRatio),
    duration: clampDuration(request.durationSec),
  };
  const res = await fetch(`${RUNWAY_BASE}/v1/image_to_video`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(
      ko
        ? `Runway 제출 실패 (HTTP ${res.status}): ${truncate(await res.text())}`
        : `Runway submission failed (HTTP ${res.status}): ${truncate(await res.text())}`,
    );
  }
  const json = (await res.json()) as { id?: string };
  const taskId = json.id;
  if (!taskId) throw new Error(ko ? "Runway 응답에 task id가 없습니다." : "The Runway response did not include a task id.");

  updateJob(job, { phase: "generating", message: ko ? "Runway 생성 중" : "Runway generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetch(`${RUNWAY_BASE}/v1/tasks/${taskId}`, { headers });
    if (!poll.ok) {
      if (poll.status === 429) continue; // throttled
      throw new Error(ko ? `Runway 폴링 실패 (HTTP ${poll.status})` : `Runway polling failed (HTTP ${poll.status})`);
    }
    const data = (await poll.json()) as { status?: string; output?: string[]; failure?: string; failureCode?: string };
    const status = String(data.status || "").toUpperCase();
    if (status === "SUCCEEDED") {
      const url = data.output?.[0];
      if (!url) throw new Error(ko ? "Runway 완료됐으나 결과 URL이 없습니다." : "Runway completed but returned no result URL.");
      return url;
    }
    if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
      throw new Error(
        ko ? `Runway 생성 실패: ${data.failure || data.failureCode || status}` : `Runway generation failed: ${data.failure || data.failureCode || status}`,
      );
    }
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  throw new Error(ko ? "Runway 생성 시간 초과(약 10분)." : "Runway generation timed out (~10 minutes).");
}

async function resolveRunwayImage(request: OberonAnimateRequest): Promise<string> {
  const ko = currentUiLocale() === "ko";
  if (request.imageUrl && /^https:\/\//i.test(request.imageUrl)) return request.imageUrl;
  if (request.imagePath) {
    const buf = await fs.readFile(request.imagePath);
    return `data:${mimeForPath(request.imagePath)};base64,${buf.toString("base64")}`;
  }
  throw new Error(
    ko ? "입력 이미지가 없습니다. 컷 이미지(키프레임)를 먼저 생성하세요." : "No input image. Generate a shot image (keyframe) first.",
  );
}

function runwayRatio(aspect: OberonAnimateRequest["aspectRatio"]): string {
  if (aspect === "9:16") return "720:1280";
  if (aspect === "1:1") return "960:960";
  return "1280:720";
}

// ── Luma (ray-2, image-to-video; 공개 URL만) ─────────────────
async function runLuma(job: OberonAnimateJob, request: OberonAnimateRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  if (!request.imageUrl || !/^https:\/\//i.test(request.imageUrl)) {
    throw new Error(
      ko
        ? "Luma는 공개 HTTPS 이미지 URL만 지원합니다. 로컬 이미지를 쓰려면 provider를 runway로 선택하세요."
        : "Luma only supports public HTTPS image URLs. Choose provider runway to use a local image.",
    );
  }
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const body = {
    prompt,
    model: job.model,
    keyframes: { frame0: { type: "image", url: request.imageUrl } },
    resolution: "720p",
    duration: clampDuration(request.durationSec) >= 9 ? "9s" : "5s",
    aspect_ratio: request.aspectRatio ?? "16:9",
  };
  const res = await fetch(`${LUMA_BASE}/dream-machine/v1/generations`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(
      ko
        ? `Luma 제출 실패 (HTTP ${res.status}): ${truncate(await res.text())}`
        : `Luma submission failed (HTTP ${res.status}): ${truncate(await res.text())}`,
    );
  }
  const json = (await res.json()) as { id?: string };
  const genId = json.id;
  if (!genId) throw new Error(ko ? "Luma 응답에 generation id가 없습니다." : "The Luma response did not include a generation id.");

  updateJob(job, { phase: "generating", message: ko ? "Luma 생성 중" : "Luma generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetch(`${LUMA_BASE}/dream-machine/v1/generations/${genId}`, { headers });
    if (!poll.ok) throw new Error(ko ? `Luma 폴링 실패 (HTTP ${poll.status})` : `Luma polling failed (HTTP ${poll.status})`);
    const data = (await poll.json()) as { state?: string; assets?: { video?: string }; failure_reason?: string };
    const state = String(data.state || "").toLowerCase();
    if (state === "completed") {
      const url = data.assets?.video;
      if (!url) throw new Error(ko ? "Luma 완료됐으나 결과 영상이 없습니다." : "Luma completed but returned no result video.");
      return url;
    }
    if (state === "failed") {
      throw new Error(ko ? `Luma 생성 실패: ${data.failure_reason || "unknown"}` : `Luma generation failed: ${data.failure_reason || "unknown"}`);
    }
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  throw new Error(ko ? "Luma 생성 시간 초과(약 10분)." : "Luma generation timed out (~10 minutes).");
}

// ── 공통 ─────────────────────────────────────────────────────
async function downloadVideo(job: OberonAnimateJob, url: string): Promise<OberonAnimateFile> {
  const ko = currentUiLocale() === "ko";
  const res = await fetch(url);
  if (!res.ok) throw new Error(ko ? `결과 영상 다운로드 실패 (HTTP ${res.status})` : `Failed to download the result video (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = `${safeSlug(job.title)}-${job.id.slice(0, 8)}.mp4`;
  const absPath = path.join(job.outputDir, name);
  await fs.writeFile(absPath, buf);
  return {
    id: randomUUID(),
    kind: "animation_mp4",
    name,
    absPath,
    url: pathToFileURL(absPath).href,
    mime: "video/mp4",
    sizeBytes: buf.byteLength,
  };
}

function clampDuration(sec: number | undefined): number {
  return (sec ?? 5) >= 10 ? 10 : 5;
}

function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function truncate(s: string): string {
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSlug(value: string): string {
  return (value || "oberon").toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "oberon";
}

function snapshot(job: OberonAnimateJob): OberonAnimateJob {
  return JSON.parse(JSON.stringify(job)) as OberonAnimateJob;
}

function requireJob(id: string): OberonAnimateJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Animate job ${id} not found`);
  return job;
}

function updateJob(
  job: OberonAnimateJob,
  patch: { status?: OberonAnimateJob["status"]; phase?: OberonAnimateJob["progress"]["phase"]; message?: string; percent?: number },
): void {
  if (patch.status) job.status = patch.status;
  if (patch.phase) job.progress.phase = patch.phase;
  if (typeof patch.percent === "number") job.progress.percent = patch.percent;
  if (patch.message) job.message = patch.message;
  job.updatedAtMs = Date.now();
}

function failJob(id: string, error: unknown): void {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === "cancelled") return;
  const ko = currentUiLocale() === "ko";
  job.status = "failed";
  job.progress.phase = "failed";
  job.error = error instanceof Error ? error.message : String(error);
  job.message = ko ? "실패" : "Failed";
  job.updatedAtMs = Date.now();
}

function assertNotCancelled(id: string): void {
  if (cancelledJobs.has(id)) throw new AnimateCancelled();
}

class AnimateCancelled extends Error {
  constructor() {
    super("Animate cancelled");
  }
}
