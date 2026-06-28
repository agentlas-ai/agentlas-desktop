// 우측 Workflow 패널 — 세로 활동 타임라인 + 에이전트/팀 명단.
//   - 명단: firm.orgChart에서 CEO → 본부 → 전문가 3계층을 그리고, 실행 중인 노드는
//     실시간 속성 이벤트(liveAgents)로 활성(녹색)·대기(빈 점) 표시.
//   - 타임라인: 단일 에이전트/팀 오케스트레이터의 상태, 도구, 위임(handoff)을 위→아래 피드로.
"use client";
import { useMemo, useState, type CSSProperties } from "react";
import type { InstalledAgent, InstalledFirm, ResolvedOrg } from "@/lib/types";
import { pickLocalized, useT } from "@/lib/i18n";
import { formatTokens } from "@/lib/receipts";
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
  // ── 영수증(receipt)용 실측 필드 — 이벤트가 줄 때만 채워진다. 없으면 생략(지어내지 않음). ──
  /** 사용한 도구 이름 — tool 이벤트의 tool.name */
  toolName?: string;
  /** 생성 토큰 수 — 이벤트의 tokens (formatTokens로 포맷, 없으면 미표시) */
  tokens?: number;
  /** 위임/핸드오프 대상 노드 id 들 — handoff 카드의 "to" */
  delegateTo?: string[];
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
  chatTitle?: string;
  latestUserPrompt?: string;
  onClose: () => void;
}

type RosterNode = { key: string; name: string; role: string; tier: 1 | 2 | 3 };
type RosterDivision = RosterNode & { specialists: RosterNode[] };

export function AgentNetworkPanel({
  firm,
  org,
  agent,
  agents,
  busy,
  liveAgents,
  timeline,
  chatTitle,
  latestUserPrompt,
  onClose,
}: Props) {
  const { t, locale } = useT();
  const [briefOpen, setBriefOpen] = useState(false);

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

  const anyActive = Object.values(liveAgents).some((a) => a.active);
  const activeTitle =
    chatTitle?.trim() ||
    (firm ? pickLocalized(firm, locale).name : agent ? pickLocalized(agent, locale).name : t("network.title"));
  const promptPreview = cleanPromptPreview(latestUserPrompt ?? "");
  const participants = roster
    ? [
        roster.ceo,
        ...roster.divisions,
        ...roster.divisions.flatMap((d) => d.specialists),
      ].filter((node): node is RosterNode => Boolean(node))
    : agent
      ? [{ key: agent.id, name: pickLocalized(agent, locale).name, role: "", tier: 1 as const }]
      : [];
  const feed = timeline.slice(-10);
  const activityRows = workflowActivityRows(timeline, locale);
  const webSeen = timeline.some((item) => /web|검색|search|탐색/i.test(item.text));
  const activeParticipant =
    participants.find((node) => liveAgents[node.key]?.active) ??
    participants[0] ??
    null;

  return (
    <aside
      style={{
        width: 318,
        minWidth: 268,
        maxWidth: "45vw",
        flexShrink: 1, // 좁은 창에서 줄어들어 화면 안에 맞춤(고정폭이면 우측으로 오버플로우)
        height: "100%",
        background: "var(--paper)",
        borderLeft: "1px solid var(--paper-edge)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 헤더 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 10px 9px 12px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
        }}
      >
        <IconNetwork size={15} style={{ color: "var(--ink-soft)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 750, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {activeTitle}
          </div>
          <div style={panelSubtitleStyle}>
            {firm ? t("network.subtitle.firm") : agent ? t("network.subtitle.agent") : t("network.idle")}
          </div>
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

      <div style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "12px 10px" }}>
        <section
          style={briefCardStyle}
        >
          <div style={briefTitleStyle}>
            {locale === "ko" ? "사용자 요청" : "User request"}
          </div>
          <div style={briefBodyStyle(briefOpen)}>
            {promptPreview || (locale === "ko" ? "메시지를 보내면 현재 위임 내용이 여기에 표시됩니다." : "Send a message to show the current delegation brief here.")}
          </div>
          {promptPreview && (
            <div style={briefSectionStyle}>
              <div style={briefSectionLabelStyle}>
                {locale === "ko" ? "## 사용자 의도" : "## User intent"}
              </div>
              <div style={briefSectionTextStyle}>
                {deriveBriefIntent(promptPreview, locale)}
              </div>
            </div>
          )}
          {promptPreview.length > 130 && (
            <button onClick={() => setBriefOpen((v) => !v)} style={moreButtonStyle}>
              {briefOpen ? (locale === "ko" ? "접기" : "Show less") : (locale === "ko" ? "더보기" : "Show more")}
            </button>
          )}
        </section>

        <div style={activityRowsWrapStyle}>
          {activityRows.map((row) => (
            <button key={row.label} style={activitySummaryRowStyle}>
              <span>{row.label}</span>
              <span style={{ color: "var(--muted)" }}>›</span>
            </button>
          ))}
          <div style={searchingRowStyle}>
            <span aria-hidden style={searchingDotStyle(busy || anyActive)} />
            <span>{webSeen || busy || anyActive ? (locale === "ko" ? "탐색함 웹" : "Browsing web") : (locale === "ko" ? "대기 중" : "Idle")}</span>
            <span style={{ color: "var(--muted)" }}>›</span>
          </div>
        </div>

        {activeParticipant && (
          <div style={participantLineStyle}>
            <span aria-hidden style={participantDotStyle(!!liveAgents[activeParticipant.key]?.active || busy)} />
            <span>{activeParticipant.name}</span>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {feed.length === 0 ? (
            <div style={idleCardStyle}>
              <span aria-hidden style={idleDotStyle} />
              <span>{t("network.idle")}</span>
            </div>
          ) : (
            feed.map((item, i) => (
              <WorkflowCard
                key={item.key}
                item={item}
                live={busy && i === feed.length - 1}
                locale={locale}
              />
            ))
          )}
        </div>
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
          boxShadow: "0 0 0 3px color-mix(in srgb, var(--green-deep) 14%, transparent)",
        }}
      />
      {label}
    </span>
  );
}

function WorkflowCard({
  item,
  live,
  locale,
}: {
  item: NetTimelineItem;
  live: boolean;
  locale: "ko" | "en";
}) {
  const isHandoff = item.kind === "handoff";
  const isComplete = /완료|done|completed/i.test(item.text);
  const title = isHandoff
    ? locale === "ko" ? `${item.name} 위임` : `${item.name} delegation`
    : item.name;
  const state = live
    ? locale === "ko" ? "에이전트 시작됨" : "Agent started"
    : isComplete
      ? locale === "ko" ? "에이전트 작업 완료" : "Agent work completed"
    : isHandoff
      ? locale === "ko" ? "위임" : "Delegation"
      : item.kind === "tool"
        ? locale === "ko" ? "에이전트" : "Agent"
        : locale === "ko" ? "상태" : "Status";
  // ── 영수증 메타 — 실측값만. 없으면 해당 줄을 그리지 않는다(지어내지 않음). ──
  const tokensText = formatTokens(item.tokens, locale);
  const handoffTargets = isHandoff && item.delegateTo && item.delegateTo.length > 0 ? item.delegateTo : null;
  return (
    <article
      className={`agentlas-activity-card${live ? " is-running" : ""}${isComplete ? " is-complete" : ""}`}
      style={workflowCardStyle}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
        <span aria-hidden style={workflowDotStyle(item.kind, live, isComplete)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={workflowTitleStyle}>{title}</div>
          <div style={workflowMetaStyle}>{item.role || state}</div>
        </div>
        <span style={workflowKindStyle(item.kind, isComplete)}>{state}</span>
      </div>
      <div style={workflowTextStyle}>
        {isHandoff ? `↳ ${item.text}` : item.text}
      </div>
      {/* 구조화된 영수증 라인 — from→to(핸드오프), 사용 도구, 토큰. 실측 있을 때만. */}
      {(handoffTargets || item.toolName || tokensText) && (
        <div style={receiptMetaRowStyle}>
          {handoffTargets && (
            <span style={receiptChipStyle}>
              {locale === "ko" ? "위임 →" : "to →"} {handoffTargets.join(", ")}
            </span>
          )}
          {item.toolName && (
            <span style={receiptChipStyle}>
              {locale === "ko" ? "도구" : "tool"} · {item.toolName}
            </span>
          )}
          {tokensText && <span style={receiptChipStyle}>{tokensText}</span>}
        </div>
      )}
    </article>
  );
}

function workflowActivityRows(timeline: NetTimelineItem[], locale: "ko" | "en") {
  const handoff = timeline.filter((item) => item.kind === "handoff").length;
  const tool = timeline.filter((item) => item.kind === "tool").length;
  const status = timeline.filter((item) => item.kind === "status").length;
  const command = Math.max(0, tool - handoff);
  const read = timeline.filter((item) => /read|읽기|파일/i.test(item.text)).length;
  const primary =
    locale === "ko"
      ? `읽기 파일 ${read}개, 실행됨 명령 ${command}개, 사용함 도구 ${tool}개`
      : `Read ${read} file${read === 1 ? "" : "s"}, ran ${command} command${command === 1 ? "" : "s"}, used ${tool} tool${tool === 1 ? "" : "s"}`;
  const secondary =
    locale === "ko"
      ? `위임 ${handoff}개, 상태 ${status}개`
      : `${handoff} delegation${handoff === 1 ? "" : "s"}, ${status} update${status === 1 ? "" : "s"}`;
  return [
    { label: primary },
    { label: secondary },
  ];
}

function cleanPromptPreview(value: string): string {
  return value
    .replace(/^\/goal\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveBriefIntent(value: string, locale: "ko" | "en"): string {
  if (!value) return "";
  const trimmed = value.replace(/[.。]\s*/g, ". ").trim();
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] || trimmed;
  const compact = firstSentence.length > 112 ? `${firstSentence.slice(0, 111)}…` : firstSentence;
  return compact || (locale === "ko" ? "현재 요청을 실행 가능한 위임으로 정리합니다." : "Turn the current request into an executable delegation.");
}

const panelSubtitleStyle: CSSProperties = {
  marginTop: 1,
  fontSize: 10.5,
  color: "var(--muted-deep)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const briefCardStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  borderRadius: 8,
  border: "1px solid color-mix(in srgb, var(--paper-edge) 78%, transparent)",
  background: "color-mix(in srgb, var(--paper-2) 92%, var(--paper) 8%)",
  padding: 12,
};

const briefTitleStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 760,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function briefBodyStyle(open: boolean): CSSProperties {
  return {
    marginTop: 7,
    color: "var(--ink-soft)",
    fontSize: 11.5,
    lineHeight: 1.52,
    overflowWrap: "anywhere",
    display: open ? "block" : "-webkit-box",
    WebkitLineClamp: open ? undefined : 4,
    WebkitBoxOrient: open ? undefined : "vertical",
    overflow: "hidden",
  };
}

const briefSectionStyle: CSSProperties = {
  marginTop: 11,
  paddingTop: 10,
  borderTop: "1px solid color-mix(in srgb, var(--paper-edge) 72%, transparent)",
};

const briefSectionLabelStyle: CSSProperties = {
  color: "var(--muted)",
  fontSize: 10.5,
  fontWeight: 750,
};

const briefSectionTextStyle: CSSProperties = {
  marginTop: 4,
  color: "var(--ink-soft)",
  fontSize: 11.3,
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};

const moreButtonStyle: CSSProperties = {
  marginTop: 8,
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 700,
  border: "none",
  background: "transparent",
  padding: 0,
};

const activityRowsWrapStyle: CSSProperties = {
  marginTop: 14,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const activitySummaryRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  minWidth: 0,
  border: "none",
  background: "transparent",
  padding: "0 1px",
  color: "var(--muted-deep)",
  fontSize: 11.2,
  fontWeight: 700,
  textAlign: "left",
};

const searchingRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
  color: "var(--muted-deep)",
  fontSize: 11.2,
  fontWeight: 700,
  padding: "0 1px",
};

function participantDotStyle(active: boolean): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    background: active ? "var(--green-deep)" : "transparent",
    border: active ? "none" : "1px solid var(--muted)",
  };
}

const participantLineStyle: CSSProperties = {
  marginTop: 10,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: "100%",
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 720,
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  padding: "4px 8px",
};

const idleCardStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  padding: "10px 12px",
  color: "var(--muted-deep)",
  fontSize: 11.5,
  lineHeight: 1.5,
};

const idleDotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  border: "1.5px solid var(--muted)",
  flexShrink: 0,
};

const workflowCardStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  padding: "10px 11px",
  boxShadow: "0 1px 2px rgba(11, 11, 15, 0.035)",
};

// 영수증 메타 칩 줄 — from→to / 도구 / 토큰. 실측 있을 때만 렌더.
const receiptMetaRowStyle: CSSProperties = {
  marginTop: 8,
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
};

const receiptChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  padding: "2px 7px",
  fontSize: 9.5,
  fontWeight: 750,
};

// 마진 라인 — 모든 영수증에 1급 데이터로. 항상 ₩0.
const receiptMarginStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 7,
  borderTop: "1px solid color-mix(in srgb, var(--paper-edge) 72%, transparent)",
  color: "var(--green-deep)",
  fontSize: 10.5,
  fontWeight: 800,
  letterSpacing: 0.1,
};

// 세션 누적 마진 카운터 — 패널 하단 고정 바.
const sessionMarginCounterStyle: CSSProperties = {
  flexShrink: 0,
  borderTop: "var(--hairline)",
  background: "var(--paper)",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const sessionMarginLabelStyle: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const sessionMarginValueStyle: CSSProperties = {
  color: "var(--green-deep)",
  fontSize: 12.5,
  fontWeight: 850,
};

const sessionMarginSubStyle: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 10,
  lineHeight: 1.4,
  overflowWrap: "anywhere",
};

function searchingDotStyle(active: boolean): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
    background: active ? "var(--peach)" : "var(--muted)",
    boxShadow: active ? "0 0 0 4px color-mix(in srgb, var(--peach) 14%, transparent)" : undefined,
  };
}

const workflowTitleStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 780,
};

const workflowMetaStyle: CSSProperties = {
  marginTop: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 650,
};

const workflowTextStyle: CSSProperties = {
  marginTop: 7,
  color: "var(--ink-soft)",
  fontSize: 11.3,
  lineHeight: 1.48,
  overflowWrap: "anywhere",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

function workflowDotStyle(kind: NetTimelineItem["kind"], live: boolean, complete = false): CSSProperties {
  const color = complete ? "var(--green-deep)" : kind === "handoff" ? "var(--accent)" : kind === "tool" ? "var(--blue-deep)" : "var(--muted-deep)";
  return {
    width: kind === "handoff" ? 10 : 9,
    height: 9,
    borderRadius: kind === "handoff" ? 3 : "50%",
    flexShrink: 0,
    background: live ? "var(--green-deep)" : color,
    boxShadow: live ? "0 0 0 4px color-mix(in srgb, var(--green-deep) 13%, transparent)" : undefined,
  };
}

function workflowKindStyle(kind: NetTimelineItem["kind"], complete = false): CSSProperties {
  const color = complete ? "var(--green-deep)" : kind === "handoff" ? "var(--accent)" : kind === "tool" ? "var(--blue-deep)" : "var(--muted-deep)";
  return {
    flexShrink: 0,
    borderRadius: 999,
    border: "1px solid color-mix(in srgb, currentColor 22%, var(--paper-edge))",
    background: "color-mix(in srgb, currentColor 7%, var(--paper))",
    color,
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 760,
  };
}
