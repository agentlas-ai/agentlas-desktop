/**
 * AGI goal manager, P3 — the typed action executor (plan §3.5, §3.9).
 *
 * The unblocker never gets a shell or a free-form write. It emits `agentlas.agi-unblock.v1` action requests; Main
 * validates each one and executes it through the product's existing paths, writing a durable receipt first:
 *
 *   create_teammate          oneTeamCreateMember (D2: allowed without asking, Hub teammates included)
 *   invite_teammate          oneTeamInvite (group chats)
 *   dispatch_teammate        oneTeamStartSession, brief bound to a plan node (depth 1)
 *   switch_runtime           a recorded persistence move (switch_runtime) for the goal's next turn
 *   retry_node_with          a recorded switch_tool move + node note (path = an installed alternative)
 *   replan_tree              plan ops (split after failure only, merge, retire, reorder); intent edits = purpose_change
 *   start_work_turn          continueGoalForAlive with the goal's original permission
 *   run_login_recovery       the login-recovery ladder (electron/browser/login-recovery.ts, another agent) via a seam
 *   restart_agentlas_browser the Agentlas Browser restart path via a seam (D6: allowed)
 *   request_app_restart      one owner ask; the app itself is never restarted by AGI (D6: must ask)
 *   file_defect              local agi_defect_reports row + one chip notice; sending needs the owner's press (D5)
 *   ask_owner_once           one precise ask, only for the incident's own persistence boundary, only after an alternative path (G1);
 *                           the owner line is a host template per boundary plus a short, labelled model summary, and the ask counts
 *                           as asked only once it reached the owner's room
 *   rest                     nothing left; the incident stays open until the state digest changes
 *
 * Guards, all structural (the executor refuses; no prompt is trusted to):
 *  - fence: (goalId, runId, runVersion) must equal the ledger now, else refused stale;
 *  - replay: the same actionId returns the same receipt (claimed before the side effect);
 *  - owner boundaries: a goal paused by the owner, for approval or for budget gets no action but file_defect;
 *  - model-briefed team work: never on a human_only incident, and a teammate the AGI starts runs at write at most, never full;
 *  - G1: ask_owner_once needs ≥1 settled non-ask alternative action on the same incident;
 *  - repeat escalation (R16, R2): an action already taken MAX_SAME_MOVE_PER_CAUSE times on the incident, or one whose
 *    effect failed there, is not refused but replaced by the next deterministic move (repeatEscalation): the runtime's
 *    own tools for a failing Agentlas capability, then another runtime, then the goal's next work turn;
 *  - budget (D1): ≤4 executed actions per attempt; the unblocker's model calls are admitted in model-attempt.ts.
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "../../shared/secret-patterns";
import { desktopStoreTransaction } from "../store/change-bus";
import type { GoalEpisodeDisposition } from "../long-run/episode-disposition";
import type Database from "better-sqlite3";
import { MAX_SAME_MOVE_PER_CAUSE, PERSISTENCE_BOUNDARY_KINDS, isPersistenceBoundaryKind, type PersistenceBoundaryKind } from "../../shared/persistence-policy";
import { AGI_ACTION_KINDS, AGI_NON_ALTERNATIVE_ACTIONS, agiHarnessCapability, type AgiActionKind } from "./blocker";
import type { AgiOwnerAskCardKind } from "./owner-ask-card";
import { AgiIncidentStore, type AgiIncident } from "./incident-store";
import { applyDefectResolutions, ensureDefectResolutionColumns } from "./defect-resolutions";
import { assertAgiDecisionControl, agiDecisionAbortSignal, retainAgiDecisionControl, AGI_DECISION_CONTROL_CHANGED } from "./decision-control";
import type { AgiUnblockInput } from "./monitor";

export const AGI_ACTION_SCHEMA = "agentlas.agi-unblock.v1" as const;
/**
 * Owner 2026-10-12: there is no per-attempt action COUNT cap (a cap that turns a goal into a dead end is forbidden).
 * The only guard inside one attempt is against idle spin: an action identical (kind + canonical args) to one already
 * executed in the same attempt is refused with this code. Distinct actions are unlimited.
 */
export const AGI_REPEAT_IN_ATTEMPT_CODE = "agi.action.repeat-in-attempt";

/**
 * The same tactic is handed to a teammate at most this many times per Goal in any 24 hours. Production 2026-10-19, one Yotube room
 * Goal: 96 of 99 teammate dispatches were the AGI's, 76 of them tactic t9 (62 to the same teammate). Re-briefing the work again does
 * not move it; other tactics, other moves and the next day stay open, so this is not a dead end.
 */
export const AGI_TACTIC_DISPATCHES_PER_DAY = 3;
/** An action whose product path threw something that is not a typed code. */
export const AGI_ACTION_THREW_CODE = "agi.action.threw";
function untypedReason(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(raw).replace(/(?:\/Users|\/home|[A-Za-z]:\\Users)[\\/][^\\/\s]+/g, "~").replace(/\s+/g, " ").trim().slice(0, 120);
}
export const AGI_TACTIC_DAILY_LIMIT_CODE = "agi.team.tactic-daily-limit";
/** An owner ask whose notice did not reach the room: refused, not counted as asked, free to be asked again. */
export const AGI_ASK_NOT_DELIVERED_CODE = "agi.ask.not-delivered";
/** A model-briefed teammate is never started on an incident that waits for the owner (payment, credential, consent, purpose). */
export const AGI_HUMAN_ONLY_INCIDENT_CODE = "agi.team.human-only-incident";
/**
 * Host provenance mark in front of every brief the AGI hands a teammate. The brief is model-written and the model reads chat, tool and
 * run-event content that may come from outside the owner (web pages, mail, tool output): it is a relay, not an instruction of the owner.
 */
export const AGI_BRIEF_PROVENANCE = "[agi-relay: model-written from chat/tool/run content, unverified; payment, sending, publishing, deletion and permission changes stay with the owner]";

/**
 * The permission an AGI-started teammate session (and the teammate it creates) runs with: write at most. The Goal's own turns keep
 * the Goal's permission; a model-written brief never rides on full. Read stays read.
 */
export function agiTeamPermission(permission: AgiGoalView["permission"]): "read" | "write" {
  return permission === "read" ? "read" : "write";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Digest of what the model asked for (before any host escalation rewrite). */
export function agiActionRepeatDigest(action: unknown, args: unknown): string {
  return createHash("sha256").update(canonicalJson({ action: String(action ?? ""), args: args ?? {} })).digest("hex");
}

/**
 * Actions a repeat never escalates: a defect record and a wait are idempotent by design (resting again is the intended
 * idle behavior), the work turn is the end of the ladder, an ask has its own once-per-boundary rule, and a harness
 * hand-off is a no-op inside its hold.
 */
const NEVER_ESCALATED = new Set<string>(["file_defect", "rest", "start_work_turn", "ask_owner_once", "use_native_harness"]);

/** The next deterministic move for an action that already repeated or failed on this incident. */
export function repeatEscalation(incident: Pick<AgiIncident, "reasonCode" | "diagnosis">, action: string,
  history: ReadonlyArray<{ action: string }>, options: { nativeHarness?: boolean; runtimeSwitch?: boolean } = {}): { action: AgiActionKind; args: Record<string, unknown> } {
  // A read-only Goal is never handed the runtime's own write-capable tools; its ladder goes on to another runtime and the work turn.
  const capability = options.nativeHarness === false ? null : agiHarnessCapability(incident.diagnosis);
  if (capability) return { action: "use_native_harness", args: { capability, defect: incident.reasonCode } };
  const switched = history.filter((entry) => entry.action === "switch_runtime").length;
  // runtimeSwitch false: the host has nothing a switch could move for this Goal (recordMove refuses it every time).
  if (action !== "switch_runtime" && options.runtimeSwitch !== false && switched < MAX_SAME_MOVE_PER_CAUSE) return { action: "switch_runtime", args: { reason: incident.reasonCode } };
  return { action: "start_work_turn", args: { nodeId: incident.diagnosis.eligibleTactics?.[0] ?? null } };
}

export interface AgiActionRequest {
  schema: typeof AGI_ACTION_SCHEMA;
  actionId: string;
  incidentId: string;
  /** Which attempt on the incident this action belongs to (per-attempt action cap). */
  attempt: number;
  fence: { goalId: string; runId: string; runVersion: number };
  action: AgiActionKind;
  args?: Record<string, unknown>;
  /** Host-only pre-model capture; never parsed from action args. */
  episodeCaptureId?: string;
  episodeRefusal?: string;
  /** Tokens the attempt has spent so far (P4 model loop); 0 for the deterministic handler. */
  attemptTokensSoFar?: number;
}

export interface AgiActionReceipt {
  actionId: string;
  action: string;
  ok: boolean;
  code: string;
  detail?: Record<string, unknown>;
  replayed?: boolean;
}

export interface AgiGoalView {
  goalId: string; runId: string; version: number; status: string; pauseReason: string | null; blockedReason: string | null;
  chatId: string | null; permission: "read" | "write" | "full";
}

export interface AgiPlanTactic { id: string; strategyId: string | null; status: string; ord: number; description: string; doneWhen: string; failures: number; intent?: string | null }
export interface AgiPlanView { revision: number; planSeq: number; tactics: AgiPlanTactic[] }
export type AgiPlanOp =
  | { op: "split"; nodeId: string; into: Array<{ description: string }> }
  | { op: "merge"; keep: string; retire: string[] }
  | { op: "retire"; nodeId: string }
  | { op: "reorder"; nodeId: string; ord: number };

export type AgiLoginRecoveryOutcome = "recovered" | "awaiting-owner" | "in-flight" | "not-a-wall" | "unavailable";

/** Main-only original decision boundary, never parsed from model action arguments. */
export interface AgiBrowserRestartControl { signal: AbortSignal; assertCurrent(): void }
export type AgiLoginRecoveryControl = AgiBrowserRestartControl;
export interface AgiLoginRecoveryResult {
  state: AgiLoginRecoveryOutcome | "cancelled" | "unknown";
  directEffect: "not-started" | "imported" | "unknown";
  /** Acknowledged writes only; not a total-effect count when directEffect is unknown. */
  acknowledgedWritten: number;
  /** The admitted legacy observer retains its own pending-card scope. */
  observerEffect: "not-started" | "unknown";
}
export interface AgiBrowserRestartOutcome {
  state: "ready" | "failed" | "cancelled" | "unknown";
  closeEffect: "not-started" | "closed" | "unknown";
  /** Shared ensure internals are not owned by this borrower. */
  ensureEffect?: "not-started" | "unknown";
}

export interface AgiStrategyBatch { plan: AgiActionRequest; rest: AgiActionRequest }

export interface AgiExecutorDeps {
  db: Database.Database;
  now(): number;
  captureEpisode?(captureId: string, goalId: string): void;
  rest?(request: AgiActionRequest): GoalEpisodeDisposition;
  strategy?: {
    prepare(batch: AgiStrategyBatch, decision: AgiUnblockInput): Promise<unknown>;
    commit(batch: AgiStrategyBatch, prepared: unknown, decision: AgiUnblockInput): GoalEpisodeDisposition;
  };
  afterRest?(): void;
  goal(goalId: string): AgiGoalView | null;
  /** continueGoalForAlive (blocked-goal-sweep.ts) — the existing continuation path. */
  continueGoal(runId: string, expectedVersion: number): { action: string; detail: string };
  /**
   * Why continueGoal would defer this Goal before trying anything (aliveGoalContinuationRefusal), null = it would try. Absent: unknown,
   * the work turn is asked as before.
   */
  continuationRefusal?(runId: string, expectedVersion: number): string | null;
  team?: {
    create(chatId: string, permission: AgiGoalView["permission"], input: { name: string; role?: string; personality?: string }): { memberId: string; created: boolean };
    invite(chatId: string, permission: AgiGoalView["permission"], member: string): { memberId: string; joined: boolean; memberName?: string };
    /** runId: the Goal's long run; the host start goes through its wake budget (wake-arbiter, source "agi"). */
    dispatch(chatId: string, permission: AgiGoalView["permission"], input: { member: string; brief: string; runId?: string; delegationPermission: "write" }): { sessionId: string; memberName?: string };
  };
  plan?: {
    read(goalId: string): AgiPlanView | null;
    apply(goalId: string, plan: AgiPlanView, ops: AgiPlanOp[]): void;
  };
  /** Is there anything a switch_runtime can move for this Goal (false = recordMove refuses it by structure; absent/undefined = unknown). */
  canSwitchRuntime?(goalId: string): boolean | undefined;
  /** Record a persistence move (switch_runtime / switch_tool) for the goal's next turn. */
  recordMove?(goalId: string, runId: string, move: "switch_runtime" | "switch_tool" | "native_harness", detail: Record<string, unknown>): { ok: true } | { ok: false; code: string } | void;
  /** Installed alternatives for a capability path (retry_node_with guard). */
  installedPaths?(capability: string): string[];
  /** The login-recovery ladder seam (plugged by electron/browser/*; absent → unavailable). */
  runLoginRecovery?(input: { domain: string; goalId: string; runId: string; chatId: string | null }, control: AgiLoginRecoveryControl): AgiLoginRecoveryOutcome | AgiLoginRecoveryResult | Promise<AgiLoginRecoveryOutcome | AgiLoginRecoveryResult>;
  /** Agentlas Browser restart seam (D6: allowed without asking). */
  restartAgentlasBrowser?(control: AgiBrowserRestartControl): boolean | AgiBrowserRestartOutcome | Promise<boolean | AgiBrowserRestartOutcome>;
  /**
   * One owner-visible line in the goal chat (host-notice marker). Idempotent per actionId. An owner ask also names its
   * typed card kind: the line explains, the card is how the owner answers (owner 2026-10-20: asks are always cards).
   */
  announce?(input: { chatId: string; actionId: string; kind: "action" | "ask" | "defect"; text: { ko: string; en: string }; card?: AgiOwnerAskCardKind }): void;
  /** A defect was filed: surface the chip (D5). */
  onDefectFiled?(input: { defectId: string; goalId: string; chatId: string | null; code: string }): void;
}

export function ensureAgiActionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_action_receipts (
    action_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, goal_id TEXT NOT NULL, attempt INTEGER NOT NULL, action TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('claimed','settled')), ok INTEGER, code TEXT,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agi_action_receipts_incident ON agi_action_receipts(incident_id, attempt)");
  // The goal panel reads a goal's latest settled receipts (long-run/goal-panel.ts agiActions/agiSuggestions). Without
  // this the right panel's 목표 tab scanned every receipt of every goal (15k rows, ~200 ms cold on the owner's store,
  // 2026-10-25). Additive: older versions open the same file and simply do not use it.
  db.exec("CREATE INDEX IF NOT EXISTS idx_agi_action_receipts_goal_settled ON agi_action_receipts(goal_id, settled_at_ms DESC)");
  db.exec(`CREATE TABLE IF NOT EXISTS agi_defect_reports (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, chat_id TEXT, incident_id TEXT, code TEXT NOT NULL, category TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), workaround TEXT, created_at_ms INTEGER NOT NULL,
    UNIQUE(goal_id, code))`);
  // The report had no state, so a fixed defect looked open for ever. resolved_* is stamped by defect-resolutions.ts.
  ensureDefectResolutionColumns(db);
  try { applyDefectResolutions(db); } catch (error) { console.warn("[agi] defect resolutions not applied:", error); }
}

const strategyPreparations = new WeakMap<Database.Database, Map<string, { digest: string; actionIds: string[] }>>();

const ACTION_ID = /^[A-Za-z0-9._:-]{8,160}$/;
function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}
// A budget pause is lifted by the owner too (blocker.ts budget_stop): AGI files defects there, nothing else.
const OWNER_BOUNDARY_PAUSES = new Set(["user", "budget"]);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

export class AgiActionExecutor {
  readonly incidents: AgiIncidentStore;
  private readonly deferredBrowser = new Map<string, { goalId: string; promise: Promise<void> }>();
  isDeferredBusy(goalId?: string): boolean {
    return [...this.deferredBrowser.values()].some(entry => goalId === undefined || entry.goalId === goalId);
  }
  settledDeferred(): Promise<unknown> { return Promise.allSettled([...this.deferredBrowser.values()].map(entry => entry.promise)); }
  constructor(private readonly deps: AgiExecutorDeps) {
    ensureAgiActionSchema(deps.db);
    this.incidents = new AgiIncidentStore(deps.db);
  }

  /** A model attempt settled after the monitor recorded "dispatched": write its end onto the state's attempt row. */
  recordAttemptResult(goalId: string, stateDigest: string, result: { outcome: string; code?: string }, attempt?: number): void {
    try {
      this.deps.db.prepare("UPDATE agi_unblock_attempts SET outcome = ?, code = ?, result_json = ?, at_ms = ? WHERE goal_id = ? AND state_digest = ? AND code = 'agi.model-attempt-dispatched' AND (? IS NULL OR incident_id IN (SELECT id FROM agi_incidents WHERE attempts=?))")
        .run(result.outcome, result.code ?? null, JSON.stringify(result), this.deps.now(), goalId, stateDigest, attempt ?? null, attempt ?? null);
    } catch { /* table absent in a bare executor (contracts) */ }
  }

  /** The goal ledger's version now (the model attempt refreshes its fence after its own accepted effects). */
  currentVersion(goalId: string): number | null { return this.deps.goal(goalId)?.version ?? null; }

  /** The host would try to continue this Goal now (blocked-goal-sweep.ts aliveGoalContinuationRefusal). Unknown counts as yes. */
  canContinueGoal(goalId: string): boolean {
    const goal = this.deps.goal(goalId);
    if (!goal) return false;
    try { return (this.deps.continuationRefusal?.(goal.runId, goal.version) ?? null) === null; } catch { return true; }
  }

  receipt(actionId: string): AgiActionReceipt | null {
    const row = this.deps.db.prepare("SELECT status, result_json FROM agi_action_receipts WHERE action_id = ?").get(actionId) as { status: string; result_json: string | null } | undefined;
    if (!row || row.status !== "settled" || !row.result_json) return null;
    try { return JSON.parse(row.result_json) as AgiActionReceipt; } catch { return null; }
  }

  /**
   * Executed actions on an incident (G1, circuit breaker, per-attempt cap): an effect that ran (ok) or ran and failed.
   * An argument/precondition refusal never reached the product and is not counted.
   */
  private history(incidentId: string): Array<{ action: string; ok: boolean; attempt: number }> {
    return (this.deps.db.prepare(`SELECT action, ok, attempt FROM agi_action_receipts WHERE incident_id = ? AND status = 'settled' AND attempt >= 1
      AND (ok = 1 OR code LIKE '%failed%' OR code LIKE '%unavailable%' OR code LIKE 'agi.turn.%')`).all(incidentId) as Array<{ action: string; ok: number; attempt: number }>)
      .map((row) => ({ action: row.action, ok: row.ok === 1, attempt: row.attempt }));
  }

  captureEpisode(captureId: string, goalId: string): void { this.deps.captureEpisode?.(captureId, goalId); }

  /** Two existing actions, one Main transaction. Preparation never executes either action. */
  async executeStrategyEpisode(batch: AgiStrategyBatch, decision: AgiUnblockInput): Promise<AgiActionReceipt[]> {
    const requests = [batch.plan, batch.rest];
    const batchDigest = createHash("sha256").update(JSON.stringify(requests.map(r => ({ actionId: r.actionId, action: r.action,
      incidentId: r.incidentId, attempt: r.attempt, goalId: r.fence.goalId, runId: r.fence.runId, captureId: r.episodeCaptureId, args: r.args })))).digest("hex");
    const failed = (code: string) => requests.map(r => ({ actionId: r.actionId, action: r.action, ok: false, code }));
    const prior = requests.map(r => this.receipt(r.actionId));
    if (prior.some(Boolean)) return prior.every(r => r?.detail?.batchDigest === batchDigest)
      ? prior.map(r => ({ ...r!, replayed: true })) : failed("goal_strategy_request_conflict");
    if (requests.some(r => this.deps.db.prepare("SELECT 1 FROM agi_action_receipts WHERE action_id=? AND status='claimed'").get(r.actionId)))
      return failed("agi.action.in-flight");
    const gate = (): string | null => {
      if (batch.plan.action !== "replan_tree" || batch.rest.action !== "rest"
        || requests.some(r => r.schema !== AGI_ACTION_SCHEMA || !ACTION_ID.test(r.actionId) || !Number.isSafeInteger(r.attempt) || r.attempt < 1)
        || batch.plan.actionId === batch.rest.actionId || batch.plan.incidentId !== batch.rest.incidentId
        || batch.plan.attempt !== batch.rest.attempt || batch.plan.episodeCaptureId !== batch.rest.episodeCaptureId
        || JSON.stringify(batch.plan.fence) !== JSON.stringify(batch.rest.fence)) return "agi.action.invalid";
      const incident = this.incidents.get(batch.plan.incidentId);
      if (!incident || incident.goalId !== batch.plan.fence.goalId) return "agi.action.incident-unknown";
      // Original Main custody travels separately from model action data. Read-only
      // settled replay above remains valid after this decision's lifetime ends.
      if (!decision || decision.goalId !== incident.goalId || decision.runId !== batch.plan.fence.runId
        || decision.incidentId !== incident.id || incident.attempts !== batch.plan.attempt) return AGI_DECISION_CONTROL_CHANGED;
      try { assertAgiDecisionControl(decision.decisionControl, decision); } catch { return AGI_DECISION_CONTROL_CHANGED; }
      const goal = this.deps.goal(incident.goalId);
      if (!goal || goal.runId !== batch.plan.fence.runId || goal.version !== batch.plan.fence.runVersion) return "agi.action.stale";
      if (goal.status !== "running" || (goal.pauseReason && OWNER_BOUNDARY_PAUSES.has(goal.pauseReason))) return "agi.action.owner-boundary";
      if (goal.permission !== "write" && goal.permission !== "full") return "agi.plan.permission-read";
      const history = this.history(incident.id);
      // A repeated or failed replan does not run again as part of this batch. The code is not a stop: a model attempt
      // whose actions all come back refused hands the incident to the deterministic path, which escalates
      // (repeatEscalation: the runtime's own tools, another runtime, the next work turn). A rest is never limited.
      for (const r of requests) {
        if (NEVER_ESCALATED.has(r.action)) continue;
        if (history.filter(h => h.action === r.action).length >= MAX_SAME_MOVE_PER_CAUSE || this.incidents.ruledOut(incident.id).has(r.action)) return "agi.action.repeat-escalated";
      }
      return this.deps.strategy ? null : "goal_strategy_unavailable";
    };
    const refusal = gate();
    if (refusal) return failed(refusal).map((r,i) => this.settle(requests[i],{ ...r, detail: { batchDigest } },0));
    // Preparation has no execution effects. Keep live preparation exclusion local;
    // a crash may leave reserved audit, but must never leave durable action claims.
    let preparing = strategyPreparations.get(this.deps.db);
    if (!preparing) { preparing = new Map(); strategyPreparations.set(this.deps.db, preparing); }
    const goalId = batch.plan.fence.goalId;
    const hasClaim = () => requests.some(r => this.deps.db.prepare("SELECT 1 FROM agi_action_receipts WHERE goal_id=? AND action=? AND status='claimed'")
      .get(r.fence.goalId,r.action));
    const activePreparation = preparing.get(goalId);
    if (activePreparation) return failed(activePreparation.digest !== batchDigest
      && requests.some(r => activePreparation.actionIds.includes(r.actionId)) ? "goal_strategy_request_conflict" : "agi.action.in-flight");
    if (hasClaim()) return failed("agi.action.in-flight");
    preparing.set(goalId, { digest: batchDigest, actionIds: requests.map(r => r.actionId) });
    try {
      const prepared = await this.deps.strategy!.prepare(batch,decision);
      const receipts = desktopStoreTransaction(this.deps.db,() => {
        const replay = requests.map(r => this.receipt(r.actionId));
        if (replay.some(Boolean)) {
          if (!replay.every(r => r?.detail?.batchDigest === batchDigest)) throw new Error("goal_strategy_request_conflict");
          return replay.map(r => ({ ...r!, replayed: true }));
        }
        const stale = gate(); if (stale) throw new Error(stale);
        if (hasClaim()) throw new Error("agi.action.in-flight");
        for (const r of requests) this.deps.db.prepare(`INSERT INTO agi_action_receipts
          (action_id,incident_id,goal_id,attempt,action,status,created_at_ms) VALUES (?,?,?,?,?,'claimed',?)`)
          .run(r.actionId,r.incidentId,r.fence.goalId,r.attempt,r.action,this.deps.now());
        const result = this.deps.strategy!.commit(batch,prepared,decision);
        if (result.status !== "wait_registered" || !result.waitId || !result.checkpointId) throw new Error(result.code);
        return requests.map((r,i) => this.settle(r,{ actionId: r.actionId, action: r.action, ok: true,
          code: i === 0 ? "agi.plan.applied" : "goal_episode_wait_registered", detail: { ...result, batchDigest } }));
      }).immediate();
      try { this.deps.afterRest?.(); } catch { /* Persisted outbox owns delivery; never repeat work. */ }
      return receipts;
    } catch (error) {
      const replay = requests.map(r => this.receipt(r.actionId));
      if (replay.some(Boolean)) return replay.every(r => r?.detail?.batchDigest === batchDigest)
        ? replay.map(r => ({ ...r!, replayed: true })) : failed("goal_strategy_request_conflict");
      // Any surviving claim belongs to another executor: our own commit rolled back.
      // Never settle a legacy/unknown effect merely because preparation was refused.
      if (requests.some(r => this.deps.db.prepare("SELECT 1 FROM agi_action_receipts WHERE action_id=? AND status='claimed'").get(r.actionId)))
        return failed("agi.action.in-flight");
      const code = error instanceof Error && /^[a-z][a-z0-9._:-]{2,120}$/.test(error.message) ? error.message : "goal_strategy_unavailable";
      return desktopStoreTransaction(this.deps.db,() => failed(code).map((receipt,i) => this.settle(requests[i],
        { ...receipt, detail: { batchDigest } },0))).immediate();
    } finally {
      preparing.delete(goalId);
    }
  }

  execute(request: AgiActionRequest, decision?: AgiUnblockInput): AgiActionReceipt {
    const replay = request && typeof request.actionId === "string" ? this.receipt(request.actionId) : null;
    if (replay) {
      if (request.action === "rest" && replay.detail?.requestDigest && replay.detail.requestDigest !== restRequestDigest(request))
        return { actionId: request.actionId, action: request.action, ok: false, code: "goal_episode_request_conflict" };
      return { ...replay, replayed: true };
    }
    // A previously claimed action can have an unknown external effect. Never execute it again.
    if (request && typeof request.actionId === "string" && this.deps.db.prepare(
      "SELECT 1 FROM agi_action_receipts WHERE action_id=? AND status='claimed'").get(request.actionId)) {
      return { actionId: request.actionId, action: request.action, ok: false, code: "agi.action.in-flight" };
    }
    // A refused precondition is recorded (replay-stable) with attempt 0: it was never executed, so it counts neither
    // toward the per-attempt cap nor the circuit breaker nor G1.
    const refuse = (code: string, detail?: Record<string, unknown>): AgiActionReceipt => this.settle(request, { actionId: String(request?.actionId ?? ""), action: String(request?.action ?? ""), ok: false, code, ...(detail ? { detail } : {}) }, 0);
    // 1. shape
    if (!request || request.schema !== AGI_ACTION_SCHEMA || !ACTION_ID.test(String(request.actionId))
      || !(AGI_ACTION_KINDS as readonly string[]).includes(request.action) || !Number.isSafeInteger(request.attempt) || request.attempt < 1
      || !request.fence || typeof request.fence.goalId !== "string" || typeof request.fence.runId !== "string" || !Number.isSafeInteger(request.fence.runVersion)) {
      if (!request || !ACTION_ID.test(String(request?.actionId ?? ""))) return { actionId: String(request?.actionId ?? ""), action: String(request?.action ?? ""), ok: false, code: "agi.action.invalid" };
      return refuse("agi.action.invalid");
    }
    const incident = this.incidents.get(request.incidentId);
    if (!incident || incident.goalId !== request.fence.goalId) return refuse("agi.action.incident-unknown");
    if (request.action === "restart_agentlas_browser" || request.action === "run_login_recovery") {
      if (!decision || decision.goalId !== request.fence.goalId || decision.runId !== request.fence.runId
        || decision.incidentId !== incident.id || request.attempt !== incident.attempts) return refuse(AGI_DECISION_CONTROL_CHANGED);
      try { assertAgiDecisionControl(decision.decisionControl, decision); } catch { return refuse(AGI_DECISION_CONTROL_CHANGED); }
      if (this.isDeferredBusy(decision.goalId)) return refuse("agi.action.in-flight");
    }
    // 2. fence against the ledger now
    const goal = this.deps.goal(request.fence.goalId);
    if (!goal || goal.runId !== request.fence.runId || goal.version !== request.fence.runVersion) return refuse("agi.action.stale");
    // 3. owner boundaries: nothing but a defect record on a goal the owner stopped / must approve / must fund
    if (goal.status === "paused" && OWNER_BOUNDARY_PAUSES.has(goal.pauseReason ?? "") && request.action !== "file_defect") {
      return refuse(`agi.action.owner-boundary:${goal.pauseReason}`);
    }
    if (["completed", "failed", "cancelled", "cancelling"].includes(goal.status) && request.action !== "file_defect") return refuse("agi.action.goal-terminal");
    // 4. per-attempt action cap, circuit breaker, ruled-out actions
    const history = this.history(incident.id);
    // No count cap. Spin guard only: the identical (action, canonical args) already executed in this attempt is refused.
    // A rest and a defect record are idempotent by design and exempt.
    const repeatDigest = agiActionRepeatDigest(request.action, request.args);
    if (!["file_defect", "rest"].includes(request.action) && this.deps.db.prepare(
      `SELECT 1 FROM agi_action_receipts WHERE incident_id = ? AND attempt = ? AND status = 'settled'
        AND json_extract(result_json, '$.detail.repeatDigest') = ? LIMIT 1`).get(incident.id, request.attempt, repeatDigest)) {
      return refuse(AGI_REPEAT_IN_ATTEMPT_CODE);
    }
    // Owner 2026-10-12: a repeat is not refused. It used to be (agi.action.circuit-open 2,376 times in production, almost
    // all of them a rest), which left the goal where it was; the next deterministic move runs instead.
    const repeated = history.filter((entry) => entry.action === request.action).length >= MAX_SAME_MOVE_PER_CAUSE;
    const failedHere = this.incidents.ruledOut(incident.id).has(request.action);
    if ((repeated || failedHere) && !NEVER_ESCALATED.has(request.action)) {
      const next = repeatEscalation(incident, request.action, history, { nativeHarness: goal.permission === "write" || goal.permission === "full",
        runtimeSwitch: this.deps.canSwitchRuntime?.(goal.goalId) });
      request = { ...request, action: next.action, args: { ...next.args, escalatedFrom: request.action } };
    }
    // 5. Tokens (D1): the AGI caps govern the unblocker's own model calls (model-attempt.ts admits each one). A work turn
    // or a teammate session this action starts is goal work, governed by the goal's own budget and permission — the
    // same turn the sweep would start — so it is not refused by the AGI cap (that would stall the goal on AGI's bill).
    // 6. G1 + boundary rules for the ask
    if (request.action === "ask_owner_once") {
      const boundary = request.args?.boundary;
      if (!isPersistenceBoundaryKind(boundary)) return refuse("agi.ask.boundary-required", { allowed: [...PERSISTENCE_BOUNDARY_KINDS] });
      if (boundary === "owner_stop") return refuse("agi.ask.owner-stop-is-not-asked");
      // The model names the boundary, the host's diagnosis decides it: an ask for a boundary the incident does not carry is refused
      // (a model could otherwise put a "payment" or "credential" question in the owner's room on any incident).
      if (incident.diagnosis.boundary !== boundary) return refuse("agi.ask.boundary-mismatch", { expected: incident.diagnosis.boundary ?? null });
      const alternatives = history.filter((entry) => entry.ok && !AGI_NON_ALTERNATIVE_ACTIONS.has(entry.action as AgiActionKind));
      if (!alternatives.length) return refuse("agi.ask.alternative-path-required");
      // Once per boundary per goal (not per incident): a moved digest is not a new question (R17, no repeats while
      // nothing changes). The same boundary may be asked again only a day later.
      const asked = this.deps.db.prepare(`SELECT 1 FROM agi_action_receipts WHERE goal_id = ? AND action = 'ask_owner_once' AND ok = 1
        AND json_extract(result_json, '$.detail.boundary') = ? AND settled_at_ms > ?`).get(goal.goalId, boundary, this.deps.now() - 24 * 60 * 60_000);
      if (asked) return refuse("agi.ask.already-asked");
    }
    if (request.action === "rest") {
      // This local-only action can commit claim, checkpoint, wait, disposition,
      // notification outbox and action settlement together. No network in here.
      let settled: AgiActionReceipt;
      try { settled = desktopStoreTransaction(this.deps.db, () => {
        const claim = this.deps.db.prepare(`INSERT INTO agi_action_receipts
          (action_id,incident_id,goal_id,attempt,action,status,created_at_ms) VALUES (?,?,?,?,?,'claimed',?)`)
          .run(request.actionId, incident.id, goal.goalId, request.attempt, request.action, this.deps.now());
        if (claim.changes !== 1) throw new Error("goal_episode_claim_failed");
        return this.settle(request, this.run(request, goal, incident.id));
      }).immediate(); } catch {
        return { actionId: request.actionId, action: request.action, ok: false, code: "goal_episode_storage_unavailable" };
      }
      try { this.deps.afterRest?.(); } catch { /* A local notice never repeats work. */ }
      return settled;
    }
    // 7. durable claim, then the effect
    const claimed = this.deps.db.prepare(`INSERT INTO agi_action_receipts(action_id,incident_id,goal_id,attempt,action,status,created_at_ms)
      SELECT ?,?,?,?,?,'claimed',? WHERE NOT EXISTS
        (SELECT 1 FROM agi_action_receipts WHERE goal_id=? AND action=? AND status='claimed')
      ON CONFLICT(action_id) DO NOTHING`)
      .run(request.actionId, incident.id, goal.goalId, request.attempt, request.action, this.deps.now(), goal.goalId, request.action);
    if (claimed.changes !== 1) return this.receipt(request.actionId) ?? { actionId: request.actionId, action: request.action, ok: false, code: "agi.action.in-flight" };
    let result: AgiActionReceipt;
    try {
      result = this.run(request, goal, incident.id, decision);
    } catch (error) {
      // A typed code thrown by a product path is kept. Anything else is an untyped exception: its reason stays in the receipt
      // (redacted, 120 chars) instead of vanishing into a generic code, and its code (agi.action.threw) is neither "failed" for the
      // ruled-out rule below nor an executed move for repeat escalation, so a reason nobody knows does not pick the next move
      // (production: dispatch_teammate agi.action.failed 48 times, reason lost).
      const typed = error instanceof Error && /^[a-z][a-z0-9._:-]{2,120}$/.test(error.message) ? error.message : null;
      result = typed ? { actionId: request.actionId, action: request.action, ok: false, code: typed }
        : { actionId: request.actionId, action: request.action, ok: false, code: AGI_ACTION_THREW_CODE, detail: { reason: untypedReason(error) } };
    }
    if (typeof request.args?.escalatedFrom === "string") result = { ...result, detail: { ...(result.detail ?? {}), escalatedFrom: request.args.escalatedFrom } };
    result = { ...result, detail: { ...(result.detail ?? {}), repeatDigest } };
    const settled = this.settle(request, result);
    this.incidents.reflect(incident.id, { atMs: this.deps.now(), action: request.action, result: settled.ok ? "ok" : `refused:${settled.code}`,
      evidenceRefs: Array.isArray(settled.detail?.evidenceRefs) ? settled.detail!.evidenceRefs as string[] : [],
      // A failed effect is ruled out for this incident (R2); a refused precondition is not an attempt.
      ruledOut: !settled.ok && /\.failed$|-failed$|unavailable$/.test(settled.code) });
    // The room is One's (owner 2026-10-12: "AGI · Motiondirector에게 t5 작업을 맡겼어요 같은 거 쓰지 마라"). AGI's own
    // actions are host bookkeeping: they stay in the receipts and the Goal panel (goal-panel.ts) and never become room
    // messages. Only an ask the owner must answer is posted, and it is posted BEFORE its receipt settles ok (deliverOwnerAsk).
    return settled;
  }

  /**
   * The owner-visible ask (ask_owner_once, request_app_restart) reaches the room before the action counts as done. The "already asked"
   * rules read ok receipts, so an ask whose notice never went out (no room, no announce seam, the post threw) must not be one:
   * it would silence the question for a day while the owner never saw it. Idempotent per actionId (the seam skips a posted one).
   */
  private deliverOwnerAsk(request: AgiActionRequest, goal: AgiGoalView, delivered: AgiActionReceipt): AgiActionReceipt {
    const line = noticeLine(request.action, delivered);
    if (!line) return delivered;
    if (!goal.chatId || !this.deps.announce) return { ...delivered, ok: false, code: AGI_ASK_NOT_DELIVERED_CODE, detail: { ...(delivered.detail ?? {}), reason: !goal.chatId ? "no-room" : "no-announce-seam" } };
    // The card follows the typed fact: a persistence boundary, or the app restart ask. No other ask has a card kind.
    const boundary = (delivered.detail ?? {}).boundary;
    const card: AgiOwnerAskCardKind | undefined = request.action === "request_app_restart" ? "app_restart"
      : isPersistenceBoundaryKind(boundary) ? boundary : undefined;
    try { this.deps.announce({ chatId: goal.chatId, actionId: request.actionId, kind: "ask", text: line, ...(card ? { card } : {}) }); }
    catch (error) { return { ...delivered, ok: false, code: AGI_ASK_NOT_DELIVERED_CODE, detail: { ...(delivered.detail ?? {}), reason: untypedReason(error) } }; }
    return delivered;
  }

  /** The end of an async action (login ladder, browser restart): a reflection on the incident, never a second receipt. */
  private later(request: AgiActionRequest, goal: AgiGoalView, incidentId: string, code: string, failed: boolean, browser?: AgiBrowserRestartOutcome, login?: AgiLoginRecoveryResult): void {
    try {
      this.incidents.reflect(incidentId, { atMs: this.deps.now(), action: request.action, result: failed ? `failed:${code}` : code,
        evidenceRefs: [`agi-action:${request.actionId}`], ruledOut: failed });
      this.deps.db.prepare("UPDATE agi_action_receipts SET result_json = json_set(result_json, '$.detail.completion', ?) WHERE action_id = ?")
        .run(code, request.actionId);
      if (browser) this.deps.db.prepare("UPDATE agi_action_receipts SET result_json = json_set(result_json, '$.detail.browser', json(?)) WHERE action_id = ?")
        .run(JSON.stringify(browser), request.actionId);
      if (login) this.deps.db.prepare("UPDATE agi_action_receipts SET result_json = json_set(result_json, '$.detail.login', json(?)) WHERE action_id = ?")
        .run(JSON.stringify(login), request.actionId);
      // A recovered login or restarted browser is AGI bookkeeping too: no room message (see run() above).
    } catch { /* the store may be closing */ }
  }

  private settle(request: AgiActionRequest, result: AgiActionReceipt, attemptOverride?: number): AgiActionReceipt {
    const incidentId = typeof request?.incidentId === "string" ? request.incidentId : "";
    const goalId = typeof request?.fence?.goalId === "string" ? request.fence.goalId : "";
    this.deps.db.prepare(`INSERT INTO agi_action_receipts(action_id,incident_id,goal_id,attempt,action,status,ok,code,result_json,created_at_ms,settled_at_ms)
      VALUES (?,?,?,?,?,'settled',?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET status='settled', ok=excluded.ok, code=excluded.code,
      result_json=excluded.result_json, settled_at_ms=excluded.settled_at_ms WHERE agi_action_receipts.status='claimed'`)
      .run(result.actionId, incidentId, goalId, attemptOverride ?? (Number(request?.attempt) || 0), result.action, result.ok ? 1 : 0, result.code,
        JSON.stringify(result), this.deps.now(), this.deps.now());
    return this.receipt(result.actionId) ?? result;
  }

  private run(request: AgiActionRequest, goal: AgiGoalView, incidentId: string, decision?: AgiUnblockInput): AgiActionReceipt {
    const ok = (code: string, detail?: Record<string, unknown>): AgiActionReceipt => ({ actionId: request.actionId, action: request.action, ok: true, code, ...(detail ? { detail } : {}) });
    const no = (code: string, detail?: Record<string, unknown>): AgiActionReceipt => ({ actionId: request.actionId, action: request.action, ok: false, code, ...(detail ? { detail } : {}) });
    const args = request.args ?? {};
    const writeCapable = goal.permission === "write" || goal.permission === "full";
    switch (request.action) {
      case "create_teammate": {
        if (!this.deps.team || !goal.chatId) return no("agi.team.unavailable");
        if (!writeCapable) return no("agi.team.permission-read");
        if (this.incidents.get(incidentId)?.diagnosis.ownerClass === "human_only") return no(AGI_HUMAN_ONLY_INCIDENT_CODE);
        const name = text(args.name, 80);
        if (!name) return no("agi.team.name-required");
        const made = this.deps.team.create(goal.chatId, agiTeamPermission(goal.permission), { name, ...(text(args.role, 100) ? { role: text(args.role, 100)! } : {}),
          ...(text(args.personality, 1_200) ? { personality: text(args.personality, 1_200)! } : {}) });
        return ok(made.created ? "agi.team.created" : "agi.team.already-exists", { memberId: made.memberId, name });
      }
      case "invite_teammate": {
        if (!this.deps.team || !goal.chatId) return no("agi.team.unavailable");
        if (!writeCapable) return no("agi.team.permission-read");
        const member = text(args.member, 120);
        if (!member) return no("agi.team.member-required");
        const joined = this.deps.team.invite(goal.chatId, agiTeamPermission(goal.permission), member);
        return ok(joined.joined ? "agi.team.invited" : "agi.team.already-member", { memberId: joined.memberId, member,
          ...(joined.memberName ? { memberName: joined.memberName } : {}) });
      }
      case "dispatch_teammate": {
        if (!this.deps.team || !goal.chatId) return no("agi.team.unavailable");
        if (!writeCapable) return no("agi.team.permission-read");
        if (this.incidents.get(incidentId)?.diagnosis.ownerClass === "human_only") return no(AGI_HUMAN_ONLY_INCIDENT_CODE);
        const member = text(args.member, 120);
        const brief = text(args.brief, 4_000);
        const nodeId = text(args.nodeId, 80);
        if (!member || !brief || !nodeId) return no("agi.team.dispatch-args-required");
        const plan = this.deps.plan?.read(goal.goalId) ?? null;
        if (!plan?.tactics.some((tactic) => tactic.id === nodeId && tactic.status === "active")) return no("agi.team.node-not-active");
        const dayAgo = this.deps.now() - 24 * 60 * 60_000;
        const recent = (this.deps.db.prepare(`SELECT settled_at_ms AS at FROM agi_action_receipts
          WHERE goal_id = ? AND action = 'dispatch_teammate' AND status = 'settled' AND ok = 1
            AND json_extract(result_json, '$.detail.nodeId') = ? AND settled_at_ms > ? ORDER BY settled_at_ms DESC`)
          .all(goal.goalId, nodeId, dayAgo) as Array<{ at: number }>).map((row) => row.at);
        if (recent.length >= AGI_TACTIC_DISPATCHES_PER_DAY) {
          // Allowed again once the oldest of the newest `limit` dispatches is a day old.
          return no(AGI_TACTIC_DAILY_LIMIT_CODE, { nodeId, dispatched: recent.length, limit: AGI_TACTIC_DISPATCHES_PER_DAY,
            nextAllowedAt: new Date(recent[AGI_TACTIC_DISPATCHES_PER_DAY - 1]! + 24 * 60 * 60_000).toISOString() });
        }
        const session = this.deps.team.dispatch(goal.chatId, agiTeamPermission(goal.permission), { member, brief: `[${nodeId}] ${AGI_BRIEF_PROVENANCE} ${brief}`, runId: goal.runId,
          delegationPermission: "write" });
        return ok("agi.team.dispatched", { sessionId: session.sessionId, member, nodeId,
          ...(session.memberName ? { memberName: session.memberName } : {}) });
      }
      case "switch_runtime": {
        if (!this.deps.recordMove) return no("agi.move.unavailable");
        const recorded = this.deps.recordMove(goal.goalId, goal.runId, "switch_runtime", { incidentId, reason: text(args.reason, 120) });
        if (recorded && recorded.ok === false) return no(recorded.code);
        // The owner line names why (soak 1.2.50: a bare "다음 실행은 다른 모델로 이어가요" with no reason).
        return ok("agi.move.switch-runtime-recorded", { causeKind: this.incidents.get(incidentId)?.diagnosis.causeKind ?? null });
      }
      case "retry_node_with": {
        const nodeId = text(args.nodeId, 80);
        const path = text(args.path, 120);
        const capability = text(args.capability, 80);
        if (!nodeId || !path || !capability) return no("agi.retry.args-required");
        const installed = this.deps.installedPaths?.(capability) ?? [];
        if (!installed.includes(path)) return no("agi.retry.path-not-installed", { installed });
        if (!this.deps.recordMove) return no("agi.move.unavailable");
        const recorded = this.deps.recordMove(goal.goalId, goal.runId, "switch_tool", { incidentId, nodeId, capability, path });
        if (recorded && recorded.ok === false) return no(recorded.code);
        return ok("agi.retry.recorded", { nodeId, path });
      }
      case "use_native_harness": {
        // An Agentlas capability keeps failing for this goal (our defect): until it recovers, every step that needs it is
        // done with the runtime's own tools (shell, direct API calls with the saved keys, local programs, its built-in
        // web access) and Agentlas only records the outputs. The failure is the goal's, not one tactic's: the browser
        // ladder and run receipts are chat-level facts. Host facts only; no model judgment chooses it.
        const capability = text(args.capability, 80);
        const defect = text(args.defect, 120) || "our_defect";
        if (capability !== "browser" && capability !== "tool") return no("agi.harness.capability-required");
        // The runtime's own tools are write-capable (shell, direct API with saved keys): never for a read-only Goal.
        if (!writeCapable) return no("agi.harness.permission-read");
        // The host's own reading of the incident decides, not the model's argument: only a broken tool (agiHarnessCapability) is answered
        // this way, never an ownership, consent, approval or credential verdict.
        const incident = this.incidents.get(incidentId);
        if (!incident || agiHarnessCapability(incident.diagnosis) !== capability) return no("agi.harness.not-indicated");
        if (!this.deps.recordMove) return no("agi.move.unavailable");
        const recorded = this.deps.recordMove(goal.goalId, goal.runId, "native_harness", { incidentId, capability, defect });
        if (recorded && recorded.ok === false) return no(recorded.code);
        return ok("agi.harness.recorded", { capability, defect });
      }
      case "replan_tree": {
        if (!this.deps.plan) return no("agi.plan.unavailable");
        const plan = this.deps.plan.read(goal.goalId);
        if (!plan) return no("agi.plan.missing");
        const ops = Array.isArray(args.ops) ? args.ops as AgiPlanOp[] : [];
        if (!ops.length || ops.length > 12) return no("agi.plan.ops-invalid");
        const byId = new Map(plan.tactics.map((tactic) => [tactic.id, tactic]));
        for (const op of ops) {
          const raw = op as unknown as Record<string, unknown>;
          // R9: intent (purpose + end state) is the owner's. Any op that carries an intent edit is purpose_change.
          if ("intent" in raw || "doneWhen" in raw || "done_when" in raw || "objective" in raw || "mission" in raw) {
            // Refused, and kept as the owner's suggestion: the goal panel shows it with Accept (owner edits intent).
            return no("agi.plan.purpose-change-boundary", { boundary: "purpose_change" satisfies PersistenceBoundaryKind,
              proposals: ops.map(intentProposal).filter((proposal): proposal is AgiIntentProposal => proposal !== null).slice(0, 6) });
          }
          if (op.op === "split") {
            const node = byId.get(op.nodeId);
            if (!node) return no("agi.plan.node-unknown");
            // R3 (ADaPT): split only after an observed failure on that node.
            if (node.failures < 1) return no("agi.plan.split-needs-failure");
            if (!Array.isArray(op.into) || op.into.length < 2 || op.into.length > 5 || op.into.some((part) => !text(part?.description, 400))) return no("agi.plan.split-invalid");
          } else if (op.op === "merge") {
            const keep = byId.get(op.keep);
            if (!keep || !Array.isArray(op.retire) || !op.retire.length) return no("agi.plan.merge-invalid");
            if (op.retire.some((id) => !byId.has(id) || byId.get(id)!.strategyId !== keep.strategyId)) return no("agi.plan.merge-across-strategy");
          } else if (op.op === "retire" || op.op === "reorder") {
            if (!byId.has(op.nodeId)) return no("agi.plan.node-unknown");
            if (op.op === "reorder" && !Number.isSafeInteger(op.ord)) return no("agi.plan.ops-invalid");
          } else {
            return no("agi.plan.ops-invalid");
          }
        }
        this.deps.plan.apply(goal.goalId, plan, ops);
        return ok("agi.plan.applied", { ops: ops.map((op) => op.op) });
      }
      case "start_work_turn": {
        const outcome = this.deps.continueGoal(goal.runId, goal.version);
        if (outcome.action === "resumed" || outcome.action === "observation_dispatched") {
          return ok(outcome.action === "resumed" ? "agi.turn.started" : "agi.turn.observing", { invocationRunId: outcome.detail, nodeId: text(args.nodeId, 80) });
        }
        return no(`agi.turn.${outcome.action}`, { detail: outcome.detail });
      }
      case "run_login_recovery": {
        const domain = text(args.domain, 200);
        if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) return no("agi.login.domain-required");
        if (!this.deps.runLoginRecovery) return no("agi.login.ladder-unavailable");
        if (!decision) return no(AGI_DECISION_CONTROL_CHANGED);
        const original = Object.freeze({ ...decision });
        const release = retainAgiDecisionControl(original);
        let finish!: () => void;
        const promise = new Promise<void>(resolve => { finish = resolve; });
        this.deferredBrowser.set(request.actionId, { goalId: goal.goalId, promise });
        const cleanup = () => {
          try { release(); } finally { this.deferredBrowser.delete(request.actionId); finish(); }
        };
        const complete = (value: AgiLoginRecoveryOutcome | AgiLoginRecoveryResult) => {
          const outcome: AgiLoginRecoveryResult = typeof value === "string"
            ? { state: value, directEffect: "unknown", acknowledgedWritten: 0, observerEffect: "unknown" } : value;
          this.later(request, goal, incidentId, `agi.login.${outcome.state}`, outcome.state === "unavailable", undefined, outcome);
        };
        let recovered: ReturnType<NonNullable<AgiExecutorDeps["runLoginRecovery"]>>;
        let admitted = false;
        try {
          const control: AgiLoginRecoveryControl = { signal: agiDecisionAbortSignal(original),
            assertCurrent: () => assertAgiDecisionControl(original.decisionControl, original) };
          control.assertCurrent();
          admitted = true;
          recovered = this.deps.runLoginRecovery({ domain, goalId: goal.goalId, runId: goal.runId, chatId: goal.chatId }, control);
        } catch (error) {
          if (!admitted) { cleanup(); throw error; }
          recovered = Promise.reject(error);
        }
        // Acceptance and terminal evidence survive revocation; a throwing admitted seam is not no-action proof.
        void Promise.resolve(recovered).then(complete, () => complete({ state: "unknown", directEffect: "unknown", acknowledgedWritten: 0, observerEffect: "unknown" }))
          .finally(cleanup).catch(() => { /* reflection cannot repeat admitted work */ });
        return ok("agi.login.dispatched", { domain });
      }
      case "restart_agentlas_browser": {
        if (!this.deps.restartAgentlasBrowser) return no("agi.browser.restart-unavailable");
        if (!decision) return no(AGI_DECISION_CONTROL_CHANGED);
        const original = Object.freeze({ ...decision });
        const release = retainAgiDecisionControl(original);
        let finish!: () => void;
        const promise = new Promise<void>(resolve => { finish = resolve; });
        // Register before calling the seam, including synchronous reentrancy.
        this.deferredBrowser.set(request.actionId, { goalId: goal.goalId, promise });
        const cleanup = () => {
          try { release(); } finally { this.deferredBrowser.delete(request.actionId); finish(); }
        };
        const complete = (value: boolean | AgiBrowserRestartOutcome) => {
          const outcome: AgiBrowserRestartOutcome = typeof value === "boolean"
            ? { state: value ? "ready" : "unknown", closeEffect: "unknown" } : value;
          const code = outcome.state === "ready"
            ? outcome.closeEffect === "closed" ? "agi.browser.restarted" : "agi.browser.ready"
            : `agi.browser.restart-${outcome.state}`;
          this.later(request, goal, incidentId, code, outcome.state === "failed", outcome);
        };
        let restarted: ReturnType<NonNullable<AgiExecutorDeps["restartAgentlasBrowser"]>>;
        let admitted = false;
        try {
          const control: AgiBrowserRestartControl = { signal: agiDecisionAbortSignal(original),
            assertCurrent: () => assertAgiDecisionControl(original.decisionControl, original) };
          control.assertCurrent();
          admitted = true;
          restarted = this.deps.restartAgentlasBrowser(control);
        } catch (error) {
          if (!admitted) { cleanup(); throw error; }
          restarted = Promise.reject(error); // A throwing admitted seam does not prove no effect.
        }
        // Terminal evidence is unconditional, even after Stop or a failed DB read.
        void Promise.resolve(restarted).then(complete, () => complete({ state: "unknown", closeEffect: "unknown" }))
          .finally(cleanup).catch(() => { /* reflection cannot repeat admitted work */ });
        return ok("agi.browser.restart-dispatched");
      }
      case "request_app_restart": {
        // The owner pays for a restart; ask only when the incident's typed cause is one a restart clears
        // (AGI_APP_RESTART_CAUSES). "Not tried yet" is not a basis (Yotube 2026-10-17: the restart changed nothing).
        const indicated = this.incidents.get(incidentId)?.diagnosis.appRestart;
        if (!indicated) return no("agi.app-restart.not-indicated");
        const asked = this.deps.db.prepare("SELECT 1 FROM agi_action_receipts WHERE incident_id = ? AND action = 'request_app_restart' AND ok = 1").get(incidentId);
        if (asked) return no("agi.ask.already-asked");
        return this.deliverOwnerAsk(request, goal, ok("agi.app-restart.asked", { reason: text(args.reason, 200), cause: indicated.code }));
      }
      case "file_defect": {
        const named = text(args.code, 160);
        if (!named || !/^[a-z0-9_:.-]+$/i.test(named)) return no("agi.defect.code-required");
        const evidenceRefs = Array.isArray(args.evidenceRefs) ? args.evidenceRefs.filter((ref): ref is string => typeof ref === "string").slice(0, 12) : [];
        if (!evidenceRefs.length) return no("agi.defect.evidence-required");
        const category = ["crash", "stall", "wrong-result", "ui", "login", "other"].includes(String(args.category)) ? String(args.category) : "other";
        // A defect's identity is host-typed: one of the incident's own defect findings, or else the incident's reason code
        // and category. A model names the same defect differently every time (production 2026-10-12: 65 reports with 65
        // spellings from run_failed_unknown incidents, 44 from boundary_payment), so its name never matched
        // UNIQUE(goal_id, code) and each attempt filed a new report. The incident and evidence refs carry the specifics.
        const incident = this.incidents.get(incidentId);
        const typed = incident?.diagnosis.defects?.some((finding) => finding.code === named) === true;
        const code = typed || !incident ? named : `${incident.reasonCode}:${category}`;
        const id = `agi-defect:${request.actionId}`;
        const inserted = this.deps.db.prepare(`INSERT INTO agi_defect_reports(id,goal_id,chat_id,incident_id,code,category,evidence_json,workaround,created_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id, code) DO NOTHING`)
          .run(id, goal.goalId, goal.chatId, incidentId, code, category, JSON.stringify(evidenceRefs), text(args.workaround, 400), this.deps.now()).changes > 0;
        if (inserted) {
          try { this.deps.onDefectFiled?.({ defectId: id, goalId: goal.goalId, chatId: goal.chatId, code }); } catch { /* chip refresh only */ }
        }
        return ok(inserted ? "agi.defect.filed" : "agi.defect.already-filed", { code, evidenceRefs });
      }
      case "ask_owner_once": {
        const ask = text(args.ask, 400);
        const resumesWith = text(args.resumesWith, 200);
        if (!ask || !resumesWith) return no("agi.ask.text-required");
        return this.deliverOwnerAsk(request, goal, ok("agi.ask.posted", { boundary: args.boundary, ask, resumesWith }));
      }
      case "rest": {
        if (!this.deps.rest) return no("goal_episode_adapter_unavailable");
        const disposition = this.deps.rest(request);
        const detail = { ...disposition, requestDigest: restRequestDigest(request) };
        return disposition.status === "wait_registered" ? ok(disposition.code, detail) : no(disposition.code, detail);
      }
    }
    return no("agi.action.invalid");
  }
}

/** An intent edit the AGI proposed (refused as purpose_change); the owner may accept it in the goal panel. */
export interface AgiIntentProposal { nodeId: string | null; field: "objective" | "intent" | "done_when"; text: string }

function intentProposal(op: AgiPlanOp): AgiIntentProposal | null {
  const raw = op as unknown as Record<string, unknown>;
  const nodeId = text(raw.nodeId, 80) ?? text(raw.keep, 80);
  const objective = text(raw.objective, 600) ?? (raw.mission && typeof raw.mission === "object" ? text((raw.mission as Record<string, unknown>).objective, 600) : null);
  if (objective) return { nodeId: null, field: "objective", text: objective };
  const doneWhen = text(raw.doneWhen, 600) ?? text(raw.done_when, 600);
  const intent = text(raw.intent, 600);
  if (intent && nodeId) return { nodeId, field: "intent", text: intent };
  if (doneWhen && nodeId) return { nodeId, field: "done_when", text: doneWhen };
  return null;
}

const SWITCH_RUNTIME_WHY: Record<string, { ko: string; en: string }> = {
  quota: { ko: "지금 모델의 사용 한도가 차서", en: "The current model hit its usage limit." },
  auth: { ko: "지금 모델의 로그인이 풀려서", en: "The current model is signed out." },
  runtime_unavailable: { ko: "지금 모델을 쓸 수 없어서", en: "The current model is unavailable." },
  judge_unavailable: { ko: "결과를 판정할 모델이 응답하지 않아서", en: "The model that judges results did not answer." },
  claimed_without_tools: { ko: "지금 모델이 도구 없이 끝났다고만 해서", en: "The current model claimed completion without using its tools." },
  session_conflict: { ko: "지금 모델의 세션이 충돌해서", en: "The current model's session conflicted." },
};

const OWNER_ASK_TEMPLATE: Record<PersistenceBoundaryKind, { ko: string; en: string }> = {
  payment: { ko: "결제 승인이 필요해서 이 부분은 멈춰 있어요. 승인해 주시면 자동으로 이어가요.", en: "A payment approval is needed, so this part is on hold. It resumes by itself once you approve." },
  credential: { ko: "로그인이나 인증 정보가 필요해서 이 부분은 멈춰 있어요. 준비해 주시면 자동으로 이어가요.", en: "A sign-in or credential is needed, so this part is on hold. It resumes by itself once you provide it." },
  security_consent: { ko: "보안 확인(동의)이 필요해서 이 부분은 멈춰 있어요. 확인해 주시면 자동으로 이어가요.", en: "A security confirmation (consent) is needed, so this part is on hold. It resumes by itself once you confirm." },
  purpose_change: { ko: "목표 자체를 바꿔야 풀리는 일이라 이 부분은 멈춰 있어요. 결정해 주시면 자동으로 이어가요.", en: "This only clears if the goal itself changes, so this part is on hold. It resumes by itself once you decide." },
  owner_stop: { ko: "멈춘 목표예요. 다시 시작하시면 이어가요.", en: "The goal is stopped. It continues when you restart it." },
};

/** The model's one-line summary as the owner sees it: one line, no links or markup, no borrowed "AGI:" voice, short. */
export function ownerAskSummary(value: unknown): string | null {
  const clean = text(value, 400);
  if (!clean) return null;
  const plain = clean.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(?:https?|ftp):\/\/\S+|www\.\S+/gi, "").replace(/[`*#>|<>{}\\]/g, "")
    .replace(/^\s*(?:AGI|에이전트|시스템|System)\s*[:：]\s*/i, "").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 160) : null;
}

/** The ask the owner sees: a host template for the boundary, then the model's summary labelled as the model's. Never the model's own sentence alone. */
export function ownerAskLine(boundary: unknown, ask: unknown): { ko: string; en: string } | null {
  if (!isPersistenceBoundaryKind(boundary)) return null;
  const template = OWNER_ASK_TEMPLATE[boundary];
  const summary = ownerAskSummary(ask);
  return { ko: `AGI: ${template.ko}${summary ? ` (AI 요약, 확인되지 않음: ${summary})` : ""}`, en: `AGI: ${template.en}${summary ? ` (AI summary, unverified: ${summary})` : ""}` };
}

function teammateLabel(detail: Record<string, unknown>): string {
  return typeof detail.memberName === "string" && detail.memberName.trim() ? detail.memberName.trim() : String(detail.member ?? "");
}

/** One plain line per real action (plan §3.8); nothing for rest, nothing for a refusal. */
export function noticeLine(action: AgiActionKind, receipt: AgiActionReceipt): { ko: string; en: string } | null {
  const detail = receipt.detail ?? {};
  switch (action) {
    case "create_teammate": return { ko: `AGI: ${String(detail.name ?? "")} 팀원을 만들었어요`, en: `AGI: created teammate ${String(detail.name ?? "")}` };
    // The model may name a teammate by its member id (a UUID). The owner sees
    // the resolved display name; the raw argument stays in the receipt.
    case "invite_teammate": return { ko: `AGI: ${teammateLabel(detail)} 팀원을 초대했어요`, en: `AGI: invited ${teammateLabel(detail)}` };
    case "dispatch_teammate": return { ko: `AGI: ${teammateLabel(detail)}에게 ${String(detail.nodeId ?? "")} 작업을 맡겼어요`, en: `AGI: handed ${String(detail.nodeId ?? "")} to ${teammateLabel(detail)}` };
    case "switch_runtime": {
      const why = SWITCH_RUNTIME_WHY[String(detail.causeKind ?? "")];
      return why
        ? { ko: `AGI: ${why.ko} 다음 실행은 다른 모델로 이어가요`, en: `AGI: ${why.en} The next run continues on another model.` }
        : { ko: "AGI: 지금 모델로는 진행이 막혀 다음 실행은 다른 모델로 이어가요", en: "AGI: progress is stuck on the current model, so the next run continues on another model." };
    }
    case "retry_node_with": return { ko: `AGI: ${String(detail.nodeId ?? "")}를 다른 방법(${String(detail.path ?? "")})으로 다시 해요`, en: `AGI: retrying ${String(detail.nodeId ?? "")} another way (${String(detail.path ?? "")})` };
    case "replan_tree": return { ko: "AGI: 전술 목록을 정리했어요", en: "AGI: tidied the tactic list" };
    case "start_work_turn": return receipt.code === "agi.turn.started"
      ? { ko: "AGI: 막히지 않은 작업부터 이어가요", en: "AGI: continuing with the work that is not blocked" }
      : { ko: "AGI: 이전 작업이 반영됐는지 먼저 확인해요", en: "AGI: checking first whether the earlier work went through" };
    case "run_login_recovery": return receipt.code === "agi.login.recovered"
      ? { ko: "AGI: 로그인을 크롬 세션으로 다시 가져왔어요", en: "AGI: re-imported the sign-in from Chrome" } : null;
    case "restart_agentlas_browser": return receipt.code === "agi.browser.restarted"
      ? { ko: "AGI: Agentlas 브라우저를 다시 켰어요", en: "AGI: restarted the Agentlas Browser" } : null;
    case "request_app_restart": return { ko: "AGI: 앱을 다시 시작하면 풀릴 것 같아요 — 괜찮을 때 재시작해 주세요", en: "AGI: restarting the app should clear this — please restart when convenient" };
    case "ask_owner_once": return ownerAskLine(detail.boundary, detail.ask);
    default: return null;
  }
}

function restRequestDigest(request: AgiActionRequest): string {
  return createHash("sha256").update(JSON.stringify({ captureId: request.episodeCaptureId ?? null,
    goalId: request.fence?.goalId ?? null, untilIso: request.args?.untilIso ?? null,
    reason: request.args?.reason ?? null, refusal: request.episodeRefusal ?? null })).digest("hex");
}
