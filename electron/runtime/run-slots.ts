// 전역 실행 슬롯 — 로컬 CLI LLM 자식 프로세스를 스폰하는 모든 경로(챗·firm·swarm·워크플로우·
// 자동화)가 공유하는 단일 예산. 이전에는 서브시스템별 캡만 있어 (챗 무제한) × (자동화 2 ×
// 그래프 동시성) × (firm/swarm 동시성)이 곱셈으로 쌓여 CPU/RAM 폭주를 막는 게이트가 없었다.
// 예산 = 사용자 슬라이더(getAgentConcurrency, 사양 기반 추천값). 초과분은 거절이 아니라
// FIFO 큐잉 — abort 시 큐에서 즉시 이탈한다. 진짜 원격 API인 BYOK는 로컬 자원을 거의 안
// 쓰므로 이 예산에 안 걸린다. 로컬 추론(Ollama/LM Studio/MLX)은 HTTP로 호출하지만 로컬
// CPU/GPU를 쓰므로 이 풀이 아니라 local-inference-run-slots.ts의 별도 예산으로 게이트한다
// (selection.ts의 withRunSlot/withLocalInferenceSlot 참고).
import { getAgentConcurrency } from "../store/concurrency";
import { currentRunPriority, type RunPriority } from "./run-priority";

let inUse = 0;
let maintenance = false;

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
 */
const interactiveQueue: Waiter[] = [];
const backgroundQueue: Waiter[] = [];

function queueFor(priority: RunPriority): Waiter[] {
  return priority === "background" ? backgroundQueue : interactiveQueue;
}

function queuedCount(): number {
  return interactiveQueue.length + backgroundQueue.length;
}

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
  // CLI 파일을 교체하는 동안에는 새 자식 프로세스를 절대 스폰하지 않는다. 업데이트가
  // 끝나면 release가 pump를 다시 호출해 기존 FIFO 순서 그대로 이어간다.
  if (maintenance) return;
  while (inUse < getAgentConcurrency() && queuedCount() > 0) {
    // interactive 대기열을 먼저 비운다 — 사람이 기다리는 턴이 자동화보다 앞선다.
    const w = interactiveQueue.length > 0 ? interactiveQueue.shift()! : backgroundQueue.shift()!;
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
  if (!maintenance && inUse < getAgentConcurrency()) {
    inUse += 1;
    return Promise.resolve(makeRelease());
  }
  const effectivePriority = priority ?? currentRunPriority();
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
  };
}

/** 진단/표시용 스냅샷. queued 는 두 대기열 합계(기존 소비자 계약 유지). */
export function runSlotStats(): { inUse: number; queued: number; limit: number; maintenance: boolean } {
  return { inUse, queued: queuedCount(), limit: getAgentConcurrency(), maintenance };
}

/** 우선순위별 대기 인원 — 새 진단 표면(기존 runSlotStats 모양은 건드리지 않는다). */
export function runSlotQueueBreakdown(): { interactive: number; background: number } {
  return { interactive: interactiveQueue.length, background: backgroundQueue.length };
}
