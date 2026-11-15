// Harness cleanup: the tables the deleted AGI unblocker and the goal strategy episode left without an owner (Agentlas 2.0 N1b, section 11,
// decision; the list is WORK-PACKAGES item 43). Dropped once by the first-run migration, never by the ordinary start.
//
// What this never touches: `agi_bug_report_queue` (the defect report queue still uses it), the Science and Finance tables. The allow-list below is the only thing that can be
// dropped, and a name that does not match it is refused before any SQL runs. The Alive tables of the deleted One and Work lives are cleaned by the second half of this file
// (`runAliveCleanupUnit`, / decision): its own allow-list, its own order, and rows of Science lives are never reached.
//
// Safe to run twice, to be killed, and to meet a table that is already gone: one transaction per call, `DROP TABLE IF EXISTS`. A table another table still
// REFERENCES is left (and reported) instead of dropped - SQLite would silently delete rows of the child on a drop with foreign keys on.
import type Database from "better-sqlite3";

export const HARNESS_ORPHAN_TABLES: readonly string[] = [
  "agi_action_receipts", "agi_defect_reports", "agi_incidents", "agi_unblock_attempts", "agi_model_attempts", "agi_settings", "agi_token_ledger", "agi_playbook",
  "goal_strategy_episode_captures", "goal_strategy_episode_results", "automation_strategy_episode_reservations",
];
const ALLOWED = /^(?:agi_(?!bug_report_queue$)[a-z_]+|goal_strategy_episode_(?:captures|results)|automation_strategy_episode_reservations)$/;

export function assertHarnessAllowList(names: readonly string[] = HARNESS_ORPHAN_TABLES): void {
  for (const name of names) if (!ALLOWED.test(name) || name === "agi_bug_report_queue") throw new Error("harness_cleanup_name_refused");
}

/** Which of the orphan tables exist now. One query on `sqlite_master`; no table is read. */
export function harnessTablesPresent(db: Database.Database): string[] {
  const marks = HARNESS_ORPHAN_TABLES.map(() => "?").join(",");
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${marks})`).all(...HARNESS_ORPHAN_TABLES) as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

export interface HarnessCleanupResult { dropped: string[]; blocked: string[]; error?: string }

/** Drops what is there. `blocked` = a table another table still points at (left in place; the next start tries again). Never throws. */
export function runHarnessCleanup(db: Database.Database, options: { limit?: number } = {}): HarnessCleanupResult {
  const result: HarnessCleanupResult = { dropped: [], blocked: [] };
  try {
    assertHarnessAllowList();
    const present = harnessTablesPresent(db);
    if (!present.length) return result;
    const others = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
    const referenced = new Set<string>();
    for (const name of present) {
      const pattern = new RegExp(`REFERENCES\\s+["\`\\[]?${name}\\b`, "i");
      if (others.some((other) => other.name !== name && !HARNESS_ORPHAN_TABLES.includes(other.name) && pattern.test(other.sql))) referenced.add(name);
    }
    const droppable = present.filter((name) => !referenced.has(name));
    // `limit`: the conductor drops one table per pass so Main is never held for all eleven at once; the next pass takes the next (a table already gone is a no-op).
    const drop = options.limit && options.limit > 0 ? droppable.slice(0, options.limit) : droppable;
    db.transaction(() => { for (const name of drop) db.exec(`DROP TABLE IF EXISTS "${name}"`); }).immediate();
    result.dropped = drop;
    result.blocked = [...referenced].sort();
  } catch (error) {
    result.error = String((error as { code?: string })?.code ?? (error as Error)?.message ?? "unexpected").slice(0, 80);
  }
  return result;
}


// --- the Alive tables the deleted One and Work lives left (Agentlas 2.0 N2 / WORK-PACKAGES item 70) -----------------------------------------------------------------

/** Tables only the deleted One / Work Alive used. `alive_organism_lives` is LAST: the set of lives to clean is read from it until the shared tables are empty of them. */
export const ALIVE_DEDICATED_TABLES: readonly string[] = [
  "alive_light_wakes", "alive_runtime_facts", "alive_owner_intents", "alive_goal_action_receipts", "alive_pending_grants", "alive_domain_owner", "alive_organism_lives",
];
/** Tables Science's Alive still shares: only the rows of the One / Work lives go, children first. Their indexes (`alive_one_active_wake`, `alive_pending_actions`) belong to these tables and stay. */
export const ALIVE_SHARED_TABLES: readonly string[] = ["alive_actions", "alive_wakes", "alive_events", "alive_attachments", "alive_agents"];
const ALIVE_DOMAINS = "('work','one')";
const ALIVE_EVENT_TRIGGERS: readonly string[] = ["alive_events_no_update", "alive_events_no_delete"];
/** Rows one unit deletes at most (one transaction; a unit is one `DELETE` of a bounded number of rows, so Main is held for a few milliseconds, not for the whole history of a life). */
export const ALIVE_ROWS_PER_UNIT = 1_000;
export const ALIVE_LIVES_PER_UNIT = 100;

const hasTable = (db: Database.Database, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

/** The agents of the One and Work lives: in `alive_organism_lives`, or attached to the `work` / `one` domain - minus any agent that is also attached to another domain (those rows stay). */
function ownedLivesSql(db: Database.Database): string | null {
  const sources: string[] = [];
  if (hasTable(db, "alive_organism_lives")) sources.push("SELECT agent_id FROM alive_organism_lives");
  const attachments = hasTable(db, "alive_attachments");
  if (attachments) sources.push(`SELECT agent_id FROM alive_attachments WHERE domain IN ${ALIVE_DOMAINS}`);
  if (!sources.length) return null;
  return `SELECT agent_id FROM (${sources.join(" UNION ")})${attachments ? ` WHERE agent_id NOT IN (SELECT agent_id FROM alive_attachments WHERE domain NOT IN ${ALIVE_DOMAINS})` : ""}`;
}

/** Whether any Alive cleanup is left: a dedicated table exists, or a One / Work life still has a row in a shared table. Two cheap reads; nothing is written. */
export function aliveWorkLeft(db: Database.Database): boolean {
  try {
    const marks = ALIVE_DEDICATED_TABLES.map(() => "?").join(",");
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name IN (${marks}) LIMIT 1`).get(...ALIVE_DEDICATED_TABLES) !== undefined) return true;
    const owned = ownedLivesSql(db);
    if (!owned) return false;
    return ALIVE_SHARED_TABLES.some((table) => hasTable(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE agent_id IN (${owned}) LIMIT 1`).get() !== undefined);
  } catch { return false; }
}

/** Everything the migration's harness step still has to do (the AGI tables and the Alive tables). Reads only. */
export function harnessWorkLeft(db: Database.Database): boolean { return harnessTablesPresent(db).length > 0 || aliveWorkLeft(db); }

export interface AliveUnitResult {
  /** The table (or `alive_attachments+alive_agents`) this unit worked on; `none` when nothing was left. */
  unit: string;
  deleted: number;
  dropped: string[];
  ms: number;
  /** Nothing is left after this unit. */
  done: boolean;
  error?: string;
}

/**
 * One bounded unit of the Alive cleanup, in this order: the One / Work lives' rows in `alive_actions`, `alive_wakes`, `alive_events` (its two delete-forbidding triggers are
 * dropped and re-created from their own stored text inside the same transaction), then `alive_attachments` and `alive_agents` of up to 100 lives in one transaction, then the dedicated
 * tables one per unit with `alive_organism_lives` last. Every unit is one transaction, derives what to do from the tables themselves (no progress is kept), and is safe to run twice or to be killed:
 * a unit is whole or absent. Rows of any life that is not a One / Work life (Science) are never selected. Never throws.
 */
export function runAliveCleanupUnit(db: Database.Database, options: { rowsPerUnit?: number; livesPerUnit?: number; now?: () => number } = {}): AliveUnitResult {
  const clock = options.now ?? (() => performance.now());
  const started = clock();
  const result: AliveUnitResult = { unit: "none", deleted: 0, dropped: [], ms: 0, done: false };
  try {
    const rowsPerUnit = Math.max(1, options.rowsPerUnit ?? ALIVE_ROWS_PER_UNIT), livesPerUnit = Math.max(1, options.livesPerUnit ?? ALIVE_LIVES_PER_UNIT);
    const owned = ownedLivesSql(db);
    if (owned) {
      for (const table of ["alive_actions", "alive_wakes", "alive_events"]) {
        if (!hasTable(db, table)) continue;
        const left = db.prepare(`SELECT 1 FROM ${table} WHERE agent_id IN (${owned}) LIMIT 1`).get() !== undefined;
        if (!left) continue;
        const triggers = table === "alive_events"
          ? (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='alive_events' AND name IN (${ALIVE_EVENT_TRIGGERS.map(() => "?").join(",")})`).all(...ALIVE_EVENT_TRIGGERS) as Array<{ name: string; sql: string }>) : [];
        db.transaction(() => {
          for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
          result.deleted = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE agent_id IN (${owned}) LIMIT ?)`).run(rowsPerUnit).changes;
          for (const trigger of triggers) db.exec(trigger.sql);   // the original text, so the table ends exactly as it began
        }).immediate();
        result.unit = table;
        return finish(result, started, clock, db);
      }
      const lives = ["alive_attachments", "alive_agents"].some((table) => hasTable(db, table))
        ? (db.prepare(`SELECT agent_id AS id FROM (${owned}) WHERE ${[hasTable(db, "alive_attachments") ? "agent_id IN (SELECT agent_id FROM alive_attachments)" : "0", hasTable(db, "alive_agents") ? "agent_id IN (SELECT agent_id FROM alive_agents)" : "0"].join(" OR ")} LIMIT ?`).all(livesPerUnit) as Array<{ id: string }>).map((row) => row.id) : [];
      if (lives.length) {
        const marks = lives.map(() => "?").join(",");
        db.transaction(() => {
          if (hasTable(db, "alive_attachments")) result.deleted += db.prepare(`DELETE FROM alive_attachments WHERE agent_id IN (${marks})`).run(...lives).changes;
          if (hasTable(db, "alive_agents")) result.deleted += db.prepare(`DELETE FROM alive_agents WHERE agent_id IN (${marks})`).run(...lives).changes;
        }).immediate();
        result.unit = "alive_attachments+alive_agents";
        return finish(result, started, clock, db);
      }
    }
    // The shared tables hold no row of a One / Work life: the dedicated tables go, one per unit, `alive_organism_lives` last.
    for (const table of ALIVE_DEDICATED_TABLES) {
      if (!hasTable(db, table)) continue;
      assertAliveAllowList(table);
      const referenced = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>)
        .some((other) => other.name !== table && !ALIVE_DEDICATED_TABLES.includes(other.name) && new RegExp(`REFERENCES\\s+["\`\\[]?${table}\\b`, "i").test(other.sql));
      if (referenced) { result.error = "alive_referenced"; result.unit = table; return finish(result, started, clock, db); }
      db.transaction(() => { db.exec(`DROP TABLE IF EXISTS "${table}"`); }).immediate();
      result.unit = table;
      result.dropped.push(table);
      return finish(result, started, clock, db);
    }
    result.done = true;
    result.ms = clock() - started;
    return result;
  } catch (error) {
    result.error = String((error as { code?: string })?.code ?? (error as Error)?.message ?? "unexpected").slice(0, 80);
    result.ms = clock() - started;
    return result;
  }
}

function finish(result: AliveUnitResult, started: number, clock: () => number, db: Database.Database): AliveUnitResult {
  result.ms = clock() - started;
  result.done = !aliveWorkLeft(db);
  return result;
}

export function assertAliveAllowList(name: string): void {
  if (!ALIVE_DEDICATED_TABLES.includes(name)) throw new Error("harness_cleanup_name_refused");
}
