/**
 * The One/Work goal playground an Alive orchestrator observes and acts in.
 *
 * Attachment scopes:
 *   work: { surface: "work", projectId, chatId }  — the chat where AGI was turned on; its CURRENT goal is observed,
 *         so a Work life keeps living across that chat's successive goals.
 *   one:  { surface: "one", chatId, goalId }      — one concrete goal; the life ends with it.
 *
 * observe(): goal status from the long-run ledger (host facts only, no prose). salience = meaningful change only
 * (status/pause/blocker/revision/retry slot), so volatile counters never spend a model turn.
 *   running/queued/verifying/waiting_*  → work "running" (the goal owns its next step; Alive waits)
 *   blocked (not yet swept)             → work "paused" (continuable through the blocked-goal sweep path)
 *   a sweep retry is scheduled          → work "running" (the host owns that next step and its backoff)
 *   paused by a host pause              → work "paused"
 *   paused by the owner / approval / budget → blockedBy (an owner boundary Alive never bypasses)
 *   completed/failed/cancelled          → work "terminal"
 * A chat with a pending tool approval is blockedBy goal.approval-pending regardless of status.
 *
 * execute(goal.continue): durable actionId dedupe first (alive_goal_action_receipts), then the exact fence
 * (goalId, runId, runVersion, status) against the current ledger, then continueGoalForAlive — the existing
 * continuation path. A crash between the effect and the settled receipt is safe: the resume bumps the run
 * version, so a replay of the same packet fails its fence instead of resuming twice.
 */
import type Database from "better-sqlite3";
import type { AliveActionPacket, AliveActionResult, AliveAttachment, AlivePlaygroundObservation, AlivePlaygroundPort } from "../alive-core/contracts";
import { registerAliveAction } from "../alive-core/action-registry";
import { GOAL_CONTINUE_ACTION, validGoalContinueExpected } from "./goal-decision";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUNNING = new Set(["queued", "running", "waiting_worker", "waiting_tool", "verifying", "pausing", "cancelling"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const ALIVE_CONTINUABLE_PAUSES = new Set(["agent_paused", "runtime_unavailable", "app_closed", "crash_recovery"]);

export interface GoalChatView { id: string; title: string; goalId: string | null; projectId: string | null; originSurface: "one" | "work" | null }
export interface GoalRunView {
  id: string; goalId: string; surface: string; rootChatId: string | null; status: string; pauseReason: string | null;
  blockedReason: string | null; version: number; objective: string; cycleCount: number; criteriaCount: number;
}
export interface GoalContinueOutcome { action: "observation_dispatched" | "resumed" | "retry_scheduled" | "cancelled" | "deferred"; detail: string }
export interface GoalPlaygroundDeps {
  chat(chatId: string): GoalChatView | null;
  runForGoal(goalId: string): GoalRunView | null;
  goalRevision(goalId: string): number | null;
  chatBusy(chatId: string): boolean;
  pendingApproval(chatId: string): boolean;
  /** Host-scheduled retry slot (blocked-goal sweep) or wait-subscription check time: the next safe run. */
  nextSafeRunAt(run: GoalRunView): string | null;
  /** A blocked-goal sweep retry is scheduled for this run (its next step exists and may be brought forward). */
  hostRetryPending(runId: string): boolean;
  latestReceipt(chatId: string): { status: string; errorCode: string | null; finishedAt: string | null } | null;
  continueGoal(runId: string, expectedVersion: number): GoalContinueOutcome;
}

let registered = false;
/** goal.continue is carried by both goal playgrounds. Idempotent. */
export function registerGoalActions(): void {
  if (registered) return;
  registerAliveAction({ kind: GOAL_CONTINUE_ACTION, domains: ["work", "one"],
    expectedKeys: ["goalId", "runId", "runVersion", "status"], validateExpected: validGoalContinueExpected });
  registered = true;
}

export function ensureGoalPlaygroundSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alive_goal_action_receipts (
    action_id TEXT PRIMARY KEY, domain TEXT NOT NULL, goal_id TEXT NOT NULL, run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('claimed','settled')),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER)`);
}

/** The goal an attachment currently points at (Work follows its chat; One is fixed). */
export function attachedGoalId(attachment: Pick<AliveAttachment, "domain" | "scope">, deps: Pick<GoalPlaygroundDeps, "chat">): { goalId: string | null; chat: GoalChatView | null } {
  const chatId = typeof attachment.scope.chatId === "string" ? attachment.scope.chatId : "";
  const chat = chatId ? deps.chat(chatId) : null;
  if (attachment.domain === "one") {
    const goalId = typeof attachment.scope.goalId === "string" ? attachment.scope.goalId : null;
    return { goalId, chat };
  }
  return { goalId: chat?.goalId ?? null, chat };
}

export class GoalAlivePlayground implements AlivePlaygroundPort {
  constructor(readonly domain: "work" | "one", private readonly db: Database.Database, private readonly deps: GoalPlaygroundDeps) {
    ensureGoalPlaygroundSchema(db);
    registerGoalActions();
  }

  observe(attachment: AliveAttachment, _nowMs: number): AlivePlaygroundObservation {
    const { goalId, chat } = attachedGoalId(attachment, this.deps);
    if (!chat) return { work: "none", observation: { goal: null }, salience: { chat: "missing" }, blockedBy: "goal.chat-missing" };
    if (this.domain === "work" && (chat.projectId ?? null) !== (attachment.scope.projectId ?? null)) {
      return { work: "none", observation: { goal: null }, salience: { chat: "moved" }, blockedBy: "work.chat-left-project" };
    }
    if (!goalId) return { work: "none", observation: { goal: null }, salience: { goal: null }, blockedBy: "goal.none" };
    const run = this.deps.runForGoal(goalId);
    if (!run) return { work: "none", observation: { goalId }, salience: { goalId, run: null }, blockedBy: "goal.ledger-missing" };
    const revision = this.deps.goalRevision(goalId);
    const nextSafeRunAt = this.deps.nextSafeRunAt(run);
    const receipt = this.deps.latestReceipt(chat.id);
    let work: AlivePlaygroundObservation["work"];
    let blockedBy: string | null = null;
    if (TERMINAL.has(run.status)) work = "terminal";
    // A blocked-goal sweep retry is scheduled (waiting_tool, or a host pause that carried it): the host owns the
    // next step and its backoff. Alive waits instead of forcing it (see continueGoalForAlive).
    else if (this.deps.hostRetryPending(run.id)) work = "running";
    else if (run.status === "paused") {
      if (ALIVE_CONTINUABLE_PAUSES.has(run.pauseReason ?? "")) work = "paused";
      else {
        work = "paused";
        blockedBy = run.pauseReason === "user" ? "goal.owner-stopped"
          : run.pauseReason === "approval_required" ? "goal.approval-required"
            : run.pauseReason === "budget" ? "goal.budget-spent" : "goal.paused-by-boundary";
      }
    } else if (run.status === "blocked") work = "paused";
    else if (run.status === "waiting_user") { work = "paused"; blockedBy = "goal.waiting-for-owner"; }
    else if (run.status === "draft") { work = "none"; blockedBy = "goal.draft"; }
    else if (RUNNING.has(run.status)) work = "running";
    else work = "none";
    if (work !== "terminal" && this.deps.chatBusy(chat.id)) work = "running";
    if (work !== "terminal" && this.deps.pendingApproval(chat.id)) blockedBy = "goal.approval-pending";
    const world = { goalId, runId: run.id, status: run.status, pauseReason: run.pauseReason, blockedReason: run.blockedReason };
    return {
      work,
      blockedBy,
      salience: { ...world, goalRevision: revision, nextSafeRunAt },
      observation: {
        goalId, runId: run.id, runVersion: run.version, status: run.status, pauseReason: run.pauseReason,
        blockedReason: run.blockedReason, goalRevision: revision, objective: run.objective.slice(0, 600),
        acceptanceCriteria: run.criteriaCount, cycleCount: run.cycleCount, nextSafeRunAt,
        lastReceipt: receipt, chatTitle: chat.title.slice(0, 120), world,
      },
    };
  }

  actionReceipt(actionId: string): AliveActionResult | null {
    const row = this.db.prepare("SELECT status,result_json FROM alive_goal_action_receipts WHERE action_id=? AND domain=?")
      .get(actionId, this.domain) as { status: string; result_json: string | null } | undefined;
    if (!row || row.status !== "settled" || !row.result_json) return null;
    try { return JSON.parse(row.result_json) as AliveActionResult; } catch { return null; }
  }

  execute(attachment: AliveAttachment, packet: AliveActionPacket, nowMs: number): AliveActionResult {
    const replay = this.actionReceipt(packet.actionId);
    if (replay) return { ...replay, replayed: true };
    const fail = (code: string): AliveActionResult => this.settle(packet, { ok: false, actionId: packet.actionId, code }, nowMs);
    const expected = packet.expected;
    if (packet.schema !== "agentlas.alive-action.v1" || packet.action !== GOAL_CONTINUE_ACTION || packet.domain !== this.domain
      || attachment.domain !== this.domain || packet.attachmentId !== attachment.attachmentId
      || JSON.stringify(packet.scope) !== JSON.stringify(attachment.scope)
      || !expected || Object.keys(expected).sort().join("|") !== "goalId|runId|runVersion|status"
      || !validGoalContinueExpected(expected)) return fail("goal.continue-packet-invalid");
    const { goalId } = attachedGoalId(attachment, this.deps);
    const run = goalId ? this.deps.runForGoal(goalId) : null;
    if (!goalId || !run || goalId !== expected.goalId || run.id !== expected.runId
      || run.version !== expected.runVersion || run.status !== expected.status) return fail("goal.continue-stale");
    const observed = this.observe(attachment, nowMs);
    if (observed.blockedBy) return fail(observed.blockedBy);
    if (observed.work !== "paused") return fail("goal.continue-not-stopped");
    // Durable claim before the side effect. An older claim from a crashed dispatch is superseded by the
    // fence above: had it crossed, the run version would have moved and we would have failed stale.
    this.db.prepare(`INSERT INTO alive_goal_action_receipts(action_id,domain,goal_id,run_id,status,created_at_ms)
      VALUES (?,?,?,?,'claimed',?) ON CONFLICT(action_id) DO NOTHING`).run(packet.actionId, this.domain, goalId, run.id, nowMs);
    let outcome: GoalContinueOutcome;
    try { outcome = this.deps.continueGoal(run.id, run.version); }
    catch { return fail("goal.continue-dispatch-failed"); }
    const invocationRunId = UUID.test(outcome.detail) ? outcome.detail : undefined;
    const result: AliveActionResult = outcome.action === "resumed" && invocationRunId
      ? { ok: true, actionId: packet.actionId, code: "goal.continue-resumed", invocationRunId }
      : outcome.action === "observation_dispatched" && invocationRunId
        ? { ok: true, actionId: packet.actionId, code: "goal.continue-observing", invocationRunId }
        : { ok: false, actionId: packet.actionId, code: outcome.action === "retry_scheduled" ? "goal.continue-retry-scheduled"
          : outcome.action === "cancelled" ? "goal.continue-goal-closed" : "goal.continue-deferred" };
    return this.settle(packet, result, nowMs);
  }

  private settle(packet: AliveActionPacket, result: AliveActionResult, nowMs: number): AliveActionResult {
    const goalId = typeof packet.expected?.goalId === "string" ? packet.expected.goalId : "";
    const runId = typeof packet.expected?.runId === "string" ? packet.expected.runId : "";
    this.db.prepare(`INSERT INTO alive_goal_action_receipts(action_id,domain,goal_id,run_id,status,result_json,created_at_ms,settled_at_ms)
      VALUES (?,?,?,?,'settled',?,?,?) ON CONFLICT(action_id) DO UPDATE SET status='settled',result_json=excluded.result_json,
      settled_at_ms=excluded.settled_at_ms WHERE alive_goal_action_receipts.status='claimed'`)
      .run(packet.actionId, this.domain, goalId, runId, JSON.stringify(result), nowMs, nowMs);
    return result;
  }
}
