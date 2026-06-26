"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconBuilding, IconChevronRight, IconUsers, IconWand, IconFolder, IconBolt } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { HephaestusBuildEvent, HephaestusStatus } from "@/lib/types";

type Mode = "single" | "team" | "package";
type Phase = "idle" | "running" | "done" | "error";

interface LogLine {
  kind: HephaestusBuildEvent["kind"];
  text: string;
}

const MODES: { id: Mode; label: string; desc: string; icon: typeof IconBuilding }[] = [
  { id: "single", label: "단일 에이전트", desc: "설치 가능한 워커 하나 — 메모리·스킬·자가진화", icon: IconWand },
  { id: "team", label: "멀티 에이전트 팀", desc: "오케스트레이터·PM·큐레이터·정책게이트·워커 조직", icon: IconUsers },
  { id: "package", label: "기존 에이전트 패키징", desc: "외부/로컬 에이전트를 Agentlas 아키텍처로 변환·복구", icon: IconBuilding },
];

export default function BuildPage() {
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [request, setRequest] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<LogLine[]>([]);
  const [stage, setStage] = useState<string>("");
  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<null | (() => void)>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ipc()?.hephaestus.status().then(setStatus).catch(() => setStatus(null));
    return () => {
      unsubRef.current?.();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  const pickWorkspace = async () => {
    const dir = await ipc()?.fs.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  const start = async () => {
    const api = ipc();
    const ev = ipcEvents();
    if (!api || !ev || !request.trim() || !workspace || phase === "running") return;
    setPhase("running");
    setLog([{ kind: "stage", text: "빌더 초기화…" }]);
    setStage("init");

    const { runId } = await api.hephaestus.build({
      request: request.trim(),
      mode: mode || undefined,
      workspace,
    });
    runIdRef.current = runId;
    const channel = api.hephaestus.buildEventChannel(runId);
    unsubRef.current = ev.on(channel, (raw) => {
      const e = raw as unknown as HephaestusBuildEvent;
      if (e.kind === "partial") {
        setLog((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "partial") {
            return [...prev.slice(0, -1), { kind: "partial", text: (last.text + (e.text ?? "")).slice(-4000) }];
          }
          return [...prev, { kind: "partial", text: e.text ?? "" }];
        });
      } else if (e.kind === "stage") {
        setStage(e.stage ?? "");
        setLog((prev) => [...prev, { kind: "stage", text: e.text ?? e.stage ?? "" }]);
      } else if (e.kind === "log") {
        setLog((prev) => [...prev, { kind: "log", text: e.text ?? "" }]);
      } else if (e.kind === "done") {
        setLog((prev) => [...prev, { kind: "done", text: "빌드 완료" }]);
        setPhase("done");
        unsubRef.current?.();
      } else if (e.kind === "error") {
        setLog((prev) => [...prev, { kind: "error", text: e.text ?? "오류" }]);
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
      setLog((prev) => [...prev, { kind: "log", text: "✓ 라이브러리에 설치됨 — 에이전트 메뉴에서 확인하세요." }]);
    } catch (e) {
      setLog((prev) => [...prev, { kind: "error", text: `설치 실패: ${(e as Error).message}` }]);
    }
  };

  const upload = async (visibility: "private-link" | "marketplace") => {
    if (!workspace) return;
    setLog((prev) => [...prev, { kind: "stage", text: `업로드(${visibility === "marketplace" ? "Hub" : "Cloud"})…` }]);
    const res = await ipc()?.hephaestus.publish({ folder: workspace, visibility });
    setLog((prev) => [
      ...prev,
      { kind: res?.ok ? "done" : "error", text: res?.ok ? "✓ 업로드 완료" : `업로드 실패: ${res?.error ?? res?.stderr ?? "알 수 없음"}` },
    ]);
  };

  const engineMissing = status ? !status.available : false;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--paper)" }}>
      <header
        className="titlebar-drag"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 32px 14px 90px",
          borderBottom: "1px solid var(--glass-border)",
          minHeight: 64,
          flexShrink: 0,
        }}
      >
        <Link href="/apps" className="titlebar-nodrag" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Apps
        </Link>
        <div style={{ width: 1, height: 20, background: "var(--paper-edge)", margin: "0 4px" }} />
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #4DABF7, #845EF7)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <IconBuilding size={18} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, lineHeight: 1.15, color: "var(--ink)" }}>Agent Forge: Build</h1>
          <p style={{ margin: "2px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>Hephaestus 빌더 엔진 — 에이전트·팀 생성/패키징</p>
        </div>
        {status?.available && (
          <span style={{ marginLeft: "auto" }} className="titlebar-nodrag">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", padding: "4px 10px", borderRadius: 999, background: "var(--fill-1)", border: "1px solid var(--paper-edge)" }}>
              <IconBolt size={12} /> 엔진 준비됨 · Python {status.version}
            </span>
          </span>
        )}
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "32px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
        {engineMissing && (
          <div style={{ maxWidth: 880, margin: "0 auto", width: "100%", padding: 16, borderRadius: 12, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 13 }}>
            ⚠ Hephaestus 엔진을 사용할 수 없습니다: {status?.reason}. Python 3.9+ 설치 후 다시 시도하세요.
          </div>
        )}

        <section style={{ maxWidth: 880, margin: "0 auto", width: "100%" }}>
          <h2 style={{ fontSize: 22, margin: "0 0 8px", color: "var(--ink)" }}>무엇을 만들까요?</h2>
          <p style={{ color: "var(--muted-deep)", fontSize: 14, margin: "0 0 16px" }}>
            요청을 자연어로 적으면 Hephaestus 빌더가 인터뷰·리서치 후 설치 가능한 Agentlas 패키지를 폴더에 생성합니다.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
            {MODES.map((m) => {
              const active = mode === m.id;
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  onClick={() => setMode(active ? "" : m.id)}
                  disabled={phase === "running"}
                  style={{
                    textAlign: "left",
                    padding: 14,
                    borderRadius: 12,
                    border: `1px solid ${active ? "var(--accent)" : "var(--paper-edge)"}`,
                    background: active ? "var(--fill-2)" : "var(--fill-1)",
                    cursor: phase === "running" ? "default" : "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, color: active ? "var(--accent)" : "var(--ink)" }}>
                    <Icon size={16} />
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{m.label}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.4 }}>{m.desc}</p>
                </button>
              );
            })}
          </div>
          <p style={{ margin: "0 0 16px", fontSize: 11.5, color: "var(--muted)" }}>모드 미선택 시 엔진이 자동 분류합니다.</p>

          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            disabled={phase === "running"}
            placeholder="예) 인스타그램 마케팅 운영 에이전트 — 트렌드 리서치, 캡션 작성, 해시태그 추천을 하고 매주 자가 학습"
            rows={3}
            style={{
              width: "100%",
              padding: "14px 16px",
              fontSize: 14,
              borderRadius: 12,
              border: "1px solid var(--paper-edge)",
              background: "var(--fill-1)",
              color: "var(--ink)",
              outline: "none",
              resize: "vertical",
              fontFamily: "inherit",
              lineHeight: 1.5,
              boxSizing: "border-box",
            }}
          />

          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <button
              onClick={pickWorkspace}
              disabled={phase === "running"}
              className="titlebar-nodrag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "11px 14px",
                borderRadius: 10,
                border: "1px solid var(--paper-edge)",
                background: "var(--fill-1)",
                color: workspace ? "var(--ink)" : "var(--muted)",
                cursor: "pointer",
                fontSize: 13,
                maxWidth: 420,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              <IconFolder size={15} />
              {workspace ? workspace.split("/").slice(-2).join("/") : "생성 폴더 선택"}
            </button>
            <div style={{ flex: 1 }} />
            {phase === "running" ? (
              <button
                onClick={cancel}
                style={{ padding: "11px 22px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--fill-2)", color: "var(--ink)", cursor: "pointer", fontSize: 14, fontWeight: 600 }}
              >
                중지
              </button>
            ) : (
              <button
                onClick={start}
                disabled={!request.trim() || !workspace || engineMissing}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "11px 22px",
                  borderRadius: 10,
                  border: "none",
                  background: !request.trim() || !workspace || engineMissing ? "var(--fill-2)" : "var(--accent)",
                  color: !request.trim() || !workspace || engineMissing ? "var(--muted)" : "#fff",
                  cursor: !request.trim() || !workspace || engineMissing ? "default" : "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                <IconWand size={15} /> 빌드 시작
              </button>
            )}
          </div>
        </section>

        {log.length > 0 && (
          <section style={{ maxWidth: 880, margin: "0 auto", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <h3 style={{ fontSize: 14, margin: 0, color: "var(--ink)" }}>빌드 진행</h3>
              {phase === "running" && (
                <span style={{ fontSize: 11, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", display: "inline-block" }} />
                  {stage || "실행 중"}
                </span>
              )}
            </div>
            <div
              style={{
                borderRadius: 12,
                border: "1px solid var(--paper-edge)",
                background: "#0d1117",
                padding: 16,
                maxHeight: 360,
                overflowY: "auto",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {log.map((l, i) => (
                <div
                  key={i}
                  style={{
                    color:
                      l.kind === "error"
                        ? "#ff7b72"
                        : l.kind === "done"
                          ? "#3fb950"
                          : l.kind === "stage"
                            ? "#79c0ff"
                            : l.kind === "partial"
                              ? "#c9d1d9"
                              : "#8b949e",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {l.kind === "stage" ? `▸ ${l.text}` : l.text}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            {phase === "done" && (
              <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                <button onClick={installToLibrary} style={actionBtn(true)}>라이브러리에 설치</button>
                <button onClick={() => upload("private-link")} style={actionBtn(false)}>Cloud 업로드(비공개)</button>
                <button onClick={() => upload("marketplace")} style={actionBtn(false)}>Hub 업로드(공개)</button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function actionBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "10px 18px",
    borderRadius: 10,
    border: primary ? "none" : "1px solid var(--paper-edge)",
    background: primary ? "var(--accent)" : "var(--fill-1)",
    color: primary ? "#fff" : "var(--ink)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  };
}
