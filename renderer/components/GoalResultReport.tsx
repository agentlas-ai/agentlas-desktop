"use client";
import type { ReactNode } from "react";
import type { GoalResultPresentation } from "../../shared/goal-result";
import { goalResultLabel } from "@/lib/goal-result-label";

/** Shared by One and Work. Unverified reports stay visibly unverified without a disclosure bubble. */
export function GoalResultReport({ result, locale, children }: {
  result?: GoalResultPresentation; locale: string; children: ReactNode;
}) {
  /*
   * 실행에 결속되지 않은 "검증 전"은 보고가 아니다 — 목표 대화에 앱이 쓴 안내("확인하는 중…")와
   * 반영 확인 관찰의 답이 여기에 해당하고, 결속될 실행이 없어 영원히 "검증 전"으로 남았다
   * (오너 녹화 2026-09-26: 말풍선마다 "Verification pending"). 실행에 결속된 보고만 표를 단다.
   */
  const showReport = Boolean(result && result.status !== "verified" && !(result.status === "pending" && !result.runId));
  const label = goalResultLabel(result, locale);
  // Keep the content parent stable when verification arrives during interaction.
  return <div data-goal-result={showReport ? result?.status : undefined} style={{ marginTop: showReport ? 10 : undefined, minWidth: 0 }}>
    {showReport && <div key="verification" role="status" style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>{label}</div>}
    <div key="content" style={{ marginTop: showReport ? 4 : undefined, minWidth: 0 }}>{children}</div>
  </div>;
}
