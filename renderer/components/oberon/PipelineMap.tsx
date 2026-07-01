// Oberon — Pipeline Map. 13개 제작 에이전트의 흐름과 단계 상태 시각화.
// 사람은 방향·승인만, 에이전트가 샷을 나누고·생성하고·검사하고·재시도한다.
"use client";
import { useState } from "react";
import {
  FILM_AGENTS,
  PIPELINE_STAGES,
  QUALITY_GATES,
  agentById,
  agentList,
  agentText,
  type FilmAgentDefI18n,
  type FilmProduction,
  type PipelineStageKey,
  type StageStatus,
} from "@/lib/oberon";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n";
import { IconRoute, IconChevronRight, IconLock, IconCheck, IconTarget } from "@/components/Icon";
import { Card, PanelHead, Tag } from "./ui";

const STATUS_STYLE: Record<StageStatus, { color: string; bg: string }> = {
  locked: { color: "var(--muted-deep)", bg: "var(--fill-1)" },
  ready: { color: "var(--accent)", bg: "color-mix(in srgb, var(--accent) 12%, transparent)" },
  active: { color: "var(--peach-ink)", bg: "color-mix(in srgb, var(--peach-ink) 14%, transparent)" },
  blocked: { color: "var(--red-deep)", bg: "color-mix(in srgb, var(--red-deep) 12%, transparent)" },
  done: { color: "var(--green-deep)", bg: "color-mix(in srgb, var(--green-deep) 14%, transparent)" },
};

const STATUS_LABEL: Record<StageStatus, { ko: string; en: string }> = {
  locked: { ko: "잠김", en: "Locked" },
  ready: { ko: "대기", en: "Ready" },
  active: { ko: "진행", en: "Active" },
  blocked: { ko: "차단", en: "Blocked" },
  done: { ko: "완료", en: "Done" },
};

function statusLabel(status: StageStatus, locale: Locale): string {
  return locale === "ko" ? STATUS_LABEL[status].ko : STATUS_LABEL[status].en;
}

export function PipelineMap({
  production,
  onNavigate,
}: {
  production: FilmProduction | null;
  onNavigate?: (stage: PipelineStageKey) => void;
}) {
  const { locale } = useT();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const stageStatus = production?.stageStatus;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
      <PanelHead
        title={locale === "ko" ? "Pipeline — 제작 에이전트 라우팅" : "Pipeline — Production Agent Routing"}
        subtitle={
          locale === "ko"
            ? "기획 → 샷 리스트 → 레퍼런스 → 승인 → 생성 → QA → 편집 → 납품. 각 단계가 곧 하나의 에이전트이며, 비싼 생성 전에 7개 품질 게이트를 통과해야 합니다."
            : "Brief → Shot List → Reference → Approval → Generation → QA → Edit → Delivery. Each stage is a single agent, and 7 quality gates must pass before any expensive generation."
        }
        icon={<IconRoute size={18} />}
      />

      {/* 스테이지 플로우 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "stretch", marginBottom: 26 }}>
        {PIPELINE_STAGES.map((stage, i) => {
          const status: StageStatus = stageStatus?.[stage.key] ?? "locked";
          const st = STATUS_STYLE[status];
          const agents = stage.agentIds.map((id) => agentById(id)).filter(Boolean) as FilmAgentDefI18n[];
          return (
            <div key={stage.key} style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
              <button
                onClick={() => onNavigate?.(stage.key)}
                style={{
                  width: 150,
                  textAlign: "left",
                  border: `1px solid ${status === "locked" ? "var(--paper-edge)" : st.color}`,
                  background: st.bg,
                  borderRadius: 12,
                  padding: "10px 11px",
                  cursor: onNavigate ? "pointer" : "default",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  transition: "all 0.15s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--muted-deep)" }}>{String(i).padStart(2, "0")}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)", flex: 1 }}>{agentText(stage.name, stage.nameEn, locale)}</span>
                  {stage.humanGate && <IconTarget size={11} style={{ color: "var(--peach-ink)" }} />}
                  {status === "done" && <IconCheck size={12} style={{ color: "var(--green-deep)" }} />}
                  {status === "locked" && <IconLock size={10} style={{ color: "var(--muted-deep)" }} />}
                </div>
                <div style={{ fontSize: 10, color: "var(--muted-deep)", lineHeight: 1.35 }}>{agentText(stage.summary, stage.summaryEn, locale)}</div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                  {agents.map((a) => (
                    <span
                      key={a.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedAgent(a.id === selectedAgent ? null : a.id);
                      }}
                      style={{
                        fontSize: 9,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 700,
                        color: "#fff",
                        background: a.accent,
                        padding: "1px 5px",
                        borderRadius: 5,
                        cursor: "pointer",
                        opacity: selectedAgent && selectedAgent !== a.id ? 0.4 : 1,
                      }}
                      title={agentText(a.name, a.nameEn, locale)}
                    >
                      {a.code}
                    </span>
                  ))}
                </div>
                <span style={{ fontSize: 9, fontWeight: 700, color: st.color, fontFamily: "var(--font-mono)" }}>● {statusLabel(status, locale)}</span>
              </button>
              {i < PIPELINE_STAGES.length - 1 && (
                <div style={{ display: "flex", alignItems: "center", color: "var(--muted)" }}>
                  <IconChevronRight size={14} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 선택 에이전트 상세 */}
      {selectedAgent && <AgentDetail agent={agentById(selectedAgent)!} onClose={() => setSelectedAgent(null)} locale={locale} />}

      {/* 품질 게이트 */}
      <div style={{ ...sectionLabel, marginTop: 8 }}>
        {locale === "ko" ? "QUALITY GATES — 비싼 생성 전 통과 조건" : "QUALITY GATES — Conditions to pass before expensive generation"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, marginBottom: 26 }}>
        {QUALITY_GATES.map((g) => (
          <Card key={g.key} style={{ padding: "11px 13px" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", marginBottom: 3 }}>{agentText(g.name, g.nameEn, locale)}</div>
            <div style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.4 }}>{agentText(g.passCondition, g.passConditionEn, locale)}</div>
          </Card>
        ))}
      </div>

      {/* 에이전트 명부 */}
      <div style={sectionLabel}>{locale === "ko" ? "제작 에이전트" : "Production Agents"} — {FILM_AGENTS.length}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
        {FILM_AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelectedAgent(a.id === selectedAgent ? null : a.id)}
            style={{
              textAlign: "left",
              border: `1px solid ${selectedAgent === a.id ? a.accent : "var(--paper-edge)"}`,
              background: "var(--paper)",
              borderRadius: 11,
              padding: "11px 13px",
              cursor: "pointer",
              display: "flex",
              gap: 10,
              boxShadow: "var(--shadow-1)",
            }}
          >
            <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 800, color: "#fff", background: a.accent, padding: "3px 7px", borderRadius: 7, height: "fit-content" }}>
              {a.code}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{agentText(a.name, a.nameEn, locale)}</div>
              <div style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.4, marginTop: 2 }}>{agentText(a.role, a.roleEn, locale)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentDetail({ agent, onClose, locale }: { agent: FilmAgentDefI18n; onClose: () => void; locale: Locale }) {
  const primaryName = agentText(agent.name, agent.nameEn, locale);
  const secondaryName = locale === "ko" ? agent.nameEn : agent.name;
  return (
    <Card style={{ padding: 16, marginBottom: 24, borderLeft: `3px solid ${agent.accent}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 800, color: "#fff", background: agent.accent, padding: "4px 9px", borderRadius: 8 }}>{agent.code}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{primaryName}</div>
          <div style={{ fontSize: 11, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>{secondaryName}</div>
        </div>
        <button onClick={onClose} style={{ border: "none", background: "var(--fill-1)", borderRadius: 8, padding: "4px 10px", cursor: "pointer", color: "var(--muted-deep)", fontSize: 12 }}>
          {locale === "ko" ? "닫기" : "Close"}
        </button>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>{agentText(agent.role, agent.roleEn, locale)}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
        <IOCol title={locale === "ko" ? "입력" : "Input"} items={agentList(agent.inputs, agent.inputsEn, locale)} />
        <IOCol title={locale === "ko" ? "출력" : "Output"} items={agentList(agent.outputs, agent.outputsEn, locale)} />
        <div>
          <div style={ioLabel}>{locale === "ko" ? "실패 게이트" : "Fail Gate"}</div>
          <Tag color="var(--red-deep)">{agentText(agent.failGate, agent.failGateEn, locale)}</Tag>
        </div>
      </div>
      <div style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", letterSpacing: 0.5, color: "var(--muted-deep)", marginBottom: 4 }}>SYSTEM PROMPT</div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5, background: "var(--fill-1)", borderRadius: 8, padding: "9px 11px", border: "1px solid var(--paper-edge)", fontFamily: "var(--font-mono)" }}>
        {agent.systemPrompt}
      </div>
    </Card>
  );
}

function IOCol({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div style={ioLabel}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {items.map((it, i) => (
          <span key={i} style={{ fontSize: 11, color: "var(--ink-soft)" }}>· {it}</span>
        ))}
      </div>
    </div>
  );
}

const sectionLabel: React.CSSProperties = { fontSize: 10.5, fontFamily: "var(--font-mono)", letterSpacing: 0.5, color: "var(--muted-deep)", fontWeight: 700, marginBottom: 10 };
const ioLabel: React.CSSProperties = { fontSize: 9, fontFamily: "var(--font-mono)", letterSpacing: 0.5, color: "var(--muted-deep)", marginBottom: 5, fontWeight: 700 };
