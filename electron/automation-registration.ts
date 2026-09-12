import type { Automation, Trigger } from "../shared/types";
import type { AutomationMonitorContract } from "../shared/automation-monitor";
import type { ParsedAutomation } from "./automation-emitter";

/** Only exact receipts/session identity or an unambiguous same-origin name may
 * select an existing automation. Global display names are not identity. */
export function resolveAutomationRegistrationTarget(input: {
  parsed: ParsedAutomation; automations: Automation[]; chatId: string; sessionAutomationId?: string;
}): Automation | undefined {
  const id = input.parsed.automationId ?? input.sessionAutomationId;
  if (input.sessionAutomationId && input.parsed.automationId && input.sessionAutomationId !== input.parsed.automationId) throw new Error("automation_session_identity_mismatch");
  if (id) {
    const row = input.automations.find(a => a.id === id);
    if (!row) throw new Error("automation_identity_not_found");
    return row;
  }
  const matches = input.automations.filter(a => a.monitor?.originChatId === input.chatId
    && a.name.trim().toLowerCase() === input.parsed.name.trim().toLowerCase());
  if (matches.length > 1) throw new Error("automation_identity_ambiguous");
  return matches[0];
}
export function automationRegistrationMonitoring(input: {
  parsed: ParsedAutomation; chatId: string; messageId: string | null; existing?: Automation; now?: Date;
}): { monitor: AutomationMonitorContract; trigger?: Trigger; triggerType?: "poll" } {
  const emitted = input.parsed.monitor;
  const prior = input.existing?.monitor;
  const monitor: AutomationMonitorContract = { schemaVersion: "agentlas.automation-monitor.v1",
    originChatId: prior?.originChatId ?? input.chatId, originMessageId: prior?.originMessageId ?? input.messageId,
    notificationPolicy: emitted?.notificationPolicy ?? prior?.notificationPolicy ?? "every_run",
    deadline: emitted ? emitted.deadline : prior?.deadline ?? null };
  if (!emitted?.source) {
    if (emitted && input.existing?.trigger?.kind === "poll" && prior?.deadline !== monitor.deadline) {
      return {monitor,triggerType:"poll",trigger:{...input.existing.trigger,monitor,
        pollState:{schemaVersion:"agentlas.poll-state.v1",revision:(input.existing.trigger.pollState?.revision ?? 0)+1,
          nextCheckAt:(input.now ?? new Date()).toISOString(),currentIntervalMs:input.existing.trigger.minIntervalMs,observedAt:null,status:"pending"}}};
    }
    return { monitor };
  }
  const next: Extract<Trigger, {kind:"poll"}> = {kind:"poll", source:emitted.source,
    cond:emitted.condition ?? {left:"{{value}}",op:"changed"}, minIntervalMs:emitted.minIntervalMs,
    maxIntervalMs:emitted.maxIntervalMs, monitor};
  const existing = input.existing?.trigger;
  if (existing?.kind === "poll" && JSON.stringify(existing.source) === JSON.stringify(next.source)
    && JSON.stringify(existing.cond) === JSON.stringify(next.cond) && prior?.deadline === monitor.deadline) {
    next.lastSeen = existing.lastSeen;
    next.pollState = existing.pollState;
  }
  if (!next.pollState) next.pollState = {schemaVersion:"agentlas.poll-state.v1",revision:1,
    nextCheckAt:(input.now ?? new Date()).toISOString(), currentIntervalMs:emitted.minIntervalMs, observedAt:null,status:"pending"};
  return {monitor,triggerType:"poll",trigger:next};
}
