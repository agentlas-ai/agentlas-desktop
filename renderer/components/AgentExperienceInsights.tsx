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
  AgentOntologyAttachDecisionResult,
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
    [locale === "ko" ? "경험 칩" : "Chips", summary.packCount],
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

export function AgentHubOntologyProjectionView({
  result,
  loading,
  error,
  locale,
  onRefresh,
  onResolveApproval,
}: {
  result: AgentOntologyHubProjection | null;
  loading: boolean;
  error: string;
  locale: Locale;
  onRefresh: () => void;
  onResolveApproval: (approvalId: string, decision: "approve" | "deny") => Promise<AgentOntologyAttachDecisionResult>;
}) {
  const ko = locale === "ko";
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    setResolvingApprovalId(null);
    setAttachmentNotice(null);
  }, [result?.binding?.agentDefinitionId, result?.binding?.agentReleaseId]);

  async function resolveApproval(approvalId: string, decision: "approve" | "deny") {
    if (resolvingApprovalId) return;
    setResolvingApprovalId(approvalId);
    setAttachmentNotice(null);
    try {
      const resolved = await onResolveApproval(approvalId, decision);
      const successful = resolved.outcome === "accepted" || resolved.outcome === "denied" || resolved.outcome === "already-resolved";
      setAttachmentNotice({
        tone: successful ? "ok" : "error",
        text: ontologyAttachOutcomeMessage(resolved.outcome, ko),
      });
    } catch {
      setAttachmentNotice({
        tone: "error",
        text: ko ? "장착 상태가 바뀌었습니다. 새로고침한 뒤 다시 확인해 주세요." : "The attachment state changed. Refresh and review it again.",
      });
    } finally {
      setResolvingApprovalId(null);
    }
  }
  if (!result && loading) {
    return <InsightNotice text={ko ? "Hub 장착 상태를 확인하는 중…" : "Loading equipped chips…"} />;
  }
  if (!result) {
    return <InsightNotice error text={error || (ko ? "Hub 장착 상태를 불러오지 못했습니다." : "Equipped chip status is unavailable.")} />;
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
            <h3 style={{ margin: 0, fontSize: 15 }}>{ko ? "이 에이전트의 경험칩" : "This agent's Experience Chips"}</h3>
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
              {attachmentNotice && (
                <div
                  data-testid="ontology-attach-notice"
                  role={attachmentNotice.tone === "error" ? "alert" : "status"}
                  style={{ marginBottom: 8, padding: "8px 9px", borderRadius: 8, color: attachmentNotice.tone === "error" ? "var(--red-deep)" : "var(--green-deep)", background: attachmentNotice.tone === "error" ? "rgba(194,74,40,0.08)" : "var(--green-soft)", fontSize: 10.5, lineHeight: 1.5 }}
                >
                  {attachmentNotice.text}
                </div>
              )}
              {projection.pendingAttachApprovals.length > 0 ? projection.pendingAttachApprovals.map((approval) => (
                <div key={approval.approvalId} style={ontologyRowStyle}>
                  <strong style={{ fontSize: 11.5 }}>{ko ? "적용할지 직접 확인해 주세요" : "Choose whether to apply this change"}</strong>
                  <span style={{ color: "var(--ink-soft)", fontSize: 10.5, lineHeight: 1.45 }}>
                    {ko ? "적용해도 지금 대화는 바뀌지 않고, 새로 시작하는 대화부터 사용됩니다." : "Your current conversation stays unchanged; the chip starts with newly created conversations."}
                  </span>
                  <span style={ontologyMetaStyle}>{ko ? "확인 가능 기한" : "Review by"} {formatOntologyTime(approval.expiresAt, locale)}</span>
                  <LoadoutEntries entries={approval.selectedChips} chips={chips} locale={locale} />
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 5 }}>
                    <button
                      type="button"
                      disabled={Boolean(resolvingApprovalId)}
                      onClick={() => void resolveApproval(approval.approvalId, "approve")}
                      style={{ ...ontologyPrimaryButtonStyle, opacity: resolvingApprovalId ? 0.55 : 1, cursor: resolvingApprovalId ? "wait" : "pointer" }}
                    >
                      {resolvingApprovalId === approval.approvalId
                        ? (ko ? "확인 중…" : "Applying…")
                        : (ko ? "새 대화부터 적용" : "Apply to new conversations")}
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(resolvingApprovalId)}
                      onClick={() => void resolveApproval(approval.approvalId, "deny")}
                      style={{ ...ontologySecondaryButtonStyle, opacity: resolvingApprovalId ? 0.55 : 1, cursor: resolvingApprovalId ? "wait" : "pointer" }}
                    >
                      {ko ? "이번엔 적용 안 함" : "Not this time"}
                    </button>
                  </div>
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

function ontologyAttachOutcomeMessage(outcome: AgentOntologyAttachDecisionResult["outcome"], ko: boolean): string {
  const messages: Record<AgentOntologyAttachDecisionResult["outcome"], [string, string]> = {
    accepted: ["장착했습니다. 새로 시작하는 대화부터 사용됩니다.", "Attached. It will be used in newly created conversations."],
    denied: ["이번에는 적용하지 않았습니다.", "This change was not applied."],
    "already-resolved": ["이미 처리된 요청입니다. 최신 상태로 다시 확인했습니다.", "This request was already resolved. The latest state is shown."],
    offline: ["Hub에 연결되지 않아 적용하지 못했습니다.", "The change was not applied because Hub is offline."],
    stale: ["장착 정보가 오래되어 적용하지 않았습니다. 다시 확인해 주세요.", "The attachment state was stale, so nothing changed. Please review it again."],
    conflict: ["장착 상태가 바뀌어 적용하지 않았습니다. 다시 확인해 주세요.", "The equipped chips changed, so nothing was applied. Please review it again."],
    revoked: ["더 이상 사용할 수 없는 경험칩이라 적용하지 않았습니다.", "This Experience Chip is no longer available and was not applied."],
    "outcome-unknown": ["처리 결과를 확인하지 못했습니다. 중복 적용하지 말고 먼저 새로고침해 주세요.", "The outcome is unknown. Refresh before trying again to avoid a duplicate action."],
  };
  return messages[outcome][ko ? 0 : 1];
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
          <span style={ontologyMetaStyle}>{locale === "ko" ? `효과 확인 기록 ${chip.evidenceCount}개` : `${chip.evidenceCount} outcome checks`}</span>
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
const ontologySecondaryButtonStyle = { padding: "7px 10px", borderRadius: 7, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 11, fontWeight: 700, cursor: "pointer" };
const ontologyPrimaryButtonStyle = { padding: "8px 11px", borderRadius: 7, border: "1px solid var(--green-deep)", background: "var(--green-deep)", color: "white", fontSize: 11, fontWeight: 750, cursor: "pointer" };
const ontologyCompactMetricStyle = { display: "inline-flex", alignItems: "center", gap: 4, minHeight: 24, padding: "2px 7px", borderRadius: 999, background: "var(--paper)", border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 9.5, fontWeight: 750 };

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
