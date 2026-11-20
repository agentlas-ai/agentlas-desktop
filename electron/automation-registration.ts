import type { Automation, Trigger } from "../shared/types";
import type { AutomationMonitorContract } from "../shared/automation-monitor";
import { parseAutomations, type ParsedAutomation } from "./automation-emitter";

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
    deadline: emitted ? emitted.deadline : prior?.deadline ?? null,
    // The host's own flag is never lost when a registration block updates the same schedule.
    ...(prior?.deliverAnswer === true ? { deliverAnswer: true } : {}) };
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

/** A parsed proposal needs the host consumer before another inference pass.
 * This is admission to registration/permission validation, never completion. */
export function hasAutomationRegistrationHandoff(text: string, input: {
  agentAppMode: boolean; division: boolean; sessionAutomationId?: string; backgroundAutomation: boolean; headlessFence?: boolean;
}): boolean {
  if (input.agentAppMode || input.backgroundAutomation || (input.division && !input.sessionAutomationId)) return false;
  const parsed = parseAutomations(text, { headlessFence: input.headlessFence === true });
  return parsed.automations.length > 0 || parsed.errors.length > 0;
}

/**
 * A hidden member session of a room (a division chat with a parent room, not a company division and not a Work session) answers the person's own
 * request, so a registration block it ends with is consumed like any chat's. Before, only a non-division chat or an automation's own session consumed
 * one: in a group room the member wrote "registered", the block was dropped and the store held no row. The run of an automation
 * itself never registers (the caller's executionContext check).
 */
export function isRoomMemberSession(chat: { kind?: string | null; parentChatId?: string | null; firmId?: string | null; originSurface?: string | null }): boolean {
  return chat.kind === "division" && Boolean(chat.parentChatId) && !chat.firmId && chat.originSurface !== "work";
}

/**
 * The project an automation registered from this chat belongs to: the chat's own, else its room's - the same walk as the scope stamp (runtime/approval-scope.ts
 * scopeStampOfChat: a member's hidden session belongs to its room, bounded), so a schedule's project is the project of the conversation that made it.
 * `kind` absent (a plain object) walks as a hidden session does; a real conversation of another kind is its own unit.
 */
export function automationProjectIdForChat(
  chat: { projectId?: string | null; parentChatId?: string | null; kind?: string | null },
  readChat: (id: string) => { projectId?: string | null; parentChatId?: string | null; kind?: string | null } | null | undefined,
): string | null {
  let row: { projectId?: string | null; parentChatId?: string | null; kind?: string | null } | null | undefined = chat;
  for (let hop = 0; hop < 4 && row; hop += 1) {
    if (row.projectId) return row.projectId;
    if (!row.parentChatId || (row.kind != null && row.kind !== "division")) return null;
    try { row = readChat(row.parentChatId); } catch { return null; }
  }
  return null;
}
