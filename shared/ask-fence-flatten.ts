// <<agentlas-ask>> 펜스의 **평문 렌더러** — 창 없는 표면(텔레그램·모바일 브리지)용.
//
// ★왜 있나 (InteractiveChannel 규칙, UNIVERSAL-RUNTIME-FEATURES-PLAN §2.3):
// 질문 펜스는 와이어 포맷이고 데스크탑 바텀시트는 렌더러 하나일 뿐이다. 시트를 못
// 그리는 표면은 질문을 **지우는 게 아니라 평문으로 렌더**해야 한다 — 지우면 사용자는
// 질문받은 사실조차 모른 채 대화가 멎는다(모바일에서 실제로 그랬다: sanitize 가
// stripAgentControlBlocks 로 펜스를 통째 제거했고, 텔레그램만 자기 평문화기를 갖고
// 있었다). 표면마다 손으로 다시 짜면 한 표면씩 빠진다 — 그래서 한 벌이 소유한다.
import { AGENT_ASK_OPEN, AGENT_ASK_CLOSE } from "./agent-control-blocks";
import { renderPlainAskBody } from "./ask-plaintext";
import { isUnfilledQuestionTemplate } from "./types";

export interface AgentlasAskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface ExtractedAskFences {
  /** Model prose with every complete or partial wire fence removed. */
  text: string;
  /** Only complete, bounded, user-answerable questions. */
  questions: AgentlasAskQuestion[];
}

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 8;

/** Parse one fence body without granting it approval or execution authority. */
export function parseAskFenceBody(body: string): AgentlasAskQuestion | null {
  const stripped = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const question = typeof raw.question === "string" ? raw.question.trim().slice(0, 4_000) : "";
  const header = typeof raw.header === "string" ? raw.header.trim().slice(0, 200) : "";
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return [];
        const item = option as Record<string, unknown>;
        const label = typeof item.label === "string" ? item.label.trim().slice(0, 200) : "";
        if (!label) return [];
        const description = typeof item.description === "string"
          ? item.description.trim().slice(0, 1_000)
          : "";
        return [{ label, ...(description ? { description } : {}) }];
      }).slice(0, MAX_OPTIONS)
    : [];
  if (!question || options.length < 2) return null;
  if (isUnfilledQuestionTemplate({ question, ...(header ? { header } : {}), options })) return null;
  return {
    question,
    ...(header ? { header } : {}),
    options,
    multiSelect: raw.multiSelect === true,
  };
}

/**
 * Split display prose from the ask wire format. An unfinished final/streaming
 * tail is hidden rather than exposed; the next cumulative chunk can parse it
 * once the closing marker arrives.
 */
export function extractAskFences(text: unknown): ExtractedAskFences {
  if (typeof text !== "string" || !text.includes(AGENT_ASK_OPEN)) {
    return { text: typeof text === "string" ? text : "", questions: [] };
  }
  const questions: AgentlasAskQuestion[] = [];
  let visible = "";
  let rest = text;
  for (let guard = 0; guard < 64; guard += 1) {
    const open = rest.indexOf(AGENT_ASK_OPEN);
    if (open < 0) {
      visible += rest;
      return { text: visible, questions };
    }
    visible += rest.slice(0, open);
    const afterOpen = rest.slice(open + AGENT_ASK_OPEN.length);
    const close = afterOpen.indexOf(AGENT_ASK_CLOSE);
    if (close < 0) return { text: visible, questions };
    const parsed = parseAskFenceBody(afterOpen.slice(0, close));
    if (parsed && questions.length < MAX_QUESTIONS) questions.push(parsed);
    rest = afterOpen.slice(close + AGENT_ASK_CLOSE.length);
  }
  // Adversarially many fences fail closed. No unparsed control payload reaches
  // a display surface from the truncated tail.
  return { text: visible, questions };
}

/** Rebuild only validated fields for durable legacy consumers. */
export function canonicalAskFenceText(questions: AgentlasAskQuestion[]): string {
  return questions.slice(0, MAX_QUESTIONS).map((question) => (
    `${AGENT_ASK_OPEN}${JSON.stringify({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      multiSelect: question.multiSelect,
      options: question.options,
    })}${AGENT_ASK_CLOSE}`
  )).join("\n\n");
}

/** 펜스 본문(JSON)을 사람이 읽을 질문+선택지 텍스트로 바꾼다. 파싱 실패 시 null. */
export function flattenAskFenceBody(body: string, replyLocale: "ko" | "en"): string | null {
  return renderPlainAskBody(body, replyLocale);
}

/**
 * 텍스트 안의 모든 ask 펜스를 평문 질문으로 바꾼다.
 * - 닫는 펜스가 없으면(스트리밍 잔재) 열림 마커만 제거하고 본문은 보존.
 * - 본문 파싱 실패 시 펜스를 통째 제거(raw 노출 방지).
 */
export function flattenAskFences(text: string, replyLocale: "ko" | "en"): string {
  if (!text.includes(AGENT_ASK_OPEN)) return text;
  let result = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf(AGENT_ASK_OPEN);
    if (open < 0) {
      result += rest;
      break;
    }
    result += rest.slice(0, open);
    const afterOpen = rest.slice(open + AGENT_ASK_OPEN.length);
    const close = afterOpen.indexOf(AGENT_ASK_CLOSE);
    if (close < 0) {
      // 닫는 펜스가 아직 없다(스트리밍 중). 본문을 남기면 안 된다 — 그것은 사람이 읽을
      // 글이 아니라 JSON 와이어 포맷이라, 실측(2026-08-20)에서 휴대폰에 `{"question":`
      // 조각이 그대로 떴다. 완성된 텍스트는 다음 투영에서 통째로 다시 오므로, 여기서는
      // 열림 마커부터 끝까지 버린다(다 온 뒤에 질문이 평문으로 보인다).
      break;
    }
    const flat = flattenAskFenceBody(afterOpen.slice(0, close), replyLocale);
    result += flat ?? "";
    rest = afterOpen.slice(close + AGENT_ASK_CLOSE.length);
  }
  return result;
}
