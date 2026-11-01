import { isTransientSendRefusalCode, startRefusalNeedsOwner } from "./transient-send-refusal";
import { HOST_FAILURE_CODE_CLASSES, OWNER_ACTION_FAILURE_CODES, RUN_FAILURE_UNSETTLED_CODE, isTypedProviderRunFailure } from "./run-failure-notice";
import type { RunFailureNoticeFacts } from "./run-failure-notice";
import { isNonFailureInvocationStop } from "./invocation-host-stop";
import type { InvocationRunReceipt } from "./types";

/**
 * Run failure codes whose cause is inside the app: Main's own custody, ledger, process or channel state. The owner has
 * nothing to act on, so such a failure is never written or drawn as a "needs-owner" line (host status "app-failed").
 *
 * Production Yotube, 2026-10-17: run d85e262f failed at 11:51Z with goal_episode_admission_missing (Main lost its own
 * Goal-turn admission record) and the room showed Hope saying "the run failed … check the run history" with a
 * "확인 필요" status — the owner had no action, and the screen called the room broken.
 *
 * Codes are matched exactly or by one documented prefix family; prose is never inspected. An unknown code stays an
 * owner-facing failure (conservative default). The transient send-refusal set (shared/transient-send-refusal.ts) is
 * app-side by definition and is included as a whole.
 *
 * One code is in both worlds: `runtime_turn_unsettled` is a send refusal ("the previous turn of this chat has not settled
 * yet", the chat is not ready) AND the terminal code of a provider turn that ended without its terminal receipt. The second
 * carries the runner's typed failure (InvocationRuntimeFailure); the first never does. A run whose typed provider failure is
 * known is the provider's outcome, not the app's: the owner can resend or pick another model (F51, 2026-10-21: an
 * antigravity turn blocked by the provider's content safety filters read "App problem").
 */
export interface AppSideRunFailureFamily {
  readonly match: "exact" | "prefix";
  readonly code: string;
  /** Why the owner cannot act on it. */
  readonly reason: string;
}

export const APP_SIDE_RUN_FAILURE_FAMILIES: readonly AppSideRunFailureFamily[] = Object.freeze([
  { match: "prefix", code: "goal_episode_admission_",
    reason: "Goal custody: Main's own admission record for this Goal turn was missing, stale, closed or replaced." },
  { match: "exact", code: "invocation_chat_owned_by_other_run",
    reason: "Run custody: another run of this chat still held the chat's owner row." },
  { match: "exact", code: "main_tool_start_not_durable",
    reason: "Ledger: Main could not record a tool start durably, so it refused to run the tool." },
  { match: "exact", code: "agent_context_event_collision",
    reason: "Ledger: Main reused a turn id for a second step of the same conversation." },
  { match: "exact", code: "invocation_native_fence_already_configured",
    reason: "Process: the background-service start fence was installed a second time in this process." },
  { match: "exact", code: "native_gui_activation_prerequisites_missing",
    reason: "Channel: the background service was not ready to take turns from the app window." },
  { match: "exact", code: "native_auth_not_provisioned",
    reason: "Channel: the background service started before its signed channel was provisioned." },
  { match: "exact", code: "automation_goal_execution_owner_changed",
    reason: "Custody: the automation's Goal execution moved to another owner while the run was starting." },
  { match: "exact", code: "memory_source_custody_changed",
    reason: "Custody: the memory source was changed or forgotten by the owner while a background step read it." },
]);

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

/**
 * The app-side family a run failure code belongs to, or null when the owner may have something to do (or it is unknown).
 * `runtimeFailure` is the run's typed provider failure when it has one (event.error.runtimeFailure, receipt.runtimeFailure).
 */
export function appSideRunFailure(
  code: unknown,
  runtimeFailure?: RunFailureNoticeFacts["runtimeFailure"],
): { code: string; reason: string } | null {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  if (code === RUN_FAILURE_UNSETTLED_CODE && isTypedProviderRunFailure(runtimeFailure)) return null;
  if (isTransientSendRefusalCode(code)) {
    return { code, reason: "Transient: the chat or its channel was not ready yet (shared/transient-send-refusal.ts)." };
  }
  const family = APP_SIDE_RUN_FAILURE_FAMILIES.find((entry) => entry.match === "exact"
    ? entry.code === code : code.startsWith(entry.code) && code.length > entry.code.length);
  return family ? { code, reason: family.reason } : null;
}

export function isAppSideRunFailureCode(code: unknown, runtimeFailure?: RunFailureNoticeFacts["runtimeFailure"]): boolean {
  return appSideRunFailure(code, runtimeFailure) !== null;
}

/**
 * A run that ended before anything reached a model, for a reason no table here names: an internal cause.
 *
 * The host's own delivery fact says "not-dispatched" (the error's turnDelivery marker, or every runner attempt in the run ledger
 * recorded as refused: electron/invocation/turn-placement.ts). The model provider never saw the request, so the failure cannot be
 * its refusal, quota, rate limit or sign-in, and a typed provider failure (`runtimeFailure`) rules the case out. Nor is it a code the
 * owner acts on (signing in to the Agentlas Browser) or one with a sentence of its own
 * (HOST_FAILURE_CODE_CLASSES). What is left is the app's own state: the owner has nothing to fix, and sending the same words again
 * is safe because nothing ran. Evidence only: no word of any message is read (the code is matched exactly, as everywhere in this file).
 */
export function undispatchedInternalFailure(input: { code?: unknown; runtimeFailure?: RunFailureNoticeFacts["runtimeFailure"]; delivery?: unknown }): boolean {
  if (input.delivery !== "not-dispatched" || input.runtimeFailure) return false;
  const code = typeof input.code === "string" && CODE_RE.test(input.code) ? input.code : null;
  if (!code) return true;
  if (OWNER_ACTION_FAILURE_CODES.has(code) || HOST_FAILURE_CODE_CLASSES.has(code)) return false;
  // The start path excludes the same refusals the owner acts on (transient-send-refusal.ts startRefusalNeedsOwner: a cost cap, a stopped Goal,
  // a settings change, an attachment limit), each with a sentence of its own. A run that fails after admission with one of them is that
  // refusal, not the app's own state: it must not be retried 12 times behind "the app will try again" (regression review C9).
  // The app-side families (Goal custody's goal_episode_admission_*, a ledger or channel state) share the `goal_` prefix or none: they stay internal.
  return !(startRefusalNeedsOwner(code) && appSideRunFailure(code) === null);
}

/**
 * A settled run the owner must not be told "failed" about: their own Stop (cancelled), a steering interrupt, a host stop
 * (app closing, update restart, Goal paused/deleted), or a failure whose code is the app's own custody/channel state.
 * Those either continue by themselves or were the owner's own act; an OS toast "Run failed" for them is the app calling
 * its own state or the owner's own click a failure (observed in use: Stop, new direction and update restart all toasted).
 * A real provider/tool failure, or a failure code this file does not know, still reads as a failure (conservative default).
 */
export function settledRunIsNotAFailure(
  receipt: Pick<InvocationRunReceipt, "status" | "interruptionCause" | "hostStopCause" | "errorCode" | "runtimeFailure">,
): boolean {
  if (receipt.status === "completed") return false;
  if (isNonFailureInvocationStop(receipt)) return true;
  return receipt.status === "failed" && appSideRunFailure(receipt.errorCode, receipt.runtimeFailure) !== null;
}
