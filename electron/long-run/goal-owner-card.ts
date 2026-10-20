import { canonicalAskFenceText, extractAskFences, type AgentlasAskQuestion } from "../../shared/ask-fence-flatten";

/*
 * The decision card the host adds when a Goal stops with no typed way forward.
 * A Goal that the host drove again and again and that did nothing is not waiting on a timer or a
 * tool: it is waiting for someone. The model's own last words stay as they are; the host appends the same wire block a
 * model writes, so the card, the hold, the desktop alert and the phone read it with no second code path.
 *
 * No word is judged here: the trigger is the host's own count of idle passes (client goal_idle_pass_yield), the text is
 * fixed host copy. No electron import (the daemon loads shared fence code, and gates load this file directly).
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

/**
 * The text with the host card appended. A turn that already carries a valid card is returned unchanged (the model asked
 * the right way), so a card is never doubled.
 */
export function withHostOwnerCard(text: string, kind: HostOwnerCardKind, locale: "ko" | "en"): string {
  if (extractAskFences(text).questions.length > 0) return text;
  const block = canonicalAskFenceText(hostOwnerCardQuestions(kind, locale));
  return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block}` : block;
}
