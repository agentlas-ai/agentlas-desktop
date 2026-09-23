/**
 * 효과 관찰 실행 표(Main 전용) — effect-observation.ts 가 발행하고, 실행기(InvocationService)와
 * MCP 클라이언트가 "이 실행은 목표 주기가 아니라 읽기 전용 관찰이다"를 판정할 때 읽는다.
 * 요청 본문(IPC)으로는 만들 수 없다. 순환 import 를 피하려고 무거운 의존이 없는 별도 파일에 둔다.
 */
export interface EffectObservationDispatcher {
  activeChatIds(): string[];
  start(request: import("../../shared/types").McpInvocationRequest, workspaceBinding?: undefined, executionContext?: undefined,
    questionContinuation?: undefined, hostNoticePurpose?: "goal-continuation"): { runId: string };
}

export interface EffectObservationTicket {
  readonly observationRunId: string;
  readonly goalId: string;
  readonly longRunId: string;
  readonly chatId: string;
  readonly attemptIds: readonly string[];
  readonly digest: string;
  readonly surface: string;
  readonly dispatcher: EffectObservationDispatcher;
}

const tickets = new Map<string, EffectObservationTicket>();

export function effectObservationTicket(runId: string | undefined | null): EffectObservationTicket | null {
  return runId ? tickets.get(runId) ?? null : null;
}

export function registerEffectObservationTicket(ticket: EffectObservationTicket): void {
  tickets.set(ticket.observationRunId, ticket);
}

export function takeEffectObservationTicket(runId: string): EffectObservationTicket | null {
  const ticket = tickets.get(runId) ?? null;
  tickets.delete(runId);
  return ticket;
}
