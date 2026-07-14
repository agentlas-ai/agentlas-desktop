"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  IconArrowUp,
  IconBolt,
  IconBrain,
  IconCheck,
  IconClose,
  IconEdit,
  IconLayers,
  IconNetwork,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconShield,
  IconSparkles,
  IconTarget,
} from "@/components/Icon";
import type {
  AgentLearningSummary,
  AgentOntologyHubProjection,
  ExperienceOntologyGraphSnapshot,
  ExperienceOntologySummary,
  InstalledAgent,
} from "@shared/types";
import type {
  MobileBridgeOntologyChipDto,
  MobileBridgeOntologyLoadoutEntryDto,
} from "@shared/mobile-bridge";
import { OntologyAtlas } from "@/components/ontology/OntologyAtlas";

type Locale = "ko" | "en";

type OntologyGraphNode = {
  id: string;
  short: string;
  label: string;
  detail: string;
  count: number;
  source: "agent" | "local" | "hub";
  tone: "agent" | "operational" | "taste" | "evidence" | "safety" | "hub";
  x: number;
  y: number;
};

type OntologyGraphEdge = {
  from: string;
  to: string;
  pending?: boolean;
};

export function agentOriginalName(agent: InstalledAgent, locale: Locale): string {
  return locale === "en" ? agent.nameEn?.trim() || agent.name : agent.name?.trim() || agent.nameEn;
}

export function agentDisplayName(agent: InstalledAgent, locale: Locale): string {
  return agent.localDisplayName?.trim() || agentOriginalName(agent, locale);
}

export function AgentNameEditor({
  agent,
  locale,
  onSave,
}: {
  agent: InstalledAgent;
  locale: Locale;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.localDisplayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const originalName = agentOriginalName(agent, locale);
  const displayName = agentDisplayName(agent, locale);

  useEffect(() => {
    setDraft(agent.localDisplayName ?? "");
  }, [agent.id, agent.localDisplayName]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const cancel = () => {
    setDraft(agent.localDisplayName ?? "");
    setError("");
    setEditing(false);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="agent-local-alias" style={{ minWidth: 0 }}>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
        >
          <label htmlFor={`agent-alias-${agent.id}`} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            {locale === "ko" ? "로컬 표시 이름" : "Local display name"}
          </label>
          <input
            ref={inputRef}
            id={`agent-alias-${agent.id}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
            placeholder={originalName}
            aria-describedby={`agent-alias-hint-${agent.id}`}
            disabled={saving}
            style={{ minWidth: 220, height: 34, padding: "0 10px", borderRadius: 7, border: "1px solid var(--accent)", background: "var(--paper-2)", color: "var(--ink)", fontSize: 15, fontWeight: 700 }}
          />
          <button type="submit" aria-label={locale === "ko" ? "표시 이름 저장" : "Save display name"} disabled={saving} style={iconButtonStyle}>
            <IconCheck size={14} />
          </button>
          <button type="button" aria-label={locale === "ko" ? "표시 이름 편집 취소" : "Cancel display-name editing"} onClick={cancel} disabled={saving} style={iconButtonStyle}>
            <IconClose size={14} />
          </button>
          <span id={`agent-alias-hint-${agent.id}`} style={{ flexBasis: "100%", color: "var(--muted-deep)", fontSize: 10.5 }}>
            {locale === "ko" ? "비워서 저장하면 원래 이름으로 돌아갑니다." : "Save an empty value to restore the original name."}
          </span>
        </form>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{displayName}</h1>
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={locale === "ko" ? `${displayName} 로컬 표시 이름 편집` : `Edit local display name for ${displayName}`}
            title={locale === "ko" ? "이 Mac에서만 보이는 이름 편집" : "Edit the name shown only on this Mac"}
            style={pencilIconStyle}
          >
            <IconEdit size={13} />
          </button>
        </div>
      )}
      {!editing && agent.localDisplayName?.trim() && (
        <div data-testid="agent-original-name" style={{ marginTop: 3, color: "var(--muted-deep)", fontSize: 10.5 }}>
          {locale === "ko" ? "원래 이름" : "Original name"}: {originalName}
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 5, color: "var(--red-deep)", fontSize: 10.5 }}>{error}</div>}
    </div>
  );
}

export function AgentLearningMetricGrid({
  summary,
  loading,
  error,
  locale,
  context,
}: {
  summary: AgentLearningSummary | null;
  loading: boolean;
  error: string;
  locale: Locale;
  context: "activity" | "playbook";
}) {
  if (loading) return <InsightNotice text={locale === "ko" ? "학습 기록을 확인하는 중…" : "Loading learning history…"} />;
  if (!summary) return <InsightNotice error text={error || (locale === "ko" ? "학습 기록을 불러오지 못했습니다." : "Learning history is unavailable.")} />;

  const metrics = context === "activity"
    ? [
        [locale === "ko" ? "완료한 작업" : "Completed work", summary.runCount],
        [locale === "ko" ? "관련 이전 대화" : "Related conversations", summary.legacyChatLinkedRunCount],
        [locale === "ko" ? "기억한 내용" : "Saved learnings", summary.durableMemoryCount],
        [locale === "ko" ? "문제 발생" : "Issues", summary.failureCount],
        [locale === "ko" ? "개선 기록" : "Improvements", summary.evolutionProposalCount],
      ] as const
    : [
        [locale === "ko" ? "기억한 내용" : "Saved learnings", summary.durableMemoryCount],
        [locale === "ko" ? "수동 메모" : "Manual notes", summary.memoryMarkdownCount],
        [locale === "ko" ? "연결된 파일" : "Connected files", summary.localFileCount],
        [locale === "ko" ? "변경 기록" : "Change records", summary.localReceiptCount],
      ] as const;

  return (
    <div data-testid={`agent-learning-${context}`}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 10 }}>
        {metrics.map(([label, value]) => (
          <div key={label} style={metricCardStyle}>
            <div style={{ color: "var(--muted-deep)", fontSize: 10.5 }}>{label}</div>
            <strong style={{ color: "var(--ink)", fontSize: 20 }}>{value}</strong>
          </div>
        ))}
      </div>
      <div data-testid="agent-memory-curation-ledger" style={{ marginTop: 9, color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.55 }}>
        {summary.curationTurnCount > 0 ? (
          <>
            <div>
              {locale === "ko"
                ? `최근 작업 ${summary.curationTurnCount}건을 확인해 기억할 내용 ${summary.memoryEventCount}개를 찾고 ${summary.memoryWrittenCount}개를 저장했습니다.`
                : `Checked ${summary.curationTurnCount} recent tasks, found ${summary.memoryEventCount} useful items, and saved ${summary.memoryWrittenCount}.`}
            </div>
            <details style={{ marginTop: 3 }}>
              <summary style={{ cursor: "pointer", fontWeight: 650 }}>
                {locale === "ko" ? "자세한 처리 내역" : "View processing details"}
              </summary>
              <div style={{ marginTop: 4 }}>
                {locale === "ko"
                  ? `새 내용 없음 ${summary.noNewMemoryTurnCount} · 중복 제외 ${summary.memoryDedupedCount} · 민감정보 제외 ${summary.memoryRedactedCount} · 이번 작업에만 사용 ${summary.memorySessionOnlyCount} · 저장하지 않음 ${summary.memoryDiscardedCount}`
                  : `No new content ${summary.noNewMemoryTurnCount} · duplicates removed ${summary.memoryDedupedCount} · sensitive content removed ${summary.memoryRedactedCount} · session only ${summary.memorySessionOnlyCount} · not saved ${summary.memoryDiscardedCount}`}
              </div>
            </details>
          </>
        ) : (
          locale === "ko"
            ? "상세 학습 기록은 이번 버전부터 쌓입니다. 이전 기록은 확인할 수 있는 범위만 표시합니다."
            : "Detailed learning history starts with this version. Older activity is shown only where it can be verified."
        )}
      </div>
      {context === "activity" && (
        <div style={{ marginTop: 8, color: "var(--muted-deep)", fontSize: 10.5 }}>
          {locale === "ko" ? "최근 작업" : "Latest work"}: {summary.lastRunAt ? new Date(summary.lastRunAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US") : (locale === "ko" ? "기록 없음" : "No recorded work")}
          {summary.legacyChatLinkedRunCount > 0
            ? ` · ${locale === "ko" ? "관련 이전 대화" : "Related earlier conversations"} ${summary.legacyChatLinkedRunCount}${summary.legacyChatLinkedFailureCount > 0 ? ` (${locale === "ko" ? "문제가 있었던 대화" : "with issues"} ${summary.legacyChatLinkedFailureCount})` : ""}`
            : ""}
          {summary.legacyUnattributedCount > 0 ? ` · ${locale === "ko" ? "담당 에이전트 미확인" : "Agent not identified"} ${summary.legacyUnattributedCount}` : ""}
          {summary.legacyChatLinkedRunCount > 0 && (
            <span style={{ display: "block", marginTop: 4 }}>
              {locale === "ko"
                ? "이전 대화는 이 에이전트와 관련 있지만, 당시 작업을 끝까지 맡았는지는 확인할 수 없습니다."
                : "These earlier conversations are related to this agent, but do not prove it handled the work from start to finish."}
            </span>
          )}
        </div>
      )}
      {context === "playbook" && (
        <p style={{ margin: "9px 0 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}>
          {locale === "ko"
            ? "배운 내용은 자동으로 작업 절차에 반영되지 않습니다. 검토하고 승인한 변경만 적용됩니다."
            : "Learned content is not added to the playbook automatically. Only reviewed and approved changes are applied."}
        </p>
      )}
    </div>
  );
}

export function ExperienceOntologySummaryView({
  summary,
  loading,
  error,
  locale,
}: {
  summary: ExperienceOntologySummary | null;
  loading: boolean;
  error: string;
  locale: Locale;
}) {
  if (loading) return <InsightNotice text={locale === "ko" ? "저장된 경험을 확인하는 중…" : "Checking saved experience…"} />;
  if (!summary) return <InsightNotice error text={error || (locale === "ko" ? "저장된 경험을 불러오지 못했습니다." : "Saved experience is unavailable.")} />;

  const counts = [
    [locale === "ko" ? "경험 묶음" : "Collections", summary.packCount],
    [locale === "ko" ? "저장한 경험" : "Saved items", summary.candidateCount],
    [locale === "ko" ? "검토 완료" : "Reviewed", summary.promotedCount],
    [locale === "ko" ? "적용 작업" : "Supported tasks", summary.taskCount],
    [locale === "ko" ? "확인 자료" : "Supporting checks", summary.evidenceCount],
  ] as const;

  return (
    <details data-testid="experience-ontology-summary" style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
      <summary style={{ listStyle: "none", cursor: "pointer", minHeight: 52, padding: "9px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--paper-2)", color: "var(--accent)", boxShadow: "inset 0 1px 0 color-mix(in srgb, white 58%, transparent)" }}>
          <IconLayers size={14} />
        </span>
        <strong style={{ fontSize: 12.5 }}>{locale === "ko" ? "내가 만든 경험" : "Experience I created"}</strong>
        <span aria-label={`${locale === "ko" ? "저장한 경험" : "Saved experience"} ${summary.candidateCount}`} style={ontologyCompactMetricStyle}>
          {locale === "ko" ? "저장" : "Saved"} {summary.candidateCount}
        </span>
        {summary.autoIntake.blocked > 0 && (
          <span aria-label={`${locale === "ko" ? "개인정보 보호로 제외" : "Excluded for privacy"} ${summary.autoIntake.blocked}`} style={{ ...ontologyCompactMetricStyle, color: "var(--red-deep)" }}>
            {locale === "ko" ? "개인정보 보호로 제외" : "Excluded for privacy"} {summary.autoIntake.blocked}
          </span>
        )}
        <span aria-hidden="true" style={{ marginLeft: "auto", width: 7, height: 7, borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", transform: "rotate(45deg) translateY(-2px)", color: "var(--muted-deep)" }} />
      </summary>
      <div style={{ padding: "0 12px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10, paddingTop: 10, borderTop: "1px solid var(--paper-edge)" }}>
          <strong style={{ fontSize: 11.5 }}>{locale === "ko" ? "저장된 경험" : "Saved experience"}</strong>
          <span style={{ padding: "4px 8px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 10.5, fontWeight: 700 }}>
            {summary.localReceiptCount} {locale === "ko" ? "검토 기록" : "review records"}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 7 }}>
          {counts.map(([label, value]) => (
            <div key={label} style={{ ...metricCardStyle, padding: 9 }}>
              <span style={{ color: "var(--muted-deep)", fontSize: 10 }}>{label}</span>
              <strong style={{ color: "var(--ink)", fontSize: 17 }}>{value}</strong>
            </div>
          ))}
        </div>
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--paper-edge)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 11.5 }}>{locale === "ko" ? "자동으로 찾은 경험" : "Automatically found experience"}</strong>
          <StatusChip tone="safe" label={`${locale === "ko" ? "생성" : "created"} ${summary.autoIntake.candidateCreated}`} />
          <StatusChip tone="blocked" label={`${locale === "ko" ? "개인정보 차단" : "privacy-blocked"} ${summary.autoIntake.blocked}`} />
          <StatusChip tone="skipped" label={`${locale === "ko" ? "건너뜀" : "skipped"} ${summary.autoIntake.skipped}`} />
        </div>
        {summary.autoIntake.reasons.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}>
            {summary.autoIntake.reasons.slice(0, 8).map((reason) => (
              <span key={reason.code} title={reason.code} style={{ padding: "4px 7px", borderRadius: 999, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 10.5 }}>
                {experienceIntakeReasonLabel(reason.code, locale)} · <strong>{reason.count}</strong>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 8, color: "var(--muted-deep)", fontSize: 11 }}>{locale === "ko" ? "차단·건너뜀 사유가 없습니다." : "No blocked or skipped reason recorded."}</div>
        )}
        {(summary.autoIntake.blocked > 0 || summary.tasteNeedsEvidenceCount > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 9, color: "var(--muted-deep)", fontSize: 10.5 }}>
            {summary.autoIntake.blocked > 0 && <span>{locale === "ko" ? "개인정보가 감지된 원문은 저장하지 않았습니다." : "Source text containing personal information was not saved."}</span>}
            {summary.tasteNeedsEvidenceCount > 0 && <span>{locale === "ko" ? "취향 후보는 효과 점수가 아니라 선택 기록입니다." : "Taste candidates are preference records, not effectiveness scores."}</span>}
          </div>
        )}
      </div>
      </div>
    </details>
  );
}

export function AgentOntologyGraphView({
  summary,
  graphSnapshot,
  hub,
  agentName,
  locale,
  graphLoading = false,
  graphError = false,
}: {
  summary: ExperienceOntologySummary | null;
  graphSnapshot: ExperienceOntologyGraphSnapshot | null;
  hub: AgentOntologyHubProjection | null;
  agentName: string;
  locale: Locale;
  graphLoading?: boolean;
  graphError?: boolean;
}) {
  return (
    <OntologyAtlas
      summary={summary}
      graphSnapshot={graphSnapshot}
      hub={hub}
      agentName={agentName}
      locale={locale}
      graphLoading={graphLoading}
      graphError={graphError}
    />
  );
}

/**
 * Kept temporarily as a no-export compatibility reference while the new
 * relation-ledger Atlas is exercised by release QA. It is not mounted.
 */
function LegacyAgentOntologyGraphView({
  summary,
  hub,
  agentName,
  locale,
}: {
  summary: ExperienceOntologySummary | null;
  hub: AgentOntologyHubProjection | null;
  agentName: string;
  locale: Locale;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<
    | { kind: "pan"; pointerId: number; clientX: number; clientY: number; x: number; y: number }
    | { kind: "node"; pointerId: number; nodeId: string; clientX: number; clientY: number; x: number; y: number }
    | null
  >(null);
  const instructionsId = useId();
  const [filter, setFilter] = useState<"all" | "local" | "hub">("all");
  const [selectedId, setSelectedId] = useState("agent");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [reducedMotion, setReducedMotion] = useState(false);
  const ko = locale === "ko";
  const projection = hub?.projection ?? null;
  const hubOperational = projection?.operationalChips ?? [];
  const hubTaste = projection?.tasteChips ?? [];
  const oneHubOperational = hubOperational.length === 1 ? hubOperational[0] : null;
  const oneHubTaste = hubTaste.length === 1 ? hubTaste[0] : null;
  const nodes: OntologyGraphNode[] = summary ? [
    { id: "agent", short: "A", label: agentName, detail: ko ? "선택한 에이전트" : "Selected agent", count: 1, source: "agent", tone: "agent", x: 48, y: 45 },
    { id: "operational", short: "O", label: ko ? "실행 경험" : "Operational", detail: ko ? "재현 가능한 실행 후보" : "Reproducible work candidates", count: summary.candidateCount, source: "local", tone: "operational", x: 24, y: 27 },
    { id: "taste", short: "T", label: ko ? "취향 후보" : "Taste drafts", detail: ko ? "비공개 · 사람 근거 대기" : "Private · awaiting human evidence", count: summary.tasteDraftCount, source: "local", tone: "taste", x: 24, y: 57 },
    { id: "tasks", short: "TSK", label: ko ? "태스크" : "Tasks", detail: ko ? "적용 가능한 표준 작업" : "Canonical task signatures", count: summary.taskCount, source: "local", tone: "evidence", x: 8, y: 13 },
    { id: "evidence", short: "EV", label: ko ? "확인 자료" : "Supporting checks", detail: ko ? "효과와 안전을 확인한 기록" : "Records confirming effectiveness and safety", count: summary.evidenceCount, source: "local", tone: "evidence", x: 8, y: 38 },
    { id: "mcp", short: "MCP", label: "MCP", detail: ko ? "필요한 도구 카탈로그 관계" : "Required tool-catalog relations", count: summary.mcpCount, source: "local", tone: "evidence", x: 9, y: 65 },
    { id: "safety", short: "S", label: ko ? "안전 차단" : "Safety", detail: ko ? "원문을 복사하지 않은 항목" : "Items blocked without copying source text", count: summary.autoIntake.blocked, source: "local", tone: "safety", x: 41, y: 65 },
    { id: "hub", short: "H", label: "Hub", detail: hub?.binding ? (ko ? "Hub 연결 확인됨" : "Hub connection verified") : (ko ? "Hub 연결 없음" : "Not connected to Hub"), count: hub?.binding ? 1 : 0, source: "hub", tone: "hub", x: 72, y: 45 },
    { id: "hub-op", short: "O", label: oneHubOperational?.displayName || (ko ? "장착 실행칩" : "Hub Operational"), detail: oneHubOperational?.summary || (ko ? "Hub에서 확인된 실행칩" : "Hub-confirmed Operational chips"), count: oneHubOperational?.evidenceCount ?? hubOperational.length, source: "hub", tone: "operational", x: 90, y: 18 },
    { id: "hub-taste", short: "T", label: oneHubTaste?.displayName || (ko ? "장착 취향칩" : "Hub Taste"), detail: oneHubTaste?.summary || (ko ? "사람 A/B 근거가 있는 Taste 칩" : "Taste chips with human A/B evidence"), count: oneHubTaste?.evidenceCount ?? hubTaste.length, source: "hub", tone: "taste", x: 91, y: 45 },
    { id: "next", short: "N", label: ko ? "다음 세션" : "Next session", detail: ko ? "승인 후 다음 세션에 적용" : "Applies next session after approval", count: projection?.scheduledNextSession?.entries.length ?? 0, source: "hub", tone: "hub", x: 84, y: 65 },
  ] : [];
  const edges: OntologyGraphEdge[] = [
    { from: "agent", to: "operational" },
    { from: "agent", to: "taste", pending: (summary?.tasteNeedsEvidenceCount ?? 0) > 0 },
    { from: "operational", to: "tasks" },
    { from: "operational", to: "evidence" },
    { from: "operational", to: "mcp" },
    { from: "taste", to: "safety", pending: true },
    { from: "agent", to: "hub", pending: !hub?.binding },
    { from: "hub", to: "hub-op" },
    { from: "hub", to: "hub-taste" },
    { from: "hub", to: "next", pending: true },
  ];
  const visibleNodes = nodes.filter((node) => filter === "all" || node.source === "agent" || node.source === filter);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const selected = visibleNodes.find((node) => node.id === selectedId) ?? visibleNodes[0] ?? null;
  const inspected = visibleNodes.find((node) => node.id === hoveredId) ?? selected;
  const positionedVisibleNodes = visibleNodes.map((node) => ({ ...node, ...(nodePositions[node.id] ?? {}) }));
  const connected = new Set(visibleEdges.flatMap((edge) =>
    edge.from === inspected?.id ? [edge.to] : edge.to === inspected?.id ? [edge.from] : []));

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    setView({ x: 0, y: 0, scale: 1 });
    setNodePositions({});
    setSelectedId("agent");
    setHoveredId(null);
  }, [agentName]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !canvas) return;
    const draw = () => {
      const rect = surface.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      const style = getComputedStyle(surface);
      const edge = style.getPropertyValue("--ontology-edge").trim() || "rgba(110,120,132,.35)";
      const active = style.getPropertyValue("--ontology-edge-active").trim() || "rgba(35,110,105,.78)";
      const byId = new Map(positionedVisibleNodes.map((node) => [node.id, node]));
      for (const relation of visibleEdges) {
        const from = byId.get(relation.from);
        const to = byId.get(relation.to);
        if (!from || !to) continue;
        const highlighted = inspected?.id === relation.from || inspected?.id === relation.to;
        context.beginPath();
        context.setLineDash(relation.pending ? [5, 6] : []);
        context.strokeStyle = highlighted ? active : edge;
        context.lineWidth = highlighted ? 1.8 : 1;
        context.moveTo((from.x / 100) * rect.width, (from.y / 100) * rect.height);
        context.lineTo((to.x / 100) * rect.width, (to.y / 100) * rect.height);
        context.stroke();
      }
      context.setLineDash([]);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [filter, selectedId, hoveredId, summary, hub, nodePositions]);

  const resetGraph = () => {
    setView({ x: 0, y: 0, scale: 1 });
    setNodePositions({});
    setSelectedId("agent");
    setHoveredId(null);
  };

  const zoomAt = (nextScale: number, clientX?: number, clientY?: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const anchorX = clientX == null ? rect.width / 2 : clientX - rect.left;
    const anchorY = clientY == null ? rect.height / 2 : clientY - rect.top;
    setView((current) => {
      const scale = Math.min(2.2, Math.max(0.7, nextScale));
      const ratio = scale / current.scale;
      return {
        scale,
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio,
      };
    });
  };

  const nudgeNode = (node: OntologyGraphNode, dx: number, dy: number) => {
    const position = nodePositions[node.id] ?? { x: node.x, y: node.y };
    setNodePositions((current) => ({
      ...current,
      [node.id]: {
        x: Math.min(93, Math.max(7, position.x + dx)),
        y: Math.min(66, Math.max(8, position.y + dy)),
      },
    }));
  };

  if (!summary) return <InsightNotice text={ko ? "관계 지도를 만드는 중…" : "Building the relation map…"} />;

  return (
    <section data-testid="agent-ontology-graph" style={{ border: "1px solid var(--paper-edge)", borderRadius: 16, background: "var(--paper)", overflow: "hidden", boxShadow: "0 16px 38px color-mix(in srgb, var(--ink) 8%, transparent)" }}>
      <div style={{ minHeight: 44, padding: "8px 10px 8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderBottom: "1px solid var(--paper-edge)", background: "color-mix(in srgb, var(--paper) 86%, transparent)", backdropFilter: "blur(14px) saturate(115%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: "var(--green-deep)", boxShadow: "0 0 0 4px var(--green-soft)" }} />
          <strong style={{ fontSize: 12 }}>{ko ? "관계 지도" : "Relation map"}</strong>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7, minWidth: 0, flexWrap: "wrap" }}>
          <div aria-label={ko ? "관계선 범례" : "Relation legend"} style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--muted-deep)", fontSize: 9.5 }}>
            <span title={ko ? "연결됨" : "Connected"} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i aria-hidden="true" style={{ width: 14, borderTop: "1.5px solid currentColor" }} />{ko ? "연결" : "linked"}</span>
            <span title={ko ? "승인·근거 대기" : "Pending approval or evidence"} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i aria-hidden="true" style={{ width: 14, borderTop: "1.5px dashed currentColor" }} />{ko ? "대기" : "pending"}</span>
          </div>
          <button type="button" onClick={resetGraph} aria-label={ko ? "에이전트 중심으로 돌아가기" : "Reset to agent center"} title={ko ? "위치와 배율 초기화" : "Reset positions and zoom"} style={{ width: 30, height: 30, padding: 0, display: "grid", placeItems: "center", borderRadius: 9, border: "1px solid var(--paper-edge)", background: selectedId === "agent" && view.scale === 1 ? "var(--paper)" : "var(--paper-2)", color: selectedId === "agent" ? "var(--ink)" : "var(--muted-deep)", cursor: "pointer" }}>
            <IconBrain size={13} />
          </button>
          <div role="group" aria-label={ko ? "관계 지도 배율" : "Relation map zoom"} style={{ display: "flex", alignItems: "center", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper-2)", overflow: "hidden" }}>
            <button type="button" onClick={() => zoomAt(view.scale - 0.18)} aria-label={ko ? "축소" : "Zoom out"} title={ko ? "축소" : "Zoom out"} style={ontologyGraphToolButtonStyle}><span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>−</span></button>
            <span aria-hidden="true" style={{ minWidth: 34, textAlign: "center", color: "var(--muted-deep)", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>{Math.round(view.scale * 100)}%</span>
            <button type="button" onClick={() => zoomAt(view.scale + 0.18)} aria-label={ko ? "확대" : "Zoom in"} title={ko ? "확대" : "Zoom in"} style={ontologyGraphToolButtonStyle}><IconPlus size={12} /></button>
          </div>
          <div role="group" aria-label={ko ? "관계 지도 범위" : "Relation map scope"} style={{ display: "flex", padding: 3, borderRadius: 10, background: "var(--paper-2)", border: "1px solid var(--paper-edge)" }}>
            {(["all", "local", "hub"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setSelectedId("agent"); }} style={{ border: 0, borderRadius: 7, minWidth: 44, height: 24, padding: "0 7px", background: filter === value ? "var(--paper)" : "transparent", color: filter === value ? "var(--ink)" : "var(--muted-deep)", boxShadow: filter === value ? "0 2px 7px color-mix(in srgb, var(--ink) 10%, transparent)" : "none", fontSize: 10, fontWeight: 750, cursor: "pointer" }}>
                {value === "all" ? (ko ? "전체" : "All") : value === "local" ? (ko ? "로컬" : "Local") : "Hub"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        ref={surfaceRef}
        data-filter={filter}
        data-zoom={view.scale.toFixed(2)}
        data-pan-x={Math.round(view.x)}
        data-pan-y={Math.round(view.y)}
        role="group"
        tabIndex={0}
        aria-describedby={instructionsId}
        aria-label={ko ? "관계 지도 작업면" : "Relation map workspace"}
        onWheel={(event) => {
          event.preventDefault();
          zoomAt(view.scale * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          gestureRef.current = { kind: "pan", pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
          setPanning(true);
        }}
        onPointerMove={(event) => {
          const gesture = gestureRef.current;
          if (!gesture || gesture.kind !== "pan" || gesture.pointerId !== event.pointerId) return;
          setView((current) => ({ ...current, x: gesture.x + event.clientX - gesture.clientX, y: gesture.y + event.clientY - gesture.clientY }));
        }}
        onPointerUp={(event) => {
          const gesture = gestureRef.current;
          if (!gesture || gesture.kind !== "pan" || gesture.pointerId !== event.pointerId) return;
          gestureRef.current = null;
          setPanning(false);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => { gestureRef.current = null; setPanning(false); }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const distance = event.shiftKey ? 48 : 24;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setView((current) => ({
              ...current,
              x: current.x + (event.key === "ArrowLeft" ? distance : event.key === "ArrowRight" ? -distance : 0),
              y: current.y + (event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0),
            }));
          }
          if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(view.scale + 0.18); }
          if (event.key === "-") { event.preventDefault(); zoomAt(view.scale - 0.18); }
          if (event.key === "Escape" || event.key === "0") { event.preventDefault(); resetGraph(); }
        }}
        style={{
          "--ontology-edge": "color-mix(in srgb, var(--muted-deep) 34%, transparent)",
          "--ontology-edge-active": "color-mix(in srgb, var(--accent) 82%, var(--ink))",
          position: "relative",
          height: "clamp(380px, 44vw, 430px)",
          backgroundColor: "var(--paper-2)",
          backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--muted-deep) 17%, transparent) 1px, transparent 0)",
          backgroundSize: "18px 18px",
          overflow: "hidden",
          cursor: panning ? "grabbing" : "grab",
          touchAction: "none",
        } as React.CSSProperties}
      >
        <span id={instructionsId} style={visuallyHiddenStyle}>
          {ko ? "빈 공간을 드래그하거나 방향키로 이동하고, 휠 또는 확대·축소 버튼으로 배율을 바꿉니다. 노드는 드래그하거나 포커스 후 방향키로 옮길 수 있습니다." : "Drag empty space or use arrow keys to pan. Use the wheel or zoom buttons to zoom. Drag a node or focus it and use arrow keys to move it."}
        </span>
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`, willChange: "transform", pointerEvents: "none" }}>
          <canvas ref={canvasRef} style={{ position: "absolute", inset: 0 }} />
        </div>
        <div style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`, willChange: "transform", pointerEvents: "none" }}>
        {positionedVisibleNodes.map((node) => {
          const active = selected?.id === node.id;
          const dimmed = inspected?.id !== "agent" && inspected && inspected.id !== node.id && !connected.has(node.id);
          const tone = ontologyGraphTone(node.tone);
          const size = node.source === "agent" ? 74 : node.source === "hub" && node.id === "hub" ? 64 : Math.min(64, 44 + Math.log2(node.count + 1) * 5);
          return (
            <button
              key={node.id}
              type="button"
              data-node-id={node.id}
              aria-label={`${node.label}: ${node.count}. ${node.detail}`}
              aria-pressed={active}
              onClick={() => setSelectedId(node.id)}
              onFocus={() => setSelectedId(node.id)}
              onMouseEnter={() => setHoveredId(node.id)}
              onMouseLeave={() => setHoveredId((current) => current === node.id ? null : current)}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                setSelectedId(node.id);
                const position = nodePositions[node.id] ?? { x: node.x, y: node.y };
                gestureRef.current = { kind: "node", pointerId: event.pointerId, nodeId: node.id, clientX: event.clientX, clientY: event.clientY, x: position.x, y: position.y };
                setDraggingId(node.id);
              }}
              onPointerMove={(event) => {
                const gesture = gestureRef.current;
                const surface = surfaceRef.current;
                if (!surface || !gesture || gesture.kind !== "node" || gesture.nodeId !== node.id || gesture.pointerId !== event.pointerId) return;
                const rect = surface.getBoundingClientRect();
                const x = gesture.x + ((event.clientX - gesture.clientX) / view.scale / rect.width) * 100;
                const y = gesture.y + ((event.clientY - gesture.clientY) / view.scale / rect.height) * 100;
                setNodePositions((current) => ({ ...current, [node.id]: { x: Math.min(93, Math.max(7, x)), y: Math.min(66, Math.max(8, y)) } }));
              }}
              onPointerUp={(event) => {
                const gesture = gestureRef.current;
                if (!gesture || gesture.kind !== "node" || gesture.nodeId !== node.id || gesture.pointerId !== event.pointerId) return;
                gestureRef.current = null;
                setDraggingId(null);
                event.currentTarget.releasePointerCapture?.(event.pointerId);
              }}
              onPointerCancel={() => { gestureRef.current = null; setDraggingId(null); }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 5 : 2;
                if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  nudgeNode(node, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
                }
                if (event.key === "Escape") { event.preventDefault(); resetGraph(); }
              }}
              title={ko ? "가리켜서 확인 · 드래그 또는 방향키로 이동" : "Hover to inspect · drag or use arrow keys to move"}
              style={{
                position: "absolute",
                left: `${node.x}%`,
                top: `${node.y}%`,
                width: size,
                height: size,
                transform: "translate(-50%, -50%)",
                borderRadius: node.tone === "agent" ? 20 : 999,
                border: `1px ${node.count === 0 ? "dashed" : "solid"} ${tone.border}`,
                background: tone.background,
                color: tone.color,
                boxShadow: active ? `0 0 0 4px ${tone.ring}, 0 12px 26px color-mix(in srgb, var(--ink) 16%, transparent)` : "inset 0 1px 0 color-mix(in srgb, white 55%, transparent), 0 6px 16px color-mix(in srgb, var(--ink) 10%, transparent)",
                opacity: dimmed ? 0.42 : node.count === 0 ? 0.64 : 1,
                display: "grid",
                placeItems: "center",
                cursor: draggingId === node.id ? "grabbing" : "grab",
                transition: reducedMotion ? "none" : "opacity 140ms ease, box-shadow 140ms ease",
                zIndex: active ? 3 : 2,
                pointerEvents: "auto",
                touchAction: "none",
              }}
            >
              <span aria-hidden="true" style={{ display: "grid", placeItems: "center", lineHeight: 1 }}>
                {ontologyGraphNodeIcon(node.id, node.source === "agent" ? 23 : 18, tone.color)}
                <small style={{ marginTop: 3, fontSize: 9, fontWeight: 850 }}>{node.count}</small>
              </span>
              <span aria-hidden="true" style={{ position: "absolute", top: "calc(100% + 5px)", left: "50%", transform: "translateX(-50%)", maxWidth: 105, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-soft)", fontSize: 9.5, fontWeight: 700, textShadow: "0 1px 0 var(--paper-2)" }}>{node.label}</span>
            </button>
          );
        })}
        </div>
        {inspected && (
          <div data-testid="ontology-node-inspector" aria-live="polite" style={{ position: "absolute", left: 12, right: 12, bottom: 10, minHeight: 44, padding: "8px 11px", border: "1px solid var(--paper-edge)", borderRadius: 11, background: "color-mix(in srgb, var(--paper) 84%, transparent)", backdropFilter: "blur(15px) saturate(120%)", boxShadow: "0 8px 24px color-mix(in srgb, var(--ink) 12%, transparent)", display: "flex", alignItems: "center", gap: 9, zIndex: 4 }}>
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 999, background: ontologyGraphTone(inspected.tone).color }} />
            <strong style={{ fontSize: 11.5 }}>{inspected.label}</strong>
            <span style={{ color: "var(--muted-deep)", fontSize: 10.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {inspected.detail}</span>
            <span style={{ marginLeft: "auto", minWidth: 26, textAlign: "center", fontSize: 11, fontWeight: 850 }}>{inspected.count}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ontologyGraphNodeIcon(id: string, size: number, color: string) {
  const props = { size, color, strokeWidth: 1.8 };
  if (id === "agent") return <IconBrain {...props} />;
  if (id === "operational" || id === "hub-op") return <IconRoute {...props} />;
  if (id === "taste" || id === "hub-taste") return <IconSparkles {...props} />;
  if (id === "tasks") return <IconTarget {...props} />;
  if (id === "evidence") return <IconCheck {...props} />;
  if (id === "mcp") return <IconLayers {...props} />;
  if (id === "safety") return <IconShield {...props} />;
  if (id === "hub") return <IconNetwork {...props} />;
  if (id === "next") return <IconArrowUp {...props} />;
  return <IconBolt {...props} />;
}

function ontologyGraphTone(tone: OntologyGraphNode["tone"]): { background: string; border: string; color: string; ring: string } {
  const values = {
    agent: { background: "var(--ink)", border: "var(--ink)", color: "var(--paper)", ring: "color-mix(in srgb, var(--ink) 18%, transparent)" },
    operational: { background: "color-mix(in srgb, var(--green-soft) 72%, var(--paper))", border: "color-mix(in srgb, var(--green-deep) 55%, var(--paper-edge))", color: "var(--green-deep)", ring: "color-mix(in srgb, var(--green-deep) 18%, transparent)" },
    taste: { background: "color-mix(in srgb, var(--amber-soft) 72%, var(--paper))", border: "color-mix(in srgb, var(--amber-deep) 48%, var(--paper-edge))", color: "var(--amber-deep)", ring: "color-mix(in srgb, var(--amber-deep) 17%, transparent)" },
    evidence: { background: "color-mix(in srgb, var(--accent-soft) 68%, var(--paper))", border: "color-mix(in srgb, var(--accent) 45%, var(--paper-edge))", color: "var(--accent)", ring: "color-mix(in srgb, var(--accent) 16%, transparent)" },
    safety: { background: "color-mix(in srgb, var(--red-soft) 68%, var(--paper))", border: "color-mix(in srgb, var(--red-deep) 44%, var(--paper-edge))", color: "var(--red-deep)", ring: "color-mix(in srgb, var(--red-deep) 16%, transparent)" },
    hub: { background: "var(--paper)", border: "color-mix(in srgb, var(--muted-deep) 45%, var(--paper-edge))", color: "var(--ink-soft)", ring: "color-mix(in srgb, var(--muted-deep) 16%, transparent)" },
  } as const;
  return values[tone];
}

export function AgentHubOntologyProjectionView({
  result,
  loading,
  error,
  locale,
  onRefresh,
}: {
  result: AgentOntologyHubProjection | null;
  loading: boolean;
  error: string;
  locale: Locale;
  onRefresh: () => void;
}) {
  const ko = locale === "ko";
  if (!result && loading) {
    return <InsightNotice text={ko ? "Hub 장착 상태를 확인하는 중…" : "Loading the Hub loadout…"} />;
  }
  if (!result) {
    return <InsightNotice error text={error || (ko ? "Hub 장착 상태를 불러오지 못했습니다." : "The Hub loadout is unavailable.")} />;
  }

  const projection = result.projection;
  const chips = new Map<string, MobileBridgeOntologyChipDto>(
    [...(projection?.operationalChips ?? []), ...(projection?.tasteChips ?? [])]
      .map((chip) => [chip.chipId, chip]),
  );
  const state = projection?.state ?? result.status;
  const status = ontologyProjectionStatus(state, ko);
  const hubStatus = ontologyProjectionStatus(result.status, ko);
  const activeCount = projection?.loadout.entries.length ?? 0;
  const scheduledCount = projection?.scheduledNextSession?.entries.length ?? 0;
  const approvalCount = projection?.pendingAttachApprovals.length ?? 0;
  const attachmentSummary = projection
    ? (ko
      ? `현재 ${activeCount}개 사용 중${scheduledCount > 0 ? ` · 새로 시작하는 대화부터 ${scheduledCount}개 적용 예정` : ""}${approvalCount > 0 ? ` · 내 확인 필요 ${approvalCount}개` : ""}`
      : `${activeCount} in use now${scheduledCount > 0 ? ` · ${scheduledCount} set for new conversations` : ""}${approvalCount > 0 ? ` · ${approvalCount} awaiting your review` : ""}`)
    : (ko ? "아직 이 에이전트에 연결된 경험칩이 없습니다." : "No Experience Chips are connected to this agent yet.");

  return (
    <section
      data-testid="agent-hub-ontology-projection"
      data-projection-status={state}
      data-hub-status={result.status}
      style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{ko ? "장착된 경험칩" : "Attached experience chips"}</h3>
            <span style={{ padding: "3px 7px", borderRadius: 999, background: status.background, color: status.color, fontSize: 10.5, fontWeight: 700 }}>
              {status.label}
            </span>
            {result.status !== state && (
              <span style={{ padding: "3px 7px", borderRadius: 999, background: hubStatus.background, color: hubStatus.color, fontSize: 10.5, fontWeight: 700 }}>
                {hubStatus.label}
              </span>
            )}
          </div>
          <p style={{ margin: "6px 0 0", color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.5 }}>{attachmentSummary}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label={loading ? (ko ? "Hub 상태 확인 중" : "Refreshing Hub status") : (ko ? "Hub 상태 새로고침" : "Refresh Hub status")}
          title={loading ? (ko ? "확인 중" : "Refreshing") : (ko ? "Hub 상태 새로고침" : "Refresh Hub status")}
          style={{ ...ontologySecondaryButtonStyle, width: 34, height: 34, padding: 0, display: "grid", placeItems: "center", opacity: loading ? 0.55 : 1 }}
        >
          <IconRefresh size={14} />
        </button>
      </div>

      {error && <div role="alert" style={{ marginTop: 10, color: "var(--red-deep)", fontSize: 11 }}>{error}</div>}

      <details data-testid="ontology-hub-details" style={{ marginTop: 12 }}>
        <summary style={{ listStyle: "none", cursor: "pointer", minHeight: 44, padding: "7px 9px", border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper-2)", display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 10.5, color: "var(--ink-soft)" }}>
          <span aria-hidden="true" style={{ width: 27, height: 27, display: "grid", placeItems: "center", borderRadius: 9, background: "var(--paper)", color: "var(--accent)" }}><IconLayers size={13} /></span>
          <strong style={{ color: "var(--ink)" }}>{ko ? "자세히 보기" : "View details"}</strong>
          <span style={ontologyCompactMetricStyle}>{ko ? `현재 사용 중 ${activeCount}` : `In use ${activeCount}`}</span>
          {scheduledCount > 0 && <span style={ontologyCompactMetricStyle}>{ko ? `새 대화부터 ${scheduledCount}` : `New conversations ${scheduledCount}`}</span>}
          {approvalCount > 0 && <span style={ontologyCompactMetricStyle}>{ko ? `내 확인 필요 ${approvalCount}` : `Needs review ${approvalCount}`}</span>}
          <span aria-hidden="true" style={{ marginLeft: "auto", width: 7, height: 7, borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", transform: "rotate(45deg) translateY(-2px)" }} />
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
          {result.binding ? (
            <div data-testid="ontology-exact-binding" role="status" style={{ padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 9, color: "var(--green-deep)", background: "var(--green-soft)", fontSize: 11.5, lineHeight: 1.55 }}>
              {ko ? "이 에이전트에서 사용할 수 있는 경험칩입니다." : "These Experience Chips can be used with this agent."}
            </div>
          ) : (
            <div role="status" style={{ padding: 12, border: "1px dashed var(--paper-edge)", borderRadius: 9, color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.55 }}>
              {result.status === "binding-changed"
                ? (ko ? "확인하는 동안 연결 상태가 바뀌었습니다. 다시 새로고침하세요." : "The connection changed during refresh. Please refresh again.")
                : (ko ? "이 에이전트는 아직 Hub 경험과 연결되지 않았습니다." : "This agent is not connected to Hub experience yet.")}
            </div>
          )}

        {projection ? (
          <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            <OntologyChipList
              testId="ontology-operational-chips"
              title={ko ? "문제 해결 경험" : "Problem-solving experience"}
              description={ko ? "이 에이전트가 잘 해결했던 방법과 복구 순서" : "Methods and recovery steps this agent handled well"}
              chips={projection.operationalChips}
              locale={locale}
            />
            <OntologyChipList
              testId="ontology-taste-chips"
              title={ko ? "취향·스타일" : "Taste and style"}
              description={ko ? "내가 선택한 결과에서 확인된 공통 취향" : "Preferences confirmed from the results I chose"}
              chips={projection.tasteChips}
              locale={locale}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            <LoadoutCard
              testId="ontology-active-loadout"
              title={ko ? "현재 대화에서 사용 중" : "In use in the current conversation"}
              state={projection.loadout.state}
              entries={projection.loadout.entries}
              chips={chips}
              empty={ko ? "현재 장착된 칩이 없습니다." : "No chips are active."}
              locale={locale}
            />
            <LoadoutCard
              testId="ontology-next-session"
              title={ko ? "새로 시작하는 대화부터 적용" : "Applies to newly started conversations"}
              state={projection.scheduledNextSession?.state ?? "none"}
              entries={projection.scheduledNextSession?.entries ?? []}
              chips={chips}
              empty={ko ? "새 대화에 적용할 변경이 없습니다." : "No change is set for new conversations."}
              locale={locale}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            <section data-testid="ontology-pending-approvals" style={ontologySubsectionStyle}>
              <h4 style={ontologyHeadingStyle}>{ko ? "내 확인이 필요한 변경" : "Changes awaiting my review"} · {projection.pendingAttachApprovals.length}</h4>
              {projection.pendingAttachApprovals.length > 0 ? projection.pendingAttachApprovals.map((approval) => (
                <div key={approval.approvalId} style={ontologyRowStyle}>
                  <strong style={{ fontSize: 11.5 }}>{ko ? "적용할지 직접 확인해 주세요" : "Choose whether to apply this change"}</strong>
                  <span style={ontologyMetaStyle}>{ko ? "확인 가능 기한" : "Review by"} {formatOntologyTime(approval.expiresAt, locale)}</span>
                  <LoadoutEntries entries={approval.selectedChips} chips={chips} locale={locale} />
                </div>
              )) : <EmptyOntologyText text={ko ? "대기 중인 승인 요청이 없습니다." : "No approval is pending."} />}
            </section>

            <section data-testid="ontology-recommendations" style={ontologySubsectionStyle}>
              <h4 style={ontologyHeadingStyle}>{ko ? "추천 경험칩" : "Recommended Experience Chips"} · {projection.recommendations.length}</h4>
              {projection.recommendations.length > 0 ? projection.recommendations.map((recommendation) => (
                <div key={recommendation.recommendationId} style={ontologyRowStyle}>
                  <strong style={{ fontSize: 11.5 }}>{recommendation.summary}</strong>
                  <span style={ontologyMetaStyle}>{ko ? "추천 확인 가능 기한" : "Recommendation available until"} {formatOntologyTime(recommendation.expiresAt, locale)}</span>
                  {recommendation.reasons.length > 0 && <SmallOntologyList title={ko ? "추천 이유" : "Why"} items={recommendation.reasons} />}
                  {recommendation.tradeoffs.length > 0 && <SmallOntologyList title={ko ? "고려사항" : "Trade-offs"} items={recommendation.tradeoffs} />}
                  <LoadoutEntries entries={recommendation.proposedChips} chips={chips} locale={locale} />
                </div>
              )) : <EmptyOntologyText text={ko ? "현재 추천이 없습니다." : "No recommendation is available."} />}
            </section>
          </div>

          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.5 }}>
            {ko
              ? `마지막 확인 ${formatOntologyTime(projection.generatedAt, locale)} · 추천은 내가 확인하기 전에는 적용되지 않습니다.`
              : `Last checked ${formatOntologyTime(projection.generatedAt, locale)} · Recommendations do not apply until I review them.`}
          </p>
          </>
      ) : result.binding ? (
        <div role="status" style={{ padding: 12, border: "1px dashed var(--paper-edge)", borderRadius: 9, color: "var(--muted-deep)", fontSize: 11.5 }}>
          {ontologyProjectionEmptyMessage(result.status, ko)}
        </div>
      ) : null}
        </div>
      </details>
    </section>
  );
}

function OntologyChipList({ testId, title, description, chips, locale }: {
  testId: string;
  title: string;
  description: string;
  chips: MobileBridgeOntologyChipDto[];
  locale: Locale;
}) {
  return (
    <section data-testid={testId} style={ontologySubsectionStyle}>
      <h4 style={ontologyHeadingStyle}>{title} · {chips.length}</h4>
      <p style={{ margin: "-3px 0 8px", color: "var(--muted-deep)", fontSize: 10.5 }}>{description}</p>
      {chips.length > 0 ? chips.map((chip) => (
        <div key={`${chip.chipId}:${chip.releaseId}`} style={ontologyRowStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 11.5 }}>{chip.displayName}</strong>
            <span style={{ ...ontologyMetaStyle, flexShrink: 0 }}>{verificationLabel(chip.verification, locale)}</span>
          </div>
          <span style={{ color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.45 }}>{chip.summary}</span>
          <span style={ontologyMetaStyle}>{locale === "ko" ? "확인 자료" : "Supporting checks"} {chip.evidenceCount}</span>
          {chip.labels.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{chip.labels.map((label) => <span key={label} style={ontologyTagStyle}>{label}</span>)}</div>}
        </div>
      )) : <EmptyOntologyText text={locale === "ko" ? "표시할 칩이 없습니다." : "No chips to show."} />}
    </section>
  );
}

function LoadoutCard({ testId, title, state, entries, chips, empty, locale }: {
  testId: string;
  title: string;
  state: string;
  entries: MobileBridgeOntologyLoadoutEntryDto[];
  chips: Map<string, MobileBridgeOntologyChipDto>;
  empty: string;
  locale: Locale;
}) {
  return (
    <section data-testid={testId} data-loadout-state={state} style={ontologySubsectionStyle}>
      <h4 style={ontologyHeadingStyle}>{title}</h4>
      {entries.length > 0 ? <LoadoutEntries entries={entries} chips={chips} locale={locale} /> : <EmptyOntologyText text={empty} />}
    </section>
  );
}

function LoadoutEntries({ entries, chips, locale }: {
  entries: MobileBridgeOntologyLoadoutEntryDto[];
  chips: Map<string, MobileBridgeOntologyChipDto>;
  locale: Locale;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
      {entries.map((entry) => (
        <div key={`${entry.kind}:${entry.chipId}:${entry.releaseId}`} style={{ padding: "7px 8px", borderRadius: 7, background: "var(--paper-2)", border: "1px solid var(--paper-edge)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <strong style={{ fontSize: 11 }}>{chips.get(entry.chipId)?.displayName ?? (locale === "ko" ? "경험칩" : "Experience chip")}</strong>
            <span style={ontologyMetaStyle}>{locale === "ko" ? "사용 가능" : "Ready"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SmallOntologyList({ title, items }: { title: string; items: string[] }) {
  return <div style={{ color: "var(--ink-soft)", fontSize: 10.5, lineHeight: 1.45 }}><strong>{title}:</strong> {items.join(" · ")}</div>;
}

function EmptyOntologyText({ text }: { text: string }) {
  return <div style={{ color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.5 }}>{text}</div>;
}

function ontologyProjectionStatus(state: string, ko: boolean): { label: string; color: string; background: string } {
  if (state === "live") return { label: ko ? "Hub와 연결됨" : "Connected to Hub", color: "var(--green-deep)", background: "rgba(12,166,120,0.1)" };
  if (state === "unbound") return { label: ko ? "아직 연결 안 됨" : "Not connected yet", color: "var(--muted-deep)", background: "var(--fill-1)" };
  if (state === "revoked") return { label: ko ? "더 이상 사용 불가" : "No longer available", color: "var(--red-deep)", background: "rgba(194,74,40,0.1)" };
  if (state === "conflict" || state === "binding-changed") return { label: ko ? "다시 확인 필요" : "Needs another check", color: "var(--red-deep)", background: "rgba(194,74,40,0.1)" };
  if (state === "auth-unavailable") return { label: ko ? "Hub 로그인 필요" : "Hub sign-in required", color: "var(--peach-ink)", background: "rgba(217,119,6,0.1)" };
  if (state === "endpoint-absent") return { label: ko ? "Hub 기능 미지원" : "Hub unsupported", color: "var(--muted-deep)", background: "var(--fill-1)" };
  return { label: state === "stale" ? (ko ? "최신 상태 확인 필요" : "Needs a current check") : (ko ? "오프라인" : "Offline"), color: "var(--peach-ink)", background: "rgba(217,119,6,0.1)" };
}

function ontologyProjectionEmptyMessage(status: AgentOntologyHubProjection["status"], ko: boolean): string {
  const messages: Record<AgentOntologyHubProjection["status"], [string, string]> = {
    unbound: ["아직 이 에이전트가 Hub와 연결되지 않았습니다.", "This agent is not connected to Hub yet."],
    live: ["장착 정보를 불러오지 못했습니다. 잠시 뒤 다시 확인해 주세요.", "Attachment information is unavailable. Try again shortly."],
    offline: ["Hub에 연결할 수 없습니다. 인터넷 연결 후 다시 확인해 주세요.", "Hub is offline. Check again after reconnecting to the internet."],
    stale: ["최신 장착 상태를 확인할 수 없습니다.", "The current attachment status cannot be confirmed."],
    "auth-unavailable": ["Agentlas Hub 로그인이 필요합니다.", "Agentlas Hub sign-in is required."],
    "endpoint-absent": ["현재 Hub에서는 경험칩 장착 상태를 지원하지 않습니다.", "This Hub version does not support Experience Chip attachments."],
    "projection-missing": ["장착 정보가 응답에서 누락되었습니다. 다시 확인해 주세요.", "Attachment information was missing. Please refresh."],
    "binding-changed": ["확인하는 동안 에이전트 연결이 바뀌었습니다. 다시 확인해 주세요.", "The agent connection changed during refresh. Please check again."],
  };
  return messages[status][ko ? 0 : 1];
}

function verificationLabel(value: MobileBridgeOntologyChipDto["verification"], locale: Locale): string {
  const labels: Record<MobileBridgeOntologyChipDto["verification"], [string, string]> = {
    verified: ["안전 확인 완료", "Safety checked"],
    requested: ["안전 확인 중", "Safety check in progress"],
    unverified: ["안전 확인 필요", "Safety check needed"],
    rejected: ["공개 불가", "Not publishable"],
  };
  return labels[value][locale === "ko" ? 0 : 1];
}

function formatOntologyTime(value: string, locale: Locale): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(locale === "ko" ? "ko-KR" : "en-US") : value;
}

const ontologySubsectionStyle = {
  padding: 12,
  border: "1px solid var(--paper-edge)",
  borderRadius: 10,
  background: "var(--paper-2)",
  minWidth: 0,
};

const ontologyHeadingStyle = { margin: "0 0 8px", color: "var(--ink)", fontSize: 12.5 };
const ontologyRowStyle = { display: "flex", flexDirection: "column" as const, gap: 5, padding: 9, borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper)", marginTop: 6 };
const ontologyMetaStyle = { color: "var(--muted-deep)", fontSize: 9.5, lineHeight: 1.4 };
const ontologyTagStyle = { padding: "2px 6px", borderRadius: 999, background: "var(--fill-1)", color: "var(--muted-deep)", fontSize: 9.5, lineHeight: 1.4 };
const ontologySecondaryButtonStyle = { padding: "7px 10px", borderRadius: 7, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 11, fontWeight: 700, cursor: "pointer" };
const ontologyCompactMetricStyle = { display: "inline-flex", alignItems: "center", gap: 4, minHeight: 24, padding: "2px 7px", borderRadius: 999, background: "var(--paper)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 9.5, fontWeight: 750 };
const ontologyGraphToolButtonStyle = { width: 28, height: 28, padding: 0, border: 0, background: "transparent", color: "var(--ink-soft)", display: "grid", placeItems: "center", cursor: "pointer" };
const visuallyHiddenStyle: React.CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 };

function experienceIntakeReasonLabel(code: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    "local-path-or-url": ["개인 경로 또는 URL 감지", "Private path or URL detected"],
    email: ["이메일 주소 감지", "Email address detected"],
    "phone-or-long-number": ["전화번호 또는 긴 번호 감지", "Phone number or long identifier detected"],
    "account-identifier": ["계정·고객 식별자 감지", "Account or customer identifier detected"],
    "opaque-identifier": ["범용화되지 않은 식별자 감지", "Opaque non-portable identifier detected"],
    "secret-value": ["키·토큰 등 비밀값 감지", "Secret or token detected"],
    "sensitive-memory": ["기밀 메모리", "Confidential memory"],
    "unsupported-sensitivity": ["분류되지 않은 민감도", "Unsupported sensitivity label"],
    "preference-requires-taste-evidence": ["취향 메모리 · Taste 칩 A/B 근거 필요", "Preference memory · Taste chip needs A/B evidence"],
    "preference-captured-as-private-taste-draft": ["Taste 비공개 후보로 분리 · 사람 근거 필요", "Separated into a private Taste draft · human evidence required"],
    "non-operational-memory-kind": ["범용 실행 경험이 아닌 메모리", "Memory is not operational experience"],
    "task-taxonomy-unavailable": ["적용 작업을 아직 분류할 수 없음", "Task could not be classified yet"],
    "exact-base-unavailable": ["에이전트 기준 버전 확인 필요", "Exact agent base version unavailable"],
    "environment-taxonomy-unavailable": ["실행 환경 확인 필요", "Execution environment unavailable"],
    "raw-prompt-or-transcript": ["프롬프트·대화 원문 감지", "Raw prompt or transcript detected"],
  };
  const pair = labels[code];
  return pair ? pair[locale === "ko" ? 0 : 1] : code;
}

function StatusChip({ tone, label }: { tone: "safe" | "blocked" | "skipped"; label: string }) {
  const colors = tone === "safe"
    ? { background: "rgba(12,166,120,0.1)", color: "var(--green-deep)" }
    : tone === "blocked"
      ? { background: "rgba(194,74,40,0.1)", color: "var(--red-deep)" }
      : { background: "var(--fill-1)", color: "var(--muted-deep)" };
  return <span data-intake-state={tone} style={{ ...colors, padding: "3px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>{label}</span>;
}

function InsightNotice({ text, error = false }: { text: string; error?: boolean }) {
  return <div role={error ? "alert" : "status"} style={{ padding: 14, border: `1px ${error ? "solid" : "dashed"} var(--paper-edge)`, borderRadius: 9, color: error ? "var(--red-deep)" : "var(--muted-deep)", background: "var(--paper)", fontSize: 12 }}>{text}</div>;
}

const metricCardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
  padding: 11,
  border: "1px solid var(--paper-edge)",
  borderRadius: 9,
  background: "var(--paper-2)",
};

const iconButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  padding: 0,
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  cursor: "pointer",
};

// 보기 상태에서는 별도 버튼처럼 보이지 않고 이름 옆의 작은 연필만 남긴다.
// 편집 상태의 저장/취소 조작은 위 iconButtonStyle을 유지해 클릭 결과를 분명히 한다.
const pencilIconStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  padding: 0,
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--muted-deep)",
  cursor: "pointer",
};
