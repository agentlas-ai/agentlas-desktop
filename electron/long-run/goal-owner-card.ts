import type { AgentlasAskQuestion } from "../../shared/ask-fence-flatten";

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
