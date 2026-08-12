// 자동화 실행이 "사람이 봐야 하는 상태"인가 — **한 벌**이 소유하는 규칙.
//
// 이 파일이 생긴 이유(2026-08-12 실측): 데스크탑 실행 기록 패널과 모바일 브리지
// 투영이 각자 판정을 갖고 있었고 서로 달랐다. 패널은 `status ∪ outcome ∪
// acknowledgedAt` 을 보는데 투영은 `status` 만 봤다. 그래서 판정이 **반려**한
// 실행(`outcome: "rejected"`, status 는 `ok`)이 폰에는 "완료"로 도착했고, 새로
// 만든 알림 종은 울리지 않았다. 화면마다 다른 답을 주는 규칙은 둘 중 하나가
// 반드시 틀린다.
import type { AutomationRunRecord } from "./types";

/** 실행 자체가 끝나지 못한 상태. */
const ATTENTION_STATUSES: ReadonlySet<AutomationRunRecord["status"]> = new Set([
  "error",
  "partial",
  "blocked",
  "needs_input",
]);

/**
 * 실행은 멀쩡했는데 **결과물**이 사람 손을 필요로 하는 상태.
 *
 * status 와 다른 질문이다. `ok` 로 끝난 실행도 판정이 반려하면 확인 대상이다.
 */
const ATTENTION_OUTCOMES: ReadonlySet<
  NonNullable<AutomationRunRecord["outcome"]>
> = new Set(["needs_input", "blocked", "rejected"]);

/**
 * 이 실행이 사용자의 확인을 요구하는가.
 *
 * `acknowledgedAt` 이 찍혀 있으면 사용자가 이미 봤다는 뜻이므로 요구하지 않는다 —
 * 그게 없으면 해소 수단 없는 배지가 영원히 눌러앉는다(2026-08-06 오너 보고).
 */
export function automationRunNeedsAttention(
  run: Pick<AutomationRunRecord, "status" | "outcome" | "acknowledgedAt"> | null | undefined,
): boolean {
  if (!run) return false;
  if (run.acknowledgedAt) return false;
  if (ATTENTION_STATUSES.has(run.status)) return true;
  return run.outcome != null && ATTENTION_OUTCOMES.has(run.outcome);
}
