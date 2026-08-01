"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import type { CanonicalTask, Project } from "@/lib/types";
import { IconFolder, IconHome, IconPlus } from "./Icon";
import { ProductModeMenu } from "./one/ProductModeMenu";
import { AccountChip } from "./AccountChip";
import { VersionChip } from "./VersionChip";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";

export function ProjectSidebar() {
  const { locale } = useT();
  const ko = locale === "ko";
  const params = useSearchParams();
  const currentId = params.get("projectId") ?? params.get("id");
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<CanonicalTask[]>([]);

  useEffect(() => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("project-sidebar-load", new Error("Desktop bridge unavailable"));
      return;
    }
    let cancelled = false;
    const load = () => void Promise.all([api.projects.list(), api.tasks.list({ limit: 200 })]).then(([items, taskRows]) => {
      if (!cancelled) { setProjects(items); setTasks(taskRows); }
    }).catch(() => {
      // Preserve the last good navigation list while One inspects the failure.
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
        {projects.map((project) => <div className="project-sidebar-project" key={project.id}>
          <button type="button" data-active={currentId === project.id} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><IconFolder size={15} /><span>{project.name}</span></button>
          {tasks.filter((task) => task.projectId === project.id && task.originChatId).slice(0, 6).map((task) => <button type="button" className="project-sidebar-task" key={task.id} onClick={() => navigate(`/workspace/task?id=${encodeURIComponent(task.originChatId ?? "")}&task=${encodeURIComponent(task.id)}&projectId=${encodeURIComponent(project.id)}`)}><span>{task.title || (ko ? "새 작업" : "New task")}</span></button>)}
        </div>)}
        {projects.length === 0 ? <button type="button" className="project-sidebar-empty" onClick={() => navigate("/project/new")}>{ko ? "첫 프로젝트를 연결하세요" : "Connect your first project"}</button> : null}
      </nav>
      <div className="project-sidebar-foot"><AccountChip /><VersionChip /></div>
    </aside>
  );
}
