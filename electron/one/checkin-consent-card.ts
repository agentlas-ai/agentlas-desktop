import { AGENT_ASK_CLOSE, AGENT_ASK_OPEN } from "../../shared/agent-control-blocks";
import { askResendMessage } from "../../shared/ask-action-bar";
import type { AgentlasAskQuestion } from "../../shared/ask-fence-flatten";
import { composeQuestionReply } from "../../shared/question-reply";
import type { OneCheckinCadence } from "../../shared/one-supervisor";

/*
 * The owner card for a check-in the model proposed (one_supervisor_checkin create). A model-made check-in costs a full One turn each time
 * it runs, so it only starts when the owner turns it on: the proposal is stored inactive, this card says what / when / with which
 * permission, and the owner's pick is the typed decision. The card's text is fixed host copy built from the stored proposal; the answer is
 * recognised by an exact match against the closed set of replies the app's own answer paths write for it (the same identity check as
 * long-run/goal-owner-card.ts), never by reading the owner's words. A reply with typed text of its own matches nothing and stays an ordinary
 * message. No electron import (gates load this file directly).
 */
export type CheckinConsentDecision = "enable" | "decline";
export interface CheckinProposalView { instruction: string; cadence: OneCheckinCadence; notify: "important" | "always" }
const DECISIONS: readonly CheckinConsentDecision[] = ["enable", "decline"];
const clip = (text: string, max: number): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** The schedule in the owner's words. */
export function humanCheckinSchedule(cadence: OneCheckinCadence, locale: "ko" | "en"): string {
  if (cadence.kind === "daily") return locale === "ko" ? `매일 ${cadence.time}` : `daily at ${cadence.time}`;
  const minutes = cadence.minutes;
  if (locale === "ko") return minutes % 60 === 0 ? `${minutes / 60}시간마다` : `${minutes}분마다`;
  return minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `every ${minutes} minutes`;
}

/** The card's question and options for a stored proposal. Deterministic: the same proposal always gives the same bytes. */
export function checkinConsentQuestion(proposal: CheckinProposalView, locale: "ko" | "en"): AgentlasAskQuestion {
  const when = humanCheckinSchedule(proposal.cadence, locale);
  const what = clip(proposal.instruction, 220);
  if (locale === "ko") {
    return {
      header: "자동 확인을 켤까요?",
      question: `${when} 이것을 확인하게 할까요: "${what}" — 읽기 전용(앱 조작·쓰기 없이 보고만), 하루 최대 24회, ${proposal.notify === "always" ? "확인할 때마다 알려요" : "중요할 때만 알려요"}. 켜기 전에는 아무것도 실행되지 않아요.`,
      multiSelect: false,
      options: [
        { label: "켜기", description: "이 일정으로 자동 확인을 시작합니다." },
        { label: "아니요", description: "만들지 않습니다." },
      ],
    };
  }
  return {
    header: "Turn on this automatic check?",
    question: `Run this check ${when}: "${what}" — read-only (reports only, no app actions or writes), at most 24 runs a day, ${proposal.notify === "always" ? "tells you every time" : "tells you only when it matters"}. Nothing runs until you turn it on.`,
    multiSelect: false,
    options: [
      { label: "Turn on", description: "Start the automatic check on this schedule." },
      { label: "No", description: "Do not create it." },
    ],
  };
}

/** The assistant message text that carries the card (the ask fence every surface already renders, the phone included). */
export function checkinConsentCardText(proposal: CheckinProposalView, locale: "ko" | "en"): string {
  const card = checkinConsentQuestion(proposal, locale);
  return `${AGENT_ASK_OPEN}\n${JSON.stringify({ header: card.header, question: card.question, multiSelect: false, options: card.options })}\n${AGENT_ASK_CLOSE}`;
}

/** Every reply text the app's answer paths write for one option of this proposal's card, in either language. */
function canonicalReplies(proposal: CheckinProposalView, optionIndex: number): Set<string> {
  const replies = new Set<string>();
  for (const cardLocale of ["ko", "en"] as const) {
    const card = checkinConsentQuestion(proposal, cardLocale);
    const label = card.options[optionIndex]?.label;
    if (!label) continue;
    for (const ko of [true, false]) {
      replies.add(composeQuestionReply([{ ...card, id: "host-card-q0" }], { "host-card-q0": [label] }, {}, ko).reply.trim());
      replies.add(askResendMessage(ko ? "ko" : "en", card.question, label).trim());
    }
  }
  return replies;
}

/** The decision this owner reply makes on this proposal's card, or null when it is not exactly one of its question-bound replies. */
export function checkinConsentDecisionForReply(proposal: CheckinProposalView, reply: unknown): CheckinConsentDecision | null {
  if (typeof reply !== "string" || reply.length > 8_000) return null;
  const text = reply.trim();
  for (let index = 0; index < DECISIONS.length; index += 1) if (canonicalReplies(proposal, index).has(text)) return DECISIONS[index];
  return null;
}

const HEADERS = new Set(["자동 확인을 켤까요?", "Turn on this automatic check?"]);
/** Whether this assistant message is a check-in consent card (an ask fence whose header is this card's). */
export function isCheckinConsentCardText(text: string): boolean {
  const open = text.indexOf(AGENT_ASK_OPEN), close = text.indexOf(AGENT_ASK_CLOSE);
  if (open < 0 || close < open) return false;
  try { return HEADERS.has(String(JSON.parse(text.slice(open + AGENT_ASK_OPEN.length, close)).header)); } catch { return false; }
}
/** The card message text of a proposal in either language (the language it was posted in is not stored). */
export function checkinConsentCardTexts(proposal: CheckinProposalView): string[] {
  return [checkinConsentCardText(proposal, "ko"), checkinConsentCardText(proposal, "en")];
}
/**
 * A short answer that carries no question: the option number the phone's plain rendering asks for ("1", "2", "1. 켜기"), the label, or a
 * plain yes/no. It decides a proposal ONLY when that proposal's card is the last card of the conversation (the caller checks), because on
 * its own it would answer any question.
 */
export function checkinShortAnswer(reply: unknown): CheckinConsentDecision | null {
  if (typeof reply !== "string" || reply.length > 80) return null;
  const text = reply.trim().replace(/^["'“”‘’]+|["'“”‘’.!。]+$/gu, "").trim().toLowerCase();
  if (!text) return null;
  // The whole reply must be the answer: "1 hour is too often", "1.5시간마다로" or "2.5 hours instead" are not option numbers.
  if (/^1\s*[.)\]:-]?\s*(?:켜기|turn on)?$/u.test(text) || ["켜기", "turn on", "네", "예", "응", "yes", "y", "ok", "okay"].includes(text)) return "enable";
  if (/^2\s*[.)\]:-]?\s*(?:아니요|no)?$/u.test(text) || ["아니요", "아니오", "아니", "no", "n", "nope", "no thanks"].includes(text)) return "decline";
  return null;
}
/** One line telling the owner how to answer a card that is still valid. */
export function checkinCardGuidance(locale: "ko" | "en"): string {
  return locale === "ko" ? "이 카드는 아직 유효합니다. 1(켜기) 또는 2(아니요)로 답해 주세요." : "This card is still open. Reply 1 (Turn on) or 2 (No).";
}
export function checkinCardExpiredLine(locale: "ko" | "en"): string {
  return locale === "ko" ? "이 제안은 만료됐어요. 다시 요청해 주세요." : "This proposal expired. Please ask again.";
}
export function checkinCardWithdrawnLine(instruction: string, locale: "ko" | "en"): string {
  const what = clip(instruction, 80);
  return locale === "ko" ? `새 제안이 들어와 이전 제안("${what}")은 취소됐어요. 다시 요청해 주세요.` : `A newer proposal replaced the earlier one ("${what}"). Ask again if you still want it.`;
}
export function checkinCardLimitLine(locale: "ko" | "en"): string {
  return locale === "ko" ? "켜 둔 체크인이 너무 많아 이 체크인은 켜지 못했어요. 하나를 취소한 뒤 다시 요청해 주세요." : "There are too many active check-ins, so this one was not turned on. Cancel one and ask again.";
}
export function checkinDailyCapLine(scope: "checkin" | "all", locale: "ko" | "en"): string {
  return locale === "ko" ? `오늘 체크인 상한(${scope === "all" ? "전체 48회" : "체크인당 24회"})에 닿아 내일 다시 시작해요.` : `Today's check-in limit (${scope === "all" ? "48 runs in all" : "24 runs for one check-in"}) was reached; they resume tomorrow.`;
}
export function checkinReadOnlyLine(instruction: string, locale: "ko" | "en"): string {
  const which = clip(instruction, 40);
  return locale === "ko" ? `"${which}": 이 체크인은 이제 읽기 전용으로 돌아요. 바꿀 일이 생기면 제안으로 알려 드려요.` : `"${which}": this check-in now runs read-only. If something needs changing, I will suggest it to you.`;
}
