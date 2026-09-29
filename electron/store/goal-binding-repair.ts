/**
 * A chat whose goal is still alive must stay bound to it.
 *
 * Owner 2026-09-28 ("단톡방들 목표가 다 날아갔네 안 보인다 … 그럼 AGI도 못하고"): the One room "Youtube launch" had
 * chats.goal_id = NULL while its goal was alive — contract `blocked`, long run `blocked · goal_owner_answer_required`
 * (the goal had asked the owner a question). The goal chip, the owner's answer path and the Alive/AGI room life all
 * read chats.goal_id, so the goal vanished from every surface although nothing had ended it. The writer was the
 * continuation hard-stop (goal-continuation-hold.ts, 11:46:19Z: contract → blocked + binding cleared); a new turn
 * could not rebind it either, because the orphan rebind only looked at `active` contracts.
 *
 * This module is the one rule for "which non-terminal goal belongs to this chat" when the binding is detached:
 *  - a contract for this chat that is not terminal (`active` or `blocked`), whose long run exists, is not terminal
 *    and is rooted in this chat (or has no root), and that no other chat is bound to. Latest activity wins.
 *  - the chat counts as detached when its goal_id is NULL, or points at a goal whose contract is completed/cancelled
 *    or whose long run is terminal. A chat bound to a live goal (or to an armed contract with no run yet) is never
 *    touched.
 * The repair only rewrites chats.goal_id. It never changes a contract, a long run status or a continuation row; it
 * records one typed long-run event per repair and is idempotent (a repaired chat no longer matches).
 */
import type Database from "better-sqlite3";

export const GOAL_BINDING_REPAIR_EVENT_KIND = "run.chat_goal_binding_repaired";
export const GOAL_BINDING_REPAIR_SCHEMA = "agentlas.chat-goal-binding-repair.v1";

/** A run in one of these has ended; its chat may be rebound. */
const ENDED_RUN = ["completed", "failed", "cancelled", "cancelling"];
/** Not a rebind target: ended, or a draft that never started. */
const TERMINAL_RUN_SQL = [...ENDED_RUN, "draft"].map((status) => `'${status}'`).join(",");

export interface DetachedGoalBinding {
  chatId: string;
  previousGoalId: string | null;
  goalId: string;
  runId: string;
  contractStatus: string;
  runStatus: string;
  reason: "chat_unbound" | "chat_bound_to_ended_goal";
}

type CandidateRow = { goal_id: string; contract_status: string; run_id: string; run_status: string };

function candidatesForChat(db: Database.Database, chatId: string): CandidateRow[] {
  return db.prepare(
    `SELECT g.goal_id AS goal_id, g.status AS contract_status, lr.id AS run_id, lr.status AS run_status
       FROM chat_goal_contracts g
       JOIN long_runs lr ON lr.goal_id = g.goal_id
      WHERE g.chat_id = ? AND g.status IN ('active','blocked')
        AND lr.status NOT IN (${TERMINAL_RUN_SQL})
        AND (lr.root_chat_id IS NULL OR lr.root_chat_id = g.chat_id)
        AND NOT EXISTS (SELECT 1 FROM chats o WHERE o.goal_id = g.goal_id AND o.id <> g.chat_id)
      ORDER BY MAX(COALESCE(lr.updated_at, ''), COALESCE(g.updated_at, '')) DESC, g.created_at DESC`,
  ).all(chatId) as CandidateRow[];
}

/** Is the goal this chat is bound to still alive (or an armed contract that has no run yet)? */
function boundGoalAlive(db: Database.Database, goalId: string): boolean {
  const contract = db.prepare("SELECT status FROM chat_goal_contracts WHERE goal_id = ?").get(goalId) as { status: string } | undefined;
  const run = db.prepare("SELECT status FROM long_runs WHERE goal_id = ?").get(goalId) as { status: string } | undefined;
  if (contract && (contract.status === "completed" || contract.status === "cancelled")) return false;
  if (run) return !ENDED_RUN.includes(run.status);
  // No run: an armed/defined contract (or an unknown id we must not second-guess) stays as it is.
  return true;
}

/** The live goal a detached chat belongs to, read from the contract table (null when the chat is fine or has none). */
export function detachedGoalForChat(db: Database.Database, chatId: string): DetachedGoalBinding | null {
  const chat = db.prepare("SELECT id, goal_id, archived_at FROM chats WHERE id = ?")
    .get(chatId) as { id: string; goal_id: string | null; archived_at: string | null } | undefined;
  if (!chat || chat.archived_at) return null;
  if (chat.goal_id && boundGoalAlive(db, chat.goal_id)) return null;
  const candidate = candidatesForChat(db, chat.id).find((row) => row.goal_id !== chat.goal_id);
  if (!candidate) return null;
  return { chatId: chat.id, previousGoalId: chat.goal_id, goalId: candidate.goal_id, runId: candidate.run_id,
    contractStatus: candidate.contract_status, runStatus: candidate.run_status,
    reason: chat.goal_id ? "chat_bound_to_ended_goal" : "chat_unbound" };
}

/** The goal a chat is working on: its binding, or — when the binding is detached — its live contract's goal. */
export function effectiveGoalIdForChat(db: Database.Database, chatId: string, boundGoalId: string | null): string | null {
  if (boundGoalId && boundGoalAlive(db, boundGoalId)) return boundGoalId;
  return detachedGoalForChat(db, chatId)?.goalId ?? boundGoalId;
}

export function listDetachedGoalBindings(db: Database.Database): DetachedGoalBinding[] {
  const chatIds = db.prepare(
    `SELECT DISTINCT g.chat_id AS chat_id
       FROM chat_goal_contracts g JOIN chats c ON c.id = g.chat_id
       JOIN long_runs lr ON lr.goal_id = g.goal_id
      WHERE g.status IN ('active','blocked') AND c.archived_at IS NULL
        AND lr.status NOT IN (${TERMINAL_RUN_SQL})
        AND (c.goal_id IS NULL OR c.goal_id <> g.goal_id)`,
  ).all() as Array<{ chat_id: string }>;
  return chatIds.map((row) => detachedGoalForChat(db, row.chat_id)).filter((row): row is DetachedGoalBinding => row !== null);
}

/**
 * Startup self-repair: rebind every detached chat to its live goal. Compare-and-set on the previous binding, one
 * typed event per repair, nothing else written. Safe to run on every launch.
 */
export function repairDetachedGoalBindings(deps: {
  db: Database.Database;
  appendEvent: (input: { runId: string; kind: string; actorKind: "host"; payload: Record<string, unknown> }) => unknown;
  emitChatChanged?: (chatId: string) => void;
  now?: () => Date;
}): DetachedGoalBinding[] {
  const { db } = deps;
  const repaired: DetachedGoalBinding[] = [];
  for (const binding of listDetachedGoalBindings(db)) {
    const stamp = (deps.now?.() ?? new Date()).toISOString();
    const applied = db.transaction(() => {
      const changed = db.prepare(
        "UPDATE chats SET goal_id = ?, updated_at = ? WHERE id = ? AND goal_id IS ? AND archived_at IS NULL",
      ).run(binding.goalId, stamp, binding.chatId, binding.previousGoalId);
      if (changed.changes !== 1) return false;
      deps.appendEvent({ runId: binding.runId, kind: GOAL_BINDING_REPAIR_EVENT_KIND, actorKind: "host", payload: {
        schemaVersion: GOAL_BINDING_REPAIR_SCHEMA, chatId: binding.chatId, goalId: binding.goalId,
        previousGoalId: binding.previousGoalId, reason: binding.reason,
        contractStatus: binding.contractStatus, runStatus: binding.runStatus, trigger: "startup" } });
      return true;
    })();
    if (!applied) continue;
    repaired.push(binding);
    deps.emitChatChanged?.(binding.chatId);
  }
  return repaired;
}
