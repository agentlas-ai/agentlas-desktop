// 로컬 추론 실행 슬롯 — Ollama/LM Studio/MLX 전용, run-slots.ts(CLI 자식 프로세스)와는
// 별개의 예산이다. CLI 러너는 대부분 원격 API를 기다리며 로컬 자원을 거의 안 쓰지만,
// 로컬 추론은 요청 1건이 이미 코어 대부분/GPU·통합메모리 대역폭을 쓰므로 같은 예산에
// 섞으면 안 된다(getLocalInferenceConcurrency, concurrency.ts 참고).
import { getLocalInferenceConcurrency } from "../store/concurrency";
import { currentRunPriority, type RunPriority } from "./run-priority";

let inUse = 0;
let ownerInUse = 0;
/** Same owner lane as run-slots.ts (native-harness notyet NH20): one local request above the limit for the owner's message. */
const OWNER_RESERVED_SLOTS = 1;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const ownerQueue: Waiter[] = [];
const interactiveQueue: Waiter[] = [];
const backgroundQueue: Waiter[] = [];
const queueFor = (priority: RunPriority): Waiter[] => priority === "owner" ? ownerQueue : priority === "background" ? backgroundQueue : interactiveQueue;
const queuedCount = (): number => ownerQueue.length + interactiveQueue.length + backgroundQueue.length;

function concurrencyLimit(): number {
  try {
    return getLocalInferenceConcurrency();
  } catch {
    // Recovery judgments can run while SQLite is unavailable. They still
    // share this process's FIFO queue; an unreadable setting permits only one.
    return 1;
  }
}

function abortError(): Error {
  const e = new Error("local inference slot acquisition aborted");
  e.name = "AbortError";
  return e;
}

function canAdmit(priority: RunPriority): boolean {
  const limit = concurrencyLimit();
  if (inUse < limit) return true;
  return priority === "owner" && inUse - ownerInUse > 0 && inUse < limit + OWNER_RESERVED_SLOTS;
}

function admit(priority: RunPriority): () => void {
  inUse += 1;
  if (priority === "owner") ownerInUse += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inUse -= 1;
    if (priority === "owner") ownerInUse -= 1;
    pump();
  };
}

function pump(): void {
  for (;;) {
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
 * 로컬 추론 슬롯 획득. 즉시 가능하면 동기 해결, 아니면 우선순위별 FIFO 대기(owner > interactive > background).
 * @param onQueued 대기열에 들어갈 때 1회 호출 — "대기 중" 상태 표시용.
 * @returns 해제 함수(멱등).
 */
export function acquireLocalInferenceSlot(
  signal?: AbortSignal,
  onQueued?: (position: number) => void,
  priority?: RunPriority,
): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  const effectivePriority = priority ?? currentRunPriority();
  const ahead = effectivePriority === "owner" ? ownerQueue.length
    : effectivePriority === "interactive" ? ownerQueue.length + interactiveQueue.length : queuedCount();
  if (ahead === 0 && canAdmit(effectivePriority)) return Promise.resolve(admit(effectivePriority));
  const queue = queueFor(effectivePriority);
  return new Promise<() => void>((resolve, reject) => {
    const w: Waiter = { resolve, reject, signal };
    if (signal) {
      w.onAbort = () => {
        const i = queue.indexOf(w);
        if (i >= 0) queue.splice(i, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", w.onAbort, { once: true });
    }
    queue.push(w);
    try {
      onQueued?.(queuedCount());
    } catch {
      // 상태 콜백 실패는 무시
    }
  });
}

/** 진단/표시용 스냅샷. */
export function localInferenceSlotStats(): { inUse: number; queued: number; limit: number } {
  return { inUse, queued: queuedCount(), limit: concurrencyLimit() };
}
