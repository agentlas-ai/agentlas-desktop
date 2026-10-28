import { normalizeChatHostNotice } from "../../shared/chat-host-notice";
import { extractAskFences } from "../../shared/ask-fence-flatten";

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

/**
 * A decision card Main writes into the room while no turn of it runs (the Goal's idle card after its verdict, an owner
 * question a background path posts): it reaches the open screen only through the store's chat change, never a run stream,
 * so it was drawn only after a reload (Finance validation 2026-10-28: "답변 대기" with no card until the window was
 * refreshed). Callers merge it only while no run of this room is live, so a streamed card is never doubled. The marker is
 * the wire fence Main's own parser reads (`questions` already parsed, or a complete <<agentlas-ask>> block in the text).
 */
export function mergeOwnerDecisionRows<T extends NoticeRow & { text?: string; questions?: readonly unknown[] }>(current: T[], history: T[]): T[] {
  const seen = new Set(current.flatMap(row => [row.id, row.durableMessageId ?? row.id]));
  // A card the stream already showed under another id: same visible text and the same question(s).
  const signature = (row: T) => `${(row.text ?? "").trim()}\u0000${(row.questions ?? [])
    .map(question => (question && typeof question === "object" ? String((question as { question?: unknown }).question ?? "") : "")).join("\u0001")}`;
  // Only a live row with no durable identity yet can be this card under another id; a durable row is a different message.
  const shown = new Set(current.filter(row => (row.role === "agent" || row.role === "assistant") && !row.durableMessageId).map(signature));
  let next = current;
  for (const row of history) {
    if ((row.role !== "agent" && row.role !== "assistant") || seen.has(row.id) || seen.has(row.durableMessageId ?? row.id)) continue;
    const decision = (row.questions?.length ?? 0) > 0 || extractAskFences(row.text ?? "").questions.length > 0;
    if (!decision || shown.has(signature(row))) continue;
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
