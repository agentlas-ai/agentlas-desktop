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
  // ── 모델이 쓴 기계 자기보고 (2026-08-08 ollama 실측) ──
  // "The system encountered a timeout error while processing a request. No further
  // function calls are required. Please retry the operation..." — 도구 왕복이 무너진 뒤
  // 로컬 모델이 뱉은 문장이 최종 답으로 저장됐다. 이건 사람에게 하는 답이 아니라
  // 프로토콜 잡담이다. 짧고 구조 없는 출력에서만 보므로 산출물 오탐 여지가 거의 없다.
  /\bno further (function|tool) calls?\b/i,
  /\bsystem encountered (a|an) [a-z]+ error\b/i,
  /\bretry the (operation|request)\b/i,
];

function kindOf(text: string): RunnerFailureKind {
  if (/\btimed? ?out\b|\btimeout\b/i.test(text)) return "timeout";
  if (/\b(log ?in|sign ?in|logged in|expired|unauthorized|subscription)\b/i.test(text)) return "auth";
  if (/\b(limit|quota|credits?|resets?|try again)\b/i.test(text)) return "quota";
  return "refused";
}

/*
 * ── 승인 대기로 막힌 도구 호출 ────────────────────────────────────────────────
 *
 * 헤드리스 실행에는 승인할 사람이 붙어 있지 않다. 그래서 CLI는 승인이 필요한
 * 도구를 **거부된 것으로** 처리하고 tool_result에 그 사유를 적어 보낸다.
 * 실측(사용자 제보, Claude Code 2.1.x):
 *   "This Bash command contains multiple operations.
 *    The following part requires approval: npm run verify 2>&1"
 *   "Claude requested permissions to write to <…>, but you haven't granted it yet."
 * 세션 이벤트에는 `toolDenialKind: "user-rejected"` 로 남는다 — 사용자는 아무것도
 * 거절한 적이 없는데도. 그리고 화면에는 그 사실이 **전혀 표시되지 않았다.**
 *
 * 이건 실패가 아니라 **막힌 것**이라 별도로 센다. 실패로 세면 실행이 끝나 버리고,
 * 무시하면 사용자는 왜 아무 일도 안 일어났는지 알 수 없다.
 *
 * 여기 두는 이유는 이 파일의 존재 이유와 같다 — 문구로 판정하는 코드는 저장소에
 * 한 곳만 둔다. 다만 이 판별은 **tool_result 본문**을 보므로 길이·구조 제한을
 * 적용하지 않는다(도구 결과는 길고 구조가 있을 수 있다).
 */
const APPROVAL_REQUIRED_PATTERNS: RegExp[] = [
  /\brequires? approval\b/i,
  /\brequested permissions? to\b/i,
  /\bhaven'?t granted (it|permission)\b/i,
  /\bpermission to use\b[^\n]*\bhas not been granted\b/i,
  /\bapproval (is )?required\b/i,
];

/** 이 tool_result가 "승인이 없어서 막혔다"를 말하는가. 막힌 명령을 함께 돌려준다. */
export function detectApprovalRequired(
  toolResultText: string,
): { message: string; blocked?: string } | null {
  const t = String(toolResultText || "").trim();
  if (!t) return null;
  if (!APPROVAL_REQUIRED_PATTERNS.some((re) => re.test(t))) return null;
  // "The following part requires approval: <명령>" 형태면 그 명령을 뽑아 보여준다.
  const blocked = t.match(/requires? approval:\s*([^\n]+)/i)?.[1]?.trim()
    ?? t.match(/permissions? to (?:write to|use) ([^\n,]+)/i)?.[1]?.trim();
  return blocked ? { message: t, blocked } : { message: t };
}

/** 텍스트가 산출물이 아니라 거절 고지문인가. */
export function detectRuntimeRefusal(text: string): { kind: RunnerFailureKind; message: string } | null {
  const t = String(text || "").trim();
  if (!t || t.length > MAX_NOTICE_LENGTH) return null;
  if (t.includes("{") || t.includes("```") || /\n\s*\n/.test(t)) return null;
  if (!NOTICE_PATTERNS.some((re) => re.test(t))) return null;
  return { kind: kindOf(t), message: t };
}
