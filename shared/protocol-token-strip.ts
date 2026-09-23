/**
 * 화면·기록에 남으면 안 되는 내부 프로토콜 토큰을 지운다.
 *
 * 실측(페르소나 루프 라운드 2 재시험, 2026-09-14): 모델이 대기 요청 형식(```agentlas-goal-wait 블록)을 지키지 않고
 * 산문에 `<<agentlas-goal-wait>>` 를 그대로 적어 채팅 화면에 노출됐다. 형식이 맞는 블록은 wait-emitter 가 파싱해 지우고,
 * 질문 펜스(`<<agentlas-ask>>{…}`)는 질문 카드가 되므로 건드리지 않는다 — JSON 이 따라오지 않는 맨 토큰만 지운다.
 */
import { stripEffectObservationMarker } from "./effect-observation";

// 라운드 3 실측: <<stormbreaker-continue>> 도 채팅·기억란에 그대로 보였다 — agentlas- 접두가 없는 표식까지 포함.
const STRAY_TOKEN_RE = /[ \t]*<<(?:agentlas-(?:goal-wait|goal-complete|continue)|stormbreaker-(?:continue|long-run))(?::[^>\n]*)?>>[ \t]*(?!\s*\{)/g;

export function stripStrayProtocolTokens<T extends string | null | undefined>(text: T): T | string {
  if (typeof text !== "string" || !text.includes("<<")) return text;
  // 효과 관찰 표식(<<agentlas-effect-observation>>{…})은 JSON 을 달고 오지만 질문 카드가 아니라
  // Main 만 읽는 판정 줄이다 — 화면·기록 어디에도 남기지 않는다.
  return stripEffectObservationMarker(text).replace(STRAY_TOKEN_RE, (match, offset: number, whole: string) => {
    // 줄 전체가 토큰뿐이면 줄까지 지운다.
    const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = whole.indexOf("\n", offset + match.length);
    const line = whole.slice(lineStart, lineEnd < 0 ? whole.length : lineEnd);
    return line.trim() === match.trim() ? "" : " ";
  }).replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}
