// 자율 전략 진화(실패→다른 방법) — 실패 이력을 다음 시도의 프롬프트에 결정적으로 주입해
// "같은 방법 무한 반복"을 구조적으로 차단한다. 과거에는 재시도가 동일 promptTemplate을
// 그대로 재사용했고, 실패 경로(handleAutomationFailure)는 인프라 수리(Runtime Doctor /
// System Optimizer)만 호출해 방법 전환이 정의상 불가능했다.
// 이 모듈은 순수(스토어 읽기 전용)이며 러너 결과에 영향을 주는 실패는 던지지 않는다.
import { countConsecutiveFailures, listRunHistory } from "./store/automations";

export interface AutomationFailureContext {
  /** 직전 실행부터 끊기지 않고 이어진 error 런 수. 0이면 지시문 없음. */
  streak: number;
  /** 현재 실패 스트릭 안에서 관측된 서로 다른 실패 메시지(정규화, 최신순, 최대 5개). */
  recentErrors: string[];
}

const MAX_DISTINCT_ERRORS = 5;
const MAX_ERROR_CHARS = 280;

// 2026-07-23 보안 강화 — 자동화 실패 원문은 (1) 자동화가 방금 스크랩한 웹페이지/API
// 응답을 그대로 담고 있을 수 있어 프롬프트 인젝션 매개체가 될 수 있고, (2) URL
// 쿼리스트링·헤더에 토큰/키가 섞여 나올 수 있다. 이 함수를 거치지 않은 원문은 모델
// 프롬프트·에이전트 메모리·Experience 레코드 어디에도 닿지 않아야 한다(정책: 시크릿
// 유출 금지 + "원문 그대로" 주입 금지 — 재작성/스크럽된 신호만 통과).
const SECRET_REDACT_RE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*\S+|BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY|Bearer\s+[A-Za-z0-9._~-]{12,})/gi;
// 전체 URL은 쿼리스트링에 토큰이 실려 있을 수 있어 host만 남긴다(경로·쿼리 폐기).
const URL_REDACT_RE = /https?:\/\/([^\s/?#]+)[^\s]*/gi;

/**
 * 실패 원문을 durable 저장/프롬프트 주입이 안전한 형태로 재작성한다.
 * 타임스탬프/ID처럼 매 실행 바뀌는 토큰도 뭉개 같은 실패를 같은 문자열로 본다.
 * 이 함수의 출력은 "원문(raw)"이 아니라 "스크럽된 신호"다 — 시크릿·URL 세부·인젝션
 * 소지가 있는 서식은 이미 제거된 상태로만 호출부에 노출한다.
 */
export function normalizeFailureText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(SECRET_REDACT_RE, "[redacted]")
    .replace(URL_REDACT_RE, (_m, host: string) => `<url:${host}>`)
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b\d{10,}\b/g, "<n>")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

/**
 * 실패 스트릭의 결정적 서명 — 복구 이벤트 집계(같은 실패 계열이 몇 번 복구됐는지)와
 * 진화 임계 판정에 쓴다. 에러 원문이 아니라 정규화 집합 기반이라 재실행에 안정적이다.
 */
export function failureSignature(recentErrors: string[]): string {
  const canonical = [...new Set(recentErrors.map(normalizeFailureText))].sort().join("\n");
  let hash = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash * 33) ^ canonical.charCodeAt(i)) >>> 0;
  }
  return `fsig-${hash.toString(16).padStart(8, "0")}`;
}

/** run_history에서 현재 실패 스트릭과 그 안의 distinct 에러들을 수집한다(읽기 전용). */
export function collectAutomationFailureContext(automationId: string): AutomationFailureContext {
  let streak = 0;
  try {
    streak = Math.max(0, countConsecutiveFailures(automationId));
  } catch {
    return { streak: 0, recentErrors: [] };
  }
  if (streak === 0) return { streak: 0, recentErrors: [] };
  const recentErrors: string[] = [];
  try {
    const seen = new Set<string>();
    for (const run of listRunHistory(automationId, Math.min(streak, 10))) {
      if (run.status !== "error") break;
      const normalized = normalizeFailureText(run.error ?? "unknown failure");
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      recentErrors.push(normalized);
      if (recentErrors.length >= MAX_DISTINCT_ERRORS) break;
    }
  } catch {
    /* 이력 조회 실패 시에도 streak 기반 지시문은 낼 수 있다 */
  }
  return { streak, recentErrors };
}

/** 러너가 성공 시 선언하도록 요구하는 전략 전환 마커. 복구 기억 추출에 사용. */
export const STRATEGY_CHANGE_MARKER = "Strategy change:";

/**
 * 실패 맥락 → 프롬프트 지시문 블록.
 * streak 0 → "" (오버헤드 없음). streak 1 → 진단 후 조정 권고.
 * streak >= 2 → 동일 방법 반복 금지 + 전략 전환 선언 강제 + 대안 소진 시 BLOCKED 정직 표면화.
 */
export function buildStrategyDirective(ctx: AutomationFailureContext): string {
  if (ctx.streak <= 0) return "";
  const errorLines = ctx.recentErrors.map((error) => `- ${error}`);
  if (ctx.streak === 1) {
    return [
      "[Agentlas strategy evolution]",
      "The previous run of this automation failed:",
      ...errorLines,
      "Diagnose why before acting. If the same approach would hit the same failure, change the approach instead of repeating it.",
      "[/Agentlas strategy evolution]",
    ].join("\n");
  }
  return [
    "[Agentlas strategy evolution]",
    `This automation has failed ${ctx.streak} consecutive times. The prior approach keeps producing these failures:`,
    ...errorLines,
    "Repeating the prior approach is prohibited this run. Choose a materially different method: a different tool, a different data source, a different order of operations, or decompose the task into smaller verifiable steps.",
    `Start your work with a single line "${STRATEGY_CHANGE_MARKER} <previous approach> -> <new approach>" so the change is auditable.`,
    "If every viable alternative is exhausted, do not go through the motions again: stop and output one line starting with \"BLOCKED:\" naming the missing prerequisite.",
    "[/Agentlas strategy evolution]",
  ].join("\n");
}

/**
 * 성공 출력에서 러너가 선언한 전략 전환 한 줄을 추출한다.
 * 지시문이 요구한 계약("Strategy change: old -> new")의 소비 측 절반.
 */
export function extractStrategyChangeLine(output: string | undefined): string | null {
  if (!output) return null;
  const match = output.match(/^[^\S\n]*Strategy change:\s*(.{3,400})$/im);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}
