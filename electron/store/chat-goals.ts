import { getDb } from "./db";
import type { ChatGoalContext } from "../../shared/types";
import {
  createAutomaticGoalRevision,
  reviseAutomaticGoal,
  type GoalRevision,
  type GoalSourceMessage,
} from "../../shared/auto-goal";

type GoalStatus = ChatGoalContext["status"];

interface GoalContractRow {
  goal_id: string;
  chat_id: string;
  objective: string | null;
  acceptance_criteria_json: string;
  status: string;
}

function normalizeCriteria(value: readonly string[]): string[] {
  return value
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 32);
}

function parseStatus(value: string): GoalStatus {
  return ["active", "blocked", "completed", "cancelled"].includes(value)
    ? value as GoalStatus
    : "active";
}

function toContext(row: GoalContractRow | undefined): ChatGoalContext | null {
  if (!row?.objective?.trim()) return null;
  let acceptanceCriteria: string[] = [];
  try {
    const parsed = JSON.parse(row.acceptance_criteria_json || "[]") as unknown;
    if (Array.isArray(parsed)) {
      acceptanceCriteria = normalizeCriteria(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    acceptanceCriteria = [];
  }
  return {
    goalId: row.goal_id,
    objective: row.objective.trim(),
    acceptanceCriteria,
    status: parseStatus(row.status),
  };
}

function toArmedContext(row: GoalContractRow | undefined): ChatGoalContext | null {
  if (!row || parseStatus(row.status) !== "active") return null;
  const defined = toContext(row);
  return defined ?? {
    goalId: row.goal_id,
    objective: "",
    acceptanceCriteria: [],
    status: "active",
  };
}

function readRow(goalId: string): GoalContractRow | undefined {
  return getDb()
    .prepare(
      `SELECT goal_id, chat_id, objective, acceptance_criteria_json, status
       FROM chat_goal_contracts
       WHERE goal_id = ?
       LIMIT 1`,
    )
    .get(goalId) as GoalContractRow | undefined;
}

/**
 * Prepare an explicitly enabled Goal without inventing an objective from a
 * chat title or a later steering message. One goal id is bound to one root
 * chat, and ON is idempotent while that campaign remains active.
 */
export function armChatGoalContract(input: { goalId: string; chatId: string }): void {
  const goalId = input.goalId.trim();
  const chatId = input.chatId.trim();
  if (!goalId || !chatId) throw new TypeError("goal_contract_identity_required");
  const now = new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    // An explicit new ON owns this chat. If a crash cleared the chat binding
    // before terminalising an older local contract, retire that orphan first;
    // otherwise the one-active-goal index would turn recovery into a dead end.
    db.prepare(
      `UPDATE chat_goal_contracts
       SET status = 'cancelled', updated_at = ?, completed_at = ?
       WHERE chat_id = ? AND goal_id <> ? AND status = 'active'`,
    ).run(now, now, chatId, goalId);
    db.prepare(
      `INSERT INTO chat_goal_contracts
        (goal_id, chat_id, objective, acceptance_criteria_json, status, created_at, updated_at, completed_at)
       VALUES (?, ?, NULL, '[]', 'active', ?, ?, NULL)
       ON CONFLICT(goal_id) DO NOTHING`,
    ).run(goalId, chatId, now, now);
  })();
}

/** Main-owned durable source of truth. A missing objective means "armed". */
export function getChatGoalContract(goalId: string): ChatGoalContext | null {
  const normalized = goalId.trim();
  return normalized ? toContext(readRow(normalized)) : null;
}

/** Read the active campaign even before its first request defines objective. */
export function getArmedChatGoalContract(goalId: string): ChatGoalContext | null {
  const normalized = goalId.trim();
  return normalized ? toArmedContext(readRow(normalized)) : null;
}

/**
 * Define exactly once. The conditional UPDATE is the concurrency boundary:
 * two renderer windows can race, but only the first non-empty request wins.
 * Every later call receives the existing immutable contract.
 */
export function defineChatGoalContract(input: {
  goalId: string;
  chatId: string;
  objective: string;
  acceptanceCriteria: readonly string[];
}): ChatGoalContext | null {
  const goalId = input.goalId.trim();
  const chatId = input.chatId.trim();
  const objective = input.objective.replace(/\s+/g, " ").trim().slice(0, 2_000);
  if (!goalId || !chatId || !objective) return getChatGoalContract(goalId);
  const criteria = normalizeCriteria(input.acceptanceCriteria);
  if (criteria.length === 0) throw new TypeError("goal_contract_acceptance_criteria_required");
  armChatGoalContract({ goalId, chatId });
  getDb().prepare(
    `UPDATE chat_goal_contracts
     SET objective = ?, acceptance_criteria_json = ?, updated_at = ?
     WHERE goal_id = ? AND chat_id = ? AND status = 'active'
       AND (objective IS NULL OR TRIM(objective) = '')`,
  ).run(objective, JSON.stringify(criteria), new Date().toISOString(), goalId, chatId);
  return getChatGoalContract(goalId);
}

/**
 * Terminalize the local contract before clearing the chat binding. Contracts
 * are retained for audit/recovery; a future ON receives a new goal id.
 */
export function completeChatGoalContract(
  goalId: string,
  status: Extract<GoalStatus, "blocked" | "completed" | "cancelled">,
): ChatGoalContext | null {
  const normalized = goalId.trim();
  if (!normalized) return null;
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE chat_goal_contracts
     SET status = ?, updated_at = ?, completed_at = ?
     WHERE goal_id = ? AND (status = 'active' OR (? = 'cancelled' AND status = 'blocked'))`,
  ).run(status, now, now, normalized, status);
  return toContext(readRow(normalized));
}

/** A bound but undefined campaign is distinguishable from a missing row. */
export function isChatGoalContractArmed(goalId: string): boolean {
  const normalized = goalId.trim();
  return Boolean(normalized && readRow(normalized)?.status === "active");
}

/** Revision APIs are model storage only, not a scheduler or a permission grant.
 * Intake adapters must opt into these APIs after their authoritative intent decision.
 */
export function getChatGoalRevision(goalId: string, revision?: number): GoalRevision | null {
  const row = revision === undefined
    ? getDb().prepare("SELECT payload_json FROM chat_goal_revisions WHERE goal_id = ? ORDER BY revision DESC LIMIT 1").get(goalId)
    : getDb().prepare("SELECT payload_json FROM chat_goal_revisions WHERE goal_id = ? AND revision = ?").get(goalId, revision);
  return row ? JSON.parse((row as { payload_json: string }).payload_json) as GoalRevision : null;
}

function assertStoredUserSource(source: GoalSourceMessage): void {
  const message = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as
    { chat_id: string; role: string; text: string } | undefined;
  if (!message || message.chat_id !== source.chatId || message.role !== "user" || message.text !== source.text) {
    throw new Error("goal_source_message_mismatch");
  }
}

function previouslyAppliedRevision(goalId: string, source: GoalSourceMessage): GoalRevision | null {
  const row = getDb().prepare("SELECT payload_json FROM chat_goal_revisions WHERE goal_id = ? AND source_message_id = ?")
    .get(goalId, source.messageId) as { payload_json: string } | undefined;
  if (!row) return null;
  const revision = JSON.parse(row.payload_json) as GoalRevision;
  if (revision.chatId !== source.chatId || revision.sourceMessage.text !== source.text) throw new Error("goal_source_message_mismatch");
  return revision;
}

function insertRevision(revision: GoalRevision): void {
  getDb().prepare(`INSERT INTO chat_goal_revisions (goal_id, revision, source_message_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(revision.goalId, revision.revision, revision.sourceMessage.messageId,
    JSON.stringify(revision), revision.createdAt);
}

export function createStoredAutomaticGoal(input: Parameters<typeof createAutomaticGoalRevision>[0]): GoalRevision | null {
  const revision = createAutomaticGoalRevision(input);
  if (!revision) return null;
  return getDb().transaction(() => {
    assertStoredUserSource(input.source);
    const replay = previouslyAppliedRevision(input.goalId, input.source);
    if (replay) return replay;
    // An existing campaign must be explicitly adopted/revised by its adapter.
    // Never overwrite it or cancel another active campaign as an intake side effect.
    if (readRow(input.goalId)) throw new Error("goal_contract_already_exists");
    getDb().prepare(`INSERT INTO chat_goal_contracts
      (goal_id, chat_id, objective, acceptance_criteria_json, status, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`).run(revision.goalId, revision.chatId, revision.objective,
      JSON.stringify(revision.acceptanceCriteria.map((criterion) => criterion.text)), revision.createdAt, revision.createdAt);
    insertRevision(revision);
    return revision;
  })();
}

export function reviseStoredAutomaticGoal(input: Omit<Parameters<typeof reviseAutomaticGoal>[0], "current"> & {
  goalId: string;
}): GoalRevision {
  return getDb().transaction(() => {
    assertStoredUserSource(input.source);
    const replay = previouslyAppliedRevision(input.goalId, input.source);
    if (replay) return replay;
    const contract = readRow(input.goalId);
    if (!contract || contract.chat_id !== input.source.chatId) throw new Error("goal_chat_mismatch");
    if (contract.status !== "active") throw new Error("goal_contract_not_active");
    const current = getChatGoalRevision(input.goalId);
    if (!current) throw new Error("goal_revision_missing");
    const next = reviseAutomaticGoal({ ...input, current });
    insertRevision(next);
    return next;
  })();
}
