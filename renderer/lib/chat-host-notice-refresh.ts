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
