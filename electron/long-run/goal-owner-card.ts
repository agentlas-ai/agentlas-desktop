import type { AgentlasAskQuestion } from "../../shared/ask-fence-flatten";
import { askResendMessage, composeAskAnswer } from "../../shared/ask-action-bar";
import { composeQuestionReply } from "../../shared/question-reply";

/*
 * The decision card the host posts when a Goal's passes did nothing and the terminal verification did not close it (owner
 * 2026-10-20: "묻는건 무조건 카드로 주고 알림 울리게해"). A Goal the host drove again and that did nothing, and that the
 * independent verifier does not call done, is not waiting on a timer or a tool: it is waiting for someone. The invocation
 * service posts this card as its own assistant message after that verdict (askOwnerAfterIdleYield), holds the Goal for the
 * answer and rings the desktop and the phone; the card, the hold and the alerts read it with no second code path.
 *
 * It is never added before the verification: a card in the turn's own text pre-empted the terminal verification and held a
 * Goal whose plan was done and whose answer was right (antigravity run, 2026-10-20).
 *
 * No word is judged here: the trigger is the host's own count of idle passes (client goal_idle_pass_yield) followed by a
 * verification verdict; the text is fixed host copy. No electron import (gates load this file directly).
 */
export type HostOwnerCardKind = "goal_idle_stop";

/**
 * The typed decision each option of a host card stands for (owner rule 2026-10-28: a terminal action — close, stop, cancel —
 * is a machine-readable decision, never a sentence a model or a judge has to interpret). The option order in COPY is the
 * order of this tuple, in every language. Finance validation 2026-10-28: the owner picked "여기서 멈추고 지금까지를 정리해
 * 주세요" and the Goal was not stopped — the choice reached the Goal only as words, the turn reopened the Goal, its
 * summary was verified inconclusive and the same card came back; the owner-answer judge was unavailable the whole time.
 */
export type HostOwnerCardDecision = "continue_on_own_judgment" | "stop_and_summarize";
export const HOST_OWNER_CARD_DECISIONS: Readonly<Record<HostOwnerCardKind, readonly HostOwnerCardDecision[]>> = {
  goal_idle_stop: ["continue_on_own_judgment", "stop_and_summarize"],
};

type CardCopy = Record<"ko" | "en", AgentlasAskQuestion>;

const COPY: Record<HostOwnerCardKind, CardCopy> = {
  goal_idle_stop: {
    ko: {
      header: "목표가 멈췄어요",
      question: "목표가 다음 단계를 스스로 정하지 못하고 멈췄어요. 위 내용에 답하거나, 아래에서 골라 주세요.",
      multiSelect: false,
      options: [
        { label: "스스로 판단해서 계속 진행해 주세요", description: "다시 묻지 않고 가장 안전한 다음 단계를 골라 이어갑니다." },
        { label: "여기서 멈추고 지금까지를 정리해 주세요", description: "더 진행하지 않고 결과와 남은 일을 요약합니다." },
      ],
    },
    en: {
      header: "The Goal stopped",
      question: "The Goal stopped because it could not choose its next step. Answer what it asked above, or pick one below.",
      multiSelect: false,
      options: [
        { label: "Continue on your own judgment", description: "Pick the safest next step without asking again." },
        { label: "Stop here and summarize", description: "Go no further; summarize the results and what is left." },
      ],
    },
  },
};

/** The card's questions in the owner's language. */
export function hostOwnerCardQuestions(kind: HostOwnerCardKind, locale: "ko" | "en"): AgentlasAskQuestion[] {
  const copy = COPY[kind][locale === "ko" ? "ko" : "en"];
  return [{ ...copy, options: copy.options.map((option) => ({ ...option })) }];
}

/**
 * Every reply text the app's own answer paths write for one option of this card, in either language: the card's own row
 * (OneShell, shared/ask-action-bar composeAskAnswer: the bare label), the question sheet and the phone's canonical answer
 * (shared/question-reply composeQuestionReply: question + selected label, Korean or English prefixes), and the stale-question
 * resend (askResendMessage). A closed set computed by the same functions that write the reply — an exact match is an
 * identity check against host-owned bytes, not a reading of the owner's words. A reply with typed text of its own (a note,
 * an edited answer) matches nothing and stays an ordinary owner message.
 */
function canonicalOptionReplies(kind: HostOwnerCardKind, optionIndex: number): Set<string> {
  const replies = new Set<string>();
  for (const cardLocale of ["ko", "en"] as const) {
    const [card] = hostOwnerCardQuestions(kind, cardLocale);
    const label = card.options[optionIndex]?.label;
    if (!label) continue;
    replies.add(composeAskAnswer([label], ""));
    for (const ko of [true, false]) {
      replies.add(composeQuestionReply([{ ...card, id: "host-card-q0" }], { "host-card-q0": [label] }, {}, ko).reply);
      replies.add(askResendMessage(ko ? "ko" : "en", card.question, label));
    }
  }
  return replies;
}

const REPLY_INDEX = new Map<string, { kind: HostOwnerCardKind; decision: HostOwnerCardDecision }>();
for (const kind of Object.keys(HOST_OWNER_CARD_DECISIONS) as HostOwnerCardKind[]) {
  HOST_OWNER_CARD_DECISIONS[kind].forEach((decision, index) => {
    for (const reply of canonicalOptionReplies(kind, index)) REPLY_INDEX.set(`${kind}\u0000${reply.trim()}`, { kind, decision });
  });
}

/** The typed decision an owner reply to this host card selects, or null when it is not exactly one of the card's options. */
export function hostOwnerCardDecisionForReply(kind: HostOwnerCardKind, reply: unknown): HostOwnerCardDecision | null {
  if (typeof reply !== "string" || reply.length > 8_000) return null;
  return REPLY_INDEX.get(`${kind}\u0000${reply.trim()}`)?.decision ?? null;
}
