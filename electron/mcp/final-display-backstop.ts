/**
 * ★최종 답 표시 위생 백스톱 — 실행 갈래가 몇 개든 반드시 지나는 단 한 곳.
 *
 * 실측 사고(2026-08-08): firm 채팅의 최종 답이 `<<agentlas-surface>> { ... }` JSON
 * 원문 그대로 화면에 뜨고 chat_messages에도 그대로 저장됐다(제품 DB 실물 확인).
 * 진범은 서피스 파서가 아니라 **경로 구조**였다 — 정리(parseSurfaces)는 client.ts의
 * 단일 에이전트 경로 한 곳에만 있고, firm/swarm/borrowed-task-force처럼
 * `earlyResult()`로 빠지는 20여 갈래는 그 단계를 통째로 건너뛴다. 갈래마다 정리를
 * 복붙하는 수리는 다음에 생기는 갈래가 또 새게 만든다.
 *
 * 그래서 정리를 **sink 래퍼**(모든 이벤트가 예외 없이 지나는 자리)에 둔다.
 * 이미 정리된 텍스트에는 여는 울타리가 없으므로 이 함수는 멱등이다 — 정상 경로는
 * 아무 영향도 받지 않는다.
 *
 * 원칙 두 가지:
 *  - **원문을 절대 흘리지 않는다.** 파싱이 실패해도 자르는 쪽을 택한다.
 *  - **값을 버리지 않는다.** 유효한 매니페스트는 삭제가 아니라 surface 이벤트로
 *    승격해 원래 보여야 했던 화면을 보여준다.
 */
import type {
  AgentlasSurfaceManifest,
  AgentlasUserDecisionRequest,
} from "../../shared/types";
import { stripAgentControlBlocks } from "../../shared/agent-control-blocks";
import {
  canonicalAskFenceText,
  extractAskFences,
} from "../../shared/ask-fence-flatten";
import { SURFACE_OPEN_FENCE, parseSurfaces } from "../surface-emitter";
import { SURFACE_INTENT_MARKER } from "../runtime/runner";

export interface FinalDisplayBackstopResult {
  /** 사용자에게 보여도 되는 텍스트. 프로토콜 원문은 여기 남지 않는다. */
  text: string;
  /**
   * Main-private assistant body. It contains only canonical, validated ask
   * fences so existing confirmation/reload consumers keep the exact Decision.
   */
  durableText: string;
  /** A question request is not an approval or an execution grant. */
  userDecisionRequest?: AgentlasUserDecisionRequest;
  /** 텍스트에서 건져 올린 유효 매니페스트 — 호출부가 surface 이벤트로 승격한다. */
  surfaces: AgentlasSurfaceManifest[];
  /** 무언가 잘라냈는가(게이트·로그용). false면 입력이 이미 깨끗했다는 뜻. */
  changed: boolean;
}

function surfaceReadyLine(locale: string): string {
  return locale === "ko" ? "여기 결과를 정리해 두었어요." : "Here's your result.";
}

function surfaceDroppedLine(locale: string): string {
  return locale === "ko"
    ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
    : "Something went wrong while preparing this result, so it is not complete.";
}

/** 값 없이 순수하게 잘라내도 되는 마커들(프로토콜 제어 문자열). */
function stripBareMarkers(text: string): string {
  // Surface fences must remain intact until parseSurfaces has had a chance to
  // promote their manifest into a structured event. Other control markers are
  // removed after that parse boundary.
  return text.split(SURFACE_INTENT_MARKER).join("");
}

/** U+FFFD는 이미 upstream 바이트 디코딩이 깨졌다는 뜻이다. 원문을 다시
 * 사용자에게 보여주지 않고, 누락된 부분만 짧은 생략부호로 표시한다. */
function sanitizeDisplayText(text: string): string {
  return stripAgentControlBlocks(text).replace(/\uFFFD+/gu, "…");
}

function decisionProjection(text: string): {
  visibleText: string;
  durableAskText: string;
  userDecisionRequest?: AgentlasUserDecisionRequest;
} {
  const extracted = extractAskFences(text);
  if (extracted.questions.length === 0) {
    return { visibleText: extracted.text, durableAskText: "" };
  }
  return {
    visibleText: extracted.text,
    durableAskText: canonicalAskFenceText(extracted.questions),
    userDecisionRequest: {
      schemaVersion: "agentlas.user-decision-request.v1",
      questions: extracted.questions,
    },
  };
}

function durableDisplayText(visibleText: string, durableAskText: string): string {
  return [visibleText.trim(), durableAskText].filter(Boolean).join("\n\n");
}

/**
 * @param allowSurfaceRender 신뢰 경계. Agent App 같은 미신뢰 실행에서는 모델이 쓴
 *   매니페스트를 렌더하지 않는다 — 그때는 조용히 잘라내기만 한다.
 */
export function applyFinalDisplayBackstop(
  rawText: unknown,
  opts: { locale: string; allowSurfaceRender: boolean },
): FinalDisplayBackstopResult {
  const original = typeof rawText === "string" ? rawText : "";
  const withoutMarkers = stripBareMarkers(original);
  if (!withoutMarkers.includes(SURFACE_OPEN_FENCE)) {
    const decision = decisionProjection(withoutMarkers);
    const cleaned = sanitizeDisplayText(decision.visibleText);
    return {
      text: cleaned,
      durableText: durableDisplayText(cleaned, decision.durableAskText),
      ...(decision.userDecisionRequest ? { userDecisionRequest: decision.userDecisionRequest } : {}),
      surfaces: [],
      changed: cleaned !== original,
    };
  }

  let parsed: ReturnType<typeof parseSurfaces>;
  try {
    parsed = parseSurfaces(withoutMarkers);
  } catch {
    // 파서가 넘어져도 원문은 못 나간다. 거절된 본문은 로그에도 남기지 않는다 —
    // Main 전용 전송값이나 로컬 경로가 들어 있을 수 있다.
    const text = surfaceDroppedLine(opts.locale);
    return { text, durableText: text, surfaces: [], changed: true };
  }

  const surfaces = opts.allowSurfaceRender ? parsed.surfaces.map((entry) => entry.manifest) : [];
  const decision = decisionProjection(parsed.cleanedText);
  const cleaned = sanitizeDisplayText(decision.visibleText).trim();
  const text = cleaned || (surfaces.length > 0 ? surfaceReadyLine(opts.locale) : surfaceDroppedLine(opts.locale));
  return {
    text,
    durableText: durableDisplayText(text, decision.durableAskText),
    ...(decision.userDecisionRequest ? { userDecisionRequest: decision.userDecisionRequest } : {}),
    surfaces,
    changed: true,
  };
}
