/**
 * 런타임 거절 고지문 판별 — **표식이 없는 런타임을 위한 최후 수단, 이 저장소에서 이 파일 하나뿐.**
 *
 * 원칙(2026-08-06 실측 사고에서): 실패 판정은 런타임의 기계 표식(RunnerResult.failure)으로
 * 한다. 텍스트 모양을 보는 것은 표식을 아예 안 주는 케이스(실측: codex 한도 — 거절문이
 * agent_message로 오고 turn.completed, 표식 0)에서만 허용되고, 그 판별 로직은 여기 한 곳에만
 * 산다. 흩어지면 조율 불가능한 키워드 그물이 여러 벌 생긴다.
 *
 * 오탐 방어(이게 이 모듈의 존재 이유다):
 *  - 전체 출력이 짧을 때만(고지문은 한두 문장이다 — 긴 답 속의 "429" 언급은 산출물).
 *  - 구조(JSON·코드펜스·다문단)가 보이면 산출물로 간주.
 *  - 앵커된 고지 문구만 — 낱말 하나로 판정하지 않는다.
 *  - 판별 결과는 항상 source:"heuristic"으로 표기 — 화면은 단정 대신 완곡하게,
 *    원문은 저널에 보존.
 *
 * 쌍둥이: agentlas_terminal/engine/runtime-refusal.cjs (수동 동기 — 런타임 계층은
 * 미러 코드가 아니라 패리티 게이트가 없다. 규칙을 바꾸면 양쪽을 같이 바꿀 것.)
 */
import type { RunnerFailureKind } from "./runner";

const MAX_NOTICE_LENGTH = 400;

const NOTICE_PATTERNS: RegExp[] = [
  /\byou'?ve hit\b/i,
  /\busage limit\b/i,
  /\brate.?limit(ed)?\b/i,
  /\bquota (exceeded|reached)\b/i,
  /\bresets? (at|on)\b/i,
  /\btry again (at|later)\b/i,
  /\bupgrade to\b/i,
  /\bpurchase more credits\b/i,
  /\bout of credits\b/i,
  /\bplease (log ?in|sign ?in)\b/i,
  /\bnot logged in\b/i,
  /\b(login|session|token) (expired|invalid)\b/i,
  /\bsubscription (required|expired)\b/i,
];

function kindOf(text: string): RunnerFailureKind {
  if (/\b(log ?in|sign ?in|logged in|expired|unauthorized|subscription)\b/i.test(text)) return "auth";
  if (/\b(limit|quota|credits?|resets?|try again)\b/i.test(text)) return "quota";
  return "refused";
}

/** 텍스트가 산출물이 아니라 거절 고지문인가. */
export function detectRuntimeRefusal(text: string): { kind: RunnerFailureKind; message: string } | null {
  const t = String(text || "").trim();
  if (!t || t.length > MAX_NOTICE_LENGTH) return null;
  if (t.includes("{") || t.includes("```") || /\n\s*\n/.test(t)) return null;
  if (!NOTICE_PATTERNS.some((re) => re.test(t))) return null;
  return { kind: kindOf(t), message: t };
}
