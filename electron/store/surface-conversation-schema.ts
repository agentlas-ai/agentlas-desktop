import type Database from "better-sqlite3";
import { stableScienceRuntimeChatId } from "../runtime/science-transport-identity";

/** The marker title Desktop has always given a Science conversation's hidden runtime chat (store/chats.ts). */
export const SCIENCE_RUNTIME_CHAT_MARKER = "⟦science⟧";
export const SCIENCE_SURFACE_PACK = "science";

/**
 * The one place a screen pack is mapped to the screen that shows its chats (an approval, a search hit, a link). Common code reads a
 * chat's pack through this, not an execution source: a Science conversation is known by its chat, as a Work or One chat is.
 */
const SURFACE_PACK_SCREENS = { [SCIENCE_SURFACE_PACK]: "science" } as const;
export type SurfacePackScreen = typeof SURFACE_PACK_SCREENS[keyof typeof SURFACE_PACK_SCREENS];
export function surfacePackScreen(pack: string | null | undefined): SurfacePackScreen | null {
  return pack && Object.prototype.hasOwnProperty.call(SURFACE_PACK_SCREENS, pack) ? SURFACE_PACK_SCREENS[pack as keyof typeof SURFACE_PACK_SCREENS] : null;
}

/** A chat a pack creates for its own work (e.g. Science's independent review chat) belongs to that pack's screen too. */
export function tagChatSurfacePack(db: Database.Database, chatId: string, pack: string): void {
  if (!surfacePackScreen(pack)) throw new Error("surface_pack_unknown");
  const row = db.prepare("SELECT surface_pack FROM chats WHERE id = ?").get(chatId) as { surface_pack: string | null } | undefined;
  if (!row) throw new Error("surface_pack_chat_not_found");
  if (row.surface_pack === pack) return;
  if (row.surface_pack !== null) throw new Error("surface_pack_conflict");
  db.prepare("UPDATE chats SET surface_pack = ? WHERE id = ? AND surface_pack IS NULL").run(pack, chatId);
}

/**
 * v136 backfill: tag the hidden chat of every existing Science conversation with its screen pack. A row is tagged only when
 * its whole identity matches the one Desktop derives (division kind, Work origin, marker title, id derived from the title's
 * conversation id); anything else is left untagged rather than guessed. Idempotent.
 */
export function tagSurfacePackChatsInDb(db: Database.Database): number {
  const columns = new Set((db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((column) => column.name));
  // A store without `kind` has no hidden division chats, so nothing to tag; one without `origin_surface` predates surfaces and is
  // all Work. The migration must never stop an upgrade on a store shaped differently from the ladder's assumption (a v83 store
  // with a minimal chats table stopped the v136 step with "no such column: kind").
  if (!columns.has("surface_pack") || !columns.has("kind") || !columns.has("title")) return 0;
  const originIsWork = columns.has("origin_surface") ? "COALESCE(origin_surface, 'work') = 'work'" : "1 = 1";
  const rows = db.prepare(`SELECT id, title FROM chats
    WHERE kind = 'division' AND ${originIsWork} AND surface_pack IS NULL
      AND substr(title, 1, ?) = ?`).all(SCIENCE_RUNTIME_CHAT_MARKER.length, SCIENCE_RUNTIME_CHAT_MARKER) as Array<{ id: string; title: string }>;
  const tag = db.prepare("UPDATE chats SET surface_pack = ? WHERE id = ? AND surface_pack IS NULL");
  let tagged = 0;
  for (const row of rows) {
    const conversationId = row.title.slice(SCIENCE_RUNTIME_CHAT_MARKER.length);
    let derived: string;
    try { derived = stableScienceRuntimeChatId(conversationId); } catch { continue; }
    if (derived !== row.id) continue;
    tagged += tag.run(SCIENCE_SURFACE_PACK, row.id).changes;
  }
  return tagged;
}
