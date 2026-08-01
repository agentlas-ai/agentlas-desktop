// 프로젝트 상세 — 프로젝트 문맥, 채팅, PM 메모리 기반 작업 타임라인.
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { IconArrowLeft, IconPlus, IconTrash } from "@/components/Icon";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import type {
  CanonicalTask,
  InstalledAgent,
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
  const [timeline, setTimeline] = useState<ProjectTimelineSnapshot | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [agentPoolDraft, setAgentPoolDraft] = useState<ProjectAgentPoolMember[]>([]);
  const [editingTeam, setEditingTeam] = useState(false);
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
  const [draggedMemberId, setDraggedMemberId] = useState<string | null>(null);
  const pointerDragRef = useRef<{ kind: "agent" | "member"; id: string; startX: number; startY: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [recoveryPending, setRecoveryPending] = useState(false);

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
      const [p, taskRows, ag, timelineResult] = await Promise.all([
        api.projects.get(id),
        api.tasks.list({ limit: 200 }),
        api.team.list(),
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
      setAgents(visibleAgents(ag));
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

  function addAgent(agent: InstalledAgent) {
    setAgentPoolDraft((current) => current.some((member) => member.agentId === agent.id)
      ? current
      : [...current, {
          agentId: agent.id,
          source: "local",
          releaseId: null,
          nameSnapshot: pickLocalized(agent, locale).name,
        }]);
  }

  function dropAgent(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.dataTransfer.getData("application/x-agentlas-project-member")) return;
    const agentId = event.dataTransfer.getData("application/x-agentlas-agent");
    const selected = agents.find((agent) => agent.id === agentId);
    if (selected) addAgent(selected);
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
    } else if (draggedAgentId) {
      const selected = agents.find((agent) => agent.id === draggedAgentId);
      if (selected) addAgent(selected);
    }
    setDraggedAgentId(null);
    setDraggedMemberId(null);
  }

  function beginPointerDrag(event: ReactPointerEvent<HTMLElement>, kind: "agent" | "member", agentId: string) {
    if (!editingTeam) return;
    pointerDragRef.current = { kind, id: agentId, startX: event.clientX, startY: event.clientY };
    if (kind === "agent") setDraggedAgentId(agentId);
    else setDraggedMemberId(agentId);
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
        } else if (drag.kind === "agent") {
          const selected = agents.find((agent) => agent.id === drag.id);
          if (selected) addAgent(selected);
        }
      }
    }
    setDraggedAgentId(null);
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
        } else if (drag.kind === "agent") {
          const selected = agents.find((agent) => agent.id === drag.id);
          if (selected) addAgent(selected);
        }
      }
      setDraggedAgentId(null);
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
  }, [agents, editingTeam, locale]);

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

  const agentById = new Map(visibleAgents(agents).map((agent) => [agent.id, agent]));
  const availableProjectAgents = agents.filter((agent) => !agentPoolDraft.some((member) => member.agentId === agent.id));

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
              <div style={{ ...eyebrowStyle, flex: 1 }}>{locale === "ko" ? "프로젝트 팀 · 위에서부터 우선" : "Project team · priority from the top"}</div>
              {!editingTeam ? (
                <button type="button" onClick={() => setEditingTeam(true)} style={{ color: "var(--accent)", fontSize: 12, fontWeight: 700 }}>
                  {locale === "ko" ? "편집" : "Edit"}
                </button>
              ) : null}
            </div>
            <div className="project-agent-workbench project-agent-workbench-compact">
              <div className="project-agent-pool" data-project-agent-pool data-empty={agentPoolDraft.length === 0} onDragOver={(event) => event.preventDefault()} onDrop={dropAgent}>
                {agentPoolDraft.map((member, index) => (
                  <div
                    className="project-agent-member"
                    data-project-member-index={index}
                    key={`${member.source}:${member.agentId}`}
                    draggable={false}
                    onPointerDown={(event) => beginPointerDrag(event, "member", member.agentId)}
                    onPointerUp={finishPointerDrag}
                    onPointerCancel={() => { pointerDragRef.current = null; setDraggedMemberId(null); }}
                    onDragStart={(event) => {
                      if (!editingTeam) return;
                      event.dataTransfer.setData("application/x-agentlas-project-member", member.agentId);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => { if (editingTeam) event.preventDefault(); }}
                    onDrop={(event) => {
                      event.preventDefault();
                      movePoolMember(event.dataTransfer.getData("application/x-agentlas-project-member"), index);
                    }}
                  >
                    <span className="project-agent-order">{index + 1}</span>
                    <strong>{member.nameSnapshot}</strong>
                    {editingTeam ? <>
                      <button type="button" disabled={index === 0} aria-label={locale === "ko" ? "위로 이동" : "Move up"} onClick={() => movePoolMember(member.agentId, index - 1)}>↑</button>
                      <button type="button" disabled={index === agentPoolDraft.length - 1} aria-label={locale === "ko" ? "아래로 이동" : "Move down"} onClick={() => movePoolMember(member.agentId, index + 1)}>↓</button>
                      <button type="button" onClick={() => setAgentPoolDraft((current) => current.filter((item) => item.agentId !== member.agentId))}>{locale === "ko" ? "제거" : "Remove"}</button>
                    </> : null}
                  </div>
                ))}
              </div>
              {editingTeam ? (
                <aside className="project-agent-library">
                  {availableProjectAgents.map((candidate) => {
                    const localized = pickLocalized(candidate, locale);
                    return <button
                      type="button"
                      draggable={false}
                      className="project-agent-source"
                      key={candidate.id}
                      onPointerDown={(event) => beginPointerDrag(event, "agent", candidate.id)}
                      onMouseDown={(event) => {
                        if (editingTeam && !pointerDragRef.current) pointerDragRef.current = { kind: "agent", id: candidate.id, startX: event.clientX, startY: event.clientY };
                      }}
                      onPointerUp={finishPointerDrag}
                      onPointerCancel={() => { pointerDragRef.current = null; setDraggedAgentId(null); }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/x-agentlas-agent", candidate.id);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => addAgent(candidate)}
                    ><strong>{localized.name}</strong><span>{localized.tagline}</span></button>;
                  })}
                </aside>
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

        <aside className="project-timeline-aside" style={{ minWidth: 0 }}>
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
        </aside>
      </section>

      <style jsx global>{`
        .project-detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(300px, 370px);
          gap: 24px;
          align-items: start;
        }
        .project-timeline-aside {
          position: sticky;
          top: 20px;
          max-height: calc(100vh - 44px);
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
          .project-timeline-aside {
            position: static;
            max-height: none;
            grid-row: 1;
          }
        }
      `}</style>
    </div>
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
