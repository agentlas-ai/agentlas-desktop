/*
 * The question cards a person closed with X (moved from a renderer store to the database): which cards of a conversation are closed decides whether the
 * conversation draws the card or a "Reopen" line, so it is the conversation's state, not one window's. Every window of the app, and the next start, read the same answer.
 *
 * Storage: ONE `meta` row per conversation (`qcard-closed:<chatId>`, a JSON list of { key, count, at }). Reader: the conversation's windows (chat:closedQuestions) on a store signal.
 * Deleted: when the question is gone from its source (the window prunes: answered, superseded, expired), by age (14 days), by the per-conversation cap (20), by the total cap
 * (200 conversations, the oldest list goes), and with a conversation that no longer exists. The same limits the renderer store had;
 * nothing new is added. The old localStorage copy is imported once by the renderer and removed (importLegacy), so nothing already on a person's machine is orphaned.
 * Pure of Electron (takes the store handle); the conversation's windows are told through one store change.
 */
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";

export interface ClosedQuestionCard { key: string; count: number; at: number }
export const CLOSED_QUESTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CLOSED_QUESTION_MAX_PER_CHAT = 20;
export const CLOSED_QUESTION_MAX_CHATS = 200;
const PREFIX = "qcard-closed:";
const KEY_MAX = 300;

type Statement = { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
export interface ClosedDb { prepare(sql: string): Statement }
const metaKey = (chatId: string): string => `${PREFIX}${chatId}`;
const validChat = (chatId: unknown): chatId is string => typeof chatId === "string" && chatId.length > 0 && chatId.length <= 256;

function parse(value: unknown, now: number): ClosedQuestionCard[] {
  let list: unknown;
  try { list = typeof value === "string" ? JSON.parse(value) : null; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is ClosedQuestionCard => !!item && typeof item === "object" && typeof (item as ClosedQuestionCard).key === "string" && (item as ClosedQuestionCard).key.length <= KEY_MAX
    && typeof (item as ClosedQuestionCard).at === "number" && now - (item as ClosedQuestionCard).at <= CLOSED_QUESTION_MAX_AGE_MS)
    .map((item) => ({ key: item.key, count: Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 1, at: item.at }))
    .slice(-CLOSED_QUESTION_MAX_PER_CHAT);
}

export function listClosedQuestionCards(chatId: string, db: ClosedDb = getDb() as unknown as ClosedDb, now: number = Date.now()): ClosedQuestionCard[] {
  if (!validChat(chatId)) return [];
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey(chatId)) as { value?: string } | undefined;
  return parse(row?.value, now);
}

function write(db: ClosedDb, chatId: string, list: ClosedQuestionCard[]): void {
  if (list.length) db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(metaKey(chatId), JSON.stringify(list));
  else db.prepare("DELETE FROM meta WHERE key = ?").run(metaKey(chatId));
}

/** The total cap and the conversation that is gone: the lists of conversations that no longer exist go first, then the oldest lists. Runs when a card is closed (rare), not on a timer. */
function enforceTotal(db: ClosedDb): void {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?").all(PREFIX, `${PREFIX.slice(0, -1)};`) as Array<{ key: string; value: string }>;
  const alive = new Set((db.prepare("SELECT id FROM chats").all() as Array<{ id: string }>).map((row) => row.id));
  const kept: Array<{ key: string; newest: number }> = [];
  for (const row of rows) {
    const chatId = row.key.slice(PREFIX.length);
    if (!alive.has(chatId)) { db.prepare("DELETE FROM meta WHERE key = ?").run(row.key); continue; }
    kept.push({ key: row.key, newest: Math.max(0, ...parse(row.value, Date.now()).map((item) => item.at)) });
  }
  kept.sort((a, b) => b.newest - a.newest);
  for (const extra of kept.slice(CLOSED_QUESTION_MAX_CHATS)) db.prepare("DELETE FROM meta WHERE key = ?").run(extra.key);
}

const told = (chatId: string): void => { try { emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* cosmetic */ } };

export function closeQuestionCard(input: { chatId: string; key: string; count?: number }, db: ClosedDb = getDb() as unknown as ClosedDb, now: number = Date.now()): ClosedQuestionCard[] {
  if (!validChat(input.chatId) || typeof input.key !== "string" || !input.key || input.key.length > KEY_MAX) return [];
  const list = [...listClosedQuestionCards(input.chatId, db, now).filter((item) => item.key !== input.key), { key: input.key, count: Math.max(1, Math.floor(input.count ?? 1)), at: now }].slice(-CLOSED_QUESTION_MAX_PER_CHAT);
  write(db, input.chatId, list);
  enforceTotal(db);
  told(input.chatId);
  return list;
}

export function reopenQuestionCard(input: { chatId: string; key: string }, db: ClosedDb = getDb() as unknown as ClosedDb, now: number = Date.now()): ClosedQuestionCard[] {
  if (!validChat(input.chatId)) return [];
  const current = listClosedQuestionCards(input.chatId, db, now);
  const list = current.filter((item) => item.key !== input.key);
  if (list.length === current.length) return current;
  write(db, input.chatId, list);
  told(input.chatId);
  return list;
}

/** The question is gone from its source (answered, superseded, expired): its closed entry goes. `liveKeys` = the keys the window still reads. */
export function pruneClosedQuestionCards(input: { chatId: string; liveKeys: readonly string[] }, db: ClosedDb = getDb() as unknown as ClosedDb, now: number = Date.now()): ClosedQuestionCard[] {
  if (!validChat(input.chatId)) return [];
  const live = new Set(input.liveKeys.filter((key) => typeof key === "string").slice(0, 200));
  const current = listClosedQuestionCards(input.chatId, db, now);
  const list = current.filter((item) => live.has(item.key));
  if (list.length === current.length) return current;
  write(db, input.chatId, list);
  told(input.chatId);
  return list;
}

/** The old per-window copy (localStorage `agentlas.question-closed.v1`): imported once, entry by entry, never over a newer close of the same card. */
export function importLegacyClosedQuestionCards(legacy: Record<string, unknown>, db: ClosedDb = getDb() as unknown as ClosedDb, now: number = Date.now()): number {
  let imported = 0;
  for (const [chatId, raw] of Object.entries(legacy ?? {}).slice(0, CLOSED_QUESTION_MAX_CHATS)) {
    if (!validChat(chatId)) continue;
    const incoming = parse(JSON.stringify(raw), now);
    if (!incoming.length) continue;
    const have = new Map(listClosedQuestionCards(chatId, db, now).map((item) => [item.key, item]));
    for (const item of incoming) if (!have.has(item.key)) { have.set(item.key, item); imported += 1; }
    write(db, chatId, [...have.values()].sort((a, b) => a.at - b.at).slice(-CLOSED_QUESTION_MAX_PER_CHAT));
  }
  if (imported) enforceTotal(db);
  return imported;
}
