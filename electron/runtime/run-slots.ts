// 전역 실행 슬롯 — 로컬 CLI LLM 자식 프로세스를 스폰하는 모든 경로(챗·firm·swarm·워크플로우·
// 자동화)가 공유하는 단일 예산. 이전에는 서브시스템별 캡만 있어 (챗 무제한) × (자동화 2 ×
// 그래프 동시성) × (firm/swarm 동시성)이 곱셈으로 쌓여 CPU/RAM 폭주를 막는 게이트가 없었다.
// 예산 = 사용자 슬라이더(getAgentConcurrency, 사양 기반 추천값). 초과분은 거절이 아니라
// FIFO 큐잉 — abort 시 큐에서 즉시 이탈한다. HTTP 런타임(BYOK/Ollama)은 로컬 CPU를 거의
// 안 쓰므로 게이트하지 않는다(selection.ts에서 CLI 러너만 래핑).
import { getAgentConcurrency } from "../store/concurrency";

let inUse = 0;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const queue: Waiter[] = [];

function abortError(): Error {
  const e = new Error("run slot acquisition aborted");
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
  while (inUse < getAgentConcurrency() && queue.length > 0) {
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
 * 실행 슬롯 획득. 즉시 가능하면 동기 해결, 아니면 FIFO 대기.
 * @param onQueued 대기열에 들어갈 때 1회 호출 — "대기 중" 상태 표시용.
 * @returns 해제 함수(멱등).
 */
export function acquireRunSlot(
  signal?: AbortSignal,
  onQueued?: (position: number) => void,
): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (inUse < getAgentConcurrency()) {
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
export function runSlotStats(): { inUse: number; queued: number; limit: number } {
  return { inUse, queued: queue.length, limit: getAgentConcurrency() };
}
