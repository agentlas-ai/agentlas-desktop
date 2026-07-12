// Oberon 애니메이션 스튜디오 — image-to-video 엔진.
//   키프레임 이미지 1장 + 모션 프롬프트 → 짧은 영상(mp4). BYOK 키(Environment Keys).
//   provider: runway(로컬 base64) | luma(공개 HTTPS URL만) | veo(@google/genai)
//            | seedance(ByteDance, fal.ai 경유) | kling(Kuaishou, PiAPI 경유).
//   provider는 UI에서 "연결/키 있는 멀티모달"로 확정해 넘어온다(무조건 Veo 아님).
//   ⚠️ no-fallback: 키 미설정/입력 부적합이면 조용히 떨어지지 않고 명시적으로 실패 보고한다.
import { app, shell } from "electron";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { GoogleGenAI, type GenerateVideosOperation } from "@google/genai";
import { readEnvVar, hasEnvVar } from "../secrets/vault";
import { currentUiLocale } from "../ui-locale";
import type {
  OberonAnimateFile,
  OberonAnimateJob,
  OberonAnimateKeyStatus,
  OberonAnimateProvider,
  OberonAnimateRequest,
} from "../../shared/types";
import { grokAuthSource } from "../multimodal/availability";
import { resolveGrokBin, runGrokImagine } from "../multimodal/grok-imagine";

// provider별 허용 env 키 — 멀티모달 레지스트리(shared/multimodal.ts) 키명을 먼저,
// 레거시/실동작 키명을 폴백으로. "멀티모달로 연결한 키"를 animate가 그대로 인식하도록 정렬.
//   runway  : 레지스트리 RUNWAY_API_KEY / 레거시 RUNWAYML_API_SECRET
//   luma    : 레지스트리 LUMA_API_KEY / 레거시 LUMAAI_API_KEY
//   veo     : GEMINI_API_KEY / GOOGLE_API_KEY (render.ts와 동일 — 실제 동작 키)
//   seedance: FAL_KEY (fal.ai 경유)
//   kling   : PIAPI_KEY (PiAPI 경유)
const PROVIDER_KEYS: Record<OberonAnimateProvider, string[]> = {
  runway: ["RUNWAY_API_KEY", "RUNWAYML_API_SECRET"],
  luma: ["LUMA_API_KEY", "LUMAAI_API_KEY"],
  veo: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  seedance: ["FAL_KEY"],
  kling: ["PIAPI_KEY"],
  // grok: API 키가 아니라 구독 로그인된 Grok CLI(bin)로 동작 — 키 목록은 비워둔다.
  grok: [],
};
const DEFAULT_MODELS: Record<OberonAnimateProvider, string> = {
  runway: "gen4_turbo",
  luma: "ray-2",
  veo: "veo-3.1-lite-generate-001",
  seedance: "fal-ai/bytedance/seedance/v1/pro/image-to-video",
  kling: "kling",
  grok: "runtime-default",
};

const RUNWAY_BASE = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";
const LUMA_BASE = "https://api.lumalabs.ai";
const FAL_QUEUE_BASE = "https://queue.fal.run";
const PIAPI_BASE = "https://api.piapi.ai";
const POLL_MS = 5_000;
const MAX_POLLS = 120; // ~10분

const jobs = new Map<string, OberonAnimateJob>();
const cancelledJobs = new Set<string>();

async function hasAnyEnvVar(keys: string[]): Promise<boolean> {
  const checks = await Promise.all(keys.map((key) => hasEnvVar(key)));
  return checks.some(Boolean);
}

export async function animateKeyStatus(): Promise<OberonAnimateKeyStatus> {
  const [runway, luma, veo, seedance, kling, grokAuth] = await Promise.all([
    hasAnyEnvVar(PROVIDER_KEYS.runway),
    hasAnyEnvVar(PROVIDER_KEYS.luma),
    hasAnyEnvVar(PROVIDER_KEYS.veo),
    hasAnyEnvVar(PROVIDER_KEYS.seedance),
    hasAnyEnvVar(PROVIDER_KEYS.kling),
    grokAuthSource(),
  ]);
  return { runway, luma, veo, seedance, kling, grok: Boolean(resolveGrokBin()) && grokAuth === "oauth" };
}

export function startOberonAnimate(request: OberonAnimateRequest): OberonAnimateJob {
  const ko = currentUiLocale() === "ko";
  const id = randomUUID();
  const provider: OberonAnimateProvider = request.provider ?? "runway";
  const model = request.model || DEFAULT_MODELS[provider];
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

  if (job.provider === "grok") {
    await runGrokAnimate(id, job, request, prompt);
    return;
  }

  // provider별 허용 키 목록에서 실제 존재하는 첫 키를 쓴다(멀티모달 연결 키 인식).
  const keyList = PROVIDER_KEYS[job.provider];
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
          : await runKling(job, request, key, prompt);

  assertNotCancelled(id);
  updateJob(job, { phase: "downloading", message: ko ? "결과 영상 다운로드 중" : "Downloading the result video", percent: 92 });
  const file = await downloadVideo(job, videoUrl);
  job.files.push(file);
  updateJob(job, { status: "succeeded", phase: "complete", message: ko ? "애니메이션 완료" : "Animation complete", percent: 100 });
}

async function runGrokAnimate(
  id: string,
  job: OberonAnimateJob,
  request: OberonAnimateRequest,
  prompt: string,
): Promise<void> {
  const ko = currentUiLocale() === "ko";
  await fs.mkdir(job.outputDir, { recursive: true });
  const inputFrame = await materializeGrokAnimateInput(job, request);
  const name = `${safeSlug(job.title)}-${job.id.slice(0, 8)}.mp4`;
  const absPath = path.join(job.outputDir, name);
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
  const stat = await fs.stat(generated);
  job.files.push({
    id: randomUUID(),
    kind: "animation_mp4",
    name: path.basename(generated),
    absPath: generated,
    url: pathToFileURL(generated).href,
    mime: "video/mp4",
    sizeBytes: stat.size,
  });
  updateJob(job, { status: "succeeded", phase: "complete", message: ko ? "Grok 애니메이션 완료" : "Grok animation complete", percent: 100 });
}

async function materializeGrokAnimateInput(job: OberonAnimateJob, request: OberonAnimateRequest): Promise<string> {
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
  job: OberonAnimateJob,
  request: OberonAnimateRequest,
  prompt: string,
  apiKey: string,
): Promise<void> {
  const ko = currentUiLocale() === "ko";
  const image = await resolveVeoImage(request);
  assertNotCancelled(id);

  const ai = new GoogleGenAI({ apiKey });
  let operation: GenerateVideosOperation = await ai.models.generateVideos({
    model: job.model,
    prompt,
    image,
    config: {
      numberOfVideos: 1,
      durationSeconds: (request.durationSec ?? 5) >= 8 ? 8 : 6,
      aspectRatio: request.aspectRatio === "9:16" ? "9:16" : "16:9",
      resolution: "720p",
      enhancePrompt: true,
      personGeneration: "allow_adult",
    },
  });

  updateJob(job, { phase: "generating", message: ko ? "Veo 생성 중" : "Veo generating", percent: 25 });
  for (let i = 0; !operation.done && i < MAX_POLLS; i += 1) {
    assertNotCancelled(id);
    await sleep(POLL_MS);
    operation = await ai.operations.getVideosOperation({ operation });
    updateJob(job, { percent: Math.min(90, 25 + Math.round((i / MAX_POLLS) * 65)) });
  }
  if (!operation.done) throw new Error(ko ? "Veo 생성 시간 초과." : "Veo operation timed out before completion.");
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
  const name = `${safeSlug(job.title)}-${job.id.slice(0, 8)}.mp4`;
  const absPath = path.join(job.outputDir, name);
  if (video.videoBytes) {
    await fs.writeFile(absPath, Buffer.from(video.videoBytes, "base64"));
  } else if (video.uri) {
    await ai.files.download({ file: video.uri, downloadPath: absPath });
  } else {
    throw new Error(ko ? "Veo가 uri/바이트 없는 영상을 반환했습니다." : "Veo returned a video without uri or videoBytes.");
  }
  const stat = await fs.stat(absPath);
  job.files.push({
    id: randomUUID(),
    kind: "animation_mp4",
    name,
    absPath,
    url: pathToFileURL(absPath).href,
    mime: "video/mp4",
    sizeBytes: stat.size,
  });
  updateJob(job, { status: "succeeded", phase: "complete", message: ko ? "애니메이션 완료" : "Animation complete", percent: 100 });
}

// Veo i2v 입력 이미지 → {imageBytes(base64), mimeType}. 로컬 경로 우선, 공개 URL 폴백.
async function resolveVeoImage(request: OberonAnimateRequest): Promise<{ imageBytes: string; mimeType: string }> {
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

// ── Seedance 2.0 (ByteDance, fal.ai queue 경유; image-to-video) ──
//   fal 큐 API: 제출→status_url/response_url→폴링→결과 video.url. 이미지는 data-uri 인라인.
async function runSeedance(job: OberonAnimateJob, request: OberonAnimateRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const imageUrl = await resolveRunwayImage(request); // https URL 또는 로컬 data-uri.
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  const body = {
    prompt,
    image_url: imageUrl,
    aspect_ratio: request.aspectRatio ?? "16:9",
    resolution: "720p",
    duration: clampDuration(request.durationSec) >= 10 ? "10" : "5",
  };
  const submit = await fetch(`${FAL_QUEUE_BASE}/${job.model}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!submit.ok) {
    throw new Error(
      ko
        ? `Seedance(fal) 제출 실패 (HTTP ${submit.status}): ${truncate(await submit.text())}`
        : `Seedance (fal) submission failed (HTTP ${submit.status}): ${truncate(await submit.text())}`,
    );
  }
  const queued = (await submit.json()) as { status_url?: string; response_url?: string };
  const statusUrl = queued.status_url;
  const responseUrl = queued.response_url;
  if (!statusUrl || !responseUrl) {
    throw new Error(ko ? "Seedance(fal) 응답에 상태 URL이 없습니다." : "The fal response did not include a status URL.");
  }

  updateJob(job, { phase: "generating", message: ko ? "Seedance 생성 중" : "Seedance generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetch(statusUrl, { headers });
    if (!poll.ok) {
      if (poll.status === 429) continue; // throttled
      throw new Error(ko ? `Seedance(fal) 폴링 실패 (HTTP ${poll.status})` : `fal polling failed (HTTP ${poll.status})`);
    }
    const data = (await poll.json()) as { status?: string };
    const status = String(data.status || "").toUpperCase();
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
  throw new Error(ko ? "Seedance 생성 시간 초과(약 10분)." : "Seedance generation timed out (~10 minutes).");
}

// ── Kling 2.x (Kuaishou, PiAPI 경유; image-to-video) ─────────
//   PiAPI 통합 태스크: POST /api/v1/task → GET /api/v1/task/{id} 폴링 → output 영상 URL.
async function runKling(job: OberonAnimateJob, request: OberonAnimateRequest, key: string, prompt: string): Promise<string> {
  const ko = currentUiLocale() === "ko";
  const imageUrl = await resolveRunwayImage(request); // https URL 또는 로컬 data-uri.
  const headers = { "x-api-key": key, "Content-Type": "application/json" };
  const body = {
    model: "kling",
    task_type: "video_generation",
    input: {
      prompt,
      image_url: imageUrl,
      duration: clampDuration(request.durationSec) >= 10 ? 10 : 5,
      aspect_ratio: request.aspectRatio ?? "16:9",
      mode: "std",
      version: "2.5",
    },
  };
  const submit = await fetch(`${PIAPI_BASE}/api/v1/task`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!submit.ok) {
    throw new Error(
      ko
        ? `Kling(PiAPI) 제출 실패 (HTTP ${submit.status}): ${truncate(await submit.text())}`
        : `Kling (PiAPI) submission failed (HTTP ${submit.status}): ${truncate(await submit.text())}`,
    );
  }
  const created = (await submit.json()) as { message?: string; data?: { task_id?: string } };
  const taskId = created.data?.task_id;
  if (!taskId) {
    throw new Error(
      ko ? `Kling(PiAPI) 응답에 task id가 없습니다: ${truncate(created.message || "")}` : `PiAPI response did not include a task id: ${truncate(created.message || "")}`,
    );
  }

  updateJob(job, { phase: "generating", message: ko ? "Kling 생성 중" : "Kling generating", percent: 25 });
  for (let i = 0; i < MAX_POLLS; i++) {
    assertNotCancelled(job.id);
    await sleep(POLL_MS);
    const poll = await fetch(`${PIAPI_BASE}/api/v1/task/${taskId}`, { headers });
    if (!poll.ok) {
      if (poll.status === 429) continue; // throttled
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
  throw new Error(ko ? "Kling 생성 시간 초과(약 10분)." : "Kling generation timed out (~10 minutes).");
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
