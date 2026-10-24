// One-off graphs One saves for a piece of work end with that work; they never stay on as standing automations.
//
// Owner design (2026-10-20): work done once runs and ends. Work that comes back with different inputs (find topics, then let the
// team discuss; monitor performance) is a graph that stays; a graph that has served three different inputs has proven that and is
// never switched off here. A Toolchain is something else: a deterministic tool for an app or page the agents keep operating by
// hand (toolchains/detector.ts). Measured on the owner's store before this existed:
// 39 of 68 automations were input-triggered graphs, 38 of them saved by one room's Goal turns
// (one-team.one_graph_save, renamed per episode), 37 still on, none with an end, a Goal or a run limit — the store's end
// conditions (markAutomationRun) only finish schedules.
//
// Lifetime of an input-triggered graph One saves (one/graph-dispatch.ts marks it here):
//   · saved while its conversation has an open Goal → switched off when that Goal is completed or cancelled;
//   · otherwise → switched off after EPHEMERAL_GRAPH_IDLE_DAYS without a run.
// Nothing is deleted. The row, its runs and this marker (with the reason and time it was switched off) stay. A graph
// switched off here that One saves again unchanged, or switches on, starts a fresh lifetime; a graph the owner switches
// back on by hand is left on. The first sweep also classifies graphs saved before this existed (same rules, the Goal
// that was open when each was created).

import { getDb } from "../store/db";
import { getAutomation, hasDurableActiveAutomationExecution, hasGraphLoginWait, isToolchainImplementationAutomation,
  listAutomations, toggleAutomation } from "../store/automations";
import type { Automation } from "../../shared/types";
import { graphPurpose } from "../../shared/graph-purpose";

const MARKER = "automation.ephemeral-graph.v1:";
const MIGRATION = "migration:ephemeral-command-graphs:v1";
const SWEEP_INTERVAL_MS = 3_600_000;
export const EPHEMERAL_GRAPH_IDLE_DAYS = 3;
/** Completed runs with this many different inputs make a graph recurring work, not an occasion. */
export const RECURRING_GRAPH_DISTINCT_INPUTS = 3;

export interface EphemeralGraphMarker {
  schemaVersion: "agentlas.ephemeral-graph.v1";
  /** The Goal open in the origin conversation when the graph was saved; the graph ends with it. Null: idle rule. */
  goalId: string | null;
  /** Start of the current lifetime (save, re-save of a switched-off graph, or switch-on by One). */
  markedAt: string;
  source: "one_graph_save" | "migration";
  disabledAt: string | null;
  disabledReason: "goal_ended" | "idle" | null;
}

export interface EphemeralSweepResult {
  migrated: { marked: number } | null;
  disabled: Array<{ automationId: string; reason: "goal_ended" | "idle" }>;
  /** Due but left on this round: running, waiting for a login, queued, or a step of an enabled graph. */
  held: Array<{ automationId: string; reason: string }>;
}

export function readEphemeralGraphMarker(automationId: string): EphemeralGraphMarker | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(`${MARKER}${automationId}`) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as EphemeralGraphMarker : null; } catch { return null; }
}

function writeMarker(automationId: string, marker: EphemeralGraphMarker): void {
  getDb().prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(`${MARKER}${automationId}`, JSON.stringify(marker));
}

/** The Goal open in a conversation now, or (for graphs saved before this existed) at a past moment. */
function goalOpenIn(chatId: string, at?: string): string | null {
  const db = getDb();
  if (!at) {
    const row = db.prepare(`SELECT goal_id FROM chat_goal_contracts WHERE chat_id=? AND status IN ('active','blocked')
      ORDER BY created_at DESC LIMIT 1`).get(chatId) as { goal_id: string } | undefined;
    return row?.goal_id ?? null;
  }
  const row = db.prepare(`SELECT goal_id FROM chat_goal_contracts WHERE chat_id=? AND created_at <= ?
      AND (status IN ('active','blocked') OR COALESCE(completed_at, updated_at) >= ?)
    ORDER BY created_at DESC LIMIT 1`).get(chatId, at, at) as { goal_id: string } | undefined;
  return row?.goal_id ?? null;
}

const isInputGraph = (a: Pick<Automation, "triggerType" | "graph">): boolean => a.triggerType === "command" && Boolean(a.graph?.nodes.length);

/** One saved (or switched on) an input-triggered graph in this conversation: start its lifetime. */
export function markOneGraphEphemeral(automation: Automation, chatId: string, now = new Date()): EphemeralGraphMarker | null {
  if (!isInputGraph(automation)) return null;
  const marker: EphemeralGraphMarker = { schemaVersion: "agentlas.ephemeral-graph.v1", goalId: goalOpenIn(chatId),
    markedAt: now.toISOString(), source: "one_graph_save", disabledAt: null, disabledReason: null };
  writeMarker(automation.id, marker);
  return marker;
}

/** Switched off by the lifetime rule (not by the owner): saving it again unchanged may switch it back on. */
export function ephemeralGraphSweptOff(automation: Automation): boolean {
  return !automation.enabled && Boolean(readEphemeralGraphMarker(automation.id)?.disabledAt);
}

/** Whether completed runs of this graph carried at least RECURRING_GRAPH_DISTINCT_INPUTS different inputs (dry runs do not count). */
export function reusedWithDifferentInputs(automationId: string): boolean {
  const rows = getDb().prepare(`SELECT payload_json FROM automation_trigger_events WHERE automation_id=? AND trigger_kind='command'
    AND run_outcome IN ('ok','partial') ORDER BY created_at DESC LIMIT 60`).all(automationId) as Array<{ payload_json: string }>;
  const inputs = new Set<string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { input?: unknown; dryRun?: unknown };
      if (payload.dryRun === true) continue;
      inputs.add(JSON.stringify(payload.input ?? {}));
    } catch { /* an unreadable event is no evidence */ }
  }
  return inputs.size >= RECURRING_GRAPH_DISTINCT_INPUTS;
}

interface CandidateRow { id: string; created_at: string; trigger_json: string | null }

/** Once per store: graphs One saved before lifetimes existed get one. */
function migrateExistingGraphs(now: Date): EphemeralSweepResult["migrated"] {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM meta WHERE key=?").get(MIGRATION)) return null;
  const rows = db.prepare(`SELECT id, created_at, trigger_json FROM automations
    WHERE trigger_type='command' AND created_by='agent' AND graph_json IS NOT NULL ORDER BY created_at`).all() as CandidateRow[];
  let marked = 0;
  const graphIds: string[] = [];
  db.transaction(() => {
    for (const row of rows) {
      let originChatId: string | null = null;
      try { originChatId = (JSON.parse(row.trigger_json ?? "{}") as { monitor?: { originChatId?: unknown } }).monitor?.originChatId as string ?? null; }
      catch { originChatId = null; }
      if (typeof originChatId !== "string" || !originChatId || isToolchainImplementationAutomation(row.id)) continue;
      const automation = getAutomation(row.id);
      if (!automation || !isInputGraph(automation)) continue;
      graphIds.push(row.id);
      if (!readEphemeralGraphMarker(row.id)) {
        writeMarker(row.id, { schemaVersion: "agentlas.ephemeral-graph.v1", goalId: goalOpenIn(originChatId, row.created_at),
          markedAt: row.created_at, source: "migration", disabledAt: null, disabledReason: null });
        marked++;
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(MIGRATION,
      JSON.stringify({ at: now.toISOString(), idleDays: EPHEMERAL_GRAPH_IDLE_DAYS, inputGraphs: graphIds.length, marked }));
  })();
  return { marked };
}

/** A step of an enabled graph keeps the graph it calls on: switching it off would break the parent. */
function graphsCalledByEnabledGraphs(): Set<string> {
  const called = new Set<string>();
  for (const automation of listAutomations()) {
    if (!automation.enabled) continue;
    for (const node of automation.graph?.nodes ?? []) {
      const ref = node.type === "subgraph" ? node.config?.graphRef : null;
      if (typeof ref === "string" && ref) called.add(ref);
    }
  }
  return called;
}

function goalEnded(goalId: string): boolean {
  const row = getDb().prepare("SELECT status FROM chat_goal_contracts WHERE goal_id=?").get(goalId) as { status: string } | undefined;
  // A Goal whose record is gone (its conversation was deleted) has ended too.
  return !row || row.status === "completed" || row.status === "cancelled";
}

export function sweepEphemeralGraphs(now = new Date()): EphemeralSweepResult {
  const migrated = migrateExistingGraphs(now);
  const db = getDb();
  const markers = db.prepare(`SELECT m.key, m.value FROM meta m JOIN automations a ON a.id = substr(m.key, ?)
    WHERE m.key >= ? AND m.key < ? AND a.enabled = 1 AND a.trigger_type = 'command'`)
    .all(MARKER.length + 1, MARKER, `${MARKER}￿`) as Array<{ key: string; value: string }>;
  const result: EphemeralSweepResult = { migrated, disabled: [], held: [] };
  if (!markers.length) return result;
  const called = graphsCalledByEnabledGraphs();
  const idleMs = EPHEMERAL_GRAPH_IDLE_DAYS * 86_400_000;
  for (const row of markers) {
    const automationId = row.key.slice(MARKER.length);
    let marker: EphemeralGraphMarker;
    try { marker = JSON.parse(row.value) as EphemeralGraphMarker; } catch { continue; }
    // Switched off here once and back on by the owner's own hand: the owner's choice stands.
    if (marker.disabledAt) continue;
    const automation = getAutomation(automationId);
    if (!automation?.enabled || !isInputGraph(automation)) continue;
    let reason: "goal_ended" | "idle" | null = null;
    if (marker.goalId) reason = goalEnded(marker.goalId) ? "goal_ended" : null;
    else {
      const last = Math.max(Date.parse(marker.markedAt) || 0, automation.lastRunAt ? Date.parse(automation.lastRunAt) || 0 : 0);
      reason = now.getTime() - last >= idleMs ? "idle" : null;
    }
    if (!reason) continue;
    const hold = isToolchainImplementationAutomation(automationId) ? "toolchain_implementation"
      : called.has(automationId) ? "called_by_enabled_graph"
      // Recurring work stays: AIs act on results again and again. A tool-like graph (code and tool steps only) does not earn
      // that by being reused; a reused tool is a Toolchain.
      : graphPurpose(automation.graph!, "input") === "workflow" && reusedWithDifferentInputs(automationId) ? "recurring_work"
      : hasDurableActiveAutomationExecution(automationId, now) || hasGraphLoginWait(automationId) ? "running"
      : db.prepare("SELECT 1 FROM automation_trigger_events WHERE automation_id=? AND status IN ('pending','claimed') LIMIT 1").get(automationId) ? "queued"
      : null;
    if (hold) { result.held.push({ automationId, reason: hold }); continue; }
    toggleAutomation(automationId, false);
    writeMarker(automationId, { ...marker, disabledAt: now.toISOString(), disabledReason: reason });
    result.disabled.push({ automationId, reason });
  }
  return result;
}

let lastSweepAt = 0;
/** Automation scheduler tick (Main): at most once an hour; the first tick after launch sweeps. Never throws. */
export function maybeSweepEphemeralGraphs(now = new Date()): EphemeralSweepResult | null {
  if (lastSweepAt && now.getTime() - lastSweepAt < SWEEP_INTERVAL_MS) return null;
  lastSweepAt = now.getTime();
  try {
    const result = sweepEphemeralGraphs(now);
    if (result.migrated || result.disabled.length) {
      console.info(`[automation] one-off graphs: ${result.migrated ? `classified ${result.migrated.marked}; ` : ""}`
        + `switched off ${result.disabled.length}${result.disabled.length ? ` (${result.disabled.map(item => `${item.automationId.slice(0, 8)}:${item.reason}`).join(", ")})` : ""}`
        + `${result.held.length ? `; held ${result.held.length}` : ""}`);
    }
    return result;
  } catch (error) {
    console.warn("[automation] one-off graph sweep deferred:", error instanceof Error ? error.message : error);
    return null;
  }
}
