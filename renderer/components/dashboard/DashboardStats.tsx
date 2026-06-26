// 대시보드 상단 요약 스탯 — 관제탑 한눈 보기. 전부 실제 IPC.
//   · 활성 런타임(연결된 엔진 수)  · 실행 중(activeChats)  · 확인 대기  · 자동화 활성
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconBolt, IconChat, IconShield, IconRefresh } from "@/components/Icon";

const POLL_MS = 10_000;

interface Stat {
  key: string;
  label: string;
  value: number | "—";
  icon: typeof IconBolt;
  tint: string; // 강조색
  live?: boolean; // 값>0 일 때 라이브 점등
}

export function DashboardStats() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [engines, setEngines] = useState<number | "—">("—");
  const [running, setRunning] = useState<number | "—">("—");
  const [confirms, setConfirms] = useState<number | "—">("—");
  const [autos, setAutos] = useState<number | "—">("—");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setEngines(0);
      setRunning(0);
      setConfirms(0);
      setAutos(0);
      return;
    }
    try {
      const [rt, run, conf, auto] = await Promise.all([
        api.runtime.detect().catch(() => []),
        api.invoke.activeChats().catch(() => []),
        api.confirm.listPending().catch(() => []),
        api.automations.list().catch(() => []),
      ]);
      // 연결된 엔진 = 버전/소스가 잡힌(실제 설치·활성) 런타임.
      setEngines(rt.filter((r) => r.active || Boolean(r.version)).length);
      setRunning(run.length);
      setConfirms(conf.length);
      setAutos(auto.filter((a) => a.enabled).length);
    } catch {
      // 다음 폴링 재시도
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const stats: Stat[] = [
    { key: "engines", label: ko ? "연결된 엔진" : "Engines", value: engines, icon: IconBolt, tint: "var(--accent)" },
    { key: "running", label: ko ? "실행 중" : "Running", value: running, icon: IconChat, tint: "var(--green-deep, #56a14a)", live: true },
    { key: "confirms", label: ko ? "확인 대기" : "Awaiting you", value: confirms, icon: IconShield, tint: "var(--amber-deep, #c98c1a)", live: true },
    { key: "autos", label: ko ? "자동화 활성" : "Automations", value: autos, icon: IconRefresh, tint: "var(--accent)" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12 }}>
      {stats.map((s) => {
        const Icon = s.icon;
        const lit = s.live && typeof s.value === "number" && s.value > 0;
        return (
          <div
            key={s.key}
            style={{
              background: "var(--paper-2)",
              border: "1px solid var(--paper-edge)",
              borderRadius: 14,
              padding: "14px 16px",
              boxShadow: "var(--neu-raised, var(--shadow-1))",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minWidth: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  background: lit ? s.tint : "var(--fill-1)",
                  color: lit ? "#fff" : s.tint,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "all .25s",
                }}
              >
                <Icon size={16} />
              </span>
              <span style={{ fontSize: 11.5, color: "var(--muted-deep)", fontWeight: 500, lineHeight: 1.2 }}>{s.label}</span>
              {lit && (
                <span
                  className="dash-stat-live"
                  style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: 999, background: s.tint, display: "inline-block", flexShrink: 0 }}
                />
              )}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 26, fontWeight: 700, fontFamily: "var(--font-head)", letterSpacing: "-0.02em", color: "var(--ink)", lineHeight: 1 }}>
                {s.value}
              </span>
            </div>
          </div>
        );
      })}
      <style dangerouslySetInnerHTML={{ __html: `@keyframes dashStatLive{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}} .dash-stat-live{animation:dashStatLive 1.4s ease-in-out infinite}` }} />
    </div>
  );
}
