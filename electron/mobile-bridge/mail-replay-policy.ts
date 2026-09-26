// Replay policy for mail writes over the Mobile Bridge. Kept free of Main
// imports so the socket server can use it without loading the mail client.

/**
 * Refusals the phone may safely retry with the SAME bridge key: the request
 * did not run to a decided end (Desktop could not reach the web, the web was
 * briefly unavailable, or the send result is unknown). The web idempotency key
 * is derived from the bridge key, so a re-run can never become a second email.
 * The bridge must not store these as the command's final answer (M1, M7).
 */
export const MOBILE_BRIDGE_MAIL_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "send_outcome_unknown",
  "timeout",
  "network",
  "rate_limited",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
  "service_unavailable",
  "agent_mail_unavailable",
  // Web 06ac7b82: SES refused before taking the mail (rate / daily quota / paused).
  // The web frees the idempotency key, so the same key sends once SES recovers.
  "agent_mail_service_busy",
  "agent_mail_provider_quota",
  "agent_mail_provider_paused",
]);

/**
 * Refusals given before anything ran. After signing in (or back into the
 * paired account) the same key must run, not replay this refusal for a day.
 * Safe for every mail/profile write, including mail.delegate.
 */
export const MOBILE_BRIDGE_MAIL_NOT_RUN_CODES: ReadonlySet<string> = new Set([
  "sign_in_required",
  "account_mismatch",
  "mail_unavailable",
]);

/**
 * Mail writes whose downstream call is safe to run again with the same bridge
 * key: send (web Idempotency-Key is derived from the bridge key) and the
 * desired-state writes (read/archive/delete/draft CAS/settings). mail.delegate
 * is not here: it starts a One run, and a re-run would start a second one.
 */
export const MOBILE_BRIDGE_RERUNNABLE_MAIL_WRITES: ReadonlySet<string> = new Set([
  "mail.send",
  "mail.markRead",
  "mail.archive",
  "mail.delete",
  "mail.draft.save",
  "mail.draft.delete",
  "mail.updateSettings",
  // PLAN-2: create is desired-state (same address → 200 created:false); contact
  // save is keyed by address/version; delete is desired-state.
  "mail.create",
  "mail.contact.save",
  "mail.contact.delete",
]);

export function mobileBridgeMailReplayMayRerun(method: string, code: string): boolean {
  if (MOBILE_BRIDGE_RERUNNABLE_MAIL_WRITES.has(method) && MOBILE_BRIDGE_MAIL_RETRYABLE_CODES.has(code)) return true;
  return (method.startsWith("mail.") || method.startsWith("one.profile.")) && MOBILE_BRIDGE_MAIL_NOT_RUN_CODES.has(code);
}
