/**
 * 효과 관찰 실행 표(Main 전용) — effect-observation.ts 가 발행하고, 실행기(InvocationService)와
 * MCP 클라이언트가 "이 실행은 목표 주기가 아니라 읽기 전용 관찰이다"를 판정할 때 읽는다.
 * 요청 본문(IPC)으로는 만들 수 없다. 순환 import 를 피하려고 무거운 의존이 없는 별도 파일에 둔다.
 */
export interface EffectObservationDispatcher {
  activeChatIds(): string[];
  /** An owner request queued in this chat runs before any automatic resume. */
  hasQueuedOwnerRequest?(chatId: string): boolean;
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
  /** "attempts": uncertain worker attempts; "boundary": no attempt rows, only an unsealed last invocation. */
  readonly kind: "attempts" | "boundary";
  /** The interrupted work touched a web page or a browser tool: the look needs the Agentlas browser.
   * Otherwise it looks with read built-ins only (no MCP tool schemas in its context). */
  readonly needsBrowser?: boolean;
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

/** Goals whose effect observation is in flight — the chip shows "checking" instead of "review outcome". */
const observingGoals = new Set<string>();
/** Automations whose effect observation is in flight (headless path). */
const observingAutomations = new Set<string>();

export function markGoalObserving(goalId: string, observing: boolean): void {
  if (observing) observingGoals.add(goalId); else observingGoals.delete(goalId);
}
export function isGoalObserving(goalId: string | null | undefined): boolean {
  return Boolean(goalId && observingGoals.has(goalId));
}
export function markAutomationObserving(automationId: string, observing: boolean): void {
  if (observing) observingAutomations.add(automationId); else observingAutomations.delete(automationId);
}
export function isAutomationObserving(automationId: string | null | undefined): boolean {
  return Boolean(automationId && observingAutomations.has(automationId));
}

/** Headless automation observation seam, registered by automation-scheduler at module load (QA registers a fake).
 * Kept in this import-free module so registration never depends on module load order. */
export interface AutomationObservationRuntime {
  isAutomationRunning(automationId: string): boolean;
  /** Headless read-only run on the automation's own session (Main-built request only). */
  runHeadless(automationId: string, request: import("../../shared/types").McpInvocationRequest, signal: AbortSignal): Promise<{ finalText?: string }>;
  /** Queue the automation's next run now; false when refused (lease/running/quiescing). */
  enqueueRun(automationId: string): boolean;
}
let automationRuntime: AutomationObservationRuntime | null = null;
export function registerAutomationObservationRuntime(runtime: AutomationObservationRuntime | null): void {
  automationRuntime = runtime;
}
export function automationObservationRuntime(): AutomationObservationRuntime | null {
  return automationRuntime;
}
