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

/**
 * Server loop brakes (agentlas a116f675). Kept beside the code that shows them;
 * both languages are required.
 */
const LOCAL: Record<string, Record<Locale, string>> = {
  agent_mail_auto_reply_blocked: {
    ko: "자동 메일·자기 주소·대화 밖 주소에는 자동으로 답하지 않아요.",
    en: "Automatic replies are not sent to automated mail, your own address, or people outside the conversation.",
  },
  agent_mail_loop_suspected: {
    ko: "이 대화에서 자동 답장이 한 시간에 너무 많아 멈췄어요. 직접 확인해 주세요.",
    en: "Paused: too many automatic replies in this conversation in the last hour. Please check it yourself.",
  },
  // PLAN-2 (web e7f3ef8e): permanent address
  agent_mail_address_required: {
    ko: "주소를 정해야 메일함을 만들 수 있어요. 앱이 오래됐다면 업데이트해 주세요.",
    en: "Choose an address to create the mailbox. If the app is old, please update it.",
  },
  agent_mail_address_locked: {
    ko: "메일 주소는 한 번 정하면 바꿀 수 없어요.",
    en: "The mail address can't be changed once chosen.",
  },
  agent_mail_address_retired: {
    ko: "지운 주소는 되살리기만 할 수 있어요.",
    en: "A deleted address can only be brought back.",
  },
  // PLAN-2: agent-to-agent machine rules (never retried)
  agent_mail_a2a_reply_not_expected: {
    ko: "상대 에이전트가 답장을 원하지 않아 자동으로 보내지 않았어요.",
    en: "The other agent asked for no reply, so nothing was sent automatically.",
  },
  agent_mail_auto_reply_exists: {
    ko: "이 메일에는 이미 자동으로 답했어요.",
    en: "This message already got its automatic reply.",
  },
  agent_mail_a2a_turns_exhausted: {
    ko: "에이전트끼리 자동으로 주고받은 횟수가 한도에 닿았어요. 직접 한 번 답하면 다시 이어져요.",
    en: "The agents reached their automatic turn limit. Reply once yourself to continue.",
  },
  agent_mail_a2a_no_progress: {
    ko: "같은 내용이 되풀이되어 보내지 않았어요.",
    en: "Not sent: it repeated the previous message.",
  },
  agent_mail_a2a_unsolicited: {
    ko: "처음 연락한 에이전트에게는 자동으로 답하지 않아요.",
    en: "Automatic replies aren't sent to an agent writing for the first time.",
  },
  // Web 06ac7b82: the sending service (SES) refused for account-level reasons.
  // Nothing was sent, the monthly allowance was not used, the draft stays.
  agent_mail_service_busy: {
    ko: "지금 메일 서버가 붐벼서 보내지 못했어요. 보낸 수에는 세지 않았고 쓴 내용은 그대로 있어요. 잠시 뒤 다시 보내 주세요.",
    en: "The mail service is busy, so it wasn't sent. It didn't count toward your allowance and your text is kept. Please try again shortly.",
  },
  agent_mail_provider_quota: {
    ko: "Agentlas 메일이 오늘 보낼 수 있는 양을 다 써서 보내지 못했어요. 보낸 수에는 세지 않았고 쓴 내용은 그대로 있어요. 나중에 다시 보내 주세요.",
    en: "Agentlas mail reached today's sending limit, so it wasn't sent. It didn't count toward your allowance and your text is kept. Please try again later.",
  },
  agent_mail_provider_paused: {
    ko: "Agentlas 메일 발송이 잠시 멈춰 있어 보내지 못했어요. 보낸 수에는 세지 않았고 쓴 내용은 그대로 있어요. 나중에 다시 보내 주세요.",
    en: "Agentlas mail sending is paused, so it wasn't sent. It didn't count toward your allowance and your text is kept. Please try again later.",
  },
  agent_mail_internal_delivery_failed: {
    ko: "받는 Agentlas 메일함에 전하지 못했어요. 잠시 뒤 다시 보내 주세요.",
    en: "Couldn't deliver to the Agentlas mailbox. Please try again shortly.",
  },
  // PLAN-2: contacts
  agent_mail_contact_not_found: { ko: "연락처를 찾을 수 없어요.", en: "Contact not found." },
  agent_mail_contact_version_conflict: {
    ko: "다른 기기에서 먼저 바뀌었어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.",
    en: "Another device changed it first. Check the latest version and save again.",
  },
  agent_mail_contact_field_forbidden: { ko: "이 칸은 여기서 바꿀 수 없어요.", en: "This field can't be changed here." },
  // PLAN-2: directory
  agent_mail_directory_query_required: { ko: "검색어를 조금 더 적어 주세요.", en: "Type a little more to search." },
  agent_mail_directory_name_reserved: {
    ko: "이 이름은 쓸 수 없어요(Agentlas·공식 등 사칭 방지).",
    en: "This name can't be used (it looks like Agentlas or an official account).",
  },
  agent_mail_directory_identity_unsupported: {
    ko: "내 도메인이 확인된 뒤에 등재할 수 있어요.",
    en: "You can be listed after your domain is verified.",
  },
  // PLAN-2: custom domain
  agent_mail_domain_invalid: { ko: "도메인 형식이 맞지 않거나 쓸 수 없는 도메인이에요.", en: "That domain isn't valid or can't be used." },
  agent_mail_domain_taken: { ko: "다른 계정이 쓰고 있는 도메인이에요.", en: "Another account uses this domain." },
  agent_mail_domain_limit: { ko: "도메인을 더 추가할 수 없어요.", en: "No more domains can be added." },
  agent_mail_domain_not_found: { ko: "도메인을 찾을 수 없어요.", en: "Domain not found." },
  agent_mail_domain_unverified: { ko: "도메인 확인이 끝난 뒤에 할 수 있어요.", en: "Available after the domain is verified." },
  agent_mail_domain_already_verified: { ko: "이미 확인된 도메인이에요.", en: "This domain is already verified." },
  agent_mail_domain_in_use: {
    ko: "지금 메일 주소가 이 도메인에 있어서 지울 수 없어요.",
    en: "The current mail address is on this domain, so it can't be removed.",
  },
  agent_mail_domain_unsupported: { ko: "이 메일함에서는 내 도메인을 쓸 수 없어요.", en: "This mailbox can't use a custom domain." },
  agent_mail_domain_provider_failed: {
    ko: "메일 서버가 잠시 응답하지 않았어요. 다시 시도해 주세요.",
    en: "The mail provider didn't respond. Please try again.",
  },
};

export function mailErrorText(locale: Locale, error: { code?: string | null } | null | undefined): string {
  const code = typeof error?.code === "string" ? error.code : "";
  const local = LOCAL[code];
  if (local) return local[locale] ?? local.en;
  if (KNOWN.has(code)) return tFor(locale, `one.mail.error.${code}` as Key);
  return tFor(locale, "one.mail.error.generic", { code: code || "unknown" });
}
