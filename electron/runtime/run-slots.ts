// 전역 실행 슬롯 — 로컬 CLI LLM 자식 프로세스를 스폰하는 모든 경로(챗·firm·swarm·워크플로우·
// 자동화)가 공유하는 단일 예산. 이전에는 서브시스템별 캡만 있어 (챗 무제한) × (자동화 2 ×
// 그래프 동시성) × (firm/swarm 동시성)이 곱셈으로 쌓여 CPU/RAM 폭주를 막는 게이트가 없었다.
// 예산 = 사용자 슬라이더(getAgentConcurrency, 사양 기반 추천값). 초과분은 거절이 아니라
// FIFO 큐잉 — abort 시 큐에서 즉시 이탈한다. 진짜 원격 API인 BYOK는 로컬 자원을 거의 안
// 쓰므로 이 예산에 안 걸린다. 로컬 추론(Ollama/LM Studio/MLX)은 HTTP로 호출하지만 로컬
// CPU/GPU를 쓰므로 이 풀이 아니라 local-inference-run-slots.ts의 별도 예산으로 게이트한다
// (selection.ts의 withRunSlot/withLocalInferenceSlot 참고).
import { getAgentConcurrency } from "../store/concurrency";
import { currentRunPriority, memberQueueReporter, type RunPriority } from "./run-priority";
import { createLendBudget } from "./run-slot-lease";

let inUse = 0;
/** Slots held by owner runs (part of inUse). */
let ownerInUse = 0;
let maintenance = false;
/**
 * Slots an owner run may take above the limit while other work holds slots (native-harness notyet NH20): the owner's message
 * starts now instead of waiting for automation, a Goal pass or a teammate to finish. Bounded: at most one extra child.
 */
export const OWNER_RESERVED_SLOTS = 1;
/** How many turns may have let their slot go while a person decides (run-slot-lease.ts): at most the limit, so live CLIs <= 2 x limit. */
export const runSlotLendBudget = createLendBudget(() => concurrencyLimit());
/** Last moment a run held or released a slot (process start counts as activity). */
let lastSlotActivityAt = Date.now();
/**
 * Runs in progress that hold no slot of this pool (N8): an API run (BYOK, Agentlas serving) and a local-inference run (its own pool).
 * They are "the app is working" for the busy signal and the quiet clock, but they never wait for or take a slot here, so an owner's
 * API turn starts exactly as before.
 */
let activityRuns = 0;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/*
 * ★2단 우선순위 큐 — interactive(사람이 기다리는 채팅 턴) > background(자동화·그래프·스웜).
 *
 * FIFO 하나였을 때는 자동화가 슬롯을 선점하면 방금 온 채팅 턴이 그 **뒤에** 줄을 섰다 —
 * 사람에게는 "앱이 멈췄다"로 보인다. 이제 background 대기자는 interactive 대기열이 빌
 * 때만 승계한다. 각 대기열 안에서는 기존 FIFO 그대로다(기아 방지: background 도
 * interactive 가 없으면 즉시 승계하므로 무기한 배제는 없다 — 사람이 계속 누르는 동안
 * 밀리는 것이 정확히 의도다).
 *
 * 그 위에 owner 단(NH20): 오너가 보낸 메시지의 실행은 맨 앞에 서고, 다른 작업이 슬롯을 다 쥐고 있으면
 * 예약 슬롯 하나(OWNER_RESERVED_SLOTS)로 바로 시작한다 — 순서만 앞서고 슬롯이 빌 때까지 기다리던 것이
 * "재개를 눌러야 돈다"로 보였다.
 */
const ownerQueue: Waiter[] = [];
const interactiveQueue: Waiter[] = [];
const backgroundQueue: Waiter[] = [];

function queueFor(priority: RunPriority): Waiter[] {
  return priority === "owner" ? ownerQueue : priority === "background" ? backgroundQueue : interactiveQueue;
}

function queuedCount(): number {
  return ownerQueue.length + interactiveQueue.length + backgroundQueue.length;
}

/** Owner: any free slot, or the reserved one while other work holds slots. Others: a free slot only. */
let concurrencySettingUnavailable = false;
/** The configured CLI minimum is one; a failed settings read may reduce capacity, never increase it. */
function concurrencyLimit(): number {
  try {
    const limit = getAgentConcurrency();
    if (concurrencySettingUnavailable) try { console.info("[run-slots]", JSON.stringify({ code: "runtime_concurrency_setting_restored" })); } catch { /* Diagnostics cannot refuse admission. */ }
    concurrencySettingUnavailable = false;
    return limit;
  } catch (error) {
    if (!concurrencySettingUnavailable) {
      let causeCode = "unknown";
      try {
        const rawCode = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
        if (typeof rawCode === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(rawCode)) causeCode = rawCode;
      } catch { /* An unreadable diagnostic supplies no cause code. */ }
      try { console.warn("[run-slots]", JSON.stringify({ code: "runtime_concurrency_setting_unavailable", causeCode, fallbackLimit: 1 })); } catch { /* Diagnostics cannot refuse admission. */ }
    }
    concurrencySettingUnavailable = true;
    return 1;
  }
}

function canAdmit(priority: RunPriority): boolean {
  if (maintenance) return false;
  const limit = concurrencyLimit();
  if (inUse < limit) return true;
  return priority === "owner" && inUse - ownerInUse > 0 && inUse < limit + OWNER_RESERVED_SLOTS;
}

function abortError(): Error {
  const e = new Error("run slot acquisition aborted");
  e.name = "AbortError";
  return e;
}

const busyListeners = new Set<(busy: boolean) => void>();
/**
 * Tells a listener when this process goes from no run to one, and from its last run to none. Every run takes a slot,
 * also one that never keeps a resident CLI (an API-only run), so this is the process's "is anything running" signal.
 * Returns the function that removes the listener.
 */
export function onRunSlotsBusyChange(listener: (busy: boolean) => void): () => void {
  busyListeners.add(listener);
  return () => { busyListeners.delete(listener); };
}
let busyAnnounced = false;
/** Announces a change only: a release that hands its slot straight to a queued run stays "busy" and says nothing. */
function syncBusy(): void {
  const busy = inUse > 0 || activityRuns > 0;
  if (busy === busyAnnounced) return;
  busyAnnounced = busy;
  for (const listener of [...busyListeners]) { try { listener(busy); } catch { /* a listener must not break admission */ } }
}

/**
 * Marks one run that holds no slot of this pool as working until the returned function is called (idempotent). Starting costs one
 * counter and a listener call only when the process goes from idle to working; it never waits.
 */
export function beginRunActivity(): () => void {
  activityRuns += 1;
  lastSlotActivityAt = Date.now();
  syncBusy();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activityRuns -= 1;
    lastSlotActivityAt = Date.now();
    syncBusy();
    notifyBackgroundStart();
  };
}

function admit(priority: RunPriority): () => void {
  inUse += 1;
  if (priority === "owner") ownerInUse += 1;
  lastSlotActivityAt = Date.now();
  syncBusy();
  return makeRelease(priority);
}

function makeRelease(priority: RunPriority): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inUse -= 1;
    if (priority === "owner") ownerInUse -= 1;
    lastSlotActivityAt = Date.now();
    pump();
    // After pump: a waiter that took the freed slot keeps the process busy, so no "idle" is announced in between.
    syncBusy();
    notifyBackgroundStart();
  };
}

function pump(): void {
  // CLI 파일을 교체하는 동안에는 새 자식 프로세스를 절대 스폰하지 않는다. 업데이트가
  // 끝나면 release가 pump를 다시 호출해 기존 FIFO 순서 그대로 이어간다.
  if (maintenance) return;
  for (;;) {
    // owner first, then interactive (a person waiting) ahead of automation.
    const priority: RunPriority | null = ownerQueue.length > 0 && canAdmit("owner") ? "owner"
      : interactiveQueue.length > 0 && canAdmit("interactive") ? "interactive"
        : backgroundQueue.length > 0 && interactiveQueue.length === 0 && canAdmit("background") ? "background" : null;
    if (!priority) return;
    const w = queueFor(priority).shift()!;
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    if (w.signal?.aborted) {
      w.reject(abortError());
      continue;
    }
    w.resolve(admit(priority));
  }
}

/**
 * 실행 슬롯 획득. 즉시 가능하면 동기 해결, 아니면 우선순위별 FIFO 대기.
 * @param onQueued 대기열에 들어갈 때 1회 호출 — "대기 중" 상태 표시용.
 * @param priority 미지정이면 호출 문맥(withRunPriority)에서 읽고, 그마저 없으면 interactive.
 * @returns 해제 함수(멱등).
 */
export function acquireRunSlot(
  signal?: AbortSignal,
  onQueued?: (position: number) => void,
  priority?: RunPriority,
): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  const effectivePriority = priority ?? currentRunPriority();
  // A free slot is taken at once unless someone ahead in priority is already waiting for it.
  const ahead = effectivePriority === "owner" ? ownerQueue.length
    : effectivePriority === "interactive" ? ownerQueue.length + interactiveQueue.length : queuedCount();
  if (ahead === 0 && canAdmit(effectivePriority)) return Promise.resolve(admit(effectivePriority));
  const queue = queueFor(effectivePriority);
  // A member turn of a lead room says "waiting" / "let in" through its own scope, so its time limit does not run while it waits
  // (the tool-need judgement's slot wait included - its status line is dropped, this is not).
  const memberQueue = memberQueueReporter?.() ?? null;
  return new Promise<() => void>((resolve, reject) => {
    const w: Waiter = { resolve: memberQueue ? (release) => { memberQueue(false); resolve(release); } : resolve, reject, signal };
    if (signal) {
      w.onAbort = () => {
        const i = queue.indexOf(w);
        if (i >= 0) queue.splice(i, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", w.onAbort, { once: true });
    }
    queue.push(w);
    memberQueue?.(true);
    try {
      // 위치는 전체 대기 인원 기준 — 사용자에게 "몇 번째"인지의 근사치면 충분하다.
      onQueued?.(queuedCount());
    } catch {
      // 상태 콜백 실패는 무시
    }
  });
}

/**
 * CLI 설치 파일을 원자적으로 교체하기 위한 짧은 유지보수 잠금.
 * 실행 중이거나 이미 기다리는 작업이 하나라도 있으면 선점하지 않고 즉시 null을 반환한다.
 * 따라서 자동 업데이트가 채팅·자동화·Workforce의 세션을 끊거나 새 작업보다 앞질러 가지 않는다.
 */
export function tryAcquireRuntimeMaintenance(): (() => void) | null {
  if (maintenance || inUse > 0 || queuedCount() > 0) return null;
  maintenance = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    maintenance = false;
    pump();
    notifyBackgroundStart();
  };
}

/** 진단/표시용 스냅샷. queued 는 두 대기열 합계(기존 소비자 계약 유지). */
/**
 * How long no run has held a slot — "this app is quiet", independent of system HID idle. Measured
 * 2026-09-27: Codex Computer Use and a remote-desktop tool assert UserIsActive on this machine
 * (pmset log: 217 SkyComputerUseService + 259 remoting tickles in 7 days), so system idle stops
 * meaning "the owner is away" and idle-gated maintenance starved. 0 while any run holds or awaits one.
 */
export function runSlotsQuietForMs(now = Date.now()): number {
  if (inUse > 0 || activityRuns > 0 || queuedCount() > 0) return 0;
  return Math.max(0, now - lastSlotActivityAt);
}

export function runSlotStats(): { inUse: number; queued: number; limit: number; maintenance: boolean } {
  return { inUse, queued: queuedCount(), limit: concurrencyLimit(), maintenance };
}

/** 우선순위별 대기 인원 — 새 진단 표면(기존 runSlotStats 모양은 건드리지 않는다). */
export function runSlotQueueBreakdown(): { interactive: number; background: number } {
  return { interactive: interactiveQueue.length, background: backgroundQueue.length };
}

/** The owner lane (NH20): owner messages waiting and owner runs holding a slot (the latter may exceed the limit by one). */
export function runSlotOwnerLane(): { queued: number; inUse: number } {
  return { queued: ownerQueue.length, inUse: ownerInUse };
}

/** True when a background run would start at once: a free slot, nobody waiting, no CLI update in progress. */
export function backgroundRunCouldStartNow(): boolean {
  return !maintenance && queuedCount() === 0 && inUse < concurrencyLimit();
}

const backgroundStartListeners = new Set<() => void>();

/**
 * Calls `listener` once, at the next slot release (or end of a CLI update) after which a background run could start at
 * once. For unattended work that must claim nothing while it would only wait in the queue: the memory curator's job lease
 * and model deadline both run from the claim, so a wait was recorded as a model failure. A signal, not a timer: nothing
 * polls while the slots are taken. Registering the same function again is still one registration.
 */
export function onceBackgroundRunCouldStart(listener: () => void): void {
  backgroundStartListeners.add(listener);
}

function notifyBackgroundStart(): void {
  if (backgroundStartListeners.size === 0 || !backgroundRunCouldStartNow()) return;
  const listeners = [...backgroundStartListeners];
  backgroundStartListeners.clear();
  for (const listener of listeners) {
    try { listener(); } catch { /* A listener cannot block a slot release. */ }
  }
}
