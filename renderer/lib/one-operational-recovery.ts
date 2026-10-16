import { redactSecrets } from "@shared/secret-patterns";
import { ipcErrorCode } from "@shared/ipc-error-code";
import { isTransientSendRefusal } from "@shared/transient-send-refusal";
import { innermostTypedCode, isTypedCode, type TurnDelivery } from "@shared/turn-settlement";

export const ONE_OPERATIONAL_RECOVERY_EVENT = "agentlas:one-operational-recovery";

/**
 * What a recovery turn may know about a failure: machine facts only (docs 31 W1, audit A7 M19). The error's message and
 * stack never reach the model: 10 recovery turns built from that prose finished 0 of 3 owner requests (2026-10-11..16).
 */
export type OneOperationalRecoveryFacts = {
  /** The failure's machine code (IPC code marker, own code or innermost cause code); "uncoded" when it has none. */
  code: string;
  /** Where it failed: the product call site's scope. */
  stage: string;
  /** Whether the failed turn reached a runtime (RuntimeTurnDelivery), when the failure carries it. */
  turnDelivery?: TurnDelivery;
  /** The machine code of a failed recovery attempt itself, from its receipt. */
  attemptFailureCode?: string;
};

export type OneOperationalRecoveryDetail = {
  scope: string;
  /** The serialized typed facts (OneOperationalRecoveryFacts), never error prose. */
  evidence: string;
  facts: OneOperationalRecoveryFacts;
  /**
   * 실패가 일어난 대화. 복구는 "가장 최근 One 대화"가 아니라 **실패한 방**에서 이어져야
   * 사용자가 맥락을 잃지 않는다(PRD §4.6). 호출부 89곳을 고치는 대신, 실패 순간 화면이
   * 열고 있던 대화를 여기서 붙잡는다 — 그 방이 곧 실패한 방이다.
   */
  chatId?: string;
  /** Task-route failures retain their durable origin instead of guessing a chat. */
  taskId?: string;
  userMessage?: string;
};

let recoveryDispatchSuppressionDepth = 0;

/**
 * Recovery uses the same IPC bridge as ordinary product work. Suppress event
 * emission while that controller turn is being accepted or receipt-checked,
 * otherwise a temporarily unavailable controller would recursively create a
 * second recovery incident for its own transport failure.
 */
export async function withOneOperationalRecoveryDispatchSuppressed<T>(
  operation: () => Promise<T>,
): Promise<T> {
  recoveryDispatchSuppressionDepth += 1;
  try {
    return await operation();
  } finally {
    recoveryDispatchSuppressionDepth = Math.max(0, recoveryDispatchSuppressionDepth - 1);
  }
}

/** Send private operational evidence to the mounted One controller. */
export function requestOneOperationalRecovery(
  scope: string,
  cause: unknown,
  options?: { userMessage?: string; chatId?: string },
): void {
  if (typeof window === "undefined" || recoveryDispatchSuppressionDepth > 0) return;
  // A transient refusal (the chat or the app-service channel is not ready yet) is Main's to retry; no recovery turn.
  if (isTransientSendRefusal(cause)) return;
  const facts = oneOperationalRecoveryFacts(scope, cause);
  const rawEvidence = JSON.stringify(facts);
  const evidence = redactSecrets(rawEvidence, "[private value removed]");
  let chatId = options?.chatId;
  let taskId: string | undefined;
  try {
    if (!chatId) {
      const params = new URL(window.location.href).searchParams;
      const current = params.get("chat");
      if (current && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(current)) chatId = current;
      const task = params.get("task");
      if (!chatId && task && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(task)) taskId = task;
    }
  } catch {
    // 주소를 못 읽는 것은 실패 사유가 아니다 — 대상 없이 진행한다.
  }
  window.dispatchEvent(new CustomEvent<OneOperationalRecoveryDetail>(
    ONE_OPERATIONAL_RECOVERY_EVENT,
    {
      detail: {
        scope: scope.slice(0, 120),
        evidence: evidence.slice(0, 4_000),
        facts,
        ...(chatId && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(chatId) ? { chatId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(options?.userMessage?.trim() ? { userMessage: options.userMessage.trim().slice(0, 500) } : {}),
      },
    },
  ));
}

/** Read a data property only (no getter runs). */
function dataField(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, name);
    return property && Object.hasOwn(property, "value") ? property.value : undefined;
  } catch { return undefined; }
}

/** Typed facts of a failure for operational recovery: codes and delivery only, no message, stack or provider text. */
export function oneOperationalRecoveryFacts(scope: string, cause: unknown): OneOperationalRecoveryFacts {
  // The innermost code of a same-process cause chain; across IPC only the marker Main encoded survives.
  const code = innermostTypedCode(cause) ?? ipcErrorCode(cause);
  const delivery = dataField(cause, "turnDelivery");
  return {
    code: isTypedCode(code) ? code : "uncoded",
    stage: scope.slice(0, 120),
    ...(delivery === "not-dispatched" || delivery === "not-accepted" || delivery === "accepted" ? { turnDelivery: delivery } : {}),
  };
}
