"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { IconChevronRight, IconNetwork, IconImage, IconWand, IconFilm } from "@/components/Icon";
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
      title: pkg ? `스튜디오 패키지 준비됨: ${pkg}` : "Hephaestus Network 라우팅 완료",
      detail: `엔진이 마케팅 에셋 팩 요청을 처리했습니다 (action: ${action}). 결과 패키지가 준비/실행되었습니다.`,
      pkg,
    };
  }
  return {
    title: "라우팅 결과",
    detail: res.error ?? res.stderr?.slice(0, 400) ?? "스튜디오 패키지를 찾지 못했습니다. Hub 연결/로그인을 확인하세요.",
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
    // 유효한 URL 인지 먼저 확인 — "asdf" 같은 입력으로 라우팅을 낭비하지 않는다.
    try {
      const u = new URL(url.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
    } catch {
      setResult({ title: "유효한 URL을 입력하세요", detail: "예: https://example.com/products/orbit-lamp" });
      setPhase("error");
      return;
    }
    setPhase("routing");
    setResult(null);
    const query = `마케팅 광고 에셋 팩 생성 — 제품 URL: ${url.trim()}. 제품 아이덴티티 스크랩, 이미지/릴 키프레임 생성, 에셋 팩 구성.`;
    try {
      const res = await api.hephaestus.network({ query, noOpen: true });
      setResult(summarize(res!));
      setPhase(res?.ok ? "done" : "error");
    } catch (e) {
      setResult({ title: "오류", detail: (e as Error).message });
      setPhase("error");
    }
  };

  const engineMissing = status ? !status.available : false;
  const busy = phase === "routing";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--paper)" }}>
      <header
        className="titlebar-drag"
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 32px 14px 90px", borderBottom: "1px solid var(--glass-border)", minHeight: 64, flexShrink: 0 }}
      >
        <Link href="/apps" className="titlebar-nodrag" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Apps
        </Link>
        <div style={{ width: 1, height: 20, background: "var(--paper-edge)", margin: "0 4px" }} />
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #FF6B6B, #845EF7)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <IconImage size={18} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, lineHeight: 1.15, color: "var(--ink)" }}>Creative Studio</h1>
          <p style={{ margin: "2px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>Hephaestus Network — 마케팅 에셋 팩 라우팅</p>
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "40px 60px", display: "flex", flexDirection: "column", gap: 30 }}>
        {engineMissing && (
          <div style={{ maxWidth: 800, margin: "0 auto", width: "100%", padding: 16, borderRadius: 12, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 13 }}>
            ⚠ Hephaestus 엔진을 사용할 수 없습니다: {status?.reason}. Python 3.9+ 설치 후 다시 시도하세요.
          </div>
        )}

        <section style={{ maxWidth: 800, margin: "0 auto", width: "100%" }}>
          <h2 style={{ fontSize: 24, margin: "0 0 8px", color: "var(--ink)" }}>Generate Ad Pack</h2>
          <p style={{ color: "var(--muted-deep)", fontSize: 14, margin: "0 0 20px" }}>
            제품 URL 을 입력하면 Hephaestus Network 가 크리에이티브 스튜디오 패키지로 라우팅해 제품 아이덴티티 스크랩 → 이미지 생성 → 에셋 팩 구성을 수행합니다.
          </p>

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center" }}>
              <div style={{ position: "absolute", left: 16, color: "var(--muted)" }}><IconNetwork size={18} /></div>
              <input
                type="url"
                placeholder="https://example.com/products/orbit-lamp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
                style={{ width: "100%", padding: "16px 16px 16px 44px", fontSize: 15, borderRadius: 12, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", color: "var(--ink)", outline: "none", transition: "border-color 0.2s", boxSizing: "border-box" }}
              />
            </div>
            <button
              onClick={start}
              disabled={!url.trim() || busy || engineMissing}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8, padding: "0 24px", borderRadius: 12, border: "none",
                background: !url.trim() || busy || engineMissing ? "var(--fill-2)" : "linear-gradient(135deg, #FF6B6B, #845EF7)",
                color: !url.trim() || busy || engineMissing ? "var(--muted)" : "#fff",
                fontWeight: 600, fontSize: 15, cursor: !url.trim() || busy || engineMissing ? "not-allowed" : "pointer", transition: "all 0.2s", whiteSpace: "nowrap",
              }}
            >
              <IconWand size={18} /> {busy ? "라우팅 중…" : phase === "done" ? "Regenerate" : "Generate"}
            </button>
          </div>
        </section>

        {busy && (
          <section style={{ maxWidth: 800, margin: "0 auto", width: "100%" }}>
            <div style={{ padding: 24, borderRadius: 16, background: "var(--fill-1)", border: "1px solid var(--paper-edge)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#845EF7", display: "inline-block" }} />
                Hephaestus Network 를 통해 스튜디오 패키지로 라우팅 중…
              </div>
              <div style={{ height: 8, borderRadius: 4, background: "var(--fill-3)", overflow: "hidden", marginTop: 12 }}>
                <div style={{ height: "100%", width: "40%", background: "linear-gradient(90deg, #FF6B6B, #845EF7)", borderRadius: 4, animation: "indet 1.2s ease-in-out infinite" }} />
              </div>
            </div>
          </section>
        )}

        {result && !busy && (
          <section style={{ maxWidth: 800, margin: "0 auto", width: "100%" }}>
            <div style={{ padding: 24, borderRadius: 16, background: "var(--fill-1)", border: "1px solid var(--paper-edge)" }}>
              <h3 style={{ fontSize: 16, margin: "0 0 10px", color: phase === "done" ? "#0ca678" : "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: phase === "done" ? "#51cf66" : "#fa5252" }} />
                {result.title}
              </h3>
              <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--muted-deep)", lineHeight: 1.6 }}>{result.detail}</p>
              {phase === "done" && (
                <div style={{ padding: 16, borderRadius: 12, background: "rgba(132, 94, 247, 0.05)", border: "1px dashed rgba(132, 94, 247, 0.3)", display: "flex", alignItems: "center", gap: 10 }}>
                  <IconFilm size={18} style={{ color: "#845EF7" }} />
                  <p style={{ margin: 0, fontSize: 13, color: "var(--muted-deep)" }}>
                    생성된 에셋과 릴 타임라인은 Oberon Film Studio 에서 이어서 편집할 수 있습니다.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `@keyframes indet { 0%{margin-left:-40%} 100%{margin-left:100%} }` }} />
    </div>
  );
}
