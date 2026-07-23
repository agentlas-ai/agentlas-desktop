// 자율 전략 진화(실패→다른 방법) — 실패 이력을 다음 시도의 프롬프트에 결정적으로 주입해
// "같은 방법 무한 반복"을 구조적으로 차단한다. 과거에는 재시도가 동일 promptTemplate을
// 그대로 재사용했고, 실패 경로(handleAutomationFailure)는 인프라 수리(Runtime Doctor /
// System Optimizer)만 호출해 방법 전환이 정의상 불가능했다.
// 이 모듈은 순수(스토어 읽기 전용)이며 러너 결과에 영향을 주는 실패는 던지지 않는다.
import { countConsecutiveFailures } from "./store/automations";

export interface AutomationFailureContext {
  /** 직전 실행부터 끊기지 않고 이어진 error 런 수. 0이면 지시문 없음. */
  streak: number;
  /**
   * 오류 원문은 모델 프롬프트·메모리·로그로 재배포하지 않는다. 이 필드는 기존 호출
   * 호환성만 위해 남겨두며 collectAutomationFailureContext는 항상 빈 배열을 돌려준다.
   */
  recentErrors: string[];
}

/**
 * 다음 시도의 방법 전환 여부만 수집한다. 런 오류에는 토큰·개인 URL·원격 응답이
 * 포함될 수 있으므로 원문이나 파생 텍스트를 LLM 프롬프트로 보내지 않는다.
 */
export function collectAutomationFailureContext(automationId: string): AutomationFailureContext {
  let streak = 0;
  try {
    streak = Math.max(0, countConsecutiveFailures(automationId));
  } catch {
    return { streak: 0, recentErrors: [] };
  }
  return { streak, recentErrors: [] };
}

/** 러너가 전략 전환을 짧게 선언하도록 요구하는 마커. */
export const STRATEGY_CHANGE_MARKER = "Strategy change:";

/**
 * 실패 맥락 → 프롬프트 지시문 블록.
 * streak 0 → "" (오버헤드 없음). streak 1 → 진단 후 조정 권고.
 * streak >= 2 → 동일 방법 반복 금지 + 전략 전환 선언 강제 + 대안 소진 시 BLOCKED 정직 표면화.
 */
export function buildStrategyDirective(ctx: AutomationFailureContext): string {
  if (ctx.streak <= 0) return "";
  if (ctx.streak === 1) {
    return [
      "[Agentlas strategy evolution]",
      "The previous run of this automation failed. Its error details are intentionally not included here.",
      "Diagnose why before acting. If the same approach would hit the same failure, change the approach instead of repeating it.",
      "[/Agentlas strategy evolution]",
    ].join("\n");
  }
  return [
    "[Agentlas strategy evolution]",
    `This automation has failed ${ctx.streak} consecutive times. Failure details are intentionally withheld from this prompt.`,
    "Repeating the prior approach is prohibited this run. Choose a materially different method: a different tool, a different data source, a different order of operations, or decompose the task into smaller verifiable steps.",
    `Start your work with a single line "${STRATEGY_CHANGE_MARKER} <previous approach> -> <new approach>" so the change is auditable.`,
    "If every viable alternative is exhausted, do not go through the motions again: stop and output one line starting with \"BLOCKED:\" naming the missing prerequisite.",
    "[/Agentlas strategy evolution]",
  ].join("\n");
}
