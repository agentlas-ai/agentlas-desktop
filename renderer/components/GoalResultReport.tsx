"use client";
import type { ReactNode } from "react";
import type { GoalResultPresentation } from "../../shared/goal-result";

/** Shared by One and Work. Unverified reports stay visibly unverified without a disclosure bubble. */
export function GoalResultReport({ result, locale, children }: {
  result?: GoalResultPresentation; locale: string; children: ReactNode;
}) {
  if (!result || result.status === "verified") return <>{children}</>;
  const label = locale === "ko"
    ? result.status === "legacy" ? "이전 작업 보고 · 검증 미확인" : result.status === "pending" ? "검증 전 작업 보고" : "검증 미통과 · 결과 확인 필요"
    : result.status === "legacy" ? "Previous report · verification unknown" : result.status === "pending" ? "Verification pending" : "Verification not passed · review required";
  return <div data-goal-result={result.status} style={{ marginTop: 10 }}>
    <div role="status" style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>{label}</div>
    <div style={{ marginTop: 4 }}>{children}</div>
  </div>;
}
