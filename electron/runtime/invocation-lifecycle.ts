import { assertInvocationChatAvailable } from "./run-id";
import { isOwnerGoalStopCause } from "../../shared/invocation-host-stop";

/**
 * Production invocation state boundary.
 *
 * renderer busy/cancelPending  = a projection only (never execution authority)
 * this registry               = live main/host-process authority
 * run_events                  = durable receipt/retry authority
 * chat_runtime_sessions       = provider resume context only
 * invocation receipt folder  = result-discovery authority
 *
 * A cancelled run intentionally stays registered until its runtime promise
 * settles. Removing it when AbortController.abort() is called would let a
 * retry start while the old CLI/MCP process tree is still shutting down.
 */
/**
 * 사용자가 멈췄다는 사실 자체를 사유로 쓴다. 로케일별 문장은 화면 층에서 고르되,
 * 표식이 되도록 기계가 알아볼 수 있는 형태를 유지한다.
 */
export const STOPPED_BY_USER = "stopped_by_user";

export type MainOwnedTerminalDisposition = {
  errorCode: "cancelled" | "interrupted" | null;
  terminalKind: "invoke_completed" | "invoke_cancelled" | "invoke_interrupted" | "invoke_failed";
};

/**
 * Classify a terminal from Main-owned lifecycle facts only. Runtime/provider
 * prose is deliberately absent from this contract: the same text can describe
 * a user stop, steering, or an ordinary runner failure.
 */
export function classifyMainOwnedTerminal(input: {
  eventKind: "final" | "error";
  steeringInterruptRequested: boolean;
  signalAborted: boolean;
  abortReason: unknown;
}): MainOwnedTerminalDisposition {
  if (input.eventKind === "final") {
    return { errorCode: null, terminalKind: "invoke_completed" };
  }
  if (input.steeringInterruptRequested) {
    return { errorCode: "interrupted", terminalKind: "invoke_interrupted" };
  }
  if (
    input.signalAborted
    && input.abortReason instanceof Error
    && (input.abortReason.message === STOPPED_BY_USER
      // 오너가 목표를 멈추거나 지워서 끊은 턴도 사람의 중지다 — 실패로 적으면 붉은 "실패" 줄이
      // 서고 One 자동 복구가 그 일을 다시 돌린다(설치본 2026-09-26, 삭제 1.4초 뒤 재실행).
      || isOwnerGoalStopCause(input.abortReason.message))
  ) {
    return { errorCode: "cancelled", terminalKind: "invoke_cancelled" };
  }
  return { errorCode: null, terminalKind: "invoke_failed" };
}

export interface InvocationLifecycleRecord {
  controller: AbortController;
  chatId: string;
  cancelRequestedAt: string | null;
}

export type InvocationCancelResult = "requested" | "already-requested" | "not-found";

export class InvocationLifecycleRegistry<T extends InvocationLifecycleRecord> {
  private readonly active = new Map<string, T>();
  private readonly settled = new Set<string>();
  private readonly maxSettledIds: number;

  constructor(maxSettledIds = 2_000) {
    this.maxSettledIds = Math.max(16, maxSettledIds);
  }

  has(runId: string): boolean {
    return this.active.has(runId);
  }

  hasSeen(runId: string): boolean {
    return this.active.has(runId) || this.settled.has(runId);
  }

  get(runId: string): T | undefined {
    return this.active.get(runId);
  }

  values(): IterableIterator<T> {
    return this.active.values();
  }

  entries(): IterableIterator<[string, T]> {
    return this.active.entries();
  }

  register(runId: string, record: T): void {
    if (this.hasSeen(runId)) throw new Error("Invocation runId has already been used");
    /*
     * ★"죽은 자리를 회수한다"를 넣었다가 되돌렸다 (2026-09-07).
     *
     * 오너 기기 로그에서 `This chat already has an active invocation` 이 3초 안에 세 번
     * 찍혔고 사용자는 "왜안되냐고" 를 쳤다. 그래서 중지 신호가 떨어진 자리를 다음 전송에서
     * 회수하게 만들었는데, scripts/test-invocation-lifecycle.cjs 가 **정확히 반대 계약**을
     * 지키고 있었다: 취소를 요청해도 **호스트 자식 프로세스가 아직 살아 있으므로**
     * 그것이 실제로 정산될 때까지 재시도를 막아야 한다(그 게이트는 진짜 자식과 손자
     * 프로세스를 띄워 생존을 확인한다). 자리를 일찍 놓으면 같은 대화에 CLI 자식이 둘 뜬다.
     *
     * 즉 이 잠금 자체는 옳다. 진짜 문제는 **정산에 도달하지 못하는 경로**이고, 그것은
     * 여기서 시간이나 신호로 짐작해 풀 수 없다(취소 시각은 호출자가 넘기는 값이라
     * 경과 시간으로도 못 가른다 — 게이트가 과거 시각을 넘긴다).
     * 그래서 여기서는 잠그되, 아래 assertInvocationChatAvailable 이 **푸는 길을 말한다.**
     */
    assertInvocationChatAvailable(record.chatId, this.active.values());
    this.active.set(runId, record);
  }

  /**
   * Undo only a pre-host registration whose durable start write failed.
   * Unlike settle(), this deliberately does not consume the run id because no
   * host work was allowed to start and no durable idempotency receipt exists.
   */
  rollbackRegistration(runId: string): boolean {
    return this.active.delete(runId);
  }

  requestCancel(runId: string, at = new Date().toISOString()): InvocationCancelResult {
    return this.requestCancelWithReason(runId, new Error(STOPPED_BY_USER), at);
  }

  requestCancelWithReason(
    runId: string,
    reason: Error,
    at = new Date().toISOString(),
  ): InvocationCancelResult {
    const record = this.active.get(runId);
    if (!record) return "not-found";
    if (record.cancelRequestedAt || record.controller.signal.aborted) return "already-requested";
    record.cancelRequestedAt = at;
    /*
     * ★왜 멈췄는지 사유를 함께 넘긴다.
     *
     * 인자 없이 abort() 하면 신호에는 DOM 기본 사유("This operation was aborted")만
     * 남고, 그 문장이 그대로 화면까지 갔다 — 영어 기계 문구인 데다 실패처럼 보인다.
     * 사용자가 누른 중지는 실패가 아니고, 그 사실은 지어낼 필요 없이 여기서 이미 안다.
     * 러너들은 abortReasonError() 로 signal.reason 을 먼저 읽으므로 이 문장이 쓰인다.
     */
    record.controller.abort(reason);
    return "requested";
  }

  /** Call only after the runtime promise/terminal event proves host settlement. */
  settle(runId: string): boolean {
    const deleted = this.active.delete(runId);
    if (!deleted) return false;
    this.settled.add(runId);
    if (this.settled.size > this.maxSettledIds) {
      const oldest = this.settled.values().next().value as string | undefined;
      if (oldest) this.settled.delete(oldest);
    }
    return true;
  }

  activeChatIds(): string[] {
    return [...new Set([...this.active.values()].map((record) => record.chatId))];
  }
}

/**
 * Atomic start boundary for the main process: a run is not publishable and its
 * host adapter must not be called until the durable idempotency row succeeds.
 */
export function registerDurableInvocationStart<T extends InvocationLifecycleRecord>(input: {
  registry: InvocationLifecycleRegistry<T>;
  runId: string;
  record: T;
  persistStart: () => void;
  publishActiveState: () => void;
}): void {
  input.registry.register(input.runId, input.record);
  try {
    input.persistStart();
  } catch (error) {
    input.registry.rollbackRegistration(input.runId);
    input.publishActiveState();
    throw error;
  }
  input.publishActiveState();
}
