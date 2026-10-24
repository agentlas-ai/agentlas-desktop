import type { RuntimeSelection } from "./types";

/**
 * Where the personal agent's (Hope's) conversation turns are processed: the owner's own lane, or Agentlas's light model
 * (owner decision 2026-10-21). Pure, with no Electron, Node or renderer imports, so Main, the daemon and the renderers
 * read the same rules.
 *
 * - "own-lane" is the default and changes nothing: Hope runs the runtime the owner chose (subscription CLI, API key,
 *   local model).
 * - "agentlas" runs Hope's conversation turns on the Agentlas serving endpoint at the light tier. It takes effect only
 *   after the owner has confirmed the one-time notice (`notice === "confirmed"`), because it sends the conversation to
 *   the Agentlas server and its model provider for the first time for an owner who only used a CLI. Work sessions,
 *   teammates and every other surface are not affected: only the personal conversation's reply turn reads this.
 */
export const ONE_FRONT_CONTRACT_VERSION = "1.0.0" as const;

export const PERSONAL_AGENT_FRONTS = ["own-lane", "agentlas"] as const;
export type PersonalAgentFront = (typeof PERSONAL_AGENT_FRONTS)[number];

/** unseen: the notice has not been answered; confirmed: the owner accepted it; declined: the owner kept their own CLI. */
export const PERSONAL_AGENT_FRONT_NOTICES = ["unseen", "confirmed", "declined"] as const;
export type PersonalAgentFrontNotice = (typeof PERSONAL_AGENT_FRONT_NOTICES)[number];

export const ONE_FRONT_NOTICE_RESOLUTIONS = ["confirm", "keep-own-lane"] as const;
export type OneFrontNoticeResolution = (typeof ONE_FRONT_NOTICE_RESOLUTIONS)[number];

/** Why the last turn was not answered by the light model. Machine facts only; the words live in oneFrontFallbackCopy. */
export const ONE_FRONT_FALLBACK_CAUSES = ["credits", "signin", "busy", "unavailable"] as const;
export type OneFrontFallbackCause = (typeof ONE_FRONT_FALLBACK_CAUSES)[number];

export interface OneFrontFallback {
  cause: OneFrontFallbackCause;
  at: string;
}

export interface OneFrontState {
  contractVersion: typeof ONE_FRONT_CONTRACT_VERSION;
  version: number;
  front: PersonalAgentFront;
  notice: PersonalAgentFrontNotice;
  /** The newest turn that left the light model for the owner's own lane; cleared by the next turn it answers. */
  fallback: OneFrontFallback | null;
  updatedAt: string;
}

/** What a renderer reads: the stored state plus two derived facts. */
export interface OneFrontView extends OneFrontState {
  /** true only when Hope's next turn runs on the light model: front is agentlas and the notice is confirmed. */
  effective: boolean;
  /** Whether the owner has another runtime to continue on ("keep my CLI" is offered only then). */
  ownLaneAvailable: boolean;
}

export interface SetOneFrontInput {
  expectedVersion: number;
  front: PersonalAgentFront;
  confirmedByUser: true;
}

export interface AcknowledgeOneFrontNoticeInput {
  expectedVersion: number;
  resolution: OneFrontNoticeResolution;
  confirmedByUser: true;
}

/** The serving tier id the front runs on. It is the same string the serving catalog and the model chip use. */
export const ONE_FRONT_MODEL = "agentlas-light";

/**
 * The selection a front turn carries. It names no source, label or effort on purpose: a chip pin chosen by hand on the
 * serving runtime carries a source, so the two never read as the same thing (isOneFrontSelection).
 */
export const ONE_FRONT_SELECTION: Readonly<RuntimeSelection> = Object.freeze({
  kind: "agentlas",
  backend: "agentlas",
  model: ONE_FRONT_MODEL,
  longContext: false,
  role: "orchestrator",
  inherit: false,
});

export function isOneFrontSelection(value: RuntimeSelection | null | undefined): boolean {
  return Boolean(value) && value!.kind === "agentlas" && value!.model === ONE_FRONT_MODEL
    && !value!.source && !value!.label && !value!.effort && !value!.acpAgentId;
}

export function oneFrontEffective(state: Pick<OneFrontState, "front" | "notice">): boolean {
  return state.front === "agentlas" && state.notice === "confirmed";
}

/** The stored default: nothing changes until the owner opts in. */
export function defaultOneFrontState(now = new Date()): OneFrontState {
  return { contractVersion: ONE_FRONT_CONTRACT_VERSION, version: 1, front: "own-lane", notice: "unseen", fallback: null,
    updatedAt: now.toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isOneFrontState(value: unknown): value is OneFrontState {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => !["contractVersion", "version", "front", "notice", "fallback", "updatedAt"].includes(key))) return false;
  if (value.contractVersion !== ONE_FRONT_CONTRACT_VERSION) return false;
  if (!Number.isSafeInteger(value.version) || (value.version as number) <= 0) return false;
  if (!PERSONAL_AGENT_FRONTS.includes(value.front as PersonalAgentFront)) return false;
  if (!PERSONAL_AGENT_FRONT_NOTICES.includes(value.notice as PersonalAgentFrontNotice)) return false;
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) return false;
  if (value.fallback === null) return true;
  return isRecord(value.fallback)
    && Object.keys(value.fallback).every(key => key === "cause" || key === "at")
    && ONE_FRONT_FALLBACK_CAUSES.includes(value.fallback.cause as OneFrontFallbackCause)
    && typeof value.fallback.at === "string" && !Number.isNaN(Date.parse(value.fallback.at));
}

/** The cause a typed failure of the serving endpoint stands for. Kind and code only; the message is never read. */
export function oneFrontFallbackCause(failure: { kind?: string; providerCode?: string } | null | undefined,
  cooldownKind?: string): OneFrontFallbackCause {
  const kind = failure?.kind ?? cooldownKind;
  if (kind === "quota") return "credits";
  if (kind === "auth") return "signin";
  if (kind === "rate_limit") return "busy";
  return "unavailable";
}

/** Names for the owner's own runtimes that the app's runner labels leave as the raw kind. */
export const ONE_FRONT_OWN_LANE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ollama: "Ollama", lmstudio: "LM Studio", mlx: "MLX", "agentlas-local": "Agentlas Local", byok: "API key",
});

type Locale = "ko" | "en";

/**
 * The owner-facing words, written without model, provider or error names. `own` names the runtime the turn moved to
 * ("Claude", "Codex" …) when the caller knows it; the sentence reads without it.
 */
export function oneFrontFallbackCopy(cause: OneFrontFallbackCause, locale: Locale, own?: string): { lead: string; next: string } {
  const to = own?.trim() ? (locale === "ko" ? `${own.trim()}(내 CLI)` : `${own.trim()} (your CLI)`) : (locale === "ko" ? "내 CLI" : "your own CLI");
  if (locale === "ko") {
    switch (cause) {
      case "credits": return { lead: `현재 무료 사용량과 크레딧으로 처리할 수 없어, 이번 답변은 ${to}로 처리했습니다.`,
        next: "빠른 답변을 다시 사용하려면 사용 가능한 무료 사용량이나 크레딧을 확인해 주세요." };
      case "signin": return { lead: `Agentlas에 로그인되어 있지 않아, 이번 답변은 ${to}로 처리했습니다.`,
        next: "다시 로그인하면 빠른 답변을 자동으로 다시 씁니다." };
      case "busy": return { lead: `Agentlas 서버가 잠시 붐벼서, 이번 답변은 ${to}로 처리했습니다.`,
        next: "잠시 뒤에는 빠른 답변을 자동으로 다시 씁니다." };
      default: return { lead: `Agentlas 서버에 연결하지 못해, 이번 답변은 ${to}로 처리했습니다.`,
        next: "연결이 돌아오면 빠른 답변을 자동으로 다시 씁니다." };
    }
  }
  switch (cause) {
    case "credits": return { lead: `Available free use and credits could not cover this reply, so it went to ${to}.`,
      next: "To use fast replies again, check your available free use or credits." };
    case "signin": return { lead: `You are not signed in to Agentlas, so this reply went to ${to}.`,
      next: "Fast replies come back on their own once you sign in again." };
    case "busy": return { lead: `The Agentlas server is busy for a moment, so this reply went to ${to}.`,
      next: "Fast replies come back on their own in a moment." };
    default: return { lead: `The Agentlas server could not be reached, so this reply went to ${to}.`,
      next: "Fast replies come back on their own once the connection returns." };
  }
}

/** The one-time notice. No model name: the owner is told what is processed where, what it costs and what stays theirs. */
export function oneFrontNoticeCopy(locale: Locale): {
  title: string; body: string[]; confirm: string; keepOwnLane: string; settingsLabel: string; settingsHint: string;
} {
  if (locale === "ko") {
    return {
      title: "개인 에이전트의 빠른 답변",
      body: [
        "개인 에이전트의 빠른 답변은 Agentlas 서버의 가벼운 모델로 처리됩니다.",
        "대화 내용이 Agentlas 서버와 모델 제공사에 전달됩니다.",
        "제공되는 무료 사용량이 있으면 먼저 사용하고, 그 외에는 크레딧을 사용합니다.",
      ],
      confirm: "확인",
      keepOwnLane: "내 CLI로 계속 쓰기",
      settingsLabel: "개인 에이전트의 빠른 답변을 Agentlas로 처리",
      settingsHint: "켜면 개인 에이전트와의 대화 내용이 Agentlas 서버와 모델 제공사에 전달됩니다. 제공되는 무료 사용량이 있으면 먼저 사용하고, 그 외에는 크레딧을 사용합니다. 작업 세션은 지금처럼 내가 고른 실행 환경에서 돌아갑니다.",
    };
  }
  return {
    title: "Fast replies from your personal agent",
    body: [
      "Your personal agent's fast replies are handled by a light model on the Agentlas server.",
      "What you say in the conversation is sent to the Agentlas server and its model provider.",
      "Any available free use is applied first; otherwise, credits are used.",
    ],
    confirm: "OK",
    keepOwnLane: "Keep using my CLI",
    settingsLabel: "Handle the personal agent's fast replies on Agentlas",
    settingsHint: "When on, what you say to the personal agent is sent to the Agentlas server and its model provider. Any available free use is applied first; otherwise, credits are used. Work sessions keep running on the runtime you chose.",
  };
}
