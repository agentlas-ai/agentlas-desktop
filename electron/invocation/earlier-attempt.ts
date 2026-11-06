import type { InvocationRunReceipt, McpInvocationRequest } from "../../shared/types";
import { isNonFailureInvocationStop } from "../../shared/invocation-host-stop";

/**
 * An owner message whose first send ended with its outcome unknown (the run died or vanished before the runtime confirmed it took
 * the turn) is sent once more, with one line telling the model so. Decision: a step or message of unknown outcome
 * never stops to ask; the risk of doing something twice is accepted, and the model is told so it can check first.
 *
 * Main-only: a marker the send queue sets on the request it starts again. The renderer's own requests never carry it
 * (ipc.ts rendererInvocationRequest strips it), and it is declared here, not on the shared request type, so the app-control
 * catalog does not offer it to anyone.
 */
export type EarlierAttemptRequest = McpInvocationRequest & { earlierAttemptUncertain?: true };

/** The one line the model reads (client.ts declares it as the turn-context slot `attempt.earlier`). */
export const EARLIER_ATTEMPT_LINE =
  "earlier attempt: this same message was started before and its outcome is unknown; read the conversation and the results so far first, then do only what remains and repeat nothing already done";

export function withEarlierAttempt<T extends McpInvocationRequest>(request: T): T & { earlierAttemptUncertain: true } {
  return { ...request, earlierAttemptUncertain: true };
}

export function hasEarlierAttempt(request: McpInvocationRequest | null | undefined): boolean {
  return !!request && (request as EarlierAttemptRequest).earlierAttemptUncertain === true;
}

/**
 * The queue sends a message whose effect is unknown again at most this many times. A second unknown outcome closes the row by itself,
 * as a separate end reason ("effect could not be confirmed"), never as a delivery that was given up: a tool may already have run,
 * and a second send could run the same external action twice. Only a run with NO receipt (it never started, so nothing ran) is
 * sent again without this cap (unconfirmedResendIsUnbounded).
 */
export const UNCONFIRMED_MAX_RESENDS = 1;

/** A run that left no receipt never began: nothing ran, so sending the message again cannot repeat an effect and has no cap. */
export function unconfirmedResendIsUnbounded(receipt: unknown): boolean {
  return !receipt;
}

/** The terminal code of a dispatched turn that ended without a terminal receipt (runtime/runner.ts RUNTIME_TURN_UNSETTLED_CODE). */
const UNSETTLED_TURN_CODE = "runtime_turn_unsettled";

/**
 * Whether the run that took an owner's message and ended without proof that the runtime placed the turn should be sent once more.
 * Decided from the run's own receipt, never from prose:
 *  - no receipt at all: the run never began, nothing ran: send again;
 *  - interrupted with no stated cause (the runner vanished, the process died): send again;
 *  - failed by the app's own unexpected exception (receipt.hostInternalFailure: a TypeError, a SQLite driver error, a syscall error, told by
 *    class and never by words) with no provider failure beside it: the exception may have come after the turn was dispatched, so the effect
 *    is unknown and it is the same case; only an UNCONFIRMED placement reaches this rule (a turn proven in the conversation is not lost);
 *  - failed as an UNSETTLED turn (the turn was dispatched and ended without its completion receipt, after the host's one same-session
 *    continuation) with no cause from the provider (`runtimeFailure.cause`: quota, rate limit, login, a refusal or an empty reply are
 * outside causes the provider named and wait for their own remedy): the effect is unknown, which is the same case (decision
 *E2): send again with the earlier-attempt line;
 *  - the owner's Stop (cancelled), a steering interrupt (the owner's newer direction is the turn now), a host stop (the app
 *    closed or updated: a quit is the owner's act and an update is resumed by the update ledger) and a Goal pause or delete:
 *    never. Stop always wins;
 *  - any other failed run: it showed its own failure to the owner; this is not the place to start it again;
 *  - a run a later turn of the chat has taken over (`supersededByRunId`): the owner moved on.
 */
export function unconfirmedRunShouldBeSentAgain(
  receipt: Pick<InvocationRunReceipt, "status" | "interruptionCause" | "hostStopCause" | "supersededByRunId" | "errorCode" | "runtimeFailure" | "hostInternalFailure"> | null | undefined,
): boolean {
  if (!receipt) return true;
  if (isNonFailureInvocationStop(receipt)) return false;
  if (receipt.supersededByRunId) return false;
  if (receipt.status === "interrupted") return true;
  if (receipt.status !== "failed" || receipt.interruptionCause === "steering") return false;
  // Failed with no outside cause named, so the effect is unknown: an unfinished turn, or the app's own unexpected exception after the
  // turn was dispatched (the exception's class rides on the receipt, hostInternalFailure; a provider's own failure never does).
  return (receipt.errorCode === UNSETTLED_TURN_CODE && !receipt.runtimeFailure?.cause)
    || (receipt.hostInternalFailure === true && !receipt.runtimeFailure);
}

/** meta key of the owner's last Stop on a chat (value: ISO time). Written by the owner's own Stop entries only (recordOwnerStop). */
const OWNER_STOP_MARKER_PREFIX = "owner-stop:";

/**
 * The owner pressed Stop on this chat: a durable marker the send queue reads. The run ledger's cancel event is written only once a run is
 * live; a Stop of a run still being prepared (its admission is closed, no ledger row is written) used to leave nothing, so the start that
 * failed because of that Stop looked like any transient refusal and was queued again (regression review 2, N7). Never throws into the Stop.
 */
export function recordOwnerStop(db: { prepare(sql: string): { run(...params: unknown[]): unknown } }, chatId: string, nowMs: number = Date.now()): void {
  try { db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(`${OWNER_STOP_MARKER_PREFIX}${chatId}`, new Date(nowMs).toISOString()); }
  catch { /* the Stop never waits on its marker */ }
}

/**
 * Whether the owner pressed Stop on this chat after `sinceMs`: the run ledger holds an `invoke_cancel_requested` event for the chat
 * (idx_run_events_chat_kind_ts), or the owner's Stop entry left its marker (recordOwnerStop). A steering interrupt records the same event with
 * reason "steering" and is not a Stop. A ledger that cannot be read throws; the caller treats that as "no Stop" so the message is not lost.
 */
export function ownerStoppedChatSince(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  chatId: string,
  sinceMs: number,
): boolean {
  const since = new Date(sinceMs).toISOString();
  const rows = db.prepare("SELECT payload_json FROM run_events WHERE chat_id = ? AND kind = 'invoke_cancel_requested' AND ts > ? ORDER BY ts DESC LIMIT 20")
    .all(chatId, since) as Array<{ payload_json: string | null }>;
  if (rows.some((row) => {
    try { return (JSON.parse(row.payload_json ?? "{}") as { reason?: unknown }).reason !== "steering"; } catch { return true; }
  })) return true;
  try {
    const marks = db.prepare("SELECT value FROM meta WHERE key = ?").all(`${OWNER_STOP_MARKER_PREFIX}${chatId}`) as Array<{ value: string }>;
    // >=: a Stop in the same millisecond as the attempt began is not ordered before it (ISO times carry milliseconds); Stop wins the tie.
    return marks.some((mark) => typeof mark.value === "string" && mark.value >= since);
  } catch { return false; }
}
