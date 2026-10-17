import { isTransientSendRefusalCode } from "./transient-send-refusal";

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
]);

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

/** The app-side family a run failure code belongs to, or null when the owner may have something to do (or it is unknown). */
export function appSideRunFailure(code: unknown): { code: string; reason: string } | null {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  if (isTransientSendRefusalCode(code)) {
    return { code, reason: "Transient: the chat or its channel was not ready yet (shared/transient-send-refusal.ts)." };
  }
  const family = APP_SIDE_RUN_FAILURE_FAMILIES.find((entry) => entry.match === "exact"
    ? entry.code === code : code.startsWith(entry.code) && code.length > entry.code.length);
  return family ? { code, reason: family.reason } : null;
}

export function isAppSideRunFailureCode(code: unknown): boolean {
  return appSideRunFailure(code) !== null;
}
