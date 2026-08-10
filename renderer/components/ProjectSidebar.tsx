"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import type { CanonicalTask, Project } from "@/lib/types";
import { IconChevronDown, IconChevronRight, IconFolder, IconHome, IconPlus } from "./Icon";
import { ProductModeMenu } from "./one/ProductModeMenu";
import { AccountChip } from "./AccountChip";
import { VersionChip } from "./VersionChip";

export function ProjectSidebar() {
  const { locale } = useT();
  const ko = locale === "ko";
  const params = useSearchParams();
  const currentId = params.get("projectId") ?? params.get("id");
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<CanonicalTask[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("agentlas.project-sidebar.collapsed.v1");
      if (saved) setCollapsedProjects(JSON.parse(saved) as Record<string, boolean>);
    } catch {
      // Project navigation remains usable if local preferences cannot be restored.
    }
  }, []);

  function toggleProjectChats(projectId: string) {
    setCollapsedProjects((current) => {
      const next = { ...current, [projectId]: !current[projectId] };
      try { window.localStorage.setItem("agentlas.project-sidebar.collapsed.v1", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  useEffect(() => {
    const api = ipc();
    if (!api) {
      setLoadFailed(true);
      return;
    }
    let cancelled = false;
    const load = () => void Promise.all([api.projects.list(), api.tasks.list({ limit: 200, reconcile: false })]).then(([items, taskRows]) => {
      if (!cancelled) { setProjects(items); setTasks(taskRows); setLoadFailed(false); }
    }).catch(() => {
      if (!cancelled) setLoadFailed(true);
    });
    load();
    const onChanged = () => load();
    window.addEventListener("agentlas:projects-changed", onChanged);
    window.addEventListener("agentlas:tasks-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("agentlas:projects-changed", onChanged);
      window.removeEventListener("agentlas:tasks-changed", onChanged);
    };
  }, []);

  return (
    <aside className="project-sidebar glass-thin">
      <div className="project-sidebar-drag titlebar-drag" />
      <div className="project-sidebar-head titlebar-nodrag"><ProductModeMenu current="work" /></div>
      <button
        type="button"
        className="project-sidebar-dashboard"
        data-work-dashboard-return="sidebar"
        onClick={() => navigate("/dashboard")}
        aria-label={ko ? "대시보드로 돌아가기" : "Back to Dashboard"}
      >
        <IconHome size={15} />{ko ? "대시보드" : "Dashboard"}
      </button>
      <button type="button" className="project-sidebar-new" onClick={() => navigate("/project/new")}>
        <IconPlus size={15} />{ko ? "새 프로젝트" : "New project"}
      </button>
      <div className="project-sidebar-label">{ko ? "프로젝트" : "Projects"}</div>
      <nav className="project-sidebar-list" aria-label={ko ? "프로젝트" : "Projects"}>
        {projects.map((project) => {
          const projectTasks = tasks.filter((task) => task.projectId === project.id && task.originChatId).slice(0, 6);
          const chatsCollapsed = collapsedProjects[project.id] ?? false;
          return <div className="project-sidebar-project" key={project.id}>
            <div className="project-sidebar-project-row">
              <button type="button" className="project-sidebar-project-link" data-active={currentId === project.id} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><IconFolder size={15} /><span>{project.name}</span></button>
              {projectTasks.length > 0 ? <button type="button" className="project-sidebar-collapse" onClick={() => toggleProjectChats(project.id)} aria-label={chatsCollapsed ? (ko ? `${project.name}의 채팅 펼치기` : `Expand chats for ${project.name}`) : (ko ? `${project.name}의 채팅 접기` : `Collapse chats for ${project.name}`)} aria-expanded={!chatsCollapsed}>{chatsCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}</button> : null}
            </div>
            {!chatsCollapsed && projectTasks.map((task) => <button type="button" className="project-sidebar-task" key={task.id} onClick={() => navigate(`/workspace/task?id=${encodeURIComponent(task.originChatId ?? "")}&task=${encodeURIComponent(task.id)}&projectId=${encodeURIComponent(project.id)}`)}><span>{task.title || (ko ? "새 작업" : "New task")}</span></button>)}
          </div>;
        })}
        {loadFailed ? <div className="project-sidebar-empty" role="alert">{ko ? "프로젝트 목록을 불러오지 못했습니다" : "Projects are temporarily unavailable"}</div> : null}
        {!loadFailed && projects.length === 0 ? <button type="button" className="project-sidebar-empty" onClick={() => navigate("/project/new")}>{ko ? "첫 프로젝트를 연결하세요" : "Connect your first project"}</button> : null}
      </nav>
      <div className="project-sidebar-foot"><AccountChip /><VersionChip /></div>
    </aside>
  );
}
