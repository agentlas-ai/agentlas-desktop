// 대시보드 홈 — 사장 관제탑.
//   좌: 조직도(출처 트리: 로컬·클라우드·허브 > firm > HQ > agent)
//   우: 엔진 사용량(프로바이더 OAuth usage) + 활동(실행 중·최근) + 자동화
// 데이터는 전부 실제 IPC.
"use client";
import { useT } from "@/lib/i18n";
import { QuestBoard } from "@/components/dashboard/QuestBoard";
import { OrgTree } from "@/components/dashboard/OrgTree";
import { FleetSummaryStrip } from "@/components/dashboard/FleetSummaryStrip";
import { HubBorrowRoom } from "@/components/dashboard/HubBorrowRoom";
import { EngineUsage } from "@/components/EngineUsage";
import { RuntimeControl } from "@/components/dashboard/RuntimeControl";
import { RuntimeReadiness } from "@/components/dashboard/RuntimeReadiness";
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
            {/* 퀘스트 보드가 왼쪽 위 — 조직도는 그 아래로 살짝 내려간다. */}
            <div className="dashboard-org-column" data-tour-id="dashboard.org" style={{ display: "grid", gap: 14 }}>
              <QuestBoard />
              <OrgTree />
            </div>
            <div className="dashboard-flow-column">
              {/* LLM 연결은 대시보드의 상시 조작부다. 승인 목록의 크기와 무관하게
                  첫 화면에서 바로 연결·전환할 수 있도록 우측 최상단에 고정한다. */}
              <div className="dashboard-panel dashboard-engine-panel" data-tour-id="dashboard.llm">
                <RuntimeControl />
                <EngineUsage />
              </div>
              {/* 승인 인박스 — 가장 먼저 눈에 띄도록 최상단 전체폭으로. 대기 시 빨간 강조(data-alert). */}
              <div className="dashboard-panel" data-tour-id="dashboard.approvals"><ConfirmRequests /></div>
              <div className="dashboard-panel" data-tour-id="dashboard.readiness"><RuntimeReadiness /></div>
              <div className="dashboard-panel" data-tour-id="dashboard.activity">
                <DashboardActivity />
              </div>
              <div className="dashboard-panel" data-tour-id="dashboard.automations"><DashboardAutomations /></div>
              <div className="dashboard-panel" data-tour-id="dashboard.hub">
                <HubBorrowRoom />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
