// The mail server and Main answer refusals with an English sentence plus a
// machine `code` (API.md §0). Screens branch on the code only and show their
// own copy in the owner's language — the English `message` is for logs and the
// model, never for a Korean screen. Unknown codes get one generic line that
// still names the code, so a new server code is visible without being raw.
import { tFor, type Locale } from "@/lib/i18n";

type Key = Parameters<typeof tFor>[1];

const KNOWN = new Set([
  "sign_in_required",
  "network",
  "timeout",
  "send_outcome_unknown",
  "agent_mail_not_available",
  "agent_mail_mailbox_not_found",
  "agent_mail_mailbox_not_ready",
  "agent_mail_plan_required",
  "agent_mail_invalid_request",
  "agent_mail_thread_not_found",
  "agent_mail_message_not_found",
  "agent_mail_draft_not_found",
  "agent_mail_draft_version_conflict",
  "agent_mail_search_too_broad",
  "agent_mail_address_invalid",
  "agent_mail_address_reserved",
  "agent_mail_address_taken",
  "agent_mail_address_in_use",
  "agent_mail_address_already_chosen",
  "agent_mail_rename_unsupported",
  "agent_mail_provision_failed",
  "agent_mail_invalid_recipient",
  "agent_mail_missing_recipient",
  "agent_mail_too_many_recipients",
  "agent_mail_missing_subject",
  "agent_mail_missing_body",
  "agent_mail_body_too_large",
  "agent_mail_attachments_unsupported",
  "agent_mail_monthly_limit_reached",
  "agent_mail_thread_moved",
  "agent_mail_rejected_by_provider",
  "agent_mail_attachment_not_found",
  "agent_mail_attachment_unavailable",
  "agent_mail_attachment_unreadable",
  "agent_mail_attachment_too_large",
  "agent_mail_attachments_too_large",
]);

export function mailErrorText(locale: Locale, error: { code?: string | null } | null | undefined): string {
  const code = typeof error?.code === "string" ? error.code : "";
  if (KNOWN.has(code)) return tFor(locale, `one.mail.error.${code}` as Key);
  return tFor(locale, "one.mail.error.generic", { code: code || "unknown" });
}
