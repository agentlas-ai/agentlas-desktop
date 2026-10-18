/**
 * AGI goal manager, P1 — read one goal's typed blocker facts from the ledger (no model, no prose).
 *
 * Every signal here is a recorded host fact (long_runs status/reason codes, long_run_events kinds, attempt rows,
 * automation schedule rows, the receipt of the Goal's own controller turn). Elapsed idle time is never a signal (owner correction
 * 2026-09-28: "시간으로 보면 안 되고 … 명시적 멈춤이 멈춤"). The one schedule fact is missed_due_run: the goal's
 * schedule row says a run was due, the due time has passed by more than the scheduler's own grace, and no run
 * started since — that is a recorded miss, not idleness.
 *
 * The DB handle and the few live-state edges (chat busy, live receipts, continuation park) are injected so the
 * contracts can drive the real queries on an in-memory store.
 */
import { projectGoalPlanReadiness, type PlanReadiness } from "../../shared/goal-shape";
import { readEpisodeQuietBaseline } from "../long-run/episode-disposition";
import { getDb } from "../store/db";
import { getInvocationRunReceipt } from "../store/run-events";
import { readGoalPlan } from "../store/goal-plans";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isGoalObserving } from "../long-run/effect-observation-tickets";
import type { AgiBlockerFacts, AgiBlockerSignal, AgiTacticFact } from "./blocker";

/** The scheduler ticks every minute; a due slot missed by more than this with no run started is a miss. */
export const AGI_MISSED_DUE_GRACE_MS = 5 * 60_000;

/** goal_wait_* codes that mean "the host refused to register the wait" (not an effect/claim reconciliation). */
const WAIT_REFUSAL = /^goal_wait_(?!claimed_|restored|registered|replan_started)[a-z_]+$/;
const OWNER_QUESTION = new Set(["goal_owner_answer_required", "auto_goal_owner_review_required"]);

/** A turn receipt as the AGI reads it: status and the typed error only. */
export type AgiTurnReceipt = { status: string; errorCode: string | null; runId?: string | null; errorMessage?: string | null };

export interface AgiGoalFactsDeps {
  db: Database.Database;
  /** Internal baseline read must not consume the receipt it is constructing. */
  episodeBaselineOnly?: boolean;
  nowMs(): number;
  /**
   * Live receipt of the goal chat's current foreground turn (invocation service). Read only when that turn is the
   * Goal's own controller invocation (goalControllerAttempt): another turn of the room is never the Goal's receipt.
   */
  latestReceipt?(chatId: string): AgiTurnReceipt | null;
  /** Live receipt of one exact invocation (invocation service). Absent: the durable run ledger. */
  runReceipt?(runId: string): AgiTurnReceipt | null;
  /** The chat has a turn in flight right now: the goal owns its step. */
  chatBusy?(chatId: string): boolean;
  /** goal-continuation-hold parked the continuation row on needs_input. */
  continuationParkedForOwner?(goalId: string): boolean;
  /** A pending tool approval in the goal chat (an owner consent, surfaced by its own card). */
  pendingApproval?(chatId: string): boolean;
}

export interface AgiGoalRow {
  id: string; goalId: string; surface: string; rootChatId: string | null; status: string; pauseReason: string | null;
  blockedReason: string | null; version: number; stallStreak: number; stallWindow: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * The Goal's own turn: its newest controller attempt and the invocation that ran it. The room's newest run and the
 * newest attempt of any role are not: a teammate's report turn, an owner's side question and a relay the waiting Goal
 * refused are foreground runs of the same room, task-force specialists share the controller's invocation and a
 * verifier runs under its own id (flow audit ID-2, production Yotube 10-14..10-18: 73 of 108 foreground runs bound a
 * controller attempt; the incident `run:d85e262f` named an owner run that never became the Goal's turn).
 */
export function goalControllerAttempt(db: Database.Database, longRunId: string): { id: string; invocationRunId: string | null } | null {
  if (!tableExists(db, "long_run_worker_attempts") || !tableExists(db, "long_run_workers")) return null;
  const row = db.prepare(`SELECT a.id, a.invocation_run_id FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id = a.worker_id
    WHERE a.run_id = ? AND w.role = 'controller' ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1`)
    .get(longRunId) as { id: string; invocation_run_id: string | null } | undefined;
  return row ? { id: row.id, invocationRunId: row.invocation_run_id } : null;
}

/** The receipt of the Goal's own controller turn (exact key), live when the host can say so. */
function goalTurnReceipt(deps: AgiGoalFactsDeps, longRunId: string, chatId: string | null): AgiTurnReceipt | null {
  const runId = goalControllerAttempt(deps.db, longRunId)?.invocationRunId;
  if (!runId) return null;
  if (deps.runReceipt) return deps.runReceipt(runId);
  const live = chatId ? deps.latestReceipt?.(chatId) ?? null : null;
  if (live?.runId === runId) return live;
  const durable = getInvocationRunReceipt(runId);
  return durable ? { runId: durable.runId, status: durable.status, errorCode: durable.errorCode ?? null,
    errorMessage: durable.errorMessage ?? null } : null;
}

export function readAgiGoalRow(db: Database.Database, goalId: string): AgiGoalRow | null {
  const row = db.prepare(`SELECT id, goal_id, surface, root_chat_id, status, pause_reason, blocked_reason, version, stall_streak, stall_window
    FROM long_runs WHERE goal_id = ?`).get(goalId) as {
    id: string; goal_id: string; surface: string; root_chat_id: string | null; status: string; pause_reason: string | null;
    blocked_reason: string | null; version: number; stall_streak: number; stall_window: number } | undefined;
  return row ? { id: row.id, goalId: row.goal_id, surface: row.surface, rootChatId: row.root_chat_id, status: row.status,
    pauseReason: row.pause_reason, blockedReason: row.blocked_reason, version: row.version,
    stallStreak: row.stall_streak ?? 0, stallWindow: row.stall_window ?? 3 } : null;
}

/** One/Work goals the desktop owns and that are not finished (plan D3: the monitor watches every goal). */
export function listAgiMonitoredGoalIds(db: Database.Database, limit = 500): string[] {
  return (db.prepare(`SELECT goal_id FROM long_runs WHERE surface IN ('one','work')
      AND status NOT IN ('completed','failed','cancelled','draft')
      AND (execution_location IS NULL OR execution_location = 'desktop-local')
    ORDER BY updated_at DESC LIMIT ?`).all(limit) as Array<{ goal_id: string }>).map((row) => row.goal_id);
}

function ownerHold(db: Database.Database, runId: string): boolean {
  const row = db.prepare(`SELECT
      (SELECT MAX(seq) FROM long_run_events WHERE run_id = ? AND kind = 'run.user_control' AND actor_kind = 'user'
        AND (json_extract(payload_json, '$.action') = 'pause' OR json_extract(payload_json, '$.command') = 'pause')) AS paused,
      (SELECT MAX(seq) FROM long_run_events WHERE run_id = ? AND (
        (kind = 'run.user_control' AND actor_kind = 'user'
          AND (json_extract(payload_json, '$.action') = 'resume_with_message' OR json_extract(payload_json, '$.command') = 'resume'))
        OR (kind = 'run.status_changed' AND actor_kind = 'user' AND json_extract(payload_json, '$.to') IN ('queued', 'running')))) AS released`)
    .get(runId, runId) as { paused: number | null; released: number | null } | undefined;
  return typeof row?.paused === "number" && (typeof row.released !== "number" || row.paused > row.released);
}

function tactics(db: Database.Database, goalId: string, nowMs: number): { tactics: AgiTacticFact[]; blockedNodeId: string | null; readiness?: PlanReadiness } {
  if (!tableExists(db, "goal_plan_nodes") || !tableExists(db, "goal_plan_decisions")) return { tactics: [], blockedNodeId: null };
  const plan = readGoalPlan(goalId, undefined, db);
  if (!plan) return { tactics: [], blockedNodeId: null };
  const readiness = projectGoalPlanReadiness(plan, { nowMs });
  // A tactic the agent reported blocked carries the persistence policy's guidance until it is done (goal-shaping
  // applyTacticMarker). Nothing ever wrote payload.blocked, so this fact was always null (production 2026-10-12:
  // 0 of 138 tactics, while 31 open tactics carried guidance) and the unblocker never knew which tactic was stuck.
  const blocked = db.prepare(`SELECT node_id FROM goal_plan_nodes WHERE goal_id=? AND revision=? AND plan_seq=?
    AND kind='tactic' AND status IN ('active','proposed')
    AND CASE WHEN json_valid(payload_json) THEN json_type(payload_json,'$.guidance')='object' ELSE 0 END ORDER BY ord LIMIT 1`).get(goalId, plan.revision, plan.planSeq) as { node_id: string } | undefined;
  return { blockedNodeId: blocked?.node_id ?? null, readiness, tactics: plan.tactics.map(t => ({ nodeId: t.id,
    status: t.status, dependsOn: t.depends_on, readiness: readiness.branches.find(branch => branch.nodeId === t.id) })) };
}

function missedDueRun(db: Database.Database, goalId: string, nowMs: number): string | null {
  if (!tableExists(db, "automations")) return null;
  const automation = db.prepare("SELECT id, enabled, next_run_at FROM automations WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(goalId) as { id: string; enabled: number; next_run_at: string | null } | undefined;
  if (!automation || automation.enabled !== 1 || !automation.next_run_at) return null;
  const dueMs = Date.parse(automation.next_run_at);
  if (!Number.isFinite(dueMs) || nowMs - dueMs <= AGI_MISSED_DUE_GRACE_MS) return null;
  if (tableExists(db, "automation_runs")) {
    const started = db.prepare("SELECT MAX(started_at) AS at FROM automation_runs WHERE automation_id = ?").get(automation.id) as { at: string | null };
    if (started.at && Date.parse(started.at) >= dueMs) return null;
  }
  return automation.next_run_at;
}

/**
 * The browser fallback ladder's last word in this chat (electron/browser/fallback-ladder.ts): a stop or an owner
 * wait that no later successful agentlas-browser call has superseded. Typed fields only (run_events payload).
 */
export function browserLadderSignal(db: Database.Database, chatId: string, nowMs: number): { signal: AgiBlockerSignal; ref: string } | null {
  if (!tableExists(db, "run_events")) return null;
  const since = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  const row = db.prepare(`SELECT id, ts, json_extract(payload_json, '$.code') AS code, json_extract(payload_json, '$.final') AS final,
    json_extract(payload_json, '$.reasonCode') AS reasonCode, json_extract(payload_json, '$.site') AS site
    FROM run_events WHERE chat_id = ? AND kind = 'browser_fallback_ladder' AND ts >= ?
    AND json_extract(payload_json, '$.step') = 'final' ORDER BY ts DESC LIMIT 1`)
    .get(chatId, since) as { id: string; ts: string; code: string | null; final: string | null; reasonCode: string | null; site: string | null } | undefined;
  if (!row || !row.code || (row.final !== "stopped" && row.final !== "waiting-owner")) return null;
  const later = db.prepare(`SELECT 1 FROM run_events WHERE chat_id = ? AND kind = 'mcp_tool-use' AND ts > ?
    AND json_extract(payload_json, '$.toolName') LIKE 'agentlas-browser.%'
    AND json_extract(payload_json, '$.runtimeEvidence.phase') = 'executed' LIMIT 1`).get(chatId, row.ts);
  if (later) return null;
  const ref = `run_event:${row.id}`;
  if (row.code === "human-check-required") {
    // A site's human check is the owner's (never solved or bypassed); its card is already open.
    return { signal: { kind: "boundary", boundary: "security_consent", code: "human_check_required" }, ref };
  }
  if (row.code === "login-wall") {
    const domain = typeof row.site === "string" && /^[a-z0-9.-]+$/i.test(row.site) ? row.site : "unknown";
    return { signal: { kind: "login_wall", domain, sourceSession: "unknown" }, ref };
  }
  if (row.final !== "stopped") return null;
  return { signal: { kind: "browser_unavailable", code: `browser_ladder:${row.code}` }, ref };
}

/**
 * The start or the runner threw: the receipt's code is a generic wrapper and the typed cause is the message's leading
 * code (production 2026-10-12: invoke-start-failed with "goal_waiting_system_start_refused" 49 times, runner-failed with
 * "automation_goal_execution_owner_changed" or "goal_episode_admission_missing"). Without it every such run read as
 * run_failed_unknown. A host timeout message is kept as a timeout family.
 */
const RECEIPT_WRAPPER_CODES = new Set(["invoke-start-failed", "runner-failed", "invoke-threw"]);
function typedReceiptCode(receipt: { errorCode: string | null; errorMessage?: string | null }): string | null {
  const code = receipt.errorCode;
  if (!code || !RECEIPT_WRAPPER_CODES.has(code) || !receipt.errorMessage) return code;
  const message = receipt.errorMessage.trim();
  const token = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=$|[\s:])/.exec(message)?.[1];
  if (token) return token;
  return /\btime(?:d)? ?out\b/i.test(message) ? `${code}:timeout` : code;
}

/**
 * Refusals that are the host keeping a waiting Goal waiting, not a failure of the Goal: a system turn arriving while the
 * Goal waits for its owner or a scheduled retry is refused before any model call (relays are parked and carried by the
 * next real turn). Read as a failure, each one opened a run_failed_unknown incident (43 of 60 in production) and the
 * unblocker answered with another work turn that was refused the same way.
 */
const NOT_A_GOAL_FAILURE = new Set(["goal_waiting_system_start_refused"]);

/** Map a turn receipt error code to the specific typed signal it names (code families only). */
function receiptSignal(code: string, runId: string | null): AgiBlockerSignal {
  if (/cdp|browser_unavailable|browser_target_closed|agentlas_browser_unreachable/.test(code)) return { kind: "browser_unavailable", code };
  if (/login_wall|signin_required|sign_in_required/.test(code)) return { kind: "login_wall", domain: "unknown", sourceSession: "unknown" };
  if (/^(pre_run|preflight|gate)_/.test(code) || /_gate_refused$/.test(code)) return { kind: "pre_run_refused", code };
  return { kind: "run_failed", code, runId };
}

/** Only accepted Goal sources and in-scope host receipts wake a spent incident. Role=user and chat-wide
 * tool history are not provenance. Version, heartbeat, diagnostic notices and retry timestamps are excluded. */
function wakeState(db: Database.Database, run: AgiGoalRow, nowMs: number): Pick<AgiBlockerFacts, "progress" | "nextWakeAtMs" | "fenceState"> {
  const revision = tableExists(db, "chat_goal_revisions") ? db.prepare(
    "SELECT revision,source_message_id,payload_json,created_at FROM chat_goal_revisions WHERE goal_id=? ORDER BY revision DESC LIMIT 1")
    .get(run.goalId) as { revision: number; source_message_id: string; payload_json: string; created_at: string } | undefined : undefined;
  const control = db.prepare("SELECT seq FROM long_run_events WHERE run_id=? AND kind='run.user_control' AND actor_kind='user' ORDER BY seq DESC LIMIT 1")
    .get(run.id) as { seq: number } | undefined;
  // Newest completed worker effect since the revision. Read per kind so each walks
  // idx_run_events_chat_kind_ts backwards and stops at the first match; the IN-list form
  // sorted every tool event of the room (28k in Youtube launch) on each monitor tick.
  const completedEffect = (kind: string, extra: string) => db.prepare(`SELECT e.id, e.ts, e.seq FROM run_events e
    WHERE e.chat_id=? AND e.kind=? AND e.ts>=? ${extra}
    AND EXISTS(SELECT 1 FROM long_run_worker_attempts a WHERE a.run_id=? AND a.invocation_run_id=e.run_id)
    ORDER BY e.ts DESC,e.seq DESC LIMIT 1`).get(run.rootChatId, kind, revision?.created_at ?? "", run.id) as { id: string; ts: string; seq: number } | undefined;
  const complete = tableExists(db, "run_events") && tableExists(db, "long_run_worker_attempts") ? (() => {
    const boundary = completedEffect("runtime_effect_boundary", "");
    const tool = completedEffect("mcp_tool-use", "AND json_extract(e.payload_json,'$.toolCompleted')=1");
    if (!boundary || !tool) return boundary ?? tool;
    return tool.ts > boundary.ts || tool.ts === boundary.ts && tool.seq > boundary.seq ? tool : boundary;
  })() : undefined;
  // Column selection permits older schema fixtures without treating a timestamp as a policy change.
  const row = (table: string, names: string[], where: string, args: unknown[]) => {
    if (!tableExists(db, table)) return [];
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    const selected = names.filter(name => columns.has(name));
    return selected.length ? db.prepare(`SELECT ${selected.join(",")} FROM ${table} WHERE ${where}`).all(...args) : [];
  };
  const planHead = row("goal_plan_nodes", ["revision","plan_seq"], "goal_id=? ORDER BY revision DESC,plan_seq DESC LIMIT 1", [run.goalId]);
  const owner = row("long_runs", ["app_instance_id","host_owner_kind","runtime_fallback_policy","max_cycles","max_cost_usd",
    "max_workers","wallclock_deadline","cycle_count","cost_used_usd","last_progress_key"], "id=?", [run.id]);
  const chat = row("chats", ["goal_id","runtime_selection_json"], "id=?", [run.rootChatId]);
  const pool = row("model_role_members", ["position","kind","backend","source","model","effort","long_context"], "role='orchestrator' ORDER BY position", []);
  const wait = db.prepare(`SELECT json_extract(payload_json,'$.subscription.waitId') id,
    json_extract(payload_json,'$.subscription.intent.subject.notBefore') due,
    json_extract(payload_json,'$.subscription.state') status FROM long_run_events
    WHERE run_id=? AND kind='run.wait_subscription' ORDER BY seq DESC LIMIT 1`).get(run.id) as { id: string; due: string; status: string } | undefined;
  const schedules = row("automations", ["id","enabled","next_run_at"], "goal_id=? ORDER BY id", [run.goalId]) as Array<{ id: string; enabled: number; next_run_at?: string }>;
  const dates = [wait?.due, ...(owner as Array<{ wallclock_deadline?: string }>).map(o => o.wallclock_deadline)].filter(Boolean)
    .map(value => Date.parse(value!)).filter(Number.isFinite);
  // A missed scheduler slot changes state at the existing grace, not at an arbitrary idle timeout.
  dates.push(...schedules.filter(a => a.enabled === 1 && a.next_run_at).map(a => Date.parse(a.next_run_at!) + AGI_MISSED_DUE_GRACE_MS + 1).filter(Number.isFinite));
  const retry = db.prepare(`SELECT json_extract(payload_json,'$.nextAt') at FROM long_run_events
    WHERE run_id=? AND kind='run.blocked_sweep' AND json_extract(payload_json,'$.action')='retry_scheduled'
    ORDER BY seq DESC LIMIT 1`).get(run.id) as { at: string } | undefined;
  const retryAt = retry?.at ? Date.parse(retry.at) : NaN;
  const boundaryEvent = db.prepare(`SELECT seq FROM long_run_events WHERE run_id=? AND NOT
    (kind='run.blocked_sweep' AND json_extract(payload_json,'$.action')='retry_scheduled')
    ORDER BY seq DESC LIMIT 1`).get(run.id) as { seq: number } | undefined;
  /*
   * The blocked condition, not the Goal's bookkeeping (plan R6: one attempt per blocked state; R14: progress is a changed
   * key result or owner input, never a counter). Production 2026-10-12, Yotube room: the authority also hashed
   * cycle_count, cost_used_usd and app_instance_id, the newest wait subscription id/due, every scheduler next_run_at, the
   * due boundaries and the checkpoint seq (run.cycle_recorded fires every cycle). A Goal cycling every few minutes was a
   * "new blocked state" each time: 62 model attempts over 60 distinct digests in a day, each a new Codex session. The
   * wait, schedules and boundaries still set the next wake (nextWakeAtMs below); an unchanged condition retries on the
   * incident's own backoff (agiRetryDelayMs).
   */
  const ownerPolicy = (owner as Array<Record<string, unknown>>).map(({ app_instance_id: _instance, cycle_count: _cycles,
    cost_used_usd: _cost, host_owner_kind: _host, ...policy }) => policy);
  const authority = createHash("sha256").update(JSON.stringify({ revision: revision?.payload_json ?? null, planHead, owner: ownerPolicy, chat, pool,
    schedules: schedules.map(({ id, enabled }) => ({ id, enabled })) })).digest("hex");
  return { progress: { ownerInputId: `${revision?.source_message_id ?? ""}:${control?.seq ?? ""}`,
    completedToolId: complete?.id ?? null, checkpoint: null, authority },
    fenceState: String(boundaryEvent?.seq ?? ""),
    nextWakeAtMs: Math.min(...[...dates, retryAt].filter(at => Number.isFinite(at) && at > nowMs)) };
}

/** A typed unscheduled result is a current condition, even when the host's
 * nonblocking policy keeps the run row running. Never infer it from prose or
 * inherit a refusal from an older producer / Goal revision. */
function currentUnscheduledRest(db: Database.Database, run: AgiGoalRow): { code: string; ref: string } | null {
  if (run.status !== "running" || !run.rootChatId
    || !["run_events", "long_run_worker_attempts", "chat_goal_revisions", "chats"].every(name => tableExists(db, name))) return null;
  const chat = db.prepare("SELECT goal_id FROM chats WHERE id=?").get(run.rootChatId) as { goal_id: string | null } | undefined;
  if (chat?.goal_id !== run.goalId) return null;
  const worker = goalControllerAttempt(db, run.id);
  if (!worker?.invocationRunId) return null;
  const bound = db.prepare(`SELECT json_extract(payload_json,'$.revision') AS revision FROM long_run_events
    WHERE run_id=? AND kind='run.goal_revision_bound' AND seq <=
      (SELECT MIN(seq) FROM long_run_events WHERE run_id=? AND kind='worker.attempt_started'
        AND json_extract(payload_json,'$.attemptId')=?) ORDER BY seq DESC LIMIT 1`)
    .get(run.id, run.id, worker.id) as { revision: number | null } | undefined;
  const revision = db.prepare("SELECT MAX(revision) revision FROM chat_goal_revisions WHERE goal_id=?")
    .get(run.goalId) as { revision: number | null };
  if (!bound?.revision || bound.revision !== revision.revision) return null;
  const wait = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.wait_subscription' ORDER BY seq DESC LIMIT 1")
    .get(run.id) as { payload_json: string } | undefined;
  if (wait) { try {
    const subscription = JSON.parse(wait.payload_json)?.subscription;
    if (subscription?.goalId === run.goalId && subscription.runId === run.id && subscription.chatId === run.rootChatId
      && subscription.goalRevision === revision.revision && ["pending", "claimed"].includes(subscription.state)) return null;
  } catch { /* malformed is not a registered wake */ } }
  const event = db.prepare(`SELECT id,kind,payload_json FROM run_events WHERE run_id=? AND chat_id=?
    AND kind IN ('goal_wait_refused','goal_wait_registered') ORDER BY seq DESC LIMIT 1`)
    .get(worker.invocationRunId, run.rootChatId) as { id: string; kind: string; payload_json: string } | undefined;
  if (event?.kind !== "goal_wait_refused") return null;
  try {
    const value = JSON.parse(event.payload_json);
    if (value.goalId !== run.goalId || value.scheduled !== false || typeof value.reasonCode !== "string"
      || !/^(goal_episode|goal_plan|goal_revision|goal_wait|checkpoint)_[a-z_]{1,100}$/.test(value.reasonCode)) return null;
    return { code: value.reasonCode, ref: `run_event:${event.id}` };
  } catch { return null; }
}

export function readAgiBlockerFacts(deps: AgiGoalFactsDeps, goalId: string): AgiBlockerFacts | null {
  const { db } = deps;
  const run = readAgiGoalRow(db, goalId);
  if (!run) return null;
  const signals: AgiBlockerSignal[] = [];
  const refs: string[] = [];
  const heldByOwner = (run.status === "paused" && run.pauseReason === "user") || ownerHold(db, run.id);
  const busy = run.rootChatId ? deps.chatBusy?.(run.rootChatId) === true : false;
  const terminal = ["completed", "failed", "cancelled", "cancelling"].includes(run.status);
  const latest = goalTurnReceipt(deps, run.id, run.rootChatId);
  if (heldByOwner && !terminal) signals.push({ kind: "owner_pause" });
  if (!terminal && !busy && !heldByOwner) {
    if ((run.status === "paused" && run.pauseReason === "user") || ((run.status === "paused" || run.status === "blocked") && ownerHold(db, run.id))) {
      signals.push({ kind: "owner_pause" });
    } else {
      if (run.status === "paused" && run.pauseReason === "approval_required") signals.push({ kind: "boundary", boundary: "security_consent", code: "approval_required" });
      else if (run.status === "paused" && run.pauseReason) signals.push({ kind: "host_pause", reason: run.pauseReason });
      if (run.status === "blocked" && run.blockedReason) {
        if (OWNER_QUESTION.has(run.blockedReason)) signals.push({ kind: "needs_input", code: run.blockedReason });
        else signals.push({ kind: "blocked_status", reason: run.blockedReason });
      }
      // A refused wait registration is recorded as the blocked reason the goal fell into (goal_wait_*), whether
      // or not the sweep has since moved the row to waiting_tool for an observation retry.
      const lastWait = db.prepare(`SELECT seq, json_extract(payload_json, '$.reason') AS reason FROM long_run_events WHERE run_id = ?
        AND kind = 'run.status_changed' AND json_extract(payload_json, '$.to') = 'blocked' ORDER BY seq DESC LIMIT 1`)
        .get(run.id) as { seq: number; reason: string | null } | undefined;
      if (lastWait?.reason && WAIT_REFUSAL.test(lastWait.reason) && (run.status === "blocked" || run.status === "waiting_tool")) {
        signals.push({ kind: "wait_registration_refused", code: lastWait.reason });
        refs.push(`long_run_event:${run.id}:${lastWait.seq}`);
      }
      const unscheduled = currentUnscheduledRest(db, run);
      if (unscheduled) { signals.push({ kind: "blocked_status", reason: unscheduled.code }); refs.push(unscheduled.ref); }
      if (run.status === "waiting_user") signals.push({ kind: "needs_input", code: "waiting_user" });
      if (run.stallStreak >= run.stallWindow && run.stallWindow > 0) signals.push({ kind: "stall_detected", streak: run.stallStreak });
      if (deps.continuationParkedForOwner?.(goalId)) signals.push({ kind: "needs_input", code: "continuation_needs_input" });
      if (run.rootChatId && deps.pendingApproval?.(run.rootChatId)) signals.push({ kind: "boundary", boundary: "security_consent", code: "tool_approval_pending" });
      const receipt = latest;
      const failedCode = receipt && (receipt.status === "failed" || receipt.status === "refused") ? typedReceiptCode(receipt) : null;
      if (receipt && failedCode && !NOT_A_GOAL_FAILURE.has(failedCode)) {
        signals.push(receiptSignal(failedCode, receipt.runId ?? null));
        if (receipt.runId) refs.push(`run:${receipt.runId}`);
      }
      const ladder = run.rootChatId ? browserLadderSignal(db, run.rootChatId, deps.nowMs()) : null;
      if (ladder) { signals.push(ladder.signal); refs.push(ladder.ref); }
      const due = missedDueRun(db, goalId, deps.nowMs());
      if (due) signals.push({ kind: "missed_due_run", dueAt: due });
    }
  }
  const plan = tactics(db, goalId, deps.nowMs());
  const wake = wakeState(db, run, deps.nowMs());
  const quietBaseline = deps.episodeBaselineOnly ? null : readEpisodeQuietBaseline(goalId, deps.nowMs(), db);
  const quiet = !terminal && !heldByOwner && run.status === "waiting_tool" && quietBaseline !== null
    && !signals.some(signal => ["owner_pause", "boundary", "needs_input", "host_pause"].includes(signal.kind))
    && quietBaseline === episodeFactSignature(deps.db, run.id, run.rootChatId, signals, refs, latest ?? null);
  return { goalId, chatId: run.rootChatId, ...wake,
    fenceState: JSON.stringify([wake.fenceState, latest?.runId ?? null, latest?.status ?? null, plan.readiness?.mutationIdentity ?? null]),
    repairInFlight: busy || isGoalObserving(goalId), runId: run.id, runVersion: run.version, status: busy && !terminal && !heldByOwner ? "running" : run.status,
    pauseReason: run.pauseReason, blockedReason: run.blockedReason,
    // Audit rows and evidence refs remain intact. Only baseline blockers already
    // superseded by this exact registered wait leave the current diagnosis.
    signals: quiet ? [] : signals, tactics: plan.tactics, planReadiness: plan.readiness,
    blockedNodeId: plan.blockedNodeId, evidenceRefs: refs, continuationAutomation: hasContinuationAutomation(db, goalId) };
}

/** The same lookup recordAgiMove uses for switch_runtime: the newest automation of the goal and its latest recorded run. */
function hasContinuationAutomation(db: Database.Database, goalId: string): boolean | undefined {
  if (!tableExists(db, "automations") || !tableExists(db, "run_history")) return undefined;
  const automation = db.prepare("SELECT id FROM automations WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1").get(goalId) as { id: string } | undefined;
  if (!automation) return false;
  return Boolean(db.prepare("SELECT 1 FROM run_history WHERE automation_id = ? LIMIT 1").get(automation.id));
}

function episodeFactSignature(db: Database.Database, longRunId: string | null, chatId: string | null, signals: readonly AgiBlockerSignal[], refs: readonly string[],
  receipt: { status: string; errorCode: string | null; runId?: string | null } | null): string {
  // Typed failure IDs distinguish a new failure with the same code. Successful
  // observations, prompt/context receipts and unrelated ledger sequence churn do not.
  const faults = chatId ? db.prepare(`SELECT id,run_id,kind,
    json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.errorCode') AS errorCode,
    json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.toolFailureCode') AS toolFailureCode
    FROM run_events WHERE chat_id=? AND (kind IN ('invoke_failed','invoke_threw','mcp_error')
      OR json_type(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.errorCode')='text'
      OR json_type(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.toolFailureCode')='text')
    ORDER BY rowid DESC LIMIT 64`).all(chatId) : [];
  const failures = chatId ? db.prepare(`SELECT id,run_id,source,error_code FROM failure_events
    WHERE chat_id=? ORDER BY rowid DESC LIMIT 64`).all(chatId) : [];
  let status = receipt?.status ?? null;
  // Normal output is still in the live registry during registration. That
  // overlay may call this exact already-completed producer "running" until
  // lifetime cleanup. Only its genuine error-free terminal receipt normalizes
  // this projection difference; another producer or failed/refused receipt does not.
  if (receipt?.runId && status === "running" && !receipt.errorCode && chatId) {
    if (longRunId && goalControllerAttempt(db, longRunId)?.invocationRunId === receipt.runId) {
      const terminal = getInvocationRunReceipt(receipt.runId);
      if (terminal?.runId === receipt.runId && terminal.chatId === chatId && terminal.status === "completed" && !terminal.errorCode) status = "completed";
    }
  }
  return createHash("sha256").update(JSON.stringify({ signals, refs, faults, failures,
    receipt: receipt ? { runId: receipt.runId ?? null, status, errorCode: receipt.errorCode ?? null } : null })).digest("hex");
}
/** Capture actual production facts after registration, before its receipt commits. */
export function captureEpisodeQuietBaseline(goalId: string, now: number, hostReceipt?: AgiGoalFactsDeps["latestReceipt"]): string {
  const db = getDb();
  // Same key as the monitor's later read: the Goal's own controller turn, never the room's newest run (ID-2).
  const deps: AgiGoalFactsDeps = { db, nowMs: () => now, ...(hostReceipt ? { latestReceipt: hostReceipt } : {}), episodeBaselineOnly: true };
  const facts = readAgiBlockerFacts(deps, goalId);
  if (!facts) throw new Error("goal_episode_facts_unavailable");
  const receipt = facts.runId ? goalTurnReceipt(deps, facts.runId, facts.chatId ?? null) : null;
  return episodeFactSignature(db, facts.runId, facts.chatId ?? null, facts.signals, facts.evidenceRefs ?? [], receipt);
}
