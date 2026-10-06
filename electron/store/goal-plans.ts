/**
 * 골 구조 판단의 원장 — 목표마다 모양(단일 전술 / 전술 목록 / 대계-전략-전술 트리)과 살아 있는 노드 상태.
 * docs/2026-09-24-PLAN-persistent-autonomy-foundation.md "골 구조 판단" S-3.
 *
 * 추가형 곁 테이블이다. 스키마 사다리(db.ts) 번호를 올리지 않고 처음 쓸 때 만든다(memory_entry_native 와 같은 방식).
 *  - goal_plan_nodes: (goal_id, revision, plan_seq, node_id) — revision=목표 개정 번호, plan_seq=그 개정 안의 모양 판단 차수.
 *  - goal_plan_decisions: 영수증(append-only) — shape · shape_fallback · reshape_requested · tactic_dispatch · tactic_status ·
 *    strategy_review · plan_op · owner_edit.
 */
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "./db";
import {
  INITIAL_ACTIVE_STRATEGIES,
  type GoalShapePlan,
  type GoalTactic,
  liveGoalPlanFromRows,
  readTacticRequirements,
  validateTacticDependencies,
  type LiveGoalPlan,
  type LiveTactic,
  type PlanNodeStatus,
} from "../../shared/goal-shape";

type Db = ReturnType<typeof getDb>;
let ensuredFor: Db | null = null;

export function ensureGoalPlanTables(db: Db = getDb()): void {
  if (ensuredFor === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_plan_nodes (
      goal_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      plan_seq INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('mission','strategy','tactic')),
      parent_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('proposed','active','done','retired')),
      ord INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (goal_id, revision, plan_seq, node_id)
    );
    CREATE TABLE IF NOT EXISTS goal_plan_decisions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      plan_seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goal_plan_decisions_goal ON goal_plan_decisions(goal_id, revision, plan_seq, kind, created_at);
    CREATE TABLE IF NOT EXISTS goal_plan_mutations (
      goal_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_seq INTEGER NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(goal_id,revision,plan_seq)
    );
    CREATE TRIGGER IF NOT EXISTS goal_plan_node_insert_epoch AFTER INSERT ON goal_plan_nodes BEGIN
      INSERT INTO goal_plan_mutations(goal_id,revision,plan_seq,epoch) VALUES(NEW.goal_id,NEW.revision,NEW.plan_seq,1)
      ON CONFLICT(goal_id,revision,plan_seq) DO UPDATE SET epoch=epoch+1;
    END;
    CREATE TRIGGER IF NOT EXISTS goal_plan_node_update_epoch AFTER UPDATE ON goal_plan_nodes
      WHEN OLD.payload_json IS NOT NEW.payload_json OR OLD.status IS NOT NEW.status OR OLD.ord IS NOT NEW.ord
        OR OLD.parent_id IS NOT NEW.parent_id OR OLD.kind IS NOT NEW.kind OR OLD.node_id IS NOT NEW.node_id
      BEGIN
      INSERT INTO goal_plan_mutations(goal_id,revision,plan_seq,epoch) VALUES(NEW.goal_id,NEW.revision,NEW.plan_seq,1)
      ON CONFLICT(goal_id,revision,plan_seq) DO UPDATE SET epoch=epoch+1;
    END;
    CREATE TRIGGER IF NOT EXISTS goal_plan_node_delete_epoch AFTER DELETE ON goal_plan_nodes BEGIN
      INSERT INTO goal_plan_mutations(goal_id,revision,plan_seq,epoch) VALUES(OLD.goal_id,OLD.revision,OLD.plan_seq,1)
      ON CONFLICT(goal_id,revision,plan_seq) DO UPDATE SET epoch=epoch+1;
    END;
  `);
  // SQLite rolls DDL back with its enclosing transaction. A refused wait may
  // first read a Goal plan inside that transaction, then throw; caching here
  // would claim the rolled-back tables exist for the rest of the app lifetime.
  // Cache only schema observed outside a transaction, where it is committed.
  if (!db.inTransaction) ensuredFor = db;
}

export type GoalPlanDecisionKind =
  | "shape" | "shape_fallback" | "reshape_requested" | "tactic_dispatch" | "tactic_status" | "strategy_review" | "plan_op"
  /** An edit the owner made in the goal panel (electron/long-run/goal-panel.ts). Receipt only; the node rows carry the state. */
  | "owner_edit" | "marker_apply" | "marker_context";

export interface GoalPlanDecisionRow {
  id: string;
  goalId: string;
  revision: number;
  planSeq: number;
  kind: GoalPlanDecisionKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function recordGoalPlanDecision(input: {
  goalId: string; revision: number; planSeq: number; kind: GoalPlanDecisionKind; payload: Record<string, unknown>; createdAt?: string;
}): GoalPlanDecisionRow {
  ensureGoalPlanTables();
  const row = { id: randomUUID(), createdAt: input.createdAt ?? new Date().toISOString() };
  getDb().prepare("INSERT INTO goal_plan_decisions (id, goal_id, revision, plan_seq, kind, payload_json, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(row.id, input.goalId, input.revision, input.planSeq, input.kind, JSON.stringify(input.payload), row.createdAt);
  return { id: row.id, goalId: input.goalId, revision: input.revision, planSeq: input.planSeq, kind: input.kind,
    payload: input.payload, createdAt: row.createdAt };
}

export function listGoalPlanDecisions(goalId: string, filter: { revision?: number; planSeq?: number; kind?: GoalPlanDecisionKind; limit?: number } = {}): GoalPlanDecisionRow[] {
  ensureGoalPlanTables();
  const clauses = ["goal_id = ?"];
  const args: Array<string | number> = [goalId];
  if (filter.revision !== undefined) { clauses.push("revision = ?"); args.push(filter.revision); }
  if (filter.planSeq !== undefined) { clauses.push("plan_seq = ?"); args.push(filter.planSeq); }
  if (filter.kind) { clauses.push("kind = ?"); args.push(filter.kind); }
  const rows = getDb().prepare(`SELECT * FROM goal_plan_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args, Math.max(1, Math.min(500, filter.limit ?? 100))) as Array<{
      id: string; goal_id: string; revision: number; plan_seq: number; kind: GoalPlanDecisionKind; payload_json: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, goalId: row.goal_id, revision: row.revision, planSeq: row.plan_seq, kind: row.kind,
    payload: safeJson(row.payload_json), createdAt: row.created_at }));
}

function safeJson(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

/** 이 개정의 가장 최근 모양 판단 차수. 없으면 0. */
export function latestGoalPlanSeq(goalId: string, revision: number): number {
  ensureGoalPlanTables();
  const row = getDb().prepare("SELECT MAX(plan_seq) AS seq FROM goal_plan_decisions WHERE goal_id = ? AND revision = ? AND kind IN ('shape','shape_fallback')")
    .get(goalId, revision) as { seq: number | null } | undefined;
  return row?.seq ?? 0;
}

function tacticPayload(tactic: GoalTactic, extra: Partial<Pick<LiveTactic, "runs" | "failures" | "evidence" | "guidance" | "deferredUntil">> = {}) {
  return { ...(tactic.depends_on !== undefined ? { depends_on: tactic.depends_on } : {}),
    ...(tactic.prerequisites !== undefined ? { prerequisites: tactic.prerequisites } : {}), description: tactic.description, done_when: tactic.done_when, kind: tactic.kind, runs: extra.runs ?? 0,
    failures: extra.failures ?? 0, evidence: extra.evidence ?? null, guidance: extra.guidance ?? null, deferredUntil: extra.deferredUntil ?? null };
}

/**
 * 검증된 모양을 새 차수로 저장한다. 노드와 모양 영수증이 한 트랜잭션이다.
 * fallback=true 는 판단 실패 뒤의 결정적 폴백 — 다음 턴에 다시 판단한다.
 */
export function saveGoalPlan(input: {
  goalId: string; revision: number; plan: GoalShapePlan; fallback: boolean; receipt: Record<string, unknown>; createdAt?: string;
}): LiveGoalPlan {
  ensureGoalPlanTables();
  const db = getDb();
  const at = input.createdAt ?? new Date().toISOString();
  return db.transaction(() => {
    const planSeq = latestGoalPlanSeq(input.goalId, input.revision) + 1;
    const insert = db.prepare(`INSERT INTO goal_plan_nodes (goal_id, revision, plan_seq, node_id, kind, parent_id, status, ord, payload_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const { plan } = input;
    const error = validateTacticDependencies(plan.tactics);
    if (error) throw new Error(error);
    for (const tactic of plan.tactics) {
      const notes: string[] = []; readTacticRequirements(tactic as unknown as Record<string, unknown>, notes, tactic.id);
      if (notes.length) throw new Error("prerequisites_invalid");
    }
    if (plan.mission) insert.run(input.goalId, input.revision, planSeq, "mission", "mission", null, "active", 0, JSON.stringify(plan.mission), at, at);
    plan.strategies.forEach((strategy, index) => {
      insert.run(input.goalId, input.revision, planSeq, strategy.id, "strategy", plan.mission ? "mission" : null,
        index < INITIAL_ACTIVE_STRATEGIES ? "active" : "proposed", strategy.priority, JSON.stringify({ ...strategy, activatedAt: at }), at, at);
    });
    plan.tactics.forEach((tactic, index) => {
      insert.run(input.goalId, input.revision, planSeq, tactic.id, "tactic", tactic.strategy_id, "active", index,
        JSON.stringify(tacticPayload(tactic)), at, at);
    });
    recordGoalPlanDecision({ goalId: input.goalId, revision: input.revision, planSeq, kind: input.fallback ? "shape_fallback" : "shape",
      createdAt: at, payload: { ...input.receipt, plan } });
    const live = readGoalPlan(input.goalId, input.revision);
    if (!live) throw new Error("goal_plan_write_lost");
    return live;
  })();
}

/** 가장 최근 개정(또는 지정 개정)의 가장 최근 차수 계획. */
export function readGoalPlan(goalId: string, revision?: number, db: Db = getDb()): LiveGoalPlan | null {
  ensureGoalPlanTables(db);
  const rev = revision ?? (db.prepare("SELECT MAX(revision) AS r FROM goal_plan_decisions WHERE goal_id = ? AND kind IN ('shape','shape_fallback')")
    .get(goalId) as { r: number | null } | undefined)?.r;
  if (rev === null || rev === undefined) return null;
  const decision = db.prepare(`SELECT kind, plan_seq, payload_json, created_at FROM goal_plan_decisions
    WHERE goal_id = ? AND revision = ? AND kind IN ('shape','shape_fallback') ORDER BY plan_seq DESC LIMIT 1`)
    .get(goalId, rev) as { kind: string; plan_seq: number; payload_json: string; created_at: string } | undefined;
  if (!decision) return null;
  const nodes = db.prepare("SELECT * FROM goal_plan_nodes WHERE goal_id = ? AND revision = ? AND plan_seq = ? ORDER BY ord, created_at")
    .all(goalId, rev, decision.plan_seq) as Array<{ node_id: string; kind: string; parent_id: string | null; status: PlanNodeStatus; ord: number; payload_json: string }>;
  const plan = liveGoalPlanFromRows(goalId, rev, decision, nodes);
  // Content hash catches direct row edits; the epoch also fences pause/resume ABA even when bytes return to the original state.
  const epoch = (db.prepare("SELECT epoch FROM goal_plan_mutations WHERE goal_id=? AND revision=? AND plan_seq=?")
    .get(goalId, rev, decision.plan_seq) as { epoch: number } | undefined)?.epoch ?? 0;
  if (plan) plan.mutationIdentity = `sha256:${createHash("sha256").update(JSON.stringify({ goalId, revision: rev, epoch, decision,
    nodes: [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id)).map(node => ({ node_id: node.node_id,
      kind: node.kind, parent_id: node.parent_id, status: node.status, ord: node.ord, payload_json: node.payload_json })) })).digest("hex")}`;
  if (plan) {
    const cursor = db.prepare("SELECT id FROM goal_plan_decisions WHERE goal_id=? AND revision=? AND plan_seq=? ORDER BY rowid DESC LIMIT 1")
      .get(goalId, rev, decision.plan_seq) as { id: string } | undefined;
    plan.observationCursor = cursor?.id ?? "";
  }
  return plan;
}

/** 노드 하나의 상태·payload 조각을 바꾼다(같은 차수 안에서만). */
export function updateGoalPlanNode(plan: Pick<LiveGoalPlan, "goalId" | "revision" | "planSeq">, nodeId: string,
  patch: { status?: PlanNodeStatus; payload?: Record<string, unknown>; ord?: number }): void {
  ensureGoalPlanTables();
  const db = getDb();
  const row = db.prepare("SELECT payload_json FROM goal_plan_nodes WHERE goal_id = ? AND revision = ? AND plan_seq = ? AND node_id = ?")
    .get(plan.goalId, plan.revision, plan.planSeq, nodeId) as { payload_json: string } | undefined;
  if (!row) throw new Error("goal_plan_node_missing");
  if (patch.payload && ("depends_on" in patch.payload || "prerequisites" in patch.payload)) {
    const live = readGoalPlan(plan.goalId, plan.revision)!;
    const target = live.tactics.find(t => t.id === nodeId);
    const notes: string[] = []; const requirements = readTacticRequirements({ ...safeJson(row.payload_json), ...patch.payload }, notes, nodeId);
    if (!target || notes.length) throw new Error("prerequisites_invalid");
    const error = validateTacticDependencies(live.tactics.map(t => t.id === nodeId ? { ...t, ...requirements } : t));
    if (error) throw new Error(error);
  }
  const payload = patch.payload ? { ...safeJson(row.payload_json), ...patch.payload } : safeJson(row.payload_json);
  db.prepare(`UPDATE goal_plan_nodes SET status = COALESCE(?, status), ord = COALESCE(?, ord), payload_json = ?, updated_at = ?
    WHERE goal_id = ? AND revision = ? AND plan_seq = ? AND node_id = ?`)
    .run(patch.status ?? null, patch.ord ?? null, JSON.stringify(payload), new Date().toISOString(), plan.goalId, plan.revision, plan.planSeq, nodeId);
}

/** 같은 차수에 노드를 더한다(계획 연산이 만든 전략·전술). */
export function insertGoalPlanNode(plan: Pick<LiveGoalPlan, "goalId" | "revision" | "planSeq">, node: {
  nodeId: string; kind: "strategy" | "tactic"; parentId: string | null; status: PlanNodeStatus; ord: number; payload: Record<string, unknown>;
}): void {
  ensureGoalPlanTables();
  const at = new Date().toISOString();
  if (node.kind === "tactic") {
    const notes: string[] = []; const requirements = readTacticRequirements(node.payload, notes, node.nodeId);
    if (notes.length) throw new Error("prerequisites_invalid");
    const live = readGoalPlan(plan.goalId, plan.revision)!;
    const error = validateTacticDependencies([...live.tactics, { id: node.nodeId, strategy_id: node.parentId,
      description: String(node.payload.description ?? ""), done_when: String(node.payload.done_when ?? ""), kind: "one_off", ...requirements }]);
    if (error) throw new Error(error);
  }
  getDb().prepare(`INSERT INTO goal_plan_nodes (goal_id, revision, plan_seq, node_id, kind, parent_id, status, ord, payload_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(plan.goalId, plan.revision, plan.planSeq, node.nodeId, node.kind, node.parentId, node.status, node.ord, JSON.stringify(node.payload), at, at);
}

export { tacticPayload as goalPlanTacticPayload };

/** Main-only exact compare-and-apply. The callback is synchronous local work, never provider/network work. */
export function withCurrentGoalPlan<T>(goalId: string, expectedIdentity: string, apply: (plan: LiveGoalPlan) => T): T {
  const db = getDb();
  return db.transaction(() => {
    const current = readGoalPlan(goalId);
    if (!current || current.mutationIdentity !== expectedIdentity) throw new Error("goal_plan_stale");
    const revisionTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_goal_revisions'").get();
    if (revisionTable) {
      const latest = db.prepare("SELECT MAX(revision) revision FROM chat_goal_revisions WHERE goal_id=?").get(goalId) as { revision: number | null };
      if (latest.revision !== null && latest.revision !== current.revision) throw new Error("goal_revision_stale");
    }
    return apply(current);
  })();
}

/** All receipts for one producing invocation, in append order, independent of wall-clock order. */
export function goalPlanInvocationReceipts(goalId: string, runId: string): Array<{ id: string; kind: string; payload: Record<string, unknown> }> {
  ensureGoalPlanTables();
  return (getDb().prepare(`SELECT id,kind,payload_json FROM goal_plan_decisions WHERE goal_id=?
    AND kind IN ('marker_context','marker_apply') AND json_extract(payload_json,'$.runId')=? ORDER BY rowid`)
    .all(goalId, runId) as Array<{ id: string; kind: string; payload_json: string }>).map(row => ({ id: row.id, kind: row.kind, payload: safeJson(row.payload_json) }));
}

/** Typed owner-control custody across pause/resume, separate from plan node mutation and observation bookkeeping. */
export function goalPlanOwnerControlEpoch(goalId: string): string {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('long_runs','long_run_events')").get() as { n: number };
  if (count.n !== 2) return "[]";
  return JSON.stringify(db.prepare(`SELECT e.run_id,MAX(e.seq) seq FROM long_run_events e
    JOIN long_runs r ON r.id=e.run_id WHERE r.goal_id=? AND e.kind='run.user_control' AND e.actor_kind='user'
    GROUP BY e.run_id ORDER BY e.run_id`).all(goalId));
}
