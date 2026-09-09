// 프로젝트 상세 — 프로젝트 문맥, 채팅, PM 메모리 기반 작업 타임라인.
"use client";
import { OneBottomSheet as SharedDialog } from "@/components/one/OneBottomSheet";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { detailForUser, failureMessage } from "@/lib/invocation-failure";
import { taskTitleForDisplay } from "@/lib/task-title";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  IconArrowLeft,
  IconBuilding,
  IconChat,
  IconClose,
  IconChevronDown,
  IconChevronRight,
  IconFileUp,
  IconPanelRight,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUsers,
} from "@/components/Icon";
import { pickLocalized, useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { AgentLeaseDialog } from "@/components/AgentLeaseDialog";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import {
  buildProjectRosterSections,
  isUserFacingProjectPoolMember,
  projectPoolMemberKey,
  type ProjectRosterCandidate,
  type ProjectRosterSection,
  type ProjectRosterSource,
} from "@/lib/project-agent-roster";
import type {
  CanonicalTask,
  ExternalCliSessionSummary,
  HubAgentBookmark,
  InstalledAgent,
  InstalledAgentExactBinding,
  InstalledFirm,
  MarketplaceListing,
  Project,
  ProjectAgentPoolMember,
  ProjectTimelineEntry,
  ProjectTimelineSnapshot,
} from "@/lib/types";
import type { OntologyProjectStatus } from "@shared/types";

/**
 * 프로젝트 지식 — 상태 보기, 준비, 새로고침, 소스 추가, 인박스 열기.
 *
 * 이 다섯 창구는 처음부터 다 있었는데 화면에서 부르는 곳이 0이었다
 * (감사 2026-08-25). 엔진은 실행 중에 이 지식을 이미 조회하고 있었으므로
 * 죽은 코드가 아니라 손잡이가 없던 것이다. 서재의 "온톨로지 인박스" 는
 * 채우는 코드가 저장소 어디에도 없어 영원히 비어 있었고, 그 화면이 쓰는
 * 것은 에이전트 한 명의 경험이지 이 프로젝트 폴더의 지식이 아니다.
 */
function ProjectOntologyPanel({
  projectId,
  folderPath,
  locale,
  cardStyle,
  eyebrowStyle,
}: {
  projectId: string;
  folderPath: string | null;
  locale: "ko" | "en";
  cardStyle: CSSProperties;
  eyebrowStyle: CSSProperties;
}) {
  const ko = locale === "ko";
  const [status, setStatus] = useState<OntologyProjectStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!folderPath) return;
    const api = ipc();
    if (!api?.ontology) return;
    const next = await api.ontology.getProject(projectId).catch(() => null);
    setStatus(next);
  }, [projectId, folderPath]);

  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
      await load();
    } catch (error) {
      // 실패는 사유를 그대로 보인다 — 조용히 아무 일도 없던 것처럼 두지 않는다.
      setNote(String((error as Error)?.message ?? error).slice(0, 200));
    } finally {
      setBusy(null);
    }
  };

  if (!folderPath) {
    return (
      <section style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ ...eyebrowStyle, marginBottom: 8 }}>{ko ? "프로젝트 지식" : "Project knowledge"}</div>
        <strong style={{ display: "block", fontSize: 13, color: "var(--ink)" }}>
          {ko ? "로컬 폴더 미연결" : "No local folder connected"}
        </strong>
        <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
          {ko
            ? "프로젝트 지식은 로컬 폴더가 있는 프로젝트에서 사용할 수 있습니다. 폴더 없이도 대화와 작업은 시작할 수 있습니다."
            : "Project knowledge is available for projects with a local folder. You can still start conversations and tasks without one."}
        </p>
      </section>
    );
  }

  const stateLabel = !status
    ? (ko ? "확인 중" : "Checking")
    : status.state === "ready" ? (ko ? "준비됨" : "Ready")
    : status.state === "ingesting" ? (ko ? "읽는 중" : "Ingesting")
    : status.state === "provisioned" ? (ko ? "자리만 잡음" : "Provisioned")
    : status.state === "degraded" ? (ko ? "일부만 됨" : "Degraded")
    : (ko ? "실패" : "Failed");

  const counts = status?.counts;
  const buttonStyle: CSSProperties = {
    minHeight: 28,
    padding: "0 10px",
    border: "1px solid var(--paper-edge)",
    borderRadius: 8,
    background: "var(--paper)",
    color: "var(--ink)",
    fontSize: 11.5,
    fontWeight: 620,
    cursor: "pointer",
  };

  return (
    <section style={{ ...cardStyle, marginBottom: 16 }}>
      <div style={{ ...eyebrowStyle, marginBottom: 8 }}>{ko ? "프로젝트 지식" : "Project knowledge"}</div>
      <strong style={{ display: "block", fontSize: 13, color: "var(--ink)" }}>{stateLabel}</strong>
      {counts ? (
        <span style={{ display: "block", marginTop: 4, fontSize: 11.5, color: "var(--muted-deep)" }}>
          {ko
            ? `등록한 소스 ${counts.registeredSources}개 · 인박스 ${counts.inboxEntries}개 · 읽은 조각 ${counts.databaseChunks}개`
            : `${counts.registeredSources} sources · ${counts.inboxEntries} in inbox · ${counts.databaseChunks} chunks`}
        </span>
      ) : null}
      {status && status.warnings.length > 0 ? (
        <span style={{ display: "block", marginTop: 6, fontSize: 11.5, color: "var(--muted-deep)" }}>
          {status.warnings[0]}
        </span>
      ) : null}
      {status?.error ? (
        <span role="status" style={{ display: "block", marginTop: 6, fontSize: 11.5, color: "var(--danger, var(--danger))", overflowWrap: "anywhere" }}>
          {status.error}
        </span>
      ) : null}
      {note ? (
        <span style={{ display: "block", marginTop: 6, fontSize: 11.5, color: "var(--danger, var(--danger))" }} role="status">{note}</span>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {status?.state === "failed" || !status?.memoryDir ? (
          <button type="button" style={buttonStyle} disabled={Boolean(busy)}
            onClick={() => void run("provision", () => ipc()!.ontology.provision(projectId))}>
            {busy === "provision" ? (ko ? "준비 중" : "Preparing") : (ko ? "지식 자리 만들기" : "Set up")}
          </button>
        ) : null}
        <button type="button" style={buttonStyle} disabled={Boolean(busy)}
          onClick={() => void run("sync", () => ipc()!.ontology.sync(projectId))}>
          {busy === "sync" ? (ko ? "읽는 중" : "Reading") : (ko ? "다시 읽기" : "Re-read")}
        </button>
        <button type="button" style={buttonStyle} disabled={Boolean(busy)}
          onClick={() => void run("inbox", () => ipc()!.ontology.openInbox(projectId))}>
          {ko ? "인박스 열기" : "Open inbox"}
        </button>
      </div>
      <span style={{ display: "block", marginTop: 8, fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.5 }}>
        {ko
          ? "인박스에 넣은 파일과 등록한 폴더만 읽습니다. 홈 폴더나 옆 프로젝트는 절대 훑지 않습니다."
          : "Only the inbox and folders you register are read. Your home directory and sibling projects are never scanned."}
      </span>
    </section>
  );
}

export default function ProjectPageWrapper() {
  return (
    <Suspense fallback={null}>
      <ProjectPage />
    </Suspense>
  );
}

function ProjectPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const { t, locale } = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<CanonicalTask[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [cloudListings, setCloudListings] = useState<MarketplaceListing[]>([]);
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>([]);
  const [exactBindings, setExactBindings] = useState<InstalledAgentExactBinding[]>([]);
  const [timeline, setTimeline] = useState<ProjectTimelineSnapshot | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [agentPoolDraft, setAgentPoolDraft] = useState<ProjectAgentPoolMember[]>([]);
  const [editingTeam, setEditingTeam] = useState(false);
  const [draggedCandidateKey, setDraggedCandidateKey] = useState<string | null>(null);
  const [draggedMemberId, setDraggedMemberId] = useState<string | null>(null);
  const pointerDragRef = useRef<{ kind: "candidate" | "member"; id: string; startX: number; startY: number } | null>(null);
  const [openRosterSources, setOpenRosterSources] = useState<Record<ProjectRosterSource, boolean>>({
    local: true,
    cloud: true,
    hub: false,
  });
  const [openRosterFirms, setOpenRosterFirms] = useState<Record<string, boolean>>({});
  // Tasks are the primary project surface. Keep the potentially long tool
  // roster collapsed by default so recent conversations remain above the fold.
  const [teamTreeOpen, setTeamTreeOpen] = useState(false);
  // ── Hub 렌트/장기대여 상태 (오너 결정 2026-08-18: 24h 자동 리스 폐지) ──
  // 렌트허용은 (projectId × slug) 데스크탑 로컬 저장, 대여는 서버 계정 상태.
  const [rentAllowedSlugs, setRentAllowedSlugs] = useState<Set<string>>(new Set());
  const [leaseUntilBySlug, setLeaseUntilBySlug] = useState<Map<string, string>>(new Map());
  const [leaseDialog, setLeaseDialog] = useState<{ slug: string; name: string } | null>(null);
  const [leaseRefreshTick, setLeaseRefreshTick] = useState(0);
  const [agentKindsHelpOpen, setAgentKindsHelpOpen] = useState(false);
  // 에이전트 픽커 검색 — 목록이 길어 이름/slug로 즉시 좁힌다(클라이언트 필터).
  const [rosterQuery, setRosterQuery] = useState("");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recoveryPending, setRecoveryPending] = useState(false);
  /** "새 채팅" 만들기가 실패한 이유. 읽기 실패(recoveryPending)와 섞지 않는다. */
  const [startChatError, setStartChatError] = useState("");
  const [taskStartOpen, setTaskStartOpen] = useState(false);
  const [externalSessionsOpen, setExternalSessionsOpen] = useState(false);
  const [externalSessions, setExternalSessions] = useState<ExternalCliSessionSummary[]>([]);
  const [externalSessionQuery, setExternalSessionQuery] = useState("");
  const [externalSessionsLoading, setExternalSessionsLoading] = useState(false);
  const [externalSessionsError, setExternalSessionsError] = useState("");
  const [externalSessionImporting, setExternalSessionImporting] = useState<string | null>(null);

  const rosterSections = useMemo(
    () => buildProjectRosterSections(agents, firms, cloudListings, hubBookmarks, locale, exactBindings),
    [agents, cloudListings, exactBindings, firms, hubBookmarks, locale],
  );
  const candidateByKey = useMemo(() => {
    const rows = rosterSections.flatMap((section) => [
      ...section.standalone,
      ...section.firms.flatMap((firm) => [firm.team, ...firm.members]),
    ]);
    return new Map(rows.map((candidate) => [candidate.key, candidate]));
  }, [rosterSections]);

  const recoverMissingBridge = useCallback((_scope: string) => {
    setRecoveryPending(true);
  }, []);

  // Hub 풀 멤버의 targetId 는 slug 이거나 agentDefinitionId 다(로스터 규칙). 렌트/대여
  // API 는 slug 를 키로 쓰므로 북마크 목록으로 되돌린다 — 못 되돌리면 컨트롤을 숨긴다.
  const hubSlugByTargetId = useMemo(() => {
    const map = new Map<string, string>();
    for (const bookmark of hubBookmarks) {
      const slug = String(bookmark.listing.slug ?? "").trim().toLowerCase();
      if (!slug) continue;
      map.set(slug, slug);
      const definitionId = String(bookmark.listing.agentDefinitionId ?? "").trim().toLowerCase();
      if (definitionId) map.set(definitionId, slug);
    }
    return map;
  }, [hubBookmarks]);
  const hubSlugForMember = useCallback((member: ProjectAgentPoolMember): string | null => {
    if (member.source !== "hub") return null;
    return hubSlugByTargetId.get(member.targetId.trim().toLowerCase()) ?? null;
  }, [hubSlugByTargetId]);

  // 패널이 열릴 때마다 렌트허용/대여 상태를 새로 읽는다(대여 만료·타 기기 변경 반영).
  const agentsPanelOpen = teamTreeOpen || editingTeam;
  useEffect(() => {
    if (!agentsPanelOpen || !id) return;
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void api.projects.listRentAllowed(id)
      .then((slugs) => {
        if (!cancelled) setRentAllowedSlugs(new Set(slugs.map((slug) => slug.toLowerCase())));
      })
      .catch(() => {
        // 읽기 실패는 기본(OFF) 표시로 남긴다 — 쓰기가 아니므로 복구 배너는 띄우지 않는다.
      });
    void api.agentLeases.list()
      .then((rows) => {
        if (cancelled) return;
        const now = Date.now();
        setLeaseUntilBySlug(new Map(rows
          .filter((row) => Number.isFinite(Date.parse(row.leasedUntil)) && Date.parse(row.leasedUntil) > now)
          .map((row) => [row.slug.toLowerCase(), row.leasedUntil])));
      })
      .catch(() => {
        // 미로그인/오프라인 — 대여 배지 없이 컨트롤만 보여준다.
      });
    return () => { cancelled = true; };
  }, [agentsPanelOpen, id, leaseRefreshTick]);

  async function toggleRentAllowed(slug: string, allowed: boolean) {
    const api = ipc();
    if (!api || !project) return;
    try {
      const updated = await api.projects.setRentAllowed({ projectId: project.id, slug, allowed });
      setRentAllowedSlugs(new Set(updated.map((item) => item.toLowerCase())));
    } catch {
      setRecoveryPending(true);
    }
  }

  const refresh = useCallback(async () => {
    const api = ipc();
    setLoading(true);
    setRecoveryPending(false);
    if (!id) {
      navigate("/dashboard", "replace");
      setLoading(false);
      return;
    }
    if (!api) {
      recoverMissingBridge("project-detail-load");
      setLoading(false);
      return;
    }
    try {
      // Project-owned work must not wait on optional catalog/timeline sources.
      // Load the local project, tasks, and installed graph first so the page can
      // become usable even when a remote catalog or derived timeline stalls.
      const [p, taskRows, ag] = await Promise.all([
        api.projects.get(id),
        api.tasks.list({ projectId: id, limit: 200, reconcile: false }),
        api.team.list(),
      ]);
      if (!p) {
        navigate("/dashboard", "replace");
        return;
      }
      const userFacingPool = (Array.isArray(p.agentPool) ? p.agentPool : [])
        .filter((member) => isUserFacingProjectPoolMember(member, ag));
      setProject({ ...p, agentPool: userFacingPool });
      setNoteDraft(p.systemPrompt ?? "");
      // Older projects and imported fixtures can predate the ordered pool.
      // Keep that state explicit and empty instead of inventing a controller.
      setAgentPoolDraft(userFacingPool);
      setTasks(taskRows.filter((task) => task.projectId === id));
      // Keep the complete installed graph for identity resolution. The roster
      // builder exposes only executable user-facing teams and agents; internal
      // HQ role cells remain private to their controller.
      setAgents(ag);
      setLoading(false);

      const [firmRows, mine, bookmarks, bindings, timelineResult] = await Promise.all([
        api.firms.list().catch(() => [] as InstalledFirm[]),
        api.marketplace.listMine().catch(() => [] as MarketplaceListing[]),
        api.marketplace.bookmarks().catch(() => [] as HubAgentBookmark[]),
        api.agents.exactBindings().catch(() => [] as InstalledAgentExactBinding[]),
        api.projects.timeline(id).catch(() => null),
      ]);
      setFirms(firmRows);
      setCloudListings(mine);
      setHubBookmarks(bookmarks);
      setExactBindings(bindings);
      setTimeline(timelineResult);
      if (!timelineResult) setRecoveryPending(true);
    } catch {
      setRecoveryPending(true);
    } finally {
      setLoading(false);
    }
  }, [id, recoverMissingBridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    try {
      setInspectorCollapsed(window.localStorage.getItem("agentlas:project-inspector-collapsed") === "true");
    } catch {
      // Local storage is a preference only; the panel remains usable without it.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("agentlas:project-inspector-collapsed", String(inspectorCollapsed));
    } catch {
      // Preference persistence must not block project work.
    }
  }, [inspectorCollapsed]);

  /*
   * ★"새 채팅"이 실패하면 **만들기가 실패했다고 말해야 한다** (QA 실측 2026-09-08:
   *   "새 채팅을 눌러도 채팅으로 안 넘어가고 작업 (0) 만 보인다").
   *
   *   예전에는 catch 가 setRecoveryPending(true) 만 했다. 그 깃발이 켜지면 화면에는
   *   "프로젝트 정보 일부를 불러오지 못했습니다" 가 뜬다 — **읽기 실패 문구**다.
   *   사람은 만들기를 눌렀는데 읽기가 안 됐다는 말을 듣는다. 이유도, 다시 할 방법도 없다.
   */
  async function startNewChat() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-detail-new-task");
      return;
    }
    if (!project) return;
    setStartChatError("");
    try {
      const target = await api.tasks.createProject({ projectId: project.id });
      window.dispatchEvent(new Event("agentlas:tasks-changed"));
      navigate(`/workspace/task?id=${encodeURIComponent(target.chatId)}&task=${encodeURIComponent(target.taskId)}&projectId=${encodeURIComponent(project.id)}`);
    } catch (error) {
      // IPC 포장("Error invoking remote method '...': Error: ")까지 벗긴다 —
      // 사용자에게 remote method 이름을 보여 줄 이유가 없다.
      const raw = failureMessage(error);
      /*
       * 엔진이 내는 이유는 셋뿐이다(electron/ipc.ts "tasks:createProject").
       * 그 영어 문장을 그대로 보여 주면 "무엇을 해야 하는지"가 없다 — 뜻과 다음 할 일로 옮긴다.
       */
      const ko = locale === "ko";
      const explained =
        /orchestrator is unavailable/i.test(raw)
          ? (ko
            ? "기본 작업 오케스트레이터가 설치되어 있지 않습니다. 설정 > 에이전트에서 내장 에이전트를 다시 설치한 뒤 시도하세요."
            : "The built-in task orchestrator is not installed. Reinstall the built-in agents in Settings > Agents, then try again.")
          : /Project is unavailable/i.test(raw)
            ? (ko
              ? "이 프로젝트를 찾지 못했습니다. 목록으로 돌아갔다 다시 열어 보세요."
              : "This project could not be found. Go back to the list and open it again.")
            : /Project is required/i.test(raw)
              ? (ko
                ? "프로젝트가 지정되지 않았습니다. 목록에서 프로젝트를 다시 열어 주세요."
                : "No project was given. Open the project again from the list.")
              : raw
                ? (ko ? `이유: ${raw}` : `Reason: ${raw}`)
                : (ko ? "이유가 오지 않았습니다." : "No reason came back.");
      setStartChatError(
        ko
          ? `새 채팅을 만들지 못했습니다. ${explained}`
          : `The new conversation could not be created. ${explained}`,
      );
    }
  }

  const loadExternalSessions = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setExternalSessionsError(locale === "ko" ? "Desktop 연결을 확인할 수 없습니다." : "Desktop connection is unavailable.");
      return;
    }
    setExternalSessionsLoading(true);
    setExternalSessionsError("");
    try {
      if (!project) return;
      setExternalSessions(await api.externalCliSessions.list({ projectId: project.id, limit: 80 }));
    } catch (error) {
      setExternalSessionsError(locale === "ko" ? `세션을 읽지 못했습니다: ${detailForUser(error)}` : `Could not read sessions: ${detailForUser(error)}`);
    } finally {
      setExternalSessionsLoading(false);
    }
  }, [locale, project]);

  async function openExternalSessionImport() {
    setExternalSessionsOpen(true);
    setExternalSessionQuery("");
    await loadExternalSessions();
  }

  async function importExternalSession(session: ExternalCliSessionSummary) {
    const api = ipc();
    if (!api || !project) return;
    setExternalSessionImporting(session.sourceKey);
    setExternalSessionsError("");
    try {
      const target = await api.externalCliSessions.importToProject({
        sourceKey: session.sourceKey,
        projectId: project.id,
      });
      window.dispatchEvent(new Event("agentlas:tasks-changed"));
      navigate(`/workspace/task?id=${encodeURIComponent(target.chatId)}&task=${encodeURIComponent(target.taskId)}&projectId=${encodeURIComponent(project.id)}`);
    } catch (error) {
      setExternalSessionsError(locale === "ko" ? `가져오지 못했습니다: ${detailForUser(error)}` : `Could not import this session: ${detailForUser(error)}`);
      setExternalSessionImporting(null);
    }
  }

  useEffect(() => {
    if (!externalSessionsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || externalSessionImporting) return;
      if (externalSessionsOpen) setExternalSessionsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [externalSessionImporting, externalSessionsOpen]);

  async function saveNote() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-detail-save-instructions");
      return;
    }
    if (!project) return;
    try {
      const updated = await api.projects.update(project.id, {
        systemPrompt: noteDraft.trim() || null,
      });
      setProject(updated);
      setEditingNote(false);
      setRecoveryPending(false);
    } catch {
      setRecoveryPending(true);
    }
  }

  function addCandidates(candidates: ProjectRosterCandidate[]) {
    setAgentPoolDraft((current) => {
      const next = [...current];
      const seen = new Set(next.map(projectPoolMemberKey));
      for (const candidate of candidates) {
        if (next.length === 0 && !candidate.installed) continue;
        const key = projectPoolMemberKey(candidate.member);
        if (seen.has(key)) continue;
        next.push(candidate.member);
        seen.add(key);
      }
      return next;
    });
  }

  function addCandidate(candidate: ProjectRosterCandidate) {
    addCandidates([candidate]);
  }

  function dropAgent(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.dataTransfer.getData("application/x-agentlas-project-member")) return;
    const candidate = candidateByKey.get(event.dataTransfer.getData("application/x-agentlas-project-candidate"));
    if (candidate) addCandidate(candidate);
  }

  function movePoolMember(memberKey: string, targetIndex: number) {
    if (!editingTeam) return;
    setAgentPoolDraft((current) => {
      const sourceIndex = current.findIndex((member) => projectPoolMemberKey(member) === memberKey);
      if (sourceIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function pointerDropToPool(targetIndex?: number) {
    if (!editingTeam) return;
    if (draggedMemberId && targetIndex !== undefined) {
      movePoolMember(draggedMemberId, targetIndex);
    } else if (draggedCandidateKey) {
      const selected = candidateByKey.get(draggedCandidateKey);
      if (selected) addCandidate(selected);
    }
    setDraggedCandidateKey(null);
    setDraggedMemberId(null);
  }

  function beginPointerDrag(event: ReactPointerEvent<HTMLElement>, kind: "candidate" | "member", id: string) {
    if (!editingTeam) return;
    setInspectorCollapsed(true);
    pointerDragRef.current = { kind, id, startX: event.clientX, startY: event.clientY };
    if (kind === "candidate") setDraggedCandidateKey(id);
    else setDraggedMemberId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    if (!drag) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    if (moved) {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const memberRow = target?.closest<HTMLElement>("[data-project-member-index]");
      const pool = target?.closest<HTMLElement>("[data-project-agent-pool]");
      if (pool) {
        if (drag.kind === "member" && memberRow) {
          movePoolMember(drag.id, Number(memberRow.dataset.projectMemberIndex));
        } else if (drag.kind === "candidate") {
          const selected = candidateByKey.get(drag.id);
          if (selected) addCandidate(selected);
        }
      }
    }
    setDraggedCandidateKey(null);
    setDraggedMemberId(null);
  }

  useEffect(() => {
    const finishAt = (clientX: number, clientY: number) => {
      const drag = pointerDragRef.current;
      if (!drag || Math.hypot(clientX - drag.startX, clientY - drag.startY) <= 4) return;
      pointerDragRef.current = null;
      const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const pool = target?.closest<HTMLElement>("[data-project-agent-pool]");
      const memberRow = target?.closest<HTMLElement>("[data-project-member-index]");
      if (pool) {
        if (drag.kind === "member" && memberRow) {
          movePoolMember(drag.id, Number(memberRow.dataset.projectMemberIndex));
        } else if (drag.kind === "candidate") {
          const selected = candidateByKey.get(drag.id);
          if (selected) addCandidate(selected);
        }
      }
      setDraggedCandidateKey(null);
      setDraggedMemberId(null);
    };
    const onPointerUp = (event: PointerEvent) => finishAt(event.clientX, event.clientY);
    const onMouseUp = (event: MouseEvent) => finishAt(event.clientX, event.clientY);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [candidateByKey, editingTeam]);

  async function saveTeam() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-detail-save-team");
      return;
    }
    if (!project) return;
    try {
      const updated = await api.projects.update(project.id, { agentPool: agentPoolDraft });
      setProject(updated);
      setEditingTeam(false);
      setRecoveryPending(false);
    } catch {
      setRecoveryPending(true);
    }
  }

  async function removeProject() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-detail-delete");
      return;
    }
    if (!project) return;
    if (!confirm(t("project.confirm_delete", { name: project.name }))) return;
    try {
      await api.projects.remove(project.id);
      navigate("/dashboard", "replace");
    } catch {
      setRecoveryPending(true);
    }
  }

  if (loading || !project) {
    return (
      <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
        <header className="project-detail-header titlebar-drag">
          <button
            type="button"
            className="project-detail-back titlebar-nodrag"
            onClick={() => navigate("/dashboard")}
            aria-label={locale === "ko" ? "대시보드로 돌아가기" : "Back to Dashboard"}
          >
            <IconArrowLeft size={16} />
            <span>{locale === "ko" ? "대시보드" : "Dashboard"}</span>
          </button>
        </header>
        <section style={{ maxWidth: 720, margin: "24px auto", padding: "0 24px" }}>
          {loading
            ? <div style={{ ...pageNotice, display: "grid", gap: 6 }}><span>{locale === "en" ? "Loading project…" : "프로젝트를 불러오는 중입니다…"}</span><LoadingEstimate locale={locale} operationKey="desktop-project-detail" expectedSeconds={[1, 25]} /></div>
            : <div style={pageNotice} role="alert">{locale === "en" ? "The project could not be loaded. Return to the dashboard and try again." : "프로젝트를 불러오지 못했습니다. 대시보드로 돌아가 다시 시도하세요."}</div>}
        </section>
      </div>
    );
  }

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const selectedMemberKeys = new Set(agentPoolDraft.map(projectPoolMemberKey));
  const normalizedExternalSessionQuery = externalSessionQuery.trim().toLocaleLowerCase(locale);
  const visibleExternalSessions = externalSessions.filter((session) => !normalizedExternalSessionQuery || [
    session.title,
    session.preview,
    session.projectLabel ?? "",
    session.provider,
  ].some((value) => value.toLocaleLowerCase(locale).includes(normalizedExternalSessionQuery)));

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
      <header
        className="project-detail-header titlebar-drag"
        style={{
          padding: "16px 32px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          type="button"
          className="project-detail-back titlebar-nodrag"
          onClick={() => navigate("/dashboard")}
          aria-label={locale === "ko" ? "대시보드로 돌아가기" : "Back to Dashboard"}
        >
          <IconArrowLeft size={16} />
          <span>{locale === "ko" ? "대시보드" : "Dashboard"}</span>
        </button>
        <div style={{ flex: 1 }}>
          <div style={eyebrowStyle}>{t("project.kind")}</div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700 }}>
            {project.name}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => setTaskStartOpen(true)}
          className="titlebar-nodrag"
          aria-haspopup="dialog"
          aria-expanded={taskStartOpen}
          style={raisedButton}
        >
          <IconPlus size={14} />
          {locale === "ko" ? "새 작업" : "New task"}
        </button>
        <button
          onClick={() => void removeProject()}
          className="titlebar-nodrag"
          aria-label={t("common.delete")}
          title={t("common.delete")}
          style={{ color: "var(--muted-deep)", padding: 6 }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      <SharedDialog open={taskStartOpen} onClose={() => setTaskStartOpen(false)}
        closeLabel={locale === "ko" ? "닫기" : "Close"} size="compact" eyebrow={project.name}
        title={locale === "ko" ? "어떻게 시작할까요?" : "How would you like to start?"}
        titleId="task-start-title"
        description={locale === "ko" ? "새 대화를 시작하거나, 이 프로젝트 폴더에서 진행하던 CLI 기록을 가져올 수 있습니다." : "Start a new conversation or bring in CLI history created inside this project folder."}>
            <div style={{ display: "grid", gap: 10, padding: 0 }}>
              <button
                autoFocus
                type="button"
                className="project-task-start-option"
                data-primary="true"
                onClick={() => { setTaskStartOpen(false); void startNewChat(); }}
                style={{ minHeight: 82, display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) auto", alignItems: "center", gap: 12, padding: "14px", border: "1px solid color-mix(in srgb, var(--accent) 42%, var(--paper-edge))", borderRadius: 12, background: "color-mix(in srgb, var(--accent) 5%, var(--paper))", color: "var(--ink)", textAlign: "left" }}
              >
                <span style={{ width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: 11, background: "var(--accent)", color: "white" }}><IconChat size={19} /></span>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ display: "block", fontSize: 14 }}>{locale === "ko" ? "새 채팅" : "New conversation"}</strong>
                  <small style={{ display: "block", marginTop: 5, color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.45 }}>{locale === "ko" ? "빈 작업에서 목표를 입력하고 바로 시작합니다." : "Start with an empty task and describe the result you want."}</small>
                </span>
                <IconChevronRight size={17} style={{ color: "var(--muted-deep)" }} />
              </button>
              <button
                type="button"
                className="project-task-start-option"
                onClick={() => { setTaskStartOpen(false); void openExternalSessionImport(); }}
                style={{ minHeight: 82, display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) auto", alignItems: "center", gap: 12, padding: "14px", border: "1px solid var(--paper-edge)", borderRadius: 12, background: "var(--paper)", color: "var(--ink)", textAlign: "left" }}
              >
                <span style={{ width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: 11, background: "var(--fill-1)", color: "var(--accent)" }}><IconFileUp size={19} /></span>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ display: "block", fontSize: 14 }}>{locale === "ko" ? "CLI 세션 가져오기" : "Import CLI session"}</strong>
                  <small style={{ display: "block", marginTop: 5, color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.45 }}>{locale === "ko" ? "Claude Code 또는 Codex 기록을 프로젝트 작업으로 가져옵니다." : "Import Claude Code or Codex history as project-owned work."}</small>
                </span>
                <IconChevronRight size={17} style={{ color: "var(--muted-deep)" }} />
              </button>
            </div>
      </SharedDialog>

      {externalSessionsOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !externalSessionImporting) setExternalSessionsOpen(false);
          }}
          style={{ position: "fixed", inset: 0, zIndex: 1200, display: "grid", placeItems: "center", padding: 24, background: "rgba(21, 22, 18, .34)", backdropFilter: "blur(3px)" }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="external-cli-session-title"
            style={{ width: "var(--popup-2-width)", maxHeight: "min(720px, calc(100vh - 48px))", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--paper-edge)", borderRadius: 16, background: "var(--paper)", boxShadow: "0 24px 80px rgba(20, 22, 18, .22)" }}
          >
            <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px", borderBottom: "1px solid var(--paper-edge)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 id="external-cli-session-title" style={{ margin: 0, fontSize: 17, fontFamily: "var(--font-head)" }}>{locale === "ko" ? "CLI 세션 가져오기" : "Import a CLI session"}</h2>
                <p style={{ margin: "5px 0 0", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5 }}>
                  {locale === "ko"
                    ? `${project.name} 폴더에서 시작한 CLI 세션만 이 프로젝트 작업 기록으로 가져옵니다. 원본 파일과 세션은 바꾸거나 재개하지 않습니다. 다음 실행은 이 프로젝트가 소유하는 새 Agentlas 세션입니다.`
                    : `Only CLI sessions started inside ${project.name}'s folder are shown. Import creates project-owned work without changing or resuming the original file or session.`}
                </p>
              </div>
              <button type="button" disabled={Boolean(externalSessionImporting)} onClick={() => setExternalSessionsOpen(false)} aria-label={locale === "ko" ? "닫기" : "Close"} style={{ width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: 10, color: "var(--muted-deep)" }}>
                <IconClose size={17} />
              </button>
            </header>

            <div style={{ display: "flex", gap: 8, padding: "12px 20px", borderBottom: "1px solid var(--paper-edge)" }}>
              <label style={{ position: "relative", flex: 1 }}>
                <span className="sr-only">{locale === "ko" ? "CLI 세션 검색" : "Search CLI sessions"}</span>
                <IconSearch size={14} style={{ position: "absolute", left: 13, top: 15, color: "var(--muted-deep)" }} />
                <input
                  autoFocus
                  type="search"
                  value={externalSessionQuery}
                  onChange={(event) => setExternalSessionQuery(event.target.value)}
                  placeholder={locale === "ko" ? "대화·프로젝트·CLI 검색" : "Search conversation, project, or CLI"}
                  style={{ width: "100%", height: 44, padding: "0 36px", border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper-2)", color: "var(--ink)", fontSize: 13 }}
                />
              </label>
              <button type="button" onClick={() => void loadExternalSessions()} disabled={externalSessionsLoading || Boolean(externalSessionImporting)} aria-label={locale === "ko" ? "새로고침" : "Refresh"} style={{ width: 44, height: 44, display: "grid", placeItems: "center", border: "1px solid var(--paper-edge)", borderRadius: 10, color: "var(--ink)" }}>
                <IconRefresh size={15} />
              </button>
            </div>

            <div style={{ overflowY: "auto", minHeight: 220, padding: "8px 12px 16px" }}>
              {externalSessionsError && <div role="alert" style={{ margin: "8px", padding: 12, borderRadius: 10, background: "var(--danger-soft)", color: "var(--red-deep)", fontSize: 12 }}>{externalSessionsError}</div>}
              {externalSessionsLoading ? (
                <div role="status" style={{ padding: 32, textAlign: "center", color: "var(--muted-deep)", fontSize: 12 }}>{locale === "ko" ? "Claude Code와 Codex 기록을 확인하는 중…" : "Checking Claude Code and Codex history…"}</div>
              ) : visibleExternalSessions.length === 0 ? (
                <div role="status" style={{ padding: 32, textAlign: "center", color: "var(--muted-deep)", fontSize: 12 }}>{locale === "ko" ? "가져올 수 있는 세션이 없습니다." : "No importable sessions found."}</div>
              ) : visibleExternalSessions.map((session) => {
                const busy = externalSessionImporting === session.sourceKey;
                return (
                  <article key={session.sourceKey} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 14, alignItems: "center", padding: "14px 10px", borderBottom: "1px solid var(--paper-edge)" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                        <span style={{ flexShrink: 0, padding: "3px 7px", borderRadius: 999, background: "var(--fill-1)", color: "var(--muted-deep)", fontSize: 9.5, fontWeight: 750 }}>{session.provider === "codex" ? "Codex" : "Claude Code"}</span>
                        <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{session.title}</strong>
                      </div>
                      <p style={{ margin: "7px 0 0", color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.5, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}>{session.preview}</p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, color: "var(--muted-deep)", fontSize: 10.5 }}>
                        {session.projectLabel && <span>{session.projectLabel}</span>}
                        <span>{locale === "ko" ? `메시지 ${session.messageCount}개` : `${session.messageCount} messages`}</span>
                        {session.truncated && <span>{locale === "ko" ? "최근 기록만 가져옴" : "Recent window only"}</span>}
                        <time dateTime={session.updatedAt}>{new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.updatedAt))}</time>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void importExternalSession(session)}
                      disabled={Boolean(externalSessionImporting)}
                      style={{ minWidth: 104, minHeight: 44, padding: "0 14px", borderRadius: 9, background: "var(--accent)", color: "var(--white)", fontSize: 12, fontWeight: 750, opacity: externalSessionImporting && !busy ? .48 : 1 }}
                    >
                      {busy ? (locale === "ko" ? "가져오는 중…" : "Importing…") : (locale === "ko" ? "이 프로젝트로 가져오기" : "Import into this project")}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {leaseDialog && (
        <AgentLeaseDialog
          slug={leaseDialog.slug}
          agentName={leaseDialog.name}
          locale={locale}
          onClose={() => setLeaseDialog(null)}
          onLeased={() => {
            // 성공 — 닫고 대여 상태를 다시 읽는다(배지로 전환, 컨트롤 숨김).
            setLeaseDialog(null);
            setLeaseRefreshTick((tick) => tick + 1);
          }}
        />
      )}

      {startChatError && (
        <section style={{ maxWidth: 1280, margin: "16px auto 0", padding: "0 24px" }} role="alert">
          <div style={{ ...pageNotice, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ minWidth: 0, flex: 1 }}>{startChatError}</span>
            <button
              type="button"
              onClick={() => { void startNewChat(); }}
              style={{ minHeight: 32, padding: "0 12px", border: "1px solid var(--paper-edge-strong)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", font: "inherit", fontSize: 12, cursor: "pointer" }}
            >
              {locale === "ko" ? "다시 시도" : "Try again"}
            </button>
            <button
              type="button"
              onClick={() => setStartChatError("")}
              aria-label={locale === "ko" ? "닫기" : "Dismiss"}
              style={{ minHeight: 32, padding: "0 10px", border: 0, background: "transparent", color: "var(--muted-deep)", font: "inherit", fontSize: 12, cursor: "pointer" }}
            >
              {locale === "ko" ? "닫기" : "Dismiss"}
            </button>
          </div>
        </section>
      )}

      {recoveryPending && (
        <section style={{ maxWidth: 1280, margin: "16px auto 0", padding: "0 24px" }} role="alert">
          <div style={pageNotice}>{locale === "en" ? "Some project information could not be loaded. Your saved work was not changed." : "프로젝트 정보 일부를 불러오지 못했습니다. 저장된 작업은 변경되지 않았습니다."}</div>
        </section>
      )}

      <section
        className="titlebar-nodrag project-detail-grid"
        data-inspector-collapsed={inspectorCollapsed}
        style={{ maxWidth: 1280, margin: "24px auto", padding: "0 24px" }}
      >
        <main style={{ minWidth: 0 }}>
          <div style={{ ...cardStyle, marginBottom: 24 }}>
            <div style={{ ...eyebrowStyle, marginBottom: 8 }}>{t("project.section.note")}</div>
            {editingNote ? (
              <>
                <textarea
                  value={noteDraft}
                  aria-label={locale === "ko" ? "프로젝트 메모" : "Project note"}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  rows={4}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    fontFamily: "var(--font-body)",
                    fontSize: 13,
                    background: "var(--paper-2)",
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={() => void saveNote()} style={raisedButton}>
                    {t("common.save")}
                  </button>
                  <button
                    onClick={() => {
                      setNoteDraft(project.systemPrompt ?? "");
                      setEditingNote(false);
                    }}
                    style={{ fontSize: 12, color: "var(--muted-deep)" }}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </>
            ) : project.systemPrompt ? (
              <div
                onDoubleClick={() => setEditingNote(true)}
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: "var(--ink-soft)",
                  cursor: "text",
                }}
                title={locale === "en" ? "Double-click to edit" : "더블클릭으로 편집"}
              >
                {project.systemPrompt}
              </div>
            ) : (
              <button
                onClick={() => setEditingNote(true)}
                style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}
              >
                {t("project.add_note")}
              </button>
            )}
          </div>

          <div style={{ ...cardStyle, marginBottom: 24, position: "relative" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <button
                type="button"
                aria-expanded={teamTreeOpen || editingTeam}
                onClick={() => { if (!editingTeam) setTeamTreeOpen((current) => !current); }}
                style={{ ...eyebrowStyle, flex: 1, minHeight: 32, display: "inline-flex", alignItems: "center", gap: 7, textAlign: "left", color: "var(--ink-soft)" }}
              >
                {teamTreeOpen || editingTeam ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                <span>{locale === "ko" ? "프로젝트 에이전트" : "Project agents"}</span>
                <span style={{ color: "var(--muted-deep)", fontSize: 10, fontWeight: 650 }}>{agentPoolDraft.length}</span>
              </button>
              {!editingTeam ? (
                <button type="button" onClick={() => { setEditingTeam(true); setTeamTreeOpen(true); setInspectorCollapsed(true); }} style={{ color: "var(--accent)", fontSize: 12, fontWeight: 700 }}>
                  {locale === "ko" ? "편집" : "Edit"}
                </button>
              ) : null}
              <button
                type="button"
                className="project-agent-help"
                aria-expanded={agentKindsHelpOpen}
                aria-label={locale === "ko" ? "렌트·장기대여·포크 안내" : "About rent, lease, and fork"}
                title={locale === "ko" ? "렌트·장기대여·포크 안내" : "About rent, lease, and fork"}
                onClick={() => setAgentKindsHelpOpen((current) => !current)}
              >
                ?
              </button>
            </div>
            {agentKindsHelpOpen ? (
              <div role="dialog" aria-label={locale === "ko" ? "이용 방식 안내" : "How hiring works"} className="project-agent-help-pop">
                <dl>
                  <dt>{locale === "ko" ? "렌트" : "Rent"}</dt>
                  <dd>{locale === "ko"
                    ? "작업당 과금. 렌트허용을 켜면 고지 없이 작업마다 호출·과금되고, 크레딧 부족 시에만 팝업이 뜹니다."
                    : "Billed per work order. With Allow rent on, the agent is called and billed per work order without a notice; only an insufficient-credits popup interrupts."}</dd>
                  <dt>{locale === "ko" ? "장기대여" : "Lease"}</dt>
                  <dd>{locale === "ko"
                    ? "일 단위 선불 대여. 계정에 귀속되어, 기간 중에는 어느 프로젝트에서든 호출이 무료입니다."
                    : "Prepaid day-based lease, bound to your account. While it lasts, calls are free in every project."}</dd>
                  <dt>{locale === "ko" ? "포크" : "Fork"}</dt>
                  <dd>{locale === "ko"
                    ? "내 워크스페이스로 사본 구매. 웹 에이전트 상세 페이지에서만 가능하며, 허브 재등록은 불가합니다."
                    : "Buy a copy into your workspace. Web agent page only; it cannot be re-published to the Hub."}</dd>
                </dl>
                <button type="button" onClick={() => setAgentKindsHelpOpen(false)}>
                  {locale === "ko" ? "닫기" : "Close"}
                </button>
              </div>
            ) : null}
            {(teamTreeOpen || editingTeam) && <div className="project-agent-workbench project-agent-workbench-compact" data-editing={editingTeam}>
              <ProjectTeamOrgChart
                locale={locale}
                members={agentPoolDraft}
                editing={editingTeam}
                open={teamTreeOpen}
                draggedMemberId={draggedMemberId}
                onToggle={() => setTeamTreeOpen((current) => !current)}
                onMove={movePoolMember}
                onRemove={(memberKey) => setAgentPoolDraft((current) => current.filter((item) => projectPoolMemberKey(item) !== memberKey))}
                onPointerDown={(event, memberKey) => beginPointerDrag(event, "member", memberKey)}
                onPointerUp={finishPointerDrag}
                onPointerCancel={() => { pointerDragRef.current = null; setDraggedMemberId(null); }}
                onDrop={dropAgent}
                hubCard={{
                  slugFor: hubSlugForMember,
                  rentAllowed: rentAllowedSlugs,
                  leaseUntil: leaseUntilBySlug,
                  onToggleRent: (slug, allowed) => void toggleRentAllowed(slug, allowed),
                  onLease: (slug, name) => setLeaseDialog({ slug, name }),
                }}
              />
              {editingTeam ? (
                <ProjectAgentRosterLibrary
                  locale={locale}
                  sections={rosterSections}
                  selectedMemberKeys={selectedMemberKeys}
                  openSources={openRosterSources}
                  openFirms={openRosterFirms}
                  draggedCandidateKey={draggedCandidateKey}
                  query={rosterQuery}
                  onQueryChange={setRosterQuery}
                  onToggleSource={(source) => setOpenRosterSources((current) => ({ ...current, [source]: !current[source] }))}
                  onToggleFirm={(firmId) => setOpenRosterFirms((current) => ({ ...current, [firmId]: !current[firmId] }))}
                  onAddCandidate={addCandidate}
                  onAddFirm={addCandidates}
                  onPointerDown={(event, candidateKey) => beginPointerDrag(event, "candidate", candidateKey)}
                  onPointerUp={finishPointerDrag}
                  onPointerCancel={() => { pointerDragRef.current = null; setDraggedCandidateKey(null); }}
                />
              ) : null}
            </div>}
            {editingTeam ? <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => void saveTeam()} style={raisedButton}>{locale === "ko" ? "도구 저장" : "Save tools"}</button>
              <button type="button" onClick={() => { setAgentPoolDraft(project.agentPool); setEditingTeam(false); }} style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("common.cancel")}</button>
            </div> : null}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 12px" }}>
            <h2 style={{ flex: 1, fontFamily: "var(--font-head)", fontSize: 15, margin: 0 }}>
              {locale === "ko" ? "작업" : "Tasks"} ({tasks.length})
            </h2>
          </div>
          {tasks.length === 0 ? (
            <div style={emptyStyle}>{t("project.empty_chats")}</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {tasks.map((task) => {
                const agent = task.participants.map((participant) => participant.agentId ? agentById.get(participant.agentId) : null).find(Boolean);
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => task.originChatId && navigate(`/workspace/task?id=${encodeURIComponent(task.originChatId)}&task=${encodeURIComponent(task.id)}&projectId=${encodeURIComponent(project.id)}`)}
                      style={chatLinkStyle}
                    >
                      <span style={chatTitleStyle}>
                        {taskTitleForDisplay(task.title, locale === "ko")}
                      </span>
                      {agent && (
                        <span style={{ fontSize: 11, color: "var(--muted-deep)", flexShrink: 0 }}>
                          {pickLocalized(agent, locale).name}
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0 }}>
                        {new Date(task.updatedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
                          month: "numeric",
                          day: "numeric",
                          hour: "numeric",
                          minute: "numeric",
                        })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        <aside className="project-timeline-aside" data-collapsed={inspectorCollapsed} style={{ minWidth: 0 }}>
          <button
            type="button"
            className="project-inspector-toggle"
            aria-expanded={!inspectorCollapsed}
            aria-label={inspectorCollapsed
              ? (locale === "ko" ? "프로젝트 정보 펼치기" : "Expand project information")
              : (locale === "ko" ? "프로젝트 정보 접기" : "Collapse project information")}
            title={inspectorCollapsed
              ? (locale === "ko" ? "프로젝트 정보 펼치기" : "Expand project information")
              : (locale === "ko" ? "프로젝트 정보 접기" : "Collapse project information")}
            onClick={() => setInspectorCollapsed((current) => !current)}
          >
            <IconPanelRight size={16} />
            {inspectorCollapsed ? <span>{locale === "ko" ? "정보" : "Info"}</span> : null}
          </button>
          <div className="project-inspector-content" aria-hidden={inspectorCollapsed}>
            <section style={{ ...cardStyle, marginBottom: 16 }}>
              <div style={{ ...eyebrowStyle, marginBottom: 8 }}>{locale === "ko" ? "소스" : "Source"}</div>
              <strong style={{ display: "block", fontSize: 13, color: "var(--ink)" }}>
                {project.sourceType === "local" ? (locale === "ko" ? "로컬 폴더" : "Local folder") : project.sourceType === "github" ? "GitHub" : (locale === "ko" ? "샘플" : "Sample")}
              </strong>
              {(project.sourceRef || project.folderPath) ? <span style={{ display: "block", marginTop: 4, fontSize: 11.5, color: "var(--muted-deep)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={project.sourceRef || project.folderPath || ""}>
                {project.sourceType === "github" ? project.sourceRef : (project.folderPath || project.sourceRef)?.split(/[\\/]/).filter(Boolean).at(-1)}
              </span> : null}
            </section>
            <ProjectOntologyPanel projectId={project.id} folderPath={project.folderPath ?? null} locale={locale} cardStyle={cardStyle} eyebrowStyle={eyebrowStyle} />
            <ProjectTimelinePanel timeline={timeline} locale={locale} recoveryPending={recoveryPending} />
          </div>
        </aside>
      </section>

      <style jsx global>{`
        .project-detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(300px, 370px);
          gap: 24px;
          align-items: start;
          transition: grid-template-columns 180ms ease, gap 180ms ease;
        }
        .project-task-start-option {
          cursor: pointer;
          transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
        }
        .project-task-start-option:hover {
          border-color: color-mix(in srgb, var(--accent) 46%, var(--paper-edge)) !important;
          background: color-mix(in srgb, var(--accent) 6%, var(--paper)) !important;
          transform: translateY(-1px);
        }
        .project-task-start-option:focus-visible {
          outline: 2px solid color-mix(in srgb, var(--accent) 48%, transparent);
          outline-offset: 2px;
        }
        .project-task-start-option:active {
          transform: translateY(0);
        }
        .project-detail-grid[data-inspector-collapsed="true"] {
          grid-template-columns: minmax(0, 1fr) 44px;
          gap: 12px;
        }
        .project-timeline-aside {
          position: sticky;
          top: 20px;
          max-height: calc(100vh - 44px);
        }
        .project-timeline-aside[data-collapsed="true"] {
          width: 44px;
        }
        .project-inspector-toggle {
          width: 36px;
          height: 36px;
          margin: 0 0 10px auto;
          display: grid;
          place-items: center;
          border: 1px solid var(--paper-edge);
          border-radius: 10px;
          background: var(--paper);
          color: var(--muted-deep);
          cursor: pointer;
          box-shadow: var(--shadow-1);
        }
        .project-inspector-toggle:hover,
        .project-inspector-toggle:focus-visible {
          border-color: var(--muted);
          color: var(--ink);
          outline: 2px solid color-mix(in srgb, var(--accent) 24%, transparent);
          outline-offset: 2px;
        }
        .project-inspector-toggle span {
          writing-mode: vertical-rl;
          margin-top: 6px;
          color: var(--muted-deep);
          font-size: 9px;
          font-weight: 800;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .project-timeline-aside[data-collapsed="true"] .project-inspector-toggle {
          height: 76px;
          margin-inline: auto;
          align-content: center;
        }
        .project-inspector-content {
          opacity: 1;
          transition: opacity 120ms ease;
        }
        .project-timeline-aside[data-collapsed="true"] .project-inspector-content {
          display: none;
          opacity: 0;
          pointer-events: none;
        }
        .project-agent-workbench-compact {
          min-height: 0;
          /* minmax(320px/280px, …) 최소폭이 좁은 패널에서 그리드를 카드 밖으로
             밀어냈다(스크린샷 실측) — 열이 0까지 줄 수 있어야 가로 넘침이 없다.
             목록 세로 스크롤은 각 열(.project-team-org/.project-agent-library-tree)이
             자기 overflow로 소유한다. */
          grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
        }
        .project-agent-workbench-compact > * {
          min-width: 0;
        }
        .project-agent-workbench-compact[data-editing="false"] {
          grid-template-columns: minmax(0, 1fr);
        }
        .project-detail-grid:not([data-inspector-collapsed="true"]) .project-agent-workbench-compact[data-editing="true"] {
          grid-template-columns: minmax(0, 1fr);
        }
        .project-team-org {
          min-height: 160px;
          padding: 14px;
          overflow: auto;
          border: 1px solid var(--paper-edge);
          border-radius: 16px;
          background: var(--paper);
        }
        .project-team-org[data-empty="true"] {
          display: grid;
          place-items: center;
          border-style: dashed;
          background: color-mix(in srgb, var(--accent) 4%, var(--paper));
        }
        .project-team-empty {
          max-width: 240px;
          color: var(--muted-deep);
          font-size: 12px;
          line-height: 1.55;
          text-align: center;
        }
        .project-team-node {
          position: relative;
          min-height: 52px;
          display: grid;
          grid-template-columns: auto 30px minmax(0, 1fr) auto;
          align-items: center;
          gap: 9px;
          padding: 8px 10px;
          border: 1px solid var(--paper-edge);
          border-radius: 11px;
          background: var(--paper);
          color: var(--ink);
        }
        .project-team-node[data-dragging="true"] {
          border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 6%, var(--paper));
        }
        .project-team-node-controller {
          border-color: color-mix(in srgb, var(--accent) 34%, var(--paper-edge));
          box-shadow: 0 8px 22px color-mix(in srgb, var(--ink) 6%, transparent);
        }
        .project-team-chevron {
          width: 24px;
          height: 24px;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: var(--muted-deep);
          cursor: pointer;
        }
        .project-team-avatar {
          width: 30px;
          height: 30px;
          display: grid;
          place-items: center;
          border-radius: 9px;
          background: var(--paper-2);
          color: var(--accent);
        }
        .project-team-node-copy {
          min-width: 0;
          display: grid;
          gap: 2px;
        }
        .project-team-node-copy strong {
          overflow: hidden;
          color: var(--ink);
          font-size: 12.5px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .project-team-node-copy span {
          color: var(--muted-deep);
          font-size: 10.5px;
        }
        .project-team-actions {
          display: flex;
          align-items: center;
          gap: 2px;
        }
        .project-team-actions button {
          min-width: 28px;
          min-height: 28px;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: var(--muted-deep);
          font-size: 11px;
          cursor: pointer;
        }
        .project-team-actions button:hover:not(:disabled),
        .project-team-actions button:focus-visible:not(:disabled) {
          background: var(--paper-2);
          color: var(--ink);
        }
        .project-team-actions button:disabled {
          opacity: .28;
          cursor: default;
        }
        .project-team-children {
          position: relative;
          display: grid;
          gap: 7px;
          margin: 8px 0 0 29px;
          padding-left: 28px;
        }
        .project-team-children::before {
          content: "";
          position: absolute;
          left: 0;
          top: -8px;
          bottom: 26px;
          width: 1px;
          background: var(--paper-edge);
        }
        .project-team-child::before {
          content: "";
          position: absolute;
          left: -29px;
          top: 25px;
          width: 28px;
          height: 1px;
          background: var(--paper-edge);
        }
        .project-agent-library-tree {
          max-height: 540px;
          padding: 10px;
          /* 목록은 자기 컨테이너 안에서만 세로 스크롤한다 — 패널 밖으로 그려지거나
             페이지 가로 스크롤을 만들면 안 된다. */
          overflow-x: hidden;
          overflow-y: auto;
          min-width: 0;
          border: 1px solid var(--paper-edge);
          border-radius: 16px;
          background: var(--paper);
        }
        .project-roster-search {
          position: relative;
          display: block;
          margin: 0 2px 8px;
        }
        .project-roster-search > svg {
          position: absolute;
          left: 10px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--muted-deep);
          pointer-events: none;
        }
        .project-roster-search > input {
          width: 100%;
          min-height: 32px;
          padding: 0 10px 0 28px;
          border: 1px solid var(--paper-edge);
          border-radius: 9px;
          background: var(--paper-2);
          color: var(--ink);
          font-size: 12px;
        }
        .project-roster-search > input:focus-visible {
          outline: 2px solid color-mix(in srgb, var(--accent) 32%, transparent);
          outline-offset: 1px;
        }
        .project-roster-search-empty {
          padding: 14px 8px;
          color: var(--muted-deep);
          font-size: 11.5px;
          text-align: center;
        }
        .project-agent-help {
          flex-shrink: 0;
          width: 22px;
          height: 22px;
          display: grid;
          place-items: center;
          border: 1px solid var(--paper-edge);
          border-radius: 999px;
          background: var(--paper);
          color: var(--muted-deep);
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
        }
        .project-agent-help:hover,
        .project-agent-help[aria-expanded="true"] {
          border-color: var(--accent);
          color: var(--accent);
        }
        .project-agent-help-pop {
          position: absolute;
          top: 44px;
          right: 14px;
          z-index: 30;
          width: min(320px, calc(100% - 28px));
          padding: 12px 14px;
          border: 1px solid var(--paper-edge);
          border-radius: 12px;
          background: var(--paper);
          box-shadow: 0 14px 44px rgba(20, 22, 18, .16);
        }
        .project-agent-help-pop dl {
          margin: 0;
          display: grid;
          gap: 8px;
        }
        .project-agent-help-pop dt {
          font-size: 11.5px;
          font-weight: 800;
          color: var(--ink);
        }
        .project-agent-help-pop dd {
          margin: 2px 0 0;
          font-size: 11.5px;
          line-height: 1.5;
          color: var(--muted-deep);
        }
        .project-agent-help-pop > button {
          margin-top: 10px;
          min-height: 28px;
          padding: 0 10px;
          border: 1px solid var(--paper-edge);
          border-radius: 8px;
          background: var(--paper);
          color: var(--ink-soft);
          font-size: 11.5px;
          font-weight: 700;
          cursor: pointer;
        }
        .project-agent-hub-controls {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }
        /* .project-team-actions button 규칙(테두리 제거·투명 배경)보다 이겨야 하므로
           두 클래스 선택자로 특이도를 올린다 — 편집 모드에서도 같은 모양을 유지. */
        .project-agent-hub-controls .project-agent-rent-toggle,
        .project-agent-rent-toggle {
          min-height: 24px;
          padding: 0 8px;
          border: 1px solid var(--paper-edge);
          border-radius: 999px;
          background: var(--paper);
          color: var(--muted-deep);
          font-size: 10px;
          font-weight: 750;
          cursor: pointer;
          white-space: nowrap;
        }
        .project-agent-hub-controls .project-agent-rent-toggle[aria-checked="true"] {
          border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 9%, var(--paper));
          color: var(--accent);
        }
        .project-agent-hub-controls .project-agent-lease-button,
        .project-agent-lease-button {
          min-height: 24px;
          padding: 0 8px;
          border: 1px solid var(--paper-edge);
          border-radius: 7px;
          background: var(--paper);
          color: var(--ink-soft);
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .project-agent-hub-controls .project-agent-lease-button:hover {
          border-color: var(--muted);
          color: var(--ink);
        }
        .project-agent-lease-badge {
          padding: 3px 8px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--green-deep) 10%, transparent);
          color: var(--green-deep);
          font-size: 10px;
          font-weight: 750;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .project-roster-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 34px;
          padding: 0 6px 8px;
          color: var(--muted-deep);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .project-roster-source-row,
        .project-roster-firm-row,
        .project-roster-candidate {
          width: 100%;
          min-width: 0;
          display: grid;
          align-items: center;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--ink);
          text-align: left;
        }
        .project-roster-source-row {
          grid-template-columns: 18px minmax(0, 1fr) auto;
          gap: 6px;
          min-height: 34px;
          padding: 5px 7px;
          font-size: 12px;
          cursor: pointer;
        }
        .project-roster-source-row:hover,
        .project-roster-firm-row:hover,
        .project-roster-candidate:hover:not(:disabled) {
          background: var(--paper-2);
        }
        .project-roster-count,
        .project-roster-kind {
          color: var(--muted);
          font: 650 10px/1 var(--font-mono);
        }
        .project-roster-firm-row {
          grid-template-columns: 18px 18px minmax(0, 1fr) auto auto;
          gap: 5px;
          min-height: 34px;
          padding: 5px 7px 5px 18px;
        }
        .project-roster-firm-row > span:not(.project-roster-count) {
          overflow: hidden;
          font-size: 11.5px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .project-roster-add-team {
          min-height: 24px;
          padding: 0 7px;
          border: 1px solid var(--paper-edge);
          border-radius: 7px;
          background: var(--paper);
          color: var(--muted-deep);
          font-size: 9.5px;
          font-weight: 750;
          cursor: pointer;
        }
        .project-roster-children {
          position: relative;
          display: grid;
          gap: 2px;
          margin-left: 31px;
          padding-left: 14px;
          border-left: 1px solid var(--paper-edge);
        }
        .project-roster-candidate {
          position: relative;
          grid-template-columns: 24px minmax(0, 1fr) auto;
          gap: 7px;
          min-height: 38px;
          padding: 5px 7px;
          cursor: grab;
        }
        .project-roster-candidate::before {
          content: "";
          position: absolute;
          left: -15px;
          top: 19px;
          width: 14px;
          height: 1px;
          background: var(--paper-edge);
        }
        .project-roster-candidate[data-selected="true"] {
          color: var(--muted);
          cursor: default;
        }
        .project-roster-candidate[data-dragging="true"] {
          background: color-mix(in srgb, var(--accent) 7%, var(--paper));
          box-shadow: inset 2px 0 var(--accent);
        }
        .project-roster-candidate:disabled {
          opacity: .48;
          cursor: not-allowed;
        }
        .project-roster-candidate-avatar {
          width: 24px;
          height: 24px;
          display: grid;
          place-items: center;
          border-radius: 7px;
          background: var(--paper-2);
          color: var(--accent);
        }
        .project-roster-candidate-copy {
          min-width: 0;
          display: grid;
          gap: 1px;
        }
        .project-roster-candidate-copy strong,
        .project-roster-candidate-copy span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .project-roster-candidate-copy strong {
          font-size: 11.5px;
        }
        .project-roster-candidate-copy span {
          color: var(--muted-deep);
          font-size: 9.5px;
        }
        .project-roster-standalone {
          display: grid;
          gap: 2px;
          margin-left: 31px;
          padding-left: 14px;
          border-left: 1px solid var(--paper-edge);
        }
        .project-memory-tree-panel {
          max-height: inherit;
          overflow-y: auto;
          padding: 2px 2px 18px;
        }
        .project-memory-tree {
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .project-memory-tree-group {
          position: relative;
          padding: 0 0 22px 20px;
        }
        .project-memory-tree-group:last-child {
          padding-bottom: 0;
        }
        .project-memory-tree-group::before {
          content: "";
          position: absolute;
          left: 0;
          top: 5px;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--accent);
        }
        .project-memory-tree-group::after {
          content: "";
          position: absolute;
          left: 3px;
          top: 15px;
          bottom: -2px;
          width: 1px;
          background: var(--paper-edge);
        }
        .project-memory-tree-group:last-child::after {
          display: none;
        }
        .project-memory-tree-date {
          display: block;
          color: var(--muted-deep);
          font: 650 11px/1.45 var(--font-mono);
          letter-spacing: -0.1px;
        }
        .project-memory-tree-entries {
          display: grid;
          gap: 6px;
          margin: 7px 0 0;
          padding: 0;
          list-style: none;
        }
        .project-memory-tree-entry {
          position: relative;
          min-width: 0;
          padding-left: 13px;
        }
        .project-memory-tree-entry::before {
          content: "–";
          position: absolute;
          left: 0;
          top: 1px;
          color: var(--muted);
          font-size: 12px;
        }
        .project-memory-tree-link,
        .project-memory-tree-static {
          display: block;
          min-width: 0;
          color: var(--ink);
          font-size: 12.5px;
          line-height: 1.5;
          text-decoration: none;
          overflow-wrap: anywhere;
        }
        .project-memory-tree-link:hover {
          color: var(--accent);
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .project-memory-tree-link:focus-visible {
          border-radius: 4px;
          outline: 2px solid var(--accent);
          outline-offset: 3px;
        }
        .project-memory-tree-static {
          color: var(--ink-soft);
        }
        .project-memory-tree-status {
          margin-left: 6px;
          color: var(--muted-deep);
          font-size: 10.5px;
          white-space: nowrap;
        }
        @media (max-width: 940px) {
          .project-detail-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .project-detail-grid[data-inspector-collapsed="true"] {
            grid-template-columns: minmax(0, 1fr);
          }
          .project-timeline-aside {
            position: static;
            max-height: none;
            grid-row: 1;
          }
          .project-timeline-aside[data-collapsed="true"] {
            width: 100%;
            min-height: 44px;
          }
          .project-timeline-aside[data-collapsed="true"] .project-inspector-toggle {
            height: 36px;
            margin-left: auto;
          }
          .project-timeline-aside[data-collapsed="true"] .project-inspector-toggle span {
            display: none;
          }
        }
        @media (max-width: 820px) {
          .project-agent-workbench-compact {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
    </div>
  );
}

/** Hub 북마크 카드 전용 컨트롤(렌트허용 토글·장기대여) 배선. 로컬/클라우드 카드는 무관. */
interface ProjectHubCardControls {
  /** Hub 멤버의 targetId → slug 복원. null 이면 컨트롤을 그리지 않는다. */
  slugFor: (member: ProjectAgentPoolMember) => string | null;
  rentAllowed: Set<string>;
  leaseUntil: Map<string, string>;
  onToggleRent: (slug: string, allowed: boolean) => void;
  onLease: (slug: string, name: string) => void;
}

function ProjectTeamOrgChart({
  locale,
  members,
  editing,
  open,
  draggedMemberId,
  onToggle,
  onMove,
  onRemove,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onDrop,
  hubCard,
}: {
  locale: string;
  members: ProjectAgentPoolMember[];
  editing: boolean;
  open: boolean;
  draggedMemberId: string | null;
  onToggle: () => void;
  onMove: (memberKey: string, targetIndex: number) => void;
  onRemove: (memberKey: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, memberKey: string) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  hubCard?: ProjectHubCardControls;
}) {
  if (members.length === 0) {
    return (
      <div
        className="project-team-org"
        data-project-agent-pool
        data-empty="true"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <div className="project-team-empty">
          {locale === "ko"
            ? "오른쪽에서 이 프로젝트가 쓸 에이전트를 넣으세요. 순위는 없고, 오케스트레이터가 필요할 때 호출합니다."
            : "Add the agents or teams this project may use as tools. The orchestrator calls them when useful."}
        </div>
      </div>
    );
  }

  const ko = locale === "ko";
  // Hub 북마크 카드의 오른쪽 컨트롤:
  //   활성 대여 → 배지만(두 컨트롤 숨김) / 그 외 → [렌트허용] 토글 + [장기대여] 버튼.
  const renderHubControls = (member: ProjectAgentPoolMember) => {
    if (!hubCard) return null;
    const slug = hubCard.slugFor(member);
    if (!slug) return null;
    const leasedUntil = hubCard.leaseUntil.get(slug) ?? null;
    if (leasedUntil) {
      const date = new Date(leasedUntil);
      const label = Number.isFinite(date.getTime())
        ? ko
          ? `${new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(date)}까지 대여`
          : `Leased until ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)}`
        : ko ? "대여 중" : "Leased";
      return <span className="project-agent-lease-badge">{label}</span>;
    }
    const allowed = hubCard.rentAllowed.has(slug);
    return (
      <span className="project-agent-hub-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="project-agent-rent-toggle"
          role="switch"
          aria-checked={allowed}
          title={ko
            ? "켜면 이 프로젝트 작업에 고지 없이 작업당 호출·과금됩니다. 끄면 자동 고용에서 제외됩니다."
            : "On: auto-hired and billed per work order with no notice. Off: excluded from auto-hire for this project."}
          onClick={() => hubCard.onToggleRent(slug, !allowed)}
        >
          {ko ? "렌트허용" : "Allow rent"}
        </button>
        <button
          type="button"
          className="project-agent-lease-button"
          onClick={() => hubCard.onLease(slug, member.nameSnapshot)}
        >
          {ko ? "장기대여" : "Lease"}
        </button>
      </span>
    );
  };

  const renderNode = (member: ProjectAgentPoolMember, index: number, child: boolean) => (
    <div
      className="project-team-node project-team-child"
      data-project-member-index={index}
      data-dragging={draggedMemberId === projectPoolMemberKey(member)}
      key={projectPoolMemberKey(member)}
      draggable={false}
      onPointerDown={(event) => { if (editing) onPointerDown(event, projectPoolMemberKey(member)); }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDragOver={(event) => { if (editing) event.preventDefault(); }}
      onDrop={(event) => {
        event.preventDefault();
        onMove(event.dataTransfer.getData("application/x-agentlas-project-member"), index);
      }}
    >
      {/* 첫 구성원이 나머지를 거느리지 않으므로 접을 하위 묶음도 없다. */}
      <span />
      <span className="project-team-avatar"><IconUsers size={14} /></span>
      <span className="project-team-node-copy">
        <strong>{member.nameSnapshot}</strong>
        <span>{locale === "ko"
          ? "프로젝트 도구 · 필요할 때 호출"
          : "Project tool · invoked when needed"}</span>
      </span>
      {editing ? (
        <span className="project-team-actions" onPointerDown={(event) => event.stopPropagation()}>
          {renderHubControls(member)}
          {/* 순위가 없으므로 위/아래로 옮길 자리도 없다. 재정렬 버튼은 그 자체가
              서열이 있다는 주장이라 제거한다. */}
          <button type="button" aria-label={locale === "ko" ? `${member.nameSnapshot} 제거` : `Remove ${member.nameSnapshot}`} onClick={() => onRemove(projectPoolMemberKey(member))}>×</button>
        </span>
      ) : (
        renderHubControls(member)
          ?? <span className="project-roster-kind">{child ? member.source : (locale === "ko" ? "프로젝트 도구" : "project tool")}</span>
      )}
    </div>
  );

  return (
    <div
      className="project-team-org"
      data-project-agent-pool
      data-empty="false"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {/* 대기조에는 책임자가 없다. 오케스트레이터는 대시보드에서 지정된 세션
          LLM이고 프로젝트에 고정되지 않는다. 구성원은 전원 동순위 대기조이므로
          첫 번째를 부모로 세우고 나머지를 자식으로 들여쓰지 않는다. */}
      {members.map((member, index) => renderNode(member, index, false))}
    </div>
  );
}

function ProjectAgentRosterLibrary({
  locale,
  sections,
  selectedMemberKeys,
  openSources,
  openFirms,
  draggedCandidateKey,
  query,
  onQueryChange,
  onToggleSource,
  onToggleFirm,
  onAddCandidate,
  onAddFirm,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
}: {
  locale: string;
  sections: ProjectRosterSection[];
  selectedMemberKeys: Set<string>;
  openSources: Record<ProjectRosterSource, boolean>;
  openFirms: Record<string, boolean>;
  draggedCandidateKey: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onToggleSource: (source: ProjectRosterSource) => void;
  onToggleFirm: (firmId: string) => void;
  onAddCandidate: (candidate: ProjectRosterCandidate) => void;
  onAddFirm: (candidates: ProjectRosterCandidate[]) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, candidateKey: string) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}) {
  // 클라이언트 필터 — 이름/slug(targetId) 부분 일치, 대소문자 무시. 검색 중에는
  // 접힘 상태를 무시하고 일치 항목을 모두 펼쳐 보여준다.
  const q = query.trim().toLowerCase();
  const matchesCandidate = (candidate: ProjectRosterCandidate) =>
    !q
    || candidate.name.toLowerCase().includes(q)
    || candidate.member.targetId.toLowerCase().includes(q);
  const renderCandidate = (candidate: ProjectRosterCandidate) => {
    const selected = selectedMemberKeys.has(candidate.key);
    const disabled = selected || !candidate.callable;
    const helper = selected
      ? (locale === "ko" ? "프로젝트에 추가됨" : "Added to project")
      : !candidate.callable
        ? candidate.blockedReason ?? (locale === "ko" ? "실행할 수 없는 항목" : "Not callable")
      : candidate.tagline;
    return (
      <button
        type="button"
        className="project-roster-candidate"
        data-project-agent-candidate={candidate.key}
        data-selected={selected}
        data-dragging={draggedCandidateKey === candidate.key}
        disabled={disabled}
        key={candidate.key}
        title={helper}
        onPointerDown={(event) => { if (!disabled) onPointerDown(event, candidate.key); }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={() => { if (!disabled) onAddCandidate(candidate); }}
      >
        <span className="project-roster-candidate-avatar">
          {candidate.kind === "team" ? <IconBuilding size={12} /> : <IconUsers size={12} />}
        </span>
        <span className="project-roster-candidate-copy">
          <strong>{candidate.name}</strong>
          <span>{helper}</span>
        </span>
        <span className="project-roster-kind">{candidate.kind === "team" ? "multi" : candidate.source}</span>
      </button>
    );
  };

  // 검색 중에는 일치하는 후보만 남긴다. 팀 행은 팀 자신이 일치하거나 일치하는
  // 멤버가 있을 때만 남고, 남은 팀/섹션은 강제로 펼친다.
  const visibleSections = sections
    .map((section) => {
      const firms = q
        ? section.firms
          .map((firm) => ({ ...firm, members: firm.members.filter(matchesCandidate) }))
          .filter((firm) => firm.members.length > 0 || matchesCandidate(firm.team))
        : section.firms;
      const standalone = q ? section.standalone.filter(matchesCandidate) : section.standalone;
      return { ...section, firms, standalone };
    })
    .filter((section) => !q || section.firms.length > 0 || section.standalone.length > 0);
  const totalCount = visibleSections.reduce(
    (sum, section) => sum + section.standalone.length + section.firms.reduce((firmSum, firm) => firmSum + 1 + firm.members.length, 0),
    0,
  );

  return (
    <aside className="project-agent-library-tree" aria-label={locale === "ko" ? "실행 가능한 팀과 에이전트" : "Callable teams and agents"}>
      <div className="project-roster-head">
        <span>{locale === "ko" ? "팀과 에이전트" : "Teams and agents"}</span>
        <span>{totalCount}</span>
      </div>
      <label className="project-roster-search">
        <span className="sr-only">{locale === "ko" ? "에이전트 검색" : "Search agents"}</span>
        <IconSearch size={13} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={locale === "ko" ? "에이전트 검색" : "Search agents"}
        />
      </label>
      {q && totalCount === 0 ? (
        <div className="project-roster-search-empty" role="status">
          {locale === "ko" ? "일치하는 에이전트가 없습니다." : "No matching agents."}
        </div>
      ) : null}
      {visibleSections.map((section) => {
        const count = section.standalone.length + section.firms.reduce((sum, firm) => sum + 1 + firm.members.length, 0);
        const open = q ? true : openSources[section.source];
        return (
          <div key={section.source}>
            <button type="button" className="project-roster-source-row" onClick={() => onToggleSource(section.source)} aria-expanded={open}>
              {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              <span>{locale === "ko" ? section.labelKo : section.labelEn}</span>
              <span className="project-roster-count">{count}</span>
            </button>
            {open ? (
              <>
                {section.firms.map((firm) => {
                  const firmOpen = q ? true : openFirms[firm.id] ?? false;
                  const teamAddable = firm.team.callable && !selectedMemberKeys.has(firm.team.key);
                  return (
                    <div key={firm.id}>
                      <div className="project-roster-firm-row">
                        {/* A self-referential firm has nothing to disclose: its only
                            member is the team itself. Showing a chevron there promised
                            member detail and delivered a duplicate of the same row, and
                            the count showed 1 because the team counted itself. */}
                        {firm.selfReferential ? (
                          <span className="project-team-chevron" aria-hidden="true" />
                        ) : (
                          <button type="button" className="project-team-chevron" onClick={() => onToggleFirm(firm.id)} aria-expanded={firmOpen}>
                            {firmOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                          </button>
                        )}
                        <IconBuilding size={12} />
                        <span>{firm.name}</span>
                        {firm.selfReferential ? null : <span className="project-roster-count">{firm.members.length}</span>}
                        <button
                          type="button"
                          className="project-roster-add-team"
                          disabled={!teamAddable}
                          onClick={() => onAddFirm([firm.team])}
                        >
                          {locale === "ko" ? "팀 도구 추가" : "Add team tool"}
                        </button>
                      </div>
                      {firmOpen && !firm.selfReferential ? <div className="project-roster-children">{firm.members.map(renderCandidate)}</div> : null}
                    </div>
                  );
                })}
                {section.standalone.length > 0 ? (
                  <>
                    {/* 단일 에이전트는 어느 팀에도 속하지 않는다. 제목 없이 팀 목록
                        바로 뒤에 이어 붙이면 마지막 팀의 구성원으로 읽힌다. */}
                    <div className="project-roster-standalone-head">{locale === "ko" ? "단일 에이전트" : "Standalone agents"}</div>
                    <div className="project-roster-standalone">{section.standalone.map(renderCandidate)}</div>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}

function ProjectTimelinePanel({
  timeline,
  locale,
  recoveryPending,
}: {
  timeline: ProjectTimelineSnapshot | null;
  locale: string;
  recoveryPending: boolean;
}) {
  const groups = useMemo(
    () => groupTimelineEntries(timeline?.entries ?? [], locale),
    [locale, timeline?.entries],
  );

  return (
    <section
      className="project-memory-tree-panel"
      aria-label={locale === "en" ? "Project work timeline" : "프로젝트 작업 타임라인"}
    >
      <header style={{ marginBottom: 14 }}>
        <div style={eyebrowStyle}>{locale === "en" ? "Project memory" : "프로젝트 기억"}</div>
        <p style={{ margin: "5px 0 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.45 }}>
          {locale === "en"
            ? `${timeline?.entries.length ?? 0} remembered work records, preserved across sessions.`
            : `세션이 바뀌어도 유지되는 작업 기록 ${timeline?.entries.length ?? 0}개`}
        </p>
      </header>
      {!timeline ? (
        recoveryPending ? <p style={timelineEmptyStyle} role="alert">{locale === "en" ? "The project timeline is temporarily unavailable." : "프로젝트 작업 기록을 잠시 불러올 수 없습니다."}</p> : null
      ) : groups.length === 0 ? (
        <p style={timelineEmptyStyle}>
          {locale === "en" ? "No work recorded yet." : "아직 기록된 작업이 없습니다."}
        </p>
      ) : (
        <ol className="project-memory-tree">
          {groups.map((group) => (
            <li key={group.key} className="project-memory-tree-group">
              <time className="project-memory-tree-date">{group.label}</time>
              <ul className="project-memory-tree-entries">
                {group.entries.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} locale={locale} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {timeline?.truncated && (
        <p style={{ margin: "14px 0 0 20px", fontSize: 10.5, color: "var(--muted-deep)" }}>
          {locale === "en"
            ? "Showing the latest 80 records."
            : "최근 기록 80개만 표시합니다."}
        </p>
      )}
    </section>
  );
}

function TimelineRow({ entry, locale }: { entry: ProjectTimelineEntry; locale: string }) {
  const href = timelineEntryHref(entry);
  const status = timelineVisibleStatus(entry, locale);
  const ariaStatus = timelineNavigationLabel(entry, locale);
  const content = (
    <>
      {entry.summary}
      {status && <span className="project-memory-tree-status">({status})</span>}
    </>
  );

  return (
    <li className="project-memory-tree-entry">
      {href ? (
        <Link
          href={href}
          className="project-memory-tree-link"
          aria-label={`${entry.summary}. ${ariaStatus}`}
        >
          {content}
        </Link>
      ) : (
        <span
          className="project-memory-tree-static"
          aria-label={`${entry.summary}. ${ariaStatus}`}
        >
          {content}
        </span>
      )}
    </li>
  );
}

function timelineEntryHref(entry: ProjectTimelineEntry): string | null {
  if (!entry.chatId) return null;
  if (entry.navigationStatus !== "exact" && entry.navigationStatus !== "chat_only") return null;
  const params = new URLSearchParams({ id: entry.chatId, from: "project-timeline" });
  if (entry.navigationStatus === "exact" && entry.messageId) {
    params.set("focus", entry.messageId);
  }
  return `/workspace/task?${params.toString()}`;
}

function timelineNavigationLabel(entry: ProjectTimelineEntry, locale: string): string {
  const archived = entry.archived
    ? locale === "en" ? "Archived session" : "보관된 세션"
    : "";
  const base = entry.navigationStatus === "exact"
    ? locale === "en" ? "Open original message" : "원문 메시지로 이동"
    : entry.navigationStatus === "chat_only"
      ? locale === "en" ? "Original message deleted · open session" : "원문 삭제됨 · 세션 열기"
      : entry.navigationStatus === "chat_deleted"
        ? locale === "en" ? "Session deleted · work record preserved" : "세션 삭제됨 · 작업 기록만 보존"
        : locale === "en" ? "Work record preserved without a session" : "세션 연결 없이 작업 기록만 보존";
  return archived ? `${base} · ${archived}` : base;
}

function timelineVisibleStatus(entry: ProjectTimelineEntry, locale: string): string {
  if (entry.navigationStatus === "chat_only") {
    return locale === "en" ? "original deleted" : "원문 삭제됨";
  }
  if (entry.navigationStatus === "chat_deleted") {
    return locale === "en" ? "session deleted" : "세션 삭제됨";
  }
  if (entry.navigationStatus === "unlinked") {
    return locale === "en" ? "record only" : "기록만 보존";
  }
  return entry.archived ? locale === "en" ? "archived" : "보관됨" : "";
}

function groupTimelineEntries(entries: ProjectTimelineEntry[], locale: string) {
  const groups = new Map<string, { key: string; label: string; entries: ProjectTimelineEntry[] }>();
  for (const entry of entries) {
    const date = new Date(entry.occurredAt);
    const valid = !Number.isNaN(date.getTime());
    const key = valid
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : "unknown";
    const label = valid
      ? locale === "en"
        ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
        : `${String(date.getFullYear()).slice(-2)}년 ${String(date.getMonth() + 1).padStart(2, "0")}월 ${String(date.getDate()).padStart(2, "0")}일`
      : locale === "en" ? "Unknown date" : "날짜 미상";
    const group = groups.get(key) ?? { key, label, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--muted-deep)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  fontFamily: "var(--font-mono)",
};

const cardStyle: React.CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-lg)",
  padding: 16,
};

const raisedButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  padding: "8px 14px",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontWeight: 600,
  fontSize: 12,
  border: "1px solid var(--paper-edge)",
  boxShadow: "var(--neu-raised)",
};

const pageNotice: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: 16,
  fontSize: 13,
  lineHeight: 1.5,
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  border: "1px dashed var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  color: "var(--muted-deep)",
  textAlign: "center",
};

const timelineEmptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "4px 0",
  color: "var(--muted-deep)",
  fontSize: 12,
  lineHeight: 1.55,
};

const chatLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  textDecoration: "none",
  color: "var(--ink)",
};

const chatTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontWeight: 500,
  fontSize: 13,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
