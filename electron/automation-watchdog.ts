import type { McpInvocationEvent } from "../shared/types";

export type AutomationWatchdogMode = "idle" | "active-tool";

export interface AutomationWatchdogState {
  lastEventAt: number;
  activeToolIds: Set<string>;
  anonymousToolActive: boolean;
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
    activeToolIds: new Set<string>(),
    anonymousToolActive: false,
  };
}

export function noteAutomationWatchdogEvent(
  state: AutomationWatchdogState,
  event: McpInvocationEvent,
  now = Date.now(),
): void {
  state.lastEventAt = now;

  if (event.kind === "final" || event.kind === "error") {
    state.activeToolIds.clear();
    state.anonymousToolActive = false;
    return;
  }

  const tool = event.tool;
  if (!tool) return;

  const id = tool.id?.trim();
  const completed = tool.result !== undefined || tool.isError === true;
  if (completed) {
    if (id) state.activeToolIds.delete(id);
    else state.anonymousToolActive = false;
    return;
  }

  // Status-only tool-use events are progress, not proof that a child tool is still running.
  if (tool.args === undefined) return;
  if (id) state.activeToolIds.add(id);
  else state.anonymousToolActive = true;
}

export function evaluateAutomationWatchdog(
  state: AutomationWatchdogState,
  idleTimeoutMs: number,
  activeToolTimeoutMs: number,
  now = Date.now(),
): AutomationWatchdogDecision {
  const activeTool = state.activeToolIds.size > 0 || state.anonymousToolActive;
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
