import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import {
  classifyOwnerFailureDetailed, internalFailureOwnerLine, waitingOwnerLine, WAITABLE_EXTERNAL_CAUSES,
  type InternalFailurePlan, type OwnerFailureFacts, type OwnerFailureVerdict,
} from "../../shared/owner-failure-class";
import { quotaRetryAfterAt } from "../../shared/runtime-quota";
import { lastRuntimeSignalKind, onRuntimeSignal, runtimeSignalFloor, watchConnection } from "../runtime/runtime-signals";
import { isTransientSendRefusal } from "../../shared/transient-send-refusal";
import { recordRunEvent } from "../store/run-events";
import { getDb } from "../store/db";
import type { InvocationWorkspaceBinding } from "./workspace-binding";
import type { InvocationExecutionContext } from "../mcp/client";
import { bindIdleRetrySignals, registerIdleRetry, type IdleRetryHandle, type IdleRetrySignals } from "./idle-retry";

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
 * An OUTSIDE cause that clears by itself (a usage limit, a sign-in, no connection, a provider outage) is not shown as "send it again"
 * either, when nothing acted and the request can be replayed: the same claim keeps the request and a `wait` record (below), and the
 * request starts again when the cause changes, never on a counter: a runtime signal (runtime/runtime-signals.ts), the time the provider
 * stated for a limit to lift, or, with neither, a timed check on HOST_RECOVERY_CHECK_LADDER_MS (2 h, 4 h, 8 h, then every 24 h). An outside
 * cause never ends the checks. Only a failure inside the app, the same one coming back after a timed check with no signal in between,
 * stops the timed checks (signal-only), because only a code defect repeats without anything outside changing.
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
/** A recovery that waits for a busy chat looks again when the chat frees (idle-retry.ts signals) and, without a signal, this often. It never gives up by count. */
export const HOST_RECOVERY_FALLBACK_MS = 15_000;

type Db = { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown } };

export function hostRecoveryOf(request: McpInvocationRequest | null | undefined): HostRecoveryMarker | null {
  const marker = (request as HostRecoveryRequest | null | undefined)?.hostRecovery;
  return marker && typeof marker.ofRunId === "string" ? marker : null;
}

/** The request a recovery turn starts: the original words and choices, none of the one-use or Goal-episode state. */
export function hostRecoveryRequestFor(original: McpInvocationRequest, marker: HostRecoveryMarker): HostRecoveryRequest {
  const {
    runId: _runId, steeringMode: _steeringMode, preflightSubmissionId: _preflight, oneMemoryUseOnceRef: _memory,
    oneBriefingActionRef: _briefing, activeGoalId: _goal, earlierAttemptUncertain: _earlier, earlierAttemptVerify: _earlierVerify, ...rest
  } = original as McpInvocationRequest & { activeGoalId?: unknown; earlierAttemptUncertain?: unknown; earlierAttemptVerify?: unknown };
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
  /** For a recovery turn: the run it stands for (its claim says whether a restart may try once more). */
  recoveryOfRunId?: string | null;
  /** The typed not-dispatched proof, or the effect tracker's proof that no tool acted. */
  nothingActed: boolean;
  replayable: boolean;
  userMessageId: string | null;
  startedAtIso: string;
  /** An active Goal in this room carries the work on by itself (queued, running, waiting). */
  goalCarries: boolean;
  /**
   * The turn is the host's own wake of this room's Goal (promptOrigin "system", the chat is bound to a Goal). Its failure is the
   * Goal's, and the owner reads one plain line for it (the Goal carries the work on), never silence: a Goal whose wake died inside
   * the app otherwise looked stuck (the failure was logged as a defect row and nothing else).
   */
  goalWake?: boolean;
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

/**
 * With no signal and no stated time, a kept request for an OUTSIDE cause is checked on this ladder: the first check after 2 h, and each
 * time the same failure comes back after a check with no signal in between, the next one is later (4 h, 8 h, then every 24 h). No count
 * ends it: no source reports that a limit of unknown length lifted or that a provider outage is over, so a request must never wait forever.
 */
export const HOST_RECOVERY_CHECK_LADDER_MS: readonly number[] = [2 * 3_600_000, 4 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];
export const HOST_RECOVERY_BACKSTOP_MS = HOST_RECOVERY_CHECK_LADDER_MS[0]!;
/** One waiter starts at most once per this when signals keep releasing it (a local model server that goes up and down). */
export const HOST_RECOVERY_SIGNAL_SPACING_MS = 5 * 60_000;
/** The same check for a failure inside the app, whose cause no runtime signal describes. */
export const HOST_RECOVERY_INTERNAL_BACKSTOP_MS = 10 * 60_000;
/** A stated time further out than the keeping time of the claim is not waited for (the restart data is gone by then). */
const HOST_RECOVERY_MAX_WAIT_MS = 6.5 * 24 * 3_600_000; // HOST_RECOVERY_KEEP_DAYS (7) less half a day

/** What one tried runtime said when it stopped the request (client.ts hands these over at the end of the recovery walk). */
export interface RuntimeWaitFact { runtime: string; kind: string; /** The time the provider stated for it to work again (ms), or null. */ until: number | null }

/**
 * Why a kept request waits and what ends the wait, stored on the claim row itself (`$.wait`; no table or column of its own).
 * The wait ends at the first of: a runtime signal newer than `floor`, `until` (a time the provider stated), `probeAt` (the one timed check
 * when nothing was stated), or an app restart for a wait that has no stated time still ahead. `release` is what ended the last wait, so a
 * failure that comes back after a timed check ("backstop") with the same `fp` is told apart from one that came after a real change.
 */
export interface HostRecoveryWait {
  v: 1;
  /** An ExternalFailureCause, or "internal" for a failure inside the app. */
  cause: string;
  /** The failure's fingerprint: cause, the runtimes and kinds that stopped it, and the stated time (to the minute). */
  fp: string;
  until: number | null;
  probeAt: number | null;
  /** The runtime signal time when the wait began: a newer one releases it. */
  floor: number;
  armedAt: number;
  release?: "signal" | "time" | "boot" | "backstop";
  /** How many timed checks of this same failure already found it unchanged (the position on HOST_RECOVERY_CHECK_LADDER_MS). */
  checks?: number;
  /** A failure inside the app only: the timed checks are over (the same failure came back after one with no signal); only a signal or a restart continues it. */
  signalOnly?: true;
}

const waitFactsByRun = new Map<string, RuntimeWaitFact[]>();
const WAIT_FACTS_CAP = 64;
/** client.ts, at the end of the recovery walk: what each tried runtime said. Read by decideOwnerFailure for the same run. */
export function noteRuntimeWaitFacts(runId: string, facts: readonly RuntimeWaitFact[]): void {
  if (!runId || !facts.length) return;
  waitFactsByRun.delete(runId);
  waitFactsByRun.set(runId, facts.slice(0, 16).map((fact) => ({ runtime: String(fact.runtime).slice(0, 40), kind: String(fact.kind).slice(0, 24),
    until: typeof fact.until === "number" && Number.isFinite(fact.until) ? fact.until : null })));
  while (waitFactsByRun.size > WAIT_FACTS_CAP) { const oldest = waitFactsByRun.keys().next().value as string | undefined; if (oldest === undefined) break; waitFactsByRun.delete(oldest); }
}
/** The wait decideOwnerFailure just decided for a run, kept until claimHostRecovery writes it onto the claim in the same transaction. */
const waitToClaim = new Map<string, HostRecoveryWait>();

const minuteOf = (ms: number | null): number | null => (ms === null ? null : Math.floor(ms / 60_000));

/** The wait for an outside cause, from what the failed turn and the tried runtimes reported. */
function externalWaitFor(input: OwnerFailureInput, cause: string, prior: HostRecoveryWait | null, now = Date.now()): HostRecoveryWait {
  const facts = waitFactsByRun.get(input.runId) ?? [];
  const stated: number[] = [];
  for (const fact of facts) if (fact.until !== null && fact.until > now) stated.push(fact.until);
  const own = quotaRetryAfterAt(input.facts.runtimeFailure?.retryAfterAt);
  if (own && Date.parse(own) > now) stated.push(Date.parse(own));
  const until = stated.length ? Math.min(Math.min(...stated), now + HOST_RECOVERY_MAX_WAIT_MS) : null;
  const tried = facts.map((fact) => `${fact.runtime}:${fact.kind}`).sort();
  const own2 = input.facts.runtimeFailure ? [`${input.facts.runtimeFailure.kind}`] : [];
  const fp = sha256Of(JSON.stringify([cause, tried.length ? tried : own2, minuteOf(until)]));
  // The same failure back after a timed check with no signal in between is checked later next time (the ladder); a new situation starts over.
  const sameFailure = Boolean(prior && prior.fp === fp);
  const checks = sameFailure ? (prior!.checks ?? 0) + (prior!.release === "backstop" ? 1 : 0) : 0;
  // A signal that arrived while the failed attempt was running (a sign-in the owner finished meanwhile) already counts: the wait's floor is
  // the start of that attempt, not the moment the failure was decided.
  const startedMs = Date.parse(input.startedAtIso);
  const floor = Number.isFinite(startedMs) ? Math.min(runtimeSignalFloor(now), startedMs) : runtimeSignalFloor(now);
  return { v: 1, cause, fp, until, floor, armedAt: now, checks,
    probeAt: until !== null ? null : now + HOST_RECOVERY_CHECK_LADDER_MS[Math.min(checks, HOST_RECOVERY_CHECK_LADDER_MS.length - 1)]! };
}

/** The wait for a failure inside the app that the host retried and that failed again with nothing sent. */
function internalWaitFor(fp: string, prior: HostRecoveryWait | null, now = Date.now()): HostRecoveryWait {
  const signalOnly = Boolean(prior && prior.cause === "internal" && prior.fp === fp && prior.release === "backstop");
  return { v: 1, cause: "internal", fp, until: null, floor: runtimeSignalFloor(now), armedAt: now,
    probeAt: signalOnly ? null : now + HOST_RECOVERY_INTERNAL_BACKSTOP_MS, ...(signalOnly ? { signalOnly: true as const } : {}) };
}

/** The fingerprint of a recovery that failed inside the app: its machine code and the app version (a new version is a new situation). */
export function internalRecoveryFingerprint(code: string | null | undefined, version = hostAppVersion()): string {
  return sha256Of(JSON.stringify(["internal", code ?? "untyped", version]));
}

/**
 * What releases a wait right now, or null while it holds. A runtime signal wins over a time; a restart releases a wait that has no stated
 * time still ahead (a stated time ahead is still waited for); the timed check is the last resort.
 */
export function waitRelease(wait: HostRecoveryWait, now: number, signalFloor: number, resumedAtBoot: boolean): HostRecoveryWait["release"] | null {
  if (signalFloor > wait.floor) return "signal";
  if (wait.until !== null) return now >= wait.until ? "time" : null;
  if (resumedAtBoot) return "boot";
  if (wait.probeAt !== null && now >= wait.probeAt) return "backstop";
  return null;
}

/** When the idle-retry timer of a waiting recovery looks: once, at the moment the wait is due; rarely when only a signal can release it. */
function waitFallbackMs(wait: HostRecoveryWait | null, now = Date.now()): number {
  if (!wait) return HOST_RECOVERY_FALLBACK_MS;
  const next = wait.until ?? wait.probeAt;
  // One timer to the moment the wait is due (a signal wakes it earlier); a wait only a signal can release looks rarely.
  if (next === null) return 60 * 60_000;
  return Math.max(next - now + 1_000, 5_000);
}

export function hostRecoveryWaitOf(db: Db, originalRunId: string): HostRecoveryWait | null {
  try {
    const row = db.prepare("SELECT json_extract(payload_json, '$.wait') AS wait FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(originalRunId, HOST_RECOVERY_REQUESTED) as { wait?: unknown } | undefined;
    if (typeof row?.wait !== "string") return null;
    const wait = JSON.parse(row.wait) as HostRecoveryWait;
    return wait && wait.v === 1 && typeof wait.fp === "string" ? wait : null;
  } catch { return null; }
}

/** Writes the wait of the claim (idempotent), and the run that armed it so the settlement can tell a re-wait from an app failure. */
function writeWait(db: Db, originalRunId: string, wait: HostRecoveryWait, armedByRunId: string | null): void {
  try {
    db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.wait', json(?), '$.waitedBy', ?) WHERE run_id = ? AND kind = ?")
      .run(JSON.stringify(wait), armedByRunId, originalRunId, HOST_RECOVERY_REQUESTED);
  } catch { /* the claim keeps its earlier wait; the timed check of that wait still ends it */ }
}

export function decideOwnerFailure(input: OwnerFailureInput): OwnerFailureDecision {
  const verdict = classifyOwnerFailureDetailed(input.facts);
  if (verdict.klass === "external") {
    const waiting = decideExternalWait(input, verdict);
    return waiting ?? { verdict, action: "external", defect: false, reason: `external:${verdict.cause}` };
  }
  // An active Goal in this room carries the work on at its next turn: the line says that instead of asking the owner to resend.
  const say = (plan: InternalFailurePlan, reason: string): OwnerFailureDecision => {
    const worded: InternalFailurePlan = input.goalCarries && input.ownerTurn && (plan === "uncertain" || plan === "exhausted" || plan === "repeated" || plan === "manual" || plan === "checking") ? "goal" : plan;
    return { verdict, action: "say", plan: worded, line: internalFailureOwnerLine(input.locale, worded), defect: true, reason };
  };
  if (!input.ownerTurn) return say(input.goalWake && input.goalCarries ? "goal" : "background", input.goalWake && input.goalCarries ? "goal_wake_failed" : "not_owner_turn");
  if (input.queueOwnsRetry && !input.hostRecovery) return { verdict, action: "queue", plan: "recovering", line: internalFailureOwnerLine(input.locale, "recovering"), defect: true, reason: "queue_retries" };
  if (input.hostRecovery) {
    // The retry may itself have acted: then nothing runs again by itself. Nothing acted: the claim kept the request, and it is tried
    // once more when something changed (a runtime signal, a restart, an update) or after one timed check. The same failure coming back
    // after that timed check with no signal in between ends the timed checks (settlement parks it as signal-only).
    if (!input.nothingActed) return say("uncertain", "recovery_effects_uncertain");
    const claim = input.recoveryOfRunId ? hostRecoveryClaimState(input.db, input.recoveryOfRunId) : null;
    if (!claim?.hasReplay) return say("manual", "recovery_failed_no_replay");
    return say(hostRecoveryRepeatsWithoutSignal(claim, internalRecoveryFingerprint(input.facts.code)) ? "repeated" : "exhausted", "recovery_failed");
  }
  // This run's own claim exists: another process is already handling it.
  if (hostRecoveryRequested(input.db, input.runId)) return say("recovering", "recovery_already_requested");
  if (!input.nothingActed) return say(input.queueResends ? "checking" : "uncertain", "effects_uncertain");
  if (ownerSpokeAfter(input.db, input.chatId, input.userMessageId, input.startedAtIso)) return say("newer", "owner_wrote_newer");
  if (!input.replayable) return say("manual", "request_not_replayable");
  return { verdict, action: "recover", plan: "recovering", line: internalFailureOwnerLine(input.locale, "recovering"), defect: true, reason: "nothing_acted" };
}

/**
 * An outside cause that clears by itself, for a request the host can start again: the request is kept and continues when the cause
 * changes, instead of the owner being told to send it again. Null (the existing honest message stands) when the cause is not one that
 * clears by itself (a provider's refusal, an empty answer, the owner's own stop or wait, a site's human check), when the owner already
 * wrote something newer, something may have run, the request cannot be replayed, a Goal carries the work, the send queue owns the retry,
 * or another process already handles this run.
 */
function decideExternalWait(input: OwnerFailureInput, verdict: OwnerFailureVerdict): OwnerFailureDecision | null {
  const cause = verdict.cause;
  if (!cause || !WAITABLE_EXTERNAL_CAUSES.has(cause)) return null;
  if (!input.ownerTurn || input.goalCarries || !input.nothingActed || !input.replayable) return null;
  const waiting = (plan: InternalFailurePlan, wait: HostRecoveryWait, action: "recover" | "say", reason: string): OwnerFailureDecision => ({
    verdict, action, plan, defect: false, reason,
    line: waitingOwnerLine(input.locale, cause, wait.until !== null ? new Date(wait.until).toISOString() : null),
  });
  if (input.hostRecovery) {
    // The retry stopped for an outside cause again: the same claim waits once more (its own wait says whether a timed check already failed).
    const claim = input.recoveryOfRunId ? hostRecoveryClaimState(input.db, input.recoveryOfRunId) : null;
    if (!claim?.hasReplay || !input.recoveryOfRunId) return null;
    if (ownerSpokeAfter(input.db, input.chatId, input.userMessageId, input.startedAtIso)) return null;
    const wait = externalWaitFor(input, cause, claim.wait);
    writeWait(input.db, input.recoveryOfRunId, wait, input.runId);
    return waiting("waiting", wait, "say", `wait_again:${cause}`);
  }
  if (input.queueOwnsRetry || hostRecoveryRequested(input.db, input.runId)) return null;
  if (ownerSpokeAfter(input.db, input.chatId, input.userMessageId, input.startedAtIso)) return null;
  const wait = externalWaitFor(input, cause, null);
  waitToClaim.set(input.runId, wait);
  while (waitToClaim.size > WAIT_FACTS_CAP) { const oldest = waitToClaim.keys().next().value as string | undefined; if (oldest === undefined) break; waitToClaim.delete(oldest); }
  return waiting("waiting", wait, "recover", `wait:${cause}`);
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

/**
 * What a restarted app needs to start the recovery again, stored on the claim row itself (the same run_events row, written in the
 * same transaction as the claim; no table or column of its own). The words are not copied: when the transcript row of the owner's
 * message holds the same text, only its hash is kept and the text is read back from that row; images are the saved attachment
 * rows (id + hash). Only what the transcript cannot give back is stored (a differing prompt text, the request's own small
 * settings). The row lives until the recovery closes (an outcome row: dropHostRecoveryReplay) and is emptied at the next boot
 * sweep once the claim is HOST_RECOVERY_KEEP_DAYS old, so it is never kept longer than the claim is actionable. A retry that failed
 * inside the app with nothing sent keeps it (parkHostRecovery): the next app start or update tries once more.
 */
export interface HostRecoveryReplay {
  v: 1;
  request: Record<string, unknown>;
  prompt: { sha256: string; text?: string };
  authored?: { sha256: string; text?: string };
  images?: Array<{ id: string; name?: string; mediaType: string; size: number; sha256: string }>;
  locale: "ko" | "en";
  startedAtIso: string;
  workspaceBinding?: InvocationWorkspaceBinding;
  executionContext?: Record<string, unknown>;
}
/** The stored recovery request stays under this size, or the claim carries none (the boot sweep then says the plain line, as before). */
export const HOST_RECOVERY_REPLAY_MAX_BYTES = 16_384;
/** Keys of an execution context that are plain data and survive a restart; any other key (a minted capability object) makes the turn unreplayable. */
const REPLAYABLE_CONTEXT_KEYS: ReadonlySet<string> = new Set(["source", "commonWorkRecovery", "surfaceConversation", "surfaceContext"]);

/** Request fields the host recomputes at every start and ignores when they arrive on the request (see invocation/service.ts, the untrusted-context strip). */
const HOST_REBUILT_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "oneProfileContext", "oneMachineTurnContext", "oneTeamExecutionPolicy", "oneTeamRuntimeBinding", "oneTeamStaffingAuthority",
  "oneParticipantExecutionSnapshot", "oneAttachmentContext", "oneAttachmentRedactions", "attachmentCapabilitySummary",
]);

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

export function buildHostRecoveryReplay(db: Db, input: {
  request: McpInvocationRequest; userMessageId: string | null; startedAtIso: string; locale: "ko" | "en";
  workspaceBinding?: InvocationWorkspaceBinding; executionContext?: InvocationExecutionContext;
}): HostRecoveryReplay | null {
  try {
    const { request } = input;
    if (!requestIsReplayable(request) || typeof request.userPrompt !== "string") return null;
    const stored = input.userMessageId
      ? db.prepare("SELECT text FROM chat_messages WHERE id = ? AND chat_id = ?").get(input.userMessageId, request.chatId) as { text?: unknown } | undefined
      : undefined;
    const messageText = typeof stored?.text === "string" ? stored.text : null;
    const textRef = (text: string): { sha256: string; text?: string } => ({ sha256: sha256Of(text), ...(messageText === text ? {} : { text }) });
    const { userPrompt, oneUserAuthoredPrompt, images, runId: _runId, ...restWithHostContext } = request as McpInvocationRequest & Record<string, unknown>;
    // What the host rebuilds at every start (invocation/service.ts drops these from an incoming request before it prepares the turn) is not
    // stored: it would only make a long profile or attachment summary push an otherwise plain request over the size cap.
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(restWithHostContext)) if (!HOST_REBUILT_REQUEST_KEYS.has(key)) rest[key] = value;
    let imageRefs: HostRecoveryReplay["images"];
    if (images && images.length > 0) {
      if (!input.userMessageId) return null;
      const rows = db.prepare("SELECT id, media_type, size_bytes, sha256 FROM chat_message_attachments WHERE message_id = ? AND chat_id = ? ORDER BY rowid")
        .all(input.userMessageId, request.chatId) as Array<{ id: string; media_type: string; size_bytes: number; sha256: string }>;
      if (rows.length !== images.length) return null;
      imageRefs = [];
      for (let i = 0; i < images.length; i += 1) {
        const bytes = Buffer.from(images[i]!.data, "base64");
        const row = rows[i]!;
        if (row.media_type !== images[i]!.mediaType || row.size_bytes !== bytes.length || row.sha256 !== createHash("sha256").update(bytes).digest("hex")) return null;
        imageRefs.push({ id: row.id, ...(images[i]!.name !== undefined ? { name: images[i]!.name } : {}), mediaType: row.media_type, size: row.size_bytes, sha256: row.sha256 });
      }
    }
    let executionContext: Record<string, unknown> | undefined;
    if (input.executionContext) {
      if (Object.keys(input.executionContext).some((key) => !REPLAYABLE_CONTEXT_KEYS.has(key))) return null;
      executionContext = JSON.parse(JSON.stringify(input.executionContext)) as Record<string, unknown>;
    }
    const replay: HostRecoveryReplay = {
      v: 1, request: JSON.parse(JSON.stringify(rest)) as Record<string, unknown>, prompt: textRef(userPrompt),
      ...(typeof oneUserAuthoredPrompt === "string" ? { authored: textRef(oneUserAuthoredPrompt) } : {}),
      ...(imageRefs ? { images: imageRefs } : {}), locale: input.locale, startedAtIso: input.startedAtIso,
      ...(input.workspaceBinding ? { workspaceBinding: JSON.parse(JSON.stringify(input.workspaceBinding)) as InvocationWorkspaceBinding } : {}),
      ...(executionContext ? { executionContext } : {}),
    };
    return Buffer.byteLength(JSON.stringify(replay)) <= HOST_RECOVERY_REPLAY_MAX_BYTES ? replay : null;
  } catch { return null; }
}

/** The job the claim describes, read back after a restart. Never throws. */
export type RestoredHostRecovery =
  | { kind: "job"; job: HostRecoveryJob }
  | { kind: "skip"; reason: string }
  | { kind: "unreplayable"; reason: string };

export interface HostRecoveryJob {
  originalRunId: string; chatId: string; request: McpInvocationRequest; userMessageId: string | null; startedAtIso: string;
  locale: "ko" | "en"; workspaceBinding?: InvocationWorkspaceBinding; executionContext?: InvocationExecutionContext;
  /** Rebuilt by the boot sweep of a restarted app: a restart releases a wait that has no stated time still ahead. */
  resumedAtBoot?: boolean;
}

export function restoreHostRecoveryJob(db: Db, row: { runId: string; chatId: string; payloadJson: string }): RestoredHostRecovery {
  try {
    const payload = JSON.parse(row.payloadJson) as { userMessageId?: unknown; replay?: HostRecoveryReplay };
    const replay = payload.replay;
    if (!replay || replay.v !== 1 || typeof replay.request !== "object" || replay.request === null) return { kind: "unreplayable", reason: "no_replay_stored" };
    if (!db.prepare("SELECT 1 FROM chats WHERE id = ?").get(row.chatId)) return { kind: "skip", reason: "chat_gone" };
    const userMessageId = typeof payload.userMessageId === "string" ? payload.userMessageId : null;
    let messageText: string | null = null;
    if (userMessageId) {
      const stored = db.prepare("SELECT text FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user'").get(userMessageId, row.chatId) as { text?: unknown } | undefined;
      // The owner removed the message the retry was meant to answer: nothing is started for words they took back.
      if (!stored || typeof stored.text !== "string") return { kind: "skip", reason: "original_message_gone" };
      messageText = stored.text;
    }
    const wordsOf = (ref: { sha256: string; text?: string } | undefined): string | null => {
      if (!ref) return null;
      const text = ref.text ?? messageText;
      return typeof text === "string" && sha256Of(text) === ref.sha256 ? text : null;
    };
    const userPrompt = wordsOf(replay.prompt);
    if (userPrompt === null) return { kind: "unreplayable", reason: "prompt_changed" };
    const request: Record<string, unknown> = { ...replay.request, chatId: row.chatId, userPrompt };
    if (replay.authored) {
      const authored = wordsOf(replay.authored);
      if (authored === null) return { kind: "unreplayable", reason: "prompt_changed" };
      request.oneUserAuthoredPrompt = authored;
    }
    if (replay.images && replay.images.length > 0) {
      const images: Array<{ mediaType: string; name?: string; data: string }> = [];
      for (const ref of replay.images) {
        const saved = db.prepare("SELECT media_type, size_bytes, sha256, data FROM chat_message_attachments WHERE id = ? AND chat_id = ?").get(ref.id, row.chatId) as
          { media_type: string; size_bytes: number; sha256: string; data: unknown } | undefined;
        if (!saved || !(saved.data instanceof Uint8Array)) return { kind: "unreplayable", reason: "attachment_gone" };
        const bytes = Buffer.from(saved.data.buffer, saved.data.byteOffset, saved.data.byteLength);
        if (saved.media_type !== ref.mediaType || bytes.length !== ref.size || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) return { kind: "unreplayable", reason: "attachment_changed" };
        images.push({ ...(ref.name !== undefined ? { name: ref.name } : {}), mediaType: ref.mediaType, data: bytes.toString("base64") });
      }
      request.images = images;
    }
    return { kind: "job", job: {
      originalRunId: row.runId, chatId: row.chatId, request: request as unknown as McpInvocationRequest, userMessageId,
      startedAtIso: replay.startedAtIso, locale: replay.locale === "ko" ? "ko" : "en",
      ...(replay.workspaceBinding ? { workspaceBinding: replay.workspaceBinding } : {}),
      ...(replay.executionContext ? { executionContext: replay.executionContext as unknown as InvocationExecutionContext } : {}),
    } };
  } catch { return { kind: "unreplayable", reason: "replay_unreadable" }; }
}

/** At-most-once across restarts and processes: only the first caller for a run gets true. The restart data rides on the same row. */
export function claimHostRecovery(runId: string, chatId: string, originalUserMessageId: string | null, replay?: HostRecoveryReplay | null): boolean {
  const db = getDb();
  const write = (withReplay: boolean): boolean => db.transaction(() => {
    if (hostRecoveryRequested(db, runId)) return false;
    const written = recordRunEvent({ runId, chatId, kind: HOST_RECOVERY_REQUESTED, sourceEventId: "host-recovery:1",
      payload: { schemaVersion: 1, ordinal: 1, userMessageId: originalUserMessageId } });
    // The ledger writer shortens and flattens payload values (a diagnostic limit), so the exact restart data is set on the very
    // row it just wrote, inside the same transaction.
    if (withReplay && replay) {
      db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.replay', json(?)) WHERE id = ?").run(JSON.stringify(replay), written.id);
    }
    // The wait decided for this run (an outside cause that clears by itself) rides on the same row, in the same transaction.
    const wait = waitToClaim.get(runId);
    if (wait) db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.wait', json(?)) WHERE id = ?").run(JSON.stringify(wait), written.id);
    return true;
  }).immediate();
  try {
    if (!replay) return write(false);
    // A store that cannot take the larger row (disk nearly full) still takes the claim itself: the retry then lives in memory only.
    try { return write(true); } catch { return write(false); }
  } finally { waitToClaim.delete(runId); }
}

/** The restart data is only needed while the recovery is open: empty it once the recovery closed. Best effort. */
export function dropHostRecoveryReplay(originalRunId: string): void {
  try {
    getDb().prepare("UPDATE run_events SET payload_json = json_remove(payload_json, '$.replay') WHERE run_id = ? AND kind = ? AND json_type(payload_json, '$.replay') IS NOT NULL")
      .run(originalRunId, HOST_RECOVERY_REQUESTED);
  } catch { /* the sweep empties it at a day old */ }
}

/** A recovery is over once an outcome row exists for the original run (the link row of a started one is found through the start claim). */
export function hostRecoveryClosed(db: Db, originalRunId: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(originalRunId, HOST_RECOVERY_OUTCOME)); }
  catch { return false; }
}

/** The version of the running app, read where Desktop Main and the background service both have it. */
export function hostAppVersion(): string {
  try {
    const electron = require("electron") as { app?: { getVersion?: () => string } };
    const version = electron.app?.getVersion?.();
    if (typeof version === "string" && version) return version;
  } catch { /* not under Electron */ }
  return process.env.AGENTLAS_DESKTOP_VERSION || "unknown";
}
/** A kept recovery stays actionable this long (the restart data is emptied after it). */
export const HOST_RECOVERY_KEEP_DAYS = 7;

/** `attemptVersion` / `attemptCount` are a diagnostic of how often each app version tried this claim; nothing is decided by them any more. */
export interface HostRecoveryClaimState { hasReplay: boolean; parked: boolean; attemptVersion: string | null; attemptCount: number; wait: HostRecoveryWait | null }
export function hostRecoveryClaimState(db: Db, originalRunId: string): HostRecoveryClaimState | null {
  try {
    const row = db.prepare(`SELECT json_type(payload_json, '$.replay') AS replayType, json_extract(payload_json, '$.parked') AS parked,
      json_extract(payload_json, '$.attemptVersion') AS version, json_extract(payload_json, '$.attemptCount') AS count
      FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1`).get(originalRunId, HOST_RECOVERY_REQUESTED) as
      { replayType: string | null; parked: number | null; version: string | null; count: number | null } | undefined;
    if (!row) return null;
    return { hasReplay: row.replayType === "object", parked: row.parked === 1, attemptVersion: typeof row.version === "string" ? row.version : null,
      attemptCount: typeof row.count === "number" ? row.count : 0, wait: hostRecoveryWaitOf(db, originalRunId) };
  } catch { return null; }
}
/**
 * The same failure came back after the timed check with no signal in between: nothing changed since, so another timed check would only
 * spend a provider call on the same answer. Signals and restarts still continue it (the settlement parks it as signal-only).
 */
export function hostRecoveryRepeatsWithoutSignal(claim: HostRecoveryClaimState, fp: string): boolean {
  return claim.wait !== null && claim.wait.cause === "internal" && claim.wait.fp === fp && claim.wait.release === "backstop";
}
/**
 * The recovery run failed with nothing sent and its claim should stay open: either the typed defect row says it failed inside the app
 * (decideOwnerFailure reason recovery_failed), or the decision armed a fresh wait on the claim for this very run (an outside cause again).
 */
export function hostRecoveryFailedParkable(db: Db, recoveryRunId: string): boolean {
  try {
    if (db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.reason') = 'recovery_failed' LIMIT 1").get(recoveryRunId, HARNESS_DEFECT)) return true;
    const original = hostRecoveryOriginalOf(db, recoveryRunId);
    return Boolean(original && db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.waitedBy') = ? LIMIT 1").get(original, HOST_RECOVERY_REQUESTED, recoveryRunId));
  } catch { return false; }
}

/** The machine code the failed recovery run's defect row recorded, for its fingerprint. */
function recoveryRunFailureCode(db: Db, originalRunId: string): string | null {
  try {
    const start = db.prepare("SELECT json_extract(payload_json, '$.recoveryRunId') AS rid FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      .get(originalRunId, HOST_RECOVERY_START) as { rid?: unknown } | undefined;
    if (typeof start?.rid !== "string") return null;
    const defect = db.prepare("SELECT json_extract(payload_json, '$.code') AS code FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      .get(start.rid, HARNESS_DEFECT) as { code?: unknown } | undefined;
    return typeof defect?.code === "string" && defect.code !== "untyped" ? defect.code : null;
  } catch { return null; }
}

/** Which runs this process already waits for (so the in-process resume after a park never schedules a second waiter for the same claim). */
const scheduledRecoveries = new Set<string>();
/** The start port of this process, taken from its boot sweep: the same one the sweep uses, so a parked claim resumes without a restart. */
let resumeParkedPort: ((job: HostRecoveryJob) => void) | null = null;
/** The start port of this process for a kept recovery that is scheduled again in-process (the boot sweep sets it too). */
export function setHostRecoveryResumePort(port: ((job: HostRecoveryJob) => void) | null): void { resumeParkedPort = port; }

/**
 * The recovery failed with nothing sent: keep its restart data and wait again. An outside cause was armed by the decision itself (the claim
 * already holds the new wait); a failure inside the app waits for a runtime signal, a restart, or one timed check, and the same failure
 * coming back after that timed check with no signal in between makes the wait signal-only. Then the waiter is scheduled again in this
 * process (no restart needed). False: nothing to keep (no restart data).
 */
export function parkHostRecovery(originalRunId: string): boolean {
  try {
    const db = getDb();
    const claim = hostRecoveryClaimState(db, originalRunId);
    if (!claim?.hasReplay) return false;
    const armedNow = (() => {
      const start = db.prepare("SELECT json_extract(payload_json, '$.recoveryRunId') AS rid FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
        .get(originalRunId, HOST_RECOVERY_START) as { rid?: unknown } | undefined;
      const by = db.prepare("SELECT json_extract(payload_json, '$.waitedBy') AS by FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1")
        .get(originalRunId, HOST_RECOVERY_REQUESTED) as { by?: unknown } | undefined;
      return typeof start?.rid === "string" && by?.by === start.rid;
    })();
    if (!armedNow) {
      const wait = internalWaitFor(internalRecoveryFingerprint(recoveryRunFailureCode(db, originalRunId)), claim.wait);
      writeWait(db, originalRunId, wait, null);
    }
    const moved = db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.parked', 1) WHERE run_id = ? AND kind = ? AND json_type(payload_json, '$.replay') = 'object'")
      .run(originalRunId, HOST_RECOVERY_REQUESTED) as { changes?: number };
    if ((moved.changes ?? 0) === 0) return false;
    const port = resumeParkedPort;
    if (port && !scheduledRecoveries.has(originalRunId)) {
      queueMicrotask(() => {
        try {
          if (scheduledRecoveries.has(originalRunId) || hostRecoveryClosed(db, originalRunId)) return;
          const row = db.prepare("SELECT run_id AS runId, chat_id AS chatId, payload_json AS payloadJson FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1")
            .get(originalRunId, HOST_RECOVERY_REQUESTED) as { runId: string; chatId: string | null; payloadJson: string } | undefined;
          if (!row?.chatId) return;
          const restored = restoreHostRecoveryJob(db, { runId: row.runId, chatId: row.chatId, payloadJson: row.payloadJson });
          if (restored.kind === "job") port(restored.job);
        } catch { /* the next boot sweep resumes it */ }
      });
    }
    return true;
  } catch { return false; }
}

export const HOST_RECOVERY_START = "host_recovery_start";
/** A start claimed this recently counts as live even before the started run has written anything. */
export const HOST_RECOVERY_START_LIVE_MS = 120_000;

/**
 * The right to start the recovery run, taken before the start so the app that woke up again and the other process of the same
 * store (Desktop Main and the background service both sweep at boot) cannot both start it. False: another start is live or its run
 * exists. A claim whose run never appeared and that is older than a start takes (its process died in between) is replaced.
 */
export function claimHostRecoveryStart(originalRunId: string, chatId: string, recoveryRunId: string, nowMs = Date.now(), release?: HostRecoveryWait["release"]): boolean {
  const db = getDb();
  return db.transaction(() => {
    const prior = db.prepare("SELECT ts, json_extract(payload_json, '$.recoveryRunId') AS rid, json_extract(payload_json, '$.released') AS released FROM run_events WHERE run_id = ? AND kind = ?")
      .all(originalRunId, HOST_RECOVERY_START) as Array<{ ts: string; rid: string | null; released: number | null }>;
    // A parked recovery's earlier attempts are over (each failed inside the app with nothing sent): only a start taken after it was parked counts.
    const parked = db.prepare("SELECT json_extract(payload_json, '$.parked') AS parked FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(originalRunId, HOST_RECOVERY_REQUESTED) as { parked?: number | null } | undefined;
    for (const claim of parked?.parked === 1 ? [] : prior) {
      if (claim.released) continue;
      const age = nowMs - Date.parse(claim.ts);
      if (!(age >= HOST_RECOVERY_START_LIVE_MS)) return false;
      if (claim.rid && db.prepare("SELECT 1 FROM run_events WHERE run_id = ? LIMIT 1").get(claim.rid)) return false;
    }
    recordRunEvent({ runId: originalRunId, chatId, kind: HOST_RECOVERY_START, sourceEventId: `host-recovery-start:${recoveryRunId}`,
      payload: { schemaVersion: 1, recoveryRunId } });
    // The attempt is counted per app version on the claim itself, and the recovery is no longer parked while it runs.
    const version = hostAppVersion();
    db.prepare(`UPDATE run_events SET payload_json = json_set(payload_json, '$.parked', 0, '$.attemptVersion', ?,
      '$.attemptCount', CASE WHEN json_extract(payload_json, '$.attemptVersion') = ? THEN COALESCE(json_extract(payload_json, '$.attemptCount'), 0) + 1 ELSE 1 END)
      WHERE run_id = ? AND kind = ?`).run(version, version, originalRunId, HOST_RECOVERY_REQUESTED);
    // What ended the wait goes on the claim with the start that won, so a failure that comes back can be told from a changed situation.
    if (release) db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.wait.release', ?) WHERE run_id = ? AND kind = ? AND json_type(payload_json, '$.wait') = 'object'")
      .run(release, originalRunId, HOST_RECOVERY_REQUESTED);
    return true;
  }).immediate();
}

/** The start was refused as "not ready yet": the next wake may claim again. */
export function releaseHostRecoveryStart(originalRunId: string, recoveryRunId: string): void {
  try {
    const db = getDb();
    db.transaction(() => {
      const released = db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.released', 1) WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.recoveryRunId') = ? AND json_extract(payload_json, '$.released') IS NULL")
        .run(originalRunId, HOST_RECOVERY_START, recoveryRunId) as { changes?: number };
      // A start the host refused never ran: it does not count as an attempt of this version.
      if ((released.changes ?? 0) > 0) {
        db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.attemptCount', MAX(COALESCE(json_extract(payload_json, '$.attemptCount'), 1) - 1, 0)) WHERE run_id = ? AND kind = ?")
          .run(originalRunId, HOST_RECOVERY_REQUESTED);
      }
    })();
  } catch { /* a stale claim is replaced after a start's time */ }
}

export function recordHostRecoveryLink(recoveryRunId: string, chatId: string, originalRunId: string): void {
  recordRunEvent({ runId: recoveryRunId, chatId, kind: HOST_RECOVERY_LINK, sourceEventId: "host-recovery-link",
    payload: { schemaVersion: 1, originalRunId, ordinal: 1 } });
}

export function recordHostRecoveryOutcome(originalRunId: string, chatId: string, outcome: "completed" | "failed" | "skipped", reason: string): void {
  try {
    recordRunEvent({ runId: originalRunId, chatId, kind: HOST_RECOVERY_OUTCOME, sourceEventId: "host-recovery-outcome",
      payload: { schemaVersion: 1, outcome, reason } });
    dropHostRecoveryReplay(originalRunId);
  } catch { /* ledger convenience only */ }
}

export interface HostRecoveryPorts {
  /** A fresh ordinary start of this request in the host that ran the failed turn. Throws the start refusal unchanged. */
  start(request: HostRecoveryRequest): { runId: string };
  chatBusy(chatId: string): boolean;
  /** The owner has a message waiting for this chat that is not in the transcript yet (the in-memory steer queue, a pending admission). */
  ownerPending?(chatId: string): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  /** The service's run-end / active-chat / steer-capacity signals (idle-retry.ts). Without them the fallback timer alone wakes a waiting recovery. */
  signals?: IdleRetrySignals;
  /** A plain line to the owner (assistant row); never carries a code. */
  say(chatId: string, plan: InternalFailurePlan): void;
  log(message: string, detail?: unknown): void;
}

/**
 * Starts the one recovery turn once the failed turn has released its chat. The durable marker was claimed at the failure
 * (claimHostRecovery), so a restart or a second process can never start it twice; a quit between the claim and the start leaves
 * a claimed row with no link, which sweepOrphanedHostRecoveries answers with the plain line at the next boot. A busy chat is
 * waited for without a count: the chat leaving its turn (idle-retry.ts) wakes it, a slow fallback covers the other process.
 * Every wake re-checks that the owner has not written something newer, has nothing waiting and did not press Stop, so a
 * recovery that starts long after the failure never covers the owner's newer work (it closes as skipped instead). A start the
 * host refuses as "not ready yet" waits for the next wake; any other refusal ends in the plain line.
 */
export function scheduleHostRecovery(ports: HostRecoveryPorts, job: {
  originalRunId: string; chatId: string; request: McpInvocationRequest; userMessageId: string | null; startedAtIso: string; resumedAtBoot?: boolean;
}): void {
  // The closures below keep only these small values, never `job` itself (the caller's object may hold image bytes).
  const { originalRunId, chatId, userMessageId, startedAtIso } = job;
  const resumedAtBoot = job.resumedAtBoot === true;
  let done = false;
  let handle: IdleRetryHandle | null = null;
  let stopSignals: (() => void) | null = null;
  let stopConnection: (() => void) | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  scheduledRecoveries.add(originalRunId);
  const close = (): void => {
    done = true; handle?.dispose(); stopSignals?.(); stopConnection?.();
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null; stopSignals = null; stopConnection = null; scheduledRecoveries.delete(originalRunId);
  };
  // A request that waits for an outside cause to clear (a `wait` on its claim) is rebuilt from the claim when the wait ends (the transcript
  // row, the saved attachments), so this waiter holds no request object while it waits. A request the claim cannot give back (its
  // attachments changed, the restart data is missing) stays held here, because this process is then the only place it lives.
  const wait0 = hostRecoveryWaitOf(getDb(), originalRunId);
  let heldRequest: McpInvocationRequest | null = job.request;
  if (wait0) {
    try {
      const claimRow = getDb().prepare("SELECT payload_json AS payloadJson FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(originalRunId, HOST_RECOVERY_REQUESTED) as { payloadJson: string } | undefined;
      if (claimRow && restoreHostRecoveryJob(getDb(), { runId: originalRunId, chatId, payloadJson: claimRow.payloadJson }).kind === "job") heldRequest = null;
    } catch { /* kept in memory */ }
  }
  const finish = (outcome: "failed" | "skipped", plan: InternalFailurePlan, reason: string): void => {
    close();
    recordHostRecoveryOutcome(originalRunId, chatId, outcome, reason);
    // The owner moved on while the request waited for an outside cause: nothing to say (the waiting line already said a newer message comes first).
    if (wait0 && wait0.cause !== "internal" && outcome === "skipped") return;
    ports.say(chatId, plan);
  };
  const tick = (): void => {
    if (done) return;
    try {
      // Another process (or an earlier life of this one) already closed this recovery: nothing is said twice.
      if (hostRecoveryClosed(getDb(), originalRunId)) { close(); return; }
      if (ownerSpokeAfter(getDb(), chatId, userMessageId, startedAtIso)) { finish("skipped", "newer", "owner_wrote_newer"); return; }
      if (ports.ownerPending?.(chatId)) { finish("skipped", "newer", "owner_message_waiting"); return; }
      if (ports.chatBusy(chatId)) return; // the chat leaving its turn wakes this again; nothing is counted
      // A kept request starts only when what stopped it changed: a runtime signal, the time the provider stated, a restart, or a timed
      // check. Until then no model is called and nothing is counted.
      const wait = hostRecoveryWaitOf(getDb(), originalRunId);
      let release: HostRecoveryWait["release"] | null = null;
      if (wait) {
        release = waitRelease(wait, Date.now(), runtimeSignalFloor(), resumedAtBoot);
        if (!release) return;
        // A runtime that keeps appearing and disappearing ("detected", a local model server going up and down) releases one waiter at most once
        // per spacing window; a finished sign-in or a returned connection is never held.
        if (release === "signal" && lastRuntimeSignalKind() === "detected") {
          const lastStart = getDb().prepare("SELECT ts FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1").get(originalRunId, HOST_RECOVERY_START) as { ts?: string } | undefined;
          const since = lastStart?.ts ? Date.now() - Date.parse(lastStart.ts) : Number.POSITIVE_INFINITY;
          if (since >= 0 && since < HOST_RECOVERY_SIGNAL_SPACING_MS) {
            if (!holdTimer) {
              holdTimer = setTimeout(() => { holdTimer = null; handle?.wakeAll(); }, HOST_RECOVERY_SIGNAL_SPACING_MS - since + 100);
              holdTimer.unref?.();
            }
            return;
          }
        }
      }
      let request = heldRequest;
      if (wait) {
        const claimRow = getDb().prepare("SELECT payload_json AS payloadJson FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(originalRunId, HOST_RECOVERY_REQUESTED) as { payloadJson: string } | undefined;
        const restored = claimRow ? restoreHostRecoveryJob(getDb(), { runId: originalRunId, chatId, payloadJson: claimRow.payloadJson }) : null;
        if (restored?.kind === "skip") { finish("skipped", "newer", restored.reason); return; }
        if (restored?.kind === "job") request = restored.job.request;
      }
      if (!request) { finish("failed", "manual", "recovery_request_unavailable"); return; }
      const marker: HostRecoveryMarker = { ofRunId: originalRunId, userMessageId, ordinal: 1 };
      const recoveryRequest = hostRecoveryRequestFor(request, marker);
      let started: { runId: string };
      // At most one start across restarts and processes: the one that did not get the claim leaves the recovery to the other.
      const recoveryRunId = recoveryRequest.runId as string;
      if (!claimHostRecoveryStart(originalRunId, chatId, recoveryRunId, Date.now(), release ?? undefined)) { close(); return; }
      try { started = ports.start(recoveryRequest); }
      catch (error) {
        const transient = isTransientSendRefusal(error);
        ports.log("host recovery start refused", { runId: originalRunId, transient });
        releaseHostRecoveryStart(originalRunId, recoveryRunId);
        if (transient) return; // not ready yet: the next wake tries again
        finish("failed", "manual", "recovery_start_refused");
        return;
      }
      close();
      try { recordHostRecoveryLink(started.runId, chatId, originalRunId); } catch (error) { ports.log("host recovery link not written", error); }
    } catch (error) {
      ports.log("host recovery tick failed", error);
      finish("failed", "manual", "recovery_tick_failed");
    }
  };
  handle = registerIdleRetry({ name: `host-recovery:${originalRunId}`, pendingChats: () => (done ? [] : [chatId]), retry: tick, fallbackMs: waitFallbackMs(wait0) });
  if (ports.signals) bindIdleRetrySignals(ports.signals);
  if (wait0) {
    // A runtime signal wakes this waiter at once (the other process's signals arrive through the stored floor at the next look).
    stopSignals = onRuntimeSignal(() => handle?.wakeAll());
    if (wait0.cause === "network" || wait0.cause === "provider_outage") stopConnection = watchConnection();
  }
  ports.setTimer(tick, 150);
}

/**
 * Boot sweep: a claim whose recovery never finished (the app quit in between, or the retry failed inside the app) must not leave
 * the owner's request closed. Claims without an outcome:
 *  - that kept their restart data (buildHostRecoveryReplay): rebuilt and scheduled again through scheduleHostRecovery (`resume`).
 *    Which ones: a claim that never started its retry (a day, or up to HOST_RECOVERY_KEEP_DAYS when it carries a `wait`), and a parked
 *    one (its retry failed with nothing sent). How often one is tried is not counted here: its `wait` decides (a signal, a stated time, a
 *    restart, one timed check; scheduleHostRecovery). A claim whose retry started and has no outcome is left alone (that turn may have acted). The owner's newer words, a removed message
 *    or a started run are re-checked there. A removed message or chat closes it as skipped without a line;
 *  - without restart data (older rows, a request that cannot be rebuilt), younger than a day and older than two minutes (a live
 *    recovery of another process starts within seconds): the plain line and an outcome row, as before.
 */
export function sweepOrphanedHostRecoveries(db: Db, say: (chatId: string, plan: InternalFailurePlan, originalRunId: string) => void, nowMs = Date.now(),
  resume?: (job: HostRecoveryJob) => void, _version = hostAppVersion()): number {
  let settled = 0;
  // The start port of this process: a recovery parked later (its retry failed with nothing sent) is scheduled again through it, no restart needed.
  if (resume) resumeParkedPort = resume;
  try {
    const keepSince = new Date(nowMs - HOST_RECOVERY_KEEP_DAYS * 24 * 3_600_000).toISOString();
    const daySince = new Date(nowMs - 24 * 3_600_000).toISOString();
    const liveBefore = new Date(nowMs - 120_000).toISOString();
    const rows = db.prepare(`SELECT run_id AS runId, chat_id AS chatId, ts, payload_json AS payloadJson,
        EXISTS (SELECT 1 FROM run_events l WHERE l.kind = ? AND json_extract(l.payload_json, '$.originalRunId') = r.run_id) AS linked
      FROM run_events r WHERE kind = ? AND ts > ? AND NOT EXISTS (SELECT 1 FROM run_events o WHERE o.run_id = r.run_id AND o.kind = ?) ORDER BY ts`)
      .all(HOST_RECOVERY_LINK, HOST_RECOVERY_REQUESTED, keepSince, HOST_RECOVERY_OUTCOME) as Array<{ runId: string; chatId: string | null; ts: string; payloadJson: string; linked: number }>;
    for (const row of rows) {
      if (!row.chatId) continue;
      const restored = restoreHostRecoveryJob(db, { runId: row.runId, chatId: row.chatId, payloadJson: row.payloadJson });
      if (restored.kind === "skip") { recordHostRecoveryOutcome(row.runId, row.chatId, "skipped", restored.reason); continue; }
      if (restored.kind === "job") {
        const claim = JSON.parse(row.payloadJson) as { parked?: unknown; wait?: unknown };
        const parked = claim.parked === 1;
        // A retry that started and left no result may have acted: only a parked one (it failed with nothing sent) or one never started goes again.
        if (row.linked && !parked) continue;
        // A claim waiting for an outside cause keeps its request for the whole keeping time, not one day: the wait is its own clock.
        if (!row.linked && row.ts <= daySince && !parked && !(claim.wait && typeof claim.wait === "object")) continue;
        if (resume) {
          try { resume({ ...restored.job, resumedAtBoot: true }); settled += 1; continue; } catch { /* the plain line below, only for a claim that never started */ }
        }
        if (row.linked) continue;
      }
      // Without restart data (or one that cannot be rebuilt): the plain line, only within the day and past a live start's time.
      if (row.linked || row.ts <= daySince || row.ts >= liveBefore) continue;
      recordHostRecoveryOutcome(row.runId, row.chatId, "failed", "app_quit_before_recovery_started");
      try { say(row.chatId, "interrupted", row.runId); settled += 1; } catch { /* the outcome row stays */ }
    }
    // A claim past its keeping time is no longer actionable: its restart data goes (the claim row itself stays as the at-most-once marker).
    // The owner was told the request would continue by itself, so the end of that is closed with an outcome row and one plain line.
    const expired = db.prepare(`SELECT run_id AS runId, chat_id AS chatId FROM run_events r WHERE kind = ? AND ts < ? AND json_type(payload_json, '$.replay') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM run_events o WHERE o.run_id = r.run_id AND o.kind = ?)`).all(HOST_RECOVERY_REQUESTED, keepSince, HOST_RECOVERY_OUTCOME) as Array<{ runId: string; chatId: string | null }>;
    for (const row of expired) {
      if (!row.chatId) continue;
      recordHostRecoveryOutcome(row.runId, row.chatId, "skipped", "kept_too_long");
      try { say(row.chatId, "expired", row.runId); settled += 1; } catch { /* the outcome row stays */ }
    }
    db.prepare("UPDATE run_events SET payload_json = json_remove(payload_json, '$.replay') WHERE kind = ? AND ts < ? AND json_type(payload_json, '$.replay') IS NOT NULL")
      .run(HOST_RECOVERY_REQUESTED, keepSince);
  } catch { /* a store that cannot be read is swept at the next boot */ }
  return settled;
}
