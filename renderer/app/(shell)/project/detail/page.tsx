// 프로젝트 상세 — 프로젝트 문맥, 채팅, PM 메모리 기반 작업 타임라인.
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  IconArrowLeft,
  IconBuilding,
  IconChevronDown,
  IconChevronRight,
  IconPanelRight,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@/components/Icon";
import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { hubBookmarksWithoutLocalDuplicates } from "@/lib/hub-bookmark-events";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import type {
  CanonicalTask,
  HubAgentBookmark,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  Project,
  ProjectAgentPoolMember,
  ProjectTimelineEntry,
  ProjectTimelineSnapshot,
} from "@/lib/types";

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
  const [teamTreeOpen, setTeamTreeOpen] = useState(true);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recoveryPending, setRecoveryPending] = useState(false);

  const rosterSections = useMemo(
    () => buildProjectRosterSections(agents, firms, cloudListings, hubBookmarks, locale),
    [agents, cloudListings, firms, hubBookmarks, locale],
  );
  const candidateByKey = useMemo(() => {
    const rows = rosterSections.flatMap((section) => [
      ...section.standalone,
      ...section.firms.flatMap((firm) => firm.members),
    ]);
    return new Map(rows.map((candidate) => [candidate.key, candidate]));
  }, [rosterSections]);

  const recoverMissingBridge = useCallback((scope: string) => {
    setRecoveryPending(true);
    requestOneOperationalRecovery(scope, new Error("Desktop bridge unavailable"));
  }, []);

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
      const [p, taskRows, ag, firmRows, mine, bookmarks, timelineResult] = await Promise.all([
        api.projects.get(id),
        api.tasks.list({ limit: 200 }),
        api.team.list(),
        api.firms.list().catch(() => [] as InstalledFirm[]),
        api.marketplace.listMine().catch(() => [] as MarketplaceListing[]),
        api.marketplace.bookmarks().catch(() => [] as HubAgentBookmark[]),
        api.projects.timeline(id).catch(() => null),
      ]);
      if (!p) {
        navigate("/dashboard", "replace");
        return;
      }
      setProject(p);
      setNoteDraft(p.systemPrompt ?? "");
      // Older projects and imported fixtures can predate the ordered pool.
      // Keep that state explicit and empty instead of inventing a controller.
      setAgentPoolDraft(Array.isArray(p.agentPool) ? p.agentPool : []);
      setTasks(taskRows.filter((task) => task.projectId === id));
      // Keep the complete installed graph here. Team members are intentionally
      // background in the global flat roster, but they must remain available
      // inside their HQ/org tree on a project. Standalone rows are filtered
      // separately below so internal workers never leak into the top level.
      setAgents(ag);
      setFirms(firmRows);
      setCloudListings(mine);
      setHubBookmarks(bookmarks);
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

  async function startNewChat() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-detail-new-task");
      return;
    }
    if (!project) return;
    try {
      const target = await api.tasks.createProject({ projectId: project.id });
      window.dispatchEvent(new Event("agentlas:tasks-changed"));
      navigate(`/workspace/task?id=${encodeURIComponent(target.chatId)}&task=${encodeURIComponent(target.taskId)}&projectId=${encodeURIComponent(project.id)}`);
    } catch {
      setRecoveryPending(true);
    }
  }

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

  function movePoolMember(agentId: string, targetIndex: number) {
    if (!editingTeam) return;
    setAgentPoolDraft((current) => {
      const sourceIndex = current.findIndex((member) => member.agentId === agentId);
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
    if (!project || agentPoolDraft.length === 0) return;
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
            ? <div style={pageNotice}>{locale === "en" ? "Loading project…" : "프로젝트를 불러오는 중입니다…"}</div>
            : <div data-one-content-slot data-capability="project-detail-recovery" />}
        </section>
      </div>
    );
  }

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const selectedMemberKeys = new Set(agentPoolDraft.map(projectPoolMemberKey));

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
          onClick={() => void startNewChat()}
          className="titlebar-nodrag"
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

      {recoveryPending && (
        <section style={{ maxWidth: 1280, margin: "16px auto 0", padding: "0 24px" }}>
          <div data-one-content-slot data-capability="project-detail-recovery" />
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

          <div style={{ ...cardStyle, marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ ...eyebrowStyle, flex: 1 }}>{locale === "ko" ? "프로젝트 조직 · 책임자와 구성원" : "Project organization · controller and members"}</div>
              {!editingTeam ? (
                <button type="button" onClick={() => { setEditingTeam(true); setInspectorCollapsed(true); }} style={{ color: "var(--accent)", fontSize: 12, fontWeight: 700 }}>
                  {locale === "ko" ? "편집" : "Edit"}
                </button>
              ) : null}
            </div>
            <div className="project-agent-workbench project-agent-workbench-compact" data-editing={editingTeam}>
              <ProjectTeamOrgChart
                locale={locale}
                members={agentPoolDraft}
                editing={editingTeam}
                open={teamTreeOpen}
                draggedMemberId={draggedMemberId}
                onToggle={() => setTeamTreeOpen((current) => !current)}
                onMove={movePoolMember}
                onRemove={(agentId) => setAgentPoolDraft((current) => current.filter((item) => item.agentId !== agentId))}
                onPointerDown={(event, agentId) => beginPointerDrag(event, "member", agentId)}
                onPointerUp={finishPointerDrag}
                onPointerCancel={() => { pointerDragRef.current = null; setDraggedMemberId(null); }}
                onDrop={dropAgent}
              />
              {editingTeam ? (
                <ProjectAgentRosterLibrary
                  locale={locale}
                  sections={rosterSections}
                  selectedMemberKeys={selectedMemberKeys}
                  hasController={agentPoolDraft.length > 0}
                  openSources={openRosterSources}
                  openFirms={openRosterFirms}
                  draggedCandidateKey={draggedCandidateKey}
                  onToggleSource={(source) => setOpenRosterSources((current) => ({ ...current, [source]: !current[source] }))}
                  onToggleFirm={(firmId) => setOpenRosterFirms((current) => ({ ...current, [firmId]: !current[firmId] }))}
                  onAddCandidate={addCandidate}
                  onAddFirm={addCandidates}
                  onPointerDown={(event, candidateKey) => beginPointerDrag(event, "candidate", candidateKey)}
                  onPointerUp={finishPointerDrag}
                  onPointerCancel={() => { pointerDragRef.current = null; setDraggedCandidateKey(null); }}
                />
              ) : null}
            </div>
            {editingTeam ? <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" disabled={agentPoolDraft.length === 0} onClick={() => void saveTeam()} style={raisedButton}>{locale === "ko" ? "팀 저장" : "Save team"}</button>
              <button type="button" onClick={() => { setAgentPoolDraft(project.agentPool); setEditingTeam(false); }} style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("common.cancel")}</button>
            </div> : null}
          </div>

          <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 12px" }}>
            {locale === "ko" ? "작업" : "Tasks"} ({tasks.length})
          </h2>
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
                        {task.title.trim() || (locale === "ko" ? "새 작업" : "New task")}
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
          box-shadow: var(--shadow-xs);
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
          grid-template-columns: minmax(320px, 1.15fr) minmax(280px, .85fr);
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
          overflow: auto;
          border: 1px solid var(--paper-edge);
          border-radius: 16px;
          background: var(--paper);
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

type ProjectRosterSource = "local" | "cloud" | "hub";

interface ProjectRosterCandidate {
  key: string;
  member: ProjectAgentPoolMember;
  name: string;
  tagline: string;
  source: ProjectRosterSource;
  kind: "agent" | "team";
  installed: boolean;
}

interface ProjectRosterFirm {
  id: string;
  name: string;
  members: ProjectRosterCandidate[];
}

interface ProjectRosterSection {
  source: ProjectRosterSource;
  labelKo: string;
  labelEn: string;
  firms: ProjectRosterFirm[];
  standalone: ProjectRosterCandidate[];
}

function projectPoolMemberKey(member: ProjectAgentPoolMember): string {
  return `${member.source}:${member.agentId}:${member.releaseId ?? ""}`;
}

function installedRosterSource(agent: InstalledAgent): ProjectRosterSource {
  if (agent.assetSource === "agent-cloud") return "cloud";
  if (agent.assetSource === "hub") return "hub";
  return "local";
}

function installedProjectCandidate(agent: InstalledAgent, locale: Locale): ProjectRosterCandidate {
  const localized = pickLocalized(agent, locale);
  const member: ProjectAgentPoolMember = {
    agentId: agent.id,
    source: "local",
    releaseId: null,
    nameSnapshot: localized.name,
  };
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source: installedRosterSource(agent),
    kind: agent.kind === "team" ? "team" : "agent",
    installed: true,
  };
}

function remoteProjectCandidate(
  listing: MarketplaceListing,
  source: "cloud" | "hub",
  locale: Locale,
): ProjectRosterCandidate {
  const localized = pickLocalized(listing, locale);
  const member: ProjectAgentPoolMember = {
    agentId: listing.slug,
    source,
    releaseId: listing.agentReleaseId ?? listing.cloudRegistration?.revision ?? listing.packageHash ?? null,
    nameSnapshot: localized.name,
  };
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: listing.entityKind === "team" ? "team" : "agent",
    installed: false,
  };
}

function buildProjectRosterSections(
  agents: InstalledAgent[],
  firms: InstalledFirm[],
  cloudListings: MarketplaceListing[],
  hubBookmarks: HubAgentBookmark[],
  locale: Locale,
): ProjectRosterSection[] {
  const roster = buildAgentRoster(agents, firms);
  const installedSlugs = new Set(agents.map((agent) => agent.slug));
  const visibleRemoteListing = (listing: MarketplaceListing) => (
    listing.visibility !== "background" && listing.visibility !== "private"
  );
  const sections: ProjectRosterSection[] = [
    { source: "local", labelKo: "로컬", labelEn: "Local", firms: [], standalone: [] },
    { source: "cloud", labelKo: "내 에이전트", labelEn: "My agents", firms: [], standalone: [] },
    { source: "hub", labelKo: "Hub", labelEn: "Hub", firms: [], standalone: [] },
  ];
  const sectionBySource = new Map(sections.map((section) => [section.source, section]));

  for (const firm of firms) {
    const members = firm.orgChart.flatMap((node) => {
      const agent = roster.agentById.get(node.agentId);
      return agent ? [installedProjectCandidate(agent, locale)] : [];
    });
    if (members.length === 0) continue;
    const ceo = roster.agentById.get(firm.ceoAgentId);
    const source = ceo ? installedRosterSource(ceo) : members[0].source;
    sectionBySource.get(source)?.firms.push({
      id: firm.id,
      name: pickLocalized(firm, locale).name,
      members,
    });
  }

  for (const agent of visibleRosterAgents(roster.standaloneAgents)) {
    const candidate = installedProjectCandidate(agent, locale);
    sectionBySource.get(candidate.source)?.standalone.push(candidate);
  }

  for (const listing of cloudListings) {
    if (installedSlugs.has(listing.slug) || !visibleRemoteListing(listing)) continue;
    sectionBySource.get("cloud")?.standalone.push(remoteProjectCandidate(listing, "cloud", locale));
  }
  for (const bookmark of hubBookmarksWithoutLocalDuplicates(hubBookmarks, agents)) {
    if (!visibleRemoteListing(bookmark.listing)) continue;
    sectionBySource.get("hub")?.standalone.push(remoteProjectCandidate(bookmark.listing, "hub", locale));
  }

  for (const section of sections) {
    section.firms.sort((left, right) => left.name.localeCompare(right.name, locale));
    section.standalone.sort((left, right) => left.name.localeCompare(right.name, locale));
  }
  return sections;
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
}: {
  locale: string;
  members: ProjectAgentPoolMember[];
  editing: boolean;
  open: boolean;
  draggedMemberId: string | null;
  onToggle: () => void;
  onMove: (agentId: string, targetIndex: number) => void;
  onRemove: (agentId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, agentId: string) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
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
            ? "오른쪽 조직도에서 책임자를 먼저 추가한 뒤 구성원을 배치하세요."
            : "Add a controller from the roster, then arrange the remaining members."}
        </div>
      </div>
    );
  }

  const renderNode = (member: ProjectAgentPoolMember, index: number, child: boolean) => (
    <div
      className={`project-team-node ${index === 0 ? "project-team-node-controller" : "project-team-child"}`}
      data-project-member-index={index}
      data-dragging={draggedMemberId === member.agentId}
      key={projectPoolMemberKey(member)}
      draggable={false}
      onPointerDown={(event) => { if (editing) onPointerDown(event, member.agentId); }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDragOver={(event) => { if (editing) event.preventDefault(); }}
      onDrop={(event) => {
        event.preventDefault();
        onMove(event.dataTransfer.getData("application/x-agentlas-project-member"), index);
      }}
    >
      {index === 0 && members.length > 1 ? (
        <button
          type="button"
          className="project-team-chevron"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={locale === "ko" ? "구성원 접기 또는 펼치기" : "Collapse or expand members"}
        >
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </button>
      ) : <span />}
      <span className="project-team-avatar"><IconUsers size={14} /></span>
      <span className="project-team-node-copy">
        <strong>{member.nameSnapshot}</strong>
        <span>{index === 0
          ? (locale === "ko" ? "책임자 · 프로젝트 컨트롤러" : "Controller · project owner")
          : (locale === "ko" ? `${index}순위 구성원` : `Member priority ${index}`)}</span>
      </span>
      {editing ? (
        <span className="project-team-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" disabled={index === 0} aria-label={locale === "ko" ? "위로 이동" : "Move up"} onClick={() => onMove(member.agentId, index - 1)}>↑</button>
          <button type="button" disabled={index === members.length - 1} aria-label={locale === "ko" ? "아래로 이동" : "Move down"} onClick={() => onMove(member.agentId, index + 1)}>↓</button>
          <button type="button" aria-label={locale === "ko" ? `${member.nameSnapshot} 제거` : `Remove ${member.nameSnapshot}`} onClick={() => onRemove(member.agentId)}>×</button>
        </span>
      ) : <span className="project-roster-kind">{child ? member.source : (locale === "ko" ? "책임자" : "controller")}</span>}
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
      {renderNode(members[0], 0, false)}
      {open && members.length > 1 ? (
        <div className="project-team-children">
          {members.slice(1).map((member, offset) => renderNode(member, offset + 1, true))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectAgentRosterLibrary({
  locale,
  sections,
  selectedMemberKeys,
  hasController,
  openSources,
  openFirms,
  draggedCandidateKey,
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
  hasController: boolean;
  openSources: Record<ProjectRosterSource, boolean>;
  openFirms: Record<string, boolean>;
  draggedCandidateKey: string | null;
  onToggleSource: (source: ProjectRosterSource) => void;
  onToggleFirm: (firmId: string) => void;
  onAddCandidate: (candidate: ProjectRosterCandidate) => void;
  onAddFirm: (candidates: ProjectRosterCandidate[]) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, candidateKey: string) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}) {
  const renderCandidate = (candidate: ProjectRosterCandidate) => {
    const selected = selectedMemberKeys.has(candidate.key);
    const requiresController = !candidate.installed && !hasController;
    const disabled = selected || requiresController;
    const helper = selected
      ? (locale === "ko" ? "프로젝트에 추가됨" : "Added to project")
      : requiresController
        ? (locale === "ko" ? "설치된 책임자를 먼저 선택하세요" : "Choose an installed controller first")
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

  return (
    <aside className="project-agent-library-tree" aria-label={locale === "ko" ? "전체 에이전트 조직도" : "All agents organization tree"}>
      <div className="project-roster-head">
        <span>{locale === "ko" ? "전체 에이전트" : "All agents"}</span>
        <span>{sections.reduce((sum, section) => sum + section.standalone.length + section.firms.reduce((firmSum, firm) => firmSum + firm.members.length, 0), 0)}</span>
      </div>
      {sections.map((section) => {
        const count = section.standalone.length + section.firms.reduce((sum, firm) => sum + firm.members.length, 0);
        const open = openSources[section.source];
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
                  const firmOpen = openFirms[firm.id] ?? false;
                  const addable = firm.members.filter((member) => !selectedMemberKeys.has(member.key));
                  return (
                    <div key={firm.id}>
                      <div className="project-roster-firm-row">
                        <button type="button" className="project-team-chevron" onClick={() => onToggleFirm(firm.id)} aria-expanded={firmOpen}>
                          {firmOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                        </button>
                        <IconBuilding size={12} />
                        <span>{firm.name}</span>
                        <span className="project-roster-count">{firm.members.length}</span>
                        <button
                          type="button"
                          className="project-roster-add-team"
                          disabled={addable.length === 0}
                          onClick={() => onAddFirm(addable)}
                        >
                          {locale === "ko" ? "팀 추가" : "Add team"}
                        </button>
                      </div>
                      {firmOpen ? <div className="project-roster-children">{firm.members.map(renderCandidate)}</div> : null}
                    </div>
                  );
                })}
                {section.standalone.length > 0 ? (
                  <div className="project-roster-standalone">{section.standalone.map(renderCandidate)}</div>
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
        recoveryPending ? <div data-one-content-slot data-capability="project-timeline-recovery" /> : null
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
