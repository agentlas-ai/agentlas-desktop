"use client";

import { ipc } from "@/lib/ipc";
import { currentLocale } from "@/lib/i18n";
import type { OberonAnimateJob, OberonKeyframeJob, OberonMotionAdJob, OberonRenderJob } from "@/lib/types";

export type OberonBackgroundJobKind = "plan" | "keyframe" | "render" | "motion" | "animate";
export type OberonBackgroundJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type OberonLiveJob = OberonKeyframeJob | OberonRenderJob | OberonMotionAdJob | OberonAnimateJob;

export interface OberonBackgroundJob {
  id: string;
  kind: OberonBackgroundJobKind;
  productionId?: string;
  title: string;
  label: string;
  status: OberonBackgroundJobStatus;
  percent: number;
  message: string;
  phase?: string;
  job?: OberonLiveJob;
  createdAtMs: number;
  updatedAtMs: number;
}

export const OBERON_JOBS_EVENT = "agentlas:oberon-jobs-change";

const STORAGE_KEY = "oberon.background.jobs.v1";
const DONE_KEEP_MS = 10 * 60 * 1000;
const DONE_VISIBLE_MS = 90 * 1000;
const PLAN_STALE_MS = 30 * 60 * 1000;
const POLL_MS = 1_200;
const terminalStatuses = new Set<OberonBackgroundJobStatus>(["succeeded", "failed", "cancelled"]);

let monitorUsers = 0;
let monitorTimer: number | null = null;
let monitorBusy = false;

export function listOberonBackgroundJobs(): OberonBackgroundJob[] {
  const jobs = readJobs();
  const pruned = pruneJobs(jobs);
  if (pruned.length !== jobs.length) writeJobs(pruned);
  return pruned.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function visibleOberonBackgroundJobs(now = Date.now()): OberonBackgroundJob[] {
  return listOberonBackgroundJobs().filter((job) => isOberonBackgroundJobActive(job) || now - job.updatedAtMs < DONE_VISIBLE_MS);
}

export function subscribeOberonBackgroundJobs(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) handler();
  };
  window.addEventListener(OBERON_JOBS_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(OBERON_JOBS_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}

export function isOberonBackgroundJobActive(job: OberonBackgroundJob): boolean {
  return !terminalStatuses.has(job.status);
}

export function trackOberonLiveJob(kind: Exclude<OberonBackgroundJobKind, "plan">, job: OberonLiveJob): OberonBackgroundJob {
  const snapshot = fromLiveJob(kind, job);
  upsertJob(snapshot);
  return snapshot;
}

export function startOberonPlanJob(title: string): OberonBackgroundJob {
  const now = Date.now();
  const snapshot: OberonBackgroundJob = {
    id: `plan-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "plan",
    title: title.trim() || "Oberon",
    label: labelForKind("plan"),
    status: "running",
    percent: 8,
    message: currentLocale() === "ko" ? "기획안을 만들고 있습니다" : "Drafting the plan",
    phase: "planning",
    createdAtMs: now,
    updatedAtMs: now,
  };
  upsertJob(snapshot);
  return snapshot;
}

export function finishOberonPlanJob(id: string, productionId: string, title: string): void {
  updateJob(id, "plan", {
    productionId,
    title: title.trim() || "Oberon",
    status: "succeeded",
    percent: 100,
    message: currentLocale() === "ko" ? "기획안 생성 완료" : "Plan generated",
    phase: "complete",
  });
}

export function failOberonBackgroundJob(kind: OberonBackgroundJobKind, id: string, message: string): void {
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

export function removeOberonBackgroundJob(kind: OberonBackgroundJobKind, id: string): void {
  writeJobs(readJobs().filter((job) => !(job.kind === kind && job.id === id)));
}

export function clearOberonBackgroundJobsForProduction(productionId: string): void {
  writeJobs(readJobs().filter((job) => job.productionId !== productionId));
}

export function startOberonBackgroundJobMonitor(): () => void {
  if (typeof window === "undefined") return () => {};
  monitorUsers += 1;
  if (!monitorTimer) {
    void tickOberonBackgroundJobs();
    monitorTimer = window.setInterval(() => void tickOberonBackgroundJobs(), POLL_MS);
  }
  return () => {
    monitorUsers = Math.max(0, monitorUsers - 1);
    if (monitorUsers === 0 && monitorTimer) {
      window.clearInterval(monitorTimer);
      monitorTimer = null;
    }
  };
}

async function tickOberonBackgroundJobs(): Promise<void> {
  // 탭 숨김 시 이 tick만 건너뛴다(타이머·POLL_MS는 유지) — 백그라운드 폴링 폭주 방지.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    const jobs = listOberonBackgroundJobs();
    const api = ipc()?.oberon;
    let changed = false;
    const now = Date.now();

    for (const snapshot of jobs) {
      if (!isOberonBackgroundJobActive(snapshot)) continue;
      if (snapshot.kind === "plan") {
        const percent = Math.min(92, Math.max(snapshot.percent, 8 + Math.floor((now - snapshot.createdAtMs) / 1_500) * 4));
        if (percent !== snapshot.percent) {
          upsertJob({ ...snapshot, percent, updatedAtMs: now });
          changed = true;
        } else if (now - snapshot.createdAtMs > PLAN_STALE_MS) {
          upsertJob({
            ...snapshot,
            status: "failed",
            message: currentLocale() === "ko" ? "기획 작업 연결이 끊겼습니다" : "Lost connection to the planning job",
            phase: "failed",
            updatedAtMs: now,
          });
          changed = true;
        }
        continue;
      }
      if (!api) continue;
      const live = await fetchLiveJob(snapshot.kind, snapshot.id);
      if (live) {
        trackOberonLiveJob(snapshot.kind, live);
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

async function fetchLiveJob(kind: Exclude<OberonBackgroundJobKind, "plan">, id: string): Promise<OberonLiveJob | null> {
  const api = ipc()?.oberon;
  if (!api) return null;
  if (kind === "keyframe") return api.getKeyframeJob(id);
  if (kind === "render") return api.getRenderJob(id);
  if (kind === "motion") return api.getMotionAdJob(id);
  return api.getAnimateJob(id);
}

function updateJob(id: string, kind: OberonBackgroundJobKind, patch: Partial<OberonBackgroundJob>): void {
  const current = readJobs().find((job) => job.kind === kind && job.id === id);
  const now = Date.now();
  upsertJob({
    id,
    kind,
    title: patch.title ?? current?.title ?? "Oberon",
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

function upsertJob(snapshot: OberonBackgroundJob): void {
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

function fromLiveJob(kind: Exclude<OberonBackgroundJobKind, "plan">, job: OberonLiveJob): OberonBackgroundJob {
  return {
    id: job.id,
    kind,
    productionId: job.productionId,
    title: job.title || "Oberon",
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

function withFailedLiveJob(job: OberonLiveJob | undefined, message: string): OberonLiveJob | undefined {
  if (!job) return undefined;
  return {
    ...job,
    status: "failed",
    message,
    error: message,
    progress: { ...job.progress, phase: "failed" },
    updatedAtMs: Date.now(),
  } as OberonLiveJob;
}

function progressPercent(job: OberonLiveJob): number {
  return clampPercent(job.progress?.percent ?? 0);
}

function labelForKind(kind: OberonBackgroundJobKind): string {
  const ko = currentLocale() === "ko";
  switch (kind) {
    case "plan":
      return ko ? "기획 생성" : "Plan generation";
    case "keyframe":
      return ko ? "키프레임 생성" : "Keyframe generation";
    case "render":
      return ko ? "Veo 영상 렌더" : "Veo video render";
    case "motion":
      return ko ? "모션그래픽 렌더" : "Motion graphics render";
    case "animate":
      return ko ? "애니메이션 생성" : "Animation generation";
  }
}

function pruneJobs(jobs: OberonBackgroundJob[]): OberonBackgroundJob[] {
  const now = Date.now();
  return jobs.filter((job) => isOberonBackgroundJobActive(job) || now - job.updatedAtMs < DONE_KEEP_MS).slice(0, 12);
}

function readJobs(): OberonBackgroundJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OberonBackgroundJob[];
    return Array.isArray(parsed) ? parsed.filter(isJobLike) : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: OberonBackgroundJob[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    return;
  }
  emitChange();
}

function emitChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OBERON_JOBS_EVENT));
}

function jobKey(job: OberonBackgroundJob): string {
  return `${job.kind}:${job.id}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isJobLike(value: OberonBackgroundJob): boolean {
  return !!value && typeof value.id === "string" && typeof value.kind === "string" && typeof value.status === "string";
}
