"use client";
import type { ReactNode } from "react";
import type { GoalResultPresentation } from "../../shared/goal-result";

/** Shared by One and Work. Unverified reports stay visibly unverified without a disclosure bubble. */
export function GoalResultReport({ result, locale, children }: {
  result?: GoalResultPresentation; locale: string; children: ReactNode;
}) {
  if (!result || result.status === "verified") return <>{children}</>;
  /*
   * 실행에 결속되지 않은 "검증 전"은 보고가 아니다 — 목표 대화에 앱이 쓴 안내("확인하는 중…")와
   * 반영 확인 관찰의 답이 여기에 해당하고, 결속될 실행이 없어 영원히 "검증 전"으로 남았다
   * (오너 녹화 2026-09-26: 말풍선마다 "Verification pending"). 실행에 결속된 보고만 표를 단다.
   */
  if (result.status === "pending" && !result.runId) return <>{children}</>;
  const label = locale === "ko"
    ? result.status === "legacy" ? "이전 작업 보고 · 검증 미확인" : result.status === "pending" ? "검증 전 작업 보고" : "검증 미통과 · 결과 확인 필요"
    : result.status === "legacy" ? "Previous report · verification unknown" : result.status === "pending" ? "Verification pending" : "Verification not passed · review required";
  return <div data-goal-result={result.status} style={{ marginTop: 10 }}>
    <div role="status" style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>{label}</div>
    <div style={{ marginTop: 4 }}>{children}</div>
  </div>;
}
