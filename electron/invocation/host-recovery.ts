import { randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import {
  classifyOwnerFailureDetailed, internalFailureOwnerLine,
  type InternalFailurePlan, type OwnerFailureFacts, type OwnerFailureVerdict,
} from "../../shared/owner-failure-class";
import { isTransientSendRefusal } from "../../shared/transient-send-refusal";
import { recordRunEvent } from "../store/run-events";
import { getDb } from "../store/db";

/**
 * The host-level safety net for an owner turn that fails INSIDE the app (owner rule: no internal harness code reaches
 * the owner; the request is completed instead).
 *
 * One decision at the one place a failed owner turn becomes visible (invocation/service.ts, the three terminal sites):
 *  - external (shared/owner-failure-class.ts table): nothing changes, the existing honest message stays;
 *  - internal and nothing acted (typed not-dispatched proof, or the effect tracker saw no tool, with complete coverage): the host
 *    starts ONE fresh ordinary turn for the same request: no Goal episode binding, a new run (new agent-context generation), the
 *    same permission, images and working folder, the same transcript row. The failed attempt is folded under the recovered
 *    answer by the existing supersession rule (a later run bound to the same prompt row: store/run-events.ts);
 *  - internal and something may have run, the owner wrote something newer, the request cannot be replayed, or the retry failed
 *    inside the app too: one plain line (no code, no exception text) and a typed defect row (run_events kind harness_defect).
 *
 * Marked Main-only (`hostRecovery` on the request): a recovery turn never schedules another, the renderer cannot send the field
 * (ipc.ts strips it), and the durable `host_recovery_requested` row makes the retry at-most-once across restarts and processes
 * (Desktop Main and the background service write the same store).
 */
export interface HostRecoveryMarker { ofRunId: string; userMessageId: string | null; ordinal: 1 }
export type HostRecoveryRequest = McpInvocationRequest & { hostRecovery?: HostRecoveryMarker };

export const HOST_RECOVERY_REQUESTED = "host_recovery_requested";
export const HOST_RECOVERY_LINK = "host_recovery_link";
export const HOST_RECOVERY_OUTCOME = "host_recovery_outcome";
export const HARNESS_DEFECT = "harness_defect";
/** Bounded waits for the chat to become free before the recovery start (the Goal's own continuation may take it first). */
export const HOST_RECOVERY_START_ATTEMPTS = 12;

type Db = { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown } };

export function hostRecoveryOf(request: McpInvocationRequest | null | undefined): HostRecoveryMarker | null {
  const marker = (request as HostRecoveryRequest | null | undefined)?.hostRecovery;
  return marker && typeof marker.ofRunId === "string" ? marker : null;
}

/** The request a recovery turn starts: the original words and choices, none of the one-use or Goal-episode state. */
export function hostRecoveryRequestFor(original: McpInvocationRequest, marker: HostRecoveryMarker): HostRecoveryRequest {
  const {
    runId: _runId, steeringMode: _steeringMode, preflightSubmissionId: _preflight, oneMemoryUseOnceRef: _memory,
    oneBriefingActionRef: _briefing, activeGoalId: _goal, earlierAttemptUncertain: _earlier, ...rest
  } = original as McpInvocationRequest & { activeGoalId?: unknown; earlierAttemptUncertain?: unknown };
  return { ...rest, runId: randomUUID(), hostRecovery: marker };
}

/** A request the host can start again exactly as the owner sent it: no one-use attachment or preflight capability. */
export function requestIsReplayable(request: McpInvocationRequest): boolean {
  return !request.oneAttachmentRef && !request.oneTeamPreflightRef && request.agentAppMode !== true;
}

/** True for the turns whose words are the owner's: the composer, the phone, an owner card answer, a remote chat of the owner. */
export function isOwnerTurnRequest(request: McpInvocationRequest, input: { background?: boolean; executionSource?: string | null; scienceTurn?: boolean }): boolean {
  if (input.background || request.promptOrigin === "system" || request.agentAppMode === true || request.oneTeamReportTurn === true) return false;
  if (input.scienceTurn) return false;
  if (input.executionSource === "automation" || input.executionSource === "graph") return false;
  return true;
}

export function hostRecoveryRequested(db: Db, runId: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(runId, HOST_RECOVERY_REQUESTED)); }
  catch { return false; }
}

/** The run that this recovery run stands for, or null when it is not a recovery run. */
export function hostRecoveryOriginalOf(db: Db, runId: string): string | null {
  try {
    const row = db.prepare("SELECT json_extract(payload_json, '$.originalRunId') AS id FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1")
      .get(runId, HOST_RECOVERY_LINK) as { id?: unknown } | undefined;
    return typeof row?.id === "string" ? row.id : null;
  } catch { return null; }
}

/**
 * Did the owner say anything after the prompt of this run, or does a message of theirs wait for the chat? A newer owner message
 * always wins: the recovery must never race it (it would answer an old question after the new one).
 */
export function ownerSpokeAfter(db: Db, chatId: string, userMessageId: string | null, startedAtIso: string): boolean {
  try {
    const row = userMessageId
      ? db.prepare(`SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user'
          AND rowid > (SELECT rowid FROM chat_messages WHERE id = ? AND chat_id = ?) LIMIT 1`).get(chatId, userMessageId, chatId)
      : db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1").get(chatId, startedAtIso);
    if (row) return true;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_chat_sends'").get()
      && db.prepare("SELECT 1 FROM pending_chat_sends WHERE chat_id = ? AND state = 'queued' LIMIT 1").get(chatId)) return true;
    return Boolean(db.prepare("SELECT 1 FROM run_events WHERE chat_id = ? AND kind = 'invoke_cancel_requested' AND ts > ? AND COALESCE(json_extract(payload_json,'$.reason'),'') != 'steering' LIMIT 1")
      .get(chatId, startedAtIso));
  } catch {
    // An unreadable ledger proves nothing about the owner: the safe answer is "they spoke" (nothing is re-run on a guess).
    return true;
  }
}

export interface OwnerFailureInput {
  db: Db;
  runId: string;
  chatId: string;
  locale: "ko" | "en";
  facts: OwnerFailureFacts;
  ownerTurn: boolean;
  /** This run is itself a host recovery turn. */
  hostRecovery: boolean;
  /** The typed not-dispatched proof, or the effect tracker's proof that no tool acted. */
  nothingActed: boolean;
  replayable: boolean;
  userMessageId: string | null;
  startedAtIso: string;
  /** An active Goal in this room carries the work on by itself (queued, running, waiting). */
  goalCarries: boolean;
  /** The send queue will send this unconfirmed message once more by itself after telling the model so (earlier-attempt.ts). */
  queueResends: boolean;
  /**
   * The owner's send queue starts this very message again by itself (queue-retry-fact.ts queueWillStartRunAgain: a "not ready yet" cause with
   * backoff, or the one start-again of a run that sent nothing). Its wait-and-retry is the right machine for a busy chat or project, so the
   * host does not start a second one; when the queue is out of tries, the next failure of the message is the host's.
   */
  queueOwnsRetry: boolean;
}

export interface OwnerFailureDecision {
  verdict: OwnerFailureVerdict;
  /** none: not an owner-visible failure to act on. external: keep the existing message. recover: start the recovery turn. say: plain line only. */
  action: "none" | "external" | "queue" | "recover" | "say";
  plan?: InternalFailurePlan;
  line?: string;
  /** A typed defect row is due (every internal failure, once per run). */
  defect: boolean;
  /** Why this plan (machine word, goes to the defect row). */
  reason: string;
}

export function decideOwnerFailure(input: OwnerFailureInput): OwnerFailureDecision {
  const verdict = classifyOwnerFailureDetailed(input.facts);
  if (verdict.klass === "external") return { verdict, action: "external", defect: false, reason: `external:${verdict.cause}` };
  // An active Goal in this room carries the work on at its next turn: the line says that instead of asking the owner to resend.
  const say = (plan: InternalFailurePlan, reason: string): OwnerFailureDecision => {
    const worded: InternalFailurePlan = input.goalCarries && input.ownerTurn && (plan === "uncertain" || plan === "exhausted" || plan === "manual" || plan === "checking") ? "goal" : plan;
    return { verdict, action: "say", plan: worded, line: internalFailureOwnerLine(input.locale, worded), defect: true, reason };
  };
  if (!input.ownerTurn) return say("background", "not_owner_turn");
  if (input.queueOwnsRetry && !input.hostRecovery) return { verdict, action: "queue", plan: "recovering", line: internalFailureOwnerLine(input.locale, "recovering"), defect: true, reason: "queue_retries" };
  if (input.hostRecovery) return say("exhausted", "recovery_failed");
  if (hostRecoveryRequested(input.db, input.runId)) return say("exhausted", "recovery_already_requested");
  if (!input.nothingActed) return say(input.queueResends ? "checking" : "uncertain", "effects_uncertain");
  if (ownerSpokeAfter(input.db, input.chatId, input.userMessageId, input.startedAtIso)) return say("newer", "owner_wrote_newer");
  if (!input.replayable) return say("manual", "request_not_replayable");
  return { verdict, action: "recover", plan: "recovering", line: internalFailureOwnerLine(input.locale, "recovering"), defect: true, reason: "nothing_acted" };
}

/** The typed defect row for us: the code stays in the ledger, never on the owner's screen. */
export function recordHarnessDefect(input: { runId: string; chatId: string; code: string | null; reason: string; plan: string;
  terminalKind: string; delivery: string; hostRecovery: boolean; exceptionClass?: string; detail?: string }): void {
  try {
    recordRunEvent({ runId: input.runId, chatId: input.chatId, kind: HARNESS_DEFECT, sourceEventId: `harness-defect:${input.runId}`,
      payload: { schemaVersion: 1, code: input.code ?? "untyped", classification: "internal", reason: input.reason, plan: input.plan,
        terminalKind: input.terminalKind, delivery: input.delivery, hostRecovery: input.hostRecovery,
        ...(input.exceptionClass ? { exceptionClass: input.exceptionClass } : {}), ...(input.detail ? { detail: input.detail } : {}) } });
  } catch { /* the defect row is evidence; its absence never changes what the owner is told */ }
}

/** At-most-once across restarts and processes: only the first caller for a run gets true. */
export function claimHostRecovery(runId: string, chatId: string, originalUserMessageId: string | null): boolean {
  const db = getDb();
  return db.transaction(() => {
    if (hostRecoveryRequested(db, runId)) return false;
    recordRunEvent({ runId, chatId, kind: HOST_RECOVERY_REQUESTED, sourceEventId: "host-recovery:1",
      payload: { schemaVersion: 1, ordinal: 1, userMessageId: originalUserMessageId } });
    return true;
  }).immediate();
}

export function recordHostRecoveryLink(recoveryRunId: string, chatId: string, originalRunId: string): void {
  recordRunEvent({ runId: recoveryRunId, chatId, kind: HOST_RECOVERY_LINK, sourceEventId: "host-recovery-link",
    payload: { schemaVersion: 1, originalRunId, ordinal: 1 } });
}

export function recordHostRecoveryOutcome(originalRunId: string, chatId: string, outcome: "completed" | "failed" | "skipped", reason: string): void {
  try {
    recordRunEvent({ runId: originalRunId, chatId, kind: HOST_RECOVERY_OUTCOME, sourceEventId: "host-recovery-outcome",
      payload: { schemaVersion: 1, outcome, reason } });
  } catch { /* ledger convenience only */ }
}

export interface HostRecoveryPorts {
  /** A fresh ordinary start of this request in the host that ran the failed turn. Throws the start refusal unchanged. */
  start(request: HostRecoveryRequest): { runId: string };
  chatBusy(chatId: string): boolean;
  /** The owner has a message waiting for this chat that is not in the transcript yet (the in-memory steer queue, a pending admission). */
  ownerPending?(chatId: string): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  /** A plain line to the owner (assistant row); never carries a code. */
  say(chatId: string, plan: InternalFailurePlan): void;
  log(message: string, detail?: unknown): void;
}

/**
 * Starts the one recovery turn once the failed turn has released its chat. The durable marker was claimed at the failure
 * (claimHostRecovery), so a restart or a second process can never start it twice; a quit between the claim and the start leaves
 * a claimed row with no link, which sweepOrphanedHostRecoveries answers with the plain line at the next boot. Waits (bounded) for
 * the chat; re-checks, at the start instant, that the owner has not written something newer or pressed Stop. A start the host
 * refuses as "not ready yet" waits and tries again; any other refusal ends in the plain line.
 */
export function scheduleHostRecovery(ports: HostRecoveryPorts, job: {
  originalRunId: string; chatId: string; request: McpInvocationRequest; userMessageId: string | null; startedAtIso: string;
}): void {
  let attempt = 0;
  const finish = (outcome: "failed" | "skipped", plan: InternalFailurePlan, reason: string): void => {
    recordHostRecoveryOutcome(job.originalRunId, job.chatId, outcome, reason);
    ports.say(job.chatId, plan);
  };
  const retryLater = (reason: string): boolean => {
    if (attempt >= HOST_RECOVERY_START_ATTEMPTS) { finish("failed", "manual", reason); return false; }
    ports.setTimer(tick, Math.min(15_000, 250 * 2 ** Math.min(attempt, 6)));
    return true;
  };
  const tick = (): void => {
    attempt += 1;
    try {
      if (ownerSpokeAfter(getDb(), job.chatId, job.userMessageId, job.startedAtIso)) { finish("skipped", "newer", "owner_wrote_newer"); return; }
      if (ports.ownerPending?.(job.chatId)) { finish("skipped", "newer", "owner_message_waiting"); return; }
      if (ports.chatBusy(job.chatId)) { retryLater("chat_stayed_busy"); return; }
      const marker: HostRecoveryMarker = { ofRunId: job.originalRunId, userMessageId: job.userMessageId, ordinal: 1 };
      const request = hostRecoveryRequestFor(job.request, marker);
      let started: { runId: string };
      try { started = ports.start(request); }
      catch (error) {
        const transient = isTransientSendRefusal(error);
        ports.log("host recovery start refused", { runId: job.originalRunId, transient });
        if (transient) { retryLater("recovery_start_refused"); return; }
        finish("failed", "manual", "recovery_start_refused");
        return;
      }
      try { recordHostRecoveryLink(started.runId, job.chatId, job.originalRunId); } catch (error) { ports.log("host recovery link not written", error); }
    } catch (error) {
      ports.log("host recovery tick failed", error);
      finish("failed", "manual", "recovery_tick_failed");
    }
  };
  ports.setTimer(tick, 150);
}

/**
 * Boot sweep: a claim whose recovery never started (the app quit in between) must not leave the owner with a line that promises a
 * retry that no longer comes. Claimed rows younger than a day, with no link and no outcome, and older than two minutes (a live recovery of another process starts within seconds), get the plain line and an outcome row.
 */
export function sweepOrphanedHostRecoveries(db: Db, say: (chatId: string, plan: InternalFailurePlan, originalRunId: string) => void, nowMs = Date.now()): number {
  let settled = 0;
  try {
    const since = new Date(nowMs - 24 * 3_600_000).toISOString();
    const rows = db.prepare(`SELECT run_id AS runId, chat_id AS chatId FROM run_events r WHERE kind = ? AND ts > ? AND ts < ?
      AND NOT EXISTS (SELECT 1 FROM run_events l WHERE l.kind = ? AND json_extract(l.payload_json, '$.originalRunId') = r.run_id)
      AND NOT EXISTS (SELECT 1 FROM run_events o WHERE o.run_id = r.run_id AND o.kind = ?)`)
      .all(HOST_RECOVERY_REQUESTED, since, new Date(nowMs - 120_000).toISOString(), HOST_RECOVERY_LINK, HOST_RECOVERY_OUTCOME) as Array<{ runId: string; chatId: string | null }>;
    for (const row of rows) {
      if (!row.chatId) continue;
      recordHostRecoveryOutcome(row.runId, row.chatId, "failed", "app_quit_before_recovery_started");
      try { say(row.chatId, "manual", row.runId); settled += 1; } catch { /* the outcome row stays */ }
    }
  } catch { /* a store that cannot be read is swept at the next boot */ }
  return settled;
}
