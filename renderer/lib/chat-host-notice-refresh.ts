import { normalizeChatHostNotice } from "../../shared/chat-host-notice";

type NoticeRow = {
  id: string;
  durableMessageId?: string;
  role: string;
  hostNotice?: unknown;
  createdAt?: string;
};

/** Append only typed, durable automation reports from Main history. Never
 * replace optimistic turns or the live response with a history snapshot. */
export function mergeAutomationHostNotices<T extends NoticeRow>(current: T[], history: T[]): T[] {
  const seen = new Set(current.flatMap(row => [row.id, row.durableMessageId ?? row.id]));
  let next = current;
  for (const row of history) {
    if (normalizeChatHostNotice(row.role, row.hostNotice)?.purpose !== "automation-report"
      || seen.has(row.id) || seen.has(row.durableMessageId ?? row.id)) continue;
    if (next === current) next = [...current];
    // Late catch-up belongs at its durable time, not below newer user turns.
    const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
    const index = Number.isFinite(at)
      ? next.findIndex(item => item.createdAt && Date.parse(item.createdAt) > at) : -1;
    next.splice(index < 0 ? next.length : index, 0, row);
    seen.add(row.id);
    seen.add(row.durableMessageId ?? row.id);
  }
  return next;
}

/** Rows a room's working team writes while the owner is looking at it: dispatch links and reports, and a member's own message. */
function isRoomWorkRow(row: NoticeRow & { speakerAgentId?: string }): boolean {
  const purpose = normalizeChatHostNotice(row.role, row.hostNotice)?.purpose;
  return purpose === "one-dispatch-link" || purpose === "one-dispatch-result"
    || (row.role === "assistant" && Boolean(row.speakerAgentId) && !row.speakerAgentId!.startsWith("builtin-"));
}

/** Append, at their durable time, the room-work rows (hand-offs, member reports and messages) that arrived after the
 * transcript loaded. Same fence as mergeAutomationHostNotices: nothing already shown is replaced. */
export function mergeRoomWorkRows<T extends NoticeRow & { speakerAgentId?: string }>(current: T[], history: T[]): T[] {
  const seen = new Set(current.flatMap(row => [row.id, row.durableMessageId ?? row.id]));
  let next = current;
  for (const row of history) {
    if (!isRoomWorkRow(row) || seen.has(row.id) || seen.has(row.durableMessageId ?? row.id)) continue;
    if (next === current) next = [...current];
    const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
    const index = Number.isFinite(at)
      ? next.findIndex(item => item.createdAt && Date.parse(item.createdAt) > at) : -1;
    next.splice(index < 0 ? next.length : index, 0, row);
    seen.add(row.id);
    seen.add(row.durableMessageId ?? row.id);
  }
  return next;
}
