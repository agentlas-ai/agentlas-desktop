"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  IconBuilding,
  IconChevronRight,
  IconUsers,
  IconWand,
  IconFolder,
  IconBolt,
  IconRoute,
  IconSearch,
  IconShield,
  IconStore,
  IconCheck,
} from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { HephaestusBuildEvent, HephaestusStatus } from "@/lib/types";

type Mode = "single" | "team" | "package";
type Phase = "idle" | "running" | "done" | "error";
type StageState = "pending" | "active" | "done" | "error";

interface LogLine {
  kind: HephaestusBuildEvent["kind"];
  text: string;
}

const MODES: { id: Mode; label: string; desc: string; icon: typeof IconBuilding }[] = [
  { id: "single", label: "단일 에이전트", desc: "설치 가능한 워커 하나 — 메모리·스킬·자가진화", icon: IconWand },
  { id: "team", label: "멀티 에이전트 팀", desc: "오케스트레이터·PM·큐레이터·정책게이트·워커 조직", icon: IconUsers },
  { id: "package", label: "기존 에이전트 패키징", desc: "외부/로컬 에이전트를 Agentlas 아키텍처로 변환·복구", icon: IconBuilding },
];

// /hep-build 의 표준 파이프라인 단계 — 빌더 에이전트 규율(모드 분류 → 인터뷰/리서치 게이트 →
// 패키지 생성 → 검증 → 배포)을 시각화한다.
const STAGES: { key: string; label: string; sub: string; icon: typeof IconRoute; color: string }[] = [
  { key: "classify", label: "모드 분류", sub: "단일 · 팀 · 패키지 판정", icon: IconRoute, color: "#4DABF7" },
  { key: "research", label: "인터뷰 & 리서치", sub: "요구사항 인터뷰 · 공식 소스 조사", icon: IconSearch, color: "#9775FA" },
  { key: "generate", label: "패키지 생성", sub: "AGENTS.md · 어댑터 · .agentlas 파일 작성", icon: IconWand, color: "#F783AC" },
  { key: "verify", label: "검증", sub: "정적 보안 스캔 · 패키지 무결성", icon: IconShield, color: "#4DD4AC" },
  { key: "deliver", label: "배포", sub: "라이브러리 설치 · Cloud/Hub 업로드", icon: IconStore, color: "#FFA94D" },
];

const ACTION_CONTRACTS = [
  { label: "hep-build", desc: "요청을 설치 가능한 Agentlas 패키지로 생성", icon: IconWand },
  { label: "install", desc: "현재 폴더를 Agents Library와 Chat 라우팅에 등록", icon: IconCheck },
  { label: "Cloud private", desc: "검토용 비공개 링크로 업로드", icon: IconBolt },
  { label: "Hub public", desc: "공개 Marketplace 제출 흐름으로 업로드", icon: IconStore },
];

// 이벤트 신호에서 도달한 최대 단계 인덱스를 추정(전진 전용).
const WRITE_SIGNALS = /write|edit|create|touch|mkdir|apply_patch|str_replace|\.md|agentlas\.json|\.agentlas|파일|생성|scaffold/i;
function stageFromEvent(ev: HephaestusBuildEvent, current: number): number {
  const t = `${ev.stage ?? ""} ${ev.text ?? ""}`;
  if (ev.kind === "done") return STAGES.length; // 전부 완료
  if (ev.kind === "stage" && (ev.stage === "security" || /보안|security/i.test(t))) return Math.max(current, 3);
  if (WRITE_SIGNALS.test(t)) return Math.max(current, 2); // 파일 쓰기 = 생성 단계
  if (ev.kind === "partial" || ev.kind === "log" || ev.kind === "stage") return Math.max(current, 1); // LLM 가동 = 인터뷰/리서치
  return current;
}

export default function BuildPage() {
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [request, setRequest] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<LogLine[]>([]);
  const [reached, setReached] = useState(0); // 도달한 최대 단계(0..STAGES.length)
  const [errored, setErrored] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<null | (() => void)>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ipc()?.hephaestus.status().then(setStatus).catch(() => setStatus(null));
    return () => unsubRef.current?.();
  }, []);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // 단계 상태 배열 도출.
  const stageStates: StageState[] = useMemo(() => {
    return STAGES.map((_, i) => {
      if (errored && i === Math.min(reached, STAGES.length - 1)) return "error";
      if (i < reached) return "done";
      if (i === reached && phase === "running") return "active";
      if (phase === "done") return "done";
      return "pending";
    });
  }, [reached, phase, errored]);

  const pickWorkspace = async () => {
    const dir = await ipc()?.fs.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  const start = async () => {
    const api = ipc();
    const ev = ipcEvents();
    if (!api || !ev || !request.trim() || !workspace || phase === "running") return;
    setPhase("running");
    setErrored(false);
    setReached(0);
    setLog([{ kind: "stage", text: "빌더 초기화 — Hephaestus 빌더 에이전트 가동" }]);

    const { runId } = await api.hephaestus.build({ request: request.trim(), mode: mode || undefined, workspace });
    runIdRef.current = runId;
    const channel = api.hephaestus.buildEventChannel(runId);
    unsubRef.current = ev.on(channel, (raw) => {
      const e = raw as unknown as HephaestusBuildEvent;
      setReached((cur) => stageFromEvent(e, cur));
      if (e.kind === "partial") {
        setLog((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "partial") {
            return [...prev.slice(0, -1), { kind: "partial", text: (last.text + (e.text ?? "")).slice(-4000) }];
          }
          return [...prev, { kind: "partial", text: e.text ?? "" }];
        });
      } else if (e.kind === "stage") {
        setLog((prev) => [...prev, { kind: "stage", text: e.text ?? e.stage ?? "" }]);
      } else if (e.kind === "log") {
        setLog((prev) => [...prev, { kind: "log", text: e.text ?? "" }]);
      } else if (e.kind === "done") {
        setReached(STAGES.length);
        setLog((prev) => [...prev, { kind: "done", text: "빌드 완료 — 패키지 생성됨" }]);
        setPhase("done");
        unsubRef.current?.();
      } else if (e.kind === "error") {
        setErrored(true);
        setLog((prev) => [...prev, { kind: "error", text: e.text ?? "오류" }]);
        setPhase("error");
        unsubRef.current?.();
      }
    });
    // 구독이 끝났음을 메인에 알려 버퍼링된 초기 이벤트(첫 stage 틱)를 flush 받는다.
    void api.hephaestus.buildReady(runId);
  };

  const cancel = () => {
    if (runIdRef.current) ipc()?.hephaestus.cancelBuild(runIdRef.current);
    setPhase("idle");
    setReached(0);
    unsubRef.current?.();
  };

  const reset = () => {
    setPhase("idle");
    setReached(0);
    setErrored(false);
    setLog([]);
  };

  const installToLibrary = async () => {
    if (!workspace) return;
    try {
      await ipc()?.team.importLocalFolder(workspace);
      setLog((prev) => [...prev, { kind: "log", text: "완료: 라이브러리에 설치됨 - 에이전트 메뉴에서 확인하세요." }]);
    } catch (e) {
      setLog((prev) => [...prev, { kind: "error", text: `설치 실패: ${(e as Error).message}` }]);
    }
  };

  const upload = async (visibility: "private-link" | "marketplace") => {
    if (!workspace) return;
    setLog((prev) => [...prev, { kind: "stage", text: `업로드(${visibility === "marketplace" ? "Hub public" : "Cloud private"})...` }]);
    const res = await ipc()?.hephaestus.publish({ folder: workspace, visibility });
    setLog((prev) => [
      ...prev,
      { kind: res?.ok ? "done" : "error", text: res?.ok ? "완료: 업로드 완료" : `업로드 실패: ${res?.error ?? res?.stderr ?? "알 수 없음"}` },
    ]);
  };

  const engineMissing = status ? !status.available : false;
  const running = phase === "running";
  // 파이프라인은 항상 표시 — idle 에선 딤된 프리뷰로 무엇을 할지 보여준다.
  const showPipeline = true;

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
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #4DABF7, #845EF7)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <IconBuilding size={18} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, lineHeight: 1.15, color: "var(--ink)" }}>Agent Forge: Build</h1>
          <p style={{ margin: "2px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>hep-build - Hephaestus 빌더 파이프라인</p>
        </div>
        {status?.available && (
          <span style={{ marginLeft: "auto" }} className="titlebar-nodrag">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", padding: "4px 10px", borderRadius: 999, background: "var(--fill-1)", border: "1px solid var(--paper-edge)" }}>
              <IconBolt size={12} /> 엔진 준비됨 · Python {status.version}
            </span>
          </span>
        )}
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "28px 40px", display: "flex", flexDirection: "column", gap: 22 }}>
        {engineMissing && (
          <div style={{ maxWidth: 1000, margin: "0 auto", width: "100%", padding: 16, borderRadius: 12, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <IconShield size={15} style={{ color: "var(--amber-deep)", flexShrink: 0, marginTop: 1 }} />
            <span>Hephaestus 엔진을 사용할 수 없습니다: {status?.reason}. Python 3.9+ 설치 후 다시 시도하세요.</span>
          </div>
        )}

        {/* ── 컨트롤 ── */}
        <section style={{ maxWidth: 1000, margin: "0 auto", width: "100%" }}>
          <h2 style={{ fontSize: 21, margin: "0 0 6px", color: "var(--ink)" }}>무엇을 만들까요?</h2>
          <p style={{ color: "var(--muted-deep)", fontSize: 13.5, margin: "0 0 16px" }}>
            요청을 적으면 빌더가 인터뷰·리서치 후 설치 가능한 Agentlas 패키지를 폴더에 생성합니다. 아래에서 진행이 단계별로 시각화됩니다.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
            {ACTION_CONTRACTS.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} style={{ border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--fill-1)", padding: 12, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5, color: "var(--ink)" }}>
                    <Icon size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                    <strong style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</strong>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.35 }}>{item.desc}</div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 14 }}>
            {MODES.map((m) => {
              const active = mode === m.id;
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  onClick={() => setMode(active ? "" : m.id)}
                  disabled={running}
                  style={{
                    textAlign: "left", padding: 14, borderRadius: 12,
                    border: `1px solid ${active ? "var(--accent)" : "var(--paper-edge)"}`,
                    background: active ? "var(--fill-2)" : "var(--fill-1)",
                    cursor: running ? "default" : "pointer", transition: "all 0.15s",
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

          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            disabled={running}
            placeholder="예) 인스타그램 마케팅 운영 에이전트 — 트렌드 리서치, 캡션 작성, 해시태그 추천을 하고 매주 자가 학습"
            rows={2}
            style={{ width: "100%", padding: "14px 16px", fontSize: 14, borderRadius: 12, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", color: "var(--ink)", outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }}
          />

          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <button onClick={pickWorkspace} disabled={running} className="titlebar-nodrag"
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "11px 14px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", color: workspace ? "var(--ink)" : "var(--muted)", cursor: "pointer", fontSize: 13, maxWidth: 420, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              <IconFolder size={15} />
              {workspace ? workspace.split("/").slice(-2).join("/") : "생성 폴더 선택"}
            </button>
            <div style={{ flex: 1 }} />
            {running ? (
              <button onClick={cancel} style={{ padding: "11px 22px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--fill-2)", color: "var(--ink)", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>중지</button>
            ) : phase === "done" || phase === "error" ? (
              <button onClick={reset} style={{ padding: "11px 22px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", color: "var(--ink)", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>새 빌드</button>
            ) : (
              <>
                {(!request.trim() || !workspace) && !engineMissing && (
                  <span style={{ fontSize: 12, color: "var(--muted)", marginRight: 10, alignSelf: "center" }}>
                    {!request.trim() ? "요청을 입력하세요" : "생성 폴더를 선택하세요"}
                  </span>
                )}
                <button onClick={start} disabled={!request.trim() || !workspace || engineMissing}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "11px 24px", borderRadius: 10, border: "none",
                    background: !request.trim() || !workspace || engineMissing ? "var(--fill-2)" : "linear-gradient(135deg, #4DABF7, #845EF7)",
                    color: !request.trim() || !workspace || engineMissing ? "var(--muted)" : "#fff",
                    cursor: !request.trim() || !workspace || engineMissing ? "default" : "pointer", fontSize: 14, fontWeight: 600 }}>
                  <IconWand size={15} /> 빌드 시작
                </button>
              </>
            )}
          </div>
        </section>

        {/* ── 시각화 파이프라인 ── */}
        {showPipeline && (
          <section style={{ maxWidth: 1000, margin: "0 auto", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <h3 style={{ fontSize: 13, margin: 0, color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "var(--font-mono)" }}>Forge Pipeline</h3>
              {running ? (
                <span style={{ fontSize: 11, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span className="forge-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", display: "inline-block" }} />
                  {STAGES[Math.min(reached, STAGES.length - 1)].label}
                </span>
              ) : phase === "idle" ? (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>빌드 시작 시 단계별로 진행됩니다</span>
              ) : null}
            </div>

            <div style={{ borderRadius: 16, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", padding: "18px 20px" }}>
              {STAGES.map((s, i) => (
                <StageRow key={s.key} stage={s} state={stageStates[i]} isLast={i === STAGES.length - 1} index={i} />
              ))}
            </div>
          </section>
        )}

        {/* ── 라이브 터미널 ── */}
        {log.length > 0 && (
          <section style={{ maxWidth: 1000, margin: "0 auto", width: "100%" }}>
            <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "var(--font-mono)" }}>Build Log</h3>
            <div style={{ borderRadius: 12, border: "1px solid var(--paper-edge)", background: "#0d1117", padding: 16, maxHeight: 300, overflowY: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.6 }}>
              {log.map((l, i) => (
                <div key={i} style={{ color: l.kind === "error" ? "#ff7b72" : l.kind === "done" ? "#3fb950" : l.kind === "stage" ? "#79c0ff" : l.kind === "partial" ? "#c9d1d9" : "#8b949e", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {l.kind === "stage" ? `> ${l.text}` : l.text}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            {phase === "done" && (
              <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#0ca678", fontSize: 13, fontWeight: 600, marginRight: 4 }}>
                  <IconCheck size={15} /> 패키지 준비됨
                </span>
                <button onClick={installToLibrary} style={actionBtn(true)}>라이브러리에 설치</button>
                <button onClick={() => upload("private-link")} style={actionBtn(false)}>Cloud private 업로드</button>
                <button onClick={() => upload("marketplace")} style={actionBtn(false)}>Hub public 제출</button>
              </div>
            )}
          </section>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes forgePulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.82); } }
        @keyframes forgeGlow { 0%,100% { box-shadow: 0 0 0 0 var(--forge-c, #4DABF7)40; } 50% { box-shadow: 0 0 0 6px transparent; } }
        .forge-pulse { animation: forgePulse 1.2s ease-in-out infinite; }
      `}} />
    </div>
  );
}

function StageRow({
  stage,
  state,
  isLast,
  index,
}: {
  stage: (typeof STAGES)[number];
  state: StageState;
  isLast: boolean;
  index: number;
}) {
  const Icon = stage.icon;
  const c = stage.color;
  const active = state === "active";
  const done = state === "done";
  const error = state === "error";
  const dim = state === "pending";

  const nodeBg = error ? "#fa5252" : done ? c : active ? c : "var(--fill-3)";
  const nodeColor = done || active || error ? "#fff" : "var(--muted)";

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "stretch", opacity: dim ? 0.5 : 1, transition: "opacity 0.4s" }}>
      {/* spine + node */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 40, flexShrink: 0 }}>
        <div
          style={{
            width: 40, height: 40, borderRadius: 12, background: nodeBg, color: nodeColor,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            border: active ? `2px solid ${c}` : "2px solid transparent",
            boxShadow: active ? `0 0 0 4px ${c}22` : "none",
            transition: "all 0.3s",
          }}
        >
          {done ? <IconCheck size={18} /> : <Icon size={18} />}
        </div>
        {!isLast && (
          <div
            style={{
              flex: 1,
              minHeight: 28,
              width: 3,
              borderRadius: 999,
              background: done || active ? c : "var(--paper-edge)",
              opacity: active ? 0.65 : 1,
              transition: "background 0.25s, opacity 0.25s",
            }}
          />
        )}
      </div>

      {/* card */}
      <div style={{ flex: 1, paddingBottom: isLast ? 0 : 16, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: error ? "#fa5252" : active ? c : "var(--ink)" }}>{stage.label}</span>
          {active && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: `${c}1e`, color: c, fontWeight: 600 }}>진행 중</span>}
          {done && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: "rgba(12,166,120,0.14)", color: "#0ca678", fontWeight: 600 }}>완료</span>}
          {error && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: "rgba(250,82,82,0.14)", color: "#fa5252", fontWeight: 600 }}>중단</span>}
        </div>
        <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--muted-deep)", lineHeight: 1.4 }}>{stage.sub}</p>
      </div>
    </div>
  );
}

function actionBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "10px 18px", borderRadius: 10,
    border: primary ? "none" : "1px solid var(--paper-edge)",
    background: primary ? "var(--accent)" : "var(--fill-1)",
    color: primary ? "#fff" : "var(--ink)",
    cursor: "pointer", fontSize: 13, fontWeight: 600,
  };
}
