/*
 * migration: a schedule a member of a group room made was saved with `monitor.originChatId` = the member's HIDDEN session (a child of the room), so its
 * reports, its receipt and its entry in the room's "scheduled" strip went where nobody looks. New schedules now name the room (harness/automation-chat-project.ts
 * reportChatOf); this one pass at Main start points the older rows at the room the same way. A row whose origin is not a lead-room member session is never touched,
 * and a repointed row names the room, so a second pass finds nothing (idempotent). Reads: automations with an origin (bounded SELECT). Writes: `trigger_json` of the
 * rows it repoints. Nothing else, no model, no timer.
 */
import type Database from "better-sqlite3";
import { isLeadRoomMemberChat } from "../runtime/session-scope";

export function repointRoomMemberSchedules(db: Database.Database): { scanned: number; repointed: number } {
  let rows: Array<{ id: string; trigger_json: string | null }> = [];
  try {
    rows = db.prepare("SELECT id, trigger_json FROM automations WHERE trigger_json IS NOT NULL AND trigger_json LIKE '%originChatId%' LIMIT 5000").all() as typeof rows;
  } catch { return { scanned: 0, repointed: 0 }; }
  const parentOf = db.prepare("SELECT parent_chat_id AS parentId FROM chats WHERE id = ? AND kind = 'division'");
  const write = db.prepare("UPDATE automations SET trigger_json = ? WHERE id = ? AND trigger_json = ?");
  let repointed = 0;
  for (const row of rows) {
    try {
      const trigger = JSON.parse(row.trigger_json ?? "null") as { monitor?: { originChatId?: unknown } } | null;
      const origin = trigger?.monitor?.originChatId;
      if (typeof origin !== "string" || !origin || !isLeadRoomMemberChat(db, origin)) continue;
      const parent = (parentOf.get(origin) as { parentId: string | null } | undefined)?.parentId;
      if (!parent) continue;
      trigger!.monitor!.originChatId = parent;
      if (write.run(JSON.stringify(trigger), row.id, row.trigger_json).changes === 1) repointed += 1;
    } catch { /* one unreadable row never stops the rest */ }
  }
  return { scanned: rows.length, repointed };
}
