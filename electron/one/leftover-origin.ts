/*
 * The origin of merged leftover lines (O-M4b, contracts/one-home-leftover.md home-side rule 2): where a line came from, and "forget everything that came from this computer".
 * Plain functions over database handles (no Electron import); home-move-real.ts gives them the real stores, the gate gives them synthetic ones.
 *
 * Where the mark lives (no new table, no new column):
 *   Personal memory line   its own `evidence_json` (the engine writes it `[]` on import): `["origin:leftover:<kid>:<sha16>"]`, written only onto a line that has no evidence yet and
 * only for the ids the engine said this merge added (its answer's `insertedIds`, B3), never for an id found by its shape. Read: "forget everything from this computer" (and the screen's "from <computer>" value). Deleted: with the line (the owner's forget blanks it).
 *                          A line the owner EDITS is replaced by a new line that keeps only the two instruction marks (owner-mutations.ts originMarksOf): an edited line has become the owner's own.
 *   conversation line      the ids in `<account folder>/leftover-origins/<kid>.json` (the chat table has no column for it and a new column would be a schema bump). Read: the same forget, the screen's
 *                          "from <computer>" value. Deleted: by that forget; a line the owner deletes one by one leaves a stale id, which is harmless (the delete is by exact id).
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { OriginDoc } from "./home-leftover";

const PERSONAL = "user_identity";
/** A conversation line id (the chat table's; a MEMORY line's id is never matched against this - B3: the engine's id grammar is wider and the origin mark is found by the evidence, not by the shape of an id). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const chunks = <T>(list: T[], size = 400): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

export function idsPresent(db: Database.Database, table: "memory_entries" | "chat_messages", ids: string[]): string[] {
  const out: string[] = [];
  for (const part of chunks(ids)) {
    for (const r of db.prepare(`SELECT id FROM ${table} WHERE id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ id: string }>) out.push(r.id);
  }
  return out;
}

/** Marks lines that have no evidence yet. A line that already has evidence is not touched (it was the home's own or was marked before). */
export function tagMemory(db: Database.Database, ids: string[], marker: string): number {
  const update = db.prepare("UPDATE memory_entries SET evidence_json=? WHERE id=? AND scope=? AND evidence_json='[]'");
  let n = 0;
  db.transaction(() => { for (const id of ids) n += update.run(JSON.stringify([marker]), id, PERSONAL).changes; }).immediate();
  return n;
}

/** The live Personal lines whose evidence carries a mark that starts with `prefix` (the lines of one computer's merge that are still that merge's lines: an edited line is a new line without the mark, a forgotten one is empty). */
export function markedMemoryIds(db: Database.Database, prefix: string): string[] {
  return (db.prepare(
    "SELECT m.id AS id FROM memory_entries m WHERE m.scope=? AND m.superseded_at IS NULL AND m.content<>'' AND EXISTS (SELECT 1 FROM json_each(m.evidence_json) e WHERE substr(e.value,1,?)=?) ORDER BY m.id",
  ).all(PERSONAL, prefix.length, prefix) as Array<{ id: string }>).map((r) => r.id);
}

/** Audit 61 (desktop 6): the OLDER versions (`superseded_at` set, words still there) that carry a mark of that computer's merge. An owner edit makes a new line without the mark and leaves the replaced line as it was: that line is the other computer's original
 * wording, still marked. "Forget everything from this computer" deletes these by id as well. A superseded line WITHOUT the mark (the history of a line the home wrote itself) is never listed. */
export function markedOlderVersionIds(db: Database.Database, prefix: string): string[] {
  return (db.prepare(
    "SELECT m.id AS id FROM memory_entries m WHERE m.scope=? AND m.superseded_at IS NOT NULL AND m.content<>'' AND EXISTS (SELECT 1 FROM json_each(m.evidence_json) e WHERE substr(e.value,1,?)=?) ORDER BY m.id",
  ).all(PERSONAL, prefix.length, prefix) as Array<{ id: string }>).map((r) => r.id);
}

export function deleteLines(db: Database.Database, ids: string[]): number {
  let n = 0;
  db.transaction(() => { for (const part of chunks(ids)) n += db.prepare(`DELETE FROM chat_messages WHERE id IN (${part.map(() => "?").join(",")})`).run(...part).changes; }).immediate();
  return n;
}

/** The conversation-line index: one small JSON file per computer it came from, atomic writes. `dir` = the account's folder. */
export function createOriginIndex(dir: (userId: string) => string): { write(userId: string, doc: OriginDoc): boolean; read(userId: string, kid: string): OriginDoc | null; remove(userId: string, kid: string): void; list(userId: string): string[] } {
  const folder = (userId: string): string => path.join(dir(userId), "leftover-origins");
  const file = (userId: string, kid: string): string => path.join(folder(userId), `${kid}.json`);
  const SAFE = /^[A-Za-z0-9_-]{22}$/;
  return {
    write(userId, doc) {
      if (!SAFE.test(doc.kid)) return false;
      try {
        fs.mkdirSync(folder(userId), { recursive: true, mode: 0o700 });
        const tmp = `${file(userId, doc.kid)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ kid: doc.kid, lines: doc.lines.filter((id) => ID.test(id)), at: doc.at, ...(doc.unmarked ? { unmarked: Math.floor(doc.unmarked) } : {}), ...(doc.gap ? { gap: true } : {}) }), { mode: 0o600 });
        fs.renameSync(tmp, file(userId, doc.kid));
        return true;
      } catch { return false; }
    },
    read(userId, kid) {
      if (!SAFE.test(kid)) return null;
      try {
        const v = JSON.parse(fs.readFileSync(file(userId, kid), "utf8")) as Partial<OriginDoc>;
        return v && v.kid === kid && Array.isArray(v.lines) ? { kid, lines: v.lines.filter((x): x is string => typeof x === "string" && ID.test(x)), at: Number(v.at) || 0, ...(Number.isSafeInteger(v.unmarked) && (v.unmarked as number) > 0 ? { unmarked: v.unmarked } : {}), ...(v.gap === true ? { gap: true } : {}) } : null;
      } catch { return null; }
    },
    remove(userId, kid) { if (SAFE.test(kid)) { try { fs.rmSync(file(userId, kid), { force: true }); } catch { /* checked by the next list */ } } },
    list(userId) { try { return fs.readdirSync(folder(userId)).filter((n) => n.endsWith(".json") && SAFE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)); } catch { return []; } },
  };
}
