/**
 * Schema v142 data repairs for names. Both are idempotent and run inside the migration's one
 * transaction: a restart in the middle leaves user_version unchanged and the whole step runs again from nothing done.
 *
 * Readers and deletion: the names are read by every list that shows a group room or an agent; nothing here adds a row or a table.
 */
import type Database from "better-sqlite3";
import { groupRoomTitleOf } from "./group-room-title";

function has(db: Database.Database, table: string, ...columns: string[]): boolean {
  const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
  return names.size > 0 && columns.every((column) => names.has(column));
}

/**
 * A group room's name is `chats.title`; `one_taskforces.title` and the seat's title are derived from it. Builds from before this
 * step renamed only the chat (or wrote a stale form title back), so a room can hold two names. Bring the derived ones to the chat's
 * name and raise the room's revision once (only when they differ, so a second run changes 0 rows). Returns the rooms changed.
 */
export function alignGroupRoomNamesWithChats(db: Database.Database): number {
  if (!has(db, "one_taskforces", "id", "chat_id", "title", "revision")) return 0;
  const rows = db.prepare(
    `SELECT tf.id AS id, tf.title AS tf_title, c.title AS chat_title
       FROM one_taskforces tf JOIN chats c ON c.id = tf.chat_id`,
  ).all() as Array<{ id: string; tf_title: string; chat_title: string | null }>;
  const seats = has(db, "one_seats", "id", "title", "updated_at");
  const now = new Date().toISOString();
  let changed = 0;
  for (const row of rows) {
    const name = groupRoomTitleOf(row.chat_title);
    if (!name) continue; // a chat with no usable name keeps the room's own
    const moved = db.prepare("UPDATE one_taskforces SET title = ?, revision = revision + 1 WHERE id = ? AND title <> ?").run(name, row.id, name).changes;
    if (seats) db.prepare("UPDATE one_seats SET title = ?, updated_at = ? WHERE id = ? AND title <> ?").run(name, now, `seat_tf_${row.id}`, name);
    changed += moved;
  }
  return changed;
}

/**
 * A team member's own `display_name` was a copy of the agent's name that the org form could overwrite, so one agent could show two
 * names. The owner's name now lives only on the agent (`installed_agents.local_display_name`). A member name the owner (or the add
 * dialog) gave that differs from the package name is kept by moving it there, unless the agent already has an own name. The copy
 * column is left as it is (last-known label for a seat whose agent is gone) and is no longer read for an installed agent.
 */
export function adoptOrgMemberNamesAsAliases(db: Database.Database): number {
  if (!has(db, "one_org_members", "installed_agent_id", "display_name", "archived_at", "updated_at")
    || !has(db, "installed_agents", "id", "name", "local_display_name")) return 0;
  const nameEn = has(db, "installed_agents", "name_en") ? "AND m.display_name <> COALESCE(a.name_en, '')" : "";
  return db.prepare(
    `UPDATE installed_agents AS a SET local_display_name = (
        SELECT TRIM(m.display_name) FROM one_org_members m
         WHERE m.installed_agent_id = a.id AND m.display_name IS NOT NULL AND TRIM(m.display_name) <> ''
           AND m.display_name <> a.name ${nameEn}
         ORDER BY (m.archived_at IS NOT NULL), m.updated_at DESC LIMIT 1)
      WHERE (a.local_display_name IS NULL OR TRIM(a.local_display_name) = '')
        AND EXISTS (SELECT 1 FROM one_org_members m
         WHERE m.installed_agent_id = a.id AND m.display_name IS NOT NULL AND TRIM(m.display_name) <> ''
           AND m.display_name <> a.name ${nameEn})`,
  ).run().changes;
}
