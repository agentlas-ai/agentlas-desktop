// Dashboard (Agentlas 2.0, F-D2). One column of cards in the shape of mockups/dashboard-final:
//   Work in progress (cards, newest left, a red dot + words where a chat waits for the owner)
//   left  : Models (Orchestrator, Worker, Multimodal: [model][effort] lines). Below it stays empty on purpose (owner: "뭐 넣지 흠 - 나중에").
//   right : the readiness card (only while the owner has something to do), the waiting-for-you inbox (only while something waits), Connections and usage, Agent Hub.
// The org chart, the summary strip, the project cards and the Recent tasks list are gone: where each of their jobs lives now is in
// docs/Agentlas2.0/evidence/frontend/F-D2/. Every card reads through the shared caches and signals; nothing here polls an unchanged state.
"use client";
import { useEffect } from "react";
import { useT } from "@/lib/i18n";
import { dropRetiredLocalKeys } from "@/lib/retired-local-keys";
import { HubBorrowRoom } from "@/components/dashboard/HubBorrowRoom";
import { EngineUsage } from "@/components/EngineUsage";
import { RuntimeControl } from "@/components/dashboard/RuntimeControl";
import { RuntimeReadiness } from "@/components/dashboard/RuntimeReadiness";
import { ConfirmRequests } from "@/components/dashboard/ConfirmRequests";
import { FirstRunLine } from "@/components/dashboard/FirstRunLine";
import { OneHomeKeepCard } from "@/components/one/OneHomeKeepCard";
import { WorkInProgress } from "@/components/dashboard/WorkInProgress";
import s from "@/components/dashboard/Dashboard.module.css";

export default function DashboardPage() {
  const { t } = useT();
  useEffect(() => { dropRetiredLocalKeys(); }, []);
  return (
    <div className="dashboard-root rd" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="titlebar-drag" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 38 }} />
      <div className="dashboard-scroll">
        {/* The bottom clears the help button (20px from the edge, 46px tall), which covered the last card's button. */}
        <div className="dashboard-shell" style={{ paddingBottom: 88 }}>
          {/* The page name is the menu row's own word: the nav.dashboard key. */}
          <h1 className="sr-only">{t("nav.dashboard")}</h1>
          <div className={s.shell}>
            {/* The first run after the 2.0 update: one line, the very top (nothing on a build with no cleanup). */}
            <FirstRunLine />
            <OneHomeKeepCard />
            <WorkInProgress />
            <div className={s.grid}>
              <div className={s.col} data-testid="dashboard-left">
                <RuntimeControl />
              </div>
              <div className={s.col} data-testid="dashboard-right">
                {/* The readiness card is the top of this column and exists only while the owner has something to do. */}
                <RuntimeReadiness />
                <ConfirmRequests />
                <EngineUsage />
                <div className={`${s.card} ${s.hub}`} data-tour-id="dashboard.hub"><HubBorrowRoom /></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
