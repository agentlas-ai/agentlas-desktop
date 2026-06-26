// 대시보드 홈 — 사장 관제탑.
//   좌: 조직도(출처 트리: 로컬·클라우드·허브 > firm > HQ > agent)
//   우: 엔진 사용량(프로바이더 OAuth usage) + 활동(실행 중·최근) + 자동화
// 데이터는 전부 실제 IPC.
"use client";
import { useT } from "@/lib/i18n";
import { OrgTree } from "@/components/dashboard/OrgTree";
import { EngineUsage } from "@/components/EngineUsage";
import { ConfirmRequests } from "@/components/dashboard/ConfirmRequests";
import { DashboardActivity } from "@/components/dashboard/DashboardActivity";
import { DashboardAutomations } from "@/components/dashboard/DashboardAutomations";

export default function DashboardPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="titlebar-drag" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 38 }} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "44px 28px 32px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", width: "100%" }}>
          <h1 style={{ margin: "0 0 18px", fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)" }}>
            {ko ? "대시보드" : "Dashboard"}
          </h1>
          <div style={{ display: "grid", gridTemplateColumns: "232px minmax(0,1fr)", gap: 14, alignItems: "start" }}>
            <OrgTree />
            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
              <EngineUsage />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 14 }}>
                <ConfirmRequests />
                <DashboardAutomations />
              </div>
              <DashboardActivity />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
