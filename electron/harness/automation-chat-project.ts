// A model that saves an automation from a conversation that lives in a project is working in that project: the automation belongs to it.
// automations made inside the projects "브리핑" and "이사" were saved with project_id empty, so the project's own
// screen and run folder never saw them. The model does not send projectId (it was never told the project's id), so the host fills it from the
// conversation the call came from, the way the neighbouring reads fill `chatId` (app-control/call-aliases.ts).
// An explicit projectId or workspaceMode in the call is the model's own choice and stays (standalone is a choice).
import { scopeStampOfChat } from "../runtime/approval-scope";
import { getDb } from "../store/db";

/**
 * The project of a conversation, or null (no such chat, the owner's own surface "ui", a chat outside every project). read from the ONE stamp
 * (a member's hidden session of a room counts as its room's project), so a schedule made through app.call and one registered from a block get the same project.
 */
export function projectOfChat(chatId: string | null | undefined): string | null {
  if (!chatId || chatId === "ui") return null;
  return scopeStampOfChat(chatId)?.project ?? null;
}

/**
 * Adds the conversation's project to an automations.create call that named none. Returns the `resolved` line to tell the model what was read, or null
 * when nothing was added. Mutates `args.input` (the object the call alias reader already built for this call).
 */
export function defaultAutomationProject(
  operation: unknown,
  args: unknown,
  chatId: string | null | undefined,
): Record<string, string> | null {
  if (operation !== "automations.create" || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const input = (args as { input?: unknown }).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.projectId !== undefined || record.workspaceMode !== undefined) return null;
  const projectId = projectOfChat(chatId);
  if (!projectId) return null;
  record.projectId = projectId;
  record.workspaceMode = "project";
  return { kind: "default", from: "projectId", to: "this conversation's project" };
}

/**
 * The conversation a schedule made from `chatId` reports into. A member of a group room works in a hidden session of its own (a child of the room); the owner
 * never sees that session, so a report - and the receipt of the schedule - written there is written where nobody looks (the schedule a person asked for
 * in the room "이 방에 올린다" reported into the hidden session). The room is the owner's conversation, the same rule a graph a room saved already follows
 * (the room is its originChatId, automation-scheduler.ts). Any other conversation reports into itself.
 */
export function reportChatOf(chatId: string): string {
  try {
    const db = getDb();
    const row = db.prepare("SELECT kind, parent_chat_id AS parentId FROM chats WHERE id = ?").get(chatId) as { kind: string | null; parentId: string | null } | undefined;
    if (!row || row.kind !== "division" || !row.parentId) return chatId;
    const sessionScope = require("../runtime/session-scope") as typeof import("../runtime/session-scope"); // eslint-disable-line @typescript-eslint/no-require-imports
    if (sessionScope.isLeadRoomMemberChat(db, chatId)) return row.parentId;
    // A teammate of the older hand-off model (one_team_dispatches) belongs to its room as well.
    const dispatch = db.prepare("SELECT parent_chat_id AS parentId FROM one_team_dispatches WHERE child_chat_id = ? ORDER BY created_at DESC LIMIT 1").get(chatId) as { parentId: string | null } | undefined;
    return dispatch?.parentId && dispatch.parentId === row.parentId ? row.parentId : chatId;
  } catch { return chatId; }
}

/**
 * (reminder never delivered): a model saving a schedule from a conversation had to guess `targetId` ("agentlas-one" for the
 * personal agent "builtin-agentlas-one") and wire the origin conversation into the monitor by hand. The host knows both from the call: the
 * conversation's own agent (or firm) is the target, and the conversation is where the report goes. Only what the call left out is filled; an
 * explicit target or monitor is the model's choice and stays (an unknown target id is refused by the create entrance, never rewritten here).
 * Returns the `resolved` lines for what was read, in the order filled.
 */
export function defaultAutomationFromChat(operation: unknown, args: unknown, chatId: string | null | undefined): Array<Record<string, string>> {
  if (operation !== "automations.create" || !args || typeof args !== "object" || Array.isArray(args)) return [];
  const input = (args as { input?: unknown }).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const lines: Array<Record<string, string>> = [];
  const project = defaultAutomationProject(operation, args, chatId);
  if (project) lines.push(project);
  if (!chatId || chatId === "ui") return lines;
  let chat: { agent_id: string | null; firm_id: string | null } | undefined;
  try { chat = getDb().prepare("SELECT agent_id, firm_id FROM chats WHERE id = ?").get(chatId) as typeof chat; } catch { chat = undefined; }
  if (!chat) return lines;
  if (record.targetType === undefined && record.targetId === undefined) {
    const firm = chat.firm_id || null, agent = chat.agent_id || null;
    if (firm) { record.targetType = "firm"; record.targetId = firm; lines.push({ kind: "default", from: "targetType, targetId", to: "this conversation's company" }); }
    else if (agent) { record.targetType = "agent"; record.targetId = agent; lines.push({ kind: "default", from: "targetType, targetId", to: "this conversation's agent" }); }
  }
  const trigger = record.trigger && typeof record.trigger === "object" && !Array.isArray(record.trigger) ? record.trigger as Record<string, unknown> : null;
  const timeDriven = (record.triggerType ?? "schedule") === "schedule";
  const reportChatId = reportChatOf(chatId);
  if (timeDriven && record.monitor === undefined && trigger?.monitor === undefined) {
    record.monitor = { schemaVersion: "agentlas.automation-monitor.v1", notificationPolicy: "every_run", originChatId: reportChatId, originMessageId: null, deadline: null };
    lines.push({ kind: "default", from: "monitor", to: reportChatId === chatId ? "report back into this conversation" : "report back into this group room" });
  } else if (reportChatId !== chatId) {
    // A monitor that names the hidden member session (the only conversation the member knows) means the room it works for.
    for (const monitor of [record.monitor, trigger?.monitor]) {
      if (monitor && typeof monitor === "object" && !Array.isArray(monitor) && (monitor as { originChatId?: unknown }).originChatId === chatId) {
        (monitor as { originChatId?: unknown }).originChatId = reportChatId;
        lines.push({ kind: "default", from: "monitor.originChatId", to: "this group room" });
      }
    }
  }
  return lines;
}
