import { redactSecrets } from "@shared/secret-patterns";

export const ONE_OPERATIONAL_RECOVERY_EVENT = "agentlas:one-operational-recovery";

export type OneOperationalRecoveryDetail = {
  scope: string;
  evidence: string;
  /**
   * 실패가 일어난 대화. 복구는 "가장 최근 One 대화"가 아니라 **실패한 방**에서 이어져야
   * 사용자가 맥락을 잃지 않는다(PRD §4.6). 호출부 89곳을 고치는 대신, 실패 순간 화면이
   * 열고 있던 대화를 여기서 붙잡는다 — 그 방이 곧 실패한 방이다.
   */
  chatId?: string;
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
export function requestOneOperationalRecovery(scope: string, cause: unknown): void {
  if (typeof window === "undefined" || recoveryDispatchSuppressionDepth > 0) return;
  let rawEvidence: string;
  if (cause instanceof Error) {
    rawEvidence = [cause.name, cause.message, cause.stack].filter(Boolean).join("\n");
  } else if (cause && typeof cause === "object") {
    try { rawEvidence = JSON.stringify(cause); }
    catch { rawEvidence = Object.prototype.toString.call(cause); }
  } else {
    rawEvidence = String(cause ?? "");
  }
  const evidence = redactSecrets(rawEvidence, "[private value removed]")
    .replace(/\s+/g, " ")
    .trim();
  let chatId: string | undefined;
  try {
    const current = new URL(window.location.href).searchParams.get("chat");
    if (current && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(current)) chatId = current;
  } catch {
    // 주소를 못 읽는 것은 실패 사유가 아니다 — 대상 없이 진행한다.
  }
  window.dispatchEvent(new CustomEvent<OneOperationalRecoveryDetail>(
    ONE_OPERATIONAL_RECOVERY_EVENT,
    { detail: { scope: scope.slice(0, 120), evidence: evidence.slice(0, 4_000), ...(chatId ? { chatId } : {}) } },
  ));
}
