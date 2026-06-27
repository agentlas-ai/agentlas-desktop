"use client";
// Startup Founder Studio — 패키지의 실제 GUI 를 앱 안에서 그대로 구동.
// 새로 그리지 않는다. electron 이 패키지 자체 런처(open-studio-gui.py)를 spawn 해 실제 SPA 를
// 로컬 서빙하고, 이 페이지는 그 URL 을 <iframe> 으로 띄운다 → 진짜 스튜디오가 앱 안에서 돈다.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconChevronRight, IconRoute, IconRefresh } from "@/components/Icon";
import { ipc } from "@/lib/ipc";

type Phase = "starting" | "ready" | "error";

export default function StartupFounderStudioPage() {
  const [phase, setPhase] = useState<Phase>("starting");
  const [url, setUrl] = useState<string | null>(null);
  const [reason, setReason] = useState<string>("");
  const startedRef = useRef(false);

  const start = async () => {
    setPhase("starting");
    setReason("");
    const res = await ipc()?.hephaestus.startStudio();
    if (res?.ok && res.url) {
      setUrl(res.url + "?t=" + Date.now());
      setPhase("ready");
    } else {
      setReason(res?.reason ?? "스튜디오를 시작할 수 없습니다.");
      setPhase("error");
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    // 페이지를 벗어나도 런처는 유지(재방문 빠름) — 앱 종료 시 electron 이 정리.
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--paper)" }}>
      <header
        className="titlebar-drag"
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px 12px 90px", borderBottom: "1px solid var(--glass-border)", minHeight: 56, flexShrink: 0 }}
      >
        <Link href="/apps" className="titlebar-nodrag" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Apps
        </Link>
        <div style={{ width: 1, height: 18, background: "var(--paper-edge)", margin: "0 2px" }} />
        <div style={{ width: 28, height: 28, borderRadius: 7, background: "linear-gradient(135deg, #845EF7, #5C7CFA)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <IconRoute size={15} />
        </div>
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 16, color: "var(--ink)" }}>Startup Founder Studio</h1>
        <button
          onClick={() => void start()}
          className="titlebar-nodrag"
          title="다시 시작"
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted-deep)", background: "var(--fill-1)", border: "1px solid var(--paper-edge)", borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}
        >
          <IconRefresh size={13} /> 새로고침
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#0f0f12" }}>
        {phase === "ready" && url ? (
          <iframe
            key={url}
            src={url}
            title="Startup Founder Studio"
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
            allow="clipboard-write; clipboard-read"
          />
        ) : phase === "starting" ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: "#9aa", background: "#0f0f12" }}>
            <div className="sfs-spin" style={{ width: 34, height: 34, borderRadius: "50%", border: "3px solid rgba(255,255,255,0.15)", borderTopColor: "#845EF7" }} />
            <div style={{ fontSize: 13.5 }}>스튜디오 엔진을 시작하는 중…</div>
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: "#bbb", background: "#0f0f12", padding: 32, textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#e9e9ee" }}>스튜디오를 시작할 수 없습니다</div>
            <div style={{ fontSize: 13, color: "#9aa", maxWidth: 460, lineHeight: 1.6 }}>{reason}</div>
            <button onClick={() => void start()} style={{ marginTop: 6, padding: "9px 20px", borderRadius: 10, border: "none", background: "#845EF7", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              다시 시도
            </button>
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes sfsSpin{to{transform:rotate(360deg)}} .sfs-spin{animation:sfsSpin .8s linear infinite}` }} />
    </div>
  );
}
