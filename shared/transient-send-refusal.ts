/**










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
]);

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

export function isTransientSendRefusal(error: unknown): boolean {
  return isTransientSendRefusalCode(sendRefusalCode(error));
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

/** A message that has waited this long without ever starting is given up on (the row stays in the transcript). */
export const TRANSIENT_SEND_DEADLINE_MS = 2 * 60 * 60 * 1000;
