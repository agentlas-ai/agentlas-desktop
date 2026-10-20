import type { AgentlasAskQuestion } from "../../shared/ask-fence-flatten";
import type { PersistenceBoundaryKind } from "../../shared/persistence-policy";

/*
 * What the owner sees when the AGI monitor must ask (ask_owner_once, request_app_restart): a decision card, never prose
 * alone (an ask is always a card that rings). The host line (agi/actions.ts noticeLine) stays above
 * the card as the explanation; this is the card itself. Fixed host copy keyed by the typed boundary, no model words.
 * No electron import (gates load this file directly).
 */
export type AgiOwnerAskCardKind = PersistenceBoundaryKind | "app_restart";

type Copy = { header: string; question: string; options: Array<{ label: string; description?: string }> };
const COPY: Record<AgiOwnerAskCardKind, Record<"ko" | "en", Copy>> = {
  payment: {
    ko: { header: "결제 승인", question: "결제 승인이 필요해서 이 부분이 멈춰 있어요. 어떻게 할까요?",
      options: [{ label: "결제를 승인했어요, 이어가 주세요" }, { label: "결제하지 않을게요, 다른 방법을 찾아 주세요" }] },
    en: { header: "Payment approval", question: "A payment approval is needed, so this part is on hold. What should happen?",
      options: [{ label: "I approved the payment, continue" }, { label: "Do not pay, find another way" }] },
  },
  credential: {
    ko: { header: "로그인·인증 정보", question: "로그인이나 인증 정보가 필요해서 이 부분이 멈춰 있어요. 어떻게 할까요?",
      options: [{ label: "준비했어요, 이어가 주세요" }, { label: "지금은 어려워요, 이 부분은 건너뛰어 주세요" }] },
    en: { header: "Sign-in or credential", question: "A sign-in or credential is needed, so this part is on hold. What should happen?",
      options: [{ label: "It is ready, continue" }, { label: "Not now, skip this part" }] },
  },
  security_consent: {
    ko: { header: "보안 확인", question: "보안 확인(동의)이 필요해서 이 부분이 멈춰 있어요. 어떻게 할까요?",
      options: [{ label: "확인했어요, 이어가 주세요" }, { label: "동의하지 않을게요, 다른 방법을 찾아 주세요" }] },
    en: { header: "Security confirmation", question: "A security confirmation (consent) is needed, so this part is on hold. What should happen?",
      options: [{ label: "I confirm, continue" }, { label: "I do not consent, find another way" }] },
  },
  purpose_change: {
    ko: { header: "목표 변경", question: "목표 자체를 바꿔야 풀리는 일이라 이 부분이 멈춰 있어요. 어떻게 할까요?",
      options: [{ label: "목표를 바꿀게요, 아래에 적을게요" }, { label: "목표는 그대로 두고 다른 방법을 찾아 주세요" }] },
    en: { header: "Change the goal", question: "This only clears if the goal itself changes, so this part is on hold. What should happen?",
      options: [{ label: "I will change the goal, writing it below" }, { label: "Keep the goal and find another way" }] },
  },
  owner_stop: {
    ko: { header: "멈춘 목표", question: "멈춘 목표예요. 다시 시작할까요?",
      options: [{ label: "다시 시작해 주세요" }, { label: "계속 멈춰 두세요" }] },
    en: { header: "Stopped goal", question: "The goal is stopped. Restart it?",
      options: [{ label: "Restart it" }, { label: "Keep it stopped" }] },
  },
  app_restart: {
    ko: { header: "앱 다시 시작", question: "앱을 다시 시작하면 풀릴 것 같아요. 지금 다시 시작해도 될까요?",
      options: [{ label: "괜찮을 때 제가 다시 시작할게요" }, { label: "지금은 다시 시작하지 않을게요" }] },
    en: { header: "Restart the app", question: "Restarting the app should clear this. Is a restart fine now?",
      options: [{ label: "I will restart it when it suits me" }, { label: "Not restarting now" }] },
  },
};

/** The decision card for one typed owner ask, in the owner's language. */
export function agiOwnerAskCard(kind: AgiOwnerAskCardKind, locale: "ko" | "en"): AgentlasAskQuestion {
  const copy = COPY[kind][locale === "ko" ? "ko" : "en"];
  return { header: copy.header, question: copy.question, multiSelect: false, options: copy.options.map((option) => ({ ...option })) };
}

/** The same card for both languages, so the wiring can pick the owner's UI language at post time. */
export function agiOwnerAskCards(kind: AgiOwnerAskCardKind): { ko: AgentlasAskQuestion; en: AgentlasAskQuestion } {
  return { ko: agiOwnerAskCard(kind, "ko"), en: agiOwnerAskCard(kind, "en") };
}

export const AGI_OWNER_ASK_CARD_KINDS = Object.keys(COPY) as AgiOwnerAskCardKind[];
