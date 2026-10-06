// Desktop, mobile and briefing share the same intervention rule. A result
// shortfall remains visible in history, but alone is not an owner-input request.
import type { AutomationRunRecord } from "./types";
import { automationRunPresentation } from "./automation-run-presentation";

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
  return automationRunPresentation(run).requiresAttention;
}
