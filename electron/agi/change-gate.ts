/**
 * AGI goal manager — the monitor's change gate.
 *
 * Every beat used to read every monitored goal's full typed facts (goal-facts.ts readAgiBlockerFacts: plan, readiness, the room's
 * fault scan, the episode signature), 500 goals at most, on Main each minute, although almost nothing had changed. This module
 * lets the monitor skip a goal whose inputs did not move:
 *
 *   1. readAgiGoalFingerprints — ONE statement per beat. Per goal it hashes every stored row the facts reader depends on, each
 *      through an indexed lookup (never a scan of a room's events): the long-run row's classifier columns, the newest long-run
 *      event seq, the Goal's controller attempt, the newest Goal revision, the plan head and its mutation epoch, the root chat
 *      row, its child chats, the newest room event of each kind the reader consults, the Goal's automations with their latest
 *      history/run rows; plus two global parts (the orchestrator pool and the newest failure event).
 *   2. A recheck instant per goal (goal-facts.ts reports it, see noteAgiFactsRecheck): the earliest moment a time-based fact could
 *      flip, never later than a 15 minute floor. A skipped goal is read again once that instant passes.
 *   3. Volatile goals are never skipped: a busy room, a turn that has not settled, a pending approval, an observation in flight.
 *      Those depend on in-memory state a fingerprint cannot see.
 *
 * In-memory only. A restart reads everything once. Nothing here changes what a full read returns.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { GOAL_CONTINUATION_PROMPT_MARKER } from "../store/goal-continuation-rows";

/** A skipped goal is read again after this long at the latest, whatever else is known (the "unsure" floor). */
export const AGI_RECHECK_FLOOR_MS = 15 * 60_000;

export interface AgiFactsRecheck {
  /** The earliest instant a time-based fact of this read could flip. Always finite (the floor bounds it). */
  recheckAtMs: number;
  /** The read depends on live in-memory state (a busy room, an unsettled turn, a pending approval): never skip it. */
  volatile: boolean;
  /**
   * A signature of the live in-memory inputs of the read that a stored row cannot show (is the room or a teammate chat busy right now, is
   * an effect observation running, is an approval pending). Taken again before a skip; a different value means the read is stale.
   */
  live?: () => string;
}

const recheckThunks = new WeakMap<object, () => AgiFactsRecheck>();
const recheckValues = new WeakMap<object, AgiFactsRecheck | null>();

/** goal-facts.ts registers how to compute the recheck of the facts object it returns. Lazily: other readers of facts pay nothing. */
export function noteAgiFactsRecheck(facts: object, compute: () => AgiFactsRecheck): void { recheckThunks.set(facts, compute); }

/** The recheck of a facts object that readAgiBlockerFacts produced. Undefined for any other facts: the caller must read them every beat. */
export function agiFactsRecheck(facts: object | null | undefined): AgiFactsRecheck | undefined {
  if (!facts) return undefined;
  if (recheckValues.has(facts)) return recheckValues.get(facts) ?? undefined;
  const thunk = recheckThunks.get(facts);
  if (!thunk) return undefined;
  let value: AgiFactsRecheck | null = null;
  try { value = thunk(); } catch { value = null; }
  recheckValues.set(facts, value);
  return value ?? undefined;
}

export interface AgiGoalFingerprint {
  fingerprint: string;
  /** Ids of the automations bound to the goal (automations.goal_id) when the fingerprint was taken. */
  automationIds: readonly string[];
}

export interface AgiGateEntry {
  fingerprint: string;
  automationIds: readonly string[];
  /** Skip the goal until this instant (exclusive), unless its fingerprint moves first. */
  recheckAtMs: number;
  /** The last classification read signals, a hold or an attempt: runtime and capability changes may move it. */
  runtimeSensitive: boolean;
  /** The live inputs' signature when the goal was read, and how to take it again. */
  liveProbe?: () => string;
  liveAtRead?: string;
}

/** Why a goal must be read now, or null when the cached read still stands. Pure: the monitor and the gate script share it. */
export function agiGateReadReason(entry: AgiGateEntry | undefined, fingerprint: AgiGoalFingerprint | undefined, nowMs: number):
  "no-entry" | "no-fingerprint" | "fingerprint-changed" | "recheck-due" | "live-changed" | null {
  if (!entry) return "no-entry";
  if (!fingerprint) return "no-fingerprint";
  if (entry.fingerprint !== fingerprint.fingerprint) return "fingerprint-changed";
  if (!(nowMs < entry.recheckAtMs)) return "recheck-due";
  // A clock set back would otherwise hold a read past the floor: no cached read outlives the floor from now.
  if (entry.recheckAtMs - nowMs > AGI_RECHECK_FLOOR_MS) return "recheck-due";
  if (entry.liveProbe) { try { if (entry.liveProbe() !== entry.liveAtRead) return "live-changed"; } catch { return "live-changed"; } }
  return null;
}

/** The monitored goals an `automation` store event can concern. Null id: the writer did not say, so every goal. */
export function agiAutomationEventTargets(goalIds: Iterable<string>, entries: ReadonlyMap<string, AgiGateEntry>, automationId: string | undefined,
  boundGoalId: string | null | "unknown"): string[] {
  const all = [...goalIds];
  if (!automationId || boundGoalId === "unknown") return all;
  // A goal without a cached read is read next beat anyway; reading it now keeps today's promptness for those.
  return all.filter((goalId) => { const entry = entries.get(goalId); return !entry || goalId === boundGoalId || entry.automationIds.includes(automationId); });
}

/** The monitored goals a `runtime` or `capability-grant` event can concern: those without a cached read and those whose last read had a state to change.
 *  Correct only while the facts reader reads no runtime or grant state (today it reads neither): adding one means routing these events to every goal. */
export function agiRuntimeEventTargets(goalIds: Iterable<string>, entries: ReadonlyMap<string, AgiGateEntry>): string[] {
  return [...goalIds].filter((goalId) => { const entry = entries.get(goalId); return !entry || entry.runtimeSensitive; });
}

// ── the fingerprint statement ──────────────────────────────────────────────────────────────────────────────────────────────────

const WANTED_TABLES = ["long_runs", "long_run_events", "long_run_worker_attempts", "long_run_workers", "chat_goal_revisions", "goal_plan_decisions",
  "goal_plan_mutations", "chats", "run_events", "automations", "run_history", "automation_runs", "model_role_members", "failure_events",
  "one_team_dispatches", "goal_episode_captures", "goal_episode_dispositions"] as const;
/** Room event kinds the facts reader consults (browser ladder, continuation notices, wake and wait receipts, turn ends, tool faults). */
const ROOM_EVENT_KINDS = ["browser_fallback_ladder", "mcp_notice", "goal_wake_started", "goal_wait_refused", "goal_wait_registered", "invoke_started",
  "invoke_completed", "invoke_failed", "invoke_threw", "mcp_error", "mcp_tool-use", "invoke_waiting", "mcp_final", "invoke_cancelled",
  "invoke_interrupted", "runtime_effect_boundary"] as const;
/** long_runs columns the facts and the classifier read (cycle_count, cost_used_usd, app_instance_id and host_owner_kind are excluded by the reader itself). */
const LONG_RUN_COLUMNS = ["status", "pause_reason", "blocked_reason", "version", "stall_streak", "stall_window", "runtime_fallback_policy", "max_cycles",
  "max_cost_usd", "max_workers", "wallclock_deadline", "last_progress_key", "root_chat_id", "surface", "execution_location"] as const;
const CHAT_COLUMNS = ["goal_id", "runtime_selection_json", "parent_chat_id", "archived_at", "kind", "title", "origin_surface", "agent_id"] as const;
const POOL_COLUMNS = ["position", "kind", "backend", "source", "model", "effort", "long_context"] as const;

interface BuiltStatement { key: string; stmt: Database.Statement; pool: Database.Statement | null; failures: Database.Statement | null }
const built = new WeakMap<Database.Database, BuiltStatement>();

const US = "char(31)";
const nz = (expr: string) => `COALESCE(${expr},'')`;

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

function buildStatement(db: Database.Database, tables: ReadonlySet<string>): BuiltStatement | null {
  if (!tables.has("long_runs")) return null;
  const columns = new Map<string, Set<string>>();
  for (const table of tables) columns.set(table, columnsOf(db, table));
  const has = (table: string, ...names: string[]) => tables.has(table) && names.every((name) => columns.get(table)!.has(name));
  const parts: string[] = [];
  for (const name of LONG_RUN_COLUMNS) if (has("long_runs", name)) parts.push(nz(`r.${name}`));
  if (has("long_run_events", "run_id", "seq")) parts.push(nz("(SELECT MAX(seq) FROM long_run_events e WHERE e.run_id=r.id)"));
  if (has("long_run_worker_attempts", "run_id", "worker_id", "invocation_run_id", "started_at") && has("long_run_workers", "id", "role"))
    parts.push(nz(`(SELECT a.id||':'||COALESCE(a.invocation_run_id,'') FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id=a.worker_id
      WHERE a.run_id=r.id AND w.role='controller' ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1)`));
  if (has("chat_goal_revisions", "goal_id", "revision")) parts.push(nz("(SELECT MAX(revision) FROM chat_goal_revisions v WHERE v.goal_id=r.goal_id)"));
  if (has("goal_plan_decisions", "goal_id", "revision", "plan_seq", "kind")) {
    const epoch = has("goal_plan_mutations", "goal_id", "revision", "plan_seq", "epoch")
      ? "COALESCE((SELECT m.epoch FROM goal_plan_mutations m WHERE m.goal_id=d.goal_id AND m.revision=d.revision AND m.plan_seq=d.plan_seq),0)" : "0";
    parts.push(nz(`(SELECT d.revision||'.'||d.plan_seq||'.'||${epoch}||'.'||COALESCE((SELECT c.id FROM goal_plan_decisions c
      WHERE c.goal_id=d.goal_id AND c.revision=d.revision AND c.plan_seq=d.plan_seq ORDER BY c.rowid DESC LIMIT 1),'')
      FROM goal_plan_decisions d WHERE d.goal_id=r.goal_id AND d.kind IN ('shape','shape_fallback') ORDER BY d.revision DESC, d.plan_seq DESC LIMIT 1)`));
  }
  if (tables.has("chats") && has("chats", "id")) {
    const chatColumns = CHAT_COLUMNS.filter((name) => has("chats", name));
    if (chatColumns.length) parts.push(nz(`(SELECT ${chatColumns.map((name) => nz(`c.${name}`)).join(`||${US}||`)} FROM chats c WHERE c.id=r.root_chat_id)`));
    if (has("chats", "parent_chat_id", "updated_at"))
      parts.push(nz("(SELECT COUNT(*)||':'||COALESCE(MAX(k.updated_at),'') FROM chats k WHERE k.parent_chat_id=r.root_chat_id)"));
  }
  if (has("run_events", "chat_id", "kind", "ts")) {
    for (const kind of ROOM_EVENT_KINDS)
      parts.push(nz(`(SELECT x.ts||'#'||x.rowid FROM run_events x WHERE x.chat_id=r.root_chat_id AND x.kind='${kind}' ORDER BY x.ts DESC LIMIT 1)`));
  }
  let join = "";
  let automationIds = "''";
  if (has("automations", "id", "goal_id", "enabled", "next_run_at", "prompt_template")) {
    const history = has("run_history", "automation_id", "status")
      ? `(SELECT ${["status", "ran_at", "outcome"].filter((name) => has("run_history", name)).map((name) => nz(`h.${name}`)).join(`||${US}||`)}||${US}||h.rowid
          FROM run_history h WHERE h.automation_id=a.id ORDER BY h.rowid DESC LIMIT 1)` : "''";
    const runs = has("automation_runs", "automation_id", "started_at") ? "(SELECT MAX(u.started_at) FROM automation_runs u WHERE u.automation_id=a.id)" : "''";
    const row = [nz("a.id"), nz("a.enabled"), nz("a.next_run_at"), has("automations", "last_run_at") ? nz("a.last_run_at") : "''",
      `(COALESCE(instr(a.prompt_template,'${GOAL_CONTINUATION_PROMPT_MARKER}'),0)>0)`, has("automations", "created_at") ? nz("a.created_at") : "''", nz(history), nz(runs)]
      .join(`||${US}||`);
    join = `LEFT JOIN (SELECT a.goal_id AS goal_id, group_concat(${row}, char(30)) AS sig, group_concat(a.id, char(30)) AS ids
      FROM automations a WHERE a.goal_id IS NOT NULL GROUP BY a.goal_id) am ON am.goal_id=r.goal_id`;
    parts.push(nz("am.sig"));
    automationIds = nz("am.ids");
  }
  const stmt = db.prepare(`SELECT r.goal_id AS goal_id, ${parts.join(`||${US}||`)} AS fp, ${automationIds} AS ids FROM long_runs r ${join}
    WHERE r.goal_id IN (SELECT value FROM json_each(?))`);
  const poolColumns = POOL_COLUMNS.filter((name) => has("model_role_members", name));
  const pool = has("model_role_members", "role") && poolColumns.length
    ? db.prepare(`SELECT ${poolColumns.map((name) => nz(name)).join(`||${US}||`)} AS member FROM model_role_members WHERE role='orchestrator' ORDER BY position`) : null;
  // Shared parts any goal's facts can depend on: a failure anywhere, teammate dispatches (teamAvailable reads them) and the
  // episode quiet baseline (captures and dispositions). Each is one indexed MAX; a change re-reads every goal once.
  const shared = [
    tables.has("failure_events") ? "COALESCE((SELECT MAX(rowid) FROM failure_events), 0)" : null,
    tables.has("one_team_dispatches") ? "COALESCE((SELECT MAX(rowid) FROM one_team_dispatches), 0) || ':' || COALESCE((SELECT MAX(updated_at) FROM one_team_dispatches), '')" : null,
    tables.has("goal_episode_captures") ? "COALESCE((SELECT MAX(rowid) FROM goal_episode_captures), 0)" : null,
    tables.has("goal_episode_dispositions") ? "COALESCE((SELECT MAX(rowid) FROM goal_episode_dispositions), 0)" : null,
  ].filter((part): part is string => part !== null);
  const failures = shared.length ? db.prepare(`SELECT ${shared.join(" || '/' || ")} AS n`) : null;
  return { key: [...tables].sort().join(","), stmt, pool, failures };
}

/**
 * One fingerprint per monitored goal that has a long-run row. A goal that is not in the result has no row (the facts reader returns
 * null for it). Throws when the store cannot answer; the caller then reads every goal this beat.
 */
export function readAgiGoalFingerprints(db: Database.Database, goalIds: readonly string[]): Map<string, AgiGoalFingerprint> {
  const out = new Map<string, AgiGoalFingerprint>();
  if (goalIds.length === 0) return out;
  const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (SELECT value FROM json_each(?))")
    .pluck().all(JSON.stringify(WANTED_TABLES)) as string[]));
  const key = [...present].sort().join(",");
  let statement = built.get(db);
  if (!statement || statement.key !== key) {
    const next = buildStatement(db, present);
    if (!next) return out;
    built.set(db, next); statement = next;
  }
  // The parts shared by every goal: the orchestrator pool (a runtime change) and the newest failure event (the episode signature reads it).
  const shared = createHash("sha1").update(JSON.stringify([
    statement.pool ? (statement.pool.pluck().all() as string[]) : null,
    statement.failures ? (statement.failures.get() as { n: string | number | null }).n : null])).digest("hex");
  for (const row of statement.stmt.all(JSON.stringify(goalIds)) as Array<{ goal_id: string; fp: string | null; ids: string | null }>) {
    out.set(row.goal_id, { fingerprint: createHash("sha1").update(shared).update("\u0000").update(row.fp ?? "").digest("hex"),
      automationIds: row.ids ? row.ids.split("\u001e") : [] });
  }
  return out;
}
