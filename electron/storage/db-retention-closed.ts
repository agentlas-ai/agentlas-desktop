import type Database from "better-sqlite3";
import { DB_RETENTION_LIMITS, DB_RETENTION_POLICY, type ClosedRowSpec } from "./db-retention-policy";

/**
 * Executor of the `delete-closed` rules of db-retention-policy.ts: delivery and ledger rows whose work is over. One generic
 * routine; the per-table knowledge (final states, clock columns, kept custody rows, child tables) is data in the policy.
 *
 * One batch = one IMMEDIATE transaction over one table: pick up to `closedBatchRows` rows by the full predicate, delete their
 * child rows, then delete the rows with the same predicate again (so a row that went back to work cannot be removed). Rows
 * are picked by rowid, never by an ordering, so no sort is built. Specs run in policy order: children tables listed before
 * the tables that reference them.
 */

const DAY_MS = 86_400_000;

export interface ClosedPurgeState {
  /** Index into the delete-closed rules of the policy. */
  index: number;
  deleted: Record<string, number>;
  /** Tables left alone because the store lacks the table or a column of an older shape. */
  skipped: string[];
}

export const newClosedPurgeState = (): ClosedPurgeState => ({ index: 0, deleted: {}, skipped: [] });

interface ClosedRule { id: string; table: string; spec: ClosedRowSpec }

export function closedRules(): ClosedRule[] {
  const out: ClosedRule[] = [];
  for (const rule of DB_RETENTION_POLICY) if (rule.action.type === "delete-closed") out.push({ id: rule.id, table: rule.table, spec: rule.action.spec });
  return out;
}

const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`db_retention_identifier:${name}`);
  return name;
};
const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function columnsOf(db: Database.Database, table: string): Set<string> | null {
  const rows = db.prepare(`PRAGMA table_info(${ident(table)})`).all() as Array<{ name: string }>;
  return rows.length ? new Set(rows.map((row) => row.name)) : null;
}

/** The WHERE over alias `t` and its bound cutoff; null when this store lacks what the spec reads. */
export function closedPredicate(db: Database.Database, table: string, spec: ClosedRowSpec, now: number): { where: string; cutoff: string | number } | null {
  const own = columnsOf(db, table);
  if (!own || spec.requires.some((column) => !own.has(column))) return null;
  for (const child of spec.children ?? []) {
    const columns = columnsOf(db, child.table);
    if (columns && !columns.has(child.column)) return null;
  }
  const cutoff = spec.timeUnit === "ms" ? now - spec.days * DAY_MS : new Date(now - spec.days * DAY_MS).toISOString();
  const empty = spec.timeUnit === "ms" ? "0" : "''";
  const parts = [
    ...(spec.stateColumn && spec.closedStates ? [`t.${ident(spec.stateColumn)} IN (${spec.closedStates.map(quote).join(", ")})`] : []),
    ...(spec.closedWhen ? [spec.closedWhen] : []),
    ...(spec.keepWhen ?? []).filter((keep) => columnsOf(db, keep.table) !== null).map((keep) => `NOT (${keep.sql})`),
    ...spec.timeColumns.map((column) => `COALESCE(t.${ident(column)}, ${empty}) < @cutoff`),
  ];
  return { where: parts.join(" AND "), cutoff };
}

/** One batch of the rule at `state.index`; advances the index when the rule has no more rows. `done` when every rule is drained. */
export function purgeClosedBatch(db: Database.Database, now: number, state: ClosedPurgeState): { deleted: number; done: boolean } {
  const rules = closedRules();
  if (state.index >= rules.length) return { deleted: 0, done: true };
  const rule = rules[state.index]!;
  const { table, spec } = rule;
  const predicate = closedPredicate(db, table, spec, now);
  if (!predicate) {
    state.skipped.push(table);
    state.index += 1;
    return { deleted: 0, done: state.index >= rules.length };
  }
  const limit = DB_RETENTION_LIMITS.closedBatchRows;
  const parentColumns = [...new Set((spec.children ?? []).map((child) => child.parentColumn))];
  const pick = db.prepare(`SELECT t.rowid AS rid${parentColumns.map((column, i) => `, t.${ident(column)} AS p${i}`).join("")}
    FROM ${ident(table)} t WHERE ${predicate.where} LIMIT ${limit}`);
  const remove = db.prepare(`DELETE FROM ${ident(table)} AS t WHERE t.rowid IN (SELECT value FROM json_each(@ids)) AND ${predicate.where}`);
  let removed = 0;
  let picked = 0;
  db.transaction(() => {
    const rows = pick.all({ cutoff: predicate.cutoff }) as Array<Record<string, unknown>>;
    picked = rows.length;
    if (!rows.length) return;
    for (const child of spec.children ?? []) {
      if (!columnsOf(db, child.table)) continue;
      const at = parentColumns.indexOf(child.parentColumn);
      const keys = [...new Set(rows.map((row) => row[`p${at}`]).filter((value) => value !== null && value !== undefined))];
      if (keys.length) db.prepare(`DELETE FROM ${ident(child.table)} WHERE ${ident(child.column)} IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keys));
    }
    removed = Number(remove.run({ ids: JSON.stringify(rows.map((row) => row.rid)), cutoff: predicate.cutoff }).changes);
  }).immediate();
  if (removed > 0) state.deleted[table] = (state.deleted[table] ?? 0) + removed;
  if (picked < limit || removed === 0) state.index += 1;
  return { deleted: removed, done: state.index >= rules.length };
}
