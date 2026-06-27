"use client";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { IconChevronRight, IconFilm, IconNetwork, IconWand } from "@/components/Icon";
import { StudioBotLogo } from "@/components/StudioBotLogo";
import { ipc } from "@/lib/ipc";
import type { HephaestusCommandResult, HephaestusStatus } from "@/lib/types";

type Phase = "idle" | "routing" | "done" | "error";

function summarize(res: HephaestusCommandResult): { title: string; detail: string; pkg?: string } {
  const j = (res.json ?? {}) as Record<string, unknown>;
  const sel = (j.selected ?? j.candidate ?? j.launched ?? {}) as Record<string, unknown>;
  const pkg = (sel.name_ko ?? sel.name ?? sel.id ?? j.shortcut) as string | undefined;
  const action = String(j.action ?? j.status ?? (res.ok ? "routed" : "failed"));
  if (res.ok) {
    return {
      title: pkg ? `패키지 준비됨: ${pkg}` : "라우팅 완료",
      detail: `action: ${action}`,
      pkg,
    };
  }
  return {
    title: "라우팅 실패",
    detail: res.error ?? res.stderr?.slice(0, 400) ?? "Hub 연결 또는 로그인을 확인하세요.",
    pkg,
  };
}

export default function CreativeStudioPage() {
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ReturnType<typeof summarize> | null>(null);

  useEffect(() => {
    ipc()?.hephaestus.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const start = async () => {
    const api = ipc();
    if (!api || !url.trim() || phase === "routing") return;
    try {
      const u = new URL(url.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
    } catch {
      setResult({ title: "URL 확인 필요", detail: "https:// 로 시작하는 제품 URL을 입력하세요." });
      setPhase("error");
      return;
    }

    setPhase("routing");
    setResult(null);
    const query = `마케팅 광고 에셋 팩 생성 — 제품 URL: ${url.trim()}. 제품 아이덴티티 스크랩, 이미지/릴 키프레임 생성, 에셋 팩 구성.`;
    try {
      const res = await api.hephaestus.network({ query, noOpen: true });
      setResult(summarize(res));
      setPhase(res.ok ? "done" : "error");
    } catch (e) {
      setResult({ title: "오류", detail: (e as Error).message });
      setPhase("error");
    }
  };

  const engineMissing = status ? !status.available : false;
  const busy = phase === "routing";

  return (
    <div style={shell}>
      <video src="/apps/creative-studio.mp4" poster="/apps/creative-studio.png" autoPlay muted loop playsInline style={video} />
      <div style={shade} />

      <header className="titlebar-drag" style={header}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Apps
        </Link>
        <div style={divider} />
        <StudioBotLogo size={32} />
        <div style={{ minWidth: 0 }}>
          <h1 style={title}>Creative Studio</h1>
          <p style={subtitle}>creative-studio</p>
        </div>
      </header>

      <main style={main}>
        <section style={panel}>
          <div style={panelTopline}>
            <IconFilm size={15} />
            <span>Asset Pack</span>
          </div>
          <h2 style={headline}>Creative Studio</h2>

          {engineMissing ? (
            <div style={engineNotice}>Hephaestus 엔진을 사용할 수 없습니다: {status?.reason}</div>
          ) : null}

          <div style={inputRow}>
            <label style={urlBox}>
              <IconNetwork size={17} />
              <input
                type="url"
                placeholder="https://example.com/products/orbit-lamp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
                style={input}
              />
            </label>
            <button onClick={start} disabled={!url.trim() || busy || engineMissing} style={actionButton(!url.trim() || busy || engineMissing)}>
              <IconWand size={17} /> {busy ? "라우팅 중" : phase === "done" ? "다시 생성" : "생성"}
            </button>
          </div>

          {busy ? (
            <div style={progressBox}>
              <span style={liveDot} />
              <span>Hephaestus Network</span>
              <div style={progressTrack}>
                <div style={progressFill} />
              </div>
            </div>
          ) : null}

          {result && !busy ? (
            <div style={resultBox(phase)}>
              <strong>{result.title}</strong>
              <span>{result.detail}</span>
            </div>
          ) : null}
        </section>
      </main>
      <style dangerouslySetInnerHTML={{ __html: "@keyframes creativeIndet{0%{margin-left:-44%}100%{margin-left:100%}}" }} />
    </div>
  );
}

const shell: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
  background: "#07090f",
  color: "#f7f8ff",
};

const video: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  filter: "saturate(1.08) contrast(1.08)",
};

const shade: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(90deg, rgba(5,7,12,0.94), rgba(5,7,12,0.58) 52%, rgba(5,7,12,0.88)), linear-gradient(0deg, rgba(5,7,12,0.96), rgba(5,7,12,0.12) 62%, rgba(5,7,12,0.68))",
};

const header: CSSProperties = {
  position: "relative",
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 24px 12px 90px",
  minHeight: 58,
  flexShrink: 0,
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(7,9,15,0.72)",
  backdropFilter: "blur(18px)",
};

const backLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 13,
  color: "rgba(247,248,255,0.68)",
  textDecoration: "none",
};

const divider: CSSProperties = {
  width: 1,
  height: 20,
  background: "rgba(255,255,255,0.14)",
};

const title: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-head)",
  fontSize: 16,
  color: "#ffffff",
};

const subtitle: CSSProperties = {
  margin: "2px 0 0",
  fontSize: 11.5,
  color: "rgba(247,248,255,0.54)",
  fontFamily: "var(--font-mono)",
};

const main: CSSProperties = {
  position: "relative",
  zIndex: 1,
  flex: 1,
  minHeight: 0,
  display: "flex",
  alignItems: "flex-end",
  padding: "42px 54px 58px",
};

const panel: CSSProperties = {
  width: "min(760px, 100%)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(11,15,24,0.96)",
  boxShadow: "0 30px 100px rgba(0,0,0,0.34)",
};

const panelTopline: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  color: "rgba(247,248,255,0.66)",
  fontSize: 12,
  fontWeight: 760,
};

const headline: CSSProperties = {
  margin: 0,
  color: "#ffffff",
  fontFamily: "var(--font-head)",
  fontSize: 34,
  lineHeight: 1.05,
  letterSpacing: 0,
};

const engineNotice: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(255,184,77,0.12)",
  border: "1px solid rgba(255,184,77,0.24)",
  color: "#ffe1a3",
  fontSize: 12.5,
};

const inputRow: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "stretch",
};

const urlBox: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 44,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 13px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.08)",
  color: "rgba(247,248,255,0.66)",
};

const input: CSSProperties = {
  minWidth: 0,
  flex: 1,
  height: "100%",
  border: 0,
  outline: 0,
  background: "transparent",
  color: "#ffffff",
  fontSize: 14,
};

function actionButton(disabled: boolean): CSSProperties {
  return {
    height: 44,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "0 18px",
    borderRadius: 8,
    border: "none",
    background: disabled ? "rgba(255,255,255,0.14)" : "#6D91FF",
    color: disabled ? "rgba(247,248,255,0.48)" : "#071122",
    fontWeight: 820,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

const progressBox: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto auto 1fr",
  alignItems: "center",
  gap: 10,
  color: "rgba(247,248,255,0.74)",
  fontSize: 12.5,
};

const liveDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 99,
  background: "#83F7FF",
  boxShadow: "0 0 18px rgba(131,247,255,0.78)",
};

const progressTrack: CSSProperties = {
  height: 7,
  borderRadius: 99,
  background: "rgba(255,255,255,0.14)",
  overflow: "hidden",
};

const progressFill: CSSProperties = {
  width: "44%",
  height: "100%",
  borderRadius: 99,
  background: "#83F7FF",
  animation: "creativeIndet 1.2s ease-in-out infinite",
};

function resultBox(phase: Phase): CSSProperties {
  const ok = phase === "done";
  return {
    display: "grid",
    gap: 5,
    padding: "12px 13px",
    borderRadius: 8,
    border: `1px solid ${ok ? "rgba(131,247,255,0.26)" : "rgba(255,154,154,0.28)"}`,
    background: ok ? "rgba(131,247,255,0.08)" : "rgba(255,154,154,0.1)",
    color: ok ? "#d9fdff" : "#ffd4d4",
    fontSize: 12.5,
    lineHeight: 1.45,
  };
}
