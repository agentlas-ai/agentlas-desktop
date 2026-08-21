"use client";

import { ipc } from "@/lib/ipc";
import { currentLocale } from "@/lib/i18n";
import type { MultimodalVideoJob } from "@/lib/types";

/** 멀티모달 생성 한 건의 종류. 스튜디오 전용 종류(plan/keyframe/render/motion)는
 * Oberon 삭제와 함께 사라졌다(2026-08-21). */
export type MultimodalJobKind = "image" | "video" | "audio";
export type MultimodalJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** 지금은 비디오 잡만 라이브 폴링 대상이다(이미지는 한 번의 왕복). */
export type MultimodalLiveJob = MultimodalVideoJob;

export interface MultimodalJob {
  id: string;
  kind: MultimodalJobKind;
  productionId?: string;
  title: string;
  label: string;
  status: MultimodalJobStatus;
  percent: number;
  message: string;
  phase?: string;
  job?: MultimodalLiveJob;
  createdAtMs: number;
  updatedAtMs: number;
}

export const MULTIMODAL_JOBS_EVENT = "agentlas:multimodal-jobs-change";

const STORAGE_KEY = "multimodal.background.jobs.v1";
const DONE_KEEP_MS = 10 * 60 * 1000;
const DONE_VISIBLE_MS = 90 * 1000;
const PLAN_STALE_MS = 30 * 60 * 1000;
const POLL_MS = 1_200;
const terminalStatuses = new Set<MultimodalJobStatus>(["succeeded", "failed", "cancelled"]);

let monitorUsers = 0;
let monitorTimer: number | null = null;
let monitorBusy = false;

// localStorage 파싱 캐시 — 전역 모니터(1.2초)와 AppShell 틱(2초)이 잡 0개인
// 평상시에도 매 틱 JSON.parse를 돌리지 않게 마지막 파싱 결과를 재사용한다.
// 같은 탭의 쓰기는 writeJobs가 갱신하고, 다른 창의 쓰기는 storage 이벤트가
// 무효화한다. 반환 배열은 호출부가 절대 제자리 수정하지 않는다(filter/find만).
let jobsReadCache: MultimodalJob[] | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) jobsReadCache = null;
  });
}

export function listMultimodalJobs(): MultimodalJob[] {
  const jobs = readJobs();
  const pruned = pruneJobs(jobs);
  if (pruned.length !== jobs.length) writeJobs(pruned);
  return pruned.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function visibleMultimodalJobs(now = Date.now()): MultimodalJob[] {
  return listMultimodalJobs().filter((job) => isMultimodalJobActive(job) || now - job.updatedAtMs < DONE_VISIBLE_MS);
}

export function subscribeMultimodalJobs(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) handler();
  };
  window.addEventListener(MULTIMODAL_JOBS_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MULTIMODAL_JOBS_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}

export function isMultimodalJobActive(job: MultimodalJob): boolean {
  return !terminalStatuses.has(job.status);
}

export function trackMultimodalJob(kind: MultimodalJobKind, job: MultimodalLiveJob): MultimodalJob {
  const snapshot = fromLiveJob(kind, job);
  // 폴러 둘(페이지 1초 + 전역 모니터 1.2초)이 같은 잡을 추적한다. 표시 내용이
  // 그대로면 localStorage 직렬화·변경 이벤트·AppShell 리렌더를 전부 생략한다.
  const existing = readJobs().find((row) => row.kind === snapshot.kind && row.id === snapshot.id);
  if (
    existing
    && existing.status === snapshot.status
    && clampPercent(existing.percent) === clampPercent(snapshot.percent)
    && existing.message === snapshot.message
    && existing.phase === snapshot.phase
    && existing.title === snapshot.title
  ) {
    return existing;
  }
  upsertJob(snapshot);
  return snapshot;
}

export function failMultimodalJob(kind: MultimodalJobKind, id: string, message: string): void {
  const current = readJobs().find((job) => job.kind === kind && job.id === id);
  if (!current) return;
  const failed = withFailedLiveJob(current.job, message);
  upsertJob({
    ...current,
    status: "failed",
    percent: current.percent,
    message,
    phase: "failed",
    job: failed,
    updatedAtMs: Date.now(),
  });
}

export function removeMultimodalJob(kind: MultimodalJobKind, id: string): void {
  writeJobs(readJobs().filter((job) => !(job.kind === kind && job.id === id)));
}

export function clearMultimodalJobsForProduction(productionId: string): void {
  writeJobs(readJobs().filter((job) => job.productionId !== productionId));
}

export function startMultimodalJobMonitor(): () => void {
  if (typeof window === "undefined") return () => {};
  monitorUsers += 1;
  if (!monitorTimer) {
    void tickMultimodalJobs();
    monitorTimer = window.setInterval(() => void tickMultimodalJobs(), POLL_MS);
  }
  return () => {
    monitorUsers = Math.max(0, monitorUsers - 1);
    if (monitorUsers === 0 && monitorTimer) {
      window.clearInterval(monitorTimer);
      monitorTimer = null;
    }
  };
}

async function tickMultimodalJobs(): Promise<void> {
  // 탭 숨김 시 이 tick만 건너뛴다(타이머·POLL_MS는 유지) — 백그라운드 폴링 폭주 방지.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    const jobs = listMultimodalJobs();
    const api = ipc()?.multimodal;
    let changed = false;
    const now = Date.now();

    for (const snapshot of jobs) {
      if (!isMultimodalJobActive(snapshot)) continue;
      if (!api) continue;
      const live = await fetchLiveJob(snapshot.kind, snapshot.id);
      if (live) {
        trackMultimodalJob(snapshot.kind, live);
        changed = true;
      } else {
        upsertJob({
          ...snapshot,
          status: "failed",
          message:
            currentLocale() === "ko"
              ? "앱을 다시 시작해 작업 연결이 끊겼습니다"
              : "Lost the job connection — restart the app",
          phase: "failed",
          updatedAtMs: now,
        });
        changed = true;
      }
    }

    if (changed) emitChange();
  } finally {
    monitorBusy = false;
  }
}

async function fetchLiveJob(kind: MultimodalJobKind, id: string): Promise<MultimodalLiveJob | null> {
  const api = ipc()?.multimodal;
  if (!api) return null;
  // 비디오만 비동기 잡이다. 이미지는 한 번의 왕복으로 끝나고 오디오는 아직 엔진이 없다
  // (PLUGIN 규격의 provider 선언만 존재) — 없는 것을 폴링하는 시늉을 하지 않는다.
  if (kind !== "video") return null;
  return api.getVideoJob(id);
}

function updateJob(id: string, kind: MultimodalJobKind, patch: Partial<MultimodalJob>): void {
  const current = readJobs().find((job) => job.kind === kind && job.id === id);
  const now = Date.now();
  upsertJob({
    id,
    kind,
    title: patch.title ?? current?.title ?? "Multimodal",
    label: patch.label ?? current?.label ?? labelForKind(kind),
    status: patch.status ?? current?.status ?? "running",
    percent: clampPercent(patch.percent ?? current?.percent ?? 0),
    message: patch.message ?? current?.message ?? "",
    phase: patch.phase ?? current?.phase,
    productionId: patch.productionId ?? current?.productionId,
    job: patch.job ?? current?.job,
    createdAtMs: current?.createdAtMs ?? patch.createdAtMs ?? now,
    updatedAtMs: now,
  });
}

function upsertJob(snapshot: MultimodalJob): void {
  const jobs = readJobs();
  const key = jobKey(snapshot);
  const next = [
    {
      ...snapshot,
      label: snapshot.label || labelForKind(snapshot.kind),
      percent: clampPercent(snapshot.percent),
      updatedAtMs: snapshot.updatedAtMs || Date.now(),
    },
    ...jobs.filter((job) => jobKey(job) !== key),
  ];
  writeJobs(pruneJobs(next));
}

function fromLiveJob(kind: MultimodalJobKind, job: MultimodalLiveJob): MultimodalJob {
  return {
    id: job.id,
    kind,
    productionId: job.productionId,
    title: job.title || "Multimodal",
    label: labelForKind(kind),
    status: job.status,
    percent: progressPercent(job),
    message: job.message || labelForKind(kind),
    phase: job.progress?.phase,
    job,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs || Date.now(),
  };
}

function withFailedLiveJob(job: MultimodalLiveJob | undefined, message: string): MultimodalLiveJob | undefined {
  if (!job) return undefined;
  return {
    ...job,
    status: "failed",
    message,
    error: message,
    progress: { ...job.progress, phase: "failed" },
    updatedAtMs: Date.now(),
  } as MultimodalLiveJob;
}

function progressPercent(job: MultimodalLiveJob): number {
  const raw = clampPercent(job.progress?.percent ?? 0);
  if (raw > 0 || terminalStatuses.has(job.status)) return raw;
  if (job.status === "queued" || job.status === "running") {
    const elapsedMs = Math.max(0, Date.now() - (job.createdAtMs || Date.now()));
    const floor = job.status === "queued" ? 1 : 2 + Math.floor(elapsedMs / 3_000);
    return clampPercent(Math.min(12, floor));
  }
  return raw;
}

function labelForKind(kind: MultimodalJobKind): string {
  const ko = currentLocale() === "ko";
  switch (kind) {
    case "image":
      return ko ? "이미지 생성" : "Image generation";
    case "video":
      return ko ? "영상 생성" : "Video generation";
    case "audio":
      return ko ? "음성 생성" : "Audio generation";
  }
}

function pruneJobs(jobs: MultimodalJob[]): MultimodalJob[] {
  const now = Date.now();
  return jobs.filter((job) => isMultimodalJobActive(job) || now - job.updatedAtMs < DONE_KEEP_MS).slice(0, 12);
}

function readJobs(): MultimodalJob[] {
  if (typeof window === "undefined") return [];
  if (jobsReadCache) return jobsReadCache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      jobsReadCache = [];
      return jobsReadCache;
    }
    const parsed = JSON.parse(raw) as MultimodalJob[];
    jobsReadCache = Array.isArray(parsed) ? parsed.filter(isJobLike) : [];
    return jobsReadCache;
  } catch {
    return [];
  }
}

function writeJobs(jobs: MultimodalJob[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    return;
  }
  jobsReadCache = jobs;
  emitChange();
}

function emitChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MULTIMODAL_JOBS_EVENT));
}

function jobKey(job: MultimodalJob): string {
  return `${job.kind}:${job.id}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isJobLike(value: MultimodalJob): boolean {
  return !!value && typeof value.id === "string" && typeof value.kind === "string" && typeof value.status === "string";
}
