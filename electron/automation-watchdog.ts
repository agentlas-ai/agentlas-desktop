import type { McpInvocationEvent } from "../shared/types";

/**
 * Upper bound accepted by the scheduler for a silent but known-active tool.
 * Durable run recovery reuses this exact ceiling so a second Desktop/headless
 * process never mistakes a valid long-running tool for an abandoned run.
 */
export const MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS = 4 * 60 * 60 * 1000;

export type AutomationWatchdogMode = "idle" | "active-tool";

type AutomationWatchdogNodeScope = string | null;

export interface AutomationWatchdogState {
  lastEventAt: number;
  /**
   * Tool ids are provider-local and can be reused by parallel graph nodes. Keep them under the
   * workflow node that emitted the event; `null` is the legacy/single-invocation scope.
   */
  activeToolIdsByNode: Map<AutomationWatchdogNodeScope, Set<string>>;
  /** A no-id tool cannot be paired precisely, but it can still be isolated to its graph node. */
  anonymousToolNodes: Set<AutomationWatchdogNodeScope>;
}

export interface AutomationWatchdogDecision {
  stalled: boolean;
  mode: AutomationWatchdogMode;
  timeoutMs: number;
  inactiveMs: number;
}

/**
 * Runtime events are semantic rather than process heartbeats. A long-running tool can be
 * healthy while emitting nothing, so it gets a separate inactivity budget from an idle runner.
 */
export function createAutomationWatchdogState(now = Date.now()): AutomationWatchdogState {
  return {
    lastEventAt: now,
    activeToolIdsByNode: new Map<AutomationWatchdogNodeScope, Set<string>>(),
    anonymousToolNodes: new Set<AutomationWatchdogNodeScope>(),
  };
}

function eventNodeScope(event: McpInvocationEvent): AutomationWatchdogNodeScope {
  const nodeId = event.nodeId?.trim();
  return nodeId ? nodeId : null;
}

function clearNodeScope(
  state: AutomationWatchdogState,
  scope: AutomationWatchdogNodeScope,
): void {
  state.activeToolIdsByNode.delete(scope);
  state.anonymousToolNodes.delete(scope);
}

export function noteAutomationWatchdogEvent(
  state: AutomationWatchdogState,
  event: McpInvocationEvent,
  now = Date.now(),
): void {
  state.lastEventAt = now;

  const scope = eventNodeScope(event);

  if (event.kind === "final" || event.kind === "error") {
    if (scope === null) {
      // Legacy/single invocation events have no node id and own the whole watchdog state.
      state.activeToolIdsByNode.clear();
      state.anonymousToolNodes.clear();
    } else {
      // A graph node terminal event must not erase a sibling node's active tool. Parallel
      // providers commonly reuse ids such as "tool-1", so tool id alone is not a safe key.
      clearNodeScope(state, scope);
    }
    return;
  }

  const tool = event.tool;
  if (!tool) return;

  const id = tool.id?.trim();
  const completed = tool.result !== undefined || tool.isError === true;
  if (completed) {
    if (id) {
      const nodeTools = state.activeToolIdsByNode.get(scope);
      nodeTools?.delete(id);
      if (nodeTools?.size === 0) state.activeToolIdsByNode.delete(scope);
    } else {
      state.anonymousToolNodes.delete(scope);
    }
    return;
  }

  // Status-only tool-use events are progress, not proof that a child tool is still running.
  if (tool.args === undefined) return;
  if (id) {
    let nodeTools = state.activeToolIdsByNode.get(scope);
    if (!nodeTools) {
      nodeTools = new Set<string>();
      state.activeToolIdsByNode.set(scope, nodeTools);
    }
    nodeTools.add(id);
  } else {
    state.anonymousToolNodes.add(scope);
  }
}

export function evaluateAutomationWatchdog(
  state: AutomationWatchdogState,
  idleTimeoutMs: number,
  activeToolTimeoutMs: number,
  now = Date.now(),
): AutomationWatchdogDecision {
  const activeTool = state.activeToolIdsByNode.size > 0 || state.anonymousToolNodes.size > 0;
  const mode: AutomationWatchdogMode = activeTool ? "active-tool" : "idle";
  const timeoutMs = Math.max(1, activeTool ? activeToolTimeoutMs : idleTimeoutMs);
  const inactiveMs = Math.max(0, now - state.lastEventAt);
  return {
    stalled: inactiveMs > timeoutMs,
    mode,
    timeoutMs,
    inactiveMs,
  };
}

export function automationWatchdogError(decision: AutomationWatchdogDecision): string {
  const seconds = Math.round(decision.timeoutMs / 1000);
  if (decision.mode === "active-tool") {
    return `active tool produced no event for ${seconds}s, auto-aborted (active-tool watchdog)`;
  }
  return `no response for ${seconds}s, auto-aborted (stall watchdog)`;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === "string" && signal.reason.trim()) return new Error(signal.reason);
  return new Error("Automation runner aborted");
}

/**
 * Wait for a runner until it settles, or until a short cleanup grace expires after abort.
 *
 * Well-behaved runtimes settle after receiving the signal and retain their existing child-process
 * cleanup path. After the grace, this extra race is the scheduler's lifecycle boundary for a
 * broken runtime that ignores cancellation: leases, run history, and failure reporting can still
 * finish instead of remaining stuck forever. Promise.race observes a late runner rejection, so
 * detaching it does not create an unhandled rejection.
 */
export function awaitAutomationRunnerWithAbortGrace<T>(
  runner: PromiseLike<T>,
  signal: AbortSignal,
  settleGraceMs = 10_000,
): Promise<T> {
  const observedRunner = Promise.resolve(runner);
  let removeAbortListener = () => {};
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const abortBoundary = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      // Preserve the normal runtime's child cleanup semantics first. Only detach after a finite
      // grace when a broken runtime never settles despite having received the AbortSignal.
      const graceMs = Number.isFinite(settleGraceMs)
        ? Math.max(0, Math.floor(settleGraceMs))
        : 10_000;
      settleTimer = setTimeout(() => reject(abortReason(signal)), graceMs);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([observedRunner, abortBoundary]).finally(() => {
    removeAbortListener();
    if (settleTimer) clearTimeout(settleTimer);
  });
}
