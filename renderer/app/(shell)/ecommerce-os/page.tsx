"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconChevronRight, IconShoppingBag, IconSlash, IconWand, IconFolder } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { HephaestusBuildEvent, HephaestusStatus } from "@/lib/types";

type Phase = "idle" | "running" | "ready" | "error";

export default function EcommerceOsPage() {
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [stage, setStage] = useState<string>("");
  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<null | (() => void)>(null);
  const termEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ipc()?.hephaestus.status().then(setStatus).catch(() => setStatus(null));
    return () => unsubRef.current?.();
  }, []);
  useEffect(() => {
    termEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  const pickWorkspace = async () => {
    const dir = await ipc()?.fs.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  const startScaffold = async () => {
    const api = ipc();
    const ev = ipcEvents();
    if (!api || !ev || !prompt.trim() || !workspace) return;
    setPhase("running");
    setLog(["Initializing E-Commerce Agent OS...", "Hephaestus 멀티 에이전트 팀 빌더로 커머스 조직을 구성합니다."]);
    setStage("init");

    // 커머스 팀 컨텍스트를 요청에 얹어 team-builder 가 CEO/Storefront/Catalog/Finance 조직을 만들게 한다.
    const request = [
      prompt.trim(),
      "",
      "Build this as a multi-agent COMMERCE team package: a CEO orchestrator plus Storefront (UI/UX),",
      "Catalog & Assets (inventory/images), and Payments & Data (Stripe sandbox + local SQLite) divisions,",
      "with PM Soul, Memory Curator, Policy Gate, and a QA/eval judge. Include an operations dashboard spec.",
    ].join("\n");

    const { runId } = await api.hephaestus.build({ request, mode: "team", workspace });
    runIdRef.current = runId;
    const channel = api.hephaestus.buildEventChannel(runId);
    unsubRef.current = ev.on(channel, (raw) => {
      const e = raw as unknown as HephaestusBuildEvent;
      if (e.kind === "stage") {
        setStage(e.stage ?? "");
        if (e.text) setLog((prev) => [...prev, `▸ ${e.text}`]);
      } else if (e.kind === "log") {
        if (e.text) setLog((prev) => [...prev, e.text!]);
      } else if (e.kind === "partial") {
        // 부분 출력은 마지막 줄에 누적(터미널 톤 유지).
        setLog((prev) => {
          const text = (e.text ?? "").trim();
          if (!text) return prev;
          return [...prev, text.length > 160 ? text.slice(0, 160) + "…" : text];
        });
      } else if (e.kind === "done") {
        setLog((prev) => [...prev, "✓ Commerce OS 팀 패키지 생성 완료", "System ready."]);
        setPhase("ready");
        unsubRef.current?.();
      } else if (e.kind === "error") {
        setLog((prev) => [...prev, `Error: ${e.text ?? "빌드 실패"}`]);
        setPhase("error");
        unsubRef.current?.();
      }
    });
  };

  const cancel = () => {
    if (runIdRef.current) ipc()?.hephaestus.cancelBuild(runIdRef.current);
    setPhase("idle");
    unsubRef.current?.();
  };

  const installToLibrary = async () => {
    if (!workspace) return;
    try {
      await ipc()?.team.importLocalFolder(workspace);
      setLog((prev) => [...prev, "✓ 라이브러리(에이전트 메뉴)에 설치됨"]);
    } catch (e) {
      setLog((prev) => [...prev, `Error: 설치 실패 ${(e as Error).message}`]);
    }
  };

  // Hub 업로드 — 결과를 로그로 피드백(이전엔 fire-and-forget).
  const [uploading, setUploading] = useState(false);
  const uploadToHub = async () => {
    if (!workspace) return;
    setUploading(true);
    setLog((prev) => [...prev, "▸ Hub 업로드…"]);
    try {
      const res = await ipc()?.hephaestus.publish({ folder: workspace, visibility: "marketplace" });
      setLog((prev) => [...prev, res?.ok ? "✓ Hub 업로드 완료" : `Error: 업로드 실패 ${res?.error ?? res?.stderr ?? ""}`]);
    } catch (e) {
      setLog((prev) => [...prev, `Error: 업로드 실패 ${(e as Error).message}`]);
    } finally {
      setUploading(false);
    }
  };

  const restart = () => {
    setPhase("idle");
    setLog([]);
    unsubRef.current?.();
  };

  const engineMissing = status ? !status.available : false;
  const building = phase === "running";

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
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #20c997, #0ca678)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <IconShoppingBag size={18} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, lineHeight: 1.15, color: "var(--ink)" }}>E-Commerce Agent OS</h1>
          <p style={{ margin: "2px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>Hephaestus 팀 빌더 — 커머스 조직 자동 구성</p>
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "40px 60px", display: "flex", flexDirection: "column", gap: 30 }}>
        {engineMissing && (
          <div style={{ maxWidth: 800, margin: "0 auto", width: "100%", padding: 16, borderRadius: 12, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 13 }}>
            ⚠ Hephaestus 엔진을 사용할 수 없습니다: {status?.reason}. Python 3.9+ 설치 후 다시 시도하세요.
          </div>
        )}

        {phase === "idle" && (
          <section style={{ maxWidth: 800, margin: "40px auto", width: "100%" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg, #20c997, #0ca678)", margin: "0 auto 20px", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                <IconShoppingBag size={32} />
              </div>
              <h2 style={{ fontSize: 28, margin: "0 0 12px", color: "var(--ink)" }}>Launch Your Commerce OS</h2>
              <p style={{ color: "var(--muted-deep)", fontSize: 15, maxWidth: 600, margin: "0 auto" }}>
                사업 아이디어를 적으면 Hephaestus 팀 빌더가 CEO·Storefront·Catalog·Finance 에이전트 조직을 설치 가능한 Agentlas 팀 패키지로 만듭니다.
              </p>
            </div>

            <div style={{ background: "var(--fill-1)", border: "1px solid var(--paper-edge)", padding: 8, borderRadius: 16, display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 8px 30px rgba(0,0,0,0.04)" }}>
              <textarea
                placeholder="예) 여자옷 쇼핑몰 사업하고 싶어. 결제, 디비, 이미지 생성, 운영 대시보드까지 알아서 만들어줘."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={{ width: "100%", minHeight: 100, padding: 16, fontSize: 15, background: "transparent", border: "none", resize: "none", color: "var(--ink)", outline: "none", lineHeight: 1.5, fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 8px 8px", gap: 8 }}>
                <button
                  onClick={pickWorkspace}
                  className="titlebar-nodrag"
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--fill-2)", color: workspace ? "var(--ink)" : "var(--muted)", cursor: "pointer", fontSize: 12, maxWidth: 360, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                >
                  <IconFolder size={14} /> {workspace ? workspace.split("/").slice(-2).join("/") : "생성 폴더"}
                </button>
                <button
                  onClick={startScaffold}
                  disabled={!prompt.trim() || !workspace || engineMissing}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8, padding: "0 24px", height: 44, borderRadius: 22, border: "none",
                    background: !prompt.trim() || !workspace || engineMissing ? "var(--fill-3)" : "var(--ink)",
                    color: !prompt.trim() || !workspace || engineMissing ? "var(--muted)" : "#fff",
                    fontWeight: 600, fontSize: 14, cursor: !prompt.trim() || !workspace || engineMissing ? "not-allowed" : "pointer", transition: "all 0.2s",
                  }}
                >
                  <IconWand size={16} /> Scaffold OS
                </button>
              </div>
            </div>
          </section>
        )}

        {phase !== "idle" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 30, maxWidth: 1200, margin: "0 auto", width: "100%" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <section style={{ padding: 24, borderRadius: 16, background: "var(--fill-1)", border: "1px solid var(--paper-edge)" }}>
                <h3 style={{ fontSize: 16, margin: "0 0 16px", color: "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: phase === "ready" ? "#51cf66" : phase === "error" ? "#fa5252" : "#fcc419" }} />
                  Commerce Team Org Chart
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20, background: "var(--paper)", borderRadius: 12, border: "1px dashed var(--paper-edge)" }}>
                  <div style={{ textAlign: "center", padding: 12, background: "rgba(12, 166, 120, 0.1)", color: "#0ca678", borderRadius: 8, fontWeight: 600 }}>CEO Agent</div>
                  <div style={{ display: "flex", gap: 12 }}>
                    {["Storefront", "Catalog", "Finance"].map((d) => (
                      <div key={d} style={{ flex: 1, textAlign: "center", padding: 12, background: "var(--fill-2)", color: "var(--ink-soft)", borderRadius: 8, fontSize: 13, fontWeight: 500, opacity: building ? 0.6 : 1, transition: "opacity 0.5s" }}>{d}</div>
                    ))}
                  </div>
                </div>
              </section>

              <section style={{ padding: 24, borderRadius: 16, background: "#1E1E1E", color: "#D4D4D4", flex: 1, display: "flex", flexDirection: "column", minHeight: 280 }}>
                <h3 style={{ fontSize: 14, margin: "0 0 16px", color: "#858585", display: "flex", alignItems: "center", gap: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                  <IconSlash size={14} /> OS Boot Sequence {building && <span style={{ color: "#fcc419", textTransform: "none" }}>· {stage}</span>}
                </h3>
                <div style={{ fontFamily: "Menlo, Monaco, monospace", fontSize: 12, lineHeight: 1.6, overflowY: "auto", flex: 1, maxHeight: 320 }}>
                  {log.map((line, i) => (
                    <div key={i} style={{ color: line.startsWith("✓") ? "#4CAF50" : line.startsWith("Error") ? "#F44336" : line.startsWith("▸") ? "#4DABF7" : "#D4D4D4", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {line}
                    </div>
                  ))}
                  {building && <div style={{ color: "#858585", marginTop: 8 }}>_</div>}
                  <div ref={termEndRef} />
                </div>
              </section>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <section style={{ padding: 24, borderRadius: 16, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", opacity: phase === "ready" ? 1 : 0.6, transition: "opacity 0.5s" }}>
                <h3 style={{ fontSize: 16, margin: "0 0 20px", color: "var(--ink)" }}>패키지</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ paddingBottom: 16, borderBottom: "1px solid var(--paper-edge)" }}>
                    <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>생성 폴더</div>
                    <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500, fontFamily: "monospace", wordBreak: "break-all" }}>{workspace}</div>
                  </div>
                  <div style={{ paddingBottom: 16, borderBottom: "1px solid var(--paper-edge)" }}>
                    <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>유형</div>
                    <div style={{ fontSize: 14, color: "#0ca678", fontWeight: 600 }}>멀티 에이전트 커머스 팀</div>
                  </div>
                </div>
                {phase === "ready" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
                    <button onClick={installToLibrary} style={{ padding: "10px 14px", background: "var(--ink)", color: "#fff", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>라이브러리에 설치</button>
                    <button onClick={() => void uploadToHub()} disabled={uploading} style={{ padding: "10px 14px", background: "var(--fill-2)", color: "var(--ink)", borderRadius: 8, border: "1px solid var(--paper-edge)", fontSize: 13, fontWeight: 600, cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.6 : 1 }}>{uploading ? "업로드 중…" : "Hub 업로드"}</button>
                  </div>
                )}
              </section>
              {building ? (
                <button onClick={cancel} style={{ padding: "11px 14px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", color: "var(--ink)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  중지
                </button>
              ) : phase === "error" ? (
                <button onClick={restart} style={{ padding: "11px 14px", borderRadius: 10, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  새로 시작
                </button>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
