/*
 * Agentlas 서빙 모델 — 데스크탑이 고를 수 있는 세기 세 개.
 *
 * ── 왜 세기만 있나 ──
 * CLI 도 API 키도 없는 사람에게 "어떤 모델을 쓰시겠습니까"는 답할 수 없는 질문이다.
 * 고를 것은 **얼마나 세게 생각하게 할 것인가** 하나면 충분하다(오너 지시 2026-08-23).
 *
 * ── 모델 이름이 여기 없는 이유 ──
 * 세기 뒤에 어떤 모델이 도는지는 언제든 바꿀 제품 결정이고, 사용자에게 알리지 않는다.
 * 실제 모델 id 는 서버(웹) 한 곳에만 있고 데스크탑은 세기만 보낸다 — 앱 안에 적어 두면
 * 설치본을 뜯는 것만으로 드러나므로, 앱은 아예 모르는 것이 옳다.
 */

export type AgentlasServingTier = "light" | "normal" | "hard";

export interface AgentlasServingModel {
  /** 서버에 그대로 보내는 값. 웹 모델 카탈로그의 별칭과 같은 문자열이어야 한다. */
  id: string;
  tier: AgentlasServingTier;
  label: string;
  ko: string;
  en: string;
}

export const AGENTLAS_SERVING_MODELS: AgentlasServingModel[] = [
  {
    id: "agentlas-hard",
    tier: "hard",
    label: "Agentlas Hard",
    ko: "가장 깊게 생각합니다. 어려운 판단과 긴 기획에.",
    en: "Thinks deepest. For hard calls and long planning.",
  },
  {
    id: "agentlas-normal",
    tier: "normal",
    label: "Agentlas Normal",
    ko: "균형 잡힌 주력. 대부분의 일은 이걸로 충분합니다.",
    en: "Balanced workhorse. Enough for most work.",
  },
  {
    id: "agentlas-light",
    tier: "light",
    label: "Agentlas Light",
    ko: "빠르고 가볍습니다. 짧은 대화와 정리에.",
    en: "Fast and light. For short chats and tidying up.",
  },
];

export const AGENTLAS_SERVING_DEFAULT_MODEL = "agentlas-normal";

const BY_ID = new Map(AGENTLAS_SERVING_MODELS.map((model) => [model.id, model]));

export function isAgentlasServingModel(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id.trim());
}

export function agentlasServingModel(id: string | null | undefined): AgentlasServingModel | undefined {
  return id ? BY_ID.get(id.trim()) : undefined;
}

/** 화면 라벨 — "Agentlas Normal" 처럼 세기 이름만 보인다. */
export function agentlasServingLabel(id: string | null | undefined, locale: "ko" | "en" = "ko"): string {
  const model = agentlasServingModel(id);
  if (!model) return locale === "ko" ? "Agentlas 모델" : "Agentlas model";
  return model.label;
}
