"use client";
import type { ReactNode } from "react";
import type { GoalResultPresentation } from "../../shared/goal-result";

/** Shared by One and Work. The original report remains available for inspection. */
export function GoalResultReport({ result, locale, children }: {
  result?: GoalResultPresentation; locale: string; children: ReactNode;
}) {
  if (!result || result.status === "verified") return <>{children}</>;
  const label = locale === "ko"
    ? result.status === "legacy" ? "이전 작업 보고 · 검증 상태 미확인" : result.status === "pending" ? "검증 전 작업 보고" : "검증을 통과하지 않은 작업 보고"
    : result.status === "legacy" ? "Previous work report · verification unknown" : result.status === "pending" ? "Work report · verification pending" : "Work report · not verified";
  return <details data-goal-result={result.status} style={{ marginTop: 10 }}>
    <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 13, lineHeight: 1.7 }}>{label}</summary>
    <div style={{ marginTop: 8 }}>{children}</div>
  </details>;
}
