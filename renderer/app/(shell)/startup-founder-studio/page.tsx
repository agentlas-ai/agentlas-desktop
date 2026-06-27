"use client";
// Startup Founder Studio — 앱 내 네이티브 구동.
// /hep-network startup 이 띄우던 브라우저 GUI 를 대체한다. 7단계 운영 보드(아이디어→시장→사업→
// PRD→앱→웹→QA)를 게이트형 스텝으로 돌리고, 각 단계는 Hephaestus 엔진(network)으로 해당 HQ에
// 라우팅한다. 브라우저를 띄우지 않고(noOpen) 결과를 네이티브 패널에 렌더한다.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  IconChevronRight,
  IconBolt,
  IconWand,
  IconSearch,
  IconBuilding,
  IconLayers,
  IconShield,
  IconStore,
  IconNetwork,
  IconCheck,
  IconRoute,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type { HephaestusCommandResult, HephaestusStatus } from "@/lib/types";

type StageState = "locked" | "active" | "running" | "done" | "error";

interface Stage {
  id: string;
  title: string;
  sub: string;
  hq: string;
  icon: typeof IconWand;
  prompt: (idea: string, ctx: string) => string;
}

const STAGES: Stage[] = [
  { id: "idea", title: "아이디어 구체화", sub: "문제·고객·비즈니스 모델·검증 계획", hq: "idea-foundry-hq", icon: IconWand,
    prompt: (idea) => `창업 아이디어 구체화: "${idea}". 문제 정의, 타깃 고객, 비즈니스 모델 가설, 2시간/1일/3일 검증 계획을 도출.` },
  { id: "market", title: "시장 검증", sub: "시장 스캔·경쟁사·고객 페르소나", hq: "market-intelligence-hq", icon: IconSearch,
    prompt: (idea, ctx) => `시장 검증: "${idea}". 시장 규모 스캔, 경쟁사 분석, 고객 페르소나, 근거 출처를 제시.\n[이전 단계]\n${ctx}` },
  { id: "business", title: "사업 설계", sub: "사업계획·수익모델·가정", hq: "business-plan-hq", icon: IconBuilding,
    prompt: (idea, ctx) => `사업 설계: "${idea}". 사업계획 개요, 수익 모델, 핵심 가정을 정리.\n[이전 단계]\n${ctx}` },
  { id: "prd", title: "PRD·화면 설계", sub: "PRD·유저 플로우·화면 사양·와이어프레임", hq: "agentlas-prd-maker-studio", icon: IconLayers,
    prompt: (idea, ctx) => `PRD/화면 설계: "${idea}". PRD, 유저 플로우, 핵심 화면 사양, 인터뷰 카드를 작성.\n[이전 단계]\n${ctx}` },
  { id: "app", title: "앱 제작", sub: "iOS/Android/웹 빌드 계획·QA 경로", hq: "product-development-hq", icon: IconBolt,
    prompt: (idea, ctx) => `앱 제작 계획: "${idea}". iOS/Android 빌드 계획, QA 경로, 산출물 미리보기를 제시.\n[이전 단계]\n${ctx}` },
  { id: "web", title: "웹 제작", sub: "웹 빌드 스코프·브라우저 QA", hq: "Web_master", icon: IconNetwork,
    prompt: (idea, ctx) => `웹 제작: "${idea}". 웹 빌드 스코프, 브라우저 QA 경로, 산출물 미리보기를 제시.\n[이전 단계]\n${ctx}` },
  { id: "qa", title: "QA·출시", sub: "릴리스 체크리스트·피치덱·IR", hq: "defect-driven-slide-studio", icon: IconShield,
    prompt: (idea, ctx) => `QA/출시: "${idea}". 릴리스 체크리스트, 피치덱/IR 덱 개요를 작성.\n[이전 단계]\n${ctx}` },
];

function summarize(res: HephaestusCommandResult): string {
  if (res.json) {
    const j = res.json as Record<string, unknown>;
    const action = String(j.action ?? j.decision ?? "routed");
    const sel = (j.selected ?? j.candidate ?? {}) as Record<string, unknown>;
    const name = sel.name_ko ?? sel.name ?? sel.id;
    const lines = [`라우팅: ${action}`];
    if (name) lines.push(`선택 HQ: ${String(name)}`);
    const notes = j.notes;
    if (Array.isArray(notes)) lines.push(...notes.slice(0, 3).map((n) => `· ${String(n)}`));
    return lines.join("\n");
  }
  const out = (res.stdout || res.error || "").trim();
  return out ? out.slice(0, 800) : res.ok ? "완료" : "결과 없음";
}

export default function StartupFounderStudioPage() {
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [idea, setIdea] = useState("");
  const [started, setStarted] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [states, setStates] = useState<StageState[]>(() => STAGES.map((_, i) => (i === 0 ? "active" : "locked")));
  const [results, setResults] = useState<Record<number, string>>({});
  const ctxRef = useRef<Record<number, string>>({});

  useEffect(() => {
    ipc()?.hephaestus.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const setStageState = (idx: number, s: StageState) =>
    setStates((prev) => prev.map((v, i) => (i === idx ? s : v)));

  const begin = () => {
    if (!idea.trim()) return;
    setStarted(true);
    setActiveIdx(0);
    setStates(STAGES.map((_, i) => (i === 0 ? "active" : "locked")));
    setResults({});
    ctxRef.current = {};
  };

  const runStage = async (idx: number) => {
    const api = ipc();
    if (!api) return;
    setStageState(idx, "running");
    const ctx = Object.entries(ctxRef.current)
      .map(([i, v]) => `${STAGES[Number(i)].title}: ${v.slice(0, 300)}`)
      .join("\n");
    const query = STAGES[idx].prompt(idea.trim(), ctx);
    try {
      const res = await api.hephaestus.network({ query, noOpen: true });
      const summary = summarize(res!);
      ctxRef.current[idx] = summary;
      setResults((prev) => ({ ...prev, [idx]: summary }));
      setStageState(idx, "done");
      // 다음 단계 해금
      if (idx + 1 < STAGES.length) {
        setStageState(idx + 1, "active");
        setActiveIdx(idx + 1);
      }
    } catch (e) {
      setResults((prev) => ({ ...prev, [idx]: `오류: ${(e as Error).message}` }));
      setStageState(idx, "error");
    }
  };

  const engineMissing = status ? !status.available : false;
  const allDone = states.every((s) => s === "done");

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
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #845EF7, #5C7CFA)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <IconRoute size={18} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, lineHeight: 1.15, color: "var(--ink)" }}>Startup Founder Studio</h1>
          <p style={{ margin: "2px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>아이디어 → 시장 → 사업 → PRD → 앱 → 웹 → QA · Hephaestus Network 네이티브 구동</p>
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
          <div style={{ maxWidth: 980, margin: "0 auto", width: "100%", padding: 16, borderRadius: 12, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 13 }}>
            ⚠ Hephaestus 엔진을 사용할 수 없습니다: {status?.reason}. Python 3.9+ 설치 후 다시 시도하세요.
          </div>
        )}

        {!started ? (
          <section style={{ maxWidth: 760, margin: "20px auto", width: "100%" }}>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={{ width: 60, height: 60, borderRadius: 16, background: "linear-gradient(135deg, #845EF7, #5C7CFA)", margin: "0 auto 18px", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                <IconRoute size={30} />
              </div>
              <h2 style={{ fontSize: 26, margin: "0 0 10px", color: "var(--ink)" }}>창업 아이디어를 운영 보드로</h2>
              <p style={{ color: "var(--muted-deep)", fontSize: 14.5, maxWidth: 560, margin: "0 auto", lineHeight: 1.6 }}>
                아이디어 한 줄을 적으면 7단계 운영 보드가 각 단계를 Agentlas Hub 전문 HQ로 라우팅해 아이디어·시장·사업·PRD·제품·웹·출시까지 이어갑니다.
              </p>
            </div>
            <div style={{ background: "var(--fill-1)", border: "1px solid var(--paper-edge)", padding: 8, borderRadius: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="예) 1인 가구를 위한 냉장고 재고 기반 레시피 추천 + 자동 장보기 앱"
                style={{ width: "100%", minHeight: 96, padding: 16, fontSize: 15, background: "transparent", border: "none", resize: "none", color: "var(--ink)", outline: "none", lineHeight: 1.5, fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 8px 8px" }}>
                <button
                  onClick={begin}
                  disabled={!idea.trim() || engineMissing}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "0 24px", height: 44, borderRadius: 22, border: "none",
                    background: !idea.trim() || engineMissing ? "var(--fill-3)" : "var(--ink)",
                    color: !idea.trim() || engineMissing ? "var(--muted)" : "#fff",
                    fontWeight: 600, fontSize: 14, cursor: !idea.trim() || engineMissing ? "not-allowed" : "pointer" }}
                >
                  <IconWand size={16} /> 스튜디오 시작
                </button>
              </div>
            </div>
          </section>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 24, maxWidth: 1100, margin: "0 auto", width: "100%" }}>
            {/* 좌: 스텝 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {STAGES.map((s, i) => {
                const st = states[i];
                const Icon = s.icon;
                const isActive = i === activeIdx;
                return (
                  <button
                    key={s.id}
                    onClick={() => st !== "locked" && setActiveIdx(i)}
                    disabled={st === "locked"}
                    style={{
                      display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", borderRadius: 10, border: "none",
                      background: isActive ? "var(--fill-2)" : "transparent",
                      cursor: st === "locked" ? "default" : "pointer", textAlign: "left", opacity: st === "locked" ? 0.45 : 1, transition: "all .2s",
                    }}
                  >
                    <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                      background: st === "done" ? "var(--green-deep, #0ca678)" : st === "error" ? "#fa5252" : st === "running" ? "var(--accent)" : isActive ? "var(--accent)" : "var(--fill-2)",
                      color: st === "done" || st === "error" || st === "running" || isActive ? "#fff" : "var(--muted)" }}>
                      {st === "done" ? <IconCheck size={15} /> : <Icon size={15} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: isActive ? "var(--ink)" : "var(--ink-soft, var(--ink))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i + 1}. {s.title}</span>
                      <span style={{ display: "block", fontSize: 10.5, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.hq}</span>
                    </span>
                    {st === "running" && <span className="sfs-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>

            {/* 우: 활성 단계 패널 */}
            <div style={{ minWidth: 0 }}>
              <StagePanel
                stage={STAGES[activeIdx]}
                idx={activeIdx}
                state={states[activeIdx]}
                result={results[activeIdx]}
                onRun={() => void runStage(activeIdx)}
              />
              {allDone && (
                <div style={{ marginTop: 16, padding: 18, borderRadius: 14, background: "rgba(12,166,120,0.06)", border: "1px dashed rgba(12,166,120,0.35)", display: "flex", alignItems: "center", gap: 12 }}>
                  <IconStore size={20} style={{ color: "#0ca678" }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#0ca678" }}>운영 보드 완성</div>
                    <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--muted-deep)" }}>7단계 라우팅이 모두 완료되었습니다. 각 단계 결과를 좌측에서 다시 확인하세요.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes sfsPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}} .sfs-pulse{animation:sfsPulse 1.2s ease-in-out infinite}` }} />
    </div>
  );
}

function StagePanel({
  stage,
  idx,
  state,
  result,
  onRun,
}: {
  stage: Stage;
  idx: number;
  state: StageState;
  result?: string;
  onRun: () => void;
}) {
  const Icon = stage.icon;
  return (
    <div style={{ borderRadius: 16, border: "1px solid var(--paper-edge)", background: "var(--fill-1)", padding: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, background: "var(--accent)", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <Icon size={19} />
        </span>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, color: "var(--ink)" }}>{idx + 1}. {stage.title}</h3>
          <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--muted-deep)" }}>{stage.sub} · HQ: {stage.hq}</p>
        </div>
        <div style={{ marginLeft: "auto" }}>
          {state === "done" ? (
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: "rgba(12,166,120,0.14)", color: "#0ca678", fontWeight: 600 }}>완료</span>
          ) : state === "running" ? (
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: "var(--fill-2)", color: "var(--accent)", fontWeight: 600 }}>라우팅 중…</span>
          ) : state === "error" ? (
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: "rgba(250,82,82,0.14)", color: "#fa5252", fontWeight: 600 }}>오류</span>
          ) : null}
        </div>
      </div>

      {result ? (
        <pre style={{ margin: "14px 0 0", padding: 14, borderRadius: 10, background: "var(--paper-2)", border: "1px solid var(--paper-edge)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 360, overflowY: "auto", color: "var(--ink-soft, var(--ink))" }}>
          {result}
        </pre>
      ) : (
        <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--muted-deep)", lineHeight: 1.6 }}>
          이 단계를 실행하면 Hephaestus Network 가 <b>{stage.hq}</b> 로 라우팅해 결과를 가져옵니다.
        </p>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <button
          onClick={onRun}
          disabled={state === "running"}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none",
            background: state === "running" ? "var(--fill-2)" : "var(--accent)", color: state === "running" ? "var(--muted)" : "#fff",
            cursor: state === "running" ? "default" : "pointer", fontSize: 13.5, fontWeight: 600 }}
        >
          <IconNetwork size={15} /> {state === "done" ? "다시 실행" : state === "running" ? "라우팅 중…" : "이 단계 실행"}
        </button>
      </div>
    </div>
  );
}
