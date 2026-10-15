// 멀티모달 — image-to-video 엔진 (Oberon 스튜디오에서 적출, 2026-08-21).
//   키프레임 이미지 1장 + 모션 프롬프트 → 짧은 영상(mp4). BYOK 키(Environment Keys).
//   provider: runway(로컬 base64) | luma(공개 HTTPS URL만) | veo(@google/genai)
//            | seedance(ByteDance, fal.ai 경유) | kling(Kuaishou, PiAPI 경유).
//   provider는 UI에서 "연결/키 있는 멀티모달"로 확정해 넘어온다(무조건 Veo 아님).
//   ⚠️ no-fallback: 키 미설정/입력 부적합이면 조용히 떨어지지 않고 명시적으로 실패 보고한다.
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { GoogleGenAI, type GenerateVideosOperation } from "@google/genai";
import { readEnvVarAliased as readEnvVar, hasEnvVarAliased as hasEnvVar } from "../secrets/env-alias";
import { currentUiLocale } from "../ui-locale";
import type {
  MultimodalVideoFile,
  MultimodalVideoJob,
  MultimodalVideoKeyStatus,
  MultimodalVideoProvider,
  MultimodalVideoRequest,
} from "../../shared/types";
import { grokAuthSource } from "./availability";
import { resolveGrokBin, runGrokImagine } from "./grok-imagine";
import { userDataPath } from "../runtime-paths";
import { MediaVerificationError, verifyVideoOutput } from "./output-verification";
import {
  currentVideoAdapterCapabilities,
  markMediaSubmitting,
  mediaInputDigest,
  reconcileMediaOperation,
  recordMediaFailed,
  recordMediaOutcomeUnknown,
  recordMediaProviderAccepted,
  recordMediaProviderProgress,
  recordMediaSucceeded,
  recordMediaVerifying,
  recoverableMediaOperations,
  registerMediaOperation,
  requestMediaCancellation,
  settleMediaCancellation,
} from "./media-operation-registry";
import { getMediaOperation } from "../store/media-operations";
import type { MediaCancellationState, MediaOperationLifecycle, MediaOperationRecord } from "../../shared/media-operation";

// provider별 허용 env 키 — 멀티모달 레지스트리(shared/multimodal.ts) 키명을 먼저,
// 레거시/실동작 키명을 폴백으로. "멀티모달로 연결한 키"를 animate가 그대로 인식하도록 정렬.
//   runway  : 레지스트리 RUNWAY_API_KEY / 레거시 RUNWAYML_API_SECRET
//   luma    : 레지스트리 LUMA_API_KEY / 레거시 LUMAAI_API_KEY
//   veo     : GEMINI_API_KEY / GOOGLE_API_KEY (render.ts와 동일 — 실제 동작 키)
//   seedance: FAL_KEY (fal.ai 경유)
//   kling   : PIAPI_KEY (PiAPI 경유)
const PROVIDER_KEYS: Record<MultimodalVideoProvider, string[]> = {
  runway: ["RUNWAY_API_KEY", "RUNWAYML_API_SECRET"],
  luma: ["LUMA_API_KEY", "LUMAAI_API_KEY"],
  veo: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  seedance: ["FAL_KEY"],
  kling: ["PIAPI_KEY"],
  // grok: API 키가 아니라 구독 로그인된 Grok CLI(bin)로 동작 — 키 목록은 비워둔다.
  grok: [],
};
const DEFAULT_MODELS: Record<MultimodalVideoProvider, string> = {
  runway: "gen4_turbo",
  luma: "ray-2",
  veo: "veo-3.1-lite-generate-001",
  seedance: "fal-ai/bytedance/seedance/v1/pro/image-to-video",
  kling: "kling",
  grok: "runtime-default",
};

// Text-to-video models (official API docs, checked 2026-10-14). Image-to-video keeps DEFAULT_MODELS.
//   runway  : POST /v1/text_to_video, gen4.5 (ratio 1280:720|720:1280, duration 2-10)  https://docs.dev.runwayml.com/api/
//   luma    : POST /dream-machine/v1/generations with prompt only                      https://docs.lumalabs.ai/docs/video-generation
//   veo     : generateVideos({prompt}) without image                                   https://ai.google.dev/gemini-api/docs/veo
//   seedance: fal-ai/bytedance/seedance/v1/pro/text-to-video                           https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video/api
//   kling   : PiAPI task with input.image_url left empty                               https://piapi.ai/docs/kling-api/create-task
//   grok    : POST https://api.x.ai/v1/videos/generations {model, prompt, duration 1-15, aspect_ratio, resolution},
//             poll GET /v1/videos/{request_id} (pending|done|failed|expired)  https://docs.x.ai/developers/model-capabilities/video/generation
//             An API-key route (XAI_API_KEY, metered): image-to-video keeps the subscription CLI.
const TEXT_MODELS: Partial<Record<MultimodalVideoProvider, string>> = {
  runway: "gen4.5",
  luma: "ray-2",
  veo: "veo-3.1-lite-generate-001",
  seedance: "fal-ai/bytedance/seedance/v1/pro/text-to-video",
  kling: "kling",
  grok: "grok-imagine-video-1.5",
};
const XAI_BASE = "https://api.x.ai/v1";
/** Grok text-to-video is the xAI API (metered), never the subscription CLI. */
const XAI_KEYS = ["XAI_API_KEY", "GROK_API_KEY"];
/** Providers with a documented public text-only video API. */
export const TEXT_TO_VIDEO_PROVIDERS = Object.keys(TEXT_MODELS) as MultimodalVideoProvider[];

/** A request with no input image. Carried inside the durable intent so restart recovery keeps the mode. */
export type MultimodalTextVideoRequest = MultimodalVideoRequest & { textOnly?: true };
function isTextOnly(request: MultimodalVideoRequest): boolean {
  return (request as MultimodalTextVideoRequest).textOnly === true;
}

const RUNWAY_BASE = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";
const LUMA_BASE = "https://api.lumalabs.ai";
const FAL_QUEUE_BASE = "https://queue.fal.run";
const PIAPI_BASE = "https://api.piapi.ai";
const POLL_MS = 5_000;
const MAX_POLLS = 120; // ~10분

const jobs = new Map<string, MultimodalVideoJob>();
const cancelledJobs = new Set<string>();
/**
 * Jobs whose provider finished after the owner stopped local waiting: the stop is honoured (no new submit, nothing more
 * started) but the finished output is kept permanently — the owner's originals are never discarded (notyet NH33).
 */
const retainAfterLocalStop = new Set<string>();
const verificationControllers = new Map<string, AbortController>();
let hydrationStarted = false;
const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recoveryRuns = new Map<string, Promise<void>>();
const videoIngestRuns = new Map<string, Promise<MultimodalVideoFile>>();

interface DurableVideoIntent {
  kind: "video";
  job: MultimodalVideoJob;
  request: MultimodalVideoRequest;
}

type VideoJobWithOperation = MultimodalVideoJob & {
  operation?: {
    lifecycle: MediaOperationLifecycle;
    cancellation: MediaCancellationState;
    version: number;
  };
};

function attachOperation(job: MultimodalVideoJob, operation: MediaOperationRecord): MultimodalVideoJob {
  (job as VideoJobWithOperation).operation = {
    lifecycle: operation.lifecycle,
    cancellation: operation.cancellation,
    version: operation.version,
  };
  return job;
}

async function hasAnyEnvVar(keys: string[]): Promise<boolean> {
  const checks = await Promise.all(keys.map((key) => hasEnvVar(key)));
  return checks.some(Boolean);
}

export async function videoKeyStatus(): Promise<MultimodalVideoKeyStatus> {
  const [runway, luma, veo, seedance, kling, grokAuth, grokApi] = await Promise.all([
    hasAnyEnvVar(PROVIDER_KEYS.runway),
    hasAnyEnvVar(PROVIDER_KEYS.luma),
    hasAnyEnvVar(PROVIDER_KEYS.veo),
    hasAnyEnvVar(PROVIDER_KEYS.seedance),
    hasAnyEnvVar(PROVIDER_KEYS.kling),
    grokAuthSource(),
    hasAnyEnvVar(XAI_KEYS),
  ]);
  return { runway, luma, veo, seedance, kling, grok: Boolean(resolveGrokBin()) && grokAuth === "oauth", grokApi };
}

function validateVideoRequest(request: MultimodalVideoRequest, provider: MultimodalVideoProvider, model: string): void {
  const prompt = request.prompt?.trim() ?? "";
  if (!prompt || prompt.length > 12_000) throw new Error("media_video_prompt_invalid");
  if (!model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) throw new Error("media_video_model_invalid");
  if (request.aspectRatio !== undefined && !["16:9", "9:16", "1:1"].includes(request.aspectRatio)) {
    throw new Error("media_video_aspect_ratio_invalid");
  }
  if (request.durationSec !== undefined
    && (!Number.isFinite(request.durationSec) || request.durationSec <= 0 || request.durationSec > 60)) {
    throw new Error("media_video_duration_invalid");
  }
  const requirements = request.outputRequirements;
  for (const value of [requirements?.minWidth, requirements?.minHeight]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 16_384)) {
      throw new Error("media_video_output_requirements_invalid");
    }
  }
  if (requirements?.requireAudio !== undefined && typeof requirements.requireAudio !== "boolean") {
    throw new Error("media_video_output_requirements_invalid");
  }
  if (request.extendFromJobId !== undefined) {
    // Extension continues a generation the provider still holds: Luma keyframes frame0 = {type: "generation", id} (NH34).
    if (provider !== "luma") throw new Error("media_video_extend_unsupported_provider");
    if (request.imagePath || request.imageUrl || isTextOnly(request)) throw new Error("media_video_extend_input_conflict");
    extendSourceGenerationId(request.extendFromJobId, provider);
    return;
  }
  if (isTextOnly(request)) {
    if (!TEXT_MODELS[provider]) throw new Error("media_video_text_unsupported_provider");
    if (request.imagePath || request.imageUrl) throw new Error("media_video_text_image_not_allowed");
    // Runway gen4.5 and Veo text-to-video accept only landscape/portrait.
    if ((provider === "runway" || provider === "veo") && request.aspectRatio === "1:1") throw new Error("media_video_aspect_ratio_unsupported");
    return;
  }
  if (provider === "luma" && (!request.imageUrl || !/^https:\/\//iu.test(request.imageUrl))) {
    throw new Error("media_video_luma_https_image_required");
  }
  if (provider !== "luma" && !request.imagePath && !request.imageUrl) throw new Error("media_video_input_image_required");
  if (request.imageUrl && !/^https:\/\//iu.test(request.imageUrl)) throw new Error("media_video_image_url_invalid");
}

/** The provider generation id of a finished job of the same provider (the extension source), or a typed refusal. */
function extendSourceGenerationId(jobId: string, provider: MultimodalVideoProvider): string {
  const source = typeof jobId === "string" && jobId ? getMediaOperation(jobId) : null;
  if (!source || source.modality !== "video" || source.providerId !== provider) throw new Error("media_video_extend_source_unknown");
  if (source.lifecycle !== "succeeded" || !source.providerOperationId) throw new Error("media_video_extend_source_not_finished");
  return source.providerOperationId;
}

function durableVideoIntent(value: unknown): DurableVideoIntent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DurableVideoIntent>;
  if (candidate.kind !== "video" || !candidate.job || !candidate.request) return null;
  const provider = candidate.job.provider;
  if (!Object.hasOwn(PROVIDER_KEYS, provider) || candidate.job.id.length < 1 || !candidate.job.outputDir) return null;
  return candidate as DurableVideoIntent;
}

function outputDirInAppScope(outputDir: string): boolean {
  const root = path.resolve(userDataPath("multimodal-video"));
  const candidate = path.resolve(outputDir);
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function jobFromOperation(operation: MediaOperationRecord): MultimodalVideoJob {
  const intent = durableVideoIntent(operation.intent);
  if (!intent || intent.job.id !== operation.id || intent.job.provider !== operation.providerId
    || intent.job.model !== operation.modelId || !outputDirInAppScope(intent.job.outputDir)) {
    throw new Error("media_video_operation_corrupt");
  }
  const job = snapshot(intent.job);
  job.updatedAtMs = Date.parse(operation.updatedAt) || job.updatedAtMs;
  if (operation.result) {
    const relative = path.relative(job.outputDir, operation.result.path);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("media_video_result_scope_mismatch");
    }
    const verification = operation.result.receipt as MultimodalVideoFile["verification"];
    job.files = [{
      id: `verified:${operation.result.sha256.slice(0, 24)}`,
      kind: "animation_mp4",
      name: path.basename(operation.result.path),
      absPath: operation.result.path,
      url: pathToFileURL(operation.result.path).href,
      mime: "video/mp4",
      sizeBytes: verification?.sizeBytes ?? 0,
      verification,
    }];
  }
  if (operation.lifecycle === "succeeded") {
    job.status = "succeeded";
    job.progress = { phase: "complete", percent: 100 };
    const kept = operation.cancellation === "unconfirmed";
    job.message = kept ? keptMessage() : (currentUiLocale() === "ko" ? "애니메이션 완료" : "Animation complete");
    if (kept && !job.warnings.includes("kept_after_local_stop")) job.warnings.push("kept_after_local_stop");
  } else if (operation.cancellation === "requested" || operation.cancellation === "unconfirmed" || operation.cancellation === "confirmed") {
    job.status = "cancelled";
    job.progress = { phase: "cancelled", percent: job.progress.percent };
    job.message = operation.cancellation === "confirmed"
      ? (currentUiLocale() === "ko" ? "취소 확인됨" : "Cancellation confirmed")
      : (currentUiLocale() === "ko" ? "로컬 대기는 중단됐지만 외부 작업 취소는 확인되지 않았습니다" : "Local waiting stopped; provider cancellation is unconfirmed");
    if (operation.cancellation !== "confirmed" && !job.warnings.includes("provider_cancel_unconfirmed")) job.warnings.push("provider_cancel_unconfirmed");
  } else if (operation.lifecycle === "failed" || operation.lifecycle === "outcome_unknown") {
    job.status = "failed";
    job.progress = { phase: "failed", percent: job.progress.percent };
    job.error = operation.failureMessage ?? undefined;
    job.message = operation.lifecycle === "outcome_unknown"
      ? (currentUiLocale() === "ko" ? "제출 접수 여부를 확인할 수 없어 다시 제출하지 않았습니다" : "Provider acceptance is unknown; the job was not resubmitted")
      : (currentUiLocale() === "ko" ? "실패" : "Failed");
  } else {
    job.status = operation.lifecycle === "submit_intent" ? "queued" : "running";
    job.progress.phase = operation.lifecycle === "verifying" ? "verifying"
      : operation.lifecycle === "submitting" ? "submitting" : "generating";
  }
  return attachOperation(job, operation);
}

function ensureVideoJobsHydrated(): void {
  if (hydrationStarted) return;
  const operations = recoverableMediaOperations().filter((entry) => entry.modality === "video");
  hydrationStarted = true;
  for (const operation of operations) {
    const job = jobFromOperation(operation);
    jobs.set(job.id, job);
    void recoverVideoOperation(operation).catch((error: unknown) => failJob(operation.id, error));
  }
}

export function initializeVideoJobs(): void {
  ensureVideoJobsHydrated();
}

export function startVideoJob(request: MultimodalTextVideoRequest): MultimodalVideoJob {
  ensureVideoJobsHydrated();
  const ko = currentUiLocale() === "ko";
  const id = randomUUID();
  const provider: MultimodalVideoProvider = request.provider ?? "runway";
  if (!Object.hasOwn(PROVIDER_KEYS, provider)) throw new Error("media_video_provider_invalid");
  const model = request.model || (isTextOnly(request) ? TEXT_MODELS[provider] : undefined) || DEFAULT_MODELS[provider];
  validateVideoRequest(request, provider, model);
  const title = request.title || "Video";
  const outputDir = userDataPath("multimodal-video", `${safeSlug(title)}-${id.slice(0, 8)}`);
  const now = Date.now();
  const job: MultimodalVideoJob = {
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
  const operation = registerMediaOperation({
    id,
    modality: "video",
    providerId: provider,
    modelId: model,
    clientRequestKey: `video:${id}`,
    inputDigest: mediaInputDigest({ provider, model, request }),
    intent: { kind: "video", job, request } satisfies DurableVideoIntent,
    spendLimitUsd: null,
    capabilities: currentVideoAdapterCapabilities(provider === "grok" && isTextOnly(request) ? "grok-api" : provider),
  });
  attachOperation(job, operation);
  jobs.set(id, job);
  void runAnimateJob(id, request).catch((error: unknown) => failJob(id, error));
  return snapshot(job);
}

export function getVideoJob(id: string): MultimodalVideoJob | null {
  ensureVideoJobsHydrated();
  let job = jobs.get(id);
  if (!job) {
    const operation = getMediaOperation(id);
    if (operation?.modality === "video") {
      job = jobFromOperation(operation);
      jobs.set(id, job);
    }
  }
  if (job) {
    const operation = getMediaOperation(id);
    if (operation) {
      if (operation.lifecycle === "succeeded" || operation.lifecycle === "failed" || operation.cancellation !== "none") {
        job = jobFromOperation(operation);
        jobs.set(id, job);
      } else attachOperation(job, operation);
    }
  }
  return job ? snapshot(job) : null;
}

export function cancelVideoJob(id: string): MultimodalVideoJob | null {
  ensureVideoJobsHydrated();
  const job = jobs.get(id) ?? (() => {
    const operation = getMediaOperation(id);
    if (!operation || operation.modality !== "video") return null;
    const restored = jobFromOperation(operation);
    jobs.set(id, restored);
    return restored;
  })();
  if (!job) return null;
  const operation = requestMediaCancellation(id);
  const ko = currentUiLocale() === "ko";
  if (operation.lifecycle === "succeeded" || operation.lifecycle === "failed") {
    const settledJob = jobFromOperation(operation);
    // Cancelled before anything was submitted: the registry closes it at once. The still-running starter must stop
    // at its next checkpoint and must not rewrite the job as failed (markMediaSubmitting would throw on a closed row).
    if (operation.lifecycle === "failed" && operation.cancellation !== "none") {
      cancelledJobs.add(id);
      jobs.set(id, settledJob);
    }
    return snapshot(settledJob);
  }
  cancelledJobs.add(id);
  verificationControllers.get(id)?.abort();
  const settled = operation.cancellation === "confirmed" ? operation : settleMediaCancellation(id, "unconfirmed");
  const restored = jobFromOperation(settled);
  jobs.set(id, restored);
  job.status = restored.status;
  job.progress = restored.progress;
  job.message = restored.message || (ko ? "취소 요청됨" : "Cancellation requested");
  job.warnings = restored.warnings;
  job.updatedAtMs = Date.now();
  if (settled.cancellation === "unconfirmed" && settled.providerOperationId) scheduleVideoRecovery(id);
  return snapshot(job);
}

export async function openVideoOutput(id: string): Promise<{ ok: boolean; message: string }> {
  const job = getVideoJob(id);
  if (!job) return { ok: false, message: "Animate job not found." };
  await fs.mkdir(job.outputDir, { recursive: true });
  // Require on use: the daemon (and the harness media ports there) loads this module without electron.
  const { shell } = require("electron") as typeof import("electron");
  const result = await shell.openPath(job.outputDir);
  return result ? { ok: false, message: result } : { ok: true, message: job.outputDir };
}

async function runAnimateJob(id: string, request: MultimodalVideoRequest): Promise<void> {
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

  if (job.provider === "grok" && !isTextOnly(request)) {
    await runGrokAnimate(id, job, request, prompt);
    return;
  }

  // provider별 허용 키 목록에서 실제 존재하는 첫 키를 쓴다(멀티모달 연결 키 인식).
  const keyList = job.provider === "grok" ? XAI_KEYS : PROVIDER_KEYS[job.provider];
  const key = await readFirstSecret(keyList);
  if (!key) {
    // no-fallback: 키 없으면 명시적으로 막는다(다른 provider로 몰래 떨어지지 않음).
    throw new Error(
      ko
        ? `${keyList.join(" / ")} 미설정 — Environment Keys에 ${job.provider.toUpperCase()} 키를 추가하세요.`
        : `${keyList.join(" / ")} is not set — add a ${job.provider.toUpperCase()} key in Environment Keys.`,
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

  // Veo(i2v)는 SDK가 영상 바이트를 직접 반환하므로 URL 다운로드 경로를 타지 않는다.
  if (job.provider === "veo") {
    await runVeo(id, job, request, prompt, key);
    return;
  }

  const videoUrl =
    job.provider === "runway"
      ? await runRunway(job, request, key, prompt)
      : job.provider === "luma"
        ? await runLuma(job, request, key, prompt)
        : job.provider === "seedance"
          ? await runSeedance(job, request, key, prompt)
          : job.provider === "grok"
            ? await runGrokTextVideo(job, request, key, prompt)
            : await runKling(job, request, key, prompt);

  assertNotCancelled(id);
  updateJob(job, { phase: "downloading", message: ko ? "결과 영상 다운로드 중" : "Downloading the result video", percent: 92 });
  const file = await downloadVideo(job, videoUrl, request);
  assertNotCancelled(id);
  job.files.push(file);
  updateJob(job, { status: "succeeded", phase: "complete", message: ko ? "애니메이션 완료" : "Animation complete", percent: 100 });
}

async function runGrokAnimate(
  id: string,
  job: MultimodalVideoJob,
  request: MultimodalVideoRequest,
  prompt: string,
): Promise<void> {
  const ko = currentUiLocale() === "ko";
  await fs.mkdir(job.outputDir, { recursive: true });
  const inputFrame = await materializeGrokAnimateInput(job, request);
  const name = `${safeSlug(job.title)}-${job.id.slice(0, 8)}.mp4`;
  const absPath = path.join(job.outputDir, name);
  markMediaSubmitting(id);
  updateJob(job, {
    status: "running",
    phase: "generating",
    message: ko ? "Grok Imagine 영상 생성 중" : "Grok Imagine generating video",
    percent: 20,
  });
  const generated = await runGrokImagine({
    prompt: [
      prompt,
      `Generate a ${request.durationSec ?? 5}-second ${request.aspectRatio ?? "16:9"} cinematic image-to-video clip.`,
      `Use the local image file "${inputFrame}" as the exact first frame and animate naturally from it.`,
      "Preserve subject identity, composition, lighting, and art direction. End on a clean stable frame. No text or watermark.",
    ].join("\n"),
    cwd: job.outputDir,
    kind: "video",
    targetPath: absPath,
    isCancelled: () => cancelledJobs.has(id),
  });
  assertNotCancelled(id);
  if (!generated) throw new Error(ko ? "Grok Imagine이 사용 가능한 영상을 반환하지 않았습니다." : "Grok Imagine returned no usable video.");
  const file = await verifiedVideoFile(job, generated, request);
  assertNotCancelled(id);
  job.files.push(file);
  updateJob(job, { status: "succeeded", phase: "complete", message: ko ? "Grok 애니메이션 완료" : "Grok animation complete", percent: 100 });
}

async function materializeGrokAnimateInput(job: MultimodalVideoJob, request: MultimodalVideoRequest): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const inputDir = path.join(job.outputDir, "inputs");
  await fs.mkdir(inputDir, { recursive: true });
  if (request.imagePath) {
    const ext = path.extname(request.imagePath) || ".png";
    const target = path.join(inputDir, `first-frame${ext}`);
    await fs.copyFile(request.imagePath, target);
    return path.relative(job.outputDir, target);
  }
  if (request.imageUrl && /^https:\/\//i.test(request.imageUrl)) {
    const response = await fetch(request.imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch input image (HTTP ${response.status})`);
    const mime = response.headers.get("content-type") || "image/png";
    const ext = mime.includes("jpeg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";
    const target = path.join(inputDir, `first-frame${ext}`);
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
    return path.relative(job.outputDir, target);
  }
  throw new Error(ko ? "입력 이미지가 없습니다. Grok 컷 이미지를 먼저 생성하세요." : "No input image. Generate a Grok cut image first.");
}

// ── Veo (google-veo, image-to-video) ─────────────────────────
//   render.ts의 Veo i2v와 동일 엔진(@google/genai). 키프레임 1장 → 짧은 클립.
async function runVeo(
  id: string,
  job: MultimodalVideoJob,
  request: MultimodalVideoRequest,
  prompt: string,
  apiKey: string,
): Promise<void> {
  const ko = currentUiLocale() === "ko";
  const textOnly = isTextOnly(request);
  const image = textOnly ? undefined : await resolveVeoImage(request);
  assertNotCancelled(id);

  const ai = new GoogleGenAI({ apiKey });
  markMediaSubmitting(id);
  let operation: GenerateVideosOperation;
  try {
    operation = await ai.models.generateVideos({
      model: job.model,
      prompt,
      ...(image ? { image } : {}),
      config: {
        numberOfVideos: 1,
        durationSeconds: textOnly ? veoTextDuration(request.durationSec) : (request.durationSec ?? 5) >= 8 ? 8 : 6,
        aspectRatio: request.aspectRatio === "9:16" ? "9:16" : "16:9",
        resolution: "720p",
        enhancePrompt: true,
        // image-to-video requires allow_adult; the text-only default is left to the API.
        ...(textOnly ? {} : { personGeneration: "allow_adult" }),
      },
    });
  } catch (error) {
    throw submitOutcomeUnknown(job.provider, error);
  }
  if (!operation.name) throw new SubmitOutcomeUnknown("Veo accepted a request without a recoverable operation name.");
  persistProviderAccepted(id, operation.name, { operationName: operation.name });

  updateJob(job, { phase: "generating", message: ko ? "Veo 생성 중" : "Veo generating", percent: 25 });
  for (let i = 0; !operation.done && i < MAX_POLLS; i += 1) {
    assertNotCancelled(id);
    await sleep(POLL_MS);
    try { operation = await ai.operations.getVideosOperation({ operation }); }
    catch (error) { throw new ProviderStatusUnknown(`Veo status lookup was interrupted; no new submit was sent. ${error instanceof Error ? error.message : String(error)}`); }
    recordProviderPoll(job, operation.done ? "SUCCEEDED" : "RUNNING", i);
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  if (!operation.done) throw new ProviderStatusUnknown(ko ? "Veo 상태 확인 시간이 끝났습니다. 다시 제출하지 않았습니다." : "Veo status polling timed out; the job was not resubmitted.");
  if (operation.error) throw new Error(JSON.stringify(operation.error));

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) {
    const reasons = operation.response?.raiMediaFilteredReasons?.join(", ");
    throw new Error(
      reasons
        ? ko ? `Veo가 클립을 필터링했습니다: ${reasons}` : `Veo filtered the clip: ${reasons}`
        : ko ? "Veo가 영상을 반환하지 않았습니다." : "Veo returned no video.",
    );
  }

  assertNotCancelled(id);
  updateJob(job, { phase: "downloading", message: ko ? "결과 영상 저장 중" : "Saving the result video", percent: 92 });
  await finishRecoveredVeo(job, request, ai, operation);
}

// Veo i2v 입력 이미지 → {imageBytes(base64), mimeType}. 로컬 경로 우선, 공개 URL 폴백.
async function resolveVeoImage(request: MultimodalVideoRequest): Promise<{ imageBytes: string; mimeType: string }> {
  const ko = currentUiLocale() === "ko";
  if (request.imagePath) {
    const buf = await fs.readFile(request.imagePath);
    return { imageBytes: buf.toString("base64"), mimeType: mimeForPath(request.imagePath) };
  }
  if (request.imageUrl && /^https:\/\//i.test(request.imageUrl)) {
    const res = await fetch(request.imageUrl);
    if (!res.ok) throw new Error(ko ? `입력 이미지 다운로드 실패 (HTTP ${res.status})` : `Failed to fetch input image (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "image/png";
    return { imageBytes: buf.toString("base64"), mimeType: mime.split(";")[0] };
  }
  throw new Error(
    ko ? "입력 이미지가 없습니다. 컷 이미지(키프레임)를 먼저 생성하세요." : "No input image. Generate a shot image (keyframe) first.",
  );
}

async function readFirstSecret(keys: string[]): Promise<string | null> {
  for (const key of keys) {
    const value = await readEnvVar(key);
    if (value) return value;
  }
  return null;
}

// ── Runway (gen4_turbo, image_to_video) ──────────────────────
async function runRunway(job: MultimodalVideoJob, request: MultimodalVideoRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const textOnly = isTextOnly(request);
  const promptImage = textOnly ? undefined : await resolveRunwayImage(request);
  const headers = {
    Authorization: `Bearer ${key}`,
    "X-Runway-Version": RUNWAY_VERSION,
    "Content-Type": "application/json",
  };
  const body = {
    model: job.model,
    ...(promptImage ? { promptImage } : {}),
    promptText: prompt,
    ratio: runwayRatio(request.aspectRatio),
    duration: textOnly ? Math.min(10, Math.max(2, Math.round(request.durationSec ?? 5))) : clampDuration(request.durationSec),
  };
  markMediaSubmitting(job.id);
  let res: Response;
  try { res = await fetch(`${RUNWAY_BASE}/v1/${textOnly ? "text_to_video" : "image_to_video"}`, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch (error) { throw submitOutcomeUnknown(job.provider, error); }
  if (!res.ok) {
    throw new Error(
      ko
        ? `Runway 제출 실패 (HTTP ${res.status}): ${truncate(await res.text())}`
        : `Runway submission failed (HTTP ${res.status}): ${truncate(await res.text())}`,
    );
  }
  const json = await readAcceptedJson<{ id?: string }>(job.provider, res);
  const taskId = json.id;
  if (!taskId) throw new SubmitOutcomeUnknown(ko ? "Runway 접수 응답에 복구할 task id가 없습니다." : "Runway accepted the request without a recoverable task id.");
  persistProviderAccepted(job.id, taskId);

  updateJob(job, { phase: "generating", message: ko ? "Runway 생성 중" : "Runway generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetchProviderStatus(`${RUNWAY_BASE}/v1/tasks/${taskId}`, { headers });
    if (!poll.ok) {
      if (poll.status === 429) { recordProviderPoll(job, "HTTP_429", i); continue; }
      throw new Error(ko ? `Runway 폴링 실패 (HTTP ${poll.status})` : `Runway polling failed (HTTP ${poll.status})`);
    }
    const data = (await poll.json()) as { status?: string; output?: string[]; failure?: string; failureCode?: string };
    const status = String(data.status || "").toUpperCase();
    recordProviderPoll(job, status || "UNKNOWN", i);
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
  throw new ProviderStatusUnknown(ko ? "Runway 상태 확인 시간이 끝났습니다. 다시 제출하지 않았습니다." : "Runway status polling timed out; the job was not resubmitted.");
}

async function resolveRunwayImage(request: MultimodalVideoRequest): Promise<string> {
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

function runwayRatio(aspect: MultimodalVideoRequest["aspectRatio"]): string {
  if (aspect === "9:16") return "720:1280";
  if (aspect === "1:1") return "960:960";
  return "1280:720";
}

// ── Luma (ray-2, image-to-video; 공개 URL만) ─────────────────
async function runLuma(job: MultimodalVideoJob, request: MultimodalVideoRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const textOnly = isTextOnly(request);
  const extendFrom = request.extendFromJobId ? extendSourceGenerationId(request.extendFromJobId, "luma") : null;
  if (!extendFrom && !textOnly && (!request.imageUrl || !/^https:\/\//i.test(request.imageUrl))) {
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
    ...(extendFrom ? { keyframes: { frame0: { type: "generation", id: extendFrom } } }
      : textOnly ? {} : { keyframes: { frame0: { type: "image", url: request.imageUrl } } }),
    resolution: "720p",
    duration: clampDuration(request.durationSec) >= 9 ? "9s" : "5s",
    aspect_ratio: request.aspectRatio ?? "16:9",
  };
  markMediaSubmitting(job.id);
  let res: Response;
  try { res = await fetch(`${LUMA_BASE}/dream-machine/v1/generations`, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch (error) { throw submitOutcomeUnknown(job.provider, error); }
  if (!res.ok) {
    throw new Error(
      ko
        ? `Luma 제출 실패 (HTTP ${res.status}): ${truncate(await res.text())}`
        : `Luma submission failed (HTTP ${res.status}): ${truncate(await res.text())}`,
    );
  }
  const json = await readAcceptedJson<{ id?: string }>(job.provider, res);
  const genId = json.id;
  if (!genId) throw new SubmitOutcomeUnknown(ko ? "Luma 접수 응답에 복구할 generation id가 없습니다." : "Luma accepted the request without a recoverable generation id.");
  persistProviderAccepted(job.id, genId);

  updateJob(job, { phase: "generating", message: ko ? "Luma 생성 중" : "Luma generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetchProviderStatus(`${LUMA_BASE}/dream-machine/v1/generations/${genId}`, { headers });
    if (!poll.ok) {
      if (poll.status === 429) { recordProviderPoll(job, "HTTP_429", i); continue; }
      throw new Error(ko ? `Luma 폴링 실패 (HTTP ${poll.status})` : `Luma polling failed (HTTP ${poll.status})`);
    }
    const data = (await poll.json()) as { state?: string; assets?: { video?: string }; failure_reason?: string };
    const state = String(data.state || "").toLowerCase();
    recordProviderPoll(job, state || "unknown", i);
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
  throw new ProviderStatusUnknown(ko ? "Luma 상태 확인 시간이 끝났습니다. 다시 제출하지 않았습니다." : "Luma status polling timed out; the job was not resubmitted.");
}

// ── Grok Imagine text-to-video (xAI API) ──
async function runGrokTextVideo(job: MultimodalVideoJob, request: MultimodalVideoRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const body = {
    model: job.model,
    prompt,
    duration: Math.min(15, Math.max(1, Math.round(request.durationSec ?? 8))),
    aspect_ratio: request.aspectRatio ?? "16:9",
    resolution: "720p",
  };
  markMediaSubmitting(job.id);
  let res: Response;
  try { res = await fetch(`${XAI_BASE}/videos/generations`, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch (error) { throw submitOutcomeUnknown(job.provider, error); }
  if (!res.ok) {
    throw new Error(ko ? `Grok 영상 제출 실패 (HTTP ${res.status}): ${truncate(await res.text())}` : `Grok video submission failed (HTTP ${res.status}): ${truncate(await res.text())}`);
  }
  const requestId = (await readAcceptedJson<{ request_id?: string }>(job.provider, res)).request_id;
  if (!requestId) throw new SubmitOutcomeUnknown(ko ? "Grok 접수 응답에 복구할 request_id가 없습니다." : "Grok accepted the request without a recoverable request_id.");
  persistProviderAccepted(job.id, requestId);
  updateJob(job, { phase: "generating", message: ko ? "Grok 생성 중" : "Grok generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetchProviderStatus(`${XAI_BASE}/videos/${encodeURIComponent(requestId)}`, { headers });
    if (!poll.ok) {
      if (poll.status === 429) { recordProviderPoll(job, "HTTP_429", i); continue; }
      throw new Error(ko ? `Grok 폴링 실패 (HTTP ${poll.status})` : `Grok polling failed (HTTP ${poll.status})`);
    }
    const outcome = grokVideoOutcome(await poll.json());
    recordProviderPoll(job, outcome.status || "unknown", i);
    if (outcome.url) return outcome.url;
    if (outcome.failure) throw new Error(ko ? `Grok 생성 실패: ${outcome.failure}` : `Grok generation failed: ${outcome.failure}`);
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  throw new ProviderStatusUnknown(ko ? "Grok 상태 확인 시간이 끝났습니다. 다시 제출하지 않았습니다." : "Grok status polling timed out; the job was not resubmitted.");
}

/** One reading of GET /v1/videos/{id}: done with a URL, a terminal failure, or still pending. */
export function grokVideoOutcome(data: unknown): { status: string; url?: string; failure?: string } {
  const rec = (data && typeof data === "object" ? data : {}) as { status?: unknown; video?: { url?: unknown }; error?: { code?: unknown; message?: unknown } };
  const status = String(rec.status ?? "").toLowerCase();
  const url = typeof rec.video?.url === "string" ? rec.video.url : undefined;
  if (status === "done") return url ? { status, url } : { status, failure: "done without a video URL" };
  if (status === "failed" || status === "expired") {
    return { status, failure: String(rec.error?.message ?? rec.error?.code ?? status).slice(0, 300) };
  }
  return { status };
}

// ── Seedance 2.0 (ByteDance, fal.ai queue 경유; image-to-video) ──
//   fal 큐 API: 제출→status_url/response_url→폴링→결과 video.url. 이미지는 data-uri 인라인.
async function runSeedance(job: MultimodalVideoJob, request: MultimodalVideoRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const imageUrl = isTextOnly(request) ? undefined : await resolveRunwayImage(request); // https URL 또는 로컬 data-uri.
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  const body = {
    prompt,
    ...(imageUrl ? { image_url: imageUrl } : {}),
    aspect_ratio: request.aspectRatio ?? "16:9",
    resolution: "720p",
    duration: clampDuration(request.durationSec) >= 10 ? "10" : "5",
  };
  markMediaSubmitting(job.id);
  let submit: Response;
  try { submit = await fetch(`${FAL_QUEUE_BASE}/${job.model}`, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch (error) { throw submitOutcomeUnknown(job.provider, error); }
  if (!submit.ok) {
    throw new Error(
      ko
        ? `Seedance(fal) 제출 실패 (HTTP ${submit.status}): ${truncate(await submit.text())}`
        : `Seedance (fal) submission failed (HTTP ${submit.status}): ${truncate(await submit.text())}`,
    );
  }
  const queued = await readAcceptedJson<{ request_id?: string; status_url?: string; response_url?: string }>(job.provider, submit);
  const requestId = queued.request_id;
  const statusUrl = queued.status_url;
  const responseUrl = queued.response_url;
  if (!requestId || !statusUrl || !responseUrl) {
    throw new SubmitOutcomeUnknown(ko ? "Seedance 접수 응답에 복구할 작업 ID 또는 상태 URL이 없습니다." : "fal accepted the request without a recoverable request id or status URL.");
  }
  persistProviderAccepted(job.id, requestId, { statusUrl, responseUrl });

  updateJob(job, { phase: "generating", message: ko ? "Seedance 생성 중" : "Seedance generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetchProviderStatus(statusUrl, { headers });
    if (!poll.ok) {
      if (poll.status === 429) { recordProviderPoll(job, "HTTP_429", i); continue; }
      throw new Error(ko ? `Seedance(fal) 폴링 실패 (HTTP ${poll.status})` : `fal polling failed (HTTP ${poll.status})`);
    }
    const data = (await poll.json()) as { status?: string };
    const status = String(data.status || "").toUpperCase();
    recordProviderPoll(job, status || "UNKNOWN", i);
    if (status === "COMPLETED") {
      const out = await fetch(responseUrl, { headers });
      if (!out.ok) throw new Error(ko ? `Seedance(fal) 결과 조회 실패 (HTTP ${out.status})` : `fal result fetch failed (HTTP ${out.status})`);
      const result = (await out.json()) as { video?: { url?: string } };
      const url = result.video?.url;
      if (!url) throw new Error(ko ? "Seedance 완료됐으나 결과 영상이 없습니다." : "Seedance completed but returned no video.");
      return url;
    }
    if (status.includes("FAIL") || status.includes("ERROR")) {
      throw new Error(ko ? `Seedance 생성 실패: ${status}` : `Seedance generation failed: ${status}`);
    }
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  throw new ProviderStatusUnknown(ko ? "Seedance 상태 확인 시간이 끝났습니다. 다시 제출하지 않았습니다." : "Seedance status polling timed out; the job was not resubmitted.");
}

// ── Kling 2.x (Kuaishou, PiAPI 경유; image-to-video) ─────────
//   PiAPI 통합 태스크: POST /api/v1/task → GET /api/v1/task/{id} 폴링 → output 영상 URL.
async function runKling(job: MultimodalVideoJob, request: MultimodalVideoRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const imageUrl = isTextOnly(request) ? undefined : await resolveRunwayImage(request); // https URL 또는 로컬 data-uri.
  const headers = { "x-api-key": key, "Content-Type": "application/json" };
  const body = {
    model: "kling",
    task_type: "video_generation",
    input: {
      prompt,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      duration: clampDuration(request.durationSec) >= 10 ? 10 : 5,
      aspect_ratio: request.aspectRatio ?? "16:9",
      mode: "std",
      version: "2.5",
    },
  };
  markMediaSubmitting(job.id);
  let submit: Response;
  try { submit = await fetch(`${PIAPI_BASE}/api/v1/task`, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch (error) { throw submitOutcomeUnknown(job.provider, error); }
  if (!submit.ok) {
    throw new Error(
      ko
        ? `Kling(PiAPI) 제출 실패 (HTTP ${submit.status}): ${truncate(await submit.text())}`
        : `Kling (PiAPI) submission failed (HTTP ${submit.status}): ${truncate(await submit.text())}`,
    );
  }
  const created = await readAcceptedJson<{ message?: string; data?: { task_id?: string } }>(job.provider, submit);
  const taskId = created.data?.task_id;
  if (!taskId) {
    throw new SubmitOutcomeUnknown(
      ko ? `Kling(PiAPI) 응답에 task id가 없습니다: ${truncate(created.message || "")}` : `PiAPI response did not include a task id: ${truncate(created.message || "")}`,
    );
  }
  persistProviderAccepted(job.id, taskId);

  updateJob(job, { phase: "generating", message: ko ? "Kling 생성 중" : "Kling generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetchProviderStatus(`${PIAPI_BASE}/api/v1/task/${taskId}`, { headers });
    if (!poll.ok) {
      if (poll.status === 429) { recordProviderPoll(job, "HTTP_429", i); continue; }
      throw new Error(ko ? `Kling(PiAPI) 폴링 실패 (HTTP ${poll.status})` : `PiAPI polling failed (HTTP ${poll.status})`);
    }
    const data = (await poll.json()) as {
      data?: {
        status?: string;
        output?: { video_url?: string; works?: { video?: { resource?: string; resource_without_watermark?: string } }[] };
        error?: { message?: string };
      };
    };
    const rec = data.data;
    const status = String(rec?.status || "").toLowerCase();
    recordProviderPoll(job, status || "unknown", i);
    if (status === "completed") {
      const out = rec?.output;
      const url =
        out?.video_url ||
        out?.works?.[0]?.video?.resource_without_watermark ||
        out?.works?.[0]?.video?.resource;
      if (!url) throw new Error(ko ? "Kling 완료됐으나 결과 영상이 없습니다." : "Kling completed but returned no video.");
      return url;
    }
    if (status === "failed") {
      throw new Error(ko ? `Kling 생성 실패: ${rec?.error?.message || "unknown"}` : `Kling generation failed: ${rec?.error?.message || "unknown"}`);
    }
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  throw new ProviderStatusUnknown(ko ? "Kling 상태 확인 시간이 끝났습니다. 다시 제출하지 않았습니다." : "Kling status polling timed out; the job was not resubmitted.");
}

// ── 공통 ─────────────────────────────────────────────────────
function runVideoIngest(id: string, action: () => Promise<MultimodalVideoFile>): Promise<MultimodalVideoFile> {
  const pending = videoIngestRuns.get(id);
  if (pending) return pending;
  const run = Promise.resolve().then(action);
  videoIngestRuns.set(id, run);
  void run.finally(() => { if (videoIngestRuns.get(id) === run) videoIngestRuns.delete(id); }).catch(() => undefined);
  return run;
}

function downloadVideo(job: MultimodalVideoJob, url: string, request: MultimodalVideoRequest): Promise<MultimodalVideoFile> {
  return runVideoIngest(job.id, () => downloadVideoOnce(job, url, request));
}

async function downloadVideoOnce(job: MultimodalVideoJob, url: string, request: MultimodalVideoRequest): Promise<MultimodalVideoFile> {
  const ko = currentUiLocale() === "ko";
  // A crashed writer must not leave a deterministic final filename that blocks retry with EEXIST.
  // Only this attempt's incomplete staging file is disposable; verified digest-named originals are never overwritten.
  const absPath = path.join(job.outputDir, `.video-ingest-${randomUUID()}.part`);
  const previous = getMediaOperation(job.id)?.providerCheckpoint as { originalResultUrl?: unknown; resultUrl?: unknown } | null;
  const originalResultUrl = typeof previous?.originalResultUrl === "string" ? previous.originalResultUrl
    : typeof previous?.resultUrl === "string" ? previous.resultUrl : url;
  checkpointVideoIngest(job.id, { originalResultUrl, resultUrl: url, stagingPath: absPath, ingestState: "downloading", localPath: null });
  const res = await fetch(url);
  if (!res.ok) throw new VideoResultFetchError(res.status, ko ? `결과 영상 다운로드 실패 (HTTP ${res.status})` : `Failed to download the result video (HTTP ${res.status})`);
  const limit = 1024 * 1024 * 1024;
  if (Number(res.headers.get("content-length")) > limit) {
    await res.body?.cancel();
    throw new Error(ko ? "영상 파일이 허용된 크기를 초과했습니다." : "The video exceeds the file size limit.");
  }
  if (!res.body) throw new Error(ko ? "영상 응답이 비어 있습니다." : "The video response has no body.");
  const reader = res.body.getReader();
  const output = await fs.open(absPath, "wx", 0o600);
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      assertNotCancelled(job.id);
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error(ko ? "영상 파일이 허용된 크기를 초과했습니다." : "The video exceeds the file size limit.");
      let written = 0;
      while (written < next.value.byteLength) written += (await output.write(next.value, written, next.value.byteLength - written)).bytesWritten;
    }
    await output.sync();
    complete = true;
  } finally {
    await reader.cancel().catch(() => undefined);
    await output.close();
    // A partial download (disk full, cancel, network) is removed so the next recovery can write the file again ("wx").
    if (!complete) await fs.unlink(absPath).catch(() => undefined);
  }
  checkpointVideoIngest(job.id, { localPath: absPath, ingestState: "downloaded" });
  return verifiedVideoFileOnce(job, absPath, request);
}

function checkpointVideoIngest(id: string, patch: Record<string, unknown>): void {
  const current = getMediaOperation(id);
  const previous = current?.providerCheckpoint;
  recordMediaVerifying(id, { ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}), ...patch });
}

function verifiedVideoFile(job: MultimodalVideoJob, absPath: string, request: MultimodalVideoRequest): Promise<MultimodalVideoFile> {
  return runVideoIngest(job.id, () => verifiedVideoFileOnce(job, absPath, request));
}

async function verifiedVideoFileOnce(job: MultimodalVideoJob, absPath: string, request: MultimodalVideoRequest): Promise<MultimodalVideoFile> {
  assertNotCancelled(job.id);
  const ko = currentUiLocale() === "ko";
  checkpointVideoIngest(job.id, { localPath: absPath, ingestState: "downloaded" });
  updateJob(job, { phase: "verifying", percent: 96, message: ko ? "영상 재생·길이·크기 확인 중" : "Checking video playback, duration and dimensions" });
  const controller = new AbortController();
  verificationControllers.set(job.id, controller);
  let verified: Awaited<ReturnType<typeof verifyVideoOutput>>;
  try {
    verified = await verifyVideoOutput({ sourcePath: absPath, allowedRoot: job.outputDir, signal: controller.signal,
      criteria: { durationSec: request.durationSec, aspectRatio: request.aspectRatio ?? "16:9", ...request.outputRequirements } });
  } catch (error) {
    if (error instanceof MediaVerificationError) {
      job.warnings.push(error.reasonCode);
      throw new MediaVerificationError(error.reasonCode, ko ? `영상 결과를 확인하지 못했습니다. ${error.reasonCode === "media_verifier_unavailable" ? "FFmpeg와 ffprobe 설치가 필요합니다." : error.reasonCode === "media_output_criteria_mismatch" ? "요청한 길이·크기·오디오 조건과 다릅니다." : "파일이 완전한 영상인지 확인해 주세요."}` : error.message);
    }
    throw error;
  } finally { if (verificationControllers.get(job.id) === controller) verificationControllers.delete(job.id); }
  assertNotCancelled(job.id);
  const file: MultimodalVideoFile = {
    id: randomUUID(),
    kind: "animation_mp4",
    name: path.basename(verified.path),
    absPath: verified.path,
    url: pathToFileURL(verified.path).href,
    mime: "video/mp4",
    sizeBytes: verified.verification.sizeBytes,
    verification: verified.verification,
  };
  recordMediaSucceeded(job.id, {
    path: verified.path,
    sha256: verified.verification.sha256,
    receipt: verified.verification,
  });
  return file;
}

function persistProviderAccepted(id: string, providerOperationId: string, providerCheckpoint?: unknown): void {
  try {
    recordMediaProviderAccepted({ id, providerOperationId, providerCheckpoint });
  } catch (error) {
    throw new SubmitOutcomeUnknown(`The provider accepted the request, but its operation identity could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordProviderPoll(job: MultimodalVideoJob, providerStatus: string, attempt: number, providerCheckpoint?: unknown): void {
  const current = getMediaOperation(job.id);
  if (!current) throw new Error("media_operation_not_found");
  if (current.pollAttempts >= MAX_POLLS) throw new ProviderStatusUnknown("Provider polling reached its durable attempt limit; the job was not resubmitted.");
  const previous = current.providerCheckpoint;
  const checkpoint = providerCheckpoint && typeof providerCheckpoint === "object" && !Array.isArray(providerCheckpoint)
    ? { ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}), ...providerCheckpoint }
    : providerCheckpoint;
  recordMediaProviderProgress({ id: job.id, providerStatus, providerCheckpoint: checkpoint });
  updateJob(job, { percent: Math.min(90, 25 + Math.round((attempt / MAX_POLLS) * 65)) });
}

function submitOutcomeUnknown(provider: MultimodalVideoProvider, error: unknown): SubmitOutcomeUnknown {
  return new SubmitOutcomeUnknown(`${provider} submission response was interrupted; acceptance is unknown and the request will not be resubmitted automatically. ${error instanceof Error ? error.message : String(error)}`);
}

async function readAcceptedJson<T>(provider: MultimodalVideoProvider, response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch (error) {
    throw new SubmitOutcomeUnknown(`${provider} returned an unreadable successful submission response; acceptance is unknown and the request will not be resubmitted automatically. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchProviderStatus(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) {
    throw new ProviderStatusUnknown(`Provider status lookup was interrupted; no new submit was sent. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function syncJobFromOperation(operation: MediaOperationRecord): void {
  const next = jobFromOperation(operation);
  jobs.set(next.id, next);
}

function scheduleVideoRecovery(id: string): void {
  if (recoveryTimers.has(id)) return;
  const timer = setTimeout(() => {
    recoveryTimers.delete(id);
    const current = getMediaOperation(id);
    if (current) void recoverVideoOperation(current).catch((error: unknown) => failJob(id, error));
  }, POLL_MS);
  recoveryTimers.set(id, timer);
  timer.unref?.();
}

function recoverVideoOperation(operation: MediaOperationRecord): Promise<void> {
  const pending = recoveryRuns.get(operation.id);
  if (pending) return pending;
  const run = Promise.resolve().then(() => {
    const current = getMediaOperation(operation.id);
    if (current) return recoverVideoOperationOnce(current);
  });
  recoveryRuns.set(operation.id, run);
  void run.finally(() => { if (recoveryRuns.get(operation.id) === run) recoveryRuns.delete(operation.id); }).catch(() => undefined);
  return run;
}

async function recoverVideoOperationOnce(operation: MediaOperationRecord): Promise<void> {
  if (operation.cancellation === "requested") {
    const receipt = await reconcileMediaOperation(operation.id);
    operation = receipt.operation;
    syncJobFromOperation(operation);
    // Settling a local stop does not finish recovery of the already-submitted provider operation.
  }
  if (operation.cancellation === "confirmed" || operation.lifecycle === "succeeded" || operation.lifecycle === "failed") return;
  if (operation.lifecycle === "submit_intent") {
    if (operation.cancellation !== "none") return;
    const intent = durableVideoIntent(operation.intent);
    if (!intent) throw new Error("media_video_operation_corrupt");
    await runAnimateJob(operation.id, intent.request);
    return;
  }
  if (operation.lifecycle === "submitting" && !operation.providerOperationId) {
    const receipt = await reconcileMediaOperation(operation.id);
    syncJobFromOperation(receipt.operation);
    return;
  }
  if (operation.lifecycle === "verifying") {
    const intent = durableVideoIntent(operation.intent);
    const checkpoint = operation.providerCheckpoint as { localPath?: unknown; resultUrl?: unknown; ingestState?: unknown } | null;
    const job = jobs.get(operation.id);
    if (!intent || !job) throw new Error("media_video_operation_corrupt");
    const kept = beginRetainAfterLocalStop(job);
    try {
      let file: MultimodalVideoFile | null = null;
      const pending = videoIngestRuns.get(job.id);
      if (pending) file = await pending;
      else if (typeof checkpoint?.localPath === "string" && checkpoint.ingestState !== "downloading") {
        try { file = await verifiedVideoFile(job, checkpoint.localPath, intent.request); }
        catch (error) {
          const incomplete = (error as NodeJS.ErrnoException).code === "ENOENT"
            || (error instanceof MediaVerificationError && ["media_decode_failed", "media_video_stream_invalid", "media_output_size_invalid"].includes(error.reasonCode));
          if (!incomplete || (typeof checkpoint.resultUrl !== "string" && !operation.providerOperationId)) throw error;
          // A legacy localPath can name a crash partial. Preserve it and recover the same output, never a new generation.
        }
      }
      if (!file && typeof checkpoint?.resultUrl === "string") {
        try { file = await downloadVideo(job, checkpoint.resultUrl, intent.request); }
        catch (error) {
          if (!(error instanceof VideoResultFetchError) || ![403, 410].includes(error.status)
            || !operation.providerOperationId || operation.capabilities.statusLookup !== "provider_operation_id") throw error;
          // Refresh an expired storage URL by looking up the same accepted provider operation; never submit again.
          const current = getMediaOperation(operation.id);
          if (current) await pollRecoveredVideoOperation(current);
          return;
        }
      }
      if (!file) {
        // A crashed Veo SDK download may have only a provider identity, never a complete local file.
        if (operation.providerOperationId) { await pollRecoveredVideoOperation(operation); return; }
        throw new Error("media_video_verification_checkpoint_missing");
      }
      job.files = [file];
      updateJob(job, { status: "succeeded", phase: "complete", message: kept ? keptMessage() : (currentUiLocale() === "ko" ? "애니메이션 완료" : "Animation complete"), percent: 100 });
    } finally { retainAfterLocalStop.delete(job.id); }
    return;
  }
  if (["provider_accepted", "running"].includes(operation.lifecycle) && operation.providerOperationId) {
    await pollRecoveredVideoOperation(operation);
  }
}

async function pollRecoveredVideoOperation(operation: MediaOperationRecord): Promise<void> {
  const intent = durableVideoIntent(operation.intent);
  const job = jobs.get(operation.id);
  if (!intent || !job || !operation.providerOperationId) throw new Error("media_video_operation_corrupt");
  if (operation.pollAttempts >= MAX_POLLS) throw new ProviderStatusUnknown("Provider polling reached its durable attempt limit; the job was not resubmitted.");
  const grokApi = job.provider === "grok" && isTextOnly(intent.request);
  const key = operation.providerId === "grok" && !grokApi ? null : await readFirstSecret(grokApi ? XAI_KEYS : PROVIDER_KEYS[job.provider]);
  if ((job.provider !== "grok" || grokApi) && !key) throw new ProviderStatusUnknown("The provider credential is unavailable for restart reconciliation.");
  try {
    if (grokApi) {
      const response = await fetch(`${XAI_BASE}/videos/${encodeURIComponent(operation.providerOperationId)}`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });
      if (response.status === 429) { recordProviderPoll(job, "HTTP_429", operation.pollAttempts); scheduleVideoRecovery(job.id); return; }
      if (!response.ok) throw new Error(`xAI video status HTTP ${response.status}`);
      const outcome = grokVideoOutcome(await response.json());
      recordProviderPoll(job, outcome.status || "unknown", operation.pollAttempts);
      if (outcome.url) return completeRecoveredRemote(job, intent.request, outcome.url);
      if (outcome.failure) throw new ProviderTerminalFailure(outcome.failure);
      scheduleVideoRecovery(job.id);
      return;
    }
    if (job.provider === "runway") {
      const response = await fetch(`${RUNWAY_BASE}/v1/tasks/${operation.providerOperationId}`, {
        headers: { Authorization: `Bearer ${key}`, "X-Runway-Version": RUNWAY_VERSION, "Content-Type": "application/json" },
      });
      if (response.status === 429) { recordProviderPoll(job, "HTTP_429", operation.pollAttempts); scheduleVideoRecovery(job.id); return; }
      if (!response.ok) throw new Error(`Runway status HTTP ${response.status}`);
      const data = await response.json() as { status?: string; output?: string[]; failure?: string; failureCode?: string };
      const status = String(data.status ?? "").toUpperCase();
      recordProviderPoll(job, status || "UNKNOWN", operation.pollAttempts);
      if (status === "SUCCEEDED" && data.output?.[0]) return completeRecoveredRemote(job, intent.request, data.output[0]);
      if (["FAILED", "CANCELED", "EXPIRED"].includes(status)) throw new ProviderTerminalFailure(data.failure || data.failureCode || status);
      scheduleVideoRecovery(job.id);
      return;
    }
    if (job.provider === "luma") {
      const response = await fetch(`${LUMA_BASE}/dream-machine/v1/generations/${operation.providerOperationId}`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });
      if (response.status === 429) { recordProviderPoll(job, "HTTP_429", operation.pollAttempts); scheduleVideoRecovery(job.id); return; }
      if (!response.ok) throw new Error(`Luma status HTTP ${response.status}`);
      const data = await response.json() as { state?: string; assets?: { video?: string }; failure_reason?: string };
      const status = String(data.state ?? "").toLowerCase();
      recordProviderPoll(job, status || "unknown", operation.pollAttempts);
      if (status === "completed" && data.assets?.video) return completeRecoveredRemote(job, intent.request, data.assets.video);
      if (status === "failed") throw new ProviderTerminalFailure(data.failure_reason || status);
      scheduleVideoRecovery(job.id);
      return;
    }
    if (job.provider === "seedance") {
      const checkpoint = operation.providerCheckpoint as { statusUrl?: unknown; responseUrl?: unknown } | null;
      if (typeof checkpoint?.statusUrl !== "string" || typeof checkpoint.responseUrl !== "string") throw new ProviderStatusUnknown("The fal status checkpoint is unavailable.");
      const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
      const response = await fetch(checkpoint.statusUrl, { headers });
      if (response.status === 429) { recordProviderPoll(job, "HTTP_429", operation.pollAttempts, checkpoint); scheduleVideoRecovery(job.id); return; }
      if (!response.ok) throw new Error(`fal status HTTP ${response.status}`);
      const status = String((await response.json() as { status?: string }).status ?? "").toUpperCase();
      recordProviderPoll(job, status || "UNKNOWN", operation.pollAttempts, checkpoint);
      if (status === "COMPLETED") {
        const output = await fetch(checkpoint.responseUrl, { headers });
        if (!output.ok) throw new Error(`fal result HTTP ${output.status}`);
        const url = (await output.json() as { video?: { url?: string } }).video?.url;
        if (!url) throw new ProviderTerminalFailure("fal completed without a video URL");
        return completeRecoveredRemote(job, intent.request, url);
      }
      if (status.includes("FAIL") || status.includes("ERROR")) throw new ProviderTerminalFailure(status);
      scheduleVideoRecovery(job.id);
      return;
    }
    if (job.provider === "kling") {
      const response = await fetch(`${PIAPI_BASE}/api/v1/task/${operation.providerOperationId}`, {
        headers: { "x-api-key": key!, "Content-Type": "application/json" },
      });
      if (response.status === 429) { recordProviderPoll(job, "HTTP_429", operation.pollAttempts); scheduleVideoRecovery(job.id); return; }
      if (!response.ok) throw new Error(`PiAPI status HTTP ${response.status}`);
      const rec = (await response.json() as { data?: { status?: string; output?: { video_url?: string; works?: { video?: { resource?: string; resource_without_watermark?: string } }[] }; error?: { message?: string } } }).data;
      const status = String(rec?.status ?? "").toLowerCase();
      recordProviderPoll(job, status || "unknown", operation.pollAttempts);
      const url = rec?.output?.video_url || rec?.output?.works?.[0]?.video?.resource_without_watermark || rec?.output?.works?.[0]?.video?.resource;
      if (status === "completed" && url) return completeRecoveredRemote(job, intent.request, url);
      if (status === "failed") throw new ProviderTerminalFailure(rec?.error?.message || status);
      scheduleVideoRecovery(job.id);
      return;
    }
    if (job.provider === "veo") {
      const ai = new GoogleGenAI({ apiKey: key! });
      const refreshed = await ai.operations.getVideosOperation({ operation: { name: operation.providerOperationId } as GenerateVideosOperation });
      recordProviderPoll(job, refreshed.done ? "SUCCEEDED" : "RUNNING", operation.pollAttempts, { operationName: operation.providerOperationId });
      if (!refreshed.done) { scheduleVideoRecovery(job.id); return; }
      if (refreshed.error) throw new ProviderTerminalFailure(JSON.stringify(refreshed.error));
      await finishRecoveredVeo(job, intent.request, ai, refreshed);
      return;
    }
    throw new ProviderStatusUnknown("This local video adapter has no provider operation lookup.");
  } catch (error) {
    if (error instanceof ProviderStatusUnknown || error instanceof ProviderTerminalFailure || error instanceof MediaVerificationError) throw error;
    throw new ProviderStatusUnknown(`Provider status reconciliation was interrupted; no new submit was sent. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Provider finished after a local stop: keep its output under the stop (cancellation state stays as it is). */
function beginRetainAfterLocalStop(job: MultimodalVideoJob): boolean {
  if (getMediaOperation(job.id)?.cancellation !== "unconfirmed") return false;
  retainAfterLocalStop.add(job.id);
  if (!job.warnings.includes("kept_after_local_stop")) job.warnings.push("kept_after_local_stop");
  return true;
}
const keptMessage = () => currentUiLocale() === "ko" ? "기다림을 멈춘 뒤 완성되어 결과를 보관했습니다" : "Finished after you stopped waiting; the result was kept";

async function completeRecoveredRemote(job: MultimodalVideoJob, request: MultimodalVideoRequest, url: string): Promise<void> {
  const kept = beginRetainAfterLocalStop(job);
  try {
    updateJob(job, { phase: "downloading", message: currentUiLocale() === "ko" ? "결과 영상 다운로드 중" : "Downloading the result video", percent: 92 });
    const file = await downloadVideo(job, url, request);
    job.files = [file];
    updateJob(job, { status: "succeeded", phase: "complete", message: kept ? keptMessage() : (currentUiLocale() === "ko" ? "애니메이션 완료" : "Animation complete"), percent: 100 });
  } finally { retainAfterLocalStop.delete(job.id); }
}

async function finishRecoveredVeo(job: MultimodalVideoJob, request: MultimodalVideoRequest, ai: GoogleGenAI, operation: GenerateVideosOperation): Promise<void> {
  const kept = beginRetainAfterLocalStop(job);
  try { await ingestRecoveredVeo(job, request, ai, operation, kept); }
  finally { retainAfterLocalStop.delete(job.id); }
}

async function ingestRecoveredVeo(job: MultimodalVideoJob, request: MultimodalVideoRequest, ai: GoogleGenAI, operation: GenerateVideosOperation, kept: boolean): Promise<void> {
  const file = await runVideoIngest(job.id, () => ingestRecoveredVeoOnce(job, request, ai, operation));
  job.files = [file];
  updateJob(job, { status: "succeeded", phase: "complete", message: kept ? keptMessage() : (currentUiLocale() === "ko" ? "애니메이션 완료" : "Animation complete"), percent: 100 });
}

async function ingestRecoveredVeoOnce(job: MultimodalVideoJob, request: MultimodalVideoRequest, ai: GoogleGenAI, operation: GenerateVideosOperation): Promise<MultimodalVideoFile> {
  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error("Veo completed without a video.");
  const absPath = path.join(job.outputDir, `.video-ingest-${randomUUID()}.part`);
  await fs.mkdir(job.outputDir, { recursive: true });
  checkpointVideoIngest(job.id, { stagingPath: absPath, localPath: null, ingestState: "downloading",
    ...(video.uri ? { veoResultUri: video.uri } : {}) });
  try {
    if (video.videoBytes) await fs.writeFile(absPath, Buffer.from(video.videoBytes, "base64"));
    else if (video.uri) await ai.files.download({ file: video.uri, downloadPath: absPath });
    else throw new Error("Veo completed without downloadable bytes.");
  } catch (error) {
    // A partial file (disk full, interrupted download) must not block the next recovery attempt.
    await fs.unlink(absPath).catch(() => undefined);
    throw error;
  }
  return verifiedVideoFileOnce(job, absPath, request);
}

// Veo accepts 4, 6 or 8 seconds.
function veoTextDuration(sec: number | undefined): number {
  const wanted = sec ?? 6;
  return wanted <= 5 ? 4 : wanted <= 7 ? 6 : 8;
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
  return (value || "video").toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "video";
}

function snapshot(job: MultimodalVideoJob): MultimodalVideoJob {
  return JSON.parse(JSON.stringify(job)) as MultimodalVideoJob;
}

function requireJob(id: string): MultimodalVideoJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Animate job ${id} not found`);
  return job;
}

function updateJob(
  job: MultimodalVideoJob,
  patch: { status?: MultimodalVideoJob["status"]; phase?: MultimodalVideoJob["progress"]["phase"]; message?: string; percent?: number },
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
  const current = getMediaOperation(id);
  // Retrying ingest or looking up an accepted operation cannot create another chargeable generation.
  // Keep the durable checkpoint after transient I/O/verification interruption, even while the local job is stopped.
  const retryIngest = current?.lifecycle === "verifying" && !(error instanceof ProviderTerminalFailure)
    && !(error instanceof MediaVerificationError && !["media_verification_cancelled", "media_verifier_unavailable", "media_verification_timeout"].includes(error.reasonCode));
  const retryLookup = current?.providerOperationId
    && (error instanceof ProviderStatusUnknown || (error instanceof AnimateCancelled && current.cancellation === "unconfirmed"))
    && ["provider_accepted", "running"].includes(current.lifecycle);
  if (current && current.cancellation !== "confirmed" && (retryIngest || retryLookup)) {
    if (current.pollAttempts < MAX_POLLS) {
      const deferred = recordMediaProviderProgress({ id, providerStatus: retryIngest ? "INGEST_INTERRUPTED" : "LOOKUP_INTERRUPTED",
        providerCheckpoint: current.providerCheckpoint ?? undefined });
      syncJobFromOperation(deferred);
      scheduleVideoRecovery(id);
    }
    return;
  }
  if (job.status === "cancelled" && !(error instanceof ProviderTerminalFailure) && !(error instanceof MediaVerificationError)) return;
  try {
    if (error instanceof ProviderStatusUnknown) {
      const current = getMediaOperation(id);
      if (current?.providerOperationId && ["provider_accepted", "running"].includes(current.lifecycle)
        && current.pollAttempts < MAX_POLLS) {
        const deferred = recordMediaProviderProgress({
          id,
          providerStatus: "LOOKUP_INTERRUPTED",
          providerCheckpoint: current.providerCheckpoint ?? undefined,
        });
        syncJobFromOperation(deferred);
        scheduleVideoRecovery(id);
        return;
      }
      const operation = recordMediaOutcomeUnknown(id, error.message.slice(0, 4_000));
      syncJobFromOperation(operation);
      return;
    }
    if (error instanceof SubmitOutcomeUnknown) {
      const operation = recordMediaOutcomeUnknown(id, error.message.slice(0, 4_000));
      syncJobFromOperation(operation);
      return;
    }
    const operation = recordMediaFailed(id, error instanceof MediaVerificationError ? error.reasonCode : "media_video_failed",
      (error instanceof Error ? error.message : String(error)).slice(0, 4_000));
    if (operation.lifecycle === "succeeded") {
      syncJobFromOperation(operation);
      return;
    }
  } catch (registryError) {
    job.warnings.push(`media_registry_update_failed:${registryError instanceof Error ? registryError.message : String(registryError)}`);
  }
  const ko = currentUiLocale() === "ko";
  job.status = "failed";
  job.progress.phase = "failed";
  job.error = error instanceof Error ? error.message : String(error);
  job.message = ko ? "실패" : "Failed";
  job.updatedAtMs = Date.now();
}

function assertNotCancelled(id: string): void {
  if (cancelledJobs.has(id) && !retainAfterLocalStop.has(id)) throw new AnimateCancelled();
}

class VideoResultFetchError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class AnimateCancelled extends Error {
  constructor() {
    super("Animate cancelled");
  }
}

class SubmitOutcomeUnknown extends Error {}
class ProviderStatusUnknown extends Error {}
class ProviderTerminalFailure extends Error {}
