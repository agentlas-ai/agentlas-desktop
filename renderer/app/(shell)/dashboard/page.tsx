// 대시보드 홈 — 사장 관제탑.
//   좌: 조직도(출처 트리: 로컬·클라우드·허브 > firm > HQ > agent)
//   우: 엔진 사용량(프로바이더 OAuth usage) + 활동(실행 중·최근) + 자동화
// 데이터는 전부 실제 IPC.
"use client";
import { useT } from "@/lib/i18n";
import { OrgTree } from "@/components/dashboard/OrgTree";
import { FleetSummaryStrip } from "@/components/dashboard/FleetSummaryStrip";
import { HubBorrowRoom } from "@/components/dashboard/HubBorrowRoom";
import { EngineUsage } from "@/components/EngineUsage";
import { ConfirmRequests } from "@/components/dashboard/ConfirmRequests";
import { DashboardActivity } from "@/components/dashboard/DashboardActivity";
import { DashboardAutomations } from "@/components/dashboard/DashboardAutomations";

export default function DashboardPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  return (
    <div className="dashboard-root rd" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="titlebar-drag" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 38 }} />
      <div className="dashboard-scroll">
        <div className="dashboard-shell">
          <h1 className="sr-only">{ko ? "대시보드" : "Dashboard"}</h1>

          <FleetSummaryStrip />

          <div className="dashboard-workspace">
            <div className="dashboard-org-column">
              <OrgTree />
            </div>
            <div className="dashboard-flow-column">
              <div className="dashboard-panel dashboard-engine-panel">
                <EngineUsage />
              </div>
              <div className="dashboard-two-up">
                <div className="dashboard-panel"><ConfirmRequests /></div>
                <div className="dashboard-panel"><DashboardAutomations /></div>
              </div>
              <div className="dashboard-panel">
                <HubBorrowRoom />
              </div>
              <div className="dashboard-panel">
              <DashboardActivity />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
