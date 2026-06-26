// 대시보드 홈 — 사장 관제탑.
//   좌: 조직도(출처 트리: 로컬·클라우드·허브 > firm > HQ > agent)
//   우: 엔진 사용량(프로바이더 OAuth usage) + 활동(실행 중·최근) + 자동화
// 데이터는 전부 실제 IPC.
"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { OrgTree } from "@/components/dashboard/OrgTree";
import { EngineUsage } from "@/components/EngineUsage";
import { ConfirmRequests } from "@/components/dashboard/ConfirmRequests";
import { DashboardActivity } from "@/components/dashboard/DashboardActivity";
import { DashboardAutomations } from "@/components/dashboard/DashboardAutomations";
import { DashboardStats } from "@/components/dashboard/DashboardStats";

function useClock(): string {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now ? now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
}

export default function DashboardPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const clock = useClock();
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="titlebar-drag" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 38 }} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "44px 28px 32px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", width: "100%" }}>
          {/* 헤더 */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, margin: "0 0 18px" }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)", fontFamily: "var(--font-head)" }}>
                {ko ? "대시보드" : "Dashboard"}
              </h1>
              <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--muted-deep)" }}>
                <span className="dash-live-pip" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--green-deep, #56a14a)", display: "inline-block" }} />
                {ko ? "실시간 관제" : "Live command center"}
              </div>
            </div>
            {clock && (
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>{clock}</span>
            )}
          </div>

          {/* 요약 스탯 */}
          <div style={{ marginBottom: 16 }}>
            <DashboardStats />
          </div>

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
      <style dangerouslySetInnerHTML={{ __html: `@keyframes dashLivePip{0%,100%{opacity:1}50%{opacity:.35}} .dash-live-pip{animation:dashLivePip 1.8s ease-in-out infinite}` }} />
    </div>
  );
}
