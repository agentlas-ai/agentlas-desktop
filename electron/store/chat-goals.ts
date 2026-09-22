import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import type { ChatGoalContext } from "../../shared/types";
import {
  createAutomaticGoalRevision,
  resolveGoalLifecycle,
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
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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
  const objective = input.objective.replace(/\s+/g, " ").trim();
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
  // Episode success cannot terminalize the user's ongoing mandate. User cancel
  // and blocked/pause handling remain available independently of this guard.
  if (status === "completed" && getChatGoalRevision(normalized)?.lifecycle === "ongoing") {
    throw new Error("goal_ongoing_cannot_complete");
  }
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
  return row ? parseGoalRevision((row as { payload_json: string }).payload_json) : null;
}

function parseGoalRevision(payload: string): GoalRevision {
  const revision = JSON.parse(payload) as GoalRevision;
  return { ...revision, lifecycle: resolveGoalLifecycle(revision.lifecycle) };
}

/** Keep absence distinct from explicit finite (and corrupt/null values). This
 * snapshot is Main-only CAS input, never a renderer-provided migration flag. */
export function getLegacyGoalLifecycleSnapshot(goalId: string): { revision: GoalRevision; payloadJson: string } | null {
  const row = getDb().prepare("SELECT payload_json FROM chat_goal_revisions WHERE goal_id = ? ORDER BY revision DESC LIMIT 1")
    .get(goalId) as { payload_json: string } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.payload_json) as GoalRevision;
  if (!raw || typeof raw !== "object" || Object.prototype.hasOwnProperty.call(raw, "lifecycle")) return null;
  const revision = parseGoalRevision(row.payload_json);
  if (revision.goalId !== goalId || revision.schemaVersion !== "agentlas.auto-goal.v1"
    || !Number.isSafeInteger(revision.revision) || revision.revision < 1) throw new Error("goal_legacy_lifecycle_invalid");
  return { revision, payloadJson: row.payload_json };
}

/** Lifecycle-only revision inside the caller's explicit-user resume transaction.
 * Never acknowledges effects, grants authority, resets budget, or resumes work. */
export function migrateLegacyGoalLifecycle(input: {
  goalId: string;
  expectedPayloadJson: string;
  source: GoalSourceMessage;
  /** Native Resume supplies no new prose. In that path the exact stored source
   * is re-judged and only the missing metadata bit is CAS-backfilled. */
  preserveRevision?: boolean;
}): GoalRevision {
  const db = getDb();
  if (!db.inTransaction) throw new Error("goal_legacy_lifecycle_transaction_required");
  assertStoredUserSource(input.source);
  const snapshot = getLegacyGoalLifecycleSnapshot(input.goalId);
  if (!snapshot || snapshot.payloadJson !== input.expectedPayloadJson) throw new Error("goal_legacy_lifecycle_conflict");
  const current = snapshot.revision;
  const contract = readRow(input.goalId);
  const binding = db.prepare("SELECT goal_id FROM chats WHERE id = ?").get(input.source.chatId) as { goal_id: string | null } | undefined;
  const prior = previouslyAppliedRevision(input.goalId, input.source);
  if (current.chatId !== input.source.chatId || contract?.chat_id !== current.chatId
    || !["active", "blocked"].includes(contract.status) || binding?.goal_id !== current.goalId
    || (input.preserveRevision
      ? current.sourceMessage.messageId !== input.source.messageId || current.sourceMessage.text !== input.source.text
      : Boolean(prior))) throw new Error("goal_legacy_lifecycle_source_conflict");
  if (input.preserveRevision) {
    const next: GoalRevision = { ...current, lifecycle: "ongoing" };
    const changed = db.prepare(`UPDATE chat_goal_revisions SET payload_json = ?
      WHERE goal_id = ? AND revision = ? AND payload_json = ?`)
      .run(JSON.stringify(next), current.goalId, current.revision, input.expectedPayloadJson);
    if (changed.changes !== 1) throw new Error("goal_legacy_lifecycle_conflict");
    return parseGoalRevision(JSON.stringify(next));
  }
  const next: GoalRevision = {
    ...current,
    revision: current.revision + 1,
    parentRevision: current.revision,
    sourceMessage: { ...input.source },
    reason: "legacy_lifecycle_user_confirmed",
    lifecycle: "ongoing",
    createdAt: new Date().toISOString(),
  };
  insertRevision(next);
  return next;
}

export interface GoalAuthorityReauthorization {
  revision: GoalRevision;
  previousAuthorityRefs: string[];
  authorityRef: string;
  changedAt: string;
}

/** Explicit renderer permission changes replace the active Goal grant. The
 * objective/criteria revision stays the same; authority is host-owned state,
 * and the new opaque ref is recorded on that revision for every future resume.
 */
export function reauthorizeStoredAutomaticGoal(input: {
  goalId: string;
  chatId: string;
  expectedRevision: number;
  permission: "read" | "write" | "full";
}): GoalAuthorityReauthorization {
  const goalId = input.goalId.trim();
  const chatId = input.chatId.trim();
  if (!goalId || !chatId) throw new Error("goal_authority_identity_required");
  const result = getDb().transaction(() => {
    const contract = readRow(goalId);
    if (!contract || contract.chat_id !== chatId || !["active", "blocked"].includes(contract.status)) {
      throw new Error("goal_authority_reauthorization_not_allowed");
    }
    const current = getChatGoalRevision(goalId);
    if (!current || current.chatId !== chatId) throw new Error("goal_revision_missing");
    if (current.revision !== input.expectedRevision) throw new Error("goal_revision_conflict");
    const changedAt = new Date().toISOString();
    const authorityRef = `invocation:permission-change-${randomUUID()}:permission:${input.permission}`;
    const next: GoalRevision = {
      ...current,
      authorityRefs: [authorityRef],
      authorityChangedAt: changedAt,
      authorityChangeReason: "user_permission_changed",
    };
    getDb().prepare("UPDATE chat_goal_revisions SET payload_json = ? WHERE goal_id = ? AND revision = ?")
      .run(JSON.stringify(next), goalId, current.revision);
    return { revision: next, previousAuthorityRefs: [...current.authorityRefs], authorityRef, changedAt };
  })();
  emitDesktopStoreChange({ entity: "chat", id: chatId });
  return result;
}

function assertStoredUserSource(source: GoalSourceMessage): void {
  const message = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as
    { chat_id: string; role: string; text: string } | undefined;
  if (!message || message.chat_id !== source.chatId || message.role !== "user" || message.text !== source.text) {
    throw new Error("goal_source_message_mismatch");
  }
}

/**
 * Persist an explicit user source while the caller owns the surrounding Goal
 * transaction.  Keeping this write in the Goal store means an amendment can
 * never create a revision whose source message was only held in renderer
 * memory.  The caller emits the chat change after its outer transaction
 * commits; this helper intentionally has no independent commit or emission.
 */
export function appendStoredUserSourceMessage(input: {
  chatId: string;
  text: string;
  createdAt?: string;
}): GoalSourceMessage {
  const chatId = input.chatId.trim();
  const text = input.text;
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!getDb().inTransaction) throw new Error("goal_source_message_transaction_required");
  if (!chatId || !text.trim() || text.includes("\0") || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("goal_source_message_invalid");
  }
  const messageId = randomUUID();
  const inserted = getDb().prepare(
    "INSERT INTO chat_messages (id, chat_id, role, text, created_at, host_notice_json) VALUES (?, ?, 'user', ?, ?, NULL)",
  ).run(messageId, chatId, text, createdAt);
  if (inserted.changes !== 1) throw new Error("goal_source_message_not_saved");
  const touched = getDb().prepare(
    "UPDATE chats SET updated_at = ?, used_at = COALESCE(used_at, ?) WHERE id = ?",
  ).run(createdAt, createdAt, chatId);
  if (touched.changes !== 1) throw new Error("goal_chat_missing");
  return { chatId, messageId, role: "user", text };
}

function previouslyAppliedRevision(goalId: string, source: GoalSourceMessage): GoalRevision | null {
  const row = getDb().prepare("SELECT payload_json FROM chat_goal_revisions WHERE goal_id = ? AND source_message_id = ?")
    .get(goalId, source.messageId) as { payload_json: string } | undefined;
  if (!row) return null;
  const revision = parseGoalRevision(row.payload_json);
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
    const orphan = getDb().prepare(
      "SELECT goal_id FROM chat_goal_contracts WHERE chat_id = ? AND status = 'active' AND goal_id <> ? LIMIT 1",
    ).get(revision.chatId, revision.goalId) as { goal_id: string } | undefined;
    if (orphan) {
      const binding = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(revision.chatId) as
        { goal_id: string | null } | undefined;
      if (binding?.goal_id === orphan.goal_id) throw new Error("auto_goal_chat_already_bound");
      const now = new Date().toISOString();
      getDb().prepare("UPDATE chat_goal_contracts SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE goal_id = ? AND status = 'active'")
        .run(now, now, orphan.goal_id);
    }
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
    if (!["active", "blocked"].includes(contract.status)) throw new Error("goal_contract_not_active");
    const current = getChatGoalRevision(input.goalId);
    if (!current) throw new Error("goal_revision_missing");
    const next = reviseAutomaticGoal({ ...input, current });
    insertRevision(next);
    getDb().prepare(`UPDATE chat_goal_contracts
      SET objective = ?, acceptance_criteria_json = ?, status = 'active', updated_at = ?, completed_at = NULL
      WHERE goal_id = ? AND chat_id = ?`).run(next.objective,
      JSON.stringify(next.acceptanceCriteria.map((criterion) => criterion.text)), next.createdAt,
      next.goalId, next.chatId);
    return next;
  })();
}
