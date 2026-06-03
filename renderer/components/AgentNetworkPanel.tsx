// 우측 Workflow 패널 — 세로 활동 타임라인 + 에이전트/팀 명단.
//   - 명단: firm.orgChart에서 CEO → 본부 → 전문가 3계층을 그리고, 실행 중인 노드는
//     실시간 속성 이벤트(liveAgents)로 활성(녹색)·대기(빈 점) 표시.
//   - 타임라인: 단일 에이전트/팀 오케스트레이터의 상태, 도구, 위임(handoff)을 위→아래 피드로.
"use client";
import { useMemo } from "react";
import type { InstalledAgent, InstalledFirm, ResolvedOrg } from "@/lib/types";
import { pickLocalized, useT } from "@/lib/i18n";
import { IconClose, IconNetwork } from "./Icon";

/** 실시간 에이전트 상태 — chat 페이지가 속성 이벤트로 채운다. */
export interface LiveAgent {
  name: string;
  role: string;
  tier?: 1 | 2 | 3;
  active: boolean;
  status?: string;
  delegateTo?: string[];
}

/** 타임라인 항목 — discrete 활동/위임. */
export interface NetTimelineItem {
  key: string;
  agentId: string;
  name: string;
  role: string;
  tier?: 1 | 2 | 3;
  kind: "status" | "tool" | "handoff";
  text: string;
}

interface Props {
  firm: InstalledFirm | null;
  /** 정규화된 3-tier 조직 (있으면 명단을 이걸로 — 노드 id가 이벤트 agentId와 일치) */
  org: ResolvedOrg | null;
  agent: InstalledAgent | null;
  agents: InstalledAgent[];
  busy: boolean;
  liveAgents: Record<string, LiveAgent>;
  timeline: NetTimelineItem[];
  onClose: () => void;
}

type RosterNode = { key: string; name: string; role: string; tier: 1 | 2 | 3 };
type RosterDivision = RosterNode & { specialists: RosterNode[] };

export function AgentNetworkPanel({ firm, org, agent, agents, busy, liveAgents, timeline, onClose }: Props) {
  const { t, locale } = useT();

  const roster = useMemo(() => {
    // ResolvedOrg가 있으면 그걸로 명단 (노드 id = 이벤트 agentId와 정확히 일치)
    if (org) {
      const divisions: RosterDivision[] = org.divisions.map((d) => ({
        key: d.id,
        name: d.name,
        role: d.role,
        tier: 2,
        specialists: d.specialists.map((s) => ({ key: s.id, name: s.name, role: s.role, tier: 3 as const })),
      }));
      return {
        ceo: { key: org.ceo.id, name: org.ceo.name, role: org.ceo.role, tier: 1 as const },
        divisions,
      };
    }
    // 폴백: firm.orgChart에서 파생
    if (!firm) return null;
    const nodes = firm.orgChart;
    const keyOf = (n: (typeof nodes)[number]) => n.agentId || n.agentSlug;
    const nameOf = (n: (typeof nodes)[number]) => {
      const a = n.agentId ? agents.find((x) => x.id === n.agentId) : null;
      return a ? pickLocalized(a, locale).name : n.role;
    };
    const ceoNode = nodes.find((n) => n.reportsTo === null) ?? null;
    const divisions: RosterDivision[] = nodes
      .filter((n) => ceoNode != null && n.reportsTo === ceoNode.agentSlug)
      .map((d) => ({
        key: keyOf(d),
        name: nameOf(d),
        role: d.role,
        tier: 2,
        specialists: nodes
          .filter((s) => s.reportsTo === d.agentSlug)
          .map((s) => ({ key: keyOf(s), name: nameOf(s), role: s.role, tier: 3 as const })),
      }));
    const ceo: RosterNode | null = ceoNode
      ? { key: keyOf(ceoNode), name: nameOf(ceoNode), role: ceoNode.role, tier: 1 }
      : null;
    return { ceo, divisions };
  }, [org, firm, agents, locale]);

  const subtitle = firm
    ? t("network.subtitle.firm")
    : agent
      ? t("network.subtitle.agent")
      : "";

  const anyActive = Object.values(liveAgents).some((a) => a.active);
  const singleAgentLive = agent
    ? liveAgents[agent.id] ?? liveAgents["active-agent"]
    : liveAgents["active-agent"];

  return (
    <aside
      style={{
        width: 340,
        minWidth: 260,
        maxWidth: "45vw",
        flexShrink: 1, // 좁은 창에서 줄어들어 화면 안에 맞춤(고정폭이면 우측으로 오버플로우)
        height: "100%",
        background: "var(--paper)",
        borderLeft: "1px solid var(--paper-edge)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @keyframes net-blink { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
        @keyframes net-bar { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }
      `}</style>

      {/* 헤더 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "var(--hairline)",
          background: "var(--paper-2)",
        }}
      >
        <IconNetwork size={15} style={{ color: "var(--ink-soft)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{t("network.title")}</div>
          {subtitle && (
            <div
              style={{
                fontSize: 10,
                color: "var(--muted-deep)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {(busy || anyActive) && <LiveBadge label={t("network.live")} />}
        <button
          onClick={onClose}
          aria-label={t("workspace.close_panel")}
          title={t("workspace.close_panel")}
          style={{
            width: 24,
            height: 24,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--muted-deep)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {/* ── 명단 (3-tier, 활성/대기) ───────────────────────── */}
        {roster?.ceo ? (
          <div style={{ padding: "10px 12px", borderBottom: "var(--hairline)" }}>
            <RosterRow node={roster.ceo} live={liveAgents[roster.ceo.key]} />
            {roster.divisions.map((d) => (
              <div key={d.key}>
                <RosterRow node={d} live={liveAgents[d.key]} />
                {d.specialists.map((s) => (
                  <RosterRow key={s.key} node={s} live={liveAgents[s.key]} indent />
                ))}
              </div>
            ))}
          </div>
        ) : agent ? (
          <div style={{ padding: "10px 12px", borderBottom: "var(--hairline)" }}>
            <RosterRow
              node={{ key: agent.id, name: pickLocalized(agent, locale).name, role: "", tier: 1 }}
              live={singleAgentLive ?? (busy ? { name: "", role: "", active: true } : undefined)}
            />
          </div>
        ) : null}

        {/* ── 활동 타임라인 ───────────────────────────────── */}
        <div style={{ padding: "10px 12px" }}>
          {timeline.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.6, padding: "8px 0" }}>
              {t("network.idle")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {timeline.map((item, i) => (
                <TimelineEntry
                  key={item.key}
                  item={item}
                  last={i === timeline.length - 1}
                  live={busy && i === timeline.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 범례 */}
      <div
        style={{
          flexShrink: 0,
          borderTop: "var(--hairline)",
          padding: "8px 12px",
          background: "var(--paper-2)",
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          minWidth: 0,
        }}
      >
        <LegendItem swatch="cmd" label={`${t("network.legend.command")} ↓`} />
        <LegendItem swatch="res" label={`${t("network.legend.response")} ↑`} />
      </div>
    </aside>
  );
}

function LiveBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 10,
        fontWeight: 700,
        color: "var(--ink-soft)",
        background: "var(--paper)",
        border: "1px solid var(--paper-edge)",
        borderRadius: 999,
        padding: "2px 8px",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--green-deep)",
          animation: "net-blink 1s ease-in-out infinite",
        }}
      />
      {label}
    </span>
  );
}

function RosterRow({
  node,
  live,
  indent,
}: {
  node: RosterNode;
  live?: LiveAgent;
  indent?: boolean;
}) {
  const active = !!live?.active;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        paddingLeft: indent ? 18 : 0,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          flexShrink: 0,
          background: active ? "var(--green-deep)" : "transparent",
          border: active ? "none" : "1.5px solid var(--paper-edge)",
          animation: active ? "net-blink 1.1s ease-in-out infinite" : undefined,
        }}
      />
      <span
        style={{
          minWidth: 0,
          flex: "1 1 0",
          fontSize: indent ? 11.5 : 12,
          fontWeight: active ? 700 : node.tier === 1 ? 600 : 500,
          color: active ? "var(--ink)" : "var(--muted-deep)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.name}
      </span>
      {node.role && node.name !== node.role && (
        <span
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            maxWidth: "48%",
            fontSize: 9.5,
            fontWeight: 600,
            color: "var(--muted-deep)",
            background: "var(--paper-2)",
            border: "1px solid var(--paper-edge)",
            borderRadius: 999,
            padding: "1px 7px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.role}
        </span>
      )}
      {active && live?.status && (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10,
            color: "var(--muted-deep)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "right",
          }}
        >
          {live.status}
        </span>
      )}
    </div>
  );
}

function TimelineEntry({
  item,
  last,
  live,
}: {
  item: NetTimelineItem;
  last: boolean;
  live: boolean;
}) {
  const isHandoff = item.kind === "handoff";
  return (
    <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: isHandoff ? 2 : "50%",
            background: live ? "var(--green-deep)" : "var(--ink-soft)",
            animation: live ? "net-blink 1s ease-in-out infinite" : undefined,
          }}
        />
        {!last && <span style={{ flex: 1, width: 2, background: "var(--paper-edge)", minHeight: 16 }} />}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          marginBottom: 8,
          padding: "7px 10px",
          borderRadius: "var(--radius-sm)",
          background: "var(--paper)",
          border: "1px solid var(--paper-edge)",
          boxShadow: live ? "var(--neu-raised)" : "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              fontWeight: 700,
              color: "var(--ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.name}
          </span>
          {item.role && (
            <span
              style={{
                flex: "0 1 42%",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 9,
                color: "var(--muted)",
                fontWeight: 600,
                textAlign: "right",
              }}
            >
              {item.role}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: isHandoff ? "var(--ink-soft)" : "var(--muted-deep)",
            fontWeight: isHandoff ? 600 : 400,
            marginTop: 2,
            lineHeight: 1.45,
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {isHandoff ? `↳ ${item.text}` : item.text}
        </div>
        {live && (
          <div
            style={{
              marginTop: 6,
              height: 3,
              borderRadius: 999,
              background: "var(--paper-2)",
              overflow: "hidden",
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: "100%",
                width: "30%",
                borderRadius: 999,
                background: "var(--ink-soft)",
                animation: "net-bar 1.1s ease-in-out infinite",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LegendItem({ swatch, label }: { swatch: "cmd" | "res"; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span
        style={{
          width: 16,
          height: 0,
          borderTop: swatch === "cmd" ? "2px dashed var(--ink-soft)" : "2px dotted var(--muted)",
          flexShrink: 0,
        }}
      />
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 10,
          color: "var(--muted-deep)",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
    </span>
  );
}
