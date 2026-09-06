// 에이전트 라이브러리 — 로스터, 큐레이팅 메모리, 승인형 자산 진화, Experience/Ontology 관리.
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { ipc } from "@/lib/ipc";
import { mapWithConcurrency } from "@/lib/concurrency";
import { isUserFacingAgentText } from "@/lib/agent-visibility";
import { buildAgentRoster, isRosterVisibleAgent, visibleRosterAgents } from "@/lib/agent-roster";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { AgentMemorySaveQueue, parseMemoryMarkdown, type ParsedMemory } from "@/lib/agent-memory";
import { cliModelTagLabel, runtimeUsesEngineModelSetting } from "@shared/models";
import { runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
import {
  projectPoolMemberKey,
  projectPoolMemberReferences,
  type ProjectPoolReferenceSet,
} from "@shared/project-agent-pool";
import {
  firmPoolMember,
  installedAgentPoolMember,
  installedTeamPoolMember,
} from "@/lib/project-agent-roster";
import type {
  AgentEvolutionProposalUi,
  AgentLearningSummary,
  AgentMemoryEntryUi,
  AgentOntologyHubProjection,
  ExperienceOntologyGraphSnapshot,
  ExperienceOntologySummary,
  LocalTasteDraftRecord,
  MemoryImportPreviewUi,
  MemoryImportResultUi,
  OperationalPublicProjectionRecord,
  TasteChipWorkflowRecord,
  TasteAxis,
  TastePreviewRights,
} from "@shared/types";
import type {
  AgentRuntimeOverride,
  AgentRuntimeOverrideScope,
  AgentUsageSummaryRow,
  BorrowedAgentProfile,
  Chat,
  ExperienceCandidateRecord,
  ExperienceCloudUploadRecord,
  ExperienceExportIntentRecord,
  ExperiencePackRecord,
  ExperiencePromotionReceipt,
  FsPathGrant,
  InstalledAgent,
  InstalledAgentExactBinding,
  InstalledFirm,
  MarketplaceListing,
  Project,
  ResolvedOrg,
  ResolvedNode,
  RuntimeSelection,
  RuntimeStatus,
  WorkspaceNode,
} from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentFileEditor } from "@/components/AgentFileEditor";
import {
  AgentLearningMetricGrid,
  AgentNameEditor,
  AgentHubOntologyProjectionView,
  AgentOntologyGraphView,
  ExperienceOntologySummaryView,
  agentDisplayName,
} from "@/components/AgentExperienceInsights";
import { ExperienceProfileCard } from "@/components/ExperienceProfileCard";
import {
  AgentLearningHistory,
  confidenceLabel,
  memoryKindLabel,
  type AgentLearningEvent,
} from "@/components/AgentLearningHistory";
import { buildMemoryLearningEvent, formatLearningTime, simpleMemorySummary } from "@/lib/agent-learning-copy";
import {
  IconBuilding,
  IconChat,
  IconChevronRight,
  IconChevronDown,
  IconSidebar,
  IconBrain,
  IconShield,
  IconCheck,
  IconWand,
  IconLayers,
  IconEdit,
  IconClose,
  IconPlus,
  IconFileUp,
  IconPaperclip,
  IconRoute,
  IconSearch,
} from "@/components/Icon";

type ManageView = "general" | "published";

function projectPoolHasTarget(
  project: Project | null,
  entityKind: "agent" | "team",
  localTargetId: string | null | undefined,
): boolean {
  if (!localTargetId) return false;
  return Boolean(project?.agentPool.some((member) => entityKind === "team"
    ? member.entityKind === "team" && member.firmId === localTargetId
    : member.entityKind === "agent" && member.agentId === localTargetId));
}

/**
 * Which projects a removal actually touches.
 *
 * The confirm dialog used to count only local rows (`member.agentId`,
 * `member.firmId`), so deleting an asset the user had staged from Cloud or Hub
 * promised "0 projects affected" and then left the row behind. The store owns
 * the detach now; this shares its predicate so the warning tells the truth.
 */
function projectsReferencing(projects: Project[], refs: ProjectPoolReferenceSet): Project[] {
  return projects.filter((project) => project.agentPool.some((member) => projectPoolMemberReferences(member, refs)));
}

function removalReferenceSet(input: {
  agentIds?: Array<string | null | undefined>;
  firmIds?: Array<string | null | undefined>;
  remoteTargetIds?: Array<string | null | undefined>;
}): ProjectPoolReferenceSet {
  const clean = (values: Array<string | null | undefined> | undefined) =>
    new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean));
  return {
    agentIds: clean(input.agentIds),
    firmIds: clean(input.firmIds),
    remoteTargetIds: new Set([...clean(input.remoteTargetIds)].map((value) => value.toLowerCase())),
  };
}

function ProjectAttachControl({
  projects,
  projectId,
  entityKind,
  localTargetId,
  locale,
  disabled,
  onProjectChange,
  onAttach,
}: {
  projects: Project[];
  projectId: string;
  entityKind: "agent" | "team";
  localTargetId: string | null | undefined;
  locale: Locale;
  disabled?: boolean;
  onProjectChange: (projectId: string) => void;
  onAttach: () => void;
}) {
  const selected = projects.find((project) => project.id === projectId) ?? null;
  const attached = projectPoolHasTarget(selected, entityKind, localTargetId);
  const ko = locale === "ko";
  if (projects.length === 0) {
    return (
      <button type="button" onClick={() => navigate("/project/new")} className="agent-run-button">
        {ko ? "프로젝트를 먼저 만들기" : "Create a project first"}
      </button>
    );
  }
  return (
    <div className="project-attach-control" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <label className="project-attach-label" style={{ fontSize: 11.5, color: "var(--muted-deep)", whiteSpace: "nowrap" }}>
        {ko ? "장착할 프로젝트" : "Attach to project"}
      </label>
      <select
        aria-label={ko ? "장착할 프로젝트" : "Project to attach to"}
        value={projectId}
        onChange={(event) => onProjectChange(event.target.value)}
        style={{ minWidth: 150, maxWidth: 240, height: 44, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", padding: "0 32px 0 11px", fontSize: 12 }}
      >
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <button
        type="button"
        className="agent-run-button"
        onClick={onAttach}
        disabled={disabled || attached}
        title={attached ? (ko ? "이미 이 프로젝트의 도구함에 있습니다." : "Already in this project's tool pool.") : undefined}
        style={{ opacity: disabled || attached ? 0.55 : 1 }}
      >
        {attached ? (ko ? "장착됨" : "Attached") : (ko ? "프로젝트에 장착" : "Attach to project")}
      </button>
    </div>
  );
}

const rosterNameStyle: CSSProperties = {
  display: "-webkit-box",
  overflow: "hidden",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  lineHeight: 1.22,
};

/** v74 사용 원장 배지 — 사용함 / 자주 씀. 사용 이력이 없으면 아무것도 그리지 않는다. */
function RosterUsageBadge({ usage, frequent, locale }: {
  usage: AgentUsageSummaryRow | undefined;
  frequent: boolean;
  locale: "ko" | "en";
}) {
  if (!usage || usage.useCount <= 0) return null;
  return (
    <span
      data-usage-badge={frequent ? "frequent" : "used"}
      title={locale === "ko" ? `사용 ${usage.useCount}회` : `Used ${usage.useCount} times`}
      style={{
        flexShrink: 0,
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 750,
        color: frequent ? "var(--accent)" : "var(--muted-deep)",
        background: frequent ? "var(--accent-soft)" : "var(--fill-1)",
      }}
    >
      {/* 이름을 밀어내지 않도록 낱말 대신 사용 횟수만 — 뜻은 위 title 에 있다. */}
      {usage.useCount}
    </span>
  );
}

function readableRoleLabel(role: string | undefined, displayName: string, agentSlug?: string): string | null {
  const label = role?.trim();
  if (!label) return null;
  const normalized = label.toLowerCase();
  if (normalized === displayName.trim().toLowerCase()) return null;
  if (agentSlug && normalized === agentSlug.toLowerCase()) return null;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(normalized)) return null;
  return label;
}

// 프롬프트 진화 후보로 승격 가능한 DB kind — 규칙성 있는 학습만(사실/가설 제외).
const EVOLUTION_CANDIDATE_KINDS = new Set(["decision", "gotcha", "procedure"]);

/**
 * Phase 1b · "기존 메모리 가져오기 / Import existing memory".
 * 레거시 마크다운 폴더/파일을 골라 어느 멤버·kind로 들어갈지 미리보기(dry-run) 후
 * 적용한다. 원본 경로는 main에서만 다루고, 결과는 N건 이관·임베딩 카드로 보인다.
 */
function MemoryImportPanel({
  agentId,
  locale,
  showToast,
}: {
  agentId: string;
  locale: Locale;
  showToast: (msg: string) => void;
}) {
  const ko = locale === "ko";
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MemoryImportPreviewUi | null>(null);
  const [result, setResult] = useState<MemoryImportResultUi | null>(null);

  const runPreview = useCallback(async () => {
    const api = ipc();
    if (!api?.agentMemory?.importPreview) return;
    setBusy(true);
    setResult(null);
    try {
      const next = await api.agentMemory.importPreview(agentId);
      setPreview(next ?? null);
      if (!next) showToast(ko ? "가져오기를 취소했습니다." : "Import cancelled.");
      else if (next.summary.total === 0) {
        showToast(ko ? "가져올 메모리를 찾지 못했습니다." : "No importable memory found in that folder.");
      }
    } catch (error) {
      showToast((ko ? "미리보기 실패: " : "Preview failed: ") + String(error));
    } finally {
      setBusy(false);
    }
  }, [agentId, ko, showToast]);

  const runApply = useCallback(async () => {
    const api = ipc();
    if (!api?.agentMemory?.importApply || !preview) return;
    setBusy(true);
    try {
      const applied = await api.agentMemory.importApply(agentId, preview.sourcePath);
      setResult(applied);
      setPreview(null);
      showToast(
        ko
          ? `메모리 ${applied.imported}건을 가져왔습니다 (임베딩 ${applied.embedded}건).`
          : `Imported ${applied.imported} memories (${applied.embedded} embedded).`,
      );
    } catch (error) {
      showToast((ko ? "가져오기 실패: " : "Import failed: ") + String(error));
    } finally {
      setBusy(false);
    }
  }, [agentId, ko, preview, showToast]);

  return (
    <div style={{ border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 14, background: "var(--paper)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <IconFileUp size={15} style={{ color: "var(--accent)" }} />
        <strong style={{ fontSize: 13 }}>{ko ? "기존 메모리 가져오기" : "Import existing memory"}</strong>
      </div>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--ink-soft)" }}>
        {ko
              ? "재사용 가능한 규칙·절차가 담긴 레거시 마크다운만 이 도구의 로컬 기억 후보로 옮깁니다. 프로젝트 상태는 해당 프로젝트에 남겨야 합니다. 먼저 대상과 개인정보 제외 내역을 미리 보여주고 확인 후 저장합니다."
              : "Move only reusable rules and procedures from legacy markdown into this tool's local memory candidates. Project state must remain with its project. Preview destinations and privacy exclusions before saving."}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={runPreview}
          disabled={busy}
          style={{ padding: "6px 12px", background: "var(--accent)", color: "var(--white)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
        >
          {ko ? "폴더 선택 & 미리보기" : "Choose folder & preview"}
        </button>
        {preview && preview.summary.newCount > 0 && (
          <button
            onClick={runApply}
            disabled={busy}
            style={{ padding: "6px 12px", background: "var(--green-deep)", color: "var(--white)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {ko ? `${preview.summary.newCount}건 가져오기` : `Import ${preview.summary.newCount}`}
          </button>
        )}
      </div>

      {preview && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)", marginBottom: 6 }}>
            {ko
              ? `총 ${preview.summary.total} · 새로 ${preview.summary.newCount} · 중복 ${preview.summary.duplicateCount} · 민감정보 제외 ${preview.summary.redactedCount}`
              : `Total ${preview.summary.total} · new ${preview.summary.newCount} · duplicate ${preview.summary.duplicateCount} · redacted ${preview.summary.redactedCount}`}
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--paper-edge)", borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted-deep)" }}>
                  <th style={{ padding: "5px 8px" }}>{ko ? "대상" : "Owner"}</th>
                  <th style={{ padding: "5px 8px" }}>{ko ? "종류" : "Kind"}</th>
                  <th style={{ padding: "5px 8px" }}>{ko ? "섹션" : "Section"}</th>
                  <th style={{ padding: "5px 8px" }}>{ko ? "상태" : "Status"}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((row, index) => (
                  <tr key={`${row.file}-${index}`} style={{ borderTop: "1px solid var(--paper-edge)" }}>
                    <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{row.ownerLabel}</td>
                    <td style={{ padding: "5px 8px", color: "var(--accent)" }}>{row.kind}</td>
                    <td style={{ padding: "5px 8px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.section}>{row.section}</td>
                    <td style={{ padding: "5px 8px", color: row.status === "new" ? "var(--green-deep)" : "var(--muted)" }}>
                      {row.status === "new" ? (ko ? "새로" : "new") : row.status === "duplicate" ? (ko ? "중복" : "dup") : (ko ? "제외" : "skip")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, padding: 10, background: "var(--fill-1)", borderRadius: 6, fontSize: 12 }}>
          <strong>{ko ? "가져오기 완료" : "Import complete"}</strong>
          <div style={{ marginTop: 4, color: "var(--ink-soft)" }}>
            {ko
              ? `${result.imported}건 저장 · 임베딩 ${result.embedded} · 경험 반영 ${result.intakeAttempted} · 중복 건너뜀 ${result.skippedDuplicate}`
              : `${result.imported} stored · ${result.embedded} embedded · ${result.intakeAttempted} to experience · ${result.skippedDuplicate} duplicates skipped`}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LibraryAgentsPage() {
  return (
    <Suspense fallback={null}>
      <LibraryAgentsView />
    </Suspense>
  );
}

function LibraryAgentsView() {
  
  const { t, locale } = useT();
  const searchParams = useSearchParams();
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [firmCollapsed, setFirmCollapsed] = useState<Record<string, boolean>>({});
  const [teamExpanded, setTeamExpanded] = useState<Record<string, boolean>>({});
  const [teamSubs, setTeamSubs] = useState<Record<string, { name: string; role: string }[] | "loading">>({});
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const rosterRefreshGenerationRef = useRef(0);
  const [chats, setChats] = useState<Chat[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [resolvedOrgs, setResolvedOrgs] = useState<Record<string, ResolvedOrg>>({});
  const [runtimeStatuses, setRuntimeStatuses] = useState<RuntimeStatus[]>([]);
  const [runtimeOverrides, setRuntimeOverrides] = useState<AgentRuntimeOverride[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [exactBindings, setExactBindings] = useState<InstalledAgentExactBinding[]>([]);
  // v74 사용 원장(run 귀속 집계) — 로스터 섹션/배지의 데이터 소스.
  const [usageRows, setUsageRows] = useState<AgentUsageSummaryRow[]>([]);
  const [borrowedProfiles, setBorrowedProfiles] = useState<BorrowedAgentProfile[]>([]);
  // 북마크 토글의 낙관적 오버라이드(진실은 refresh로 재수렴).
  const [bookmarkOverrides, setBookmarkOverrides] = useState<Record<string, boolean>>({});

  // 왼쪽 조직도 패널 너비 & 접기 상태 (localStorage 영속)
  const [orgWidth, setOrgWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 좌측 로스터 탭 — 멀티(에이전트 팀=firm) / 싱글(개별 에이전트). 대시보드 조직도와 동일한 분리.
  const [rosterTab, setRosterTab] = useState<"all" | "multi" | "single">("all");
  const [rosterQuery, setRosterQuery] = useState("");
  const [rosterSource, setRosterSource] = useState<"all" | "local" | "cloud" | "hub">("all");
  const [rosterReadiness, setRosterReadiness] = useState<"all" | "ready" | "attention">("all");

  // 선택된 에이전트 노드 (null 이면 회사 오버뷰 노출)
  const [selectedNode, setSelectedNode] = useState<ResolvedNode | null>(null);
  const [selectedFirmId, setSelectedFirmId] = useState<string | null>(null);
  const [selectedBorrowedProfileId, setSelectedBorrowedProfileId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedNode) {
      setSelectedFirmId(null);
      setSelectedBorrowedProfileId(null);
    } else if (selectedFirmId) {
      setSelectedBorrowedProfileId(null);
    }
  }, [selectedFirmId, selectedNode]);
  const [activeTab, setActiveTab] = useState<"identity" | "memory" | "playbook" | "activity" | "ontology">("identity");
  const targetDetailTab = searchParams.get("tab") === "ontology" ? "ontology" as const : null;
  const targetAgentId = searchParams.get("agentId") ?? "";
  const targetNodeId = searchParams.get("nodeId") ?? "";
  const targetFirmId = searchParams.get("firmId") ?? "";
  const manageView: ManageView = searchParams.get("view") === "published" ? "published" : "general";
  const [publishedAgents, setPublishedAgents] = useState<MarketplaceListing[]>([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedSignedIn, setPublishedSignedIn] = useState<boolean | null>(null);
  const [publishedInstalling, setPublishedInstalling] = useState<string | null>(null);

  // 파일 핸들링 및 상태
  const [agentFiles, setAgentFiles] = useState<WorkspaceNode[]>([]);
  // 런타임 durable 메모리(큐레이터가 실행 후 DB에 적재) — memory.md 와 별개의 실측 학습 소스.
  const [memoryEntries, setMemoryEntries] = useState<AgentMemoryEntryUi[]>([]);
  const [evolutionProposals, setEvolutionProposals] = useState<AgentEvolutionProposalUi[]>([]);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryParsed, setMemoryParsed] = useState<ParsedMemory>({ decisions: [], gotchas: [], openQuestions: [] });
  const memorySaveQueueRef = useRef(new AgentMemorySaveQueue());
  const selectedMemoryAgentRef = useRef<string | null>(null);

  const [promptContent, setPromptContent] = useState("");
  const [promptSourcePath, setPromptSourcePath] = useState("");
  const [savingFiles, setSavingFiles] = useState(false);


  // 온톨로지 인박스 — 실제 보류 중인 학습 제안만 표출(가짜 데이터 없음).
  // selectedNode 의 메모리 미결 과제(openQuestions)에서 도출 → 정식 규칙 승격 후보.
  const [ontologyInbox, setOntologyInbox] = useState<
    { id: string; type: "gotcha" | "decision"; title: string; content: string; source: "local" | "cloud" }[]
  >([]);

  // 허브 연동 글로벌 알림용 토스트 상태
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    const compactRoster = window.matchMedia("(max-width: 1100px)");
    try {
      const w = parseInt(window.localStorage.getItem("agentlas.firm.orgWidth") ?? "", 10);
      if (Number.isFinite(w) && w >= 200 && w <= 500) setOrgWidth(w);
      const c = window.localStorage.getItem("agentlas.firm.sidebarCollapsed") === "true";
      setSidebarCollapsed(c || compactRoster.matches);
    } catch {
      setSidebarCollapsed(compactRoster.matches);
    }
    const collapseOnCompact = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarCollapsed(true);
    };
    compactRoster.addEventListener?.("change", collapseOnCompact);
    return () => compactRoster.removeEventListener?.("change", collapseOnCompact);
  }, []);

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem("agentlas.firm.sidebarCollapsed", String(next));
    } catch {
      // ignore
    }
  };

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (sidebarCollapsed) return;
      const startX = e.clientX;
      const startW = orgWidth;
      let finalW = startW;
      function onMove(ev: MouseEvent) {
        const dx = ev.clientX - startX; // 좌측에서 우측으로 확장
        finalW = Math.max(200, Math.min(500, startW + dx));
        setOrgWidth(finalW);
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          window.localStorage.setItem("agentlas.firm.orgWidth", String(finalW));
        } catch {
          // ignore
        }
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    },
    [orgWidth, sidebarCollapsed],
  );

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const generation = ++rosterRefreshGenerationRef.current;
    const [fList, agList, runtimes, overrides, projectList, bindingList] = await Promise.all([
      api.firms.list(),
      api.team.list(),
      api.runtime.detect().catch(() => []),
      api.agentRuntime?.list ? api.agentRuntime.list().catch(() => []) : Promise.resolve([]),
      api.projects.list().catch(() => []),
      api.agents.exactBindings().catch(() => []),
    ]);
    if (rosterRefreshGenerationRef.current !== generation) return;
    const safeFirms = Array.isArray(fList) ? fList : [];
    const safeAgents = Array.isArray(agList) ? agList : [];
    const safeRuntimes = Array.isArray(runtimes) ? runtimes : [];
    const safeOverrides = Array.isArray(overrides) ? overrides : [];
    const safeProjects = Array.isArray(projectList) ? projectList : [];
    const safeBindings = Array.isArray(bindingList) ? bindingList : [];
    setFirms(safeFirms);
    setFirmCollapsed((current) => Object.fromEntries(
      safeFirms.map((firm) => [firm.id, current[firm.id] ?? true]),
    ));
    // Keep the full installed projection for organization/detail lookups. Only
    // the top-level roster is filtered; otherwise real background member cells
    // become fake "unbound" organization slots.
    setAgents(safeAgents);
    setRuntimeStatuses(safeRuntimes);
    setRuntimeOverrides(safeOverrides);
    setProjects(safeProjects);
    setExactBindings(safeBindings);
    setActiveProjectId((current) => current && safeProjects.some((project) => project.id === current)
      ? current
      : safeProjects[0]?.id ?? "");
    setBookmarkOverrides({});
    if (api.agents?.usageSummary) {
      void api.agents.usageSummary()
        .then((rows) => {
          if (rosterRefreshGenerationRef.current === generation && Array.isArray(rows)) setUsageRows(rows);
        })
        .catch(() => {});
    }
    if (api.agents?.borrowedProfiles) {
      void api.agents.borrowedProfiles()
        .then((rows) => {
          if (rosterRefreshGenerationRef.current === generation && Array.isArray(rows)) setBorrowedProfiles(rows);
        })
        .catch(() => {});
    }

    // 순차 for-await(20개면 ~4s 프리즈) → 동시성 3 병렬. 실패/null firm 은 기존처럼 누락(worker 내부 try/catch 로 null 반환). 순서 보존.
    const orgs: Record<string, ResolvedOrg> = {};
    const orgPairs = await mapWithConcurrency(safeFirms, 3, async (f) => {
      try {
        const o = await api.firms.getResolvedOrg(f.id);
        return o ? ([f.id, o] as const) : null;
      } catch {
        return null;
      }
    });
    if (rosterRefreshGenerationRef.current !== generation) return;
    for (const pair of orgPairs) {
      if (pair) orgs[pair[0]] = pair[1];
    }
    setResolvedOrgs(orgs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onAgentRosterChange((change) => {
        // Do not wait for the slower firm/org resolution pass before showing a
        // just-built local agent under My Agents.
        setAgents((previous) =>
          [change.agent, ...previous.filter((agent) => agent.id !== change.agent.id)],
        );
        setRosterTab((change.agent.kind ?? "agent") === "team" ? "multi" : "single");
        void refresh();
      }),
    [refresh],
  );

  const loadPublishedAgents = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setPublishedLoading(true);
    try {
      const session = await api.auth.getSession();
      setPublishedSignedIn(session.signedIn);
      if (!session.signedIn) {
        setPublishedAgents([]);
        return;
      }
      setPublishedAgents(await api.marketplace.listMine());
    } catch {
      setPublishedAgents([]);
    } finally {
      setPublishedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (manageView === "published") void loadPublishedAgents();
  }, [loadPublishedAgents, manageView]);

  async function signInForPublishedAgents() {
    const api = ipc();
    if (!api) return;
    setPublishedLoading(true);
    try {
      const session = await api.auth.signInWithGoogle();
      setPublishedSignedIn(session.signedIn);
      if (session.signedIn) await loadPublishedAgents();
    } finally {
      setPublishedLoading(false);
    }
  }

  async function installPublishedAgent(slug: string) {
    const api = ipc();
    if (!api) return;
    setPublishedInstalling(slug);
    try {
      const installed = await api.team.installMine(slug);
      await refresh();
      const loc = pickLocalized(installed, locale);
      setSelectedNode({
        id: installed.id,
        name: agentDisplayName(installed, locale),
        role: loc.tagline || installed.slug,
        agentId: installed.id,
      });
      setActiveTab("identity");
      showToast(locale === "ko" ? `${loc.name} 설치 완료` : `Installed ${loc.name}`);
    } catch (err) {
      showToast((locale === "ko" ? "퍼블리시 에이전트 설치 실패: " : "Failed to install published agent: ") + String(err));
    } finally {
      setPublishedInstalling(null);
    }
  }

  function openInstalledAgent(agent: InstalledAgent) {
    const loc = pickLocalized(agent, locale);
    setSelectedNode({
      id: agent.id,
      name: agentDisplayName(agent, locale),
      role: loc.tagline || agent.slug,
      agentId: agent.id,
    });
    setSelectedBorrowedProfileId(null);
    setActiveTab(targetDetailTab ?? "identity");
  }

  async function saveLocalDisplayName(agent: InstalledAgent, value: string) {
    const api = ipc();
    if (!api) throw new Error(locale === "ko" ? "Desktop 브리지를 사용할 수 없습니다." : "Desktop bridge is unavailable.");
    const updated = await api.team.setLocalDisplayName(agent.id, value);
    setAgents((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    setSelectedNode((current) => current?.agentId === updated.id
      ? { ...current, name: agentDisplayName(updated, locale) }
      : current);
    showToast(locale === "ko" ? "이 Mac의 표시 이름을 저장했습니다." : "Saved the display name for this Mac.");
  }

  async function attachAgentToActiveProject(agent: InstalledAgent | null) {
    const api = ipc();
    const project = projects.find((item) => item.id === activeProjectId) ?? null;
    if (!api || !agent || !project) {
      showToast(locale === "ko" ? "장착할 프로젝트와 실제 에이전트를 선택하세요." : "Choose a project and an installed agent.");
      return;
    }
    if (projectPoolHasTarget(project, "agent", agent.id)) {
      showToast(locale === "ko" ? "이미 이 프로젝트에 장착되어 있습니다." : "Already attached to this project.");
      return;
    }
    const exactBinding = exactBindings.find((binding) => binding.installedAgentId === agent.id) ?? null;
    // No Hub-pair gate here. An installed agent executes from the local
    // registry, and a Cloud restore without a public Hub registration can never
    // acquire that pair — the old refusal told the user to "re-import or
    // restore", which could not have helped. The project roster stages the same
    // asset under the same rule; both call the one member builder.
    if (agent.sourceMissingSince) {
      showToast(locale === "ko"
        ? "로컬 원본 경로 연결이 끊겨 장착하지 않았습니다. 원본을 다시 연결해 주세요."
        : "The local source path is disconnected, so nothing was attached. Reconnect the source first.");
      return;
    }
    try {
      const updated = await api.projects.update(project.id, {
        agentPool: [
          ...project.agentPool,
          installedAgentPoolMember(agent, exactBinding, locale),
        ],
      });
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      showToast(locale === "ko" ? `${updated.name} 프로젝트의 도구함에 장착했습니다.` : `Attached to ${updated.name}.`);
    } catch (error) {
      showToast((locale === "ko" ? "프로젝트 장착 실패: " : "Could not attach to project: ") + String(error));
    }
  }

  async function attachTeamToActiveProject(firm: InstalledFirm) {
    const api = ipc();
    const project = projects.find((item) => item.id === activeProjectId) ?? null;
    const controller = agentMap.get(firm.ceoAgentId) ?? null;
    if (!api || !project || !controller) {
      showToast(locale === "ko" ? "장착할 프로젝트와 실행 가능한 팀을 선택하세요." : "Choose a project and an executable team.");
      return;
    }
    if (projectPoolHasTarget(project, "team", firm.id)) {
      showToast(locale === "ko" ? "이미 이 프로젝트에 장착된 팀입니다." : "This team is already attached to the project.");
      return;
    }
    // "A controller release cannot stand in for a team release" is satisfied by
    // the member shape itself: keyed on firm.id with releaseId null, the CEO's
    // release can never be mistaken for the team's. Refusing on top of that
    // blocked every firm whose controller came from Cloud or Hub, which is most
    // installed teams.
    const controllerBinding = exactBindings.find((binding) => binding.installedAgentId === controller.id) ?? null;
    try {
      const updated = await api.projects.update(project.id, {
        agentPool: [
          ...project.agentPool,
          firmPoolMember(firm, controller, controllerBinding, locale),
        ],
      });
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      showToast(locale === "ko" ? `${updated.name} 프로젝트에 팀 도구를 장착했습니다.` : `Attached the team tool to ${updated.name}.`);
    } catch (error) {
      showToast((locale === "ko" ? "팀 장착 실패: " : "Could not attach team: ") + String(error));
    }
  }

  async function attachStandaloneTeamToActiveProject(team: InstalledAgent) {
    const api = ipc();
    const project = projects.find((item) => item.id === activeProjectId) ?? null;
    const binding = exactBindings.find((item) => item.installedAgentId === team.id) ?? null;
    if (!api || !project) {
      showToast(locale === "ko" ? "장착할 프로젝트를 선택하세요." : "Choose a project to attach this team to.");
      return;
    }
    // An imported team runs through its own installed package. Demanding a Hub
    // definition and release refused every locally imported and Cloud-restored
    // team; the exact pin is carried when the Hub supplies one and asserted
    // where a remote call is actually prepared.
    if (team.sourceMissingSince) {
      showToast(locale === "ko"
        ? "로컬 원본 경로 연결이 끊겨 장착하지 않았습니다. 원본을 다시 연결해 주세요."
        : "The local source path is disconnected, so nothing was attached. Reconnect the source first.");
      return;
    }
    const member = installedTeamPoolMember(team, binding, locale);
    if (project.agentPool.some((existing) => projectPoolMemberKey(existing) === projectPoolMemberKey(member))) {
      showToast(locale === "ko" ? "이미 이 프로젝트에 장착된 팀입니다." : "This team is already attached to the project.");
      return;
    }
    try {
      const updated = await api.projects.update(project.id, {
        agentPool: [...project.agentPool, member],
      });
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      showToast(locale === "ko" ? `${updated.name} 프로젝트에 팀 도구를 장착했습니다.` : `Attached the team tool to ${updated.name}.`);
    } catch (error) {
      showToast((locale === "ko" ? "팀 장착 실패: " : "Could not attach team: ") + String(error));
    }
  }

  useEffect(() => {
    if (!targetAgentId && !targetNodeId) return;
    const target = findAgentRouteNode({
      agentId: targetAgentId,
      nodeId: targetNodeId,
      firmId: targetFirmId,
      firms,
      agents,
      resolvedOrgs,
      locale,
    });
    if (!target) return;
    setSelectedNode((current) => {
      if (current?.id === target.id && current.agentId === target.agentId) return current;
      return target;
    });
    setActiveTab(targetDetailTab ?? "identity");
    if (targetFirmId) {
      setFirmCollapsed((prev) => ({ ...prev, [targetFirmId]: false }));
    }
  }, [agents, firms, locale, resolvedOrgs, targetAgentId, targetDetailTab, targetFirmId, targetNodeId]);

  // Legacy firm links now land on the canonical team detail. A firm without a
  // member target is the team itself, not an implicit request to open its CEO.
  useEffect(() => {
    if (!targetFirmId || targetAgentId || targetNodeId) return;
    if (!firms.some((firm) => firm.id === targetFirmId)) return;
    setRosterTab("multi");
    setSelectedNode(null);
    setSelectedFirmId(targetFirmId);
    setFirmCollapsed((current) => ({ ...current, [targetFirmId]: false }));
  }, [firms, targetAgentId, targetFirmId, targetNodeId]);

  // Feature-update and external deep links may open the per-agent Ontology tab
  // without already knowing a local installed id. Select the first visible
  // installed agent deterministically; never guess a Hub release binding here.
  useEffect(() => {
    if (targetDetailTab !== "ontology" || targetAgentId || targetNodeId || selectedNode || agents.length === 0) return;
    const first = visibleRosterAgents(agents)[0];
    if (!first) return;
    const loc = pickLocalized(first, locale);
    setRosterTab((first.kind ?? "agent") === "team" ? "multi" : "single");
    setSelectedNode({
      id: first.id,
      name: agentDisplayName(first, locale),
      role: loc.tagline || first.slug,
      agentId: first.id,
    });
    setActiveTab("ontology");
  }, [agents, locale, selectedNode, targetAgentId, targetDetailTab, targetNodeId]);

  // 에이전트 선택 변경 시 파일 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !selectedNode || !selectedNode.agentId) {
      selectedMemoryAgentRef.current = null;
      setAgentFiles([]);
      setMemoryContent("");
      setMemoryParsed({ decisions: [], gotchas: [], openQuestions: [] });
      setPromptContent("");
      setPromptSourcePath("");
      return;
    }
    selectedMemoryAgentRef.current = selectedNode.agentId;

    let cancelled = false;
    async function loadAgentAssets() {
      if (!selectedNode?.agentId || !api) return;
      // 메타데이터 systemPrompt를 먼저 기본값으로 — 파일 로드가 실패해도 "내용 없음"이 되지 않게.
      const curAgent = agents.find((a) => a.id === selectedNode.agentId);
      if (curAgent?.systemPrompt?.trim()) {
        setPromptContent(curAgent.systemPrompt);
      }
      try {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        if (cancelled) return;
        const fileEntries = listing.entries;
        setAgentFiles(fileEntries);

        // memory.md 탐색 및 로드
        const memFile = fileEntries.find((e) => e.kind === "file" && e.name.toLowerCase() === "memory.md");
        if (memFile) {
          const m = await api.agentFiles.read(selectedNode.agentId, memFile.path);
          if (cancelled) return;
          const parsed = parseMemoryMarkdown(m.content);
          const visible = memorySaveQueueRef.current.hydrate(selectedNode.agentId, parsed, m.content);
          setMemoryContent(m.content);
          setMemoryParsed(visible);
        } else {
          const empty: ParsedMemory = { decisions: [], gotchas: [], openQuestions: [] };
          const visible = memorySaveQueueRef.current.hydrate(selectedNode.agentId, empty, "");
          setMemoryContent("");
          setMemoryParsed(visible);
        }

        // Import/restore/runtime과 동일한 main-owned canonical resolver.
        const promptSource = await api.agentFiles.promptSource(selectedNode.agentId);
        if (cancelled) return;
        setPromptSourcePath(promptSource?.relativePath ?? "");
        if (promptSource) {
          setPromptContent(promptSource.content);
        }
      } catch (e) {
        // 파일 로드 실패 시에도 위에서 설정한 메타데이터 프롬프트가 남아있다.
        console.error("에이전트 파일 로드 실패:", e);
      }
    }

    void loadAgentAssets();
    return () => {
      cancelled = true;
    };
  }, [selectedNode, agents]);

  // 런타임 durable 메모리(큐레이터 DB) 로드 — 파일 로드와 독립·비차단, 에이전트 전환 시 취소.
  useEffect(() => {
    const api = ipc();
    if (!api || !selectedNode?.agentId) {
      setMemoryEntries([]);
      return;
    }
    let cancelled = false;
    setMemoryEntries([]);
    // 구버전 preload(agentMemory 미노출)에서도 죽지 않게 옵셔널 호출.
    Promise.resolve(api.agentMemory?.entries?.(selectedNode.agentId, 100))
      .then((rows) => {
        if (!cancelled) setMemoryEntries(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setMemoryEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  useEffect(() => {
    const api = ipc();
    if (!api || !selectedNode?.agentId) {
      setEvolutionProposals([]);
      return;
    }
    let cancelled = false;
    setEvolutionProposals([]);
    Promise.resolve(api.agentEvolution?.list?.(selectedNode.agentId, 50))
      .then((rows) => {
        if (!cancelled) setEvolutionProposals(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setEvolutionProposals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);


  // 후보 생성은 파일을 쓰지 않는다. 승인/적용은 아래 별도 사용자 액션에서만 수행한다.
  async function createEvolutionProposal(
    newPromptContent: string,
    source: Record<string, unknown> = {},
  ): Promise<AgentEvolutionProposalUi | undefined> {
    const api = ipc();
    if (!api || !selectedNode || !selectedNode.agentId) return;
    setSavingFiles(true);
    try {
      if (!promptSourcePath) throw new Error(locale === "ko" ? "런타임 프롬프트 원본 파일을 찾지 못했습니다." : "The runtime prompt source file could not be found.");
      const path = promptSourcePath;
      const proposal = await api.agentEvolution.createProposal({
        agentId: selectedNode.agentId,
        targetPath: path,
        currentContent: promptContent,
        proposedContent: newPromptContent,
        proposalType: "rule",
        risk: "medium",
        summary: locale === "ko" ? "프롬프트 진화 검토 후보" : "Prompt evolution review candidate",
        source: { ...source, surface: "desktop.library.agent_detail" },
        decisionNote: locale === "ko" ? "사용자가 검토 후보를 만들었습니다. 아직 적용되지 않았습니다." : "User created a review candidate. It is not applied yet.",
      });
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      showToast(locale === "ko" ? "검토 후보를 저장했습니다. 원본 프롬프트는 아직 바뀌지 않았습니다." : "Review candidate saved. The original prompt is unchanged.");
      return proposal;
    } catch (e) {
      showToast((locale === "ko" ? "진화 후보 생성 실패: " : "Failed to create evolution candidate: ") + String(e));
      return undefined;
    } finally {
      setSavingFiles(false);
    }
  }

  async function approveEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    setSavingFiles(true);
    try {
      const proposal = await api.agentEvolution.approveAndApply(
        proposalId,
        locale === "ko" ? "사용자가 diff와 해시를 검토하고 승인했습니다." : "User reviewed the diff and hashes, then approved.",
      );
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      if (proposal.proposalType === "rule") {
        setPromptContent(proposal.afterContent);
      } else if (proposal.proposalType === "skill" && selectedNode?.agentId) {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        setAgentFiles(listing.entries);
      }
      const receipt = proposal.receipts.find((item) => item.action === "apply");
      showToast(receipt
        ? proposal.proposalType === "skill"
          ? (locale === "ko" ? `스킬 주입 완료 · 자산 v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}` : `Skill injected · asset v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}`)
          : (locale === "ko" ? `적용 완료 · 자산 v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}` : `Applied · asset v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}`)
        : (locale === "ko" ? "적용은 완료됐지만 영수증을 확인할 수 없습니다." : "Applied, but no receipt was returned."));
    } catch (e) {
      showToast((locale === "ko" ? "승인 적용 실패: " : "Approval/apply failed: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  async function rejectEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    setSavingFiles(true);
    try {
      const proposal = await api.agentEvolution.reject(
        proposalId,
        locale === "ko" ? "사용자가 검토 후 거절했습니다." : "User rejected after review.",
      );
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      showToast(locale === "ko" ? "후보를 거절했습니다. 파일은 변경되지 않았습니다." : "Candidate rejected. No file was changed.");
    } catch (e) {
      showToast((locale === "ko" ? "후보 거절 실패: " : "Failed to reject candidate: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  async function rollbackEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    setSavingFiles(true);
    try {
      const proposal = await api.agentEvolution.rollback(proposalId);
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      if (proposal.proposalType === "rule") {
        setPromptContent(proposal.beforeContent);
      } else if (proposal.proposalType === "skill" && selectedNode?.agentId) {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        setAgentFiles(listing.entries);
      }
      const receipt = proposal.receipts.find((item) => item.action === "rollback");
      showToast(receipt
        ? proposal.proposalType === "skill"
          ? (locale === "ko" ? `스킬 제거 롤백 완료 · 자산 v${receipt.versionAfter}` : `Skill removal rollback complete · asset v${receipt.versionAfter}`)
          : (locale === "ko" ? `롤백 완료 · 자산 v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}` : `Rolled back · asset v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}`)
        : (locale === "ko" ? "롤백 완료" : "Rollback complete"));
    } catch (e) {
      showToast((locale === "ko" ? "롤백 차단/실패: " : "Rollback blocked/failed: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  // 공용 per-agent 저장 큐가 React 렌더보다 먼저 최신 상태를 누적하고, 각 에이전트의
  // durable 원문을 기준으로 직렬화한다. 빠른 토글과 에이전트 전환이 서로 덮어쓰지 않는다.
  function saveMemory(updater: (prev: typeof memoryParsed) => typeof memoryParsed) {
    const agentId = selectedNode?.agentId;
    const api = ipc();
    if (!agentId || !api) return Promise.resolve();
    const memFile = agentFiles.find((entry) => entry.name.toLowerCase() === "memory.md");
    const path = memFile?.path ?? "memory.md";
    const { completion } = memorySaveQueueRef.current.enqueue({
      agentId,
      updater,
      locale,
      write: async (serialized) => { await api.agentFiles.write(agentId, path, serialized); },
      onOptimistic: (next) => {
        if (selectedMemoryAgentRef.current === agentId) setMemoryParsed(next);
      },
      onDurable: (_next, serialized) => {
        if (selectedMemoryAgentRef.current === agentId) setMemoryContent(serialized);
      },
      onRollback: (durable) => {
        if (selectedMemoryAgentRef.current === agentId) setMemoryParsed(durable);
      },
      onPendingChange: (pending) => {
        if (selectedMemoryAgentRef.current === agentId) setSavingFiles(pending);
      },
    });
    return completion.catch((error) => {
      if (selectedMemoryAgentRef.current === agentId) {
        showToast((locale === "ko" ? "메모리 갱신 실패: " : "Failed to update memory: ") + String(error));
      }
    });
  }

  function showToast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  }

  async function importAgentFolder() {
    const api = ipc();
    if (!api || importBusy) return;
    setImportBusy(true);
    try {
      const dir = await api.fs.pickDirectory();
      if (!dir) return;
      const imported = await api.team.importLocalFolder({ path: dir.path, scope: dir.scope });
      await refresh();
      const loc = pickLocalized(imported, locale);
      setSelectedNode({
        id: imported.id,
        name: agentDisplayName(imported, locale),
        role: loc.tagline || imported.slug,
        agentId: imported.id,
      });
      setActiveTab("identity");
      showToast(locale === "ko" ? `${loc.name} 가져오기 완료` : `Imported ${loc.name}`);
    } catch (err) {
      showToast((locale === "ko" ? "에이전트 가져오기 실패: " : "Import failed: ") + String(err));
    } finally {
      setImportBusy(false);
    }
  }

  async function removeInstalledAgent(agent: InstalledAgent | null) {
    const api = ipc();
    if (!api || !agent) return;
    const displayName = agentDisplayName(agent, locale);
    const affectedProjects = projectsReferencing(
      projects,
      removalReferenceSet({ agentIds: [agent.id], remoteTargetIds: [agent.slug] }),
    );
    const impact = affectedProjects.length > 0
      ? (locale === "ko"
          ? `\n\n장착 해제될 프로젝트 ${affectedProjects.length}개: ${affectedProjects.map((project) => project.name).join(", ")}`
          : `\n\nIt will be detached from ${affectedProjects.length} project(s): ${affectedProjects.map((project) => project.name).join(", ")}`)
      : "";
    const source: "local" | "cloud" | "hub" = agent.assetSource === "agent-cloud"
      ? "cloud"
      : agent.assetSource === "hub"
        ? "hub"
        : "local";
    const sourceLabel = source === "local"
      ? (locale === "ko" ? "로컬 폴더는 휴지통으로 이동" : "the local folder will move to Trash")
      : source === "cloud"
        ? (locale === "ko" ? "Agent Cloud 원격 자산도 삭제" : "the Agent Cloud asset will also be deleted")
        : (locale === "ko" ? "Hub 북마크도 제거" : "the Hub bookmark will also be removed");
    // 좌석 모델(T1): 봇 삭제 = 자리 비우기 — 대화·세션은 보존된다. 확인 문구는 정확한
    // 수(사전 COUNT)로 그것을 말한다(SEAT-SESSION-PLAN-v2 §4-7, 계약 7-D 기준 9).
    let preservation = locale === "ko"
      ? " 대화 기록은 그대로 남습니다."
      : " Conversations are kept.";
    try {
      const preview = await api.team.uninstallPreview(agent.id);
      preservation = locale === "ko"
        ? ` 좌석 ${preview.seatCount}곳이 빈 자리가 됩니다. 대화 ${preview.chatCount}개는 그대로 남습니다.`
        : ` ${preview.seatCount} seat${preview.seatCount === 1 ? "" : "s"} become${preview.seatCount === 1 ? "s" : ""} empty. ${preview.chatCount} conversation${preview.chatCount === 1 ? "" : "s"} stay${preview.chatCount === 1 ? "s" : ""}.`;
    } catch { /* 수를 못 세면 수 없는 보존 문구로 낸다 — 지어내지 않는다 */ }
    if (!window.confirm(locale === "ko"
      ? `'${displayName}'을(를) 조직도에서 삭제할까요? ${sourceLabel}합니다.${preservation}${impact}`
      : `Delete '${displayName}' from the organization chart? ${sourceLabel}.${preservation}${impact}`)) return;
    try {
      // Detachment is a consequence of the removal itself now
      // (electron/store/projects.ts detachProjectPoolReferences), so every
      // removal surface gets it and a remote row can no longer outlive its
      // asset. This screen only reports the impact.
      if (source === "cloud") await api.marketplace.deleteMine(agent.slug);
      if (source === "hub") await api.marketplace.bookmarkRemove(agent.slug, agent.kind === "team" ? "team" : "agent");
      const removal = await api.team.uninstall(agent.id, { removeSource: source === "local" });
      setSelectedNode(null);
      await refresh();
      showToast(locale === "ko"
        ? `에이전트를 삭제했습니다.${source === "local" && !removal.sourceMovedToTrash ? " 원본 폴더는 휴지통 이동에 실패했습니다." : ""}`
        : `Agent deleted.${source === "local" && !removal.sourceMovedToTrash ? " The source folder could not be moved to Trash." : ""}`);
    } catch (err) {
      showToast((locale === "ko" ? "에이전트 제거 실패: " : "Failed to remove agent: ") + String(err));
    }
  }

  async function removeInstalledFirm(firm: InstalledFirm | null) {
    const api = ipc();
    if (!api || !firm) return;
    const name = pickLocalized(firm, locale).name;
    const firmAgentIds = [firm.ceoAgentId, ...firm.orgChart.flatMap((node) => node.agentId ? [node.agentId] : [])];
    const affectedProjects = projectsReferencing(
      projects,
      removalReferenceSet({
        agentIds: firmAgentIds,
        firmIds: [firm.id],
        remoteTargetIds: firmAgentIds.map((agentId) => agents.find((item) => item.id === agentId)?.slug),
      }),
    );
    const impact = affectedProjects.length > 0
      ? (locale === "ko"
          ? `\n\n장착 해제될 프로젝트 ${affectedProjects.length}개: ${affectedProjects.map((project) => project.name).join(", ")}`
          : `\n\nIt will be detached from ${affectedProjects.length} project(s): ${affectedProjects.map((project) => project.name).join(", ")}`)
      : "";
    const controller = agents.find((agent) => agent.id === firm.ceoAgentId) ?? null;
    const source: "local" | "cloud" | "hub" = controller?.assetSource === "agent-cloud"
      ? "cloud"
      : controller?.assetSource === "hub"
        ? "hub"
        : "local";
    const sourceLabel = source === "local"
      ? (locale === "ko" ? "팀 원본 폴더는 휴지통으로 이동" : "the team source folder will move to Trash")
      : source === "cloud"
        ? (locale === "ko" ? "Agent Cloud 팀 자산도 삭제" : "the Agent Cloud team asset will also be deleted")
        : (locale === "ko" ? "Hub 팀 북마크도 제거" : "the Hub team bookmark will also be removed");
    if (!window.confirm(locale === "ko"
      ? `'${name}' 팀을 조직도에서 완전히 삭제할까요? ${sourceLabel}합니다. 팀 멤버 설치 행과 장착 참조도 함께 정리합니다.${impact}`
      : `Permanently delete '${name}' from the organization chart? ${sourceLabel}. Team member installs and attachments will also be cleaned up.${impact}`)) return;
    try {
      // See removeInstalledAgent: the store detaches on removal.
      if (source === "cloud" && controller) await api.marketplace.deleteMine(controller.slug);
      if (source === "hub" && controller) await api.marketplace.bookmarkRemove(controller.slug, "team");
      const removal = await api.firms.uninstall(firm.id, { removeMembers: true, removeSource: source === "local" });
      setSelectedFirmId(null);
      await refresh();
      showToast(locale === "ko"
        ? `팀을 삭제했습니다.${source === "local" && !removal.sourceMovedToTrash ? " 원본 폴더는 휴지통 이동에 실패했습니다." : ""}`
        : `Team deleted.${source === "local" && !removal.sourceMovedToTrash ? " The source folder could not be moved to Trash." : ""}`);
    } catch (err) {
      showToast((locale === "ko" ? "팀 제거 실패: " : "Failed to remove team: ") + String(err));
    }
  }

  const fullRoster = useMemo(() => buildAgentRoster(agents, firms), [agents, firms]);
  const roster = useMemo(() => buildAgentRoster(visibleRosterAgents(agents), firms), [agents, firms]);
  const agentMap = fullRoster.agentById;
  const exactBindingByInstalledId = useMemo(
    () => new Map(exactBindings.map((binding) => [binding.installedAgentId, binding] as const)),
    [exactBindings],
  );
  const rosterSourceForAgent = useCallback((agent: InstalledAgent): "local" | "cloud" | "hub" => {
    const binding = exactBindingByInstalledId.get(agent.id);
    if (binding?.source === "agent-cloud-restore" || agent.assetSource === "agent-cloud") return "cloud";
    if (binding?.source === "hub-install" || agent.assetSource === "hub") return "hub";
    return "local";
  }, [exactBindingByInstalledId]);
  const rosterAgentReady = useCallback((agent: InstalledAgent): boolean => {
    if (agent.sourceMissingSince) return false;
    const source = rosterSourceForAgent(agent);
    if (source !== "local") return exactBindingByInstalledId.has(agent.id);
    // A local team without a firm projection has no authoritative hierarchy.
    return agent.kind !== "team";
  }, [exactBindingByInstalledId, rosterSourceForAgent]);
  const rosterAgentFilterMatches = useCallback((agent: InstalledAgent): boolean => {
    const sourceMatches = rosterSource === "all" || rosterSourceForAgent(agent) === rosterSource;
    const ready = rosterAgentReady(agent);
    const readinessMatches = rosterReadiness === "all"
      || (rosterReadiness === "ready" ? ready : !ready);
    return sourceMatches && readinessMatches;
  }, [rosterAgentReady, rosterReadiness, rosterSource, rosterSourceForAgent]);
  const rosterFirmFilterMatches = useCallback((firm: InstalledFirm): boolean => {
    const controller = agentMap.get(firm.ceoAgentId);
    if (!controller) return rosterReadiness !== "ready" && (rosterSource === "all" || rosterSource === "local");
    const source = rosterSourceForAgent(controller);
    const ready = source === "local" && !controller.sourceMissingSince;
    return (rosterSource === "all" || rosterSource === source)
      && (rosterReadiness === "all" || (rosterReadiness === "ready" ? ready : !ready));
  }, [agentMap, rosterReadiness, rosterSource, rosterSourceForAgent]);
  const normalizedRosterQuery = rosterQuery.trim().toLocaleLowerCase(locale);
  const rosterAgentMatches = useCallback((agent: InstalledAgent): boolean => {
    if (!normalizedRosterQuery) return true;
    const localized = pickLocalized(agent, locale);
    return [agentDisplayName(agent, locale), localized.tagline, agent.slug]
      .some((value) => value.toLocaleLowerCase(locale).includes(normalizedRosterQuery));
  }, [locale, normalizedRosterQuery]);
  const rosterFirmMatches = useCallback((firm: InstalledFirm): boolean => {
    if (!normalizedRosterQuery) return true;
    const localized = pickLocalized(firm, locale);
    if ([localized.name, localized.tagline, firm.slug]
      .some((value) => value.toLocaleLowerCase(locale).includes(normalizedRosterQuery))) return true;
    return firm.orgChart.some((node) => {
      const bound = agentMap.get(node.agentId);
      return [node.role, node.agentSlug, bound ? agentDisplayName(bound, locale) : ""]
        .some((value) => value.toLocaleLowerCase(locale).includes(normalizedRosterQuery));
    });
  }, [agentMap, locale, normalizedRosterQuery]);
  const visibleMultiFirms = useMemo(
    () => roster.multiFirms.filter((firm) => rosterFirmMatches(firm) && rosterFirmFilterMatches(firm)),
    [roster.multiFirms, rosterFirmFilterMatches, rosterFirmMatches],
  );
  const visibleStandaloneTeams = useMemo(
    () => roster.standaloneMultiAgents.filter((agent) => rosterAgentMatches(agent) && rosterAgentFilterMatches(agent)),
    [roster.standaloneMultiAgents, rosterAgentFilterMatches, rosterAgentMatches],
  );
  const visibleSingleAgents = useMemo(
    () => roster.singleModeAgents.filter((agent) => rosterAgentMatches(agent) && rosterAgentFilterMatches(agent)),
    [roster.singleModeAgents, rosterAgentFilterMatches, rosterAgentMatches],
  );

  // ── v74 사용/북마크 파생 — 로스터 섹션·배지 ─────────────────────────────
  const usageByAgentId = useMemo(() => new Map(usageRows.map((row) => [row.agentId, row])), [usageRows]);
  const isBookmarked = useCallback((a: InstalledAgent): boolean => {
    if (a.id in bookmarkOverrides) return bookmarkOverrides[a.id];
    return Boolean(a.bookmarkedAt ?? usageByAgentId.get(a.id)?.bookmarkedAt);
  }, [bookmarkOverrides, usageByAgentId]);
  // "자주 씀" = 최근 30일 안에 마지막으로 쓰였고 누적 사용이 5회 이상인 에이전트.
  const isFrequentlyUsed = useCallback((agentId: string): boolean => {
    const usage = usageByAgentId.get(agentId);
    if (!usage || usage.useCount < 5) return false;
    const last = Date.parse(usage.lastUsedAt);
    return Number.isFinite(last) && Date.now() - last <= 30 * 86_400_000;
  }, [usageByAgentId]);
  const toggleBookmark = useCallback(async (agentId: string, next: boolean) => {
    const api = ipc();
    if (!api?.agents?.setBookmark) return;
    setBookmarkOverrides((current) => ({ ...current, [agentId]: next }));
    try {
      await api.agents.setBookmark(agentId, next);
    } catch {
      setBookmarkOverrides((current) => ({ ...current, [agentId]: !next }));
    }
  }, []);
  // Hub 북마크 + 로컬 미설치 사용 이력을 합친 "Hub 선반". 북마크했거나(실행 0회여도)
  // 한 번이라도 빌려 쓴 Hub 에이전트/팀은 설치 전이라도 내 에이전트 목록에 남는다.
  // 이미 설치된 것은 정식 로스터에 이미 있으므로 제외한다.
  const installedSlugSet = useMemo(() => new Set(agents.map((a) => a.slug)), [agents]);
  const hubShelfRows = useMemo(() => borrowedProfiles
    .filter((profile) => !installedSlugSet.has(profile.slug))
    .map((profile) => ({
      ...profile,
      name: locale === "en" ? profile.nameEn : profile.name,
      bookmarked: Boolean(profile.bookmarkedAt),
    })), [borrowedProfiles, installedSlugSet, locale]);
  const visibleHubShelfRows = useMemo(() => {
    if ((rosterSource !== "all" && rosterSource !== "hub") || rosterReadiness !== "all") return [];
    if (!normalizedRosterQuery) return hubShelfRows;
    return hubShelfRows.filter((profile) => [profile.name, profile.slug]
      .some((value) => value.toLocaleLowerCase(locale).includes(normalizedRosterQuery)));
  }, [hubShelfRows, locale, normalizedRosterQuery, rosterReadiness, rosterSource]);
  const firmUsageRollup = useCallback((firm: InstalledFirm): number => {
    let total = 0;
    for (const node of firm.orgChart) total += usageByAgentId.get(node.agentId)?.useCount ?? 0;
    return total;
  }, [usageByAgentId]);
  const selectedFirm = selectedFirmId ? firms.find((firm) => firm.id === selectedFirmId) ?? null : null;
  const selectedStandaloneTeam = !selectedFirm && selectedNode?.agentId
    ? agents.find((agent) => agent.id === selectedNode.agentId && agent.kind === "team") ?? null
    : null;
  const selectedStandaloneTeamFirm = selectedStandaloneTeam
    ? firms.find((firm) => firm.ceoAgentId === selectedStandaloneTeam.id) ?? null
    : null;
  const selectedStandaloneTeamBinding = selectedStandaloneTeam
    ? exactBindings.find((binding) => binding.installedAgentId === selectedStandaloneTeam.id) ?? null
    : null;
  const selectedFirmController = selectedFirm ? agentMap.get(selectedFirm.ceoAgentId) ?? null : null;
  const selectedFirmControllerBinding = selectedFirmController
    ? exactBindings.find((binding) => binding.installedAgentId === selectedFirmController.id) ?? null
    : null;
  const selectedFirmNeedsTeamBinding = Boolean(
    selectedFirmController
    && (selectedFirmController.assetSource === "hub" || selectedFirmController.assetSource === "agent-cloud"),
  );
  const selectedBorrowedProfile = selectedBorrowedProfileId
    ? borrowedProfiles.find((profile) => profile.profileId === selectedBorrowedProfileId) ?? null
    : null;

  // 팀 에이전트 펼치기 — 하위 서브에이전트를 백엔드(즉시 결정적 + 백그라운드 LLM)로 해석.
  const toggleTeam = useCallback(
    async (agentId: string) => {
      setTeamExpanded((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
      if (teamSubs[agentId] !== undefined) return; // 이미 로드됨/로딩중
      const api = ipc();
      if (!api?.team?.resolveSubAgents) return;
      setTeamSubs((prev) => ({ ...prev, [agentId]: "loading" }));
      try {
        const res = await api.team.resolveSubAgents(agentId);
        setTeamSubs((prev) => ({ ...prev, [agentId]: res?.subAgents ?? [] }));
      } catch {
        setTeamSubs((prev) => ({ ...prev, [agentId]: [] }));
      }
    },
    [teamSubs],
  );
  const installedAgentSlugs = new Set(agents.map((a) => a.slug));
  const selectedContext = useMemo(
    () => (selectedNode ? findSelectedNodeContext(selectedNode, firms, resolvedOrgs) : null),
    [selectedNode, firms, resolvedOrgs],
  );

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* 1. 왼쪽 접이식 사이드바 (조직도 구성) */}
      <aside
        className="glass-thin"
        data-tour-id="agents.roster"
        style={{
          position: "relative",
          width: sidebarCollapsed ? 64 : orgWidth,
          flexShrink: 0,
          borderRight: "1px solid var(--glass-border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          height: "100%",
          transition: "width 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <header
          style={{
            padding: sidebarCollapsed ? "16px 0" : "14px 16px 10px",
            borderBottom: "1px solid var(--glass-border)",
            display: "flex",
            flexDirection: "column",
            alignItems: sidebarCollapsed ? "center" : "stretch",
            gap: 8,
          }}
        >
          {sidebarCollapsed ? (
            <button onClick={() => setSelectedNode(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--accent)" }}>
              <IconBuilding size={20} />
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%" }}>
              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                style={{ flex: 1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: 0, border: 0, background: "transparent", color: "inherit", textAlign: "left" }}
              >
                <IconLayers size={14} style={{ color: "var(--accent)" }} />
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {locale === "ko" ? "에이전트 도구함" : "Agent Toolbox"}
                </div>
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void importAgentFolder();
                }}
                disabled={importBusy}
                className="titlebar-nodrag"
                data-tour-id="agents.import"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minHeight: 44,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: "1px solid var(--paper-edge)",
                  background: "var(--paper)",
                  color: "var(--ink)",
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: importBusy ? "default" : "pointer",
                  opacity: importBusy ? 0.62 : 1,
                  flexShrink: 0,
                }}
              >
                <IconFileUp size={13} />
                {importBusy ? (locale === "ko" ? "가져오는 중" : "Importing") : locale === "ko" ? "가져오기" : "Import"}
              </button>
            </div>
          )}
        </header>

        {!sidebarCollapsed && (
          <div className="library-roster-tabs">
            {(["general", "published"] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => navigate(`/library/agents?view=${view}`)}
                className="library-roster-tab"
                data-active={manageView === view ? "true" : "false"}
              >
                {view === "general"
                  ? locale === "ko" ? "설치됨" : "Installed"
                  : locale === "ko" ? "내가 공개함" : "Published by me"}
              </button>
            ))}
          </div>
        )}

        {/* 자산 유형은 출처/관리 상태와 독립된 한 축이다. */}
        {manageView === "general" && !sidebarCollapsed && (
          <div className="library-roster-tabs" role="group" aria-label={locale === "ko" ? "도구 유형" : "Tool type"}>
            {(["all", "multi", "single"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRosterTab(tab)}
                className="library-roster-tab"
                data-active={rosterTab === tab ? "true" : "false"}
              >
                {tab === "all"
                  ? locale === "ko" ? "전체" : "All"
                  : tab === "multi"
                    ? locale === "ko" ? "팀" : "Teams"
                    : locale === "ko" ? "싱글" : "Singles"}
              </button>
            ))}
          </div>
        )}

        {manageView === "general" && !sidebarCollapsed && (
          <label style={{ position: "relative", display: "block", padding: "8px 12px 0" }}>
            <span className="sr-only">{locale === "ko" ? "에이전트 도구 검색" : "Search agent tools"}</span>
            <IconSearch size={14} aria-hidden="true" style={{ position: "absolute", left: 24, top: 23, color: "var(--muted-deep)", pointerEvents: "none" }} />
            <input
              type="search"
              value={rosterQuery}
              onChange={(event) => setRosterQuery(event.target.value)}
              placeholder={locale === "ko" ? "팀·에이전트·역할 검색" : "Search teams, agents, and roles"}
              style={{ width: "100%", minHeight: 44, padding: "0 34px", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", fontSize: 12.5, outline: "none" }}
            />
          </label>
        )}

        {manageView === "general" && !sidebarCollapsed && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "8px 12px 0" }}>
            <label>
              <span className="sr-only">{locale === "ko" ? "원본 출처" : "Origin"}</span>
              <select
                value={rosterSource}
                onChange={(event) => setRosterSource(event.target.value as typeof rosterSource)}
                style={{ width: "100%", minHeight: 44, padding: "0 10px", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", fontSize: 12 }}
              >
                <option value="all">{locale === "ko" ? "출처 · 전체" : "Origin · All"}</option>
                <option value="local">{locale === "ko" ? "출처 · 로컬" : "Origin · Local"}</option>
                <option value="cloud">{locale === "ko" ? "출처 · Cloud" : "Origin · Cloud"}</option>
                <option value="hub">{locale === "ko" ? "출처 · Hub" : "Origin · Hub"}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{locale === "ko" ? "프로젝트 장착 상태" : "Project attachment readiness"}</span>
              <select
                value={rosterReadiness}
                onChange={(event) => setRosterReadiness(event.target.value as typeof rosterReadiness)}
                style={{ width: "100%", minHeight: 44, padding: "0 10px", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", fontSize: 12 }}
              >
                <option value="all">{locale === "ko" ? "상태 · 전체" : "Status · All"}</option>
                <option value="ready">{locale === "ko" ? "상태 · 장착 가능" : "Status · Ready"}</option>
                <option value="attention">{locale === "ko" ? "상태 · 확인 필요" : "Status · Needs review"}</option>
              </select>
            </label>
          </div>
        )}

        {/* 조직도 목록 */}
        <div style={{ flex: 1, overflowY: "auto", padding: sidebarCollapsed ? "12px 6px" : 12 }}>
          {manageView === "published" ? (
            <PublishedAgentsRoster
              items={publishedAgents}
              loading={publishedLoading}
              signedIn={publishedSignedIn}
              installedSlugs={installedAgentSlugs}
              installedAgents={agents}
              installingSlug={publishedInstalling}
              collapsed={sidebarCollapsed}
              locale={locale}
              onSignIn={() => void signInForPublishedAgents()}
              onInstall={(slug) => void installPublishedAgent(slug)}
              onOpen={openInstalledAgent}
            />
          ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {(sidebarCollapsed || rosterTab === "all" || rosterTab === "multi") && visibleMultiFirms.map(firm => {
              const rOrg = resolvedOrgs[firm.id];
              const fLoc = pickLocalized(firm, locale);
              const isCollapsed = firmCollapsed[firm.id];
              return (
                <div key={firm.id}>
                  {!sidebarCollapsed && (
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: "var(--radius-sm)", background: selectedFirmId === firm.id ? "var(--fill-1)" : "var(--paper-2)", marginBottom: 8, minWidth: 0 }}
                    >
                      <button type="button" onClick={() => setFirmCollapsed(prev => ({ ...prev, [firm.id]: !isCollapsed }))} aria-label={isCollapsed ? "Expand team" : "Collapse team"} style={{ width: 44, height: 44, flexShrink: 0, border: 0, borderRadius: 8, background: "transparent", padding: 0, color: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                        <IconChevronDown size={14} style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.2s" }} />
                      </button>
                      <IconBuilding size={14} style={{ color: "var(--accent)" }} />
                      <button type="button" onClick={() => { setSelectedFirmId(firm.id); setSelectedNode(null); }} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", minWidth: 0, minHeight: 44, flex: 1, color: "inherit" }}>
                        <span title={fLoc.name} style={{ minWidth: 72, fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fLoc.name}</span>
                      </button>
                      {(() => {
                        // 파생 롤업: 팀 멤버들의 run 참여 합계(사용 원장 집계). 성공 점수가 아니다.
                        const totalUses = firmUsageRollup(firm);
                        return totalUses > 0 ? (
                          <span
                            data-firm-usage-rollup={totalUses}
                            title={locale === "ko" ? `팀 멤버 사용 합계 ${totalUses}회` : `Team members used ${totalUses} times in total`}
                            style={{ flexShrink: 0, fontSize: 9, fontWeight: 750, padding: "2px 6px", borderRadius: 999, background: "var(--fill-1)", color: "var(--muted-deep)" }}
                          >
                            {/* ★이름이 먼저다. 이 배지는 보조 수치인데 flexShrink:0 이라
                                좁은 사이드바에서 팀·에이전트 이름을 밀어내 "pit…" 처럼 잘랐다.
                                뜻은 title 에 그대로 두고 화면에는 숫자만 남긴다. */}
                            {totalUses}
                          </span>
                        ) : null;
                      })()}
                      <button
                        type="button"
                        aria-label={locale === "ko" ? `${fLoc.name} 팀 삭제` : `Delete ${fLoc.name} team`}
                        title={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from organization chart"}
                        onClick={(event) => { event.stopPropagation(); void removeInstalledFirm(firm); }}
                        style={{ width: 34, height: 34, flexShrink: 0, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--muted-deep)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                      >
                        <IconClose size={13} />
                      </button>
                    </div>
                  )}
                  {(!isCollapsed || sidebarCollapsed) && (
                    sidebarCollapsed ? (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                        {rOrg ? (
                          <>
                            {isVisibleResolvedNode(rOrg.ceo, agentMap) && (
                              <MiniNodeAvatar node={withAgentDisplayName(rOrg.ceo, agentMap, locale)} active={selectedFirmId === firm.id} onClick={() => { setSelectedFirmId(firm.id); setSelectedNode(null); }} />
                            )}
                            {rOrg.divisions
                              .filter((d) => isVisibleResolvedNode(d, agentMap) || d.specialists.some((s) => isVisibleResolvedNode(s, agentMap)))
                              .map((d) => (
                              <div key={d.id} style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                                {isVisibleResolvedNode(d, agentMap) && (
                                  <MiniNodeAvatar node={withAgentDisplayName(d, agentMap, locale)} active={selectedNode?.id === d.id} onClick={() => { setSelectedNode(withAgentDisplayName(d, agentMap, locale)); setActiveTab("identity"); }} />
                                )}
                                {d.specialists.filter((s) => isVisibleResolvedNode(s, agentMap)).map((s) => (
                                  <MiniNodeAvatar key={s.id} node={withAgentDisplayName(s, agentMap, locale)} active={selectedNode?.id === s.id} onClick={() => { setSelectedNode(withAgentDisplayName(s, agentMap, locale)); setActiveTab("identity"); }} />
                                ))}
                              </div>
                            ))}
                          </>
                        ) : (
                          firm.orgChart.filter((n) => isVisibleFirmOrgNode(n, agentMap)).map((n) => {
                            const agent = agentMap.get(n.agentId);
                            return (
                              <MiniNodeAvatar
                                key={n.agentSlug}
                                node={{ name: agent ? agentDisplayName(agent, locale) : n.role, role: n.role }}
                                active={selectedNode?.id === n.agentSlug}
                                onClick={() => {
                                  if (n.agentId === firm.ceoAgentId) {
                                    setSelectedFirmId(firm.id);
                                    setSelectedNode(null);
                                  } else {
                                    const resolved: ResolvedNode = { id: n.agentSlug, name: agent ? agentDisplayName(agent, locale) : n.role, role: n.role, agentId: n.agentId };
                                    setSelectedNode(resolved);
                                    setActiveTab("ontology");
                                  }
                                }}
                              />
                            );
                          })
                        )}
                      </div>
                    ) : (
                      <div style={{ paddingLeft: 12 }}>
                        <OrgChart
                          firm={firm}
                          agentMap={agentMap}
                          locale={locale}
                          selectedId={selectedNode?.id ?? null}
                          onSelect={(node) => {
                            if (node.agentId === firm.ceoAgentId) {
                              setSelectedFirmId(firm.id);
                              setSelectedNode(null);
                            } else {
                              setSelectedNode(node);
                              setActiveTab("ontology");
                            }
                          }}
                          onRemoveRoot={() => void removeInstalledFirm(firm)}
                        />
                      </div>
                    )
                  )}
                </div>
              );
            })}

            {(sidebarCollapsed || rosterTab === "all" || rosterTab === "multi") && visibleStandaloneTeams.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {!sidebarCollapsed && (
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 8 }}>
                    {t("library.agents.team_section")}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: sidebarCollapsed ? 0 : 12, alignItems: sidebarCollapsed ? "center" : "stretch" }}>
                  {visibleStandaloneTeams.map((a) => {
                    const loc = pickLocalized(a, locale);
                    const displayName = agentDisplayName(a, locale);
                    const isAct = selectedNode?.agentId === a.id;
                    if (sidebarCollapsed) {
                      return <MiniNodeAvatar key={a.id} node={{ name: displayName, role: loc.tagline }} active={isAct} onClick={() => {
                        setSelectedNode({ id: a.id, name: displayName, role: loc.tagline, agentId: a.id });
                        setActiveTab("identity");
                      }} />;
                    }
                    const expanded = !!teamExpanded[a.id];
                    const subs = teamSubs[a.id];
                    return (
                      <div key={a.id}>
                        <div
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer",
                            borderRadius: "var(--radius-md)", background: isAct ? "var(--fill-1)" : "transparent",
                            border: isAct ? "1px solid var(--accent)" : "1px solid transparent"
                          }}
                        >
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void toggleTeam(a.id); }}
                            title={expanded ? (locale === "ko" ? "접기" : "Collapse") : (locale === "ko" ? "하위 에이전트 펼치기" : "Show sub-agents")}
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: "var(--muted-deep)" }}
                          >
                            <IconChevronDown size={13} style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 0.2s" }} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedNode({ id: a.id, name: displayName, role: loc.tagline, agentId: a.id });
                              setActiveTab("identity");
                            }}
                            style={{ flex: 1, minWidth: 0, minHeight: 44, display: "flex", alignItems: "center", gap: 10, padding: 0, border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}
                          >
                            <AgentAvatar name={displayName} tone={a.tone} size={28} />
                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                <span title={displayName} style={{ minWidth: 72, flex: 1, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayName}</span>
                                <RosterUsageBadge usage={usageByAgentId.get(a.id)} frequent={isFrequentlyUsed(a.id)} locale={locale} />
                              </span>
                              <span style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.tagline}</span>
                            </div>
                          </button>
                          <IconLayers size={14} style={{ color: "var(--accent)" }} />
                          <button
                            type="button"
                            aria-label={locale === "ko" ? `${displayName} 팀 삭제` : `Delete ${displayName} team`}
                            title={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from organization chart"}
                            onClick={(e) => {
                              e.stopPropagation();
                              const firm = firms.find((item) => item.ceoAgentId === a.id) ?? null;
                              if (firm) void removeInstalledFirm(firm);
                              else void removeInstalledAgent(a);
                            }}
                            style={{ width: 34, height: 34, flexShrink: 0, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--muted-deep)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                          >
                            <IconClose size={13} />
                          </button>
                        </div>
                        {expanded && (
                          <div style={{ paddingLeft: 34, display: "flex", flexDirection: "column", gap: 3, marginTop: 2, marginBottom: 4 }}>
                            {subs === "loading" || subs === undefined ? (
                              <span style={{ fontSize: 11, color: "var(--muted-deep)", padding: "4px 0" }}>
                                {locale === "ko" ? "하위 에이전트 확인 중…" : "Resolving sub-agents…"}
                              </span>
                            ) : subs.length === 0 ? (
                              <span style={{ fontSize: 11, color: "var(--muted-deep)", padding: "4px 0" }}>
                                {locale === "ko" ? "하위 에이전트가 없습니다 (실제로는 싱글일 수 있어요)" : "No sub-agents (may actually be single)"}
                              </span>
                            ) : (
                              subs.map((s, i) => (
                                <div key={`${a.id}-sub-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                                  <span style={{ width: 20, textAlign: "center", color: "var(--muted-deep)", fontSize: 11 }}>└</span>
                                  <span style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                                  {s.role && s.role !== s.name ? (
                                    <span style={{ fontSize: 10.5, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>· {s.role}</span>
                                  ) : null}
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Independent Agents (싱글 탭) — 북마크 → 자주 씀 → 전체 섹션 */}
            {(sidebarCollapsed || rosterTab === "all" || rosterTab === "single") && (
            <div style={{ marginTop: 8 }} data-testid="single-roster-sections">
              {!sidebarCollapsed && rosterTab === "single" && visibleSingleAgents.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "8px 12px" }}>
                  {t("library.agents.single_empty")}
                </div>
              )}
              {sidebarCollapsed ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
                  {visibleSingleAgents.map(a => {
                    const loc = pickLocalized(a, locale);
                    const displayName = agentDisplayName(a, locale);
                    return <MiniNodeAvatar key={a.id} node={{ name: displayName, role: loc.tagline }} active={selectedNode?.agentId === a.id} onClick={() => {
                      setSelectedNode({ id: a.id, name: displayName, role: loc.tagline, agentId: a.id });
                      setActiveTab("identity");
                    }} />;
                  })}
                </div>
              ) : (() => {
                const bookmarked = visibleSingleAgents.filter((a) => isBookmarked(a));
                const frequent = visibleSingleAgents.filter((a) => !isBookmarked(a) && isFrequentlyUsed(a.id));
                const rest = visibleSingleAgents.filter((a) => !isBookmarked(a) && !isFrequentlyUsed(a.id));
                const sections = [
                  { key: "bookmarked", title: locale === "ko" ? "북마크" : "Bookmarked", agents: bookmarked },
                  { key: "frequent", title: locale === "ko" ? "자주 씀" : "Frequently used", agents: frequent },
                  { key: "all", title: t("library.agents.single_section"), agents: rest },
                ].filter((section) => section.agents.length > 0);
                return sections.map((section) => (
                  <div key={section.key} data-roster-section={section.key} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 6 }}>
                      {section.title}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12 }}>
                      {section.agents.map(a => {
                        const loc = pickLocalized(a, locale);
                        const displayName = agentDisplayName(a, locale);
                        const isAct = selectedNode?.agentId === a.id;
                        const usage = usageByAgentId.get(a.id);
                        const frequentAgent = isFrequentlyUsed(a.id);
                        const bookmarkedAgent = isBookmarked(a);
                        return (
                          <div
                            key={a.id}
                            style={{
                              display: "flex", alignItems: "center", gap: 4, padding: "4px 6px 4px 4px",
                              borderRadius: "var(--radius-md)", background: isAct ? "var(--fill-1)" : "transparent",
                              border: isAct ? "1px solid var(--accent)" : "1px solid transparent"
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedNode({ id: a.id, name: displayName, role: loc.tagline, agentId: a.id });
                                setActiveTab("identity");
                              }}
                              style={{ minWidth: 0, minHeight: 44, flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "4px 8px", border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}
                            >
                              <AgentAvatar name={displayName} tone={a.tone} size={28} />
                              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                  <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayName}</span>
                                  <RosterUsageBadge usage={usage} frequent={frequentAgent} locale={locale} />
                                </span>
                                <span style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.tagline}</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              aria-pressed={bookmarkedAgent}
                              aria-label={bookmarkedAgent
                                ? (locale === "ko" ? `${displayName} 북마크 해제` : `Remove bookmark for ${displayName}`)
                                : (locale === "ko" ? `${displayName} 북마크` : `Bookmark ${displayName}`)}
                              title={locale === "ko" ? "북마크" : "Bookmark"}
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggleBookmark(a.id, !bookmarkedAgent);
                              }}
                              style={{ flexShrink: 0, width: 44, height: 44, border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 16, lineHeight: 1, color: bookmarkedAgent ? "var(--amber-deep)" : "var(--muted-deep)" }}
                            >
                              {bookmarkedAgent ? "\u2605" : "\u2606"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}
            </div>
            )}
          </div>
          )}

          {/* Hub 북마크·최근 사용 — 설치 자산이 아닌 사용자별 read-only 경력 프로필.
              클릭은 Marketplace 검색이 아니라 이 사용자의 실행·메모리 상세를 연다. */}
          {!sidebarCollapsed && (normalizedRosterQuery || rosterSource !== "all" || rosterReadiness !== "all") && (
            rosterTab === "multi"
              ? visibleMultiFirms.length === 0 && visibleStandaloneTeams.length === 0
              : rosterTab === "single"
                ? visibleSingleAgents.length === 0
                : visibleMultiFirms.length === 0 && visibleStandaloneTeams.length === 0 && visibleSingleAgents.length === 0
          ) && visibleHubShelfRows.length === 0 && (
            <div role="status" style={{ padding: "20px 12px", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.55 }}>
              {normalizedRosterQuery
                ? (locale === "ko" ? `‘${rosterQuery.trim()}’과 일치하는 도구가 없습니다.` : `No tools match “${rosterQuery.trim()}”.`)
                : (locale === "ko" ? "선택한 출처와 장착 상태에 맞는 도구가 없습니다." : "No tools match the selected origin and attachment status.")}
            </div>
          )}

          {!sidebarCollapsed && visibleHubShelfRows.length > 0 && (
            <div data-roster-section="hub-shelf" style={{ marginTop: 8, borderTop: "1px solid var(--glass-border)", paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 6 }}>
                {locale === "ko" ? "Hub 북마크 · 최근 사용" : "Hub bookmarks · recently used"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12, paddingRight: 6 }}>
                {visibleHubShelfRows.map((row) => (
                  <button
                    type="button"
                    key={row.profileId}
                    title={row.slug}
                    onClick={() => {
                      setSelectedFirmId(null);
                      setSelectedNode(null);
                      setSelectedBorrowedProfileId(row.profileId);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: "var(--radius-md)", color: "var(--muted-deep)", border: "1px solid transparent", background: "transparent", cursor: "pointer", textAlign: "left", textDecoration: "none" }}
                  >
                    <IconLayers size={13} style={{ flexShrink: 0, color: "var(--accent)", opacity: row.entityKind === "team" ? 1 : 0.6 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.name}</span>
                    {row.bookmarked && (
                      <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 750, padding: "2px 6px", borderRadius: 999, border: "1px solid var(--accent)", color: "var(--accent)", background: "var(--paper)" }}>
                        {locale === "ko" ? "북마크" : "Bookmarked"}
                      </span>
                    )}
                    {row.useCount > 0 && (
                      <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 750, padding: "2px 6px", borderRadius: 999, border: "1px solid var(--paper-edge)", background: "var(--paper)" }}>
                        {locale === "ko" ? `빌림 · ${row.useCount}` : `Borrowed · ${row.useCount}`}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 사이드바 접기 하단 컨트롤 */}
        <footer style={{ borderTop: "1px solid var(--glass-border)", padding: 8, display: "flex", justifyContent: sidebarCollapsed ? "center" : "flex-end" }}>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed
              ? (locale === "ko" ? "에이전트 도구함 펼치기" : "Expand agent toolbox")
              : (locale === "ko" ? "에이전트 도구함 접기" : "Collapse agent toolbox")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted-deep)",
              width: 44,
              height: 44,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              borderRadius: 8,
            }}
          >
            <IconSidebar size={16} style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "none" }} />
          </button>
        </footer>

        {/* 리사이즈 드래그 핸들 */}
        {!sidebarCollapsed && (
          <div
            role="separator"
            aria-label={locale === "ko" ? "에이전트 도구함 너비" : "Agent toolbox width"}
            aria-orientation="vertical"
            aria-valuemin={200}
            aria-valuemax={500}
            aria-valuenow={orgWidth}
            tabIndex={0}
            onMouseDown={startResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -16 : 16;
              setOrgWidth((current) => {
                const next = Math.max(200, Math.min(500, current + delta));
                try {
                  window.localStorage.setItem("agentlas.firm.orgWidth", String(next));
                } catch {
                  // ignore
                }
                return next;
              });
            }}
            style={{
              position: "absolute",
              right: -3,
              top: 0,
              bottom: 0,
              width: 10,
              cursor: "col-resize",
              zIndex: 10,
            }}
          />
        )}
      </aside>

      {/* 2. 오른쪽 메인 콘텐츠 제어판 */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--paper-2)", overflow: "hidden", position: "relative" }}>
        
        {/* 토스트 알림창 */}
        {toastMsg && (
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              zIndex: 999,
              background: "var(--accent)",
              color: "var(--paper)",
              padding: "10px 18px",
              borderRadius: "var(--radius-md)",
              fontSize: 12.5,
              fontWeight: 600,
              boxShadow: "var(--glass-shadow-lift)",
            }}
          >
            {toastMsg}
          </div>
        )}

        {selectedBorrowedProfile ? (
          <BorrowedAgentDetailView
            profile={selectedBorrowedProfile}
            onBack={() => setSelectedBorrowedProfileId(null)}
          />
        ) : (selectedFirm || selectedStandaloneTeam) ? (
          <TeamDetailView
            agent={selectedFirmController ?? selectedStandaloneTeam}
            firm={selectedFirm ?? selectedStandaloneTeamFirm}
            resolvedOrg={selectedFirm
              ? resolvedOrgs[selectedFirm.id] ?? null
              : selectedStandaloneTeamFirm
                ? resolvedOrgs[selectedStandaloneTeamFirm.id] ?? null
                : null}
            agentMap={agentMap}
            exactBinding={selectedFirmControllerBinding ?? selectedStandaloneTeamBinding}
            projects={projects}
            activeProjectId={activeProjectId}
            locale={locale}
            onActiveProjectChange={setActiveProjectId}
            onAttach={() => {
              if (selectedFirm) void attachTeamToActiveProject(selectedFirm);
              else if (selectedStandaloneTeam) void attachStandaloneTeamToActiveProject(selectedStandaloneTeam);
            }}
            onRemove={() => {
              if (selectedFirm) void removeInstalledFirm(selectedFirm);
              else if (selectedStandaloneTeamFirm) void removeInstalledFirm(selectedStandaloneTeamFirm);
              else void removeInstalledAgent(selectedStandaloneTeam);
            }}
          />
        ) : selectedNode === null ? (
          /* A. 에이전트 미선택 시: 기존 회사 오버뷰 화면 */
          <div style={{ flex: 1, overflowY: "auto" }} data-tour-id="agents.detail">
            <header
              className="titlebar-drag"
              style={{
                padding: "16px 32px",
                minHeight: 56,
                borderBottom: "var(--hairline)",
                background: "var(--paper)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--fill-1)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <IconBuilding size={18} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {manageView === "published"
                    ? locale === "ko" ? "퍼블리시한 에이전트 관리" : "Published Agents"
                    : locale === "ko" ? "프로젝트용 에이전트 도구함" : "Project Agent Toolbox"}
                </h1>
              </div>
              <button
                onClick={() => manageView === "published" ? navigate("/cloud") : void importAgentFolder()}
                disabled={manageView !== "published" && importBusy}
                className="titlebar-nodrag"
                data-tour-id="agents.import"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 44,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid var(--accent)",
                  background: "var(--accent)",
                  color: "var(--white)",
                  fontSize: 12,
                  fontWeight: 750,
                  cursor: manageView !== "published" && importBusy ? "default" : "pointer",
                  opacity: manageView !== "published" && importBusy ? 0.72 : 1,
                }}
              >
                <IconFileUp size={14} />
                {manageView === "published"
                  ? locale === "ko" ? "에이전트 업로드" : "Upload agent"
                  : importBusy ? (locale === "ko" ? "가져오는 중..." : "Importing...") : locale === "ko" ? "에이전트 가져오기" : "Import agent"}
              </button>
            </header>

            <section style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}>
              <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.6 }}>
                {manageView === "published"
                  ? locale === "ko"
                    ? "왼쪽 목록에서 내가 agentlas.cloud에 퍼블리시한 에이전트를 확인하고, 로컬에 설치해 상세 관리로 이어갈 수 있습니다."
                    : "Select an agent you published on agentlas.cloud, install it locally, then manage it in the detail view."
                  : locale === "ko"
                    ? "작업은 프로젝트가 소유합니다. 이 화면에서는 팀과 싱글 에이전트의 구성·권한·경험 칩을 확인하고, 필요한 프로젝트의 도구함에 장착합니다."
                    : "Projects own the work. Inspect each team or single agent's composition, permissions, and Experience Chips here, then attach it to a project's tool pool."}
              </p>
              
              {manageView === "published" ? (
                <div style={{ padding: 22, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.6 }}>
                  {locale === "ko"
                    ? "퍼블리시 목록은 계정 기준입니다. 아직 목록이 비어 있다면 오른쪽 위 업로드 버튼으로 로컬 에이전트 폴더를 먼저 등록하세요."
                    : "Published agents are account-based. If the list is empty, use Upload agent to register a local agent folder first."}
                </div>
              ) : (
              <>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(240px, .65fr)", gap: 16 }}>
                <section style={{ padding: 18, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
                  <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 6px", display: "flex", alignItems: "center", gap: 7 }}>
                    <IconLayers size={15} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "프로젝트별 장착 상태" : "Attached by project"}
                  </h2>
                  <p style={{ margin: "0 0 14px", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.55 }}>
                    {locale === "ko" ? "프로젝트가 작업·기억·산출물을 소유하고, 아래 에이전트 풀은 그 프로젝트가 사용할 도구 목록입니다." : "The project owns work, memory, and outputs; its agent pool is the set of tools available to that project."}
                  </p>
                  {projects.length === 0 ? (
                    <button type="button" onClick={() => navigate("/project/new")} className="agent-run-button">{locale === "ko" ? "첫 프로젝트 만들기" : "Create first project"}</button>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {projects.slice(0, 8).map((project) => (
                        <button key={project.id} type="button" onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)} style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 10, padding: "7px 4px", border: 0, borderTop: "1px solid var(--paper-edge)", background: "transparent", color: "var(--ink)", cursor: "pointer", textAlign: "left" }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>
                          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{locale === "ko" ? `도구 ${project.agentPool.length}개` : `${project.agentPool.length} tools`}</span>
                          <IconChevronRight size={14} style={{ color: "var(--muted)" }} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                <aside style={{ padding: 18, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper-2)" }}>
                  <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>{locale === "ko" ? "시스템 에이전트는 별도" : "System agents stay separate"}</h2>
                  <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.6 }}>
                    {locale === "ko"
                      ? "PM Soul·Memory Curator·Task Bias는 OS에 상주합니다. 팀이나 싱글 패키지에 복사하거나 사용자가 프로젝트 도구로 장착하지 않습니다."
                      : "PM Soul, Memory Curator, and Task Bias live in the OS. They are not copied into packages or attached as user-selectable project tools."}
                  </p>
                </aside>
              </div>
              </>
              )}
            </section>
          </div>
        ) : (
          /* B. 에이전트 노드 선택 시: 에이전트 상세 통제 센터 */
          <AgentDetailView
            node={selectedNode}
            agent={agents.find((a) => a.id === selectedNode.agentId) ?? null}
            agentFiles={agentFiles}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onBackToOverview={() => setSelectedNode(null)}
            memoryParsed={memoryParsed}
            memoryEntries={memoryEntries}
            evolutionProposals={evolutionProposals}
            onSaveMemory={saveMemory}
            promptContent={promptContent}
            onCreateEvolution={createEvolutionProposal}
            onApproveEvolution={approveEvolutionProposal}
            onRejectEvolution={rejectEvolutionProposal}
            onRollbackEvolution={rollbackEvolutionProposal}
            saving={savingFiles}
            ontologyInbox={ontologyInbox}
            onSetOntologyInbox={setOntologyInbox}
            showToast={showToast}
            runtimeStatuses={runtimeStatuses}
            runtimeOverrides={runtimeOverrides}
            nodeContext={selectedContext}
            projects={projects}
            exactBinding={exactBindings.find((binding) => binding.installedAgentId === selectedNode.agentId) ?? null}
            activeProjectId={activeProjectId}
            onActiveProjectChange={setActiveProjectId}
            onAttachToProject={(agent) => void attachAgentToActiveProject(agent)}
            onRuntimeOverridesChange={setRuntimeOverrides}
            onSaveAlias={(value) => {
              const current = agents.find((item) => item.id === selectedNode.agentId);
              return current ? saveLocalDisplayName(current, value) : Promise.resolve();
            }}
            onRemoveAgent={() => void removeInstalledAgent(agents.find((a) => a.id === selectedNode.agentId) ?? null)}
          />
        )}
      </main>
    </div>
  );
}

interface TeamDetailViewProps {
  agent: InstalledAgent | null;
  firm: InstalledFirm | null;
  resolvedOrg: ResolvedOrg | null;
  agentMap: Map<string, InstalledAgent>;
  exactBinding: InstalledAgentExactBinding | null;
  projects: Project[];
  activeProjectId: string;
  locale: Locale;
  onActiveProjectChange: (projectId: string) => void;
  onAttach: () => void;
  onRemove: () => void;
}

function teamSourceLabel(agent: InstalledAgent | null, locale: Locale): string {
  if (agent?.assetSource === "agent-cloud") return "Agent Cloud";
  if (agent?.assetSource === "hub") return "Agentlas Hub";
  return locale === "ko" ? "로컬 가져오기" : "Local import";
}

function firmToResolvedOrg(firm: InstalledFirm): ResolvedOrg | null {
  const ceo = firm.orgChart.find((node) => node.reportsTo === null) ?? firm.orgChart[0];
  if (!ceo) return null;
  const toNode = (node: InstalledFirm["orgChart"][number]): ResolvedNode => ({
    id: node.agentSlug,
    name: node.role || node.agentSlug,
    role: node.role,
    agentId: node.agentId,
  });
  const divisions = firm.orgChart
    .filter((node) => node.reportsTo === ceo.agentSlug)
    .map((division) => ({
      ...toNode(division),
      specialists: firm.orgChart
        .filter((node) => node.reportsTo === division.agentSlug)
        .map(toNode),
    }));
  return {
    source: "orgchart",
    ceo: toNode(ceo),
    divisions,
  };
}

function TeamDetailView({
  agent,
  firm,
  resolvedOrg,
  agentMap,
  exactBinding,
  projects,
  activeProjectId,
  locale,
  onActiveProjectChange,
  onAttach,
  onRemove,
}: TeamDetailViewProps) {
  const [tab, setTab] = useState<"description" | "metadata">("description");
  const loc = firm ? pickLocalized(firm, locale) : agent ? pickLocalized(agent, locale) : { name: "Team", tagline: "" };
  const org = resolvedOrg ?? (firm ? firmToResolvedOrg(firm) : null);
  const slotCount = firm?.orgChart.filter((node) => isUserFacingAgentText(node.agentSlug, node.role)).length ?? (agent ? 1 : 0);
  const boundCount = firm?.orgChart.filter((node) => isUserFacingAgentText(node.agentSlug, node.role) && agentMap.has(node.agentId)).length ?? (agent ? 1 : 0);
  const source = teamSourceLabel(agent, locale);
  const memberExperienceNodes = firm?.orgChart.filter((node) => node.agentId && node.agentId !== firm.ceoAgentId && agentMap.has(node.agentId)) ?? [];

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }} data-testid="canonical-package-team-detail" data-unified-team-detail="true" data-tour-id="agents.detail">
      <header className="titlebar-drag" style={{ padding: "16px 32px", minHeight: 56, borderBottom: "var(--hairline)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--fill-1)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <IconLayers size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{loc.name}</h1>
          <p style={{ margin: "3px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>{locale === "ko" ? "프로젝트에 장착하는 팀 도구" : "A team tool attached to projects"}</p>
        </div>
        <span style={{ flexShrink: 0, padding: "4px 8px", borderRadius: 999, background: "var(--fill-1)", color: "var(--muted-deep)", fontSize: 10, fontWeight: 700 }}>{source}</span>
        <button type="button" onClick={onRemove} aria-label={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from organization chart"} title={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from organization chart"} style={{ width: 40, height: 40, border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper)", color: "var(--muted-deep)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <IconClose size={14} />
        </button>
      </header>

      <nav data-testid="team-detail-tabs" style={{ display: "flex", gap: 4, padding: "8px 32px", background: "var(--paper)", borderBottom: "var(--hairline)" }}>
        {(["description", "metadata"] as const).map((item) => {
          const active = tab === item;
          return (
            <button key={item} type="button" onClick={() => setTab(item)} aria-current={active ? "page" : undefined} style={{ minHeight: 44, padding: "8px 16px", border: 0, borderRadius: 8, background: active ? "var(--accent-soft)" : "transparent", color: active ? "var(--accent)" : "var(--ink-soft)", fontSize: 12.5, fontWeight: active ? 750 : 500, cursor: "pointer" }}>
              {item === "description" ? (locale === "ko" ? "디스크립션" : "Description") : (locale === "ko" ? "메타데이터" : "Metadata")}
            </button>
          );
        })}
      </nav>

      <section style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
        {tab === "description" ? (
          <>
            <div style={{ padding: 20, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>{locale === "ko" ? "팀 디스크립션" : "Team description"}</h2>
              <p style={{ margin: "8px 0 0", color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.65 }}>
                {loc.tagline || (locale === "ko" ? "이 팀은 CEO → HQ → 전문가 순서로 작업을 분배합니다." : "This team distributes work through a CEO → HQ → specialist hierarchy.")}
              </p>
              {firm?.persona && <p style={{ margin: "10px 0 0", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.6 }}>{firm.persona}</p>}
              <p style={{ margin: "12px 0 0", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.6 }}>
                {locale === "ko" ? "팀은 프로젝트에서 하나의 도구로 장착되며, 아래 조직도는 실제 연결된 구성원과 역할을 그대로 보여줍니다." : "The team attaches as one project tool; the org chart below shows its actual connected members and roles."}
              </p>
            </div>
            <div style={{ padding: 20, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 15 }}>{locale === "ko" ? "CEO → HQ → 전문가 조직도" : "CEO → HQ → specialist org chart"}</h2>
                <span style={{ color: "var(--muted-deep)", fontSize: 11 }}>{locale === "ko" ? "실제 연결 상태" : "Actual binding state"}</span>
              </div>
              {org ? (
                <div style={{ marginTop: 14 }}>
                  <ResolvedOrgChart
                    org={org}
                    agentMap={agentMap}
                    locale={locale}
                    selectedId={null}
                    onSelect={() => undefined}
                    onRemoveRoot={onRemove}
                  />
                </div>
              ) : firm ? (
                <div style={{ marginTop: 14 }}>
                  <OrgChart
                    firm={firm}
                    agentMap={agentMap}
                    locale={locale}
                    selectedId={null}
                    onSelect={() => undefined}
                    onRemoveRoot={onRemove}
                  />
                </div>
              ) : (
                <p style={{ margin: "14px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>{locale === "ko" ? "이 팀에는 아직 저장된 조직도가 없습니다." : "This team has no stored org chart yet."}</p>
              )}
              {memberExperienceNodes.length > 0 && (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--paper-edge)" }}>
                  <p style={{ margin: "0 0 8px", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}>
                    {locale === "ko" ? "멤버의 경험은 팀에 복사하지 않고 각 멤버 자산에서 확인합니다." : "Member experience stays with each member asset instead of being copied into the team."}
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {memberExperienceNodes.map((node) => {
                      const member = agentMap.get(node.agentId);
                      if (!member) return null;
                      return (
                        <Link
                          key={node.agentId}
                          href={`/library/agents?agentId=${encodeURIComponent(node.agentId)}&tab=ontology&firmId=${encodeURIComponent(firm!.id)}`}
                          style={{ display: "inline-flex", alignItems: "center", minHeight: 36, padding: "0 10px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--accent)", fontSize: 11.5, fontWeight: 700, textDecoration: "none" }}
                        >
                          {agentDisplayName(member, locale)} · {locale === "ko" ? "Experience Chips 보기" : "View Experience Chips"}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ padding: 20, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>{locale === "ko" ? "팀 메타데이터" : "Team metadata"}</h2>
            <p style={{ margin: "8px 0 16px", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.6 }}>
              {locale === "ko" ? "CEO를 별도 에이전트 버튼으로 복제하지 않습니다. 이 팀의 신원·릴리스·출처는 한 화면에서 확인합니다." : "The CEO is not duplicated as a separate agent button. This screen is the single source for the team's identity, release, and origin."}
            </p>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "150px 1fr", gap: "9px 12px", fontSize: 12 }}>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "로컬 팀 ID" : "Local team ID"}</dt><dd style={{ margin: 0 }}>{firm?.id ?? agent?.id ?? "—"}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "팀 슬러그" : "Team slug"}</dt><dd style={{ margin: 0 }}>{firm?.slug ?? agent?.slug ?? "—"}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>Definition ID</dt><dd style={{ margin: 0 }}>{exactBinding?.agentDefinitionId ?? (locale === "ko" ? "확인 필요" : "Verification required")}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "정확한 릴리스" : "Exact release"}</dt><dd style={{ margin: 0 }}>{exactBinding?.agentReleaseId ?? (locale === "ko" ? "확인 필요 · 장착 차단" : "Verification required · attachment blocked")}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "실행 컨트롤러" : "Execution controller"}</dt><dd style={{ margin: 0 }}>{agent ? agentDisplayName(agent, locale) : "—"}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "원본 출처" : "Origin"}</dt><dd style={{ margin: 0 }}>{source}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "패키지 해시" : "Package hash"}</dt><dd style={{ margin: 0 }}>{agent?.packageHash ?? (locale === "ko" ? "기록 없음" : "Not recorded")}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "사용자용 조직 자리" : "User-facing slots"}</dt><dd style={{ margin: 0 }}>{slotCount}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "실제 연결됨" : "Bound agents"}</dt><dd style={{ margin: 0 }}>{boundCount}</dd>
            </dl>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <ProjectAttachControl
            projects={projects}
            projectId={activeProjectId}
            entityKind="team"
            localTargetId={firm?.id ?? agent?.id}
            locale={locale}
            disabled={!agent || (agent.assetSource !== "local-import" && !exactBinding)}
            onProjectChange={onActiveProjectChange}
            onAttach={onAttach}
          />
          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{locale === "ko" ? `${source} · 팀 전체 장착` : `${source} · attach the whole team`}</span>
        </div>
      </section>
    </div>
  );
}

function PublishedAgentsRoster({
  items,
  loading,
  signedIn,
  installedSlugs,
  installedAgents,
  installingSlug,
  collapsed,
  locale,
  onSignIn,
  onInstall,
  onOpen,
}: {
  items: MarketplaceListing[];
  loading: boolean;
  signedIn: boolean | null;
  installedSlugs: Set<string>;
  installedAgents: InstalledAgent[];
  installingSlug: string | null;
  collapsed: boolean;
  locale: Locale;
  onSignIn: () => void;
  onInstall: (slug: string) => void;
  onOpen: (agent: InstalledAgent) => void;
}) {
  const ko = locale === "ko";

  if (loading) {
    return (
      <div style={{ padding: collapsed ? "10px 0" : 14, fontSize: 12, color: "var(--muted-deep)", textAlign: collapsed ? "center" : "left", display: "grid", gap: 5 }}>
        <span>{ko ? "불러오는 중..." : "Loading..."}</span>
        {!collapsed && <LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-agent-library" expectedSeconds={[1, 25]} />}
      </div>
    );
  }

  if (signedIn === false) {
    return (
      <div style={{ padding: collapsed ? "8px 2px" : 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {!collapsed && (
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            {ko ? "agentlas.cloud 계정으로 로그인하면 내가 퍼블리시한 에이전트를 볼 수 있습니다." : "Sign in to see the agents you published on agentlas.cloud."}
          </div>
        )}
        <button
          type="button"
          onClick={onSignIn}
          style={{
            minHeight: 44,
            borderRadius: 8,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--white)",
            fontSize: 12,
            fontWeight: 750,
            cursor: "pointer",
          }}
        >
          {collapsed ? "↗" : ko ? "로그인" : "Sign in"}
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: collapsed ? "10px 0" : 14, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5, textAlign: collapsed ? "center" : "left" }}>
        {collapsed ? "0" : ko ? "아직 퍼블리시한 에이전트가 없습니다." : "No published agents yet."}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        {items.map((item) => {
          const installed = installedAgents.find((agent) => agent.slug === item.slug);
          const loc = pickLocalized(item, locale);
          return (
            <MiniNodeAvatar
              key={item.slug}
              node={{ name: loc.name, role: loc.tagline }}
              active={false}
              onClick={() => installed ? onOpen(installed) : onInstall(item.slug)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 4px 2px" }}>
        {ko ? `퍼블리시 ${items.length}개` : `${items.length} published`}
      </div>
      {items.map((item) => {
        const loc = pickLocalized(item, locale);
        const installed = installedAgents.find((agent) => agent.slug === item.slug);
        const isInstalled = installedSlugs.has(item.slug);
        const busy = installingSlug === item.slug;
        return (
          <div
            key={item.slug}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 10px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
            }}
          >
            <AgentAvatar name={loc.name} tone={item.trustGrade === "A" ? "green" : "blue"} size={28} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
              <span style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.tagline}</span>
            </div>
            <button
              type="button"
              onClick={() => onInstall(item.slug)}
              disabled={busy}
              style={{
                minHeight: 44,
                padding: "0 9px",
                borderRadius: 7,
                border: `1px solid ${isInstalled ? "var(--paper-edge)" : "var(--accent)"}`,
                background: isInstalled ? "var(--paper-2)" : "var(--accent)",
                color: isInstalled ? "var(--ink)" : "var(--white)",
                fontSize: 11.5,
                fontWeight: 750,
                cursor: busy ? "default" : "pointer",
                flexShrink: 0,
              }}
            >
              {busy
                ? isInstalled ? (ko ? "복원 중" : "Restoring") : (ko ? "설치 중" : "Installing")
                : isInstalled ? (ko ? "Cloud에서 복원" : "Restore from Cloud") : (ko ? "설치" : "Install")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── 미니 사이드바 노드 아바타 ────────────────────────────
function MiniNodeAvatar({ node, active, onClick }: { node: { name: string; role?: string }; active: boolean; onClick: () => void }) {
  const letters = node.name.slice(0, 2).toUpperCase();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={node.role ? `${node.name} · ${node.role}` : node.name}
      aria-pressed={active}
      title={`${node.name} (${node.role ?? ""})`}
      style={{
        width: 44,
        height: 44,
        borderRadius: 8,
        background: active ? "var(--accent)" : "var(--paper)",
        color: active ? "var(--paper)" : "var(--ink)",
        border: active ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        fontWeight: 700,
        boxShadow: "var(--shadow-1)",
      }}
    >
      {letters}
    </button>
  );
}

// ── 정규화된 3-tier 조직 렌더 (사이드바 내부) ──────────
function ResolvedOrgChart({
  org,
  agentMap,
  locale,
  selectedId,
  onSelect,
  onRemoveRoot,
}: {
  org: ResolvedOrg;
  agentMap: Map<string, InstalledAgent>;
  locale: Locale;
  selectedId: string | null;
  onSelect: (node: ResolvedNode) => void;
  onRemoveRoot?: () => void;
}) {
  const visibleDivisions = org.divisions.filter(
    (division) =>
      isVisibleResolvedNode(division, agentMap) ||
      division.specialists.some((specialist) => isVisibleResolvedNode(specialist, agentMap)),
  );
  const showCeo = isVisibleResolvedNode(org.ceo, agentMap);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {showCeo && (
        <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <OrgNodeCard node={withAgentDisplayName(org.ceo, agentMap, locale)} tier={1} active={selectedId === org.ceo.id} onClick={() => onSelect(withAgentDisplayName(org.ceo, agentMap, locale))} />
          </div>
          {onRemoveRoot && (
            <button
              type="button"
              data-testid="org-chart-delete-root"
              aria-label={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from org chart"}
              title={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from org chart"}
              onClick={onRemoveRoot}
              style={{ width: 36, minHeight: 36, alignSelf: "stretch", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", background: "var(--paper)", color: "var(--muted-deep)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              <IconClose size={13} />
            </button>
          )}
        </div>
      )}
      {visibleDivisions.map((d) => {
        const visibleSpecialists = d.specialists.filter((specialist) => isVisibleResolvedNode(specialist, agentMap));
        const showDivision = isVisibleResolvedNode(d, agentMap);
        return (
        <div key={d.id}>
          {showDivision ? (
            <OrgNodeCard node={withAgentDisplayName(d, agentMap, locale)} tier={2} active={selectedId === d.id} onClick={() => onSelect(withAgentDisplayName(d, agentMap, locale))} />
          ) : (
            <OrgGroupLabel node={d} />
          )}
          {visibleSpecialists.length > 0 && (
            <div
              style={{
                marginLeft: 16,
                paddingLeft: 10,
                borderLeft: "1px solid var(--paper-edge)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                marginTop: 6,
              }}
            >
              {visibleSpecialists.map((s) => (
                <OrgNodeCard key={s.id} node={withAgentDisplayName(s, agentMap, locale)} tier={3} active={selectedId === s.id} onClick={() => onSelect(withAgentDisplayName(s, agentMap, locale))} />
              ))}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

function OrgGroupLabel({ node }: { node: ResolvedNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", color: "var(--muted-deep)" }}>
      <span style={{ width: 26, height: 1, background: "var(--paper-edge)", flexShrink: 0 }} />
      <strong style={{ fontSize: 11.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</strong>
      <span style={{ marginLeft: "auto", fontSize: 9.5, fontFamily: "var(--font-mono)" }}>HQ</span>
    </div>
  );
}

function OrgNodeCard({ node, tier, active, onClick }: { node: ResolvedNode; tier: 1 | 2 | 3; active: boolean; onClick: () => void }) {
  const isCeo = tier === 1;
  const roleLabel = readableRoleLabel(node.role, node.name);
  return (
    <button
      type="button"
      onClick={onClick}
      title={[node.name, roleLabel].filter(Boolean).join(" - ")}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        background: active ? "var(--accent-soft)" : isCeo ? "var(--fill-1)" : "var(--paper)",
        border: active ? "1px solid var(--accent)" : isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
      }}
    >
      <div
        style={{
          width: tier === 3 ? 20 : 26,
          height: tier === 3 ? 20 : 26,
          borderRadius: 6,
          background: isCeo ? "linear-gradient(135deg, var(--accent), var(--blue))" : "var(--paper-2)",
          color: isCeo ? "var(--white)" : "var(--ink-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: tier === 3 ? 9 : 10,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {node.name.slice(0, 1).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, minWidth: 0 }}>
          <strong style={{ ...rosterNameStyle, fontSize: tier === 3 ? 11.5 : 12.5, color: "var(--ink)", fontWeight: 750 }}>
            {node.name}
          </strong>
          {roleLabel && (
            <span style={{ maxWidth: "100%", fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--paper-2)", color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {roleLabel}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function isVisibleResolvedNode(node: ResolvedNode, agentMap: Map<string, InstalledAgent>): boolean {
  if (!isUserFacingAgentText(node.name, node.role)) return false;
  if (!node.agentId) return true;
  const agent = agentMap.get(node.agentId);
  // Team members are hidden from the top-level roster, but they must remain
  // visible inside their owning team's org chart.
  return Boolean(agent && (agent.parentTeamId ? agent.visibility !== "private" : isRosterVisibleAgent(agent)));
}

function withAgentDisplayName(node: ResolvedNode, agentMap: Map<string, InstalledAgent>, locale: Locale): ResolvedNode {
  const agent = node.agentId ? agentMap.get(node.agentId) : null;
  return agent ? { ...node, name: agentDisplayName(agent, locale) } : node;
}

function isVisibleFirmOrgNode(
  node: InstalledFirm["orgChart"][number],
  agentMap: Map<string, InstalledAgent>,
): boolean {
  if (!isUserFacingAgentText(node.agentSlug, node.role)) return false;
  const agent = agentMap.get(node.agentId);
  return Boolean(agent && (agent.parentTeamId ? agent.visibility !== "private" : isRosterVisibleAgent(agent)));
}

// ── 일반 트리 재귀 렌더 (사이드바 내부) ─────────────────
function OrgChart({
  firm,
  agentMap,
  locale,
  selectedId,
  onSelect,
  onRemoveRoot,
}: {
  firm: InstalledFirm;
  agentMap: Map<string, InstalledAgent>;
  locale: Locale;
  selectedId: string | null;
  onSelect: (node: ResolvedNode) => void;
  onRemoveRoot?: () => void;
}) {
  const ceo = firm.orgChart.find((n) => n.reportsTo === null);
  if (!ceo) return <div style={{ fontSize: 12, color: "var(--muted)" }}>{locale === "ko" ? "조직도가 비어있습니다." : "The org chart is empty."}</div>;

  function children(parentSlug: string) {
    return firm.orgChart.filter((n) => n.reportsTo === parentSlug && isVisibleFirmOrgNode(n, agentMap));
  }

  function renderNode(node: typeof firm.orgChart[number], depth: number): React.ReactNode {
    const agent = agentMap.get(node.agentId);
    const agentLoc = agent ? pickLocalized(agent, locale) : null;
    const kids = children(node.agentSlug);
    const isCeo = node.reportsTo === null;
    const active = selectedId === node.agentSlug;
    const displayName = agent ? agentDisplayName(agent, locale) : agentLoc?.name ?? node.role;
    const roleLabel = readableRoleLabel(node.role, displayName, agent?.slug ?? node.agentSlug);

    const resolved: ResolvedNode = {
      id: node.agentSlug,
      name: displayName,
      role: node.role,
      agentId: node.agentId,
    };

    return (
      <div key={node.agentSlug} style={{ marginTop: depth === 0 ? 0 : 6 }}>
        <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
          <button
            type="button"
            onClick={() => onSelect(resolved)}
            title={[displayName, roleLabel].filter(Boolean).join(" - ")}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "8px 10px",
              background: active ? "var(--accent-soft)" : isCeo ? "var(--fill-1)" : "var(--paper)",
              border: active ? "1px solid var(--accent)" : isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              transition: "all 0.15s ease",
              color: "inherit",
              font: "inherit",
              textAlign: "left",
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: isCeo ? "linear-gradient(135deg, var(--accent), var(--blue))" : "var(--paper-2)",
                color: isCeo ? "var(--white)" : "var(--ink-soft)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, minWidth: 0 }}>
                <strong style={{ ...rosterNameStyle, fontSize: 12, color: "var(--ink)", fontWeight: 750 }}>
                  {displayName}
                </strong>
                {roleLabel && (
                  <span style={{ maxWidth: "100%", fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--paper-2)", color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {roleLabel}
                  </span>
                )}
              </div>
            </div>
          </button>
          {isCeo && onRemoveRoot && (
            <button
              type="button"
              data-testid="org-chart-delete-root"
              aria-label={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from org chart"}
              title={locale === "ko" ? "조직도에서 팀 삭제" : "Delete team from org chart"}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveRoot();
              }}
              style={{ width: 36, minHeight: 36, alignSelf: "stretch", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", background: "var(--paper)", color: "var(--muted-deep)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              <IconClose size={13} />
            </button>
          )}
        </div>
        {kids.length > 0 && (
          <div
            style={{
              marginLeft: 16,
              paddingLeft: 10,
              borderLeft: "1px dashed var(--paper-edge)",
              marginTop: 4,
            }}
          >
            {kids.map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  if (isVisibleFirmOrgNode(ceo, agentMap)) return renderNode(ceo, 0);
  const visibleRoots = children(ceo.agentSlug);
  if (visibleRoots.length === 0) return <div style={{ fontSize: 12, color: "var(--muted)" }}>{locale === "ko" ? "표시할 에이전트가 없습니다." : "No agents to display."}</div>;
  return <>{visibleRoots.map((node) => renderNode(node, 0))}</>;
}

type SelectedNodeContext = {
  firm: InstalledFirm | null;
  division: ResolvedNode | null;
  isDivision: boolean;
};

function findResolvedNode(org: ResolvedOrg, matches: (node: ResolvedNode) => boolean): ResolvedNode | null {
  if (matches(org.ceo)) return org.ceo;
  for (const division of org.divisions) {
    if (matches(division)) return division;
    const specialist = division.specialists.find(matches);
    if (specialist) return specialist;
  }
  return null;
}

function findAgentRouteNode({
  agentId,
  nodeId,
  firmId,
  firms,
  agents,
  resolvedOrgs,
  locale,
}: {
  agentId: string;
  nodeId: string;
  firmId: string;
  firms: InstalledFirm[];
  agents: InstalledAgent[];
  resolvedOrgs: Record<string, ResolvedOrg>;
  locale: Locale;
}): ResolvedNode | null {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const matches = (node: ResolvedNode) =>
    isVisibleResolvedNode(node, agentMap) &&
    Boolean((agentId && node.agentId === agentId) || (nodeId && node.id === nodeId));
  const scopedFirms = firmId ? firms.filter((firm) => firm.id === firmId) : firms;

  for (const firm of scopedFirms) {
    const resolved = resolvedOrgs[firm.id];
    if (resolved) {
      const node = findResolvedNode(resolved, matches);
      if (node) return withAgentDisplayName(node, agentMap, locale);
    }

    const raw = firm.orgChart.find(
      (node) =>
        (agentId && node.agentId === agentId) ||
        (nodeId && (node.agentSlug === nodeId || node.role === nodeId)),
    );
    if (raw && isVisibleFirmOrgNode(raw, agentMap)) {
      const agent = agents.find((item) => item.id === raw.agentId);
      const localized = agent ? pickLocalized(agent, locale) : null;
      return {
        id: raw.agentSlug,
        name: agent ? agentDisplayName(agent, locale) : localized?.name ?? raw.role,
        role: raw.role,
        agentId: raw.agentId,
      };
    }
  }

  if (agentId) {
    const agent = agents.find((item) => item.id === agentId);
    if (agent) {
      const localized = pickLocalized(agent, locale);
      return {
        id: agent.id,
        name: agentDisplayName(agent, locale),
        role: localized.tagline,
        agentId: agent.id,
      };
    }
  }

  return null;
}

function nodeMatches(candidate: ResolvedNode, selected: ResolvedNode): boolean {
  return (
    candidate.id === selected.id ||
    (!!candidate.agentId && candidate.agentId === selected.agentId) ||
    (!!selected.agentId && candidate.id === selected.agentId)
  );
}

function divisionTargetId(firmId: string, divisionId: string): string {
  return `${firmId}:${divisionId}`;
}

function findSelectedNodeContext(
  selected: ResolvedNode,
  firms: InstalledFirm[],
  orgs: Record<string, ResolvedOrg>,
): SelectedNodeContext {
  for (const firm of firms) {
    const org = orgs[firm.id];
    if (org) {
      if (nodeMatches(org.ceo, selected)) return { firm, division: null, isDivision: false };
      for (const division of org.divisions) {
        if (nodeMatches(division, selected)) return { firm, division, isDivision: true };
        if (division.specialists.some((specialist) => nodeMatches(specialist, selected))) {
          return { firm, division, isDivision: false };
        }
      }
    }

    const rawNode = firm.orgChart.find(
      (node) => node.agentSlug === selected.id || (!!selected.agentId && node.agentId === selected.agentId),
    );
    if (rawNode) {
      const children = firm.orgChart.filter((node) => node.reportsTo === rawNode.agentSlug);
      const parent = rawNode.reportsTo
        ? firm.orgChart.find((node) => node.agentSlug === rawNode.reportsTo)
        : null;
      const parentAsDivision = parent && parent.reportsTo !== null
        ? { id: parent.agentSlug, name: parent.role, role: parent.role, agentId: parent.agentId }
        : null;
      return {
        firm,
        division: children.length > 0
          ? { id: rawNode.agentSlug, name: rawNode.role, role: rawNode.role, agentId: rawNode.agentId }
          : parentAsDivision,
        isDivision: children.length > 0,
      };
    }
  }
  return { firm: null, division: null, isDivision: false };
}

function MetricMini({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", padding: "8px 10px" }}>
      <div style={{ fontSize: 10.5, color: "var(--muted-deep)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 750, color: "var(--ink)" }}>{value}</div>
    </div>
  );
}

// ── 3.5 정보 흐름 연결 맵 (Information Flow Mapper) ──
// upstream/downstream 은 우선 Hephaestus AO(Agent Ontology) 그래프의 실제 produces/consumes
// 엣지에서 도출하고, 그래프가 없으면 역할 휴리스틱으로 폴백한다.
function flowHeuristic(role: string): { upstream: string; downstream: string } {
  const r = role.toLowerCase();
  if (r.includes("ceo") || r.includes("orchestrator") || role.includes("오케스트")) return { upstream: "User / Hub request", downstream: "Specialist agents" };
  if (r.includes("pm") || r.includes("planner") || role.includes("기획")) return { upstream: "Orchestrator", downstream: "Worker agents" };
  if (r.includes("research") || role.includes("리서치")) return { upstream: "Brief / query", downstream: "Synthesis agent" };
  if (r.includes("qa") || r.includes("review") || role.includes("검증")) return { upstream: "Worker output", downstream: "Approval / delivery" };
  if (r.includes("deploy") || r.includes("publish") || role.includes("배포")) return { upstream: "Verified package", downstream: "Cloud / Hub" };
  return { upstream: "Chat / Team route", downstream: "Workspace output" };
}

/** AO 그래프 JSON 에서 이 노드의 upstream(공급자)/downstream(수신자)를 도출. 못 찾으면 null. */
function flowFromAoGraph(graph: unknown, node: ResolvedNode): { upstream: string; downstream: string } | null {
  if (!graph || typeof graph !== "object") return null;
  const g = graph as Record<string, unknown>;
  const edges = (g.edges ?? g.relations ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const me = (node.agentId ?? node.id ?? node.name ?? "").toLowerCase();
  const role = node.role.toLowerCase();
  const matches = (v: unknown) => {
    const s = String(v ?? "").toLowerCase();
    return s && (s === me || (me && s.includes(me)) || (role && s.includes(role)));
  };
  let upstream = "";
  let downstream = "";
  for (const e of edges) {
    const type = String(e.type ?? e.kind ?? e.rel ?? "").toLowerCase();
    const from = e.from ?? e.source ?? e.src;
    const to = e.to ?? e.target ?? e.dst;
    // produces/consumes/feeds 류 엣지에서 방향 도출
    if (type.includes("consume") || type.includes("depends") || type.includes("input")) {
      if (matches(from) && !downstream) downstream = String(to);
      if (matches(to) && !upstream) upstream = String(from);
    } else if (type.includes("produce") || type.includes("feed") || type.includes("output") || type.includes("hands_off") || type.includes("handoff")) {
      if (matches(from) && !downstream) downstream = String(to);
      if (matches(to) && !upstream) upstream = String(from);
    }
  }
  if (!upstream && !downstream) return null;
  return { upstream: upstream || "—", downstream: downstream || "—" };
}

function InformationFlowMapper({ node }: { node: ResolvedNode }) {
  const { locale } = useT();
  const fallback = flowHeuristic(node.role);
  const [flow, setFlow] = useState<{ upstream: string; downstream: string }>(fallback);
  const [fromEngine, setFromEngine] = useState(false);

  useEffect(() => {
    setFlow(flowHeuristic(node.role));
	    setFromEngine(false);
	    let cancelled = false;
	    const api = ipc();
	    if (!api?.hephaestus?.aoGraph) return;
	    void api.hephaestus
      .aoGraph({ agent: node.agentId ?? node.id })
      .then((res) => {
        if (cancelled || !res?.ok) return;
        const real = flowFromAoGraph(res.json, node);
        if (real) {
          setFlow(real);
          setFromEngine(true);
        }
      })
      .catch(() => {
        /* AO 그래프 없음 — 휴리스틱 유지 */
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, node.agentId, node.role]);

  const upstreamName = flow.upstream;
  const downstreamName = flow.downstream;

  return (
    <div style={{
      background: "var(--paper)",
      borderBottom: "1px solid var(--paper-edge)",
      padding: "12px 24px",
      display: "flex",
      flexDirection: "column",
      gap: 6
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 8 }}>
        <span>{locale === "ko" ? "정보 흐름 연결 맵 (Information Flow Mapper)" : "Information Flow Mapper"}</span>
        {fromEngine && (
          <span style={{ fontSize: 8.5, padding: "1px 6px", borderRadius: 999, background: "rgba(12,166,120,0.12)", color: "var(--green-deep, var(--ok))", letterSpacing: 0.3 }}>
            AO GRAPH
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", padding: "4px 0", gap: 12 }}>
        
        {/* Upstream Node */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "6px 12px",
          background: "var(--paper-2)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 6,
          flex: 1,
          minWidth: 100,
          textAlign: "center"
        }}>
          <span style={{ fontSize: 8.5, color: "var(--muted-deep)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>Upstream</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{upstreamName}</span>
        </div>

        {/* SVG Flow Connection 1 */}
        <div style={{ width: 60, height: 16, position: "relative", flexShrink: 0 }}>
          <svg style={{ width: "100%", height: "100%", overflow: "visible" }}>
            <defs>
              <linearGradient id="flowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="var(--paper-edge)" />
                <stop offset="50%" stopColor="var(--accent)" stopOpacity="0.8" />
                <stop offset="100%" stopColor="var(--paper-edge)" />
              </linearGradient>
            </defs>
            <line
              x1="0"
              y1="8"
              x2="100%"
              y2="8"
              fill="none"
              stroke="url(#flowGrad)"
              strokeWidth="2.5"
              strokeDasharray="6 4"
              style={{
                animation: "dashFlow 1.5s linear infinite"
              }}
            />
          </svg>
        </div>

        {/* Selected Current Node */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "6px 16px",
          background: "var(--accent-soft)",
          border: "1px solid var(--accent)",
          borderRadius: 8,
          flex: 1.2,
          minWidth: 120,
          textAlign: "center",
          boxShadow: "var(--glass-shadow-lift)"
        }}>
          <span style={{ fontSize: 8.5, color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>Active Specialist</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{node.name}</span>
        </div>

        {/* SVG Flow Connection 2 */}
        <div style={{ width: 60, height: 16, position: "relative", flexShrink: 0 }}>
          <svg style={{ width: "100%", height: "100%", overflow: "visible" }}>
            <line
              x1="0"
              y1="8"
              x2="100%"
              y2="8"
              fill="none"
              stroke="url(#flowGrad)"
              strokeWidth="2.5"
              strokeDasharray="6 4"
              style={{
                animation: "dashFlow 1.5s linear infinite"
              }}
            />
          </svg>
        </div>

        {/* Downstream Node */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "6px 12px",
          background: "var(--paper-2)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 6,
          flex: 1,
          minWidth: 100,
          textAlign: "center"
        }}>
          <span style={{ fontSize: 8.5, color: "var(--muted-deep)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>Downstream</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{downstreamName}</span>
        </div>

      </div>
      <style>{`
        @keyframes dashFlow {
          to {
            stroke-dashoffset: -20;
          }
        }
      `}</style>
    </div>
  );
}

type RuntimeTargetOption = {
  scope: AgentRuntimeOverrideScope;
  targetId: string;
  label: string;
  note: string;
};

function runtimeStatusKey(runtime: Pick<RuntimeStatus, "kind" | "backend">): string {
  return `${runtime.kind}:${runtime.backend}`;
}

function runtimeDisplayName(runtime: Pick<RuntimeStatus, "kind" | "backend" | "model">): string {
  if (runtime.kind === "claude-code") return "Claude Code";
  if (runtime.kind === "codex") return "Codex";
  if (runtime.kind === "antigravity") return "Antigravity";
  if (runtime.kind === "ollama") return runtime.model ? `Ollama · ${runtime.model}` : "Ollama";
  if (runtime.kind === "byok") return `BYOK · ${runtime.backend}`;
  return runtime.kind;
}

function selectionSummary(selection?: RuntimeSelection | null, locale: Locale = "ko"): string {
  if (!selection) return locale === "ko" ? "역할별 기본값" : "Role defaults";
  const base = selection.kind === "byok" ? `BYOK · ${selection.backend ?? "provider"}` : selection.kind;
  const model = selection.model ?? runtimeModelFallbackLabel(selection.kind, locale);
  return [base, model, selection.effort ? `effort ${selection.effort}` : ""].filter(Boolean).join(" · ");
}

function effortLabel(id: string): string {
  const known: Record<string, string> = {
    none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
    high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra",
  };
  return known[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function effortsForModel(
  runtime: RuntimeStatus | null,
  model: string,
): Array<{ id: string; label: string }> {
  const perModel = model ? runtime?.allocationModelProfiles?.[model]?.efforts : undefined;
  if (perModel && perModel.length > 0) return perModel.map((id) => ({ id, label: effortLabel(id) }));
  return runtime?.efforts ?? [];
}

function RuntimeAssignmentPanel({
  node,
  agent,
  nodeContext,
  runtimeStatuses,
  runtimeOverrides,
  onRuntimeOverridesChange,
  showToast,
}: {
  node: ResolvedNode;
  agent: InstalledAgent | null;
  nodeContext: SelectedNodeContext | null;
  runtimeStatuses: RuntimeStatus[];
  runtimeOverrides: AgentRuntimeOverride[];
  onRuntimeOverridesChange: (items: AgentRuntimeOverride[]) => void;
  showToast: (msg: string) => void;
}) {
  const { locale } = useT();
  const targets = useMemo<RuntimeTargetOption[]>(() => {
    const items: RuntimeTargetOption[] = [];
    if (node.agentId) {
      items.push({
        scope: "agent",
        targetId: node.agentId,
        label: locale === "ko" ? `${node.name}만` : `${node.name} only`,
        note: locale === "ko" ? "선택한 개별 에이전트에만 적용" : "Applies only to the selected individual agent",
      });
    }
    if (nodeContext?.firm && nodeContext.division) {
      items.push({
        scope: "division",
        targetId: divisionTargetId(nodeContext.firm.id, nodeContext.division.id),
        label: locale === "ko" ? `${nodeContext.division.name} 디비전` : `${nodeContext.division.name} division`,
        note: locale === "ko" ? "해당 디비전과 하위 전문가 기본값" : "Default for this division and its specialists",
      });
    }
    if (nodeContext?.firm) {
      items.push({
        scope: "firm",
        targetId: nodeContext.firm.id,
        label: locale === "ko" ? `${nodeContext.firm.name} 전체` : `All of ${nodeContext.firm.name}`,
        note: locale === "ko" ? "조직 전체 기본값" : "Default for the whole organization",
      });
    }
    return items;
  }, [node.agentId, node.name, nodeContext, locale]);

  const [targetKey, setTargetKey] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; label: string; tag?: string }>>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (targets.length === 0) {
      setTargetKey("");
      return;
    }
    setTargetKey((current) => (targets.some((target) => `${target.scope}:${target.targetId}` === current) ? current : `${targets[0].scope}:${targets[0].targetId}`));
  }, [targets]);

  const selectedTarget = targets.find((target) => `${target.scope}:${target.targetId}` === targetKey) ?? targets[0] ?? null;
  const selectedOverride = selectedTarget
    ? runtimeOverrides.find((item) => item.scope === selectedTarget.scope && item.targetId === selectedTarget.targetId) ?? null
    : null;

  useEffect(() => {
    const fallback = runtimeStatuses.find((runtime) => runtime.active) ?? runtimeStatuses[0];
    const source = selectedOverride
      ? runtimeStatuses.find(
          (runtime) =>
            runtime.kind === selectedOverride.selection.kind &&
            (!selectedOverride.selection.backend || runtime.backend === selectedOverride.selection.backend),
        ) ?? fallback
      : fallback;
    const model = selectedOverride?.selection.model ?? source?.model ?? "";
    const effort = selectedOverride?.selection.effort ?? source?.effort ?? "";
    setRuntimeKey(source ? runtimeStatusKey(source) : "");
    setSelectedModel(model);
    setSelectedEffort(effortsForModel(source ?? null, model).some((option) => option.id === effort) ? effort : "");
  }, [selectedOverride, runtimeStatuses]);

  const selectedRuntime = runtimeStatuses.find((runtime) => runtimeStatusKey(runtime) === runtimeKey) ?? null;
  const allowsEngineModelSetting = selectedRuntime
    ? runtimeUsesEngineModelSetting(selectedRuntime.kind)
    : false;
  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api || !selectedRuntime) {
      setModelOptions([]);
      return;
    }
    void api.runtime
      .listModels({
        kind: selectedRuntime.kind,
        backend: selectedRuntime.backend,
        availableModels: selectedRuntime.availableModels,
      })
      .then((items) => {
        if (cancelled) return;
        setModelOptions(items);
        if (!runtimeUsesEngineModelSetting(selectedRuntime.kind)) {
          setSelectedModel((current) => {
            if (current) return current;
            return selectedRuntime.model ?? items[0]?.id ?? "";
          });
        }
      })
      .catch(() => {
        if (!cancelled) setModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRuntime]);

  const effortOptions = effortsForModel(selectedRuntime, selectedModel);
  const visibleModelOptions = selectedModel && !modelOptions.some((model) => model.id === selectedModel)
    ? [{ id: selectedModel, label: selectedModel }, ...modelOptions]
    : modelOptions;
  const missingRequiredModel = Boolean(selectedRuntime && !allowsEngineModelSetting && !selectedModel);

  async function refreshOverrides() {
    const api = ipc();
    if (!api) return;
    onRuntimeOverridesChange(await api.agentRuntime.list());
  }

  async function saveOverride() {
    const api = ipc();
    if (!api || !selectedTarget || !selectedRuntime) return;
    if (!runtimeUsesEngineModelSetting(selectedRuntime.kind) && !selectedModel) {
      showToast(locale === "ko" ? "실제로 사용할 모델을 먼저 선택해 주세요." : "Choose the model that will actually run first.");
      return;
    }
    setSaving(true);
    try {
      const selection: RuntimeSelection = {
        kind: selectedRuntime.kind,
        backend: selectedRuntime.backend,
        source: selectedRuntime.source,
        model: selectedModel || undefined,
        longContext: selectedRuntime.kind === "byok" ? selectedRuntime.longContextEnabled ?? false : undefined,
        // effort는 그 런타임이 실제 노출한 tier일 때만 저장 — claude의 "max"가 codex 오버라이드로
        // 새어 codex를 exit 1 시키던 사고 차단(RuntimeControl.tsx와 동일한 kind 게이팅).
        effort: effortOptions.some((option) => option.id === selectedEffort) ? selectedEffort : undefined,
      };
      await api.agentRuntime.set({
        scope: selectedTarget.scope,
        targetId: selectedTarget.targetId,
        label: selectedTarget.label,
        selection,
      });
      await refreshOverrides();
      showToast(locale === "ko" ? "런타임 모델 지정이 저장되었습니다." : "Runtime model assignment saved.");
    } catch (err) {
      showToast((locale === "ko" ? "런타임 지정 저장 실패: " : "Failed to save runtime assignment: ") + String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride() {
    const api = ipc();
    if (!api || !selectedTarget) return;
    setSaving(true);
    try {
      await api.agentRuntime.remove(selectedTarget.scope, selectedTarget.targetId);
      await refreshOverrides();
      showToast(locale === "ko" ? "런타임 모델 지정을 해제했습니다." : "Runtime model assignment cleared.");
    } finally {
      setSaving(false);
    }
  }

  if (targets.length === 0) {
    return (
      <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "실행 모델 지정" : "Runtime Model Assignment"}</h4>
        <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>{locale === "ko" ? "설치된 에이전트 노드를 선택하면 CLI 모델을 고정할 수 있습니다." : "Select an installed agent node to pin its CLI model."}</p>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "실행 모델 지정" : "Runtime Model Assignment"}</h4>
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--muted-deep)" }}>
            {locale === "ko"
              ? "저장된 값은 다음 Chat, Team 라우팅, Hub 후보 호출부터 우선 적용됩니다."
              : "Saved values take priority from the next Chat, Team routing, and Hub candidate invocation onward."}
          </p>
        </div>
        <span style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, background: selectedOverride ? "rgba(12,166,120,0.12)" : "var(--fill-2)", color: selectedOverride ? "var(--green-deep)" : "var(--muted-deep)", fontWeight: 700 }}>
          {selectedOverride ? (locale === "ko" ? "고정됨" : "Pinned") : (locale === "ko" ? "역할 기본" : "Role defaults")}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          {locale === "ko" ? "적용 범위" : "Scope"}
          <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} style={runtimeSelectStyle}>
            {targets.map((target) => (
              <option key={`${target.scope}:${target.targetId}`} value={`${target.scope}:${target.targetId}`}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          CLI / Runtime
          <select
            value={runtimeKey}
            onChange={(e) => {
              const nextKey = e.target.value;
              const nextRuntime = runtimeStatuses.find((runtime) => runtimeStatusKey(runtime) === nextKey) ?? null;
              const nextModel = nextRuntime?.model ?? "";
              setRuntimeKey(nextKey);
              setSelectedModel(nextModel);
              setSelectedEffort(effortsForModel(nextRuntime, nextModel).some((option) => option.id === selectedEffort) ? selectedEffort : "");
            }}
            style={runtimeSelectStyle}
          >
            {runtimeStatuses.map((runtime) => (
              <option key={runtimeStatusKey(runtime)} value={runtimeStatusKey(runtime)}>
                {runtimeDisplayName(runtime)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: effortOptions.length > 0 ? "1fr 1fr" : "1fr", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          {locale === "ko" ? "모델" : "Model"}
          <select
            value={selectedModel}
            onChange={(e) => {
              const model = e.target.value;
              setSelectedModel(model);
              if (selectedEffort && !effortsForModel(selectedRuntime, model).some((option) => option.id === selectedEffort)) {
                setSelectedEffort("");
              }
            }}
            style={runtimeSelectStyle}
          >
            {allowsEngineModelSetting && selectedRuntime && (
              <option value="">{runtimeModelFallbackLabel(selectedRuntime.kind, locale)}</option>
            )}
            {missingRequiredModel && (
              <option value="" disabled>{locale === "ko" ? "모델 선택 필요" : "Model required"}</option>
            )}
            {visibleModelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}{model.tag ? ` · ${cliModelTagLabel(model.tag, locale)}` : ""}
              </option>
            ))}
          </select>
        </label>
        {effortOptions.length > 0 && (
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
            {locale === "ko" ? "작업량" : "Effort"}
            <select value={selectedEffort} onChange={(e) => setSelectedEffort(e.target.value)} style={runtimeSelectStyle}>
              <option value="">{locale === "ko" ? "기본 작업량" : "Default effort"}</option>
              {effortOptions.map((effort) => (
                <option key={effort.id} value={effort.id}>{effort.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--paper-2)", border: "1px solid var(--paper-edge)", fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
        <strong style={{ color: "var(--ink)" }}>{locale === "ko" ? "현재 저장값:" : "Current saved value:"}</strong> {selectionSummary(selectedOverride?.selection, locale)}
        {selectedTarget && <span style={{ color: "var(--muted-deep)" }}> · {selectedTarget.note}</span>}
      </div>

      {/* 독립성: 키는 내 OS 키체인에 저장되고 Agentlas 서버를 거치지 않으며, 모델 호출은 내 구독/키로 직접 나간다. */}
      <div className="runtime-independence-note">
        {locale === "ko"
          ? "키는 내 OS 키체인에 저장되고 Agentlas 서버를 거치지 않습니다 · 모델 호출은 내 구독/키로 직접 나갑니다"
          : "Keys are stored in your OS keychain and never pass through Agentlas servers · model calls go out directly with your own subscription/key"}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button onClick={clearOverride} disabled={saving || !selectedOverride} style={{ ...runtimeButtonStyle, opacity: selectedOverride ? 1 : 0.45 }}>
          {locale === "ko" ? "역할 기본 사용" : "Use role defaults"}
        </button>
        <button onClick={saveOverride} disabled={saving || !selectedRuntime || missingRequiredModel} style={{ ...runtimeButtonStyle, background: "var(--accent)", color: "var(--white)", border: "1px solid var(--accent)" }}>
          {saving ? (locale === "ko" ? "저장 중..." : "Saving...") : (locale === "ko" ? "저장" : "Save")}
        </button>
      </div>
    </div>
  );
}

const runtimeSelectStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "8px 9px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  fontSize: 12,
};

const runtimeButtonStyle: React.CSSProperties = {
  padding: "7px 11px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const tasteInputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "8px 9px",
  borderRadius: 9,
  border: "1px solid var(--paper-edge)",
  background: "color-mix(in srgb, var(--paper-2) 88%, transparent)",
  color: "var(--ink)",
  fontSize: 11.5,
};

function ExperiencePanel({
  agent,
  memoryEntries,
  runtimeStatuses,
  locale,
  showToast,
  onChanged,
}: {
  agent: InstalledAgent | null;
  memoryEntries: AgentMemoryEntryUi[];
  runtimeStatuses: RuntimeStatus[];
  locale: Locale;
  showToast: (message: string) => void;
  onChanged: () => void;
}) {
  const ko = locale === "ko";
  const taskLabel = (task: string) => {
    const short = task.replace("agentlas.task.v1/", "");
    if (!ko) return short.replaceAll("-", " ");
    const labels: Record<string, string> = {
      "browser-automation": "브라우저 자동화",
      "visual-design": "시각 디자인",
      research: "리서치",
      writing: "글쓰기",
      coding: "개발",
    };
    return labels[short] ?? short.replaceAll("-", " ");
  };
  const [packs, setPacks] = useState<ExperiencePackRecord[]>([]);
  const [selectedPackId, setSelectedPackId] = useState("");
  const [candidates, setCandidates] = useState<ExperienceCandidateRecord[]>([]);
  const [receipts, setReceipts] = useState<ExperiencePromotionReceipt[]>([]);
  const [intents, setIntents] = useState<ExperienceExportIntentRecord[]>([]);
  const [cloudUploads, setCloudUploads] = useState<ExperienceCloudUploadRecord[]>([]);
  const [tasteDrafts, setTasteDrafts] = useState<LocalTasteDraftRecord[]>([]);
  const [tasteWorkflows, setTasteWorkflows] = useState<TasteChipWorkflowRecord[]>([]);
  const [operationalPublicProjections, setOperationalPublicProjections] = useState<OperationalPublicProjectionRecord[]>([]);
  const [operationalSourceIds, setOperationalSourceIds] = useState<string[]>([]);
  const [operationalTitle, setOperationalTitle] = useState("");
  const [operationalInstructions, setOperationalInstructions] = useState("");
  const [operationalTask, setOperationalTask] = useState("");
  const [editingTasteDraftId, setEditingTasteDraftId] = useState("");
  const [tasteTitle, setTasteTitle] = useState("");
  const [tasteSummary, setTasteSummary] = useState("");
  const [tasteRule, setTasteRule] = useState("");
  const [tasteAxis, setTasteAxis] = useState<TasteAxis>("composition");
  const [tasteTask, setTasteTask] = useState("");
  const [tasteContext, setTasteContext] = useState("visual-design");
  const [tastePreviewRights, setTastePreviewRights] = useState<TastePreviewRights | "">("");
  const [tasteTaskInputHash, setTasteTaskInputHash] = useState("");
  const [tasteGenerationCohort, setTasteGenerationCohort] = useState("");
  const [tasteGenerationAttested, setTasteGenerationAttested] = useState(false);
  const [packName, setPackName] = useState("");
  const [projectGrant, setProjectGrant] = useState<FsPathGrant | null>(null);
  const projectPath = projectGrant?.path ?? "";
  const [memoryId, setMemoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedPack = packs.find((pack) => pack.id === selectedPackId) ?? null;
  const activeRuntime = runtimeStatuses.find((runtime) => runtime.active) ?? runtimeStatuses[0] ?? null;
  const requireBridge = () => {
    const bridge = ipc();
    if (!bridge) throw new Error(ko ? "Desktop 브리지를 사용할 수 없습니다." : "Desktop bridge is unavailable.");
    return bridge;
  };

  const loadPacks = useCallback(async () => {
    if (!agent) return;
    const [next, nextTasteDrafts, nextTasteWorkflows] = await Promise.all([
      requireBridge().experience.listPacks({ agentId: agent.id }),
      requireBridge().experience.listTasteDrafts(agent.id),
      requireBridge().experience.listTasteWorkflows(agent.id),
    ]);
    setPacks(next);
    setTasteDrafts(nextTasteDrafts);
    setTasteWorkflows(nextTasteWorkflows);
    setSelectedPackId((current) => current && next.some((pack) => pack.id === current) ? current : next[0]?.id ?? "");
  }, [agent]);

  const loadPackDetails = useCallback(async (packId: string) => {
    if (!packId) {
      setCandidates([]);
      setReceipts([]);
      setIntents([]);
      setCloudUploads([]);
      setOperationalPublicProjections([]);
      return;
    }
    const api = requireBridge().experience;
    const [nextCandidates, nextReceipts, nextIntents, nextCloudUploads, nextPublicProjections] = await Promise.all([
      api.listCandidates(packId),
      api.listPromotionReceipts(packId),
      api.listExportIntents(packId),
      api.cloudList(packId),
      api.listOperationalPublicProjections(packId),
    ]);
    setCandidates(nextCandidates);
    setReceipts(nextReceipts);
    setIntents(nextIntents);
    setCloudUploads(nextCloudUploads);
    setOperationalPublicProjections(nextPublicProjections);
    const projection = nextPublicProjections[0];
    if (projection) {
      setOperationalSourceIds(projection.sourceBindings.map((binding) => binding.candidateId));
      setOperationalTitle(projection.title);
      setOperationalInstructions(projection.instructions.join("\n"));
      setOperationalTask(projection.taskSignatures[0] ?? "");
    } else {
      setOperationalSourceIds([]);
      setOperationalTitle("");
      setOperationalInstructions("");
      setOperationalTask("");
    }
  }, []);

  useEffect(() => {
    setError("");
    void loadPacks().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [loadPacks]);

  useEffect(() => {
    setMemoryId("");
    void loadPackDetails(selectedPackId).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [loadPackDetails, selectedPackId]);

  const eligibleMemory = memoryEntries.filter((entry) =>
    entry.projectPath === selectedPack?.projectPath &&
    ["procedure", "decision", "risk"].includes(entry.kind) &&
    !candidates.some((candidate) => candidate.sourceMemoryId === entry.id) &&
    entry.sensitivity !== "secret" && entry.sensitivity !== "confidential",
  );

  const chooseProject = async () => {
    const grant = await requireBridge().fs.pickDirectory();
    if (grant) setProjectGrant(grant);
  };

  const createPack = async () => {
    if (!agent || !packName.trim() || !projectGrant || !activeRuntime) return;
    setBusy(true);
    setError("");
    try {
      const created = await requireBridge().experience.createPack({
        agentId: agent.id,
        name: packName.trim(),
        projectGrant,
      });
      setPackName("");
      await loadPacks();
      setSelectedPackId(created.id);
      onChanged();
      showToast(ko ? "로컬 경험 칩을 만들었습니다." : "Created a local Experience Chip.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const captureCandidate = async () => {
    if (!selectedPack || !memoryId) return;
    setBusy(true);
    setError("");
    try {
      await requireBridge().experience.captureFromMemory({ packId: selectedPack.id, sourceMemoryId: memoryId });
      await loadPackDetails(selectedPack.id);
      onChanged();
      setMemoryId("");
      showToast(ko ? "검수할 경험 후보를 만들었습니다." : "Created an Experience candidate for review.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const promoteCandidate = async (candidate: ExperienceCandidateRecord) => {
    const confirmed = window.confirm(ko
      ? "이 내용을 직접 확인했나요? 확인하면 이 에이전트가 다음 작업에서 참고할 경험으로 저장합니다."
      : "Have you reviewed this content? Confirm to save it as experience this agent can use in future work.");
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await requireBridge().experience.promote({
        candidateId: candidate.id,
        explicitConsent: true,
        verification: {
          status: "attested",
          method: "user-attested",
          evidenceRefs: [`ui-attestation:${candidate.id}`],
        },
        publicSafe: false,
      });
      if (selectedPack) await loadPackDetails(selectedPack.id);
      onChanged();
      showToast(ko ? "검토한 경험으로 저장했습니다." : "Saved as reviewed experience.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createExportIntent = async () => {
    if (!selectedPack) return;
    setBusy(true);
    setError("");
    try {
      await requireBridge().experience.createExportIntent({ packId: selectedPack.id, visibility: "private" });
      await loadPackDetails(selectedPack.id);
      onChanged();
      showToast(ko ? "로컬 내보내기 의도를 기록했습니다. Hub에는 업로드하지 않았습니다." : "Recorded a local export intent. Nothing was uploaded to Hub.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const savePrivateCloud = async () => {
    if (!selectedPack) return;
    setBusy(true);
    setError("");
    try {
      const saved = await requireBridge().experience.cloudSave({ packId: selectedPack.id, requestedVisibility: "private" });
      await loadPacks();
      await loadPackDetails(selectedPack.id);
      onChanged();
      showToast(saved.state === "offline"
        ? (ko ? "오프라인입니다. 같은 업로드를 나중에 이어갈 수 있습니다." : "Offline. The same upload can be resumed later.")
        : (ko ? "경험만 비공개 Cloud에 저장했습니다. 원본 Agent 업로드와는 별개입니다." : "Saved only the Experience to private Cloud, separately from the base Agent upload."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const requestPublicVerification = async () => {
    if (!selectedPack) return;
    const confirmed = window.confirm(ko
      ? "구매자에게 보일 칩 이름과 좋아지는 점을 Hub에 등록할까요? 원본 기억은 전송하지 않습니다."
      : "Submit the buyer-facing chip name and benefits to Hub? Original memory is not sent.");
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      const requested = await requireBridge().experience.cloudSave({ packId: selectedPack.id, requestedVisibility: "public" });
      await loadPackDetails(selectedPack.id);
      onChanged();
      showToast(requested.state === "verification-requested" || requested.state === "verification-pending"
        ? (ko ? "Hub 등록 요청을 보냈습니다. 안전 확인이 끝나면 공개됩니다." : "Submitted to Hub. It becomes public after the safety review.")
        : (ko ? "비공개로 저장했습니다. Hub 등록은 아직 요청되지 않았습니다." : "Saved privately. Hub listing has not been requested yet."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleOperationalSource = (candidateId: string) => {
    setOperationalSourceIds((current) => current.includes(candidateId)
      ? current.filter((id) => id !== candidateId)
      : [...current, candidateId].sort());
  };

  const fillBuyerCopyDraft = () => {
    if (!selectedPack) return;
    const selected = candidates.filter((candidate) => operationalSourceIds.includes(candidate.id));
    if (!selected.length) return;
    if (!operationalTitle.trim()) setOperationalTitle(selectedPack.name);
    if (!operationalInstructions.trim()) {
      setOperationalInstructions(selected.map((candidate) => candidate.summary.trim()).filter(Boolean).join("\n"));
    }
    showToast(ko
      ? "선택한 경험에서 구매자용 소개 초안을 채웠습니다. 개인정보가 없는 표현으로 다듬어 주세요."
      : "Filled buyer-facing copy from the selected experience. Review it for clear, non-personal wording.");
  };

  const saveOperationalPublicProjection = async () => {
    if (!selectedPack || !operationalTask) return;
    setBusy(true);
    setError("");
    try {
      const saved = await requireBridge().experience.saveOperationalPublicProjection({
        packId: selectedPack.id,
        sourceCandidateIds: operationalSourceIds,
        title: operationalTitle,
        instructions: operationalInstructionLines,
        taskSignatures: [operationalTask],
        environmentConstraints: selectedPack.environmentProfile?.constraints ?? [],
      });
      setOperationalPublicProjections([saved]);
      setOperationalSourceIds(saved.sourceBindings.map((binding) => binding.candidateId));
      setOperationalTitle(saved.title);
      setOperationalInstructions(saved.instructions.join("\n"));
      setOperationalTask(saved.taskSignatures[0] ?? "");
      onChanged();
      showToast(saved.privacyIssueCodes.length > 0
        ? (ko ? "초안은 저장됐지만 공개 안전 검사를 통과하지 못했습니다." : "Draft saved, but it did not pass the public-safety scan.")
        : (ko ? "구매자에게 보일 소개를 저장했습니다." : "Saved the buyer-facing copy."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmOperationalPublicProjection = async () => {
    const projection = operationalPublicProjections[0];
    if (!projection || !window.confirm(ko
      ? "화면에 보이는 칩 이름과 좋아지는 점만 Hub 등록에 사용할까요? 원본 기억은 계속 비공개입니다."
      : "Use only the visible chip name and benefits for the Hub listing? Original memory stays private.")) return;
    setBusy(true);
    setError("");
    try {
      const confirmed = await requireBridge().experience.confirmOperationalPublicProjection({
        projectionId: projection.projectionId,
        proposalHash: projection.proposalHash,
        explicitConsent: true,
      });
      setOperationalPublicProjections([confirmed]);
      onChanged();
      showToast(ko ? "개인정보가 없는 구매자용 소개임을 확인했습니다." : "Confirmed that the buyer-facing copy contains no personal information.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const reconcileCloud = async (upload: ExperienceCloudUploadRecord) => {
    if (!selectedPack) return;
    setBusy(true);
    setError("");
    try {
      await requireBridge().experience.cloudReconcile({ localUploadId: upload.id });
      await loadPackDetails(selectedPack.id);
      onChanged();
      showToast(ko ? "서버 영수증과 상태를 다시 맞췄습니다." : "Reconciled the local state with the server receipt.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const cloudStateLabel = (state: ExperienceCloudUploadRecord["state"]): string => ({
    "local-ready": ko ? "내 Mac에 저장됨" : "Saved on this Mac",
    "saving-private": ko ? "내 Hub에 저장 중" : "Saving to my Hub",
    "private-saved": ko ? "내 Hub에 비공개 보관됨" : "Saved privately to my Hub",
    "requesting-verification": ko ? "공개 안전 확인 요청 중" : "Requesting public-safety review",
    "verification-requested": ko ? "공개 안전 확인 요청됨" : "Public-safety review requested",
    "verification-pending": ko ? "공개 안전 확인 중" : "Public-safety review in progress",
    "verified-private": ko ? "안전 확인 완료 · 비공개" : "Safety checked · private",
    "public-active": ko ? "Hub 공개 완료" : "Published on Hub",
    conflict: ko ? "확인할 사항이 있음" : "Needs attention",
    offline: ko ? "오프라인 · 재개 가능" : "Offline · resumable",
    error: ko ? "Hub 상태 확인 필요" : "Hub status needs review",
    withdrawn: ko ? "공개 중단됨" : "Unpublished",
    rejected: ko ? "공개 안전 확인 미통과" : "Public-safety review not passed",
  })[state];

  const latestCloud = cloudUploads[0] ?? null;
  const operationalProjection = operationalPublicProjections[0] ?? null;
  const operationalInstructionLines = operationalInstructions.split("\n").map((line) => line.trim()).filter(Boolean);
  const operationalTasks = [...new Set(candidates
    .filter((candidate) => operationalSourceIds.includes(candidate.id))
    .flatMap((candidate) => candidate.taskSignatures))].sort();
  const operationalProjectionDirty = Boolean(operationalProjection) && (
    JSON.stringify([...operationalSourceIds].sort()) !== JSON.stringify(operationalProjection!.sourceBindings.map((binding) => binding.candidateId).sort()) ||
    operationalTitle.trim() !== operationalProjection!.title ||
    JSON.stringify(operationalInstructionLines) !== JSON.stringify(operationalProjection!.instructions) ||
    operationalTask !== (operationalProjection!.taskSignatures[0] ?? "")
  );
  const operationalPublicReady = operationalProjection?.status === "confirmed" &&
    operationalProjection.privacyIssueCodes.length === 0 && !operationalProjectionDirty;
  const editingTasteDraft = tasteDrafts.find((draft) => draft.id === editingTasteDraftId) ?? null;
  const editingTasteWorkflow = tasteWorkflows.find((workflow) => workflow.draftId === editingTasteDraftId) ?? null;

  const beginTasteReview = (draft: LocalTasteDraftRecord) => {
    const workflow = tasteWorkflows.find((item) => item.draftId === draft.id);
    setEditingTasteDraftId(draft.id);
    setTasteTitle(workflow?.title ?? "");
    setTasteSummary(workflow?.summary ?? "");
    setTasteRule(workflow?.ruleStatement ?? "");
    setTasteAxis(workflow?.axis ?? draft.axisCandidates[0] ?? "composition");
    setTasteTask(workflow?.taskSignature ?? draft.taskSignatures[0] ?? "");
    setTasteContext(workflow?.contexts.join(", ") ?? "visual-design");
    setTastePreviewRights(workflow?.previewRights ?? "");
    setTasteTaskInputHash(workflow?.previewTreatments?.[0]?.canonicalTaskInputHash ?? "");
    setTasteGenerationCohort(workflow?.previewTreatments?.[0]?.generationCohortHash ?? "");
    setTasteGenerationAttested(Boolean(workflow?.previewTreatments));
  };

  const reloadTaste = async () => {
    if (!agent) return;
    setTasteWorkflows(await requireBridge().experience.listTasteWorkflows(agent.id));
  };

  const saveTasteProposal = async () => {
    if (!agent || !editingTasteDraft) return;
    setBusy(true);
    setError("");
    try {
      await requireBridge().experience.saveTasteGeneralization({
        draftId: editingTasteDraft.id,
        agentId: agent.id,
        title: tasteTitle,
        summary: tasteSummary,
        ruleStatement: tasteRule,
        axis: tasteAxis,
        taskSignature: tasteTask,
        contexts: tasteContext.split(",").map((item) => item.trim()).filter(Boolean),
      });
      await reloadTaste();
      onChanged();
      showToast(ko ? "일반화 초안을 로컬에 저장했습니다." : "Saved the generalized draft locally.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmTasteProposal = async () => {
    if (!editingTasteWorkflow || !window.confirm(ko ? "원문이 아니라 이 일반화된 규칙만 Hub 준비에 사용합니다. 확인할까요?" : "Only this generalized rule—not the raw memory—will be prepared for Hub. Confirm?")) return;
    setBusy(true);
    setError("");
    try {
      await requireBridge().experience.confirmTasteGeneralization({
        workflowId: editingTasteWorkflow.workflowId,
        generalizationHash: editingTasteWorkflow.generalizationHash,
        explicitConsent: true,
      });
      await reloadTaste();
      showToast(ko ? "프라이버시 재검사를 통과해 확인했습니다." : "Confirmed after a fresh privacy scan.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const chooseTastePreviews = async () => {
    if (!editingTasteWorkflow || !tastePreviewRights || !/^sha256:[a-f0-9]{64}$/.test(tasteTaskInputHash) || !tasteGenerationCohort.trim() || !tasteGenerationAttested) return;
    const rightsLabel = tastePreviewRights === "owner-authorized"
      ? (ko ? "내가 소유하거나 공개 미리보기를 허가받은 이미지" : "images I own or am authorized to preview publicly")
      : tastePreviewRights === "licensed-for-public-preview"
        ? (ko ? "공개 미리보기 라이선스가 있는 이미지" : "images licensed for public preview")
        : (ko ? "퍼블릭 도메인 이미지" : "public-domain images");
    if (!window.confirm(ko ? `${rightsLabel}이며, 첫 파일은 Taste 적용, 두 번째는 동일 조건의 Taste 미적용 컨트롤임을 확인합니다.` : `I confirm the first file is chip-on and the second is a no-Taste control generated under the same conditions, and both are ${rightsLabel}.`)) return;
    setBusy(true);
    setError("");
    try {
      const previews = await requireBridge().experience.pickTastePreviews();
      if (!previews) return;
      await requireBridge().experience.prepareTastePreviews({
        workflowId: editingTasteWorkflow.workflowId,
        previews,
        rightsStatus: tastePreviewRights,
        rightsAttested: true,
        canonicalTaskInputHash: tasteTaskInputHash,
        generationCohortRef: tasteGenerationCohort,
        externalGenerationAttested: true,
      });
      await reloadTaste();
      showToast(ko ? "칩 적용·컨트롤 쌍을 소유자 증명으로 준비했습니다." : "Prepared the chip-on/control pair with owner-attested provenance.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const uploadTasteProposal = async () => {
    if (!editingTasteWorkflow || !window.confirm(ko ? "일반화 규칙과 미리보기 2개만 Hub 비공개 초안으로 올릴까요? 원문·로컬 경로는 전송하지 않습니다." : "Upload only the generalized rule and two previews as a private Hub draft? Raw memory and local paths are not sent.")) return;
    setBusy(true);
    setError("");
    try {
      const uploaded = await requireBridge().experience.uploadTasteDraft({
        workflowId: editingTasteWorkflow.workflowId,
        generalizationHash: editingTasteWorkflow.generalizationHash,
        explicitUpload: true,
      });
      await reloadTaste();
      onChanged();
      showToast(uploaded.status === "ab-ready"
        ? (ko ? "블라인드 A/B 준비가 끝났습니다." : "Blinded A/B is ready.")
        : (ko ? "업로드됐고 미리보기 안전 검사를 기다립니다." : "Uploaded; preview moderation is pending."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!agent) return <div>{ko ? "설치된 에이전트 정보가 필요합니다." : "Installed agent metadata is required."}</div>;

  return (
    <div data-testid="experience-panel" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }}>
      <section style={{ padding: "16px 0 14px", borderBottom: "1px solid var(--paper-edge)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <span style={{ color: "var(--muted-deep)", fontSize: 11, fontWeight: 750 }}>{ko ? "이 에이전트가 배운 것" : "WHAT THIS AGENT LEARNED"}</span>
            <h3 style={{ margin: "5px 0 0", fontSize: 20 }}>{ko ? "경험 관리" : "Experience"}</h3>
          </div>
          <span style={{ padding: "5px 9px", borderRadius: 999, background: latestCloud?.state === "public-active" ? "var(--green-soft)" : "var(--paper-2)", color: latestCloud?.state === "public-active" ? "var(--green-deep)" : "var(--ink-soft)", fontSize: 11, fontWeight: 750 }}>
            {latestCloud ? cloudStateLabel(latestCloud.state) : (ko ? "내 컴퓨터에만 저장" : "Saved on this Mac")}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", marginTop: 14, borderTop: "1px solid var(--paper-edge)", borderBottom: "1px solid var(--paper-edge)" }}>
          {[
            [ko ? "경험 칩" : "Chips", packs.length],
            [ko ? "검토한 경험" : "Reviewed", receipts.length],
            [ko ? "공개 준비" : "Public-ready", operationalPublicReady ? (ko ? "완료" : "Ready") : (ko ? "필요" : "Needed")],
          ].map(([label, value], index) => (
            <div key={String(label)} style={{ padding: "10px 12px", borderLeft: index ? "1px solid var(--paper-edge)" : undefined }}>
              <span style={{ display: "block", color: "var(--muted-deep)", fontSize: 10.5 }}>{label}</span>
              <strong style={{ display: "block", marginTop: 3, fontSize: 14 }}>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <details style={{ borderBottom: "1px solid var(--paper-edge)", paddingBottom: 12 }}>
        <summary style={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontSize: 12.5, fontWeight: 750 }}>
          <span>{ko ? "취향 경험 후보" : "Taste candidates"}</span><span>{tasteDrafts.length}</span>
        </summary>
      <section data-testid="local-taste-drafts" style={{ background: "color-mix(in srgb, var(--paper) 92%, var(--accent-soft))", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, boxShadow: "0 10px 28px color-mix(in srgb, var(--ink) 7%, transparent)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--paper-2)", boxShadow: "inset 1px 1px 0 color-mix(in srgb, white 70%, transparent), 0 5px 12px color-mix(in srgb, var(--ink) 10%, transparent)", color: "var(--accent)", fontSize: 12, fontWeight: 850 }}>T</span>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>{ko ? "Taste 후보" : "Taste drafts"}</h3>
              <span style={{ fontSize: 10.5, color: "var(--muted-deep)" }}>{ko ? "비공개 · 사람 근거 대기" : "Private · awaiting human evidence"}</span>
            </div>
          </div>
          <span data-testid="taste-draft-count" style={{ minWidth: 32, height: 28, padding: "0 9px", borderRadius: 999, display: "grid", placeItems: "center", background: "var(--paper-2)", border: "1px solid var(--paper-edge)", fontSize: 12, fontWeight: 800 }}>{tasteDrafts.length}</span>
        </div>
        {tasteDrafts.length === 0 ? (
          <div style={{ height: 96, marginTop: 12, borderRadius: 12, border: "1px dashed var(--paper-edge)", display: "grid", placeItems: "center", color: "var(--muted-deep)", fontSize: 11.5 }}>
            {ko ? "취향 메모리가 생기면 이 에이전트의 비공개 후보로 쌓입니다." : "Preference Memory will appear here as this agent's private draft."}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 9, marginTop: 12 }}>
            {tasteDrafts.map((draft) => (
              <article key={draft.id} style={{ minWidth: 0, border: "1px solid var(--paper-edge)", borderRadius: 12, padding: 11, background: "color-mix(in srgb, var(--paper-2) 86%, transparent)", boxShadow: "inset 0 1px 0 color-mix(in srgb, white 55%, transparent)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "var(--amber-deep)", fontWeight: 800 }}>{ko ? "근거 대기" : "EVIDENCE NEEDED"}</span>
                  <span aria-label={ko ? "로컬 전용, 공개 불가" : "Local only, not publishable"} title={ko ? "로컬 전용 · 공개 불가" : "Local only · not publishable"} style={{ width: 8, height: 8, borderRadius: 999, background: "var(--amber-deep)", boxShadow: "0 0 0 4px var(--amber-soft)" }} />
                </div>
                <p style={{ margin: "9px 0", fontSize: 12, lineHeight: 1.45, color: "var(--ink)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{draft.statement}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {(draft.axisCandidates.length ? draft.axisCandidates : [ko ? "축 검토 필요" : "axis review"]).map((axis) => (
                    <span key={axis} style={{ padding: "3px 6px", borderRadius: 999, border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontSize: 9.5 }}>{axis}</span>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 10, color: "var(--muted-deep)", fontSize: 9.5, fontFamily: "var(--font-mono)" }}>
                  <span>{draft.basePackageHash.slice(0, 10)}</span>
                  <span>{draft.baseAgentReleaseId ? (ko ? "Hub 기준 고정" : "Hub base pinned") : (ko ? "로컬 기준" : "Local base")}</span>
                </div>
                <button
                  type="button"
                  onClick={() => beginTasteReview(draft)}
                  disabled={!draft.baseAgentDefinitionId || !draft.baseAgentReleaseId}
                  aria-label={ko ? "Taste 일반화 검토" : "Review Taste generalization"}
                  title={draft.baseAgentReleaseId ? (ko ? "일반화 검토" : "Review generalization") : (ko ? "정확한 Hub 릴리스 연결 필요" : "Exact Hub release binding required")}
                  style={{ ...runtimeButtonStyle, width: "100%", marginTop: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: draft.baseAgentReleaseId ? 1 : 0.45 }}
                >
                  <IconEdit size={13} />
                  {ko ? "검토" : "Review"}
                </button>
              </article>
            ))}
          </div>
        )}
        {editingTasteDraft && (
          <div data-testid="taste-generalization-workflow" style={{ marginTop: 12, padding: 12, borderRadius: 14, border: "1px solid var(--paper-edge)", background: "color-mix(in srgb, var(--paper) 82%, transparent)", boxShadow: "inset 0 1px 0 color-mix(in srgb, white 65%, transparent), 0 10px 24px color-mix(in srgb, var(--ink) 6%, transparent)" }}>
            <div aria-label={ko ? "Taste 준비 단계" : "Taste preparation steps"} style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 7, marginBottom: 11 }}>
              {[
                { icon: <IconEdit size={13} />, label: ko ? "일반화" : "Generalize", done: Boolean(editingTasteWorkflow) },
                { icon: <IconShield size={13} />, label: ko ? "확인" : "Confirm", done: Boolean(editingTasteWorkflow?.confirmedAt) },
                { icon: <IconLayers size={13} />, label: "A/B", done: Boolean(editingTasteWorkflow?.previewNames) },
                { icon: <IconFileUp size={13} />, label: "Hub", done: editingTasteWorkflow?.status === "moderation-pending" || editingTasteWorkflow?.status === "ab-ready" },
              ].map((step) => (
                <div key={step.label} title={step.label} style={{ minHeight: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, border: "1px solid var(--paper-edge)", background: step.done ? "color-mix(in srgb, var(--green-deep) 10%, var(--paper))" : "var(--paper-2)", color: step.done ? "var(--green-deep)" : "var(--muted-deep)", fontSize: 10, fontWeight: 800 }}>
                  {step.icon}<span>{step.label}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, .8fr) minmax(180px, 1.2fr)", gap: 8 }}>
              <input aria-label={ko ? "Taste 제목" : "Taste title"} value={tasteTitle} onChange={(event) => setTasteTitle(event.target.value)} placeholder={ko ? "범용 제목" : "Portable title"} style={tasteInputStyle} />
              <input aria-label={ko ? "Taste 요약" : "Taste summary"} value={tasteSummary} onChange={(event) => setTasteSummary(event.target.value)} placeholder={ko ? "개인 정보 없는 한 줄 요약" : "One safe portable summary"} style={tasteInputStyle} />
              <select aria-label={ko ? "Taste 축" : "Taste axis"} value={tasteAxis} onChange={(event) => setTasteAxis(event.target.value as TasteAxis)} style={tasteInputStyle}>
                {["composition", "color", "typography", "motion", "pacing", "density", "imagery", "editing", "spatial-rhythm"].map((axis) => <option key={axis} value={axis}>{axis}</option>)}
              </select>
              <select aria-label={ko ? "작업 유형" : "Task signature"} value={tasteTask} onChange={(event) => setTasteTask(event.target.value)} style={tasteInputStyle}>
                {editingTasteDraft.taskSignatures.map((task) => <option key={task} value={task}>{task}</option>)}
              </select>
              <input aria-label={ko ? "범용 맥락" : "Portable contexts"} value={tasteContext} onChange={(event) => setTasteContext(event.target.value)} placeholder="visual-design, editorial" style={tasteInputStyle} />
              <input aria-label={ko ? "일반화된 선호 규칙" : "Generalized preference rule"} value={tasteRule} onChange={(event) => setTasteRule(event.target.value)} placeholder={ko ? "예: 정보 계층이 분명한 절제된 구성을 선호" : "e.g. Prefer restrained layouts with clear hierarchy"} style={tasteInputStyle} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(180px, .8fr) auto", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input aria-label={ko ? "동일 작업 입력 SHA-256" : "Shared task input SHA-256"} value={tasteTaskInputHash} onChange={(event) => setTasteTaskInputHash(event.target.value.trim())} placeholder="sha256: canonical task input" style={tasteInputStyle} />
              <input aria-label={ko ? "동일 생성 코호트" : "Shared generation cohort"} value={tasteGenerationCohort} onChange={(event) => setTasteGenerationCohort(event.target.value.trim())} placeholder={ko ? "생성 코호트 참조 또는 sha256" : "generation cohort ref or sha256"} style={tasteInputStyle} />
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--muted-deep)", fontSize: 10.5 }}>
                <input type="checkbox" checked={tasteGenerationAttested} onChange={(event) => setTasteGenerationAttested(event.target.checked)} />
                {ko ? "동일 조건 생성 확인" : "Same generation conditions"}
              </label>
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>
              <button type="button" disabled={busy || !tasteTask} onClick={() => void saveTasteProposal()} style={runtimeButtonStyle}><IconEdit size={13} /> {ko ? "초안 저장" : "Save"}</button>
              <button type="button" disabled={busy || !editingTasteWorkflow || Boolean(editingTasteWorkflow.confirmedAt)} onClick={() => void confirmTasteProposal()} style={runtimeButtonStyle}><IconShield size={13} /> {ko ? "확인" : "Confirm"}</button>
              <select aria-label={ko ? "미리보기 권리" : "Preview rights"} value={tastePreviewRights} onChange={(event) => setTastePreviewRights(event.target.value as TastePreviewRights | "")} style={{ ...tasteInputStyle, width: "auto", minWidth: 152 }}>
                <option value="">{ko ? "권리 선택" : "Select rights"}</option>
                <option value="owner-authorized">{ko ? "소유·허가" : "Owned / authorized"}</option>
                <option value="licensed-for-public-preview">{ko ? "공개 라이선스" : "Public-preview license"}</option>
                <option value="public-domain">{ko ? "퍼블릭 도메인" : "Public domain"}</option>
              </select>
              <button type="button" disabled={busy || !editingTasteWorkflow?.confirmedAt || !tastePreviewRights || !/^sha256:[a-f0-9]{64}$/.test(tasteTaskInputHash) || !tasteGenerationCohort.trim() || !tasteGenerationAttested} onClick={() => void chooseTastePreviews()} style={runtimeButtonStyle}><IconLayers size={13} /> {ko ? "칩 적용 + 컨트롤" : "Chip-on + control"}</button>
              <button type="button" disabled={busy || !editingTasteWorkflow?.confirmedAt || !editingTasteWorkflow.previewNames} onClick={() => void uploadTasteProposal()} style={{ ...runtimeButtonStyle, color: "white", background: "var(--accent)" }}><IconFileUp size={13} /> {editingTasteWorkflow?.status === "moderation-pending" ? (ko ? "안전검사 확인" : "Check moderation") : (ko ? "Hub 초안" : "Hub draft")}</button>
              <button type="button" onClick={() => setEditingTasteDraftId("")} aria-label={ko ? "Taste 검토 닫기" : "Close Taste review"} style={{ ...runtimeButtonStyle, marginLeft: "auto" }}><IconClose size={13} /></button>
            </div>
            {editingTasteWorkflow?.previewNames && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginTop: 8, color: "var(--muted-deep)", fontSize: 10.5 }}><span><strong>CHIP ON</strong> · {editingTasteWorkflow.previewNames[0]}</span><span><strong>CONTROL</strong> · {editingTasteWorkflow.previewNames[1]}</span></div>}
            {editingTasteWorkflow?.previewTreatments?.[0]?.evidenceLevel === "owner-attested-external" && <small style={{ display: "block", marginTop: 7, color: "var(--amber-deep)" }}>{ko ? "외부 생성 소유자 증명 · Hub 신뢰 평가자 영수증 전에는 공개 봉인 불가" : "Owner-attested external generation · public sealing stays blocked until Hub evaluator receipts exist"}</small>}
          </div>
        )}
      </section>
      </details>

      <details style={{ borderBottom: "1px solid var(--paper-edge)", paddingBottom: 12 }}>
        <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", fontSize: 12.5, fontWeight: 750 }}>
          {ko ? "새 경험 칩 만들기" : "Create a new experience chip"}
        </summary>
      <section style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{ko ? "경험 칩" : "Experience Chips"}</h3>
          <span style={{ padding: "4px 9px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 11, fontWeight: 700 }}>
            {ko ? "내 컴퓨터에만 저장" : "Saved only on this computer"}
          </span>
        </div>
        <p style={{ margin: "0 0 14px", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.55 }}>
          {ko
            ? "이 에이전트가 잘 해결한 방법을 골라 경험칩으로 저장합니다. 원본 기억은 이 컴퓨터에 남고, 공개하기 전에는 반드시 내용을 확인합니다."
            : "Save reviewed ways this agent solved work as experience chips. Original memory stays on this computer and is reviewed before publishing."}
        </p>
        {!agent.packageHash && (
          <div style={{ padding: 10, borderRadius: 8, background: "var(--amber-soft)", color: "var(--amber-deep)", fontSize: 12 }}>
            {ko ? "먼저 이 에이전트를 Hub와 연결해야 경험칩을 만들 수 있습니다." : "Connect this agent to Hub before creating Experience Chips."}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) auto auto", gap: 8, marginTop: 12 }}>
          <input value={packName} onChange={(event) => setPackName(event.target.value)} placeholder={ko ? "경험 칩 이름" : "Experience Chip name"} style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, padding: "9px 10px", background: "var(--paper-2)", color: "var(--ink)" }} />
          <button type="button" onClick={() => void chooseProject()} style={runtimeButtonStyle}>
            {projectPath ? projectPath.split(/[\\/]/).filter(Boolean).at(-1) : (ko ? "프로젝트 폴더 선택" : "Choose project folder")}
          </button>
          <button type="button" disabled={busy || !agent.packageHash || !packName.trim() || !projectPath || !activeRuntime} onClick={() => void createPack()} style={{ ...runtimeButtonStyle, color: "white", background: "var(--accent)", opacity: busy || !agent.packageHash || !packName.trim() || !projectPath || !activeRuntime ? 0.45 : 1 }}>
            {ko ? "경험 칩 만들기" : "Create Experience Chips"}
          </button>
        </div>
        <small style={{ display: "block", marginTop: 8, color: "var(--muted-deep)" }}>
          {activeRuntime ? (ko ? "현재 Mac에서 사용할 수 있습니다." : "Ready to use on this Mac.") : (ko ? "사용 가능한 실행 환경이 필요합니다." : "An available runtime is required.")}
        </small>
        {error && <div role="alert" style={{ marginTop: 10, color: "var(--red-deep)", fontSize: 12 }}>{error}</div>}
      </section>
      </details>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(210px, 0.7fr) minmax(0, 1.8fr)", gap: 14 }}>
        <section style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 12 }}>
          <strong style={{ fontSize: 12.5 }}>{ko ? `내 경험 칩 ${packs.length}개` : `${packs.length} Experience Chips`}</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {packs.length === 0 && <span style={{ color: "var(--muted-deep)", fontSize: 12 }}>{ko ? "아직 경험 칩이 없습니다." : "No Experience Chips yet."}</span>}
            {packs.map((pack) => (
              <button key={pack.id} type="button" onClick={() => setSelectedPackId(pack.id)} data-active={pack.id === selectedPackId ? "true" : "false"} style={{ ...runtimeButtonStyle, textAlign: "left", background: pack.id === selectedPackId ? "var(--accent-soft)" : "var(--paper-2)", color: pack.id === selectedPackId ? "var(--accent)" : "var(--ink-soft)" }}>
                <strong style={{ display: "block" }}>{pack.name}</strong>
                <small>{pack.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? (ko ? "전체 프로젝트" : "All projects")}</small>
              </button>
            ))}
          </div>
        </section>

        <section style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 14 }}>
          {!selectedPack ? (
            <span style={{ color: "var(--muted-deep)", fontSize: 12 }}>{ko ? "경험 칩을 선택하세요." : "Select an Experience Chip."}</span>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 12 }}>
                <div><strong>{selectedPack.name}</strong><small style={{ display: "block", marginTop: 3, color: "var(--muted-deep)" }}>{ko ? "이 Mac에 저장된 경험" : "Experience saved on this Mac"}</small></div>
                <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{ko ? `저장 ${candidates.length} · 검토 완료 ${receipts.length}` : `${candidates.length} saved · ${receipts.length} reviewed`}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, marginBottom: 12 }}>
                <select value={memoryId} onChange={(event) => setMemoryId(event.target.value)} style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, padding: 8, background: "var(--paper-2)", color: "var(--ink)" }}>
                  <option value="">{ko ? "같은 프로젝트의 큐레이팅된 Memory 선택" : "Choose curated Memory from this project"}</option>
                  {eligibleMemory.map((entry) => <option key={entry.id} value={entry.id}>{entry.content.slice(0, 90)}</option>)}
                </select>
                <button type="button" disabled={busy || !memoryId} onClick={() => void captureCandidate()} style={runtimeButtonStyle}>{ko ? "후보 만들기" : "Create candidate"}</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {candidates.length === 0 && <span style={{ color: "var(--muted-deep)", fontSize: 12 }}>{ko ? "검수 대기 후보가 없습니다." : "No Experience candidates yet."}</span>}
                {candidates.map((candidate) => (
                  <div key={candidate.id} style={{ border: "1px solid var(--paper-edge)", borderRadius: 9, padding: 10, background: "var(--paper-2)" }}>
                    <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "flex-start" }}>
                      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}>{candidate.summary}</p>
                      <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: candidate.status === "promoted" ? "var(--green-deep)" : "var(--amber-deep)" }}>{candidate.status === "promoted" ? (ko ? "검토 완료" : "Reviewed") : (ko ? "검토 필요" : "Needs review")}</span>
                    </div>
                    {candidate.status === "candidate" && <button type="button" disabled={busy} onClick={() => void promoteCandidate(candidate)} style={{ ...runtimeButtonStyle, marginTop: 8 }}>{ko ? "내용 확인하기" : "Review content"}</button>}
                    {candidate.status === "promoted" && (
                      <button
                        type="button"
                        aria-pressed={operationalSourceIds.includes(candidate.id)}
                        onClick={() => toggleOperationalSource(candidate.id)}
                        style={{
                          ...runtimeButtonStyle,
                          marginTop: 8,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          color: operationalSourceIds.includes(candidate.id) ? "var(--green-deep)" : "var(--muted-deep)",
                          background: operationalSourceIds.includes(candidate.id) ? "var(--green-soft)" : "var(--paper)",
                        }}
                      >
                        {operationalSourceIds.includes(candidate.id) ? <IconCheck size={13} /> : <IconPlus size={13} />}
                        {ko ? "공개용으로 사용" : "Use in public copy"}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div data-testid="operational-public-projection" style={{ marginTop: 14, padding: 12, borderRadius: 14, border: "1px solid var(--paper-edge)", background: "color-mix(in srgb, var(--paper) 88%, transparent)", boxShadow: "inset 0 1px 0 color-mix(in srgb, white 60%, transparent)" }}>
                <div style={{ marginBottom: 10 }}>
                  <strong style={{ display: "block", fontSize: 13 }}>{ko ? "판매 페이지에 보일 소개" : "What buyers will see"}</strong>
                  <span style={{ display: "block", marginTop: 3, color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}>
                    {ko
                      ? "칩 내용을 바탕으로 초안을 만든 뒤, 구매자가 얻는 효과만 직접 다듬어 확인하세요. 원본 대화와 파일은 공개되지 않습니다."
                      : "Start with a draft based on the chip, then review only the benefits buyers receive. Original conversations and files stay private."}
                  </span>
                </div>
                <div aria-label={ko ? "구매자용 소개 준비 단계" : "Buyer-copy preparation steps"} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 7 }}>
                  {[
                    { icon: <IconCheck size={13} />, label: ko ? "경험 고르기" : "Choose experience", done: operationalSourceIds.length > 0 },
                    { icon: <IconEdit size={13} />, label: ko ? "효과 적기" : "Describe benefits", done: Boolean(operationalProjection) },
                    { icon: <IconShield size={13} />, label: ko ? "개인정보 확인" : "Privacy check", done: operationalPublicReady },
                    { icon: <IconFileUp size={13} />, label: ko ? "등록 요청" : "Request listing", done: latestCloud?.requestedVisibility === "public" },
                  ].map((step) => (
                    <div key={step.label} title={step.label} style={{ minHeight: 38, padding: "5px 7px", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, border: "1px solid var(--paper-edge)", background: step.done ? "color-mix(in srgb, var(--green-deep) 10%, var(--paper))" : "var(--paper-2)", color: step.done ? "var(--green-deep)" : "var(--muted-deep)", fontSize: 10, fontWeight: 800, textAlign: "center" }}>
                      {step.icon}<span>{step.label}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                  <label style={{ display: "grid", gap: 5, minWidth: 0 }}>
                    <span style={{ color: "var(--ink-soft)", fontSize: 11, fontWeight: 800 }}>{ko ? "칩 이름" : "Chip name"}</span>
                    <input aria-label={ko ? "구매자에게 보일 칩 이름" : "Buyer-facing chip name"} value={operationalTitle} onChange={(event) => setOperationalTitle(event.target.value)} placeholder={ko ? "예: 로그인 막힘을 빠르게 해결하는 경험" : "Example: Resolve sign-in blockers faster"} style={{ ...tasteInputStyle, width: "100%", minWidth: 0 }} />
                  </label>
                  <label style={{ display: "grid", gap: 5, minWidth: 0 }}>
                    <span style={{ color: "var(--ink-soft)", fontSize: 11, fontWeight: 800 }}>{ko ? "장착하면 좋아지는 점" : "What improves after attachment"}</span>
                    <textarea aria-label={ko ? "이 칩을 쓰면 좋아지는 점" : "What gets better with this chip"} value={operationalInstructions} onChange={(event) => setOperationalInstructions(event.target.value)} placeholder={ko ? "한 줄에 하나씩, 결과가 어떻게 좋아지는지 적어주세요\n예: 로그인된 브라우저를 먼저 찾아 같은 작업을 다시 하지 않게 합니다" : "Write one clear result per line\nExample: Finds an already signed-in browser first to avoid repeating work"} rows={5} style={{ ...tasteInputStyle, width: "100%", minWidth: 0, resize: "vertical" }} />
                  </label>
                  <label style={{ display: "grid", gap: 5, minWidth: 0 }}>
                    <span style={{ color: "var(--ink-soft)", fontSize: 11, fontWeight: 800 }}>{ko ? "도움 되는 일" : "Work it helps with"}</span>
                    <select aria-label={ko ? "이 칩이 도움 되는 일" : "Work this chip helps with"} value={operationalTask} onChange={(event) => setOperationalTask(event.target.value)} style={{ ...tasteInputStyle, width: "100%", minWidth: 0 }}>
                      <option value="">{ko ? "작업 유형 선택" : "Select task"}</option>
                      {operationalTasks.map((task) => <option key={task} value={task}>{taskLabel(task)}</option>)}
                    </select>
                  </label>
                  <div style={{ display: "grid", gap: 5 }}>
                    <span style={{ color: "var(--ink-soft)", fontSize: 11, fontWeight: 800 }}>{ko ? "사용 환경" : "Supported environment"}</span>
                    <div aria-label={ko ? "사용 환경" : "Supported environment"} style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minHeight: 36, padding: "7px 9px", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper-2)", color: "var(--muted-deep)", fontSize: 10.5 }}>
                      <IconRoute size={13} style={{ color: "var(--accent)" }} />
                      {ko ? "현재 Mac 환경과 호환" : "Compatible with this Mac"}
                    </div>
                  </div>
                </div>
                {operationalProjection?.privacyIssueCodes.length ? (
                  <div role="alert" style={{ marginTop: 8, padding: "8px 10px", borderRadius: 9, background: "var(--amber-soft)", color: "var(--amber-deep)", fontSize: 11.5, lineHeight: 1.5 }}>
                    {ko
                      ? "개인정보로 보이는 내용이 있습니다. 이름, 계정, 로컬 경로가 없는 표현으로 고쳐주세요."
                      : "Some text may contain personal information. Rewrite it without names, accounts, or local paths."}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                  <button type="button" disabled={busy || operationalSourceIds.length === 0} onClick={fillBuyerCopyDraft} style={runtimeButtonStyle}><IconWand size={13} /> {ko ? "자동 소개 만들기" : "Create draft automatically"}</button>
                  <button type="button" disabled={busy || operationalSourceIds.length === 0 || !operationalTitle.trim() || !operationalInstructions.trim() || !operationalTask || !selectedPack.baseAgentReleaseId} onClick={() => void saveOperationalPublicProjection()} style={runtimeButtonStyle}><IconEdit size={13} /> {ko ? "내 소개 저장" : "Save my copy"}</button>
                  <button type="button" disabled={busy || !operationalProjection || operationalProjectionDirty || operationalProjection.privacyIssueCodes.length > 0 || operationalPublicReady} onClick={() => void confirmOperationalPublicProjection()} style={runtimeButtonStyle}><IconShield size={13} /> {ko ? "공개할 문장 확인" : "Approve public copy"}</button>
                  <span title={ko ? "원본 Memory와 후보는 계속 비공개입니다." : "Original Memory and candidates remain private."} style={{ marginLeft: "auto", width: 9, height: 9, borderRadius: 999, background: operationalPublicReady ? "var(--green-deep)" : "var(--amber-deep)", boxShadow: `0 0 0 4px ${operationalPublicReady ? "var(--green-soft)" : "var(--amber-soft)"}` }} />
                </div>
                {!selectedPack.baseAgentReleaseId && <small style={{ display: "block", marginTop: 8, color: "var(--muted-deep)" }}>{ko ? "먼저 에이전트를 비공개로 연결하세요." : "Connect the agent privately first."}</small>}
              </div>

              <div data-testid="experience-cloud-exchange" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--paper-edge)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div>
                    <strong style={{ display: "block", fontSize: 13 }}>{ko ? "Hub에 올리기" : "Publish to Hub"}</strong>
                    <span style={{ display: "block", marginTop: 4, color: "var(--muted-deep)", fontSize: 11.5 }}>{ko ? "원본 기억은 보내지 않고, 내가 확인한 칩 이름과 효과만 전송합니다. 공개 등록 후 Hub에서 판매 가격을 정합니다." : "Only the chip name and benefits you approved are sent; raw memory stays local. Set the selling price on Hub after listing."}</span>
                  </div>
                  {!selectedPack.baseAgentReleaseId && <Link href="/cloud" style={{ color: "var(--accent)", fontSize: 11.5, fontWeight: 700 }}>{ko ? "먼저 에이전트 연결하기 →" : "Connect the agent first →"}</Link>}
                </div>

                <div aria-label={ko ? "경험 공개 준비 상태" : "Experience publishing readiness"} style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", marginTop: 12, borderTop: "1px solid var(--paper-edge)", borderBottom: "1px solid var(--paper-edge)" }}>
                  {[
                    [ko ? "경험 검토" : "Review", receipts.length > 0],
                    [ko ? "개인정보 확인" : "Privacy check", operationalPublicReady],
                    [ko ? "Hub 등록" : "Hub listing", latestCloud?.state === "public-active"],
                  ].map(([label, done], index) => (
                    <div key={String(label)} style={{ padding: "10px", borderLeft: index ? "1px solid var(--paper-edge)" : undefined, color: done ? "var(--green-deep)" : "var(--muted-deep)", fontSize: 11, fontWeight: 700 }}>
                      {done ? <IconCheck size={12} /> : <span aria-hidden="true">○</span>} {label}
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
                  <button type="button" disabled={busy || receipts.length === 0} onClick={() => void savePrivateCloud()} style={{ ...runtimeButtonStyle, background: "var(--paper-2)" }}>
                    {ko ? "내 Hub에 비공개 보관" : "Keep privately in my Hub"}
                  </button>
                  <button
                    type="button"
                    disabled={busy || receipts.length === 0 || !operationalPublicReady}
                    title={!operationalPublicReady ? (ko ? "확인된 공개 안전 사본이 필요합니다." : "A confirmed public-safe copy is required.") : undefined}
                    onClick={() => void requestPublicVerification()}
                    style={{ ...runtimeButtonStyle, color: "white", background: "var(--accent)", opacity: operationalPublicReady ? 1 : 0.45 }}
                  >
                    {ko ? "공개 등록 요청" : "Request public listing"}
                  </button>
                  {latestCloud && ["offline", "conflict", "error", "verification-requested", "verification-pending"].includes(latestCloud.state) && (
                    <button type="button" disabled={busy} onClick={() => void reconcileCloud(latestCloud)} style={runtimeButtonStyle}>
                      {ko ? "상태 다시 맞추기" : "Reconcile status"}
                    </button>
                  )}
                </div>

                {latestCloud ? (
                  <div data-testid="experience-cloud-status" data-cloud-state={latestCloud.state} style={{ marginTop: 10, borderRadius: 8, padding: "9px 10px", background: latestCloud.state === "public-active" ? "var(--green-soft)" : latestCloud.state === "conflict" || latestCloud.state === "error" ? "var(--amber-soft)" : "var(--paper-2)", fontSize: 11.5 }}>
                    <strong>{cloudStateLabel(latestCloud.state)}</strong>
                    <span style={{ display: "block", marginTop: 3, color: "var(--muted-deep)" }}>
                      {latestCloud.state === "public-active"
                        ? (ko ? "구매자에게 공개됐습니다. Hub의 내 보관함에서 판매 가격을 정할 수 있습니다." : "It is public to buyers. Set the selling price from your Hub library.")
                        : latestCloud.state === "verification-requested" || latestCloud.state === "verification-pending"
                          ? (ko ? "개인정보와 공개 가능 여부를 확인하고 있습니다. 아직 구매자에게 보이지 않습니다." : "Privacy and listing safety are being checked. Buyers cannot see it yet.")
                        : latestCloud.state === "conflict"
                          ? latestCloud.errorCode === "private_base_visibility_mismatch"
                            ? (ko
                              ? "이 경험을 판매하려면 먼저 원본 에이전트를 Hub에 공개 등록해야 합니다. 비공개 저장은 이미 완료됐습니다."
                              : "Publish the base agent to Hub before selling this experience. Its private save is already complete.")
                            : (ko ? "로컬 자료는 그대로입니다. Hub 상태를 다시 확인한 뒤 재시도하세요." : "Local material is intact. Refresh the Hub status before retrying.")
                          : latestCloud.errorMessage || (ko ? "Hub에 안전하게 저장되었습니다." : "Saved safely to Hub.")}
                    </span>
                    {latestCloud.state === "conflict" && latestCloud.errorCode === "private_base_visibility_mismatch" ? (
                      <Link href="/cloud" style={{ display: "inline-flex", marginTop: 8, color: "var(--accent)", fontSize: 11.5, fontWeight: 800 }}>
                        {ko ? "원본 에이전트 공개 등록하기 →" : "Publish the base agent →"}
                      </Link>
                    ) : null}
                  </div>
                ) : (
                  <small style={{ display: "block", marginTop: 9, color: "var(--muted-deep)" }}>{ko ? "아직 Cloud로 보낸 경험이 없습니다. 로컬 경험은 그대로 실행에 쓸 수 있습니다." : "No Experience has been sent to Cloud. The local Experience remains usable."}</small>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function BorrowedAgentDetailView({
  profile,
  onBack,
}: {
  profile: BorrowedAgentProfile;
  onBack: () => void;
}) {
  const { locale } = useT();
  const [graph, setGraph] = useState<ExperienceOntologyGraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const name = locale === "en" ? profile.nameEn : profile.name;
  const tagline = locale === "en" ? profile.taglineEn : profile.tagline;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setGraph(null);
    ipc()?.agents.borrowedOntologyGraph(profile.profileId)
      .then((snapshot) => {
        if (!cancelled) setGraph(snapshot);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [profile.profileId]);

  const formatDate = (value: string | null) => value
    ? new Date(value).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : (locale === "ko" ? "아직 실행 안 함" : "Not run yet");

  return (
    <div style={{ flex: 1, overflowY: "auto" }} data-testid="borrowed-agent-detail" data-profile-id={profile.profileId}>
      <header className="titlebar-drag" style={{ minHeight: 64, padding: "12px 24px", borderBottom: "var(--hairline)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="titlebar-nodrag" onClick={onBack} aria-label={locale === "ko" ? "목록으로" : "Back to list"} style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", cursor: "pointer", color: "var(--ink)" }}>
          ‹
        </button>
        <span style={{ width: 38, height: 38, borderRadius: 11, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center" }}>
          <IconLayers size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18 }}>{name}</h1>
          <p style={{ margin: "3px 0 0", color: "var(--muted-deep)", fontSize: 11.5 }}>
            {locale === "ko" ? "Hub 원본과 분리된 이 사용자의 경력 프로필" : "This user's career profile, separate from the Hub original"}
          </p>
        </div>
        <span style={{ padding: "4px 8px", borderRadius: 999, border: "1px solid var(--accent)", color: "var(--accent)", fontSize: 10, fontWeight: 750 }}>
          {profile.entityKind === "team" ? (locale === "ko" ? "대여 팀" : "Borrowed team") : (locale === "ko" ? "대여 에이전트" : "Borrowed agent")}
        </span>
      </header>

      <section style={{ maxWidth: 980, margin: "22px auto 48px", padding: "0 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ padding: 18, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>{locale === "ko" ? "이 사용자에게 속하는 정보" : "Information owned by this user"}</h2>
          {tagline && <p style={{ margin: "8px 0 0", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.6 }}>{tagline}</p>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
            {[
              [locale === "ko" ? "실행 횟수" : "Runs", String(profile.useCount)],
              [locale === "ko" ? "저장된 경험" : "Saved experience", String(profile.memoryCount)],
              [locale === "ko" ? "지도 관계" : "Map relations", String(profile.relationCount)],
              [locale === "ko" ? "마지막 실행" : "Last run", formatDate(profile.lastUsedAt)],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: 12, borderRadius: 10, background: "var(--paper-2)", border: "1px solid var(--paper-edge)" }}>
                <div style={{ color: "var(--muted-deep)", fontSize: 10.5 }}>{label}</div>
                <strong style={{ display: "block", marginTop: 5, fontSize: 12.5 }}>{value}</strong>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 18, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>{locale === "ko" ? "실제 실행 설정" : "Actual runtime settings"}</h2>
          {profile.latestRuntime ? (
            <dl style={{ margin: "14px 0 0", display: "grid", gridTemplateColumns: "110px 1fr", gap: "8px 12px", fontSize: 12 }}>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "실행기" : "Provider"}</dt><dd style={{ margin: 0 }}>{profile.latestRuntime.provider}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "모델" : "Model"}</dt><dd style={{ margin: 0 }}>{profile.latestRuntime.modelId}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "추론 강도" : "Effort"}</dt><dd style={{ margin: 0 }}>{profile.latestRuntime.effort}</dd>
              <dt style={{ color: "var(--muted-deep)" }}>{locale === "ko" ? "선택 방식" : "Selection"}</dt><dd style={{ margin: 0 }}>{profile.latestRuntime.source}</dd>
            </dl>
          ) : (
            <p style={{ margin: "10px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>
              {locale === "ko" ? "이 사용자 범위에서 확인된 실행 설정이 아직 없습니다." : "No runtime setting has been observed in this user's scope yet."}
            </p>
          )}
        </div>

        {profile.hasQuarantinedDeviceHistory && (
          <div role="status" style={{ padding: 14, border: "1px solid var(--amber-deep)", borderRadius: "var(--radius-md)", background: "var(--paper)", color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>
            {locale === "ko"
              ? "로그인 전에 이 기기에 쌓인 기록이 있지만, 현재 계정의 소유물로 자동 귀속하지 않았습니다."
              : "This device has pre-login history, but it was not automatically claimed by the current account."}
          </div>
        )}

        <div>
          <div style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 14 }}>{locale === "ko" ? "메모리 · 경험 지도" : "Memory · experience map"}</h2>
            <p style={{ margin: "5px 0 0", color: "var(--muted-deep)", fontSize: 11.5 }}>
              {locale === "ko"
                ? "원 제작자의 프롬프트·매니페스트가 아니라, 이 사용자가 실행하며 만든 개인 경험만 표시합니다."
                : "This shows only experience created by this user's runs, never the origin author's prompt or manifest."}
            </p>
          </div>
          <AgentOntologyGraphView
            summary={null}
            graphSnapshot={graph}
            hub={null}
            agentName={name}
            locale={locale}
            graphLoading={loading}
            graphError={failed}
          />
        </div>
      </section>
    </div>
  );
}

// ── 3. 에이전트 상세 컨트롤 타워 뷰 컴포넌트 ──────────
interface AgentDetailViewProps {
  node: ResolvedNode;
  agent: InstalledAgent | null;
  activeTab: "identity" | "memory" | "playbook" | "activity" | "ontology";
  onTabChange: (tab: "identity" | "memory" | "playbook" | "activity" | "ontology") => void;
  onBackToOverview: () => void;
  memoryParsed: {
    decisions: { id: string; title: string; content: string; synced?: boolean; enabled?: boolean }[];
    gotchas: { id: string; title: string; content: string; synced?: boolean; enabled?: boolean }[];
    openQuestions: { id: string; title: string; content: string }[];
  };
  /** 런타임 durable 메모리(큐레이터 DB) — memory.md 없이도 타임라인/진화 후보를 채우는 실측 소스. */
  memoryEntries: AgentMemoryEntryUi[];
  evolutionProposals: AgentEvolutionProposalUi[];
  onSaveMemory: (updater: (prev: any) => any) => Promise<void>;
  promptContent: string;
  onCreateEvolution: (newPrompt: string, source?: Record<string, unknown>) => Promise<AgentEvolutionProposalUi | undefined>;
  onApproveEvolution: (proposalId: string) => Promise<void>;
  onRejectEvolution: (proposalId: string) => Promise<void>;
  onRollbackEvolution: (proposalId: string) => Promise<void>;
  saving: boolean;
  ontologyInbox: { id: string; type: "gotcha" | "decision"; title: string; content: string; source: "local" | "cloud" }[];
  onSetOntologyInbox: (v: any) => void;
  showToast: (msg: string) => void;
  agentFiles: WorkspaceNode[];
  runtimeStatuses: RuntimeStatus[];
  runtimeOverrides: AgentRuntimeOverride[];
  nodeContext: SelectedNodeContext | null;
  projects: Project[];
  exactBinding: InstalledAgentExactBinding | null;
  activeProjectId: string;
  onActiveProjectChange: (projectId: string) => void;
  onAttachToProject: (agent: InstalledAgent | null) => void;
  onRuntimeOverridesChange: (items: AgentRuntimeOverride[]) => void;
  onSaveAlias: (value: string) => Promise<void>;
  onRemoveAgent: () => void;
}

function AgentDetailView({
  node,
  agent,
  activeTab,
  onTabChange,
  onBackToOverview,
  memoryParsed,
  memoryEntries,
  evolutionProposals,
  onSaveMemory,
  promptContent,
  onCreateEvolution,
  onApproveEvolution,
  onRejectEvolution,
  onRollbackEvolution,
  saving,
  ontologyInbox,
  onSetOntologyInbox,
  showToast,
  agentFiles,
  runtimeStatuses,
  runtimeOverrides,
  nodeContext,
  projects,
  exactBinding,
  activeProjectId,
  onActiveProjectChange,
  onAttachToProject,
  onRuntimeOverridesChange,
  onSaveAlias,
  onRemoveAgent,
}: AgentDetailViewProps) {
  const { locale } = useT();
  const loadoutRows = useMemo(() => {
    const names = new Set(agentFiles.map((entry) => entry.name.toLowerCase()));
    const has = (...candidates: string[]) => candidates.some((candidate) => names.has(candidate));
    return [
      { key: "skills", labelKo: "Skills", labelEn: "Skills", present: has("skills") },
      { key: "knowledge", labelKo: "Knowledge", labelEn: "Knowledge", present: has("knowledge") },
      { key: "tools", labelKo: "Tools", labelEn: "Tools", present: has("tools") || (agent?.mcpServers?.length ?? 0) > 0, detail: (agent?.mcpServers?.length ?? 0) > 0 ? `MCP ${agent!.mcpServers.length}` : undefined },
      { key: "permissions", labelKo: "Permissions", labelEn: "Permissions", present: has("permissions", "policy.yaml") },
      { key: "contracts", labelKo: "Contracts", labelEn: "Contracts", present: has("contracts") },
      { key: "hooks", labelKo: "Hooks", labelEn: "Hooks", present: has("hooks") },
      { key: "experience", labelKo: "Experience", labelEn: "Experience", present: has("experience") },
    ];
  }, [agent, agentFiles]);

  // 규칙 카드별 열림/닫힘(Accordion) 관리 상태
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  
  // Hub 공유 상태 메타데이터 기본값 토글. 실제 원격 업로드는 Hub/Cloud publish 흐름에서 수행한다.
  const [globalHubSync, setGlobalHubSync] = useState(true);
  const [learningSummary, setLearningSummary] = useState<AgentLearningSummary | null>(null);
  const [learningSummaryLoading, setLearningSummaryLoading] = useState(false);
  const [learningSummaryError, setLearningSummaryError] = useState("");
  const [ontologySummary, setOntologySummary] = useState<ExperienceOntologySummary | null>(null);
  const [ontologySummaryLoading, setOntologySummaryLoading] = useState(false);
  const [ontologySummaryError, setOntologySummaryError] = useState("");
  const [ontologyGraph, setOntologyGraph] = useState<ExperienceOntologyGraphSnapshot | null>(null);
  const [ontologyGraphLoading, setOntologyGraphLoading] = useState(false);
  const [ontologyGraphError, setOntologyGraphError] = useState(false);
  const [ontologyRevision, setOntologyRevision] = useState(0);
  const [hubOntology, setHubOntology] = useState<AgentOntologyHubProjection | null>(null);
  const [hubOntologyLoading, setHubOntologyLoading] = useState(false);
  const [hubOntologyError, setHubOntologyError] = useState("");
  const [hubOntologyRefresh, setHubOntologyRefresh] = useState(0);

  useEffect(() => {
    setOntologyGraph(null);
    setOntologyGraphLoading(false);
    setOntologyGraphError(false);
  }, [activeTab, agent?.id]);

  useEffect(() => {
    const api = ipc();
    if (!api || !agent?.id) {
      setLearningSummary(null);
      setLearningSummaryLoading(false);
      setLearningSummaryError(locale === "ko" ? "설치된 에이전트의 학습 기록만 볼 수 있습니다." : "Learning history is available only for installed agents.");
      return;
    }
    let cancelled = false;
    setLearningSummaryLoading(true);
    setLearningSummaryError("");
    void api.agentLearning.summary(agent.id)
      .then((summary) => {
        if (!cancelled) setLearningSummary(summary);
      })
      .catch((reason) => {
        if (!cancelled) {
          setLearningSummary(null);
          setLearningSummaryError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLearningSummaryLoading(false);
      });
    return () => { cancelled = true; };
  }, [agent?.id, locale]);

  useEffect(() => {
    const api = ipc();
    if (!api || !agent?.id) {
      setOntologySummary(null);
      setOntologySummaryLoading(false);
      setOntologySummaryError(locale === "ko" ? "설치된 에이전트만 경험 요약을 조회할 수 있습니다." : "Only installed agents have an experience summary.");
      return;
    }
    let cancelled = false;
    setOntologySummaryLoading(true);
    setOntologySummaryError("");
    void api.experience.ontologySummary(agent.id)
      .then((summary) => {
        if (!cancelled) setOntologySummary(summary);
      })
      .catch((reason) => {
        if (!cancelled) {
          setOntologySummary(null);
          setOntologySummaryError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setOntologySummaryLoading(false);
      });
    return () => { cancelled = true; };
  }, [agent?.id, locale, ontologyRevision]);

  useEffect(() => {
    if (activeTab !== "ontology") return;
    const api = ipc();
    if (!api || !agent?.id) {
      setOntologyGraph(null);
      setOntologyGraphLoading(false);
      setOntologyGraphError(true);
      return;
    }
    let cancelled = false;
    setOntologyGraph(null);
    setOntologyGraphLoading(true);
    setOntologyGraphError(false);
    void api.experience.ontologyGraph(agent.id)
      .then((snapshot) => {
        if (!cancelled) {
          setOntologyGraph(snapshot);
          setOntologyGraphError(false);
        }
      })
      .catch((reason) => {
        console.warn("[ontology-atlas] relation graph unavailable", reason);
        if (!cancelled) {
          setOntologyGraph(null);
          setOntologyGraphError(true);
        }
      })
      .finally(() => { if (!cancelled) setOntologyGraphLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, agent?.id, ontologyRevision]);

  useEffect(() => {
    if (activeTab !== "ontology") return;
    const api = ipc();
    if (!api || !agent?.id) {
      setHubOntology(null);
      setHubOntologyLoading(false);
      setHubOntologyError(locale === "ko" ? "설치된 에이전트만 Hub 장착 상태를 조회할 수 있습니다." : "Only installed agents have equipped-chip status.");
      return;
    }
    let cancelled = false;
    setHubOntology(null);
    setHubOntologyLoading(true);
    setHubOntologyError("");
    void api.experience.hubProjection(agent.id, hubOntologyRefresh > 0)
      .then((projection) => {
        if (!cancelled) setHubOntology(projection);
      })
      .catch(() => {
        if (!cancelled) {
          setHubOntology(null);
          // Never surface a raw Main/network error: it may include a host path
          // or endpoint detail outside the renderer-safe projection contract.
          setHubOntologyError(locale === "ko" ? "Hub 장착 상태를 안전하게 확인하지 못했습니다." : "Equipped-chip status could not be verified safely.");
        }
      })
      .finally(() => {
        if (!cancelled) setHubOntologyLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, agent?.id, hubOntologyRefresh, locale]);
  const effectiveRuntimeOverride = useMemo(() => {
    const orderedTargets: Array<{ scope: AgentRuntimeOverrideScope; targetId?: string | null }> = [
      { scope: "agent", targetId: node.agentId },
      {
        scope: "division",
        targetId: nodeContext?.firm && nodeContext.division
          ? divisionTargetId(nodeContext.firm.id, nodeContext.division.id)
          : null,
      },
      { scope: "firm", targetId: nodeContext?.firm?.id },
    ];
    for (const target of orderedTargets) {
      if (!target.targetId) continue;
      const found = runtimeOverrides.find((item) => item.scope === target.scope && item.targetId === target.targetId);
      if (found) return found;
    }
    return null;
  }, [node.agentId, nodeContext, runtimeOverrides]);

  // 메모리 진화 타임라인 관리 상태 — 사용자가 수행한 액션만 state로 보관하고,
  // 로드 상태는 아래 observedTimelineEvents에서 현재 파일 상태로 파생한다.
  const [timelineEvents, setTimelineEvents] = useState<AgentLearningEvent[]>([]);

  // 셀프에볼루션 — 실제 메모리(활성 결정·주의 규칙) 중 아직 시스템 프롬프트에 반영되지 않은
  // 학습 규칙을 프롬프트 부록으로 접어 넣는 실데이터 기반 진화 제안. (가짜 텍스트 아님)
  const learnedRules = [...memoryParsed.decisions, ...memoryParsed.gotchas].filter(
    (r) => r.enabled !== false && r.title && !promptContent.includes(r.title),
  );
  const evolutionAppendix = learnedRules.length
    ? "\n\n## Learned rules (folded from memory)\n" +
      learnedRules.map((r) => `- **${r.title}** — ${r.content}`).join("\n")
    : "";
  const hasPendingEvolution = learnedRules.length > 0;
  const evolutionDiff = { old: promptContent, new: promptContent + evolutionAppendix };
  const pendingProposal = evolutionProposals.find((proposal) => proposal.status === "candidate") ?? null;
  const recoveryProposal = evolutionProposals.find((proposal) => proposal.status === "recovery_required" || proposal.status === "conflicted") ?? null;
  const latestReceiptedProposal = evolutionProposals.find((proposal) => proposal.receipts.length > 0) ?? null;
  const displayedProposal = pendingProposal ?? recoveryProposal ?? latestReceiptedProposal;
  const displayedEvolutionDiff = pendingProposal || recoveryProposal
    ? { old: (pendingProposal ?? recoveryProposal)!.beforeContent, new: (pendingProposal ?? recoveryProposal)!.afterContent }
    : hasPendingEvolution
      ? evolutionDiff
      : latestReceiptedProposal
      ? { old: latestReceiptedProposal.beforeContent, new: latestReceiptedProposal.afterContent }
      : evolutionDiff;

  // 런타임 학습(자동 수집) — 큐레이터 DB durable 메모리 중 아직 프롬프트에 반영되지 않은 진화 후보.
  // 반영 여부는 trim 된 본문이 프롬프트에 그대로 포함되는지로 판정(아래 반영 액션이 본문을 그대로 append 하므로 자기 일관적).
  const runtimeEvolutionCandidates = useMemo(
    () =>
      memoryEntries.filter((entry) => {
        const body = entry.content.trim();
        return (
          entry.scope === "agent_repo" &&
          entry.projectPath === null &&
          EVOLUTION_CANDIDATE_KINDS.has((entry.kind || "").toLowerCase()) &&
          (entry.confidence === "high" || entry.confidence === "medium") &&
          body.length > 0 &&
          !promptContent.includes(body)
        );
      }),
    [memoryEntries, promptContent],
  );
  const [selectedRuntimeIds, setSelectedRuntimeIds] = useState<Record<string, boolean>>({});
  const selectedRuntimeEntries = runtimeEvolutionCandidates.filter((e) => selectedRuntimeIds[e.id]);

  // 자동 수집은 검토 후보만 만든다. 승인 전에는 프롬프트/스킬/플레이북 파일을 쓰지 않는다.
  const applyRuntimeEntries = async () => {
    if (selectedRuntimeEntries.length === 0) return;
    const appendix =
      "\n\n## Runtime learnings (auto-collected)\n" +
      selectedRuntimeEntries.map((e) => `- [${e.kind}] ${e.content.trim()}`).join("\n");
    const proposal = await onCreateEvolution(promptContent + appendix, {
      changeOrigin: "runtime_memory_selection",
      memoryEntryIds: selectedRuntimeEntries.map((entry) => entry.id),
    });
    if (!proposal) return;
    setSelectedRuntimeIds({});
    setTimelineEvents((prev) => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "새 개선안을 만들었어요" : "Created a new improvement",
        desc: locale === "ko"
          ? `배운 내용 ${selectedRuntimeEntries.length}개를 묶어 검토할 개선안으로 만들었습니다. 승인하기 전에는 에이전트가 바뀌지 않습니다.`
          : `Combined ${selectedRuntimeEntries.length} learnings into an improvement for review. The agent stays unchanged until approval.`,
        type: "evolution",
      },
      ...prev,
    ]);
  };

  const observedTimelineEvents = useMemo(() => {
    const derived: AgentLearningEvent[] = [];
    if (agentFiles.length > 0) {
      derived.push({
        id: "observed-files",
        timestamp: locale === "ko" ? "현재" : "Now",
        title: locale === "ko" ? "에이전트 자료를 불러왔어요" : "Agent files are ready",
        desc: locale === "ko"
          ? `설정과 기억이 담긴 파일 ${agentFiles.length}개를 연결했습니다.`
          : `Connected ${agentFiles.length} files containing this agent's settings and memory.`,
        type: "sync",
      });
    }
    if (promptContent.trim()) {
      derived.push({
        id: "observed-prompt",
        timestamp: locale === "ko" ? "현재" : "Now",
        title: locale === "ko" ? "에이전트 역할을 확인했어요" : "Agent role confirmed",
        desc: locale === "ko"
          ? "현재 설정된 역할과 행동 기준을 불러왔습니다."
          : "Loaded the agent's current role and working guidelines.",
        type: "sync",
      });
    }
    const memoryCount = memoryParsed.decisions.length + memoryParsed.gotchas.length + memoryParsed.openQuestions.length;
    if (memoryCount > 0) {
      derived.push({
        id: "observed-memory",
        timestamp: locale === "ko" ? "현재" : "Now",
        title: locale === "ko" ? "기억을 정리했어요" : "Memory organized",
        desc: locale === "ko"
          ? `기억 ${memoryCount}개를 기준, 주의할 점, 확인할 일로 나눴습니다.`
          : `Organized ${memoryCount} memories into decisions, cautions, and follow-ups.`,
        type: "sync",
      });
    }
    if (learningSummary && (learningSummary.runCount > 0 || learningSummary.legacyChatLinkedRunCount > 0)) {
      const latestActivityAt = learningSummary.lastRunAt ?? learningSummary.legacyChatLinkedLastRunAt;
      derived.push({
        id: "observed-curation-ledger",
        timestamp: latestActivityAt
          ? formatLearningTime(latestActivityAt, locale)
          : (locale === "ko" ? "기록" : "History"),
        title: learningSummary.curationTurnCount > 0
          ? (locale === "ko" ? "최근 작업에서 배울 내용을 확인했어요" : "Checked recent work for useful learnings")
          : learningSummary.runCount > 0
            ? (locale === "ko" ? "작업 기록을 확인했어요" : "Found work history")
            : (locale === "ko" ? "연결된 이전 대화" : "Related earlier conversations"),
        desc: learningSummary.curationTurnCount > 0
          ? learningSummary.memoryWrittenCount > 0
            ? (locale === "ko"
                ? `최근 작업 ${learningSummary.curationTurnCount}건을 확인해 새로 기억할 내용 ${learningSummary.memoryWrittenCount}개를 저장했습니다.`
                : `Checked ${learningSummary.curationTurnCount} recent tasks and saved ${learningSummary.memoryWrittenCount} useful learnings.`)
            : (locale === "ko"
                ? `최근 작업 ${learningSummary.curationTurnCount}건을 확인했지만 새로 기억할 내용은 없었습니다.`
                : `Checked ${learningSummary.curationTurnCount} recent tasks and found nothing new to remember.`)
          : learningSummary.runCount > 0
            ? (locale === "ko"
                ? `이 에이전트가 맡았던 작업 ${learningSummary.runCount}건을 찾았습니다.`
                : `Found ${learningSummary.runCount} tasks handled by this agent.`)
            : (locale === "ko"
                ? `이 에이전트와 관련된 이전 대화 ${learningSummary.legacyChatLinkedRunCount}건을 찾았습니다.`
                : `Found ${learningSummary.legacyChatLinkedRunCount} earlier conversations related to this agent.`),
        type: "sync",
      });
    }
    // 런타임 durable 메모리(큐레이터 DB) → 실제 학습 타임라인 행(최신순). 파일 파생 이벤트와 나란히 합류.
    const dbRows = [...memoryEntries]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((entry) => buildMemoryLearningEvent(entry, locale));
    const proposalRows = [...evolutionProposals]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((proposal) => ({
        id: `proposal-${proposal.id}`,
        timestamp: formatLearningTime(proposal.appliedAt || proposal.updatedAt, locale),
        title: locale === "ko" ? "에이전트 개선 기록" : "Agent improvement recorded",
        desc: proposal.summary,
        detail: `${proposal.status} · ${proposal.targetPath}`,
        type: "evolution" as const,
      }));
    const curationRows = derived.filter((row) => row.id === "observed-curation-ledger");
    const staticRows = derived.filter((row) => row.id !== "observed-curation-ledger");
    const merged: typeof derived = [...timelineEvents, ...curationRows, ...proposalRows, ...dbRows, ...staticRows];
    return merged;
  }, [agentFiles.length, evolutionProposals, learningSummary, memoryEntries, memoryParsed.decisions.length, memoryParsed.gotchas.length, memoryParsed.openQuestions.length, promptContent, timelineEvents, locale]);

  const toggleItemExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // 메모리 규칙 개별 비활성화/활성화 토글
  const handleToggleRule = (section: "decisions" | "gotchas", id: string) => {
    void onSaveMemory((prev: typeof memoryParsed) => ({
      ...prev,
      [section]: prev[section].map(item => (item.id === id ? { ...item, enabled: item.enabled === false } : item)),
    }));

    const targetItem = memoryParsed[section].find(item => item.id === id);
    if (targetItem) {
      setTimelineEvents(prev => [
        {
          id: `timeline-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          title: targetItem.enabled === false
            ? (locale === "ko" ? "규칙 활성화" : "Rule enabled")
            : (locale === "ko" ? "규칙 비활성화" : "Rule disabled"),
          desc: locale === "ko"
            ? `'${targetItem.title}' 규칙의 런타임 적용 여부를 전환했습니다.`
            : `Toggled whether the '${targetItem.title}' rule applies at runtime.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(locale === "ko" ? "규칙 설정이 저장되었습니다." : "Rule setting saved.");
  };

  // 개별 규칙 Hub 공유 후보/로컬전용 토글
  const handleToggleSync = (section: "decisions" | "gotchas", id: string) => {
    void onSaveMemory((prev: typeof memoryParsed) => ({
      ...prev,
      [section]: prev[section].map(item => (item.id === id ? { ...item, synced: !item.synced } : item)),
    }));

    const targetItem = memoryParsed[section].find(item => item.id === id);
    const nextSynced = targetItem ? !targetItem.synced : false; // 토글 후 상태
    if (targetItem) {
      setTimelineEvents(prev => [
        {
          id: `timeline-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          title: nextSynced
            ? (locale === "ko" ? "클라우드 허브 공유" : "Shared to Cloud Hub")
            : (locale === "ko" ? "로컬 전용 전환" : "Switched to local-only"),
          desc: locale === "ko"
            ? `'${targetItem.title}' 규칙의 Hub 공유 후보 상태를 전환했습니다.`
            : `Toggled the Hub share candidate status of the '${targetItem.title}' rule.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(nextSynced
      ? (locale === "ko" ? "Hub 공유 후보로 표시했습니다." : "Marked as a Hub share candidate.")
      : (locale === "ko" ? "로컬 프로젝트 전용으로 변경되었습니다." : "Changed to local-project-only."));
  };

  // 미결 과제를 결정 사항(Decision)으로 반영 승격
  const handleResolveOpen = (id: string) => {
    const target = memoryParsed.openQuestions.find(item => item.id === id);
    if (!target) return;
    void onSaveMemory((prev: typeof memoryParsed) => {
      const t = prev.openQuestions.find(item => item.id === id);
      if (!t) return prev; // 이미 다른 변이로 처리됨
      return {
        ...prev,
        decisions: [...prev.decisions, { id: t.id, title: t.title, content: t.content + (locale === "ko" ? " (미결 항목 승격 반영)" : " (promoted from an open question)"), synced: globalHubSync, enabled: true }],
        openQuestions: prev.openQuestions.filter(item => item.id !== id),
      };
    });

    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "의사결정 공식 반영" : "Decision formally applied",
        desc: locale === "ko"
          ? `미결 과제였던 '${target.title}'건을 검토 후 공식 Decisions 룰로 승격 처리했습니다.`
          : `Reviewed the open question '${target.title}' and promoted it to an official Decisions rule.`,
        type: "resolve"
      },
      ...prev
    ]);

    showToast(locale === "ko" ? "미결 과제가 결정 사항(Decision)으로 승격 저장되었습니다." : "Open question promoted and saved as a Decision.");
  };

  // 온톨로지 인박스 제안 승인 & 메모리 병합
  const handleApproveInbox = (id: string) => {
    const target = ontologyInbox.find(item => item.id === id);
    if (!target) return;
    const updatedInbox = ontologyInbox.filter(item => item.id !== id);
    onSetOntologyInbox(updatedInbox);

    const newItem = {
      id: target.id,
      title: target.title,
      content: target.content,
      synced: target.source === "cloud" ? true : globalHubSync,
      enabled: true
    };

    void onSaveMemory((prev: typeof memoryParsed) =>
      target.type === "gotcha"
        ? { ...prev, gotchas: [...prev.gotchas, newItem] }
        : { ...prev, decisions: [...prev.decisions, newItem] },
    );

    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: target.source === "cloud"
          ? (locale === "ko" ? "허브 공유 지식 풀(Pull)" : "Pulled shared knowledge from Hub")
          : (locale === "ko" ? "로컬 자동 학습 병합" : "Merged local auto-learning"),
        desc: locale === "ko"
          ? `'${target.title}' 경험 추천 피드백을 에이전트 지식베이스에 승인 및 결합 완료했습니다.`
          : `Approved and merged the ontology suggestion '${target.title}' into the agent's knowledge base.`,
        type: "resolve"
      },
      ...prev
    ]);

    showToast(locale === "ko"
      ? `학습 제안 '${target.title}'이 메모리에 병합 반영되었습니다.`
      : `Learning suggestion '${target.title}' merged into memory.`);
  };

  // 아바타 그라데이션 모노그램
  const detailDisplayName = agent ? agentDisplayName(agent, locale) : node.name;
  const letters = detailDisplayName.slice(0, 2).toUpperCase();
  const getGradient = (tone?: string) => {
    switch (tone) {
      case "blue": return "linear-gradient(135deg, var(--info), var(--info-soft))";
      case "green": return "linear-gradient(135deg, var(--ok), var(--ok-soft))";
      case "purple": return "linear-gradient(135deg, var(--purple-deep), var(--purple-soft))";
      case "amber": return "linear-gradient(135deg, var(--warn), var(--warn-soft))";
      case "peach": return "linear-gradient(135deg, var(--danger), var(--danger-soft))";
      default: return "linear-gradient(135deg, var(--info), var(--info-soft))";
    }
  };

  if (!agent) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--paper-2)" }} data-testid="unbound-org-slot">
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 24px", borderBottom: "var(--hairline)", background: "var(--paper)" }}>
          <button type="button" onClick={onBackToOverview} style={{ minHeight: 44, padding: "0 12px", borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", cursor: "pointer" }}>
            {locale === "ko" ? "← 에이전트 도구함" : "← Agent Toolbox"}
          </button>
          <span style={{ color: "var(--muted-deep)", fontSize: 12 }}>{locale === "ko" ? "조직 구조" : "Organization structure"}</span>
        </div>
        <section style={{ width: "min(680px, calc(100% - 48px))", margin: "56px auto", padding: 24, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--fill-1)", color: "var(--accent)" }}><IconBuilding size={18} /></span>
            <div>
              <h1 style={{ margin: 0, fontSize: 18 }}>{node.name}</h1>
              <p style={{ margin: "4px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>{node.role}</p>
            </div>
          </div>
          <h2 style={{ margin: "22px 0 7px", fontSize: 14 }}>{locale === "ko" ? "아직 실제 에이전트가 연결되지 않은 조직 자리입니다" : "This organization slot has no bound agent yet"}</h2>
          <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.65 }}>
            {locale === "ko"
              ? "이 항목은 회사 위계를 설명하지만 실행 가능한 도구는 아닙니다. Agent ID·신뢰 등급·런타임·메모리·경험 칩을 추정해 표시하지 않습니다. 실제 에이전트를 연결한 뒤 프로젝트 도구함에 장착할 수 있습니다."
              : "This row describes company hierarchy, but it is not an executable tool. Agent ID, trust, runtime, memory, and Experience Chips are not inferred. Bind a real agent before attaching it to a project."}
          </p>
          <div style={{ display: "flex", gap: 9, marginTop: 18, flexWrap: "wrap" }}>
            <button type="button" onClick={() => navigate("/build")} className="agent-run-button">{locale === "ko" ? "에이전트 만들기" : "Build an agent"}</button>
            <button type="button" onClick={() => navigate("/project/new")} style={{ minHeight: 44, padding: "0 12px", borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink)", cursor: "pointer", fontWeight: 700 }}>{locale === "ko" ? "프로젝트 도구 구성 보기" : "Open project tool setup"}</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }} data-tour-id="agents.detail">
      
      {/* 본 영역 (좌측 탭 컨텐츠) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100%", overflow: "hidden" }}>
        
        {/* 상단 액션 바 */}
        <div className="agent-detail-actionbar" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "var(--hairline)", background: "var(--paper)", minWidth: 0 }}>
          <button
            onClick={onBackToOverview}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              minHeight: 44,
              padding: "0 10px",
              borderRadius: 6,
              background: "var(--paper-2)",
              border: "1px solid var(--paper-edge)",
              color: "var(--ink-soft)",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {locale === "ko" ? "← 도구함 개요" : "← Toolbox overview"}
          </button>
          <div style={{ height: 12, width: 1, background: "var(--paper-edge)" }} />
          <div style={{ flex: "1 1 120px", minWidth: 0, fontSize: 13, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {agent?.kind === "team" ? (locale === "ko" ? "프로젝트용 팀 도구" : "Project team tool") : (locale === "ko" ? "프로젝트용 전문가 도구" : "Project specialist tool")}
          </div>
          <ProjectAttachControl
            projects={projects}
            projectId={activeProjectId}
            entityKind="agent"
            localTargetId={agent?.id}
            locale={locale}
            disabled={!agent}
            onProjectChange={onActiveProjectChange}
            onAttach={() => onAttachToProject(agent)}
          />
        </div>

        {/* 에이전트 마스터 헤더 */}
        <header style={{ padding: "20px 24px", background: "var(--paper)", borderBottom: "var(--hairline)", display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "var(--radius-md)",
              background: getGradient(agent?.tone),
              color: "var(--white)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              fontWeight: 700,
              boxShadow: "var(--glass-shadow)"
            }}
          >
            {letters}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
              {agent ? (
                <AgentNameEditor agent={agent} locale={locale} onSave={onSaveAlias} />
              ) : (
                <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{detailDisplayName}</h1>
              )}
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "var(--fill-1)", color: "var(--accent)", fontWeight: 700 }}>
                {node.role}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)" }}>
              {agent?.tagline || (locale === "ko" ? `${detailDisplayName}의 규칙 지식베이스 및 계약 런타임` : `${detailDisplayName}'s rule knowledge base and contract runtime`)}
            </p>
          </div>
        </header>

        {/* 탭 네비게이션 */}
        <nav data-testid="agent-detail-tabs" style={{ display: "flex", gap: 4, padding: "8px 24px", background: "var(--paper)", borderBottom: "var(--hairline)", overflowX: "auto", flexShrink: 0 }}>
          {(["identity", "memory", "playbook", "activity", "ontology"] as const).map((tab) => {
            const active = activeTab === tab;
            const labels = {
              identity: locale === "ko" ? "정체성·권한" : "Identity & permissions",
              memory: locale === "ko" ? "로컬 기억" : "Local memory",
              playbook: locale === "ko" ? "구성요소" : "Loadout",
              activity: locale === "ko" ? "변경 기록" : "Change history",
              ontology: locale === "ko" ? "경험 칩" : "Experience Chips",
            };
            return (
              <button
                key={tab}
                onClick={() => onTabChange(tab)}
                aria-current={active ? "page" : undefined}
                style={{
                  minHeight: 44,
                  padding: "8px 16px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12.5,
                  fontWeight: active ? 700 : 500,
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent)" : "var(--ink-soft)",
                  border: "none",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  whiteSpace: "nowrap",
                }}
              >
                {labels[tab]}
              </button>
            );
          })}
        </nav>

        {/* 탭 콘텐츠 영역 */}
        <div style={{ flex: 1, overflowY: "auto", padding: 24, position: "relative" }}>
          
          {/* 탭 1: 정체성 & 페르소나 */}
          {activeTab === "identity" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 840 }}>

              <div data-testid="governed-agent-identity" style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h3 style={{ margin: "0 0 7px", fontSize: 14 }}>{locale === "ko" ? "도구 정체성은 내용과 분리됩니다" : "Tool identity is separate from its contents"}</h3>
                <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>
                  {locale === "ko"
                    ? "로컬 설치 ID, 불변 에이전트 정의 ID, 정확한 릴리스를 서로 분리합니다. 원격 자산은 검증된 정의·릴리스 바인딩이 있을 때만 프로젝트에 장착됩니다."
                    : "Local installation ID, immutable agent definition ID, and exact release stay separate. Remote tools attach to projects only with a verified definition-release binding."}
                </p>
              </div>

              <RuntimeAssignmentPanel
                node={node}
                agent={agent}
                nodeContext={nodeContext}
                runtimeStatuses={runtimeStatuses}
                runtimeOverrides={runtimeOverrides}
                onRuntimeOverridesChange={onRuntimeOverridesChange}
                showToast={showToast}
              />

              {/* 매핑 메타 데이터 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "런타임 정보" : "Runtime info"}</h4>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "var(--ink-soft)" }}>
                    <div><strong>{locale === "ko" ? "로컬 설치 ID:" : "Local installation ID:"}</strong> {node.agentId ?? (locale === "ko" ? "조직 자리 · 실제 에이전트 미연결" : "Organization slot · no agent bound")}</div>
                    {exactBinding ? (
                      <>
                        <div><strong>{locale === "ko" ? "에이전트 정의 ID:" : "Agent definition ID:"}</strong> {exactBinding.agentDefinitionId}</div>
                        <div><strong>{locale === "ko" ? "정확한 릴리스:" : "Exact release:"}</strong> {exactBinding.agentReleaseId}</div>
                      </>
                    ) : agent.assetSource === "hub" || agent.assetSource === "agent-cloud" ? (
                      <div style={{ color: "var(--amber-deep)" }}><strong>{locale === "ko" ? "릴리스 바인딩:" : "Release binding:"}</strong> {locale === "ko" ? "확인 필요 · 프로젝트 장착 차단" : "Verification required · project attach blocked"}</div>
                    ) : null}
                    {agent?.packageHash && <div><strong>{locale === "ko" ? "패키지 해시:" : "Package hash:"}</strong> {agent.packageHash.slice(0, 16)}…</div>}
                    <div><strong>{locale === "ko" ? "적용 런타임:" : "Active runtime:"}</strong> {effectiveRuntimeOverride ? selectionSummary(effectiveRuntimeOverride.selection, locale) : (locale === "ko" ? "역할별 자동 라우팅" : "Role-based auto-routing")}</div>
                    <div><strong>{locale === "ko" ? "신뢰 등급:" : "Trust grade:"}</strong> Trust {agent.trustGrade}</div>
                    <div><strong>{locale === "ko" ? "원본 출처:" : "Origin:"}</strong> {agent.assetSource === "agent-cloud" ? "Agent Cloud" : agent.assetSource === "hub" ? "Agentlas Hub" : (locale === "ko" ? "로컬 가져오기" : "Local import")}</div>
                    <div><strong>{locale === "ko" ? "가용 상태:" : "Availability:"}</strong> {agent.sourceMissingSince ? (locale === "ko" ? "원본 경로 연결 끊김" : "Source path disconnected") : (locale === "ko" ? "이 Mac에 설치된 실행 사본" : "Installed execution copy on this Mac")}</div>
                    <div><strong>{locale === "ko" ? "보관 근거:" : "Custody evidence:"}</strong> {agent.assetSource === "agent-cloud"
                      ? (locale === "ko" ? "Agent Cloud에서 복원된 실행 사본 · 소유권 별도 확인" : "Execution copy restored from Agent Cloud · ownership not independently verified")
                      : agent.assetSource === "hub"
                        ? (locale === "ko" ? "Hub 패키지의 로컬 실행 사본 · 게시자 소유권 별도" : "Local execution copy of a Hub package · publisher ownership is separate")
                        : (locale === "ko" ? "이 Mac의 로컬 폴더에서 가져온 사본 · 소유권 미확인" : "Copy imported from a local folder on this Mac · ownership unverified")}</div>
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "외부 도구연동" : "External tool integrations"}</h4>
                  <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    {agent?.mcpServers && agent.mcpServers.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        {agent.mcpServers.map((s) => (
                          <span key={s} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--fill-1)", color: "var(--accent)" }}>{s}</span>
                        ))}
                      </div>
                    ) : (
                      locale === "ko" ? "연동된 외부 MCP 서버 도구가 없습니다." : "No external MCP server tools connected."
                    )}
                  </div>
                </div>
              </div>

              {agent && (
                <details style={{ alignSelf: "flex-start", color: "var(--muted-deep)", fontSize: 11.5 }}>
                  <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", fontWeight: 700 }}>
                    {locale === "ko" ? "설치 관리" : "Installation management"}
                  </summary>
                  <div style={{ display: "grid", gap: 9, maxWidth: 520, padding: "2px 0 4px" }}>
                    <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>
                      {locale === "ko"
                        ? "제거하면 연결된 프로젝트의 도구함에서도 장착 해제됩니다. 확인 단계에서 영향을 받는 프로젝트를 먼저 보여주며 원본 폴더는 삭제하지 않습니다."
                        : "Removal also detaches this tool from connected projects. The confirmation lists affected projects first, and the source folder is not deleted."}
                    </p>
                    <button
                      type="button"
                      onClick={onRemoveAgent}
                      style={{ justifySelf: "start", minHeight: 44, padding: "0 14px", borderRadius: 8, border: "1px solid var(--red-deep)", background: "transparent", color: "var(--red-deep)", cursor: "pointer", fontWeight: 700 }}
                    >
                      {locale === "ko" ? "프로젝트 영향 확인 후 제거" : "Review project impact and remove"}
                    </button>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* 탭 2: 큐레이팅된 메모리 */}
          {activeTab === "memory" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 840 }}>

              {/* 메모리 요약 — 비개발자 어휘로 한 문장. 그래프는 아래의 2차(고급) 보기에서. */}
              <p style={{ margin: 0, padding: "12px 14px", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper)", color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>
                {locale === "ko"
                  ? "여기에는 프로젝트에 속하지 않는 에이전트 전역 기억만 표시합니다. 프로젝트 작업에서 생긴 기억은 해당 프로젝트 화면에서만 확인합니다."
                  : "This view shows only agent-wide memory that is not owned by a project. Memory created during project work is visible only inside that project."}
              </p>
              <div className="memory-summary">
                <div className="memory-summary-line">
                  {locale === "ko" ? "이 에이전트가 기억하는 것: 결정 " : "What this agent remembers: Decisions "}<strong>{memoryParsed.decisions.length}</strong>
                  {" · "}{locale === "ko" ? "주의 " : "Gotchas "}<strong>{memoryParsed.gotchas.length}</strong>
                  {" · "}{locale === "ko" ? "미결 " : "Open "}<strong>{memoryParsed.openQuestions.length}</strong>
                  {(() => {
                    const synced = [...memoryParsed.decisions, ...memoryParsed.gotchas].filter((r) => r.synced).length;
                    return synced > 0 ? <> · {locale === "ko" ? "공유 후보 표시 " : "Marked as share candidates "}<strong>{synced}</strong></> : null;
                  })()}
                </div>
                <div className="memory-summary-note">
                  {locale === "ko"
                    ? "여기는 설치 패키지의 로컬 curated notes입니다. 프로젝트의 작업 상태와 원시 기억은 프로젝트 .agentlas에 남고, 검토된 해결법만 별도의 경험 칩으로 승격됩니다. ‘공유 후보’ 표시는 업로드 영수증이 아닙니다."
                    : "These are local curated notes for the installed package. Project state and raw memory stay in the project's .agentlas folder; only reviewed solutions can become separate Experience Chips. A share-candidate mark is not an upload receipt."}
                </div>
              </div>

              {/* Phase 1b: 기존 메모리 가져오기 — 폴더 선택 → 미리보기 → 적용 */}
              {agent?.id && (
                <MemoryImportPanel agentId={agent.id} locale={locale} showToast={showToast} />
              )}

              {/* 온톨로지 인박스 알림 영역 */}
              {ontologyInbox.length > 0 && (
                <div style={{ border: "1px solid var(--accent-soft)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
                  <div style={{ background: "var(--fill-1)", padding: "10px 16px", display: "flex", alignItems: "center", justifyItems: "space-between", borderBottom: "1px solid var(--accent-soft)" }}>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>
                      <IconBrain size={14} />
                      {locale === "ko" ? "경험 인박스 (학습된 정보 추천)" : "Experience inbox (learned-info suggestions)"}
                    </div>
                    <span style={{ fontSize: 10, background: "var(--accent)", color: "var(--white)", padding: "1px 6px", borderRadius: 999 }}>{ontologyInbox.length}</span>
                  </div>
                  <div style={{ background: "var(--paper)", display: "flex", flexDirection: "column" }}>
                    {ontologyInbox.map((item) => (
                      <div key={item.id} style={{ padding: "12px 16px", display: "flex", alignItems: "flex-start", justifyItems: "space-between", gap: 12, borderBottom: "1px solid var(--paper-edge)" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: item.source === "cloud" ? "var(--accent)" : "var(--fill-2)", color: item.source === "cloud" ? "var(--white)" : "var(--accent)" }}>
                              {item.source === "cloud" ? (locale === "ko" ? "허브 추천" : "Hub suggestion") : (locale === "ko" ? "로컬 학습" : "Local learning")}
                            </span>
                            <strong style={{ fontSize: 12.5, color: "var(--ink)" }}>{item.title}</strong>
                          </div>
                          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-soft)" }}>{item.content}</p>
                        </div>
                        <button
                          onClick={() => handleApproveInbox(item.id)}
                          style={{
                            padding: "6px 12px",
                            background: "var(--accent)",
                            color: "var(--white)",
                            border: "none",
                            borderRadius: 6,
                            fontSize: 11.5,
                            fontWeight: 600,
                            cursor: "pointer",
                            flexShrink: 0
                          }}
                        >
                          {locale === "ko" ? "반영 승인" : "Approve"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 메모리 리스트 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                
                {/* Decisions 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconCheck size={14} style={{ color: "var(--green-deep)" }} />
                    {locale === "ko" ? "결정 사항 (Decisions)" : "Decisions"}
                  </h3>
                  {memoryParsed.decisions.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      {locale === "ko" ? "기록된 결정 사항이 없습니다." : "No decisions recorded."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {memoryParsed.decisions.map((item) => {
                        const expanded = expandedItems[item.id];
                        const enabled = item.enabled !== false;
                        return (
                          <div
                            key={item.id}
                            style={{
                              background: "var(--paper)",
                              border: "1px solid var(--paper-edge)",
                              borderRadius: "var(--radius-sm)",
                              opacity: enabled ? 1 : 0.6,
                              transition: "all 0.15s"
                            }}
                          >
                            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyItems: "space-between", gap: 8 }}>
                              <button
                                onClick={() => toggleItemExpand(item.id)}
                                style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "none", border: "none", cursor: "pointer", color: "var(--ink)", textAlign: "left" }}
                              >
                                {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                                <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                              </button>
                              
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                {/* 클라우드 허브 공유 상태 */}
                                <button
                                  onClick={() => handleToggleSync("decisions", item.id)}
                                  title={item.synced ? (locale === "ko" ? "허브 동기화됨" : "Synced to Hub") : (locale === "ko" ? "로컬 전용 규칙" : "Local-only rule")}
                                  style={{
                                    border: "none",
                                    background: "none",
                                    cursor: "pointer",
                                    color: item.synced ? "var(--accent)" : "var(--muted)"
                                  }}
                                >
                                  <IconPaperclip size={12} />
                                </button>
                                {/* 규칙 활성 토글 */}
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={() => handleToggleRule("decisions", item.id)}
                                  style={{ width: 14, height: 14, cursor: "pointer" }}
                                />
                              </div>
                            </div>
                            
                            {expanded && (
                              <div style={{ padding: "0 14px 12px 34px", fontSize: 12, color: "var(--ink-soft)", borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                                <p style={{ margin: 0, lineHeight: 1.6 }}>{item.content}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Gotchas 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconShield size={14} style={{ color: "var(--peach-ink)" }} />
                    {locale === "ko" ? "주의 사항 (Gotchas)" : "Gotchas"}
                  </h3>
                  {memoryParsed.gotchas.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      {locale === "ko" ? "기록된 주의 사항이 없습니다." : "No gotchas recorded."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {memoryParsed.gotchas.map((item) => {
                        const expanded = expandedItems[item.id];
                        const enabled = item.enabled !== false;
                        return (
                          <div
                            key={item.id}
                            style={{
                              background: "var(--paper)",
                              border: "1px solid var(--paper-edge)",
                              borderRadius: "var(--radius-sm)",
                              opacity: enabled ? 1 : 0.6,
                              transition: "all 0.15s"
                            }}
                          >
                            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyItems: "space-between", gap: 8 }}>
                              <button
                                onClick={() => toggleItemExpand(item.id)}
                                style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "none", border: "none", cursor: "pointer", color: "var(--ink)", textAlign: "left" }}
                              >
                                {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                                <strong style={{ fontSize: 12.5, color: "var(--peach-ink)" }}>{item.title}</strong>
                              </button>
                              
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <button
                                  onClick={() => handleToggleSync("gotchas", item.id)}
                                  style={{ border: "none", background: "none", cursor: "pointer", color: item.synced ? "var(--accent)" : "var(--muted)" }}
                                >
                                  <IconPaperclip size={12} />
                                </button>
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={() => handleToggleRule("gotchas", item.id)}
                                  style={{ width: 14, height: 14, cursor: "pointer" }}
                                />
                              </div>
                            </div>
                            
                            {expanded && (
                              <div style={{ padding: "0 14px 12px 34px", fontSize: 12, color: "var(--ink-soft)", borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                                <p style={{ margin: 0, lineHeight: 1.6 }}>{item.content}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Open Questions 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconWand size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "미결 과제 (Open Questions)" : "Open Questions"}
                  </h3>
                  {memoryParsed.openQuestions.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      {locale === "ko" ? "기록된 미결 과제가 없습니다." : "No open questions recorded."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {memoryParsed.openQuestions.map((item) => (
                        <div
                          key={item.id}
                          style={{
                            background: "var(--paper)",
                            border: "1px solid var(--paper-edge)",
                            borderRadius: "var(--radius-sm)",
                            padding: "10px 14px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 12
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                            <p style={{ margin: "2px 0 0 0", fontSize: 11.5, color: "var(--ink-soft)" }}>{item.content}</p>
                          </div>
                          <button
                            onClick={() => handleResolveOpen(item.id)}
                            style={{
                              padding: "4px 10px",
                              background: "var(--fill-1)",
                              color: "var(--accent)",
                              border: "1px solid var(--accent-soft)",
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: "pointer",
                              whiteSpace: "nowrap"
                            }}
                          >
                            {locale === "ko" ? "결정 승격" : "Promote to decision"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

              {/* 사용자에게 이해하기 쉬운 학습 기록. 원본 기술 로그는 각 항목 안에서만 펼친다. */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <div style={{ marginBottom: 14 }}>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 750, display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
                    <IconRoute size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "에이전트가 배운 내용" : "What this agent learned"}
                  </h4>
                  <p style={{ margin: "4px 0 0 20px", fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.45 }}>
                    {locale === "ko" ? "다음 작업에 활용할 기억과 개선 내용을 확인하세요." : "Review memories and improvements that can help with future work."}
                  </p>
                </div>
                <AgentLearningHistory events={observedTimelineEvents} locale={locale} />
              </div>

            </div>
          )}

          {/* 경험 탭 — 프로필 카드와 경험 지도가 정면, 관리 도구는 그 아래. */}
          {activeTab === "ontology" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1180 }}>
              <section data-testid="agent-local-experience" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <ExperienceProfileCard
                  agent={agent}
                  summary={ontologySummary}
                  hub={hubOntology}
                  locale={locale}
                />
                <AgentOntologyGraphView
                  summary={ontologySummary}
                  graphSnapshot={ontologyGraph}
                  hub={hubOntology}
                  agentName={agent ? agentDisplayName(agent, locale) : (locale === "ko" ? "에이전트" : "Agent")}
                  locale={locale}
                  graphLoading={ontologyGraphLoading}
                  graphError={ontologyGraphError}
                  onRetry={() => setOntologyRevision((current) => current + 1)}
                />
                <div data-testid="ontology-human-guide" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 9 }}>
                  <div style={{ padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
                    <strong style={{ display: "block", fontSize: 12.5 }}>{locale === "ko" ? "구매한 경험 칩 쓰기" : "Use a purchased chip"}</strong>
                    <span style={{ display: "block", marginTop: 4, color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.5 }}>
                      {locale === "ko" ? "아래에서 이 도구에 장착된 칩과 다음 프로젝트 실행 적용 상태를 확인합니다." : "See what is attached to this tool and what will apply to the next project run below."}
                    </span>
                    <Link href="/marketplace?view=experience" className="btn sm" style={{ display: "inline-flex", marginTop: 9 }}>
                      {locale === "ko" ? "Hub에서 경험칩 찾기" : "Find chips on Hub"}
                    </Link>
                  </div>
                  <div style={{ padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
                    <strong style={{ display: "block", fontSize: 12.5 }}>{locale === "ko" ? "내 경험 칩 만들고 팔기" : "Create and sell my chip"}</strong>
                    <span style={{ display: "block", marginTop: 4, color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.5 }}>
                      {locale === "ko" ? "실제 작업에서 배운 해결법을 고르고, 개인정보를 뺀 소개와 가격을 정합니다." : "Choose a method learned from real work, then set privacy-safe buyer copy and a price."}
                    </span>
                  </div>
                </div>
                <AgentHubOntologyProjectionView
                  result={hubOntology}
                  loading={hubOntologyLoading}
                  error={hubOntologyError}
                  locale={locale}
                  onRefresh={() => setHubOntologyRefresh((current) => current + 1)}
                  onResolveApproval={async (approvalId, decision) => {
                    const api = ipc();
                    if (!api || !agent?.id) throw new Error("Agentlas Desktop is unavailable.");
                    const resolved = await api.experience.hubResolveAttach(agent.id, approvalId, decision);
                    setHubOntology(resolved.projection);
                    return resolved;
                  }}
                />
                <details data-testid="ontology-chip-management" style={{ border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", overflow: "hidden" }}>
                  <summary style={{ listStyle: "none", cursor: "pointer", minHeight: 56, padding: "10px 12px", display: "flex", alignItems: "center", gap: 9 }}>
                    <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 11, display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent)", boxShadow: "inset 0 1px 0 color-mix(in srgb, white 55%, transparent)" }}><IconLayers size={15} /></span>
                    <div>
                      <strong style={{ display: "block", fontSize: 13 }}>{locale === "ko" ? "내 경험칩 만들기·판매" : "Create and sell my Experience Chips"}</strong>
                      <span style={{ display: "block", marginTop: 2, color: "var(--muted-deep)", fontSize: 10.5 }}>{locale === "ko" ? "필요할 때만 열어 판매할 경험과 공개 상태를 관리합니다." : "Open only when you want to manage saleable experience and publishing."}</span>
                    </div>
                    <span title={locale === "ko" ? "저장된 경험칩" : "Saved Experience Chips"} style={{ padding: "3px 7px", border: "1px solid var(--paper-edge)", borderRadius: 999, color: "var(--green-deep)", background: "var(--green-soft)", fontSize: 10, fontWeight: 750 }}>{locale === "ko" ? "경험" : "Experience"} {ontologySummary?.packCount ?? 0}</span>
                    <span title={locale === "ko" ? "아직 검토할 취향" : "Taste drafts to review"} style={{ padding: "3px 7px", border: "1px solid var(--paper-edge)", borderRadius: 999, color: "var(--amber-deep)", background: "var(--amber-soft)", fontSize: 10, fontWeight: 750 }}>{locale === "ko" ? "취향" : "Taste"} {ontologySummary?.tasteDraftCount ?? 0}</span>
                    <span aria-hidden="true" style={{ marginLeft: "auto", width: 7, height: 7, borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", transform: "rotate(45deg) translateY(-2px)", color: "var(--muted-deep)" }} />
                  </summary>
                  <div style={{ padding: "4px 12px 12px", borderTop: "1px solid var(--paper-edge)" }}>
                    <ExperiencePanel
                      agent={agent}
                      memoryEntries={memoryEntries}
                      runtimeStatuses={runtimeStatuses}
                      locale={locale}
                      showToast={showToast}
                      onChanged={() => setOntologyRevision((current) => current + 1)}
                    />
                  </div>
                </details>
                <ExperienceOntologySummaryView
                  summary={ontologySummary}
                  loading={ontologySummaryLoading}
                  error={ontologySummaryError}
                  locale={locale}
                />
                <details data-testid="ontology-local-about" style={{ border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper-2)", overflow: "hidden" }}>
                  <summary style={{ listStyle: "none", cursor: "pointer", minHeight: 52, padding: "9px 12px", display: "flex", alignItems: "center", gap: 9 }}>
                    <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--paper)", color: "var(--green-deep)" }}><IconRoute size={14} /></span>
                    <h3 style={{ margin: 0, fontSize: 13 }}>{locale === "ko" ? "이 Mac에서 쌓인 경험이란?" : "What is experience accumulated on this Mac?"}</h3>
                    <span title={locale === "ko" ? "검토할 경험 항목" : "Experience items to review"} style={{ marginLeft: "auto", padding: "3px 7px", border: "1px solid var(--paper-edge)", borderRadius: 999, background: "var(--paper)", color: "var(--muted-deep)", fontSize: 10, fontWeight: 750 }}>{ontologySummary?.candidateCount ?? 0}</span>
                    <span aria-hidden="true" style={{ width: 7, height: 7, borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", transform: "rotate(45deg) translateY(-2px)", color: "var(--muted-deep)" }} />
                  </summary>
                  <p style={{ margin: 0, padding: "10px 12px 12px", borderTop: "1px solid var(--paper-edge)", color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.55 }}>
                    {locale === "ko"
                      ? "에이전트가 실제 작업에서 배운 해결법을 이 Mac에 비공개로 모아 둔 것입니다. 내가 고른 항목만 개인정보 검사를 거쳐 Hub에 등록할 수 있으며, 자동 업로드·구매·장착되지 않습니다."
                      : "These are solutions the agent learned from real work and kept privately on this Mac. Only items you select can be privacy-checked and listed on Hub; nothing is uploaded, purchased, or attached automatically."}
                  </p>
                </details>
              </section>
            </div>
          )}

          {/* 탭 3: 플레이북 & 워크플로우 */}
          {activeTab === "playbook" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 840 }}>
              {/* 구성요소는 읽기만 하는 목록이 아니라 고칠 수 있는 자리다 — 배관(read/write)은
                  이미 있었고 없던 것은 화면뿐이었다. */}
              {agent?.id && <AgentFileEditor agentId={agent.id} locale={locale} />}
              <section style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 6px", fontSize: 13.5 }}>{locale === "ko" ? "장착 구성요소" : "Attached loadout"}</h4>
                <p style={{ margin: "0 0 13px", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}>
                  {locale === "ko"
                    ? "패키지에서 실제로 발견한 최상위 구성만 표시합니다. ‘선언 없음’은 고장 판정이 아니라, 현재 설치본에서 확인하지 못했다는 뜻입니다."
                    : "Only top-level components actually observed in the installed package are shown. Not declared means unobserved here, not necessarily broken."}
                </p>
                <div style={{ display: "grid", border: "1px solid var(--paper-edge)", borderRadius: 10, overflow: "hidden" }}>
                  {loadoutRows.map((row, index) => (
                    <div key={row.key} style={{ minHeight: 48, padding: "8px 11px", borderBottom: index === loadoutRows.length - 1 ? 0 : "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
                      <strong style={{ minWidth: 0, fontSize: 12.5 }}>{locale === "ko" ? row.labelKo : row.labelEn}</strong>
                      <span style={{ flexShrink: 0, padding: "3px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 720, color: row.present ? "var(--green-deep)" : "var(--muted-deep)", background: row.present ? "var(--green-soft)" : "var(--paper-2)" }}>
                        {row.detail ?? (row.present ? (locale === "ko" ? "발견됨" : "Observed") : (locale === "ko" ? "선언 없음" : "Not declared"))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 14px 0", fontSize: 13.5, fontWeight: 700 }}>{locale === "ko" ? "실행 루프 (Runtime Loop)" : "Runtime Loop"}</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                  {[
                    { label: "Route", desc: locale === "ko" ? "프로젝트 작업의 요구사항과 맞을 때 이 도구가 실행 후보가 됩니다." : "This tool becomes an execution candidate when it matches a project's work requirements.", icon: IconRoute },
                    { label: "Context", desc: locale === "ko" ? "프로젝트, Env, 메모리 규칙이 invocation에 주입됩니다." : "Project, env, and memory rules are injected into the invocation.", icon: IconBrain },
                    { label: "Tools", desc: locale === "ko" ? "필요한 MCP 서버와 로컬 권한을 확인합니다." : "Checks the required MCP servers and local permissions.", icon: IconLayers },
                    { label: "Persist", desc: locale === "ko" ? "학습은 durable DB에, 승인·롤백은 영수증에 남습니다. 플레이북 파일은 승인 없이 생기지 않습니다." : "Learning is stored in the durable DB and approve/rollback actions in receipts. No playbook file is created without approval.", icon: IconPaperclip },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.label} style={{ border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper-2)", padding: 12, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                          <Icon size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                          <strong style={{ fontSize: 12.5 }}>{item.label}</strong>
                        </div>
                        <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--ink-soft)" }}>{item.desc}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 13.5 }}>{locale === "ko" ? "실제 학습·파일·영수증" : "Actual learning, files & receipts"}</h4>
                <AgentLearningMetricGrid
                  summary={learningSummary}
                  loading={learningSummaryLoading}
                  error={learningSummaryError}
                  locale={locale}
                  context="playbook"
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconRoute size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "라우팅 카드" : "Routing card"}
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55 }}>
                    <div><strong>{locale === "ko" ? "역할:" : "Role:"}</strong> {node.role || (locale === "ko" ? "자동 라우팅" : "Auto-routing")}</div>
                    <div><strong>{locale === "ko" ? "로컬 설치 ID:" : "Local installation ID:"}</strong> {node.agentId ?? (locale === "ko" ? "미연결 조직 자리" : "Unbound organization slot")}</div>
                    <div><strong>{locale === "ko" ? "적용 런타임:" : "Active runtime:"}</strong> {effectiveRuntimeOverride ? selectionSummary(effectiveRuntimeOverride.selection, locale) : (locale === "ko" ? "런타임 자동 선택" : "Automatic runtime selection")}</div>
                    <div><strong>{locale === "ko" ? "신뢰 등급:" : "Trust grade:"}</strong> Trust {agent.trustGrade}</div>
                    <div><strong>{locale === "ko" ? "원본 출처:" : "Origin:"}</strong> {agent.assetSource === "agent-cloud" ? "Agent Cloud" : agent.assetSource === "hub" ? "Agentlas Hub" : (locale === "ko" ? "로컬 가져오기" : "Local import")}</div>
                    <div><strong>{locale === "ko" ? "가용 상태:" : "Availability:"}</strong> {agent.sourceMissingSince ? (locale === "ko" ? "원본 경로 연결 끊김" : "Source path disconnected") : (locale === "ko" ? "이 Mac에 설치된 실행 사본" : "Installed execution copy on this Mac")}</div>
                    <div><strong>{locale === "ko" ? "소유 구분:" : "Ownership:"}</strong> {agent.assetSource === "agent-cloud"
                      ? (locale === "ko" ? "내 Agent Cloud 자산" : "My Agent Cloud asset")
                      : agent.assetSource === "hub"
                        ? (locale === "ko" ? "게시자 자산의 로컬 실행 사본" : "Local execution copy of a publisher asset")
                        : (locale === "ko" ? "내 로컬 폴더 자산" : "My local folder asset")}</div>
                    <div><strong>{locale === "ko" ? "사용 위치:" : "Used from:"}</strong> {locale === "ko" ? "프로젝트 에이전트 풀, 팀 위계, Network 후보 선택" : "Project agent pool, team hierarchy, Network candidate selection"}</div>
                  </div>
                </div>

                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconLayers size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "도구와 파일" : "Tools & files"}
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                    <MetricMini label="Files" value={agentFiles.length} />
                    <MetricMini label="MCP" value={agent?.mcpServers?.length ?? 0} />
                    <MetricMini label="Memory" value={memoryParsed.decisions.length + memoryParsed.gotchas.length} />
                    <MetricMini label="Open Q" value={memoryParsed.openQuestions.length} />
                  </div>
                  {(agent?.mcpServers?.length ?? 0) > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {agent!.mcpServers.map((server) => (
                        <span key={server} style={{ fontSize: 11, padding: "3px 7px", borderRadius: 999, background: "var(--fill-1)", color: "var(--ink-soft)", border: "1px solid var(--paper-edge)" }}>
                          {server}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                      {locale === "ko"
                        ? "연결된 MCP 서버가 없습니다. Hub Plugin에서 필요한 도구를 설치하면 이 에이전트의 도구 레이어와 함께 확인할 수 있습니다."
                        : "No MCP servers connected. Install the tools you need from Hub Plugin to see them alongside this agent's tool layer."}
                    </p>
                  )}
                </div>
              </div>

              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700 }}>{locale === "ko" ? "로컬 플레이북 소스" : "Local playbook source"}</h4>
                {agentFiles.length === 0 ? (
                  <div style={{ padding: 14, border: "1px dashed var(--paper-edge)", borderRadius: 10, color: "var(--muted-deep)", fontSize: 12 }}>
                    {locale === "ko"
                      ? "아직 읽힌 로컬 파일이 없습니다. 설치된 에이전트를 선택하면 AGENT.md, memory.md, skill 파일을 여기에서 확인합니다."
                      : "No local files read yet. Select an installed agent to view its AGENT.md, memory.md, and skill files here."}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    {agentFiles.slice(0, 12).map((file) => (
                      <div key={file.path} style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, padding: "8px 10px", background: "var(--paper-2)", minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{file.path}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 탭 4: 활동과 개선 */}
          {activeTab === "activity" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 840 }}>
              
              {/* Main-owned per-agent 원장만 사용. 파일 파싱 수치를 실행/실패 수치로 오인하지 않는다. */}
              <AgentLearningMetricGrid
                summary={learningSummary}
                loading={learningSummaryLoading}
                error={learningSummaryError}
                locale={locale}
                context="activity"
              />

              {/* 자체 진화 프롬프트 디프 제안 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <div style={{ display: "flex", justifyItems: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconWand size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "에이전트 개선안" : "Agent improvements"}
                  </h4>
                  <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(245,201,122,0.16)", color: "var(--amber-deep)", fontWeight: 700 }}>
                    {pendingProposal
                      ? (locale === "ko" ? "승인 대기" : "Awaiting approval")
                      : recoveryProposal
                        ? (locale === "ko" ? "확인 필요" : "Needs review")
                      : displayedProposal?.status === "applied" || displayedProposal?.status === "measured"
                        ? (locale === "ko" ? "적용됨 · 되돌릴 수 있음" : "Applied · can be reverted")
                        : displayedProposal?.status === "rolled_back"
                          ? (locale === "ko" ? "되돌림 완료" : "Reverted")
                      : hasPendingEvolution || runtimeEvolutionCandidates.length > 0
                        ? (locale === "ko" ? "새 개선안 있음" : "Improvement available")
                        : (locale === "ko" ? "변경 없음" : "No changes")}
                  </span>
                </div>

                {!hasPendingEvolution && !displayedProposal && runtimeEvolutionCandidates.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "12px 4px", lineHeight: 1.6 }}>
                    {memoryEntries.length === 0 && memoryParsed.decisions.length + memoryParsed.gotchas.length === 0
                      ? (learningSummary && (learningSummary.runCount > 0 || learningSummary.legacyChatLinkedRunCount > 0)
                          ? (locale === "ko"
                              ? `완료한 작업 ${learningSummary.runCount}건과 관련 이전 대화 ${learningSummary.legacyChatLinkedRunCount}건이 있습니다. 아직 에이전트에 반영할 새 개선 내용은 없습니다.`
                              : `There are ${learningSummary.runCount} completed tasks and ${learningSummary.legacyChatLinkedRunCount} related earlier conversations, but nothing new to apply to the agent yet.`)
                          : (locale === "ko"
                              ? "아직 작업 기록이나 배운 내용이 없습니다. 첫 작업을 마치면 여기에 기록됩니다."
                              : "No work or learning history yet. It will appear here after the first completed task."))
                      : (locale === "ko"
                          ? "현재 기억한 내용이 모두 에이전트에 반영되어 있습니다. 새 기준이나 주의할 점을 배우면 여기에 개선안이 나타납니다."
                          : "Everything currently remembered is already reflected in the agent. New decisions or cautions will appear here as improvements.")}
                  </div>
                )}

                {/* 자동으로 발견한 학습 중 에이전트 개선안으로 검토할 수 있는 항목. */}
                {runtimeEvolutionCandidates.length > 0 && (
                  <div style={{ marginBottom: hasPendingEvolution || displayedProposal ? 14 : 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <strong style={{ fontSize: 12 }}>
                        {locale === "ko" ? "에이전트가 새로 배운 내용" : "New things this agent learned"}
                      </strong>
                      <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 700 }}>
                        {runtimeEvolutionCandidates.length}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {runtimeEvolutionCandidates.map((entry) => {
                        const summary = simpleMemorySummary(entry.kind, entry.content, locale);
                        const hasTechnicalDetail = summary !== entry.content.replace(/\s+/g, " ").trim();
                        return (
                          <div key={entry.id} style={{ padding: "9px 10px", border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper-2)" }}>
                            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={!!selectedRuntimeIds[entry.id]}
                                onChange={() => setSelectedRuntimeIds((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))}
                                style={{ marginTop: 2, flexShrink: 0 }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 999, background: "var(--fill-1)", color: "var(--accent)", fontWeight: 700 }}>
                                    {memoryKindLabel(entry.kind, locale)}
                                  </span>
                                  <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--paper-edge)", color: "var(--muted-deep)", fontWeight: 700 }}>
                                    {confidenceLabel(entry.confidence, locale)}
                                  </span>
                                  <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>
                                    {formatLearningTime(entry.createdAt, locale)}
                                  </span>
                                </div>
                                <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>{summary}</div>
                              </div>
                            </label>
                            {hasTechnicalDetail && (
                              <details style={{ margin: "7px 0 0 24px", color: "var(--muted-deep)", fontSize: 10.5 }}>
                                <summary style={{ cursor: "pointer", fontWeight: 650 }}>
                                  {locale === "ko" ? "기술 기록 보기" : "View technical record"}
                                </summary>
                                <div style={{ marginTop: 6, padding: "8px 9px", borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper)", fontFamily: "var(--font-mono)", lineHeight: 1.5, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
                                  {entry.content}
                                </div>
                              </details>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                      <button
                        onClick={() => void applyRuntimeEntries()}
                        disabled={selectedRuntimeEntries.length === 0 || saving || !!pendingProposal}
                        style={{
                          padding: "7px 12px",
                          background: selectedRuntimeEntries.length === 0 || saving || !!pendingProposal ? "var(--paper-2)" : "var(--accent)",
                          color: selectedRuntimeEntries.length === 0 || saving || !!pendingProposal ? "var(--muted-deep)" : "var(--white)",
                          border: "1px solid var(--paper-edge)",
                          borderRadius: 6,
                          fontSize: 11.5,
                          fontWeight: 650,
                          cursor: selectedRuntimeEntries.length === 0 || saving || !!pendingProposal ? "default" : "pointer",
                        }}
                      >
                        {locale === "ko"
                          ? `선택한 내용으로 개선안 만들기 (${selectedRuntimeEntries.length})`
                          : `Create improvement (${selectedRuntimeEntries.length})`}
                      </button>
                    </div>
                  </div>
                )}

                {(hasPendingEvolution || displayedProposal) && (
                <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                  {/* 기존 버젼 */}
                  <div style={{ background: "rgba(255,138,138,0.04)" }}>
                    <div style={{ background: "rgba(255,138,138,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--red-deep)" }}>
                      {locale === "ko" ? "현재 설정" : "Current settings"}
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {displayedEvolutionDiff.old}
                    </pre>
                  </div>
                  {/* 제안 버젼 */}
                  <div style={{ background: "rgba(168,217,155,0.04)", borderLeft: "1px solid var(--paper-edge)" }}>
                    <div style={{ background: "rgba(168,217,155,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--green-deep)" }}>
                      {locale === "ko" ? "바뀔 설정" : "Proposed settings"}
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {displayedEvolutionDiff.new}
                    </pre>
                  </div>
                </div>

                {!pendingProposal && hasPendingEvolution && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                    <button
                      onClick={async () => {
                        await onCreateEvolution(evolutionDiff.new, { changeOrigin: "curated_memory_rules" });
                      }}
                      disabled={saving}
                      style={{
                        padding: "8px 14px",
                        background: "var(--accent)",
                        color: "var(--white)",
                        border: "none",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: saving ? "default" : "pointer",
                        opacity: saving ? 0.6 : 1,
                      }}
                    >
                      {locale === "ko" ? "개선안 만들기" : "Create improvement"}
                    </button>
                  </div>
	                )}

                  {pendingProposal && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                      <div style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.55, marginBottom: 10 }}>
                        {locale === "ko"
                          ? `후보 ${pendingProposal.id} · ${pendingProposal.targetPath} · before ${pendingProposal.beforeHash.slice(0, 12)} · after ${pendingProposal.afterHash.slice(0, 12)}. 승인 전에는 원본 파일과 패키지 버전이 유지됩니다.`
                          : `Candidate ${pendingProposal.id} · ${pendingProposal.targetPath} · before ${pendingProposal.beforeHash.slice(0, 12)} · after ${pendingProposal.afterHash.slice(0, 12)}. The original file and package version remain unchanged until approval.`}
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => void onRejectEvolution(pendingProposal.id)}
                          disabled={saving}
                          style={{ padding: "8px 12px", border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--ink-soft)", fontSize: 12, fontWeight: 650, cursor: saving ? "default" : "pointer" }}
                        >
                          {locale === "ko" ? "개선안 삭제" : "Discard improvement"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void onApproveEvolution(pendingProposal.id)}
                          disabled={saving}
                          style={{ padding: "8px 14px", background: "var(--accent)", color: "var(--white)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 650, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}
                        >
                          {locale === "ko" ? "확인하고 적용" : "Review and apply"}
                        </button>
                      </div>
                    </div>
                  )}

                  {recoveryProposal?.lastError && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--red-deep)", borderRadius: 8, background: "rgba(255,138,138,0.06)", color: "var(--red-deep)", fontSize: 11.5, lineHeight: 1.55 }}>
                      {locale === "ko"
                        ? `자동 덮어쓰기를 중단하고 현재 파일을 보존했습니다. Identity 탭의 현재 원문과 before/after hash를 직접 비교하세요. ${recoveryProposal.lastError}`
                        : `Automatic overwrite stopped and the current file was preserved. Compare the current Identity source with the before/after hashes. ${recoveryProposal.lastError}`}
                    </div>
                  )}

                  {displayedProposal && displayedProposal.receipts.length > 0 && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                      {displayedProposal.receipts.map((receipt) => (
                        <div key={receipt.id} style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.55, fontFamily: "var(--font-mono)", marginBottom: 6 }}>
                          {receipt.action.toUpperCase()} · asset v{receipt.versionBefore}→v{receipt.versionAfter} · governed {receipt.governedAssetHashBefore.slice(0, 12)}→{receipt.governedAssetHashAfter.slice(0, 12)} · receipt {receipt.id}
                        </div>
                      ))}
                      {(displayedProposal.status === "applied" || displayedProposal.status === "measured") && (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                          <button
                            type="button"
                            onClick={() => void onRollbackEvolution(displayedProposal.id)}
                            disabled={saving}
                            style={{ padding: "7px 12px", border: "1px solid var(--red-deep)", borderRadius: 6, background: "var(--paper)", color: "var(--red-deep)", fontSize: 11.5, fontWeight: 650, cursor: saving ? "default" : "pointer" }}
                          >
                            {locale === "ko" ? "이 영수증으로 롤백" : "Rollback from this receipt"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
	                </>
	                )}
	              </div>

		              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
		                <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700 }}>
		                  {locale === "ko" ? "최근 활동" : "Recent activity"}
		                </h4>
		                <AgentLearningHistory events={observedTimelineEvents} locale={locale} limit={6} compact />
		              </div>

	            </div>
	          )}

        </div>
      </div>

    </div>
  );
}
