  
                                         
  
                 
                                                      
                                                          
  
                        
                                                   
                                                       
                                       
   

export type AgentlasServingTier = "light" | "normal" | "hard";

/** Desktop-visible conservative window used for prompt compaction and routing.
 * The server may use a different backing model, but every serving tier accepts
 * this public request budget. */
export const AGENTLAS_SERVING_CONTEXT_WINDOW = 128_000;

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

/**
 Light is served by a model whose price steps up for the WHOLE request once the input passes 100K tokens. Light therefore
 admits and rotates against 100K, which puts the generation boundary (80% of the window) at 80K, clear of that step even when
 the local token estimate is off by a fifth. Ordinary use never reaches it; this bounds a long conversation. Normal and Hard
 keep the 128K window.
 */
export const AGENTLAS_SERVING_LIGHT_CONTEXT_WINDOW = 100_000;

/** The window a serving tier admits and rotates against; unknown ids get the shared ceiling. */
export function agentlasServingContextWindow(id: unknown): number {
  const tier = typeof id === "string" ? BY_ID_TIER(id) : undefined;
  return tier === "light" ? AGENTLAS_SERVING_LIGHT_CONTEXT_WINDOW : AGENTLAS_SERVING_CONTEXT_WINDOW;
}

const BY_ID = new Map(AGENTLAS_SERVING_MODELS.map((model) => [model.id, model]));

function BY_ID_TIER(id: string): AgentlasServingTier | undefined {
  return BY_ID.get(id.trim())?.tier;
}

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
