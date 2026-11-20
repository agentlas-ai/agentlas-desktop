/**
 * Which part of a runtime a refusal closes. One fact, one place: the claude runner names it, the retry store and the
 * cooldown read it, and the fallback line that tells the owner says it.
 *
 * A subscription window that is used up closes the whole account for that runtime. A model that needs paid usage credits (the CLI
 * answers `rate_limit_event` rejected with errorCode "credits_required" for that model alone) closes only that model: the
 * subscription window is not used up and the runtime's other models still run. Treating it as the account window kept every other
 * model of the runtime waiting until the window's reset date, and each of them then ended in a fallback line that said "unavailable".
 */
export const MODEL_REQUIRES_CREDITS_CODE = "model_requires_credits";

/** The CLI's own spelling of the same refusal (claude stream-json `rate_limit_info.errorCode`). */
export const MODEL_REQUIRES_CREDITS_CLI_CODE = "credits_required";

/** True when the refusal belongs to one model, so the wait must be kept on that model and nothing wider. */
export function failureClosesOnlyTheModel(failure: { providerCode?: string | null } | null | undefined): boolean {
  return failure?.providerCode === MODEL_REQUIRES_CREDITS_CODE;
}
