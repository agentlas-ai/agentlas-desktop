// 우측 오케스트레이션 패널 — Kimchi식 멀티에이전트 트리 + 활동 피드.
//   - 트리: orchestrator(CEO) → 본부(병렬 그룹) → 전문가(워커)를 실시간 상태(▶ 실행 / ✓ 완료 / ○ 대기)로.
//     백엔드(electron/mcp/firm-orchestrator.ts)가 이미 본부/전문가를 병렬 실행하고 per-agent 이벤트(+done 완료신호)를
//     스트리밍하므로, 추가 백엔드 없이 그대로 시각화한다.
//   - 팀(firm/org)이 없는 단일 에이전트 채팅에서는 병렬 표기를 쓰지 않고 단독 작업 뷰로 표시(정직성).
//   - 타임라인: 노드들의 상태/도구/위임(handoff)을 위→아래 피드로.
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
  /** 이 에이전트가 실행 중인 모델/런타임 라벨 (예: "grok-4.3", "claude") */
  model?: string;
  /** Resident CLI process state. This is deliberately separate from `active` turn state. */
  processState?: "running" | "idle" | "closed" | "failed";
  processRuntime?: string;
}

/** 타임라인 항목 — discrete 활동/위임. */
export interface NetTimelineItem {
  key: string;
  agentId: string;
  name: string;
  role: string;
  tier?: 1 | 2 | 3;
  kind: "status" | "tool" | "handoff" | "message";
  text: string;
  // ── 영수증(receipt)용 실측 필드 — 이벤트가 줄 때만 채워진다. 없으면 생략(지어내지 않음). ──
  /** 사용한 도구 이름 — tool 이벤트의 tool.name */
  toolName?: string;
  /** 생성 토큰 수 — 이벤트의 tokens (formatTokens로 포맷, 없으면 미표시) */
  tokens?: number;
  /** 위임/핸드오프 대상 노드 id 들 — handoff 카드의 "to" */
  delegateTo?: string[];
  messageDirection?: "orchestrator-to-worker" | "worker-to-orchestrator";
  messageFrom?: string;
  messageTo?: string;
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
  /** 현재 실행이 다단계 파이프라인(2+ stage)이면 단일 에이전트라도 카드/네트워크 뷰를 켠다. */
  hasPipeline?: boolean;
  onClose?: () => void;
  embedded?: boolean;
}

type RosterNode = { key: string; name: string; role: string; tier: 1 | 2 | 3 };
type RosterDivision = RosterNode & { specialists: RosterNode[] };
type Roster = { ceo: RosterNode | null; divisions: RosterDivision[] };
type SoloWaterfallItem = {
  key: string;
  kind: NetTimelineItem["kind"];
  label: string;
  text: string;
  toolName?: string;
};

function timelineHasFailureSignal(timeline: NetTimelineItem[]): boolean {
  return timeline.some((item) =>
    /실패|failed|cancel|취소|blocked|차단|interrupted|중단/i.test(item.text),
  );
}

function cleanAgentStatus(text: string | undefined): string {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!value) return "";
  if (/(?:^|\s)codex:\s|\[runtime-session\]|sessionend hook|skill descriptions were shortened|agentlas plugins|\/Users\/[^\s]+\/(?:\.codex|\.claude|Library\/Application Support)|(?:^|\s)(?:mcp__|automation_graph_|hep-network|stormbreaker[_-])|\b(?:bash|collab_tool_call|mcp_tool_call|write|read|edit|glob|grep|websearch|webfetch)\b|\b(?:codex|claude code|antigravity|kimi|grok)\s+cli\b/i.test(value)) {
    return "";
  }
  return value;
}

const INTERNAL_SYSTEM_ROLE_KEYS = new Set([
  "memory-curator",
  "pm",
  "policy-gate",
  "runtime-adapter",
]);

function normalizedRoleKey(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function isInternalSystemRole(key: string, name?: string, role?: string): boolean {
  return [key, name, role].some((value) => INTERNAL_SYSTEM_ROLE_KEYS.has(normalizedRoleKey(value)));
}

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
  hasPipeline = false,
  onClose,
  embedded = false,
}: Props) {
  const { t, locale } = useT();
  const [briefOpen, setBriefOpen] = useState(false);
  const visibleLiveAgents = useMemo<Record<string, LiveAgent>>(() => Object.fromEntries(
    Object.entries(liveAgents).flatMap(([key, item]) => {
      const installed = agents.find((candidate) =>
        candidate.id === key
        || candidate.slug === key
        || candidate.id === item.name
        || candidate.slug === item.name);
      const current = agent && (
        agent.id === key
        || agent.slug === key
        || agent.id === item.name
        || agent.slug === item.name
      ) ? agent : null;
      const resolved = installed ?? current;
      if (isInternalSystemRole(key, resolved?.slug ?? item.name, item.role)) return [];
      // 신원이 안 풀렸는데 이름 자리에 기계값이 들어 있으면 그대로 보여주지 않는다.
      // 구두점 검사만으로는 구두점 없는 32자리 hex 를 놓친다 — 사용자에게 원시 id 가
      // 이름처럼 보이는 자리는 남기지 않는다.
      const unresolvedMachineLabel = !resolved
        && item.name === key
        && (/[-_:/.]/u.test(item.name) || /^[0-9a-f]{16,}$/i.test(item.name));
      const status = cleanAgentStatus(item.status);
      return [[key, resolved
        ? { ...item, name: pickLocalized(resolved, locale).name, status }
        : unresolvedMachineLabel
          ? { ...item, name: locale === "ko" ? "에이전트" : "Agent", status }
          : { ...item, status }] as const];
    }),
  ), [agent, agents, liveAgents, locale]);
  const visibleTimeline = useMemo<NetTimelineItem[]>(() => timeline.flatMap((item) => {
    if (isInternalSystemRole(item.agentId, item.name, item.role)) return [];
    // Agent messages are user-facing bounded excerpts, not runtime status. Do
    // not run them through the status scrubber, which intentionally removes
    // words such as "read" and "write" from internal CLI chatter.
    const text = item.kind === "message"
      ? item.text.replace(/\s+/g, " ").trim()
      : cleanAgentStatus(item.text);
    return text ? [{ ...item, text }] : [];
  }), [timeline]);

  const roster = useMemo<Roster | null>(() => {
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

  // Firm/org definitions contain every possible internal role. The Work UI is
  // an execution view, not an org-chart browser: only nodes proven by a live
  // event or receipt timeline belong here. This prevents unused system roles
  // from appearing as a wall of fake "idle" workers.
  const participationKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(visibleLiveAgents)) {
      if (value.active) keys.add(key);
    }
    for (const item of visibleTimeline) {
      if (item.agentId) keys.add(item.agentId);
      for (const delegated of item.delegateTo ?? []) keys.add(delegated);
    }
    return keys;
  }, [visibleLiveAgents, visibleTimeline]);
  const participatingLiveAgents = useMemo<Record<string, LiveAgent>>(() => Object.fromEntries(
    Object.entries(visibleLiveAgents).filter(([key]) => participationKeys.has(key)),
  ), [participationKeys, visibleLiveAgents]);
  const participatingRoster = useMemo<Roster | null>(() => {
    if (!roster) return null;
    const divisions = roster.divisions.flatMap((division) => {
      const specialists = division.specialists.filter((specialist) => participationKeys.has(specialist.key));
      return participationKeys.has(division.key) || specialists.length > 0
        ? [{ ...division, specialists }]
        : [];
    });
    const ceo = roster.ceo && (participationKeys.has(roster.ceo.key) || divisions.length > 0)
      ? roster.ceo
      : null;
    return ceo || divisions.length > 0 ? { ceo, divisions } : null;
  }, [participationKeys, roster]);

  const anyActive = Object.values(participatingLiveAgents).some((a) => a.active);
  const latestActivity = visibleTimeline[visibleTimeline.length - 1] ?? null;
  const currentLiveEntry = (latestActivity && participatingLiveAgents[latestActivity.agentId]
    ? [latestActivity.agentId, participatingLiveAgents[latestActivity.agentId]] as const
    : Object.entries(participatingLiveAgents).find(([, entry]) => entry.active)
      ?? Object.entries(participatingLiveAgents)[0]) ?? null;
  const currentLiveAgent = currentLiveEntry?.[1] ?? null;
  const currentActivity = latestActivity?.agentId === currentLiveEntry?.[0]
    ? latestActivity.text
    : currentLiveAgent?.status;
  const controllerKey = participatingRoster?.ceo?.key ?? null;
  const activeWorkerCount = Object.entries(participatingLiveAgents)
    .filter(([key, value]) => value.active && key !== controllerKey)
    .length;
  const hasHistoricalActivity = !busy && !anyActive && visibleTimeline.length > 0;
  const hasFailureSignal = timelineHasFailureSignal(visibleTimeline);
  // 진짜 멀티에이전트(팀/조직) 컨텍스트일 때만 "오케스트레이션/병렬" 프레이밍을 쓴다.
  const hasRoster = Boolean(participatingRoster && (participatingRoster.ceo || participatingRoster.divisions.length > 0));
  const activeTitle =
    currentLiveAgent?.name?.trim() ||
    (agent ? pickLocalized(agent, locale).name : firm ? pickLocalized(firm, locale).name : chatTitle?.trim() || t("network.title"));
  const promptPreview = cleanPromptPreview(latestUserPrompt ?? "");
  const feed = visibleTimeline.slice(-10);
  const activityRows = workflowActivityRows(visibleTimeline, locale);
  const webSeen = visibleTimeline.some((item) => /web|검색|search|탐색/i.test(item.text));
  const waitingForFirstEvent = feed.length === 0 && (busy || anyActive);
  const uniqueTimelineAgents = new Set(visibleTimeline.map((item) => item.agentId).filter(Boolean));
  const hasParallelSignal =
    activeWorkerCount >= 2 ||
    hasPipeline ||
    uniqueTimelineAgents.size > 1 ||
    visibleTimeline.some((item) => (item.delegateTo?.length ?? 0) > 1);

  return (
    <aside
      data-tour-id="workspace.workflow"
      style={embedded ? embeddedPanelStyle : panelStyle}
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
            {currentActivity
              || (firm
                ? t("network.subtitle.firm")
                : agent
                  ? t("network.subtitle.agent")
                  : hasHistoricalActivity
                    ? (locale === "ko" ? "완료된 실행" : "Completed run")
                    : t("network.idle"))}
          </div>
        </div>
        {/* 병렬 배지 — 실제로 2개 이상 동시 실행일 때만(거짓 ∥ 방지) */}
        {activeWorkerCount >= 2 && (
          <span
            style={headerCountBadgeStyle}
            title={locale === "ko" ? "병렬 실행 중인 서브에이전트 수" : "sub-agents running in parallel"}
          >
            {activeWorkerCount} ∥
          </span>
        )}
        {(busy || anyActive) && <LiveBadge label={t("network.live")} />}
        {onClose && (
          <button
            onClick={onClose}
            aria-label={t("workspace.close_panel")}
            title={t("workspace.close_panel")}
            style={closeButtonStyle}
          >
            <IconClose size={14} />
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "12px 10px" }}>
        {hasParallelSignal ? (
          <>
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
                <div key={row.label} style={activitySummaryRowStyle}>
                  <span>{row.label}</span>
                </div>
              ))}
              <div style={searchingRowStyle}>
                <span aria-hidden style={searchingDotStyle(busy || anyActive)} />
                <span>
                  {webSeen
                    ? (locale === "ko" ? "웹 확인됨" : "Web checked")
                    : busy || anyActive
                      ? (locale === "ko" ? "실행 중" : "Running")
                      : hasFailureSignal
                        ? (locale === "ko" ? "검토 필요" : "Needs review")
                        : hasHistoricalActivity
                          ? (locale === "ko" ? "완료" : "Completed")
                          : (locale === "ko" ? "대기 중" : "Idle")}
                </span>
              </div>
            </div>

            <OrchestrationTree
              roster={participatingRoster}
              hasRoster={hasRoster}
              liveAgents={participatingLiveAgents}
              timeline={visibleTimeline}
              busy={busy}
              locale={locale}
            />
          </>
        ) : (
          <SoloAgentSummary
            busy={busy || anyActive || waitingForFirstEvent}
            timeline={visibleTimeline}
            latestUserPrompt={promptPreview}
            locale={locale}
            agentName={agent ? pickLocalized(agent, locale).name : undefined}
            liveAgents={participatingLiveAgents}
          />
        )}
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

type SoloRosterEntry = {
  key: string;
  name: string;
  role?: string;
  active: boolean;
  borrowed: boolean;
  primary: boolean;
  processState?: LiveAgent["processState"];
};

/**
 * Solo-view roster: the primary (main) agent plus any additional/borrowed
 * agents, derived from the live agent map. Borrowed Hub agents arrive under a
 * `borrow:<slug>` key; everything else is treated as native. Falls back to the
 * bound agent name when no live agent has streamed an event yet.
 */
function soloAgentRoster(liveAgents: Record<string, LiveAgent>, agentName?: string): SoloRosterEntry[] {
  const entries: SoloRosterEntry[] = [];
  const seen = new Set<string>();
  for (const [key, agent] of Object.entries(liveAgents)) {
    const name = agent.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const borrowed = key.startsWith("borrow:");
    entries.push({
      key,
      name,
      role: agent.role?.trim() || undefined,
      active: agent.active,
      borrowed,
      primary: !borrowed && (agent.tier ?? 1) === 1,
      processState: agent.processState,
    });
  }
  const boundName = agentName?.trim();
  if (boundName && !entries.some((entry) => entry.primary)) {
    const match = entries.find((entry) => entry.name === boundName);
    if (match) match.primary = true;
    else entries.unshift({ key: "__primary__", name: boundName, active: false, borrowed: false, primary: true });
  }
  entries.sort((a, b) => Number(b.primary) - Number(a.primary));
  return entries;
}

function SoloAgentSummary({
  busy,
  timeline,
  latestUserPrompt,
  locale,
  agentName,
  liveAgents,
}: {
  busy: boolean;
  timeline: NetTimelineItem[];
  latestUserPrompt: string;
  locale: "ko" | "en";
  agentName?: string;
  liveAgents: Record<string, LiveAgent>;
}) {
  const latest = latestSoloTimelineText(timeline, locale, busy);
  const waterfall = soloWaterfallItems(timeline, locale);
  const roster = soloAgentRoster(liveAgents, agentName);
  const primary = roster.find((entry) => entry.primary) ?? roster[0];
  const additional = roster.filter((entry) => entry !== primary);
  const processClosed = primary?.processState === "closed";
  const processFailed = primary?.processState === "failed";
  const processIdle = primary?.processState === "idle";
  const isRunning = Boolean(!processClosed && !processFailed && !processIdle && (primary?.active || busy));
  const hasHistory = timeline.length > 0;
  const hasFailureSignal = timelineHasFailureSignal(timeline);
  const stateWord = processClosed
    ? (locale === "ko" ? "CLI 닫힘" : "CLI closed")
    : processFailed
      ? (locale === "ko" ? "CLI 실패" : "CLI failed")
      : processIdle
        ? (locale === "ko" ? "CLI 대기 중" : "CLI idle")
      : isRunning
    ? (locale === "ko" ? "실행 중" : "Running")
    : hasFailureSignal
      ? (locale === "ko" ? "검토 필요" : "Needs review")
      : hasHistory
        ? (locale === "ko" ? "완료" : "Completed")
        : (locale === "ko" ? "대기" : "Idle");
  // Tool/work cards collapse so the panel foregrounds the agent + live status,
  // not a stack of bash cards. Default open while running (live feedback),
  // collapsed once idle so the history stays a compact list.
  const [stepsOpen, setStepsOpen] = useState(true);
  return (
    <section style={soloWrapStyle}>
      {primary && (
        <div style={soloRosterStyle}>
          <div style={soloPrimaryAgentStyle}>
            <span aria-hidden style={soloDotStyle(primary.active || busy)} />
            <span style={soloPrimaryNameStyle}>{primary.name}</span>
            {primary.role && <span style={soloPrimaryRoleStyle}>{primary.role}</span>}
            <span style={{ marginLeft: "auto", ...soloAgentStateWordStyle(isRunning) }}>
              {stateWord}
            </span>
          </div>
          {additional.length > 0 && (
            <div style={soloAdditionalWrapStyle}>
              <span style={soloAdditionalLabelStyle}>{locale === "ko" ? "함께" : "With"}</span>
              {additional.map((entry) => (
                <span key={entry.key} style={soloAgentChipStyle(entry.active)} title={entry.role}>
                  {entry.borrowed && <span aria-hidden style={soloBorrowMarkStyle}>↗</span>}
                  {entry.processState === "closed" && <span aria-hidden style={soloBorrowMarkStyle}>×</span>}
                  {entry.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={soloLineStyle}>
        <span aria-hidden style={soloDotStyle(isRunning)} />
        <span style={soloStateStyle(isRunning)}>
          {stateWord}
        </span>
        <span style={soloDetailStyle}>{latest}</span>
      </div>
      {latestUserPrompt && (
        <p style={soloPromptStyle}>
          {latestUserPrompt.length > 150 ? `${latestUserPrompt.slice(0, 149)}…` : latestUserPrompt}
        </p>
      )}
      <div style={soloWaterfallStyle}>
        <button
          type="button"
          onClick={() => setStepsOpen((open) => !open)}
          aria-expanded={stepsOpen}
          style={soloWaterfallToggleStyle}
        >
          <span>{locale === "ko" ? "작업 단계" : "Work steps"}</span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>{waterfall.length}</span>
            <span aria-hidden style={{ transform: stepsOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform .15s ease" }}>▾</span>
          </span>
        </button>
        {!stepsOpen ? null : waterfall.length === 0 ? (
          <div style={soloWaterfallEmptyStyle}>
            {locale === "ko" ? "툴 요청, 스킬 사용, 실행 상태가 여기에 시간순으로 표시됩니다." : "Tool requests, skill use, and execution states appear here in order."}
          </div>
        ) : (
          waterfall.map((item, index) => {
            // 실행 중이면 마지막 이벤트가 지금 하는 일 — 그 행만 활성으로, 이전 행은 완료(✓)로.
            const isCurrent = busy && index === waterfall.length - 1;
            return (
              <article
                key={item.key}
                className={`agentlas-activity-card${isCurrent ? " is-running" : ""}`}
                style={soloWaterfallRowStateStyle(isCurrent)}
              >
                <span style={soloWaterfallIndexStateStyle(isCurrent)}>
                  {isCurrent ? String(index + 1).padStart(2, "0") : "✓"}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={soloWaterfallTitleStyle}>
                    {item.label}
                    {item.toolName && <span style={soloWaterfallToolStyle}>{item.toolName}</span>}
                    {isCurrent && (
                      <span style={soloWaterfallNowChipStyle}>
                        {locale === "ko" ? "진행 중" : "In progress"}
                      </span>
                    )}
                  </div>
                  <div style={soloWaterfallTextStyle}>{item.text}</div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function soloWaterfallItems(timeline: NetTimelineItem[], locale: "ko" | "en"): SoloWaterfallItem[] {
  return timeline
    // TaskCockpit keeps the durable timeline bounded at 80 entries. Do not
    // silently discard the older half of a completed run in the Work rail;
    // long executions need the same inspectable history as the One result rail.
    .slice(-80)
    .map<SoloWaterfallItem | null>((item) => {
      const text = item.kind === "message"
        ? item.text.replace(/\s+/g, " ").trim()
        : cleanSoloStatus(item.text, locale, true);
      if (!text) return null;
      const label =
        item.kind === "tool"
          ? locale === "ko" ? "툴 액션" : "Tool action"
          : item.kind === "handoff"
            ? locale === "ko" ? "위임" : "Handoff"
            : item.kind === "message"
              ? locale === "ko" ? "메시지" : "Message"
            : /skill|스킬/i.test(item.text)
              ? locale === "ko" ? "스킬 사용" : "Skill use"
              : /완료|done|completed/i.test(item.text)
                ? locale === "ko" ? "완료" : "Complete"
                : locale === "ko" ? "상태" : "Status";
      return { key: item.key, kind: item.kind, label, text, toolName: item.toolName };
    })
    .filter((item): item is SoloWaterfallItem => item !== null);
}

function latestSoloTimelineText(timeline: NetTimelineItem[], locale: "ko" | "en", busy: boolean): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const cleaned = timeline[i].kind === "message"
      ? timeline[i].text.replace(/\s+/g, " ").trim()
      : cleanSoloStatus(timeline[i].text, locale, busy);
    if (cleaned) return cleaned;
  }
  return busy ? (locale === "ko" ? "응답 준비 중" : "Preparing response") : (locale === "ko" ? "메시지를 보내면 상태가 표시됩니다" : "Send a message to show status");
}

function cleanSoloStatus(value: string, locale: "ko" | "en", busy: boolean): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/stormbreaker|scope-lock|verifier-first|agentlas\s*오케스트레이터|orchestrator|루프\s*stormbreaker|loop\s*[·:]|armed|route\b/i.test(text)) {
    return busy ? (locale === "ko" ? "처리 중" : "Working") : "";
  }
  if (/^(완료|done|completed)$/i.test(text)) return busy ? text : "";
  return text.length > 110 ? `${text.slice(0, 109)}…` : text;
}

/**
 * Kimchi식 오케스트레이션 트리 — orchestrator(root) → 본부(병렬 그룹) → 전문가(워커).
 * 데스크탑 org roster를 Kimchi의 orchestrator→phase→worker 모델에 매핑하고, 기존 liveAgents + timeline
 * (+ 백엔드의 per-node done 신호)에서 파생한 per-agent 라이프사이클(✓ 완료 · ▶ 실행 · ○ 대기)을 렌더한다.
 * 한 그룹에서 2개 이상의 워커가 동시 실행이거나 본부가 2개 이상 동시 실행이면 `∥` 병렬 마커를 단다.
 * 팀/조직(roster)이 없으면(단일 에이전트) 병렬 프레이밍을 쓰지 않고 단독 작업 뷰로 표시한다.
 */
type OrchStatus = "running" | "idle" | "done" | "pending" | "closed" | "failed";

function OrchestrationTree({
  roster,
  hasRoster,
  liveAgents,
  timeline,
  busy,
  locale,
}: {
  roster: Roster | null;
  hasRoster: boolean;
  liveAgents: Record<string, LiveAgent>;
  timeline: NetTimelineItem[];
  busy: boolean;
  locale: "ko" | "en";
}) {
  const ko = locale === "ko";

  // per-agent 라이프사이클: active 플래그(라이브) + 과거 이벤트(=실행됨=완료). done 이벤트가 active를 끈다.
  const statusOf = (key: string): OrchStatus => {
    const processState = liveAgents[key]?.processState;
    if (processState === "failed") return "failed";
    if (processState === "closed") return "closed";
    if (processState === "idle") return "idle";
    if (liveAgents[key]?.active) return "running";
    const seen = liveAgents[key] !== undefined || timeline.some((it) => it.agentId === key);
    return seen ? "done" : "pending";
  };
  const latestTextOf = (key: string): string | null => {
    let genericCompletion: string | null = null;
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i].agentId !== key) continue;
      if (/^(완료|done)$/i.test(timeline[i].text.trim())) {
        genericCompletion = genericCompletion ?? timeline[i].text;
        continue;
      }
      return timeline[i].text;
    }
    return genericCompletion ?? liveAgents[key]?.status ?? null;
  };
  const tokensOf = (key: string): number =>
    timeline.reduce((sum, it) => (it.agentId === key && it.tokens ? sum + it.tokens : sum), 0);

  // 그룹(본부) 상태는 본부 노드 + 자식에서 파생한다. (단일-division/CEO-단독 시 본부 노드 자체는
  // 실행 이벤트를 안 내므로, 자식이 일하는데 부모만 회색으로 멈춰 보이는 모순을 막는다.)
  const groupStatusOf = (div: RosterDivision): OrchStatus => {
    const own = statusOf(div.key);
    if (own === "failed" || own === "closed") return own;
    if (own === "running") return "running";
    const childStatuses = div.specialists.map((s) => statusOf(s.key));
    if (childStatuses.some((s) => s === "failed")) return "failed";
    if (childStatuses.some((s) => s === "running")) return "running";
    const seen = childStatuses.filter((s) => s !== "pending");
    if (seen.length > 0 && seen.every((s) => s === "closed")) return "closed";
    if (seen.length > 0 && seen.every((s) => s === "idle")) return "idle";
    if (div.specialists.length > 0 && seen.length === div.specialists.length) return "done";
    if (seen.length > 0) return "running"; // 일부 진행했지만 전부 완료 전 → 아직 작업 중
    return own; // pending(또는 본부 자체 done)
  };

  const activeCount = Object.values(liveAgents).filter((a) => a.active).length;

  // roster 키 집합 — 여기에 안 잡히는 live 에이전트(리졸버 레이스/슬러그 불일치)는 따로라도 보여준다.
  const rosterKeys = new Set<string>();
  if (roster) {
    if (roster.ceo) rosterKeys.add(roster.ceo.key);
    for (const d of roster.divisions) {
      rosterKeys.add(d.key);
      for (const s of d.specialists) rosterKeys.add(s.key);
    }
  }
  const extraNodes: RosterNode[] = Object.entries(liveAgents)
    .filter(([k]) => !rosterKeys.has(k))
    .map(([key, a]) => ({ key, name: a.name, role: a.role, tier: a.tier ?? 3 }));

  // 동시 "실제 실행 중"인 본부 수 → 교차-division 병렬(∥) 판정. groupStatusOf의 표시용 'running'
  // (일부 완료 + 일부 대기로 진행 중)과 달리, ∥는 진짜 동시 실행(active)일 때만 켠다.
  const groupActuallyRunning = (div: RosterDivision): boolean =>
    statusOf(div.key) === "running" || div.specialists.some((s) => statusOf(s.key) === "running");
  const divisionsRunning = roster ? roster.divisions.filter(groupActuallyRunning).length : 0;

  const flatNodes: RosterNode[] = hasRoster
    ? []
    : Object.entries(liveAgents).map(([key, a]) => ({ key, name: a.name, role: a.role, tier: a.tier ?? 1 }));
  const isEmpty = !hasRoster && flatNodes.length === 0 && !busy;
  const hasHistoricalActivity = !busy && activeCount === 0 && timeline.length > 0;
  const hasFailureSignal = timelineHasFailureSignal(timeline);
  const hasClosedProcess = Object.values(liveAgents).some((agent) => agent.processState === "closed");
  const hasIdleProcess = Object.values(liveAgents).some((agent) => agent.processState === "idle");

  const statusWord =
    activeCount > 0
      ? ko ? "실행 중" : "running"
      : busy
        ? ko ? "위임 중…" : "delegating…"
        : hasClosedProcess
          ? ko ? "CLI 닫힘" : "CLI closed"
        : hasIdleProcess
          ? ko ? "CLI 대기 중" : "CLI idle"
        : hasFailureSignal
          ? ko ? "검토 필요" : "needs review"
          : hasHistoricalActivity
            ? ko ? "완료" : "completed"
            : ko ? "대기" : "idle";

  return (
    <section style={orchWrapStyle}>
      <div style={orchHeaderStyle}>
        <span style={orchTitleStyle}>
          {hasRoster ? (ko ? "오케스트레이션" : "Orchestration") : (ko ? "에이전트 작업" : "Agent activity")}
        </span>
        <span style={orchStatusWordStyle(activeCount > 0 || busy)}>{statusWord}</span>
      </div>

      {isEmpty ? (
        <div style={orchEmptyStyle}>
          {hasRoster
            ? ko
              ? "메시지를 보내면 오케스트레이터가 작업을 분해해 병렬 서브에이전트로 위임합니다. 각 에이전트의 진행이 여기 트리로 실시간 표시됩니다."
              : "Send a message — the orchestrator decomposes the task and delegates to parallel sub-agents. Each agent's progress shows here as a live tree."
            : ko
              ? "이 에이전트가 단독으로 작업합니다. 단계와 도구 사용이 여기에 실시간으로 표시됩니다."
              : "This agent works solo — its steps and tools appear here as it runs."}
        </div>
      ) : hasRoster && roster ? (
        <div style={orchTreeStyle}>
          {roster.ceo && (
            <AgentRow
              node={roster.ceo}
              kind="orchestrator"
              status={statusOf(roster.ceo.key)}
              activity={latestTextOf(roster.ceo.key)}
              tokens={tokensOf(roster.ceo.key)}
              model={liveAgents[roster.ceo.key]?.model}
              parallel={divisionsRunning >= 2}
              locale={locale}
            />
          )}
          {roster.divisions.map((div) => {
            const specs = div.specialists;
            const doneCount = specs.filter((s) => statusOf(s.key) === "done").length;
            const runningCount = specs.filter((s) => statusOf(s.key) === "running").length;
            const groupParallel = runningCount >= 2 || divisionsRunning >= 2;
            return (
              <div key={div.key} style={orchGroupStyle}>
                <AgentRow
                  node={div}
                  kind="group"
                  status={groupStatusOf(div)}
                  activity={latestTextOf(div.key)}
                  tokens={tokensOf(div.key)}
                  model={liveAgents[div.key]?.model}
                  stepCount={specs.length > 0 ? `${doneCount}/${specs.length}` : undefined}
                  parallel={groupParallel}
                  locale={locale}
                />
                {specs.length > 0 && (
                  <div style={orchWorkersStyle}>
                    {specs.map((s) => (
                      <AgentRow
                        key={s.key}
                        node={s}
                        kind="worker"
                        status={statusOf(s.key)}
                        activity={latestTextOf(s.key)}
                        tokens={tokensOf(s.key)}
                        model={liveAgents[s.key]?.model}
                        locale={locale}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {extraNodes.length > 0 && (
            <div style={orchWorkersStyle}>
              {extraNodes.map((n) => (
                <AgentRow
                  key={n.key}
                  node={n}
                  kind="worker"
                  status={statusOf(n.key)}
                  activity={latestTextOf(n.key)}
                  tokens={tokensOf(n.key)}
                  model={liveAgents[n.key]?.model}
                  locale={locale}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={orchTreeStyle}>
          {flatNodes.map((n, i) => (
            <AgentRow
              key={n.key}
              node={n}
              kind={i === 0 ? "orchestrator" : "worker"}
              status={statusOf(n.key)}
              activity={latestTextOf(n.key)}
              tokens={tokensOf(n.key)}
              model={liveAgents[n.key]?.model}
              locale={locale}
            />
          ))}
        </div>
      )}
      <AgentMessageFeed timeline={timeline} locale={locale} />
    </section>
  );
}

function AgentMessageFeed({ timeline, locale }: { timeline: NetTimelineItem[]; locale: "ko" | "en" }) {
  const messages = timeline.filter((item) => item.kind === "message").slice(-6);
  if (messages.length === 0) return null;
  const ko = locale === "ko";
  return (
    <section style={agentMessageFeedStyle} aria-label={ko ? "에이전트 메시지" : "Agent messages"}>
      <div style={agentMessageFeedTitleStyle}>{ko ? "메시지 흐름" : "Message flow"}</div>
      {messages.map((item) => {
        const outbound = item.messageDirection === "orchestrator-to-worker";
        return (
          <article key={item.key} style={agentMessageCardStyle(outbound)}>
            <div style={agentMessageMetaStyle}>
              <span>{outbound ? "↗" : "↙"}</span>
              <span>{item.name}</span>
              <span style={{ color: RETRO.muted }}>→ {item.messageTo || (ko ? "상위 에이전트" : "parent")}</span>
            </div>
            <div style={agentMessageTextStyle}>{item.text}</div>
          </article>
        );
      })}
    </section>
  );
}

// ── 오케스트레이션 팔레트 — 테마 적응형. 배경/텍스트/엣지는 앱 CSS 변수(다크모드=다크, 라이트모드=주위 색).
//    상태색(amber=작업 중 / green=완료)은 두 테마에서 모두 비비드하게 고정. 픽셀 캐릭터는 시드별 비비드 hue.
const RETRO = {
  bg: "var(--paper)",
  bgGrid: "var(--paper-2)",
  card: "var(--paper)",
  cardRun: "color-mix(in srgb, var(--warn) 10%, var(--paper))",
  cardDone: "color-mix(in srgb, var(--ok) 5%, var(--paper))",
  edge: "var(--paper-edge)",
  edgeRun: "color-mix(in srgb, var(--warn) 42%, var(--paper-edge))",
  edgeDone: "color-mix(in srgb, var(--ok) 26%, var(--paper-edge))",
  ink: "var(--ink)",
  inkSoft: "var(--ink-soft)",
  muted: "var(--muted-deep)",
  amber: "var(--warn)",
  green: "var(--ok)",
  ghost: "var(--muted)",
} as const;

// 8-bit 픽셀 캐릭터 — agent id를 시드로 절차 생성(안정·고유). 레퍼런스(크림 미니 몬스터) 감성.
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CODENAMES = [
  "Bitsy", "Gloomba", "Pixl", "Nibbit", "Zorp", "Mochi", "Goblet", "Wisp", "Tato", "Bonk",
  "Bloop", "Snib", "Crumb", "Munch", "Glitch", "Pip", "Boop", "Fizz", "Gizmo", "Noodle",
  "Pesto", "Quark", "Riff", "Sprout", "Tumble", "Vex", "Wobble", "Yolk", "Ziggy", "Cog",
  "Dapple", "Echo", "Flick", "Grub", "Hush", "Inky", "Jolt", "Kobo", "Lumi", "Mossy",
  "Nub", "Orbit", "Puddle", "Runt", "Spud", "Twix", "Umber", "Volt", "Whirl", "Blip",
] as const;
function codenameFor(seed: string): string {
  const rnd = mulberry32(hashSeed(`${seed}:name`));
  return CODENAMES[Math.floor(rnd() * CODENAMES.length)];
}
function buildCreature(seed: string): boolean[][] {
  const rnd = mulberry32(hashSeed(seed));
  const N = 9;
  const half = 5; // 0..4, 4 = 중앙 (좌우 대칭)
  const g: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
  for (let y = 0; y < N; y++) {
    const w = y === 0 ? 0.28 : y === N - 1 ? 0.32 : y <= 1 || y >= N - 2 ? 0.5 : 0.68;
    for (let x = 0; x < half; x++) {
      const on = rnd() < w;
      g[y][x] = on;
      g[y][N - 1 - x] = on;
    }
  }
  // 몸통 코어 — 가운데 세로 스파인 채워 "빈 캐릭터" 방지
  for (let y = 2; y < N - 1; y++) g[y][4] = true;
  // 눈 — 상단-중앙 구멍 2개(다크 배경이 비쳐 눈처럼). 주변을 채워 눈이 보이게.
  const ey = 2 + Math.floor(rnd() * 2);
  const ex = 2;
  for (const xx of [ex, N - 1 - ex]) {
    g[ey][xx] = false;
    if (g[ey - 1]) g[ey - 1][xx] = true;
  }
  return g;
}

function PixelAvatar({
  seed,
  status,
  kind,
}: {
  seed: string;
  status: OrchStatus;
  kind: "orchestrator" | "group" | "worker";
}) {
  const grid = useMemo(() => buildCreature(seed), [seed]);
  const N = grid.length;
  const size = kind === "worker" ? 28 : 32;
  const inner = size - 8;
  // 비비드 캐릭터 — 에이전트마다 시드 기반 선명한 hue (라이트/다크 양쪽에서 잘 보임).
  const hue = hashSeed(`${seed}:hue`) % 360;
  const tone =
    status === "pending" || status === "closed"
      ? "var(--muted)"
      : status === "failed"
        ? "var(--danger)"
      : kind === "orchestrator"
        ? "var(--warn)"
        : `hsl(${hue} 72% 52%)`;
  const pip =
    status === "running"
      ? RETRO.amber
      : status === "done"
        ? RETRO.green
        : status === "failed"
          ? "var(--danger)"
          : RETRO.muted;
  return (
    <span style={avatarChipStyle(status, size)}>
      <svg
        width={inner}
        height={inner}
        viewBox={`0 0 ${N} ${N}`}
        shapeRendering="crispEdges"
        style={{ display: "block", imageRendering: "pixelated", opacity: status === "pending" || status === "closed" ? 0.7 : 1 }}
        aria-hidden
      >
        {grid.flatMap((row, y) =>
          row.map((on, x) =>
            on ? <rect key={`${x}-${y}`} x={x} y={y} width={1.04} height={1.04} fill={tone} /> : null,
          ),
        )}
      </svg>
      <span
        aria-hidden
        style={{
          position: "absolute",
          right: -2,
          bottom: -2,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: pip,
          border: `2px solid ${RETRO.bg}`,
          boxShadow: status === "running" ? `0 0 0 2px color-mix(in srgb, ${RETRO.amber} 30%, transparent)` : undefined,
        }}
      />
    </span>
  );
}

function AgentRow({
  node,
  kind,
  status,
  activity,
  tokens,
  model,
  stepCount,
  parallel,
  locale,
}: {
  node: RosterNode;
  kind: "orchestrator" | "group" | "worker";
  status: OrchStatus;
  activity: string | null;
  tokens: number;
  model?: string;
  stepCount?: string;
  parallel?: boolean;
  locale: "ko" | "en";
}) {
  const ko = locale === "ko";
  const code = codenameFor(node.key);
  const statusWord = status === "done"
    ? (ko ? "✓ 완료" : "✓ done")
      : status === "running"
        ? (ko ? "작업 중" : "working")
        : status === "idle"
          ? (ko ? "CLI 대기" : "CLI idle")
        : status === "closed"
        ? (ko ? "× CLI 닫힘" : "× CLI closed")
        : status === "failed"
          ? (ko ? "! 실패" : "! failed")
          : (ko ? "대기" : "idle");
  const roleLabel =
    node.role ||
    (kind === "orchestrator"
      ? ko ? "오케스트레이터" : "Orchestrator"
      : kind === "group"
        ? ko ? "본부" : "Lead"
        : ko ? "워커" : "Worker");
  const tokensText = formatTokens(tokens || undefined, locale);
  return (
    <div style={agentRowStyle(kind, status)} aria-label={`${code} (${node.name}), ${model ? model + ", " : ""}${statusWord}`}>
      <PixelAvatar seed={node.key} status={status} kind={kind} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={agentRowTopStyle}>
          <span style={agentNameStyle(kind, status)}>{code}</span>
          {model && <span style={modelPillStyle(status)} title={ko ? `${model} 사용 중` : `using ${model}`}>{model}</span>}
          {parallel && (
            <span style={parallelBadgeStyle} title={ko ? "병렬 실행" : "running in parallel"}>∥</span>
          )}
          {stepCount && <span style={stepCountStyle}>{stepCount}</span>}
        </div>
        <div style={agentMetaStyle}>
          <span style={agentRoleStyle}>{roleLabel}</span>
          <span style={agentRoleSepStyle}> · </span>
          <span style={statusWordStyle(status)}>{statusWord}</span>
          {activity && <span style={agentActivityStyle}> · {activity}</span>}
        </div>
      </div>
      {tokensText && <span style={agentTokensStyle}>{tokensText}</span>}
    </div>
  );
}

function workflowActivityRows(timeline: NetTimelineItem[], locale: "ko" | "en") {
  const handoff = timeline.filter((item) => item.kind === "handoff").length;
  const tool = timeline.filter((item) => item.kind === "tool").length;
  const status = timeline.filter((item) => item.kind === "status").length;
  const message = timeline.filter((item) => item.kind === "message").length;
  const command = Math.max(0, tool - handoff);
  const read = timeline.filter((item) => /read|읽기|파일/i.test(item.text)).length;
  const primary =
    locale === "ko"
      ? `읽기 파일 ${read}개, 실행됨 명령 ${command}개, 사용함 도구 ${tool}개`
      : `Read ${read} file${read === 1 ? "" : "s"}, ran ${command} command${command === 1 ? "" : "s"}, used ${tool} tool${tool === 1 ? "" : "s"}`;
  const secondary =
    locale === "ko"
      ? `위임 ${handoff}개, 메시지 ${message}개, 상태 ${status}개`
      : `${handoff} delegation${handoff === 1 ? "" : "s"}, ${message} message${message === 1 ? "" : "s"}, ${status} update${status === 1 ? "" : "s"}`;
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

const panelStyle: CSSProperties = {
  width: 318,
  minWidth: 268,
  maxWidth: "45vw",
  flexShrink: 1,
  height: "100%",
  background: "var(--paper)",
  borderLeft: "1px solid var(--paper-edge)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const embeddedPanelStyle: CSSProperties = {
  ...panelStyle,
  width: "100%",
  minWidth: 0,
  maxWidth: "none",
  flex: 1,
  borderLeft: "none",
};

const closeButtonStyle: CSSProperties = {
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
};

const soloWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 9,
  padding: "2px 1px",
};

const soloLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
  color: "var(--muted-deep)",
  fontSize: 12.3,
  lineHeight: 1.45,
};

function soloDotStyle(active: boolean): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
    background: active ? "var(--green-deep)" : "var(--muted)",
    boxShadow: active ? "0 0 0 4px color-mix(in srgb, var(--green-deep) 13%, transparent)" : undefined,
  };
}

function soloStateStyle(active: boolean): CSSProperties {
  return {
    flexShrink: 0,
    fontWeight: 820,
    color: active ? "transparent" : "var(--ink-soft)",
    backgroundImage: active ? "linear-gradient(90deg, var(--green-deep), var(--accent), var(--amber-deep))" : undefined,
    backgroundClip: active ? "text" : undefined,
    WebkitBackgroundClip: active ? "text" : undefined,
  };
}

const soloDetailStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink-soft)",
  fontWeight: 650,
};

const soloPromptStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted-deep)",
  fontSize: 11.2,
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};

const soloWaterfallStyle: CSSProperties = {
  display: "grid",
  gap: 7,
  marginTop: 2,
};

const soloWaterfallHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  color: "var(--muted-deep)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  padding: "2px 1px",
};

const soloWaterfallToggleStyle: CSSProperties = {
  ...soloWaterfallHeaderStyle,
  width: "100%",
  border: "none",
  background: "transparent",
  cursor: "pointer",
};

const soloRosterStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "9px 10px",
  borderRadius: 11,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
};

const soloPrimaryAgentStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
};

const soloPrimaryNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12.5,
  fontWeight: 800,
  color: "var(--ink)",
};

const soloPrimaryRoleStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--muted-deep)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

function soloAgentStateWordStyle(active: boolean): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 750,
    color: active ? "var(--green-deep)" : "var(--muted)",
  };
}

const soloAdditionalWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const soloAdditionalLabelStyle: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--muted-deep)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

function soloAgentChipStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    padding: "2px 8px",
    borderRadius: 999,
    border: "1px solid var(--paper-edge)",
    background: "var(--paper)",
    fontSize: 11,
    fontWeight: 650,
    color: active ? "var(--ink)" : "var(--ink-soft)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

const soloBorrowMarkStyle: CSSProperties = {
  fontSize: 9,
  color: "var(--accent)",
  fontWeight: 800,
};

const soloWaterfallEmptyStyle: CSSProperties = {
  border: "1px dashed var(--paper-edge)",
  borderRadius: 8,
  padding: "10px 11px",
  color: "var(--muted-deep)",
  fontSize: 11.5,
  lineHeight: 1.5,
  background: "color-mix(in srgb, var(--paper-2) 72%, transparent)",
};

// 단계 행 — 현재(실행 중) 행은 액센트 하이라이트, 지나간 행은 옅은 그린(완료) 톤.
// is-running 클래스의 스윕 애니메이션(::after)을 위해 relative + overflow hidden 필요.
function soloWaterfallRowStateStyle(current: boolean): CSSProperties {
  return {
    position: "relative",
    overflow: "hidden",
    display: "flex",
    gap: 9,
    alignItems: "flex-start",
    borderRadius: 8,
    padding: "9px 10px",
    border: current
      ? "1px solid color-mix(in srgb, var(--accent) 38%, var(--paper-edge))"
      : "1px solid var(--paper-edge)",
    background: current
      ? "color-mix(in srgb, var(--accent) 6%, var(--paper))"
      : "color-mix(in srgb, var(--green-deep) 3%, var(--paper))",
    boxShadow: current
      ? "0 1px 2px rgba(11, 11, 15, 0.04), 0 8px 22px -18px color-mix(in srgb, var(--accent) 45%, transparent)"
      : "0 1px 2px rgba(11, 11, 15, 0.03)",
  };
}

// 단계 칩 — 현재 행은 번호(액센트 배경), 완료 행은 ✓(그린).
function soloWaterfallIndexStateStyle(current: boolean): CSSProperties {
  return {
    width: 26,
    height: 22,
    borderRadius: 7,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    fontFamily: "var(--font-mono)",
    fontWeight: 800,
    ...(current
      ? { background: "var(--accent)", color: "var(--paper)", fontSize: 10 }
      : {
          background: "color-mix(in srgb, var(--green-deep) 12%, var(--paper-2))",
          color: "var(--green-deep)",
          fontSize: 11,
        }),
  };
}

// 현재 행 우측 "진행 중" 상태 칩.
const soloWaterfallNowChipStyle: CSSProperties = {
  flexShrink: 0,
  marginLeft: "auto",
  borderRadius: 999,
  border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--paper-edge))",
  background: "color-mix(in srgb, var(--accent) 10%, var(--paper))",
  color: "var(--accent-strong)",
  padding: "1px 7px",
  fontSize: 9.5,
  fontWeight: 780,
};

const soloWaterfallTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  color: "var(--ink)",
  fontSize: 11.8,
  fontWeight: 780,
  lineHeight: 1.3,
};

const soloWaterfallToolStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--accent)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontWeight: 700,
};

const soloWaterfallTextStyle: CSSProperties = {
  marginTop: 3,
  color: "var(--muted-deep)",
  fontSize: 11,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
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

function idleCardStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
    border: active ? "1px solid var(--ok-soft)" : "1px solid var(--paper-edge)",
    background: active ? "color-mix(in srgb, var(--ok-soft) 68%, var(--paper) 32%)" : "var(--paper)",
    padding: "10px 12px",
    color: active ? "var(--green-deep)" : "var(--muted-deep)",
    fontSize: 11.5,
    fontWeight: active ? 740 : 500,
    lineHeight: 1.5,
  };
}

function idleDotStyle(active: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    border: active ? "none" : "1.5px solid var(--muted)",
    background: active ? "var(--green-deep)" : "transparent",
    boxShadow: active ? "0 0 0 4px color-mix(in srgb, var(--green-deep) 14%, transparent)" : undefined,
    flexShrink: 0,
  };
}

// ── 오케스트레이션 트리 스타일 ──────────────────────────────
const headerCountBadgeStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 999,
  border: "1px solid color-mix(in srgb, var(--green-deep) 40%, var(--paper-edge))",
  background: "color-mix(in srgb, var(--green-deep) 12%, var(--paper))",
  color: "var(--green-deep)",
  padding: "2px 7px",
  fontSize: 10,
  fontWeight: 850,
};

const RETRO_MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)";

const orchWrapStyle: CSSProperties = {
  marginTop: 14,
  borderRadius: 12,
  border: `1px solid ${RETRO.edge}`,
  background: RETRO.bg,
  padding: "11px 11px 12px",
  overflow: "hidden",
};

const agentMessageFeedStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  marginTop: 10,
  paddingTop: 10,
  borderTop: `1px dashed ${RETRO.edge}`,
};

const agentMessageFeedTitleStyle: CSSProperties = {
  color: RETRO.inkSoft,
  fontSize: 9.5,
  fontWeight: 800,
  letterSpacing: 1.1,
  textTransform: "uppercase",
  fontFamily: RETRO_MONO,
};

function agentMessageCardStyle(outbound: boolean): CSSProperties {
  return {
    borderRadius: 8,
    border: `1px solid ${outbound ? RETRO.edgeRun : RETRO.edgeDone}`,
    background: outbound ? RETRO.cardRun : RETRO.cardDone,
    padding: "7px 8px",
  };
}

const agentMessageMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  color: RETRO.inkSoft,
  fontSize: 9.5,
  fontWeight: 750,
  fontFamily: RETRO_MONO,
};

const agentMessageTextStyle: CSSProperties = {
  marginTop: 4,
  color: RETRO.inkSoft,
  fontSize: 10.8,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const orchHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 10,
};

const orchTitleStyle: CSSProperties = {
  color: RETRO.ink,
  fontSize: 10.5,
  fontWeight: 800,
  letterSpacing: 1.4,
  textTransform: "uppercase",
  fontFamily: RETRO_MONO,
};

function orchStatusWordStyle(active: boolean): CSSProperties {
  return {
    flexShrink: 0,
    color: active ? RETRO.green : RETRO.muted,
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: RETRO_MONO,
  };
}

const orchEmptyStyle: CSSProperties = {
  borderRadius: 9,
  border: `1px solid ${RETRO.edge}`,
  background: RETRO.card,
  padding: "12px 12px",
  color: RETRO.inkSoft,
  fontSize: 11.3,
  lineHeight: 1.55,
};

const orchTreeStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const orchGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const orchWorkersStyle: CSSProperties = {
  marginLeft: 14,
  paddingLeft: 11,
  borderLeft: `1px dashed ${RETRO.edge}`,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

function agentRowStyle(kind: "orchestrator" | "group" | "worker", status: OrchStatus): CSSProperties {
  const running = status === "running";
  const done = status === "done";
  const closed = status === "closed";
  const failed = status === "failed";
  return {
    display: "flex",
    alignItems: "center",
    gap: 9,
    borderRadius: 9,
    // 상태 3단 구분: 실행 중=앰버, 완료=그린 톤, 대기=흐림 — 어느 단계인지 색만으로 읽히게.
    border: `${closed ? "1px dashed" : "1px solid"} ${
      kind === "orchestrator"
        ? RETRO.edgeRun
        : running
          ? RETRO.edgeRun
          : done
            ? RETRO.edgeDone
            : failed
              ? "color-mix(in srgb, var(--danger) 42%, var(--paper-edge))"
              : RETRO.edge
    }`,
    background:
      kind === "orchestrator"
        ? "color-mix(in srgb, var(--warn) 12%, var(--paper))"
        : running
          ? RETRO.cardRun
          : done
            ? RETRO.cardDone
            : failed
              ? "color-mix(in srgb, var(--danger) 7%, var(--paper))"
              : closed
                ? "color-mix(in srgb, var(--muted-deep) 5%, var(--paper))"
                : RETRO.card,
    padding: kind === "worker" ? "6px 8px" : "8px 9px",
    opacity: status === "pending" || status === "closed" ? 0.68 : 1,
  };
}

function avatarChipStyle(status: OrchStatus, size: number): CSSProperties {
  const running = status === "running";
  const failed = status === "failed";
  const closed = status === "closed";
  return {
    position: "relative",
    flexShrink: 0,
    width: size,
    height: size,
    borderRadius: 7,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: running
      ? "color-mix(in srgb, var(--warn) 13%, var(--paper-2))"
      : failed
        ? "color-mix(in srgb, var(--danger) 10%, var(--paper-2))"
        : "var(--paper-2)",
    border: `1px ${closed ? "dashed" : "solid"} ${running ? RETRO.edgeRun : failed ? "color-mix(in srgb, var(--danger) 42%, var(--paper-edge))" : RETRO.edge}`,
    boxShadow: running ? `0 0 10px -3px color-mix(in srgb, ${RETRO.amber} 45%, transparent)` : undefined,
  };
}

const agentRowTopStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

function agentNameStyle(kind: "orchestrator" | "group" | "worker", status: OrchStatus): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: status === "pending" || status === "closed"
      ? RETRO.inkSoft
      : status === "failed"
        ? "var(--danger)"
        : kind === "orchestrator" ? RETRO.amber : RETRO.ink,
    fontSize: kind === "worker" ? 12 : 12.5,
    fontWeight: 800,
    letterSpacing: 0.3,
    fontFamily: RETRO_MONO,
  };
}

const parallelBadgeStyle: CSSProperties = {
  flexShrink: 0,
  color: RETRO.amber,
  fontSize: 12,
  fontWeight: 900,
  lineHeight: 1,
};

const stepCountStyle: CSSProperties = {
  flexShrink: 0,
  borderRadius: 5,
  border: `1px solid ${RETRO.edge}`,
  background: "transparent",
  color: RETRO.inkSoft,
  padding: "1px 5px",
  fontSize: 9.5,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  fontFamily: RETRO_MONO,
};

const agentMetaStyle: CSSProperties = {
  marginTop: 3,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: RETRO.muted,
  fontSize: 10.2,
  lineHeight: 1.4,
};

const agentRoleStyle: CSSProperties = {
  color: RETRO.inkSoft,
  fontWeight: 700,
};

const agentRoleSepStyle: CSSProperties = {
  color: RETRO.muted,
  fontWeight: 600,
};

const agentActivityStyle: CSSProperties = {
  color: RETRO.muted,
  fontWeight: 500,
};

const agentTokensStyle: CSSProperties = {
  flexShrink: 0,
  alignSelf: "center",
  color: RETRO.muted,
  fontSize: 9.5,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  fontFamily: RETRO_MONO,
};

// "모델 사용 중" pill — 실행 중이면 앰버, 아니면 muted.
function modelPillStyle(status: OrchStatus): CSSProperties {
  const running = status === "running";
  return {
    flexShrink: 0,
    maxWidth: 110,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderRadius: 5,
    border: `1px solid ${running ? RETRO.edgeRun : RETRO.edge}`,
    background: running ? "color-mix(in srgb, var(--warn-soft) 12%, transparent)" : "transparent",
    color: running ? RETRO.amber : RETRO.inkSoft,
    padding: "0 5px",
    fontSize: 9.5,
    fontWeight: 700,
    lineHeight: "15px",
    fontFamily: RETRO_MONO,
  };
}

// 상태 워드 — 작업 중(앰버) · 완료(그린) · 대기(muted).
function statusWordStyle(status: OrchStatus): CSSProperties {
  return {
    color: status === "running"
      ? RETRO.amber
      : status === "done"
        ? RETRO.green
        : status === "failed"
          ? "var(--danger)"
          : RETRO.muted,
    fontWeight: 700,
  };
}
