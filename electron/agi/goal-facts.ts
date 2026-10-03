/**
 * AGI goal manager, P1 — read one goal's typed blocker facts from the ledger (no model, no prose).
 *
 * Every signal here is a recorded host fact (long_runs status/reason codes, long_run_events kinds, attempt rows,
 * automation schedule rows, the latest turn receipt). Elapsed idle time is never a signal (owner correction
 * 2026-09-28: "시간으로 보면 안 되고 … 명시적 멈춤이 멈춤"). The one schedule fact is missed_due_run: the goal's
 * schedule row says a run was due, the due time has passed by more than the scheduler's own grace, and no run
 * started since — that is a recorded miss, not idleness.
 *
 * The DB handle and the few live-state edges (chat busy, latest receipt, continuation park) are injected so the
 * contracts can drive the real queries on an in-memory store.
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isGoalObserving } from "../long-run/effect-observation-tickets";
import type { AgiBlockerFacts, AgiBlockerSignal, AgiTacticFact } from "./blocker";

/** The scheduler ticks every minute; a due slot missed by more than this with no run started is a miss. */
export const AGI_MISSED_DUE_GRACE_MS = 5 * 60_000;

/** goal_wait_* codes that mean "the host refused to register the wait" (not an effect/claim reconciliation). */
const WAIT_REFUSAL = /^goal_wait_(?!effects_uncertain|claimed_|restored|registered|replan_started)[a-z_]+$/;
const OWNER_QUESTION = new Set(["goal_owner_answer_required", "auto_goal_owner_review_required"]);

export interface AgiGoalFactsDeps {
  db: Database.Database;
  nowMs(): number;
  /** Latest turn receipt of the goal chat (invocation service). */
  latestReceipt?(chatId: string): { status: string; errorCode: string | null; runId?: string | null } | null;
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

function uncertainAttemptIds(db: Database.Database, runId: string): string[] {
  if (!tableExists(db, "long_run_worker_attempts")) return [];
  const rows = db.prepare(`SELECT id FROM long_run_worker_attempts WHERE run_id = ? AND state <> 'running'
    AND (state = 'uncertain' OR side_effect_state = 'uncertain') ORDER BY id`).all(runId) as Array<{ id: string }>;
  // An attempt acknowledged or settled by a later ledger event (user review or observation/receipt) is no longer open.
  const settled = new Set<string>();
  for (const event of db.prepare(`SELECT payload_json FROM long_run_events WHERE run_id = ?
      AND ((kind = 'run.user_control' AND json_extract(payload_json, '$.action') = 'acknowledge_uncertain_attempts')
        OR (kind = 'run.effect_observation' AND json_extract(payload_json, '$.action') = 'settle_uncertain_attempts'))`)
    .all(runId) as Array<{ payload_json: string }>) {
    try { for (const id of (JSON.parse(event.payload_json).attemptIds ?? []) as string[]) settled.add(id); } catch { /* skip */ }
  }
  return rows.map((row) => row.id).filter((id) => !settled.has(id));
}

function exhaustedObservation(db: Database.Database, runId: string): { attemptIds: string[]; looksAfter: number; seq: number } | null {
  const row = db.prepare(`SELECT seq, payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.effect_observation'
    AND json_extract(payload_json, '$.action') = 'exhausted' ORDER BY seq DESC LIMIT 1`).get(runId) as { seq: number; payload_json: string } | undefined;
  if (!row) return null;
  let attemptIds: string[] = [];
  try {
    const payload = JSON.parse(row.payload_json) as { targetSet?: string };
    attemptIds = JSON.parse(payload.targetSet ?? "[]") as string[];
  } catch { attemptIds = []; }
  const targetSet = JSON.stringify([...attemptIds].sort());
  // Exhaustion belongs to one target set. An expanded or different set has
  // its own observation budget and does not prove that this cap was bypassed.
  const later = db.prepare(`SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.effect_observation'
    AND json_extract(payload_json, '$.action') = 'dispatched' AND seq > ?`).all(runId, row.seq) as Array<{ payload_json: string }>;
  const looksAfter = later.filter(({ payload_json }) => {
    try {
      const payload = JSON.parse(payload_json) as { observationTargetIds?: unknown; attemptIds?: unknown };
      const targets = payload.observationTargetIds ?? payload.attemptIds;
      return Array.isArray(targets) && JSON.stringify([...targets].sort()) === targetSet;
    } catch { return false; }
  }).length;
  return { attemptIds, looksAfter, seq: row.seq };
}

function tactics(db: Database.Database, goalId: string): { tactics: AgiTacticFact[]; blockedNodeId: string | null } {
  if (!tableExists(db, "goal_plan_nodes")) return { tactics: [], blockedNodeId: null };
  const head = db.prepare(`SELECT revision, plan_seq FROM goal_plan_nodes WHERE goal_id = ? ORDER BY revision DESC, plan_seq DESC LIMIT 1`)
    .get(goalId) as { revision: number; plan_seq: number } | undefined;
  if (!head) return { tactics: [], blockedNodeId: null };
  const rows = db.prepare(`SELECT node_id, status, payload_json FROM goal_plan_nodes WHERE goal_id = ? AND revision = ? AND plan_seq = ?
    AND kind = 'tactic' ORDER BY ord`).all(goalId, head.revision, head.plan_seq) as Array<{ node_id: string; status: AgiTacticFact["status"]; payload_json: string }>;
  let blockedNodeId: string | null = null;
  const list = rows.map((row) => {
    let dependsOn: string[] | undefined;
    try {
      const payload = JSON.parse(row.payload_json) as { depends_on?: unknown; dependsOn?: unknown; blocked?: unknown };
      const deps = Array.isArray(payload.depends_on) ? payload.depends_on : Array.isArray(payload.dependsOn) ? payload.dependsOn : undefined;
      if (deps) dependsOn = deps.filter((value): value is string => typeof value === "string");
      if (payload.blocked === true && !blockedNodeId) blockedNodeId = row.node_id;
    } catch { /* payload without structure */ }
    return { nodeId: row.node_id, status: row.status, ...(dependsOn ? { dependsOn } : {}) };
  });
  return { tactics: list, blockedNodeId };
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
  const checkpoint = db.prepare(`SELECT seq FROM long_run_events WHERE run_id=? AND kind IN
    ('run.task_checkpoint','run.checkpoint_continuation','run.ongoing_cycle_verified','run.cycle_recorded',
     'run.wait_notification','run.wait_claim_reconciled') ORDER BY seq DESC LIMIT 1`).get(run.id) as { seq: number } | undefined;
  const complete = tableExists(db, "run_events") && tableExists(db, "long_run_worker_attempts") ? db.prepare(`SELECT e.id FROM run_events e
    WHERE e.chat_id=? AND e.kind IN ('mcp_tool-use','runtime_effect_boundary') AND e.ts>=?
    AND (e.kind='runtime_effect_boundary' OR json_extract(e.payload_json,'$.toolCompleted')=1)
    AND EXISTS(SELECT 1 FROM long_run_worker_attempts a WHERE a.run_id=? AND a.invocation_run_id=e.run_id)
    ORDER BY e.ts DESC,e.seq DESC LIMIT 1`).get(run.rootChatId, revision?.created_at ?? "", run.id) as { id: string } | undefined : undefined;
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
  // Polling may rewrite a future retry timestamp. Only crossing its due boundary is new evidence.
  const retryDue = Number.isFinite(retryAt) && nowMs >= retryAt;
  const boundary = dates.map(at => ({ at, due: nowMs >= at }));
  const boundaryEvent = db.prepare(`SELECT seq FROM long_run_events WHERE run_id=? AND NOT
    (kind='run.blocked_sweep' AND json_extract(payload_json,'$.action')='retry_scheduled')
    ORDER BY seq DESC LIMIT 1`).get(run.id) as { seq: number } | undefined;
  const authority = createHash("sha256").update(JSON.stringify({ revision: revision?.payload_json ?? null, planHead, owner, chat, pool, wait, schedules, boundary, retryDue })).digest("hex");
  return { progress: { ownerInputId: `${revision?.source_message_id ?? ""}:${control?.seq ?? ""}`,
    completedToolId: complete?.id ?? null, checkpoint: checkpoint ? String(checkpoint.seq) : null, authority },
    fenceState: String(boundaryEvent?.seq ?? ""),
    nextWakeAtMs: Math.min(...[...dates, retryAt].filter(at => Number.isFinite(at) && at > nowMs)) };
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
  if (heldByOwner && !terminal) signals.push({ kind: "owner_pause" });
  if (!terminal && !busy && !heldByOwner) {
    if ((run.status === "paused" && run.pauseReason === "user") || ((run.status === "paused" || run.status === "blocked") && ownerHold(db, run.id))) {
      signals.push({ kind: "owner_pause" });
    } else {
      if (run.status === "paused" && run.pauseReason === "approval_required") signals.push({ kind: "boundary", boundary: "security_consent", code: "approval_required" });
      else if (run.status === "paused" && run.pauseReason === "budget") signals.push({ kind: "boundary", boundary: "payment", code: "long_run_budget" });
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
      if (run.status === "waiting_user") signals.push({ kind: "needs_input", code: "waiting_user" });
      const uncertain = uncertainAttemptIds(db, run.id);
      const exhausted = exhaustedObservation(db, run.id);
      if (exhausted && exhausted.attemptIds.some((id) => uncertain.includes(id))) {
        signals.push({ kind: "effect_observation_exhausted", attemptIds: exhausted.attemptIds, looksAfterExhausted: exhausted.looksAfter });
        refs.push(`long_run_event:${run.id}:${exhausted.seq}`);
      } else if (uncertain.length) {
        signals.push({ kind: "effect_uncertain", attemptIds: uncertain });
      }
      if (run.stallStreak >= run.stallWindow && run.stallWindow > 0) signals.push({ kind: "stall_detected", streak: run.stallStreak });
      if (deps.continuationParkedForOwner?.(goalId)) signals.push({ kind: "needs_input", code: "continuation_needs_input" });
      if (run.rootChatId && deps.pendingApproval?.(run.rootChatId)) signals.push({ kind: "boundary", boundary: "security_consent", code: "tool_approval_pending" });
      const receipt = run.rootChatId ? deps.latestReceipt?.(run.rootChatId) ?? null : null;
      if (receipt && (receipt.status === "failed" || receipt.status === "refused") && receipt.errorCode) {
        signals.push(receiptSignal(receipt.errorCode, receipt.runId ?? null));
        if (receipt.runId) refs.push(`run:${receipt.runId}`);
      }
      const ladder = run.rootChatId ? browserLadderSignal(db, run.rootChatId, deps.nowMs()) : null;
      if (ladder) { signals.push(ladder.signal); refs.push(ladder.ref); }
      const due = missedDueRun(db, goalId, deps.nowMs());
      if (due) signals.push({ kind: "missed_due_run", dueAt: due });
    }
  }
  const plan = tactics(db, goalId);
  const wake = wakeState(db, run, deps.nowMs());
  const latest = run.rootChatId ? deps.latestReceipt?.(run.rootChatId) : null;
  return { goalId, chatId: run.rootChatId, ...wake,
    fenceState: JSON.stringify([wake.fenceState, latest?.runId ?? null, latest?.status ?? null]),
    repairInFlight: busy || isGoalObserving(goalId), runId: run.id, runVersion: run.version, status: busy && !terminal && !heldByOwner ? "running" : run.status,
    pauseReason: run.pauseReason, blockedReason: run.blockedReason, signals, tactics: plan.tactics,
    blockedNodeId: plan.blockedNodeId, evidenceRefs: refs };
}
