/**
 * Which refusals of an owner's message are TRANSIENT: nothing is wrong, the chat (or the channel to the process that
 * runs it) is simply not ready yet. The owner typed something; the message is accepted, shown once, and run as soon as
 * the chat is free. A transient refusal must never reach the screen as text, a red color, a card or a synthetic reply.
 * Main owns the retry; the renderer only reads this to know it does not have to react.
 *
 * Production 1.2.96, 2026-10-11 10:21-10:23Z (room "Yotube", chat 8f3e09ee): every code below was thrown to the
 * renderer within two minutes of a daemon-owned run settling, and each became a red banner, a "pending reception" card
 * or a synthetic assistant message.
 *
 * Codes are matched exactly (or by the one documented prefix). Localized prose is never inspected.
 */

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  // The previous turn of this chat has not settled yet.
  "runtime_turn_unsettled",
  // A follow-up started from a settling run once inherited that run's source (see withoutOnePersonalNativeOriginal).
  "ordinary_one_turn_source_changed",
  "invocation_cleanup_pending",
  // Main could not confirm the personal One domain owner (the daemon holds it). The answer is kept and retried.
  "supervisor_owner_unconfirmed",
  "invocation_admission_chat_pending",
  "invocation_steer_parent_pending",
  "chat_invocation_active",
  "science-turn-already-active",
  "science-steering-target-stale",
  // Another run of this same process holds the chat's lease: a graph agent node or a doctor run on that chat (W5). It is
  // busy, not broken; the start waits for the release like invocation_chat_busy (store/invocation-run-owners.ts).
  "invocation_chat_owned_by_other_run",
  // Text addressed to a run that has just ended, or to the process that no longer owns it.
  "invocation_steer_stale_run",
  "invocation_steer_native_turn_required",
  "native_gui_text_input_context_changed",
  "native_gui_text_input_requires_new_preparation",
  "native_gui_original_text_parent_required",
  "native_gui_original_text_context_required",
  "native_gui_observed_text_parent_required",
  "native_gui_daemon_run_not_active",
  "native_gui_attach_superseded",
  "native_gui_admission_not_fresh",
  // The channel between the app window and the background service is reconnecting.
  "native_gui_original_channel_unavailable",
  "native_gui_enrolled_channel_required",
  "native_gui_public_original_channel_required",
  "native_gui_daemon_discovery_unavailable",
  "native_gui_capacity_reached",
  // The background service lost (or had not yet enrolled) its signed checkpoint channel to the app window mid-start.
  // Its start refusal now keeps this innermost code instead of the generic runtime_turn_unsettled (docs 31 W1).
  "native_auth_channel_lost",
  "native_auth_checkpoint_busy",
  "native_auth_checkpoint_unenrolled",
  // The ledger row the native ingress writes for any refusal before start. The real cause is not in it.
  "native_ingress_rejected_before_start",
  // No-dead-end sweep 2026-10-25: each of these was a "not ready yet" that ended the owner's message for good ("This
  // message could not run. Check the model connection ..."). All are refused before anything reaches a model.
  // The app is quitting or installing an update: the queued message survives the restart and starts after it.
  "desktop_execution_admission_closed",
  // The owner's own Stop is still settling (pausing/cancelling): the message starts once the Stop has finished.
  "goal_stop_in_progress",
  // The background service channel is attaching or re-enrolling (same situation as native_gui_original_channel_unavailable).
  "native_gui_activation_prerequisites_missing",
  "native_invocation_host_not_ready",
  "native_invocation_runtime_busy",
  "daemon_shutting_down",
  // Text addressed to a run that ended (or moved process) between the window's read and the send; it was not recorded
  // (thrown before the intake row), so it goes as the next message. native_owner_text_binding_changed is NOT listed: it
  // can mean the same intent is already recorded, and re-sending it would deliver it twice.
  "native_owner_text_parent_unavailable",
  "native_owner_text_context_unavailable",
  "invocation_current_turn_unavailable",
  "invocation_owner_unavailable",
  // Another renderer is still preparing a send. Main's durable queued parent waits for that preparation slot.
  "one_preflight_chat_pending",
  // The parent's admission was no longer pending when its preparation slot was reserved (the app began closing, or a Stop closed the admission
  // in between). The refusal closed that admission and held the submission before anything started, and the queue's start rebinds the held
  // submission (resumeQueuedOnePreflightSubmission), so the owner's message waits instead of coming back as "send it again".
  "one_preflight_parent_not_pending",
  // Capacity is backpressure before intake, so the owner's text can wait in the durable send queue.
  "invocation_steer_queue_full",
  "invocation_current_turn_steer_limit",
  // The One supervisor lives in the background service and its channel is gone or still handing over (daemon restart,
  // update, crash; a failed adopt leaves mode 'handoff'). Both are thrown before anything is dispatched
  // (one/supervisor-native-runtime.ts callOneSupervisorRuntime / oneSupervisorEndpoint). supervisor_native_channel_changed
  // is NOT listed: it is thrown after the dispatch, so the command may already be recorded.
  "supervisor_native_channel_unavailable",
  "supervisor_runtime_handoff_pending",
]);

/**
 * The transient run failures that are a fault of the app's own host rather than an occupied chat: they do not clear by waiting for
 * another conversation to end. No model turn was sent, but a failed attempt is not free: it is a run with about a dozen ledger rows, and the
 * tool-selection judge may run for it. So the queue keeps the message and starts it again, with the wait growing after
 * UNDISPATCHED_START_MAX_ATTEMPTS (startRetryBackoffMs: 1, 5, then 10 minutes, ended at once by a runtime signal or a sign-in), only when the
 * run's own mcp_config_failure event names a reason in MCP_CONFIG_HOST_NOT_READY_CODES (hostNotReadyRunCause); any other cause keeps the
 * bounded tries and is held for host-recovery. At the old cap the owner hears one calm line; the failure line is written once, not per cycle.
 */
const HOST_NOT_READY_RUN_FAILURE_CODES: ReadonlySet<string> = new Set([
  // The run's tool table could not be built after the in-run waits (mcp/config-build-retry.ts): the app's own host was not ready.
  // Thrown before any model call with turnDelivery "not-dispatched"; the message is started again after a backoff.
  "mcp-runtime-config-unavailable",
  // The Goal moved while the run's tool table was being prepared and a new selection chose different tools (mcp/client.ts settleGoalScope),
  // so the table built for the old Goal is not this Goal's. Thrown before any model call with turnDelivery "not-dispatched": the message
  // is started again and selects its tools under the Goal as it now is.
  "mcp-goal-tool-scope-changed",
]);

/**
 * Run failures the owner (or something outside the app) must clear: the chat's working folder is missing, is not a folder, or cannot be
 * opened (runtime/runner.ts spawnStartFailureRefusal). Refused before dispatch like the others, but nothing the app does by itself changes
 * them, so the queue neither retries them as the app's own state nor gives them the one legacy start-again, and no line promises that it will.
 */
const OWNER_FIXABLE_RUN_FAILURE_CODES: ReadonlySet<string> = new Set(["project_folder_missing", "project_folder_not_directory", "project_folder_unreadable"]);
export function isOwnerFixableRunFailureCode(code: string | null | undefined): boolean {
  return !!code && OWNER_FIXABLE_RUN_FAILURE_CODES.has(code);
}

export function isHostNotReadyRunFailureCode(code: string | null | undefined): boolean {
  return !!code && HOST_NOT_READY_RUN_FAILURE_CODES.has(code);
}

/**
 * A run that was admitted and then refused BEFORE anything reached a model (turnDelivery "not-dispatched") for one of
 * these reasons is not finished: the chat or its shared session is simply occupied. The send queue starts the message
 * again with backoff instead of ending it after one retry (pending-chat-sends.ts). Matched exactly.
 */
const TRANSIENT_RUN_FAILURE_CODES: ReadonlySet<string> = new Set([
  // Another chat of the same Work project holds the project's single provider process (runtime/project-residency.ts).
  "work_project_residency_busy",
  // The shared seat session is taken by a turn of another conversation (runtime/agent-context-turn-order.ts).
  "agent_context_turn_parked",
  "agent_context_turn_holder_stuck",
  "agent_context_turn_wait_expired",
  // The session scope could not be read right now (a busy or locked store; runtime/agent-context-admission.ts).
  "session_scope_unavailable",
  // SQLite stayed locked before dispatch (mcp/client.ts).
  "store_busy",
  // The launch circuit breaker is open for this runtime and closes by itself after a minute; it launched nothing
  // (runtime/invocation-breaker.ts).
  "runtime_invocation_storm",
  // The runtime's saved address or ACP profile changed between picking the runner and entering it: the next start picks it up afresh
  // (runtime/selection.ts configurationCurrent).
  "runtime_selected_configuration_changed",
  // Every resident seat of the budget is held by a running turn or an awake daemon seat (runtime/agent-residency.ts). The
  // runners continue one-shot; a refusal that still reaches the queue frees up as those turns end.
  "agent_residency_capacity",
  // The CLI process could not be created for lack of descriptors, processes or memory (EMFILE/ENFILE/EAGAIN/ENOMEM):
  // nothing was sent, and the shortage clears by itself (runtime/runner.ts spawnStartFailureRefusal).
  "runtime_spawn_resource_busy",
  ...HOST_NOT_READY_RUN_FAILURE_CODES,
]);

export function isTransientRunFailureCode(code: string | null | undefined): boolean {
  return !!code && (TRANSIENT_RUN_FAILURE_CODES.has(code) || isTransientSendRefusalCode(code));
}

/** `invocation_chat_busy`, `invocation_chat_busy_other_host`, and any later suffix of the same family. */
const TRANSIENT_PREFIXES: readonly string[] = ["invocation_chat_busy"];

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const IPC_PREFIX_RE = /\[agentlas:code=([A-Za-z][A-Za-z0-9_.:-]{0,95})\]/;

export function isTransientSendRefusalCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return TRANSIENT_CODES.has(code) || TRANSIENT_PREFIXES.some((prefix) => code === prefix || code.startsWith(`${prefix}_`));
}

/** Machine code of a thrown value: own `.code`, the IPC marker, or a message that is itself the code. */
export function sendRefusalCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const own = (error as { code?: unknown }).code;
    if (typeof own === "string" && CODE_RE.test(own)) return own;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  const marked = IPC_PREFIX_RE.exec(message)?.[1];
  if (marked) return marked;
  const bare = message.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "").trim();
  if (CODE_RE.test(bare)) return bare;
  // "code: sentence" and "code (detail)" are how a few producers append context to the code.
  return /^([a-z][a-z0-9_]{2,95})(?::\s|\s\()/.exec(bare)?.[1];
}

/** The better-sqlite3 lock family; the same set shared/turn-settlement.ts types as `store_busy`. */
const SQLITE_STORE_BUSY_RE = /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)?$|^SQLITE_PROTOCOL$/;

/**
 * A start the host refused BEFORE anything reached a runtime (InvocationService.start marks the thrown error
 * `turnDelivery: "not-dispatched"`) because the shared store stayed locked past its own 15 s busy wait. The driver's raw
 * `SQLITE_BUSY` error carries no transient code, so the owner's message was held as a hard refusal and never started again
 * (production Z: supersedeGoalWaitForInvocation threw `database is locked` inside start). A lock is not a verdict
 * on the message: it waits and starts again like every other "not ready yet" refusal. Only a provably undispatched start qualifies;
 * a lock after dispatch is the run's own settlement and never reaches this check.
 */
export function isStoreBusyRefusedBeforeDispatch(error: unknown): boolean {
  if (!error || typeof error !== "object" || (error as { turnDelivery?: unknown }).turnDelivery !== "not-dispatched") return false;
  return isStoreBusyError(error);
}

/**
 * Start refusals the owner can act on. Each has its own sentence on screen (renderer/lib/invocation-failure.ts
 * goalAdmissionControlFailureForCode) or a custody rule of its own (queued-owner-input-custody.ts), so waiting for them
 * would hide what the owner has to do. Everything else a start refuses before dispatch is the app's own state.
 */
const OWNER_ACTION_REFUSAL_PREFIXES: readonly string[] = [
  "budget_cost_", "goal_", "auto_goal_", "long_run_resume_", "work_attachment_", "one_preflight_",
  "invocation_pre_reservation_validation_", "queued_input_",
];

/**
 * Codes under those prefixes that are Main's own custody state, not the owner's: the Goal turn's admission record (missing, stale, closed,
 * replaced, claimed twice). The run path already says so (shared/run-failure-cause.ts APP_SIDE_RUN_FAILURE_FAMILIES keeps them internal:
 * undispatchedInternalFailure); the start path used to read them as "the owner acts" only because they share the `goal_` prefix, so a
 * message the host proved was refused before dispatch with one of them came back to the composer as "send the same text again in a moment"
 * (OneShell's generic line) instead of waiting. The owner has no Goal action that clears a record Main lost.
 */
const APP_SIDE_START_REFUSAL_PREFIXES: readonly string[] = ["goal_episode_admission_"];

/** A start refusal whose code is one the owner acts on (a cost cap, a stopped Goal, a settings change). Undefined = not named. */
export function startRefusalNeedsOwner(code: string | null | undefined): boolean {
  if (!code) return false;
  if (APP_SIDE_START_REFUSAL_PREFIXES.some((prefix) => code.startsWith(prefix) && code.length > prefix.length)) return false;
  return OWNER_ACTION_REFUSAL_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * The host's own proof that a thrown start sent nothing to any runtime: InvocationService.start marks every throw that precedes
 * the hand-off with `turnDelivery: "not-dispatched"` (runtime/runner.ts markRefusedBeforeDispatch). The marker lives on the error
 * object, so it exists only where the error was thrown (Main), never across IPC. The second proof, a rejected admission row for the
 * run, is read by the caller (renderer-send-queue.ts undispatchedStartWaits).
 */
export function isRefusedBeforeDispatch(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { turnDelivery?: unknown }).turnDelivery === "not-dispatched";
}

/** Retries after which the owner hears one calm line about a start refused before dispatch; no surface holds or ends a message at this count. */
export const UNDISPATCHED_START_MAX_ATTEMPTS = 12;

/**
 * The rule of the Desktop composer's queue (renderer-send-queue.ts undispatchedStartWaits) for every surface that has only the thrown
 * error: the start was refused before anything reached a runtime (the error's own `turnDelivery: "not-dispatched"`), for a reason that
 * is off the transient list and that the owner has nothing to do about. The message then waits (capped backoff, no count or age ends it)
 * instead of coming back as a code. Without the marker (a refusal over IPC, or after the hand-off) it is never taken: that message could
 * have acted. The composer also accepts a rejected admission row as the proof; the phone and the mail intake have the marker only.
 */
export function startRefusedBeforeDispatchWaits(error: unknown): boolean {
  if (isTransientSendRefusal(error)) return false;
  if (startRefusalNeedsOwner(sendRefusalCode(error))) return false;
  return isRefusedBeforeDispatch(error);
}

/** The shared store stayed locked, anywhere in the error's cause chain. Says nothing about dispatch: the caller proves that. */
export function isStoreBusyError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current as object); depth += 1) {
    seen.add(current as object);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (code === "store_busy" || SQLITE_STORE_BUSY_RE.test(code))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isTransientSendRefusal(error: unknown): boolean {
  return isTransientSendRefusalCode(sendRefusalCode(error)) || isStoreBusyRefusedBeforeDispatch(error);
}

/**
 * Transient codes a WRITE to the background service can throw after the service already recorded it: the signed channel closed
 * or was replaced while the reply was in flight (native_auth_channel_lost rejects every pending request; the generation check
 * after dispatch throws native_gui_original_channel_unavailable). They are refused-before-anything for a call that never left, so
 * they stay transient, but a caller that would resend the same words by ANOTHER route (a direction accepted as the next message)
 * must first read the service's own record of that intent (recorded-owner-steer.ts).
 */
const POSSIBLY_RECORDED_CODES: ReadonlySet<string> = new Set(["native_auth_channel_lost", "native_gui_original_channel_unavailable"]);

export function isPossiblyRecordedSendRefusal(error: unknown): boolean {
  const code = sendRefusalCode(error);
  return !!code && POSSIBLY_RECORDED_CODES.has(code);
}

/**
 * Delay before attempt `attempt` (0 = first retry) of a message that was refused transiently. Short at first because
 * most refusals clear within a second or two (a turn settling, a channel reattaching); capped so a long wait stays
 * cheap. Jitter is the caller's, so this stays a pure function.
 */
export function transientSendBackoffMs(attempt: number): number {
  const steps = [250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 15000];
  return steps[Math.max(0, Math.min(steps.length - 1, Math.floor(attempt)))];
}

/**
 * The window after which a continuous refusal's clock restarts, and the age cut of a held row an older build left behind (supervisor-service.ts).
 * Only two things still read it: that clock restart, and the age cut of a held row an older build left behind. No delivery path ends a
 * received input on it. Still bounded, on purpose: a start that may already have run (the one effect-unknown resend), a refusal only the
 * owner can clear, a run that failed for a cause outside MCP_CONFIG_HOST_NOT_READY_CODES (12 tries, then host-recovery), and the app's
 * own internal failures (12 tries, then one more).
 */
export const TRANSIENT_SEND_DEADLINE_MS = 2 * 60 * 60 * 1000;

/**
 * Delay before the next start of a message whose earlier starts were refused or failed for the app's own state (not an occupied chat).
 * Each failed attempt writes a run with its ledger rows and may run the tool-selection judge, so after UNDISPATCHED_START_MAX_ATTEMPTS
 * tries the wait grows (1 min, 5 min, 10 min cap; the cap equals host-recovery's internal backstop) instead of staying at 15 s. A
 * runtime signal or a sign-in wakes the wait at once, so a cause that clears is not waited out. `attempts` is the tries spent.
 */
const LONG_WAIT_STEPS_MS: readonly number[] = [60_000, 300_000, 600_000];
export function startRetryBackoffMs(attempts: number): number {
  const spent = Math.max(0, Math.floor(attempts));
  if (spent < UNDISPATCHED_START_MAX_ATTEMPTS) return transientSendBackoffMs(spent);
  return LONG_WAIT_STEPS_MS[Math.min(LONG_WAIT_STEPS_MS.length - 1, spent - UNDISPATCHED_START_MAX_ATTEMPTS)];
}
/** A refusal that is the app's own state, not a room or a store that frees up by itself: it is the one that waits the long steps. */
export function startRefusalWaitsLong(code: string | null | undefined): boolean {
  return !!code && code !== "store_busy" && !isTransientSendRefusalCode(code);
}

/** Start once; only the caller's typed refusal admission may turn a rejection into a durable acceptance. */
export async function startOwnerSendOrAcceptRefusal<Started, Accepted>(
  start: () => Started | Promise<Started>,
  acceptRefusal: (cause: unknown) => Accepted | null | Promise<Accepted | null>,
): Promise<Started | Accepted> {
  try { return await start(); }
  catch (cause) {
    const accepted = await acceptRefusal(cause);
    if (accepted !== null) return accepted;
    throw cause;
  }
}
