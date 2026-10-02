/**
 * AGI goal manager, P3 — the typed action executor (plan §3.5, §3.9).
 *
 * The unblocker never gets a shell or a free-form write. It emits `agentlas.agi-unblock.v1` action requests; Main
 * validates each one and executes it through the product's existing paths, writing a durable receipt first:
 *
 *   settle_uncertain_effect  existing attempt settlement, only with evidence from a later in-scope run
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
 *   ask_owner_once           one precise ask, only for a persistence boundary, only after an alternative path (G1)
 *   rest                     nothing left; the incident stays open until the state digest changes
 *
 * Guards, all structural (the executor refuses; no prompt is trusted to):
 *  - fence: (goalId, runId, runVersion) must equal the ledger now, else refused stale;
 *  - replay: the same actionId returns the same receipt (claimed before the side effect);
 *  - owner boundaries: a goal paused by the owner, for approval or for budget gets no action but file_defect;
 *  - G1: ask_owner_once needs ≥1 settled non-ask alternative action on the same incident;
 *  - circuit breaker (R16): the same action on the same incident at most MAX_SAME_MOVE_PER_CAUSE times, and never an
 *    action a reflection ruled out (R2);
 *  - budget (D1): ≤4 executed actions per attempt; the unblocker's model calls are admitted in model-attempt.ts.
 */
import type Database from "better-sqlite3";
import { MAX_SAME_MOVE_PER_CAUSE, PERSISTENCE_BOUNDARY_KINDS, isPersistenceBoundaryKind, type PersistenceBoundaryKind } from "../../shared/persistence-policy";
import { AGI_ACTION_KINDS, AGI_NON_ALTERNATIVE_ACTIONS, type AgiActionKind } from "./blocker";
import { AgiIncidentStore } from "./incident-store";

export const AGI_ACTION_SCHEMA = "agentlas.agi-unblock.v1" as const;
export const AGI_MAX_ACTIONS_PER_ATTEMPT = 4;

export interface AgiActionRequest {
  schema: typeof AGI_ACTION_SCHEMA;
  actionId: string;
  incidentId: string;
  /** Which attempt on the incident this action belongs to (per-attempt action cap). */
  attempt: number;
  fence: { goalId: string; runId: string; runVersion: number };
  action: AgiActionKind;
  args?: Record<string, unknown>;
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

export interface AgiExecutorDeps {
  db: Database.Database;
  now(): number;
  goal(goalId: string): AgiGoalView | null;
  /** continueGoalForAlive (blocked-goal-sweep.ts) — the existing continuation path. */
  continueGoal(runId: string, expectedVersion: number): { action: string; detail: string };
  /** settleUncertainAttemptsByObservation with verdict "done" and the later run as the observation. */
  settleUncertain(runId: string, input: { attemptIds: string[]; evidence: string; evidenceRunId: string }): void;
  /** A later, in-scope run whose host receipt (tool ledger / final) covers the uncertain attempts. */
  resolveEvidence(goalId: string, ref: string): { runId: string; summary: string } | null;
  team?: {
    create(chatId: string, permission: AgiGoalView["permission"], input: { name: string; role?: string; personality?: string }): { memberId: string; created: boolean };
    invite(chatId: string, permission: AgiGoalView["permission"], member: string): { memberId: string; joined: boolean; memberName?: string };
    dispatch(chatId: string, permission: AgiGoalView["permission"], input: { member: string; brief: string }): { sessionId: string; memberName?: string };
  };
  plan?: {
    read(goalId: string): AgiPlanView | null;
    apply(goalId: string, plan: AgiPlanView, ops: AgiPlanOp[]): void;
  };
  /** Record a persistence move (switch_runtime / switch_tool) for the goal's next turn. */
  recordMove?(goalId: string, runId: string, move: "switch_runtime" | "switch_tool", detail: Record<string, unknown>): { ok: true } | { ok: false; code: string } | void;
  /** Installed alternatives for a capability path (retry_node_with guard). */
  installedPaths?(capability: string): string[];
  /** The login-recovery ladder seam (plugged by electron/browser/*; absent → unavailable). */
  runLoginRecovery?(input: { domain: string; goalId: string; runId: string; chatId: string | null }): AgiLoginRecoveryOutcome | Promise<AgiLoginRecoveryOutcome>;
  /** Agentlas Browser restart seam (D6: allowed without asking). */
  restartAgentlasBrowser?(): boolean | Promise<boolean>;
  /** One owner-visible line in the goal chat (host-notice marker). Idempotent per actionId. */
  announce?(input: { chatId: string; actionId: string; kind: "action" | "ask" | "defect"; text: { ko: string; en: string } }): void;
  /** A defect was filed: surface the chip (D5). */
  onDefectFiled?(input: { defectId: string; goalId: string; chatId: string | null; code: string }): void;
}

export function ensureAgiActionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_action_receipts (
    action_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, goal_id TEXT NOT NULL, attempt INTEGER NOT NULL, action TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('claimed','settled')), ok INTEGER, code TEXT,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agi_action_receipts_incident ON agi_action_receipts(incident_id, attempt)");
  db.exec(`CREATE TABLE IF NOT EXISTS agi_defect_reports (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, chat_id TEXT, incident_id TEXT, code TEXT NOT NULL, category TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), workaround TEXT, created_at_ms INTEGER NOT NULL,
    UNIQUE(goal_id, code))`);
}

const ACTION_ID = /^[A-Za-z0-9._:-]{8,160}$/;
function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}
const OWNER_BOUNDARY_PAUSES = new Set(["user"]);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

export class AgiActionExecutor {
  readonly incidents: AgiIncidentStore;
  constructor(private readonly deps: AgiExecutorDeps) {
    ensureAgiActionSchema(deps.db);
    this.incidents = new AgiIncidentStore(deps.db);
  }

  /** A model attempt settled after the monitor recorded "dispatched": write its end onto the state's attempt row. */
  recordAttemptResult(goalId: string, stateDigest: string, result: { outcome: string; code?: string }): void {
    try {
      this.deps.db.prepare("UPDATE agi_unblock_attempts SET outcome = ?, code = ?, result_json = ?, at_ms = ? WHERE goal_id = ? AND state_digest = ?")
        .run(result.outcome, result.code ?? null, JSON.stringify(result), this.deps.now(), goalId, stateDigest);
    } catch { /* table absent in a bare executor (contracts) */ }
  }

  /** The goal ledger's version now (the model attempt refreshes its fence after its own accepted effects). */
  currentVersion(goalId: string): number | null { return this.deps.goal(goalId)?.version ?? null; }

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

  execute(request: AgiActionRequest): AgiActionReceipt {
    const replay = request && typeof request.actionId === "string" ? this.receipt(request.actionId) : null;
    if (replay) return { ...replay, replayed: true };
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
    const counted = history.filter((entry) => entry.attempt === request.attempt && entry.action !== "file_defect");
    if (!["file_defect", "start_work_turn"].includes(request.action) && counted.length >= AGI_MAX_ACTIONS_PER_ATTEMPT) return refuse("agi.budget.actions-per-attempt");
    if (history.filter((entry) => entry.action === request.action).length >= MAX_SAME_MOVE_PER_CAUSE && !["file_defect", "start_work_turn"].includes(request.action)) {
      return refuse("agi.action.circuit-open");
    }
    if (request.action !== "start_work_turn" && this.incidents.ruledOut(incident.id).has(request.action)) return refuse("agi.action.ruled-out");
    // 5. Tokens (D1): the AGI caps govern the unblocker's own model calls (model-attempt.ts admits each one). A work turn
    // or a teammate session this action starts is goal work, governed by the goal's own budget and permission — the
    // same turn the sweep would start — so it is not refused by the AGI cap (that would stall the goal on AGI's bill).
    // 6. G1 + boundary rules for the ask
    if (request.action === "ask_owner_once") {
      const boundary = request.args?.boundary;
      if (!isPersistenceBoundaryKind(boundary)) return refuse("agi.ask.boundary-required", { allowed: [...PERSISTENCE_BOUNDARY_KINDS] });
      if (boundary === "owner_stop") return refuse("agi.ask.owner-stop-is-not-asked");
      const alternatives = history.filter((entry) => entry.ok && !AGI_NON_ALTERNATIVE_ACTIONS.has(entry.action as AgiActionKind));
      if (!alternatives.length) return refuse("agi.ask.alternative-path-required");
      // Once per boundary per goal (not per incident): a moved digest is not a new question (R17, no repeats while
      // nothing changes). The same boundary may be asked again only a day later.
      const asked = this.deps.db.prepare(`SELECT 1 FROM agi_action_receipts WHERE goal_id = ? AND action = 'ask_owner_once' AND ok = 1
        AND json_extract(result_json, '$.detail.boundary') = ? AND settled_at_ms > ?`).get(goal.goalId, boundary, this.deps.now() - 24 * 60 * 60_000);
      if (asked) return refuse("agi.ask.already-asked");
    }
    // 7. durable claim, then the effect
    this.deps.db.prepare(`INSERT INTO agi_action_receipts(action_id,incident_id,goal_id,attempt,action,status,created_at_ms)
      VALUES (?,?,?,?,?,'claimed',?) ON CONFLICT(action_id) DO NOTHING`)
      .run(request.actionId, incident.id, goal.goalId, request.attempt, request.action, this.deps.now());
    let result: AgiActionReceipt;
    try {
      result = this.run(request, goal, incident.id);
    } catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9._:-]{2,120}$/.test(error.message) ? error.message : "agi.action.failed";
      result = { actionId: request.actionId, action: request.action, ok: false, code };
    }
    const settled = this.settle(request, result);
    this.incidents.reflect(incident.id, { atMs: this.deps.now(), action: request.action, result: settled.ok ? "ok" : `refused:${settled.code}`,
      evidenceRefs: Array.isArray(settled.detail?.evidenceRefs) ? settled.detail!.evidenceRefs as string[] : [],
      // A failed effect is ruled out for this incident (R2); a refused precondition is not an attempt.
      ruledOut: !settled.ok && /\.failed$|-failed$|unavailable$/.test(settled.code) });
    if (settled.ok && goal.chatId && this.deps.announce && request.action !== "rest" && request.action !== "file_defect") {
      const line = noticeLine(request.action, settled);
      if (line) {
        try { this.deps.announce({ chatId: goal.chatId, actionId: request.actionId, kind: request.action === "ask_owner_once" || request.action === "request_app_restart" ? "ask" : "action", text: line }); }
        catch { /* a notice cannot undo the action */ }
      }
    }
    return settled;
  }

  /** The end of an async action (login ladder, browser restart): a reflection on the incident, never a second receipt. */
  private later(request: AgiActionRequest, goal: AgiGoalView, incidentId: string, code: string, failed: boolean): void {
    try {
      this.incidents.reflect(incidentId, { atMs: this.deps.now(), action: request.action, result: failed ? `failed:${code}` : code,
        evidenceRefs: [`agi-action:${request.actionId}`], ruledOut: failed });
      this.deps.db.prepare("UPDATE agi_action_receipts SET result_json = json_set(result_json, '$.detail.completion', ?) WHERE action_id = ?")
        .run(code, request.actionId);
      if (!failed && goal.chatId && this.deps.announce && (code === "agi.login.recovered" || code === "agi.browser.restarted")) {
        const line = noticeLine(request.action, { actionId: request.actionId, action: request.action, ok: true, code, detail: {} });
        if (line) this.deps.announce({ chatId: goal.chatId, actionId: `${request.actionId}:done`, kind: "action", text: line });
      }
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

  private run(request: AgiActionRequest, goal: AgiGoalView, incidentId: string): AgiActionReceipt {
    const ok = (code: string, detail?: Record<string, unknown>): AgiActionReceipt => ({ actionId: request.actionId, action: request.action, ok: true, code, ...(detail ? { detail } : {}) });
    const no = (code: string, detail?: Record<string, unknown>): AgiActionReceipt => ({ actionId: request.actionId, action: request.action, ok: false, code, ...(detail ? { detail } : {}) });
    const args = request.args ?? {};
    const writeCapable = goal.permission === "write" || goal.permission === "full";
    switch (request.action) {
      case "settle_uncertain_effect": {
        const ref = text(args.evidenceRef, 200);
        const attemptIds = Array.isArray(args.attemptIds) ? args.attemptIds.filter((id): id is string => typeof id === "string").slice(0, 50) : [];
        if (!ref || !attemptIds.length) return no("agi.settle.evidence-required");
        const evidence = this.deps.resolveEvidence(goal.goalId, ref);
        if (!evidence) return no("agi.settle.evidence-unresolved");
        this.deps.settleUncertain(goal.runId, { attemptIds, evidence: `${ref}: ${evidence.summary}`.slice(0, 500), evidenceRunId: evidence.runId });
        return ok("agi.settle.settled", { attemptIds, evidenceRefs: [ref] });
      }
      case "create_teammate": {
        if (!this.deps.team || !goal.chatId) return no("agi.team.unavailable");
        if (!writeCapable) return no("agi.team.permission-read");
        const name = text(args.name, 80);
        if (!name) return no("agi.team.name-required");
        const made = this.deps.team.create(goal.chatId, goal.permission, { name, ...(text(args.role, 100) ? { role: text(args.role, 100)! } : {}),
          ...(text(args.personality, 1_200) ? { personality: text(args.personality, 1_200)! } : {}) });
        return ok(made.created ? "agi.team.created" : "agi.team.already-exists", { memberId: made.memberId, name });
      }
      case "invite_teammate": {
        if (!this.deps.team || !goal.chatId) return no("agi.team.unavailable");
        if (!writeCapable) return no("agi.team.permission-read");
        const member = text(args.member, 120);
        if (!member) return no("agi.team.member-required");
        const joined = this.deps.team.invite(goal.chatId, goal.permission, member);
        return ok(joined.joined ? "agi.team.invited" : "agi.team.already-member", { memberId: joined.memberId, member,
          ...(joined.memberName ? { memberName: joined.memberName } : {}) });
      }
      case "dispatch_teammate": {
        if (!this.deps.team || !goal.chatId) return no("agi.team.unavailable");
        if (!writeCapable) return no("agi.team.permission-read");
        const member = text(args.member, 120);
        const brief = text(args.brief, 4_000);
        const nodeId = text(args.nodeId, 80);
        if (!member || !brief || !nodeId) return no("agi.team.dispatch-args-required");
        const plan = this.deps.plan?.read(goal.goalId) ?? null;
        if (!plan?.tactics.some((tactic) => tactic.id === nodeId && tactic.status === "active")) return no("agi.team.node-not-active");
        const session = this.deps.team.dispatch(goal.chatId, goal.permission, { member, brief: `[${nodeId}] ${brief}` });
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
        const outcome = this.deps.runLoginRecovery({ domain, goalId: goal.goalId, runId: goal.runId, chatId: goal.chatId });
        if (isPromise(outcome)) {
          // The ladder is async (re-import, store feed, event-driven restore). The receipt says dispatched; its end
          // is written back to the incident as a reflection, and a failed ladder is ruled out for this incident.
          void outcome.then((end) => this.later(request, goal, incidentId, `agi.login.${end}`, end === "unavailable"), () =>
            this.later(request, goal, incidentId, "agi.login.ladder-failed", true));
          return ok("agi.login.dispatched", { domain });
        }
        if (outcome === "unavailable") return no("agi.login.ladder-unavailable");
        // awaiting-owner = the ladder's last rung (Chrome itself signed out) posted its own single card; it auto-resumes.
        return ok(`agi.login.${outcome}`, { domain });
      }
      case "restart_agentlas_browser": {
        if (!this.deps.restartAgentlasBrowser) return no("agi.browser.restart-unavailable");
        const restarted = this.deps.restartAgentlasBrowser();
        if (isPromise(restarted)) {
          void restarted.then((done) => this.later(request, goal, incidentId, done ? "agi.browser.restarted" : "agi.browser.restart-failed", !done),
            () => this.later(request, goal, incidentId, "agi.browser.restart-failed", true));
          return ok("agi.browser.restart-dispatched");
        }
        return restarted ? ok("agi.browser.restarted") : no("agi.browser.restart-failed");
      }
      case "request_app_restart": {
        const asked = this.deps.db.prepare("SELECT 1 FROM agi_action_receipts WHERE incident_id = ? AND action = 'request_app_restart' AND ok = 1").get(incidentId);
        if (asked) return no("agi.ask.already-asked");
        return ok("agi.app-restart.asked", { reason: text(args.reason, 200) });
      }
      case "file_defect": {
        const code = text(args.code, 160);
        if (!code || !/^[a-z0-9_:.-]+$/i.test(code)) return no("agi.defect.code-required");
        const evidenceRefs = Array.isArray(args.evidenceRefs) ? args.evidenceRefs.filter((ref): ref is string => typeof ref === "string").slice(0, 12) : [];
        if (!evidenceRefs.length) return no("agi.defect.evidence-required");
        const category = ["crash", "stall", "wrong-result", "ui", "login", "other"].includes(String(args.category)) ? String(args.category) : "other";
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
        return ok("agi.ask.posted", { boundary: args.boundary, ask, resumesWith });
      }
      case "rest": {
        const until = typeof args.untilIso === "string" && Number.isFinite(Date.parse(args.untilIso)) ? args.untilIso : null;
        return ok("agi.rest", { untilIso: until, reason: text(args.reason, 120) });
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

function teammateLabel(detail: Record<string, unknown>): string {
  return typeof detail.memberName === "string" && detail.memberName.trim() ? detail.memberName.trim() : String(detail.member ?? "");
}

/** One plain line per real action (plan §3.8); nothing for rest, nothing for a refusal. */
export function noticeLine(action: AgiActionKind, receipt: AgiActionReceipt): { ko: string; en: string } | null {
  const detail = receipt.detail ?? {};
  switch (action) {
    case "settle_uncertain_effect": return { ko: "AGI: 이전 작업은 이미 반영돼 있었어요 — 실행 기록으로 정리했어요", en: "AGI: the earlier action had already gone through — settled it from the run record" };
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
    case "ask_owner_once": return { ko: `AGI: ${String(detail.ask ?? "")} — 확인되면 ${String(detail.resumesWith ?? "")}부터 자동으로 이어가요`, en: `AGI: ${String(detail.ask ?? "")} — once done it resumes with ${String(detail.resumesWith ?? "")}` };
    default: return null;
  }
}
