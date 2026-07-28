// 로컬 추론 실행 슬롯 — Ollama/LM Studio/MLX 전용, run-slots.ts(CLI 자식 프로세스)와는
// 별개의 예산이다. CLI 러너는 대부분 원격 API를 기다리며 로컬 자원을 거의 안 쓰지만,
// 로컬 추론은 요청 1건이 이미 코어 대부분/GPU·통합메모리 대역폭을 쓰므로 같은 예산에
// 섞으면 안 된다(getLocalInferenceConcurrency, concurrency.ts 참고).
import { getLocalInferenceConcurrency } from "../store/concurrency";

let inUse = 0;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const queue: Waiter[] = [];

function abortError(): Error {
  const e = new Error("local inference slot acquisition aborted");
  e.name = "AbortError";
  return e;
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inUse -= 1;
    pump();
  };
}

function pump(): void {
  while (inUse < getLocalInferenceConcurrency() && queue.length > 0) {
    const w = queue.shift()!;
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    if (w.signal?.aborted) {
      w.reject(abortError());
      continue;
    }
    inUse += 1;
    w.resolve(makeRelease());
  }
}

/**
 * 로컬 추론 슬롯 획득. 즉시 가능하면 동기 해결, 아니면 FIFO 대기.
 * @param onQueued 대기열에 들어갈 때 1회 호출 — "대기 중" 상태 표시용.
 * @returns 해제 함수(멱등).
 */
export function acquireLocalInferenceSlot(
  signal?: AbortSignal,
  onQueued?: (position: number) => void,
): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (inUse < getLocalInferenceConcurrency()) {
    inUse += 1;
    return Promise.resolve(makeRelease());
  }
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
      onQueued?.(queue.length);
    } catch {
      // 상태 콜백 실패는 무시
    }
  });
}

/** 진단/표시용 스냅샷. */
export function localInferenceSlotStats(): { inUse: number; queued: number; limit: number } {
  return { inUse, queued: queue.length, limit: getLocalInferenceConcurrency() };
}
