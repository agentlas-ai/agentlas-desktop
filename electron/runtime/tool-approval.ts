/**
 * 도구 승인 계약 — 런타임이 제각각 말하는 "승인"을 한 모양으로 모은다.
 *
 * 전수 조사(2026-08-15)에서 나온 사실은 승인이 **두 종류**라는 것이다. 이 구분을
 * 지우고 하나로 만들면 "허용을 눌렀는데 아무 일도 일어나지 않는" UI가 나온다.
 *
 *  - live: 런타임이 **실행 전에** 물어보고 답을 기다린다. 사용자의 선택이 그대로
 *    이번 호출의 결과가 된다. (acp `session/request_permission`, 그리고 우리 코드가
 *    도구를 직접 도는 local-tool-loop 계열)
 *
 *  - post-denial: 헤드리스라 물어볼 상대가 없어 런타임이 **이미 거부하고 지나갔다.**
 *    이번 호출은 되돌릴 수 없다. 사용자가 할 수 있는 건 다음 실행을 위해 허용 범위를
 *    넓히는 것뿐이다. (claude-code tool_result, antigravity tool 스텝 ERROR)
 *
 * 그리고 둘 다 공통으로 겪는 문제가 있다: 런타임이 그 거부를 **"사용자가 거절했다"**로
 * 기록한다(agy `User denied permission for …`, claude `user-rejected`). 사용자는 손도
 * 대지 않았다. 그래서 이 계약은 `deniedBy`를 명시적으로 들고 다닌다 — 화면이든 원장이든
 * 사람이 거절한 것과 런타임이 자동 거부한 것을 절대 같은 말로 적지 않게 하기 위해서다.
 */

import type { ToolApprovalRequestEvent, ToolApprovalDecision } from "../../shared/types";

/** 승인 요청 하나 — 화면과 같은 정의를 쓴다(shared/types.ts). */
export type ToolApprovalRequest = ToolApprovalRequestEvent;

export type { ToolApprovalDecision };

export interface ToolApprovalOutcome {
  decision: ToolApprovalDecision;
  decidedAt: string;
}

type Pending = {
  request: ToolApprovalRequest;
  resolve: (outcome: ToolApprovalOutcome) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();
const sessionGrants = new Map<string, Set<string>>();
const listeners = new Set<(request: ToolApprovalRequest) => void>();
const resolvedListeners = new Set<(id: string, outcome: ToolApprovalOutcome) => void>();

/** 같은 도구·대상을 한 세션에서 다시 묻지 않기 위한 키. */
function grantKey(request: Pick<ToolApprovalRequest, "tool" | "detail">): string {
  return request.detail ? `${request.tool}::${request.detail}` : request.tool;
}

export function onToolApprovalRequested(fn: (request: ToolApprovalRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onToolApprovalResolved(fn: (id: string, outcome: ToolApprovalOutcome) => void): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}

export function listPendingToolApprovals(): ToolApprovalRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}

/** 세션 단위 허용이 이미 있는가. live 요청은 이걸 먼저 본다. */
export function hasSessionGrant(sessionKey: string, request: Pick<ToolApprovalRequest, "tool" | "detail">): boolean {
  return sessionGrants.get(sessionKey)?.has(grantKey(request)) === true;
}

function rememberSessionGrant(sessionKey: string, request: ToolApprovalRequest): void {
  const set = sessionGrants.get(sessionKey) ?? new Set<string>();
  set.add(grantKey(request));
  sessionGrants.set(sessionKey, set);
}

export function clearSessionGrants(sessionKey: string): void {
  sessionGrants.delete(sessionKey);
}

/**
 * live 승인 요청 — 사용자의 답을 실제로 기다린다.
 *
 * 아무도 답하지 않으면 `deny`로 닫는다. **열어둔 채 실행을 매달아 두지 않는다** —
 * 이 제품에서 "끝나지 않는 실행"은 이미 한 번 비싼 대가를 치른 실패 모양이다.
 */
export function requestToolApproval(
  input: Omit<ToolApprovalRequest, "id" | "requestedAt" | "mode"> & { sessionKey: string; timeoutMs?: number },
): Promise<ToolApprovalOutcome> {
  const { sessionKey, timeoutMs = 5 * 60_000, ...rest } = input;
  if (hasSessionGrant(sessionKey, rest)) {
    return Promise.resolve({ decision: "allow_session", decidedAt: new Date().toISOString() });
  }
  const request: ToolApprovalRequest = {
    ...rest,
    id: `approval:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    mode: "live",
    requestedAt: new Date().toISOString(),
  };
  return new Promise<ToolApprovalOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      const outcome: ToolApprovalOutcome = { decision: "deny", decidedAt: new Date().toISOString() };
      for (const fn of resolvedListeners) { try { fn(request.id, outcome); } catch { /* 화면 하나가 실행을 깨지 못한다 */ } }
      resolve(outcome);
    }, timeoutMs);
    timer.unref?.();
    pending.set(request.id, {
      request,
      timer,
      resolve: (outcome) => {
        if (outcome.decision === "allow_session") rememberSessionGrant(sessionKey, request);
        resolve(outcome);
      },
    });
    for (const fn of listeners) { try { fn(request); } catch { /* 같은 이유 */ } }
  });
}

/**
 * post-denial 고지 — 이미 거부된 호출을 사용자에게 보이게만 한다.
 * 답을 기다리지 않는다(기다릴 대상이 없다). 선택은 다음 실행의 허용 범위에만 쓰인다.
 */
export function announceToolDenied(
  input: Omit<ToolApprovalRequest, "id" | "requestedAt" | "mode">,
): ToolApprovalRequest {
  const request: ToolApprovalRequest = {
    ...input,
    id: `denied:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    mode: "post-denial",
    requestedAt: new Date().toISOString(),
  };
  for (const fn of listeners) { try { fn(request); } catch { /* 같은 이유 */ } }
  return request;
}

/** 사용자의 선택을 반영한다. live 요청만 대기 중인 실행을 푼다. */
export function resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean {
  const entry = pending.get(id);
  const outcome: ToolApprovalOutcome = { decision, decidedAt: new Date().toISOString() };
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(outcome);
  }
  for (const fn of resolvedListeners) { try { fn(id, outcome); } catch { /* 같은 이유 */ } }
  return Boolean(entry);
}
