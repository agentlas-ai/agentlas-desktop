/**
 * The one way a Goal closes (Agentlas 2.0 N4, decision; docs/Agentlas2.0/audit/39-design-n-agentlas-harness.md section 11) and the one
 * way a conversation's Goal records are deleted with the conversation.
 *
 * closeGoal(goalId, outcome, by) is ONE transaction that leaves nothing of the Goal behind that could start, wait or count as open work:
 *   - the run goes to its end state (completed / cancelled / failed) whatever state it was in: running turn, open card, wait, hold or
 *     another process's lease do not matter and nothing here waits for them (a live turn is stopped by the callers' own stop path, which
 *     is where it lives; the close does not wait for its result),
 *   - the contract takes the outcome, the conversation's Goal link and continuous mode are cleared (every conversation that names the
 *     Goal), the run's open tasks end, the conversation's harness_due line is deleted,
 *   - when the OWNER closes (stop / delete), the messages queued behind that conversation's turn are cancelled (an owner stop never
 *     leaves a direction that would start the stopped work again).
 * and then READS THE STATE BACK: no conversation links the Goal, no harness_due line, no open task, no queued steer (owner closes), the
 * contract is not open. A leftover is repaired once and read again; the result says whether the state is clean.
 *
 * The close is idempotent and safe when two processes (Main and the background service) close the same Goal: the second one finds the run
 * already ended and only repeats the unconditional clean-up statements.
 *
 * Not closed here: a Science Goal. Its run is a projection of Science's own state (store/long-runs.ts science authority); only what the
 * old call sites always did for it (the contract and the conversation link) is done, and its run, tasks and lines are left as they are.
 *
 * Retention (resource-minimum rule): this file adds no table, no column, no timer. What it deletes with a conversation
 * (removeGoalRecordsOfChat) is read only while the conversation exists; what it leaves for later (closed Goals' event lines, decision
 * receipts, KPI samples, closed steers) is aged out by storage/db-retention-policy.ts, whose pass runs at the existing idle times.
 */
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { clearHarnessDueInDb } from "./harness-due";
import { LONG_RUN_OPEN_TASK_STATES, LONG_RUN_TERMINAL_STATUSES, type LongRunStatus } from "../../shared/long-run";

export type GoalCloseOutcome = "completed" | "cancelled" | "failed";

/**
 * Who closes. The first three are the owner: the run's events are written as the owner's, and (owner-stop only) the queued messages behind
 * the conversation's turn are cancelled, as the Goal Stop and Delete always did.
 */
export type GoalCloseBy =
  | "owner-stop"      // Stop / Delete of the Goal (control, turn stop that deletes, tool cancel)
  | "owner-card"      // the owner's answer to the Goal's own card: "stop here and summarize"
  | "owner-tool"      // the Goal ledger's cancel (the owner's cancel through the tool surface)
  | "verifier"        // every criterion verified
  | "model-judgment"  // the model declared completion and the verifier could not contradict it
  | "daemon-turn"     // a turn the background service hosted ended the Goal's work
  | "cleanup"         // recovery / reconcile / sweep: the Goal had already ended or was never backed by a run
  | "transition"      // transitionLongRun was asked to end a run (the generic status entry point): the same close, the caller's actor
  | "replaced"        // a new Goal of the same conversation pushed this one out
  | "chat-deleted";   // the conversation was deleted

const OWNER_CLASS: ReadonlySet<GoalCloseBy> = new Set(["owner-stop", "owner-card", "owner-tool"]);

export interface GoalCloseOptions {
  /** Ledger reason of the run's status event; defaults to the close's own name. */
  reason?: string;
  /** Whose event the run's status change is; defaults from `by` (the owner closes as "user", everything else as "host"). */
  actorKind?: "host" | "user";
}

export interface GoalCloseResidue {
  /** Conversations that still name the Goal. */
  boundChats: number;
  /** harness_due lines of the Goal's conversations. */
  dueLines: number;
  /** Open tasks of the Goal's run. */
  openTasks: number;
  /** Queued steers of the Goal's conversations (counted only when the owner closed). */
  queuedSteers: number;
  /** The contract is still active or blocked. */
  contractOpen: number;
}

export interface GoalCloseResult {
  goalId: string;
  outcome: GoalCloseOutcome;
  by: GoalCloseBy;
  runId: string | null;
  /** This call moved the run to its end state (false: it was already ended, absent or a Science run). */
  runEnded: boolean;
  /** This call moved the contract to its end state. */
  contractEnded: boolean;
  unboundChats: string[];
  tasksEnded: number;
  /** The re-read after the close found nothing left. */
  clean: boolean;
  residue: GoalCloseResidue;
}

const nowIso = (): string => new Date().toISOString();

type RunRow = { id: string; status: LongRunStatus; surface: string; root_chat_id: string | null; version: number };

function readResidue(goalId: string, runId: string | null, chatIds: readonly string[], ownerClose: boolean, science: boolean): GoalCloseResidue {
  const db = getDb();
  const ids = JSON.stringify(chatIds);
  const count = (sql: string, ...params: unknown[]): number => Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);
  const states = [...LONG_RUN_OPEN_TASK_STATES];
  return {
    boundChats: count("SELECT COUNT(*) AS n FROM chats WHERE goal_id = ?", goalId),
    dueLines: science ? 0 : count(`SELECT COUNT(*) AS n FROM harness_due WHERE chat_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM long_runs r WHERE r.root_chat_id = harness_due.chat_id AND r.goal_id <> ? AND r.status NOT IN ('completed','failed','cancelled'))`, ids, goalId),
    openTasks: !runId || science ? 0
      : count(`SELECT COUNT(*) AS n FROM long_run_tasks WHERE run_id = ? AND state IN (${states.map(() => "?").join(",")})`, runId, ...states),
    queuedSteers: !ownerClose || science ? 0 : count("SELECT COUNT(*) AS n FROM invocation_steers WHERE status = 'queued' AND chat_id IN (SELECT value FROM json_each(?))", ids),
    contractOpen: count("SELECT COUNT(*) AS n FROM chat_goal_contracts WHERE goal_id = ? AND status IN ('active','blocked')", goalId),
  };
}

function clearHarnessDueUnlessOtherGoalLive(db: ReturnType<typeof getDb>, chatId: string, goalId: string): void {
  const other = db.prepare("SELECT 1 FROM long_runs WHERE root_chat_id = ? AND goal_id <> ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1").get(chatId, goalId);
  if (!other) clearHarnessDueInDb(db, chatId);
}

const residueClean = (r: GoalCloseResidue): boolean => r.boundChats + r.dueLines + r.openTasks + r.queuedSteers + r.contractOpen === 0;

/**
 * Close a Goal. Throws only for a completed claim the Goal's own rules refuse (an ongoing mandate never completes; open execution
 * obligations must be met), before anything is written. Every other call closes.
 */
export function closeGoal(goalId: string, outcome: GoalCloseOutcome, by: GoalCloseBy, options: GoalCloseOptions = {}): GoalCloseResult {
  const id = goalId.trim();
  const empty: GoalCloseResult = { goalId: id, outcome, by, runId: null, runEnded: false, contractEnded: false, unboundChats: [], tasksEnded: 0,
    clean: true, residue: { boundChats: 0, dueLines: 0, openTasks: 0, queuedSteers: 0, contractOpen: 0 } };
  if (!id) return empty;
  const db = getDb();
  const ownerClose = OWNER_CLASS.has(by);
  const reason = (options.reason ?? by).slice(0, 200);
  const longRuns = require("./long-runs") as typeof import("./long-runs"); // eslint-disable-line @typescript-eslint/no-require-imports
  let runId: string | null = null;
  let science = false;
  let runEnded = false;
  let contractEnded = false;
  let tasksEnded = 0;
  let unbound: string[] = [];
  let chatIds: string[] = [];

  const apply = (): void => {
    const run = db.prepare("SELECT id, status, surface, root_chat_id, version FROM long_runs WHERE goal_id = ? LIMIT 1").get(id) as RunRow | undefined;
    const contract = db.prepare("SELECT chat_id, status FROM chat_goal_contracts WHERE goal_id = ?").get(id) as { chat_id: string; status: string } | undefined;
    runId = run?.id ?? null;
    science = run?.surface === "science";
    if (outcome === "completed" && !science && run?.status !== "completed") {
      const { getChatGoalRevision } = require("./chat-goals") as typeof import("./chat-goals"); // eslint-disable-line @typescript-eslint/no-require-imports
      if (getChatGoalRevision(id)?.lifecycle === "ongoing") throw new Error("goal_ongoing_cannot_complete");
      if (!(require("../long-run/goal-obligation-context") as typeof import("../long-run/goal-obligation-context")).currentGoalObligationsSatisfied(id)) { // eslint-disable-line @typescript-eslint/no-require-imports
        throw new Error("goal_execution_obligations_unmet");
      }
    }
    const stamp = nowIso();
    const bound = (db.prepare("SELECT id FROM chats WHERE goal_id = ?").all(id) as Array<{ id: string }>).map((row) => row.id);
    chatIds = [...new Set([...bound, ...(run?.root_chat_id ? [run.root_chat_id] : []), ...(contract?.chat_id ? [contract.chat_id] : [])])];
    // 1. the run, whatever its state (a Science run is a projection: never moved here)
    if (run && !science && !LONG_RUN_TERMINAL_STATUSES.has(run.status)) {
      runEnded = runEnded || longRuns.endLongRunInTransaction({ runId: run.id, from: run.status, to: outcome, by, reason, actorKind: options.actorKind ?? (ownerClose ? "user" : "host"), at: stamp });
    }
    // 2. its open tasks (a completed run with leftovers too: "no open work" is part of closed)
    if (run && !science) tasksEnded += longRuns.endOpenTasksOfRun(run.id, stamp);
    // 3. the contract: active -> outcome; a blocked contract may only be cancelled (the rule the contract-only close had)
    if (contract) {
      const to = outcome === "completed" ? "completed" : "cancelled";
      contractEnded = contractEnded || db.prepare(
        `UPDATE chat_goal_contracts SET status = ?, updated_at = ?, completed_at = ?
         WHERE goal_id = ? AND (status = 'active' OR (? = 'cancelled' AND status = 'blocked'))`,
      ).run(to, stamp, stamp, id, to).changes > 0;
    }
    // 4. every conversation that names the Goal stops naming it, and its continuous mode goes off (the Goal chip is honest)
    if (!science && bound.length) {
      db.prepare("UPDATE chats SET goal_id = NULL, continuous_mode = 0, updated_at = ? WHERE goal_id = ?").run(stamp, id);
      unbound = [...new Set([...unbound, ...bound])];
    } else if (science && bound.length) {
      db.prepare("UPDATE chats SET goal_id = NULL, updated_at = ? WHERE goal_id = ?").run(stamp, id);
      unbound = [...new Set([...unbound, ...bound])];
    }
    // 5. no next look for the conversations of this Goal (the line is the conversation's: another live Goal run of the same conversation keeps it)
    if (!science) for (const chat of chatIds) clearHarnessDueUnlessOtherGoalLive(db, chat, id);
    // 6. the owner's stop: nothing queued behind the conversation's turn may start the stopped work again
    if (by === "owner-stop" && !science) {
      const { cancelQueuedSteersForChat } = require("./invocation-steers") as typeof import("./invocation-steers"); // eslint-disable-line @typescript-eslint/no-require-imports
      for (const chat of chatIds) cancelQueuedSteersForChat(chat, false, "goal-stopped");
    }
  };
  db.transaction(apply).immediate();

  // Read the state back. One repair pass (the unconditional statements again), one more read.
  let residue = readResidue(id, runId, chatIds, by === "owner-stop", science);
  if (!residueClean(residue)) {
    db.transaction(apply).immediate();
    residue = readResidue(id, runId, chatIds, by === "owner-stop", science);
  }
  if (runEnded && runId) emitDesktopStoreChange({ entity: "long-run", id: runId });
  for (const chat of new Set([...unbound, ...chatIds])) emitDesktopStoreChange({ entity: "chat", id: chat });
  return { goalId: id, outcome, by, runId, runEnded, contractEnded, unboundChats: unbound, tasksEnded, clean: residueClean(residue), residue };
}

// ── the delete chain: a conversation takes its Goals and their records with it ─────────────────────────────────────────────────────

type Db = ReturnType<typeof getDb>;

const hasTable = (db: Db, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * The Goals that belong to this conversation alone: named by its link, by its contracts or by its run, and not named by another
 * conversation, not owned by another conversation's run, not a Science run. A Goal another conversation still holds is only detached
 * from this one (its records stay with the other conversation).
 */
export function goalsOwnedByChat(db: Db, chatId: string): string[] {
  const candidates = new Set<string>();
  for (const row of db.prepare("SELECT goal_id AS id FROM chats WHERE id = ? AND goal_id IS NOT NULL").all(chatId) as Array<{ id: string }>) candidates.add(row.id);
  for (const row of db.prepare("SELECT goal_id AS id FROM chat_goal_contracts WHERE chat_id = ?").all(chatId) as Array<{ id: string }>) candidates.add(row.id);
  for (const row of db.prepare("SELECT goal_id AS id FROM long_runs WHERE root_chat_id = ? AND surface <> 'science'").all(chatId) as Array<{ id: string }>) candidates.add(row.id);
  const owned: string[] = [];
  for (const goal of candidates) {
    const otherChat = db.prepare("SELECT 1 FROM chats WHERE goal_id = ? AND id <> ? LIMIT 1").get(goal, chatId);
    const otherContract = db.prepare("SELECT 1 FROM chat_goal_contracts WHERE goal_id = ? AND chat_id <> ? LIMIT 1").get(goal, chatId);
    const run = db.prepare("SELECT root_chat_id, surface FROM long_runs WHERE goal_id = ? LIMIT 1").get(goal) as { root_chat_id: string | null; surface: string } | undefined;
    if (otherChat || otherContract) continue;
    if (run && (run.surface === "science" || (run.root_chat_id !== null && run.root_chat_id !== chatId))) continue;
    owned.push(goal);
  }
  return owned;
}

export interface GoalRecordPurge { goals: number; runs: number; planRows: number; kpiRows: number; episodeRows: number; automationsOff: number }

/**
 * Deletes the records of these Goals (closed by the caller first): the run and, by cascade, its events, tasks, workers, attempts,
 * messages, receipts and domain bindings; the plan tree, its decisions and mutation counters; the KPIs, samples and states; the
 * episode captures. Runs inside the caller's transaction. A table an older store lacks is skipped. Never touches a Science run.
 */
export function purgeGoalRecords(db: Db, goalIds: readonly string[], options: { detachHeavy?: boolean } = {}): GoalRecordPurge & { detached?: number } {
  const out: GoalRecordPurge & { detached?: number } = { goals: 0, runs: 0, planRows: 0, kpiRows: 0, episodeRows: 0, automationsOff: 0 };
  for (const goal of goalIds) {
    const run = db.prepare("SELECT id, surface FROM long_runs WHERE goal_id = ? LIMIT 1").get(goal) as { id: string; surface: string } | undefined;
    if (run?.surface === "science") continue;
    out.goals += 1;
    // a continuation automation of a Goal that no longer exists must not fire: it is switched off (the owner's own list keeps it)
    if (hasTable(db, "automations")) {
      const { toggleAutomation } = require("./automations") as typeof import("./automations"); // eslint-disable-line @typescript-eslint/no-require-imports
      for (const row of db.prepare("SELECT id FROM automations WHERE goal_id = ? AND enabled = 1").all(goal) as Array<{ id: string }>) {
        try { toggleAutomation(row.id, false); out.automationsOff += 1; } catch { /* the row stays enabled; its Goal has no run, the scheduler's own checks refuse it */ }
      }
    }
    if (hasTable(db, "goal_plan_nodes")) {
      out.planRows += db.prepare("DELETE FROM goal_plan_nodes WHERE goal_id = ?").run(goal).changes; // its delete trigger touches goal_plan_mutations: delete that after
      if (hasTable(db, "goal_plan_decisions")) out.planRows += db.prepare("DELETE FROM goal_plan_decisions WHERE goal_id = ?").run(goal).changes;
      if (hasTable(db, "goal_plan_mutations")) out.planRows += db.prepare("DELETE FROM goal_plan_mutations WHERE goal_id = ?").run(goal).changes;
    }
    for (const table of ["goal_kpi_samples", "goal_kpi_state", "goal_kpis"]) {
      if (hasTable(db, table)) out.kpiRows += db.prepare(`DELETE FROM ${table} WHERE goal_id = ?`).run(goal).changes;
    }
    if (hasTable(db, "goal_episode_captures")) {
      if (hasTable(db, "goal_episode_dispositions")) {
        out.episodeRows += db.prepare("DELETE FROM goal_episode_dispositions WHERE capture_id IN (SELECT id FROM goal_episode_captures WHERE goal_id = ?)").run(goal).changes;
      }
      out.episodeRows += db.prepare("DELETE FROM goal_episode_captures WHERE goal_id = ?").run(goal).changes;
    }
    if (run) {
      // A closed run with a big event ledger is only detached here (deleted-chat-ledgers.ts removes its lines in pieces, then the run);
      // anything else goes now, with the cascade, as before.
      const ledgers = require("../storage/deleted-chat-ledgers") as typeof import("../storage/deleted-chat-ledgers"); // eslint-disable-line @typescript-eslint/no-require-imports
      const closed = db.prepare("SELECT 1 FROM long_runs WHERE id = ? AND status IN ('completed','failed','cancelled')").get(run.id);
      if (options.detachHeavy && closed && ledgers.runLedgerIsHeavy(db, run.id)) {
        out.runs += db.prepare("UPDATE long_runs SET goal_id = ? WHERE id = ? AND surface <> 'science'").run(ledgers.deletedGoalId(run.id), run.id).changes;
        out.detached = (out.detached ?? 0) + 1;
        ledgers.noteLedgerDetached();
      } else out.runs += db.prepare("DELETE FROM long_runs WHERE id = ? AND surface <> 'science'").run(run.id).changes; // cascade: events, tasks, workers, ...
    }
    db.prepare("DELETE FROM chat_goal_contracts WHERE goal_id = ?").run(goal); // cascade: revisions
  }
  return out;
}

/**
 * The conversation is being deleted: close each Goal it owns through closeGoal, then delete their records, and delete what is keyed by
 * the conversation (steers, current-turn steers). Called inside removeChatTree's transaction, before the chat row goes. Returns the Goals.
 */
export function removeGoalRecordsOfChat(db: Db, chatId: string): { goals: string[]; purge: GoalRecordPurge & { detached?: number } } {
  const goals = goalsOwnedByChat(db, chatId);
  for (const goal of goals) closeGoal(goal, "cancelled", "chat-deleted", { reason: "chat_deleted" });
  // a Goal another conversation holds is detached from this one only
  db.prepare("UPDATE chats SET goal_id = NULL, continuous_mode = 0 WHERE id = ?").run(chatId);
  const purge = purgeGoalRecords(db, goals, { detachHeavy: true });
  if (hasTable(db, "invocation_steers")) db.prepare("DELETE FROM invocation_steers WHERE chat_id = ?").run(chatId);
  if (hasTable(db, "invocation_current_turn_steers")) db.prepare("DELETE FROM invocation_current_turn_steers WHERE chat_id = ?").run(chatId);
  if (hasTable(db, "goal_episode_notice_outbox")) db.prepare("DELETE FROM goal_episode_notice_outbox WHERE chat_id = ?").run(chatId);
  return { goals, purge };
}

/**
 * The agent-context journal heads (and, by cascade, their entries, bindings, deliveries and stable blocks) that belong to this
 * conversation alone: the journal whose domain is the conversation's own (`chat:<id>`, or a dispatch child's `one-team:<room>:session:<id>`),
 * unless a seat assignment record still names that domain (the journal is then shared with another conversation of the seat and stays).
 * Returns the heads deleted. Inside the caller's transaction.
 */
export function removeJournalHeadsOfChat(db: Db, chatId: string): number {
  if (!hasTable(db, "agent_context_heads")) return 0;
  const domains = [`chat:${chatId}`];
  const parent = db.prepare("SELECT parent_chat_id AS p FROM chats WHERE id = ?").get(chatId) as { p: string | null } | undefined;
  if (parent?.p) domains.push(`one-team:${parent.p}:session:${chatId}`);
  let removed = 0;
  const ledgers = require("../storage/deleted-chat-ledgers") as typeof import("../storage/deleted-chat-ledgers"); // eslint-disable-line @typescript-eslint/no-require-imports
  for (const domain of domains) {
    const shared = hasTable(db, "meta")
      && db.prepare("SELECT 1 FROM meta WHERE key LIKE 'session-scope.actor:%' AND instr(value, ?) > 0 LIMIT 1").get(domain);
    if (shared) continue;
    // A head with a big journal is only detached (its domain is renamed: no read can name it any more); deleted-chat-ledgers.ts removes
    // its entries in pieces and then the head. Small heads go now, with the cascade, as before. through_seq is the entry count.
    const heavy = db.prepare("SELECT context_key AS key FROM agent_context_heads WHERE json_valid(identity_json) AND json_extract(identity_json, '$.visibilityDomain') = ? AND through_seq > ?")
      .all(domain, ledgers.HEAVY_LEDGER_ROWS) as Array<{ key: string }>;
    for (const head of heavy) {
      removed += db.prepare("UPDATE agent_context_heads SET identity_json = json_set(identity_json, '$.visibilityDomain', ?) WHERE context_key = ?").run(ledgers.deletedChatDomain(head.key), head.key).changes;
      ledgers.noteLedgerDetached();
    }
    removed += db.prepare("DELETE FROM agent_context_heads WHERE json_valid(identity_json) AND json_extract(identity_json, '$.visibilityDomain') = ?").run(domain).changes;
  }
  return removed;
}
