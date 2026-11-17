/*
 * The personal agent's store has ONE ceiling per place (curator-ruleset.json `ceilingRows`, today 700 - the single place the number is read;
 * it moves to the plan table later). The shared set is counted once on the server (when it is full the SERVER lets go of its oldest shared `fact` as a tombstone, which comes down here as a `gone`); this place's
 * own set - its `preference` lines, which are never shared - is counted on its own (store.ts `personalCeilingClassOf`: a line the server gave is never counted here, a fact is never counted against the preferences).
 * When this place's own `preference` lines are at the ceiling, a new `preference` is no longer refused silently: the place lets go of its OLDEST OWN `preference` and then writes the new line. A new shared-kind line
 * (fact, identity, boundary) is counted against the shared-kind lines this place wrote itself (what a place with the sync off holds): at the ceiling it is refused as before and no preference is let go of for it. A shared line (fact, identity, boundary) is never let go of by the desktop. Letting go is a plain retirement (superseded, kept in the history like an absorbed line): no tombstone, no forget stamp,
 * nothing is told to the server or to another desktop - it stays this place's own act.
 * Which line is "own": the kind computed the way the shared-memory sync computes it (a `preference` column line that the model did not give as `identity`, nor as a `boundary` with its structure).
 * Read from the line's columns and `context_json`; no new table, no new column. Personal root store only (scope `user_identity`).
 */
import { getMemoryDb } from "./database";
import { supersedeMemoryEntries } from "./store";

const TICKET = "COALESCE(CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.ticket_kind') END,'')";
const HAS_BOUNDARY = "COALESCE(CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.boundary') END IS NOT NULL,0)";

/** The oldest live Personal `preference` that is this place's own (not shared), or null. */
export function oldestOwnPreference(): string | null {
  const row = getMemoryDb().prepare(`SELECT id FROM memory_entries WHERE scope='user_identity' AND kind='preference' AND superseded_at IS NULL AND content<>''
    AND NOT (${TICKET}='identity' OR (${TICKET}='boundary' AND ${HAS_BOUNDARY})) ORDER BY created_at, id LIMIT 1`).get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The place is full: let go of its oldest own `preference` (one line) and say which. null = there is none (a place full of shared lines keeps its old behaviour: the new line is not written until the server's
 * own tombstones free room). The caller writes the new line afterwards and tells the person with ONE card in the conversation the new line was said in (one/memory-room-notice.ts); a caller with no such conversation does not release at all (the old behaviour: the new line is not written).
 */
export function releaseOldestOwnPreference(): { id: string; text: string } | null {
  const id = oldestOwnPreference();
  if (id === null) return null;
  const row = getMemoryDb().prepare("SELECT content FROM memory_entries WHERE id=?").get(id) as { content: string } | undefined;
  let native: string | null = null;
  try { native = (getMemoryDb().prepare("SELECT content_native FROM memory_entry_native WHERE entry_id=?").get(id) as { content_native?: string } | undefined)?.content_native?.trim() || null; } catch { native = null; }
  supersedeMemoryEntries([id]);
  return { id, text: native ?? row?.content ?? "" };
}
