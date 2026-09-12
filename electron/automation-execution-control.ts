/** Shared in-process Stop authority for scheduler, Main and natural-language
 * lifecycle controls. Durable enabled state remains owned by the store. */
const controllers = new Map<string, AbortController>();

export function bindAutomationRunStop(automationId: string, controller: AbortController): void {
  const prior = controllers.get(automationId);
  if (prior && prior !== controller) throw new Error("automation_stop_handle_already_bound");
  controllers.set(automationId, controller);
}
export function releaseAutomationRunStop(automationId: string, controller: AbortController): void {
  if (controllers.get(automationId) === controller) controllers.delete(automationId);
}
export function stopAutomationRun(automationId: string): boolean {
  const controller = controllers.get(automationId);
  if (!controller) return false;
  controller.abort(new Error("automation_stopped_by_user"));
  return true;
}
