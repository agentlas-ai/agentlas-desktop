import { assertAutomationRemovalSafe, AutomationActiveRemovalError } from "./automation-scheduler";
import {
  getAutomation,
  hasDurableActiveAutomationExecution,
  removeAutomation,
} from "./store/automations";

/**
 * Main-owned destructive boundary for automation removal.
 *
 * The activity assertion and atomic store deletion run without an await between
 * them, so another same-process dispatch cannot enter after the check. Cached
 * work that was already queued still hits startGraphRun's parent-exists guard.
 */
export function removeAutomationSafely(automationId: string): void {
  if (!getAutomation(automationId)) throw new Error(`Automation not found: ${automationId}`);
  assertAutomationRemovalSafe(automationId);
  if (hasDurableActiveAutomationExecution(automationId)) {
    throw new AutomationActiveRemovalError(automationId, "run");
  }
  removeAutomation(automationId);
}
