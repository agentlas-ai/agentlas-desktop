import { nodeDeclaresOutwardEffect } from "./graph-node-protocol";
import type { AutomationToolMode } from "./types";

// The English+Korean wordlists that used to live here are GONE.
//
// They decided whether an automation was forced onto the slow screen-driving path, so the
// same job written in Arabic, Tagalog, or any other language simply fell through — and the
// broad words it did know ("web", "search", "account", "post") pushed unrelated jobs onto
// the brittle path. No hand-maintained list can enumerate every language, so no list decides
// here anymore: the resident judge rules by meaning, and an unjudged run keeps the neutral
// "auto" mode instead of guessing from words.
//
// What survives is FORMAT detection, not meaning: a literal product name, the CDP port, the
// remote-debugging flag. Those are identifiers — finite, language-independent, and correct
// to match exactly.
const EXACT_AGENTLAS_BROWSER_PATTERNS = [
  /\bAgentlas\s+Browser\b/i,
  /\b(?:CDP|remote[- ]debugging)\b/i,
  /(?:127\.0\.0\.1|localhost):9222/i,
  /로그인된\s*(?:에이전틀라스\s*)?브라우저/i,
];

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export const COMPUTER_USE_JUDGMENT_KIND = "automation-needs-human-web";

/**
 * Whether this automation should be forced onto the slow computer-use path.
 *
 * ONLY the resident judge decides. No verdict (no model reachable, or nothing warmed the
 * cache yet) means NO forcing: the run stays on the neutral "auto" path, where the browser
 * and Computer Use hosts are still reachable if the task or the user asks for them. Guessing
 * "yes" from words was what diverted file/API jobs into brittle screen driving, and guessing
 * from an English/Korean list silently skipped every other language.
 */
export function shouldPreferComputerUseForAutomation(
  text: string,
  judged?: (text: string) => boolean | null,
): boolean {
  if (!text.trim()) return false;
  return judged?.(text) === true;
}

/**
 * 이 그래프가 바깥으로 나가는 단계를 하나라도 가지고 있는가.
 *
 * 그래프가 스스로 "전부 읽기"라고 선언했다면, 이름을 보고 추측한 판단보다 **그 선언이 강하다.**
 * 실사용 실측: 사용자가 "화면에만 보여주세요"라고 답해 전 단계가 read로 만들어진 자동화가,
 * 이름에 "인스타"가 들어갔다는 이유로 컴퓨터 조종(computer-use)으로 올라갔다.
 * 그리고 접근성 권한이 없다고 실행이 막혔다 — 사용자는 "화면에만 보여준다면서 왜 내 컴퓨터를
 * 조종하려 하나" 하고 무서워했다. 바깥에 나갈 단계가 없으면 조종할 것도 없다.
 */
export function graphTouchesOutside(graph: unknown): boolean {
  const nodes = (graph as { nodes?: Array<{ config?: Record<string, unknown> }> } | null)?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return true; // 모르면 좁히지 않는다
  // ★선언된 effect 만 보면 emitter 가 만든 출력 노드(칸이 아예 없음)가 안 보인다 —
  //   그 노드의 기본값은 "바깥으로 나감"이라, 발행 자동화가 "안 나간다"로 읽혔다.
  return nodes.some((node) => nodeDeclaresOutwardEffect(node as { type?: string; config?: Record<string, unknown> }));
}

export function resolveAutomationToolMode(input: {
  toolMode?: AutomationToolMode | null;
  name?: string | null;
  promptTemplate?: string | null;
  targetLabel?: string | null;
  /** 이 자동화의 그래프. 전 단계가 읽기면 바깥 도구로 올리지 않는다. */
  graph?: unknown;
  /** Synchronous read of a judged verdict for this text (see peekJudgment). */
  judged?: (text: string) => boolean | null;
}): AutomationToolMode {
  if (input.toolMode === "browser" || input.toolMode === "computer-use") return input.toolMode;
  /*
   * ★그래프가 있으면 toolMode는 **단계 선언에서만** 나온다 — 이름·프롬프트 추측 금지.
   *
   * 그래프의 capability 어휘는 닫혀 있고(needs — graph-tool-binding.ts CAPABILITIES),
   * 그 어휘에 화면 조작은 **없다**. 즉 그래프는 구조적으로 화면 조작을 선언할 수 없으므로
   * 그래프 기반 자동화를 computer-use로 올릴 근거 자체가 존재하지 않는다.
   *
   * 실측(2026-08-06): 웹 검색+초안+파일 저장뿐인 X 그래프가 이름에 "X(트위터)"가
   * 들어갔다는 이유로 판정 모델이 computer-use를 골랐고, 접근성 권한이 없어 **실행
   * 자체가 스킵**됐다(needs_input). 판정 프롬프트가 "Merely mentioning a site is NOT
   * a reason"이라 경고까지 하고 있었지만, 경고는 구조가 아니다.
   *
   * 어휘에 화면 조작 capability가 생기는 날, 여기가 그것을 읽는 자리다.
   * 텍스트 판정은 그래프 없는 레거시 단일 프롬프트 전용으로 남는다.
   */
  if (input.graph !== undefined) return "auto";
  const text = [input.name ?? "", input.promptTemplate ?? "", input.targetLabel ?? ""].join("\n");
  // Exact real-login browser intent outranks the generic social-site heuristic.
  // Otherwise a Reddit job that explicitly says "Agentlas Browser / 9222" is silently
  // diverted into Computer Use and loses the authenticated CDP session.
  if (hasAny(text, EXACT_AGENTLAS_BROWSER_PATTERNS)) return "browser";
  return shouldPreferComputerUseForAutomation(text, input.judged) ? "computer-use" : "auto";
}

/** Question the resident judge answers for COMPUTER_USE_JUDGMENT_KIND. */
export const COMPUTER_USE_JUDGMENT_QUESTION =
  "Does completing this automation require driving a human-facing website in a real browser session (logging in, clicking, typing into a page), as opposed to work that can be done with files, APIs, or tools?";

export const COMPUTER_USE_JUDGMENT_GUIDANCE =
  "Answer yes only when the task genuinely has to operate a web UI as a signed-in human. Merely mentioning a " +
  "site, or using words like web/search/account/post/upload for something that is actually file, API, or " +
  "message work, is NOT a reason to drive a browser.";
