"use client";
import { useAppUiPreference } from "@/lib/app-ui-preferences";

import { useEffect, useState } from "react";
import { taskTitleForDisplay } from "@/lib/task-title";
import { isVisibleWorkTask, workTaskHref } from "@/lib/work-task-navigation";
import { usePathname, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { createStoreChangeThrottle } from "@/lib/store-change-policy";
import { navigate } from "@/lib/navigation";
import { openProjectSettings } from "@/lib/project-settings";
import { useT } from "@/lib/i18n";
import { invalidateViewDataForStoreChange, loadViewData, readViewData } from "@/lib/view-data-cache";
import type { CanonicalTask, Project } from "@/lib/types";
import { IconChevronDown, IconChevronRight, IconFolder, IconHome, IconPlus, IconSettings, IconSidebar } from "./Icon";
import { AttentionDot } from "./AttentionDot";
import { useChatAttention } from "@/lib/attention";
import { ProductModeMenu } from "./one/ProductModeMenu";
import { AccountChip } from "./AccountChip";
import { VersionChip } from "./VersionChip";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { useWorkSidebarWidth } from "@/lib/work-sidebar-width";
import { useSidebarRail } from "@/lib/sidebar-rail";

export function ProjectSidebar() {
  const { locale, t } = useT();
  const ko = locale === "ko";
  const params = useSearchParams();
  const pathname = usePathname() ?? "";
  const currentId = params.get("projectId") ?? params.get("id");
  // A narrow window keeps a rail with the way back (Dashboard) instead of hiding the panel (sidebar-rail.ts).
  const rail = useSidebarRail(`${pathname}?${params.toString()}`);
  const [projects, setProjects] = useState<Project[]>(() => readViewData<Project[]>("dashboard.projects")?.value ?? []);
  const [tasks, setTasks] = useState<CanonicalTask[]>(() => readViewData<CanonicalTask[]>("dashboard.tasks.200")?.value ?? []);
  const [loadFailed, setLoadFailed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useAppUiPreference("projectCollapsed");
  const sidebar = useWorkSidebarWidth();
  const unassignedTasks = tasks.filter((task) => !task.projectId && isVisibleWorkTask(task));

  function toggleProjectChats(projectId: string) {
    setCollapsedProjects((current) => ({ ...current, [projectId]: !current[projectId] }));
  }

  useEffect(() => {
    const api = ipc();
    if (!api) {
      setLoadFailed(true);
      return;
    }
    let cancelled = false;
    let generation = 0;
    const reader = createCoalescedRefresh<boolean>(async (force) => {
      const ticket = generation;
      try {
        const [items, taskRows] = await Promise.all([
          loadViewData("dashboard.projects", () => api.projects.list(), { maxAgeMs: 10_000, force }),
          loadViewData("dashboard.tasks.200", () => api.tasks.list({ limit: 200, reconcile: false }), { maxAgeMs: 5_000, force }),
        ]);
        if (!cancelled && ticket === generation) { setProjects(items); setTasks(taskRows); setLoadFailed(false); }
      } catch {
        if (!cancelled && ticket === generation) setLoadFailed(true);
      }
    }, (previous, incoming) => previous || incoming);
    const changes = createStoreChangeThrottle({ immediate: () => false, throttleMs: 500,
      run: () => { void reader.request(true); } });
    const onStoreChanged = (change: { entity: string }) => {
      if (!["task", "chat", "project"].includes(change.entity)) return;
      // Invalidate before requesting a read even on an older event bridge.
      // A notice during a pending read must not repaint its obsolete rows.
      ++generation;
      invalidateViewDataForStoreChange(change);
      changes.notify(change);
    };
    const off = ipcEvents()?.onStoreChanged?.(onStoreChanged);
    void reader.request(false);
    const onChanged = () => onStoreChanged({ entity: "project" });
    window.addEventListener("agentlas:projects-changed", onChanged);
    window.addEventListener("agentlas:tasks-changed", onChanged);
    return () => {
      cancelled = true;
      changes.dispose();
      reader.dispose();
      off?.();
      window.removeEventListener("agentlas:projects-changed", onChanged);
      window.removeEventListener("agentlas:tasks-changed", onChanged);
    };
  }, []);

  const dashboardLabel = ko ? "대시보드" : "Dashboard";
  const newProjectLabel = ko ? "새 프로젝트" : "New project";
  const toggle = (
    <button
      type="button"
      className="project-sidebar-toggle"
      onClick={rail.toggle}
      aria-label={rail.collapsed ? t("nav.expand_sidebar") : t("nav.collapse_sidebar")}
      aria-expanded={!rail.collapsed}
      title={rail.collapsed ? t("nav.expand") : t("nav.collapse")}
    >
      <IconSidebar size={16} />
    </button>
  );
  const dashboard = (
    <button
      type="button"
      className="project-sidebar-dashboard"
      data-work-dashboard-return="sidebar"
      onClick={() => { rail.closeOverlay(); navigate("/dashboard"); }}
      aria-label={ko ? "대시보드로 돌아가기" : "Back to Dashboard"}
      title={rail.collapsed ? dashboardLabel : undefined}
    >
      <IconHome size={15} />{rail.collapsed ? null : dashboardLabel}
    </button>
  );
  const newProject = (
    <button type="button" className="project-sidebar-new" onClick={() => openProjectSettings()}
      aria-label={rail.collapsed ? newProjectLabel : undefined} title={rail.collapsed ? newProjectLabel : undefined}>
      <IconPlus size={15} />{rail.collapsed ? null : newProjectLabel}
    </button>
  );
  const railState = {
    "data-collapsed": rail.collapsed ? "true" : "false",
    "data-compact": rail.compactViewport ? "true" : "false",
    "data-compact-open": rail.overlayOpen ? "true" : "false",
  } as const;

  if (rail.collapsed) {
    // The rail: always on screen, so the Work room keeps its way back at any window size.
    return (
      <aside className="project-sidebar glass-thin" {...railState} aria-label={ko ? "작업 사이드바" : "Work sidebar"}>
        <div className="project-sidebar-drag titlebar-drag" />
        <div className="project-sidebar-head titlebar-nodrag"><ProductModeMenu current="work" compact />{toggle}</div>
        {dashboard}
        {newProject}
      </aside>
    );
  }

  const resizable = !rail.compactViewport;
  return (
    <aside className="project-sidebar glass-thin" {...railState} data-sidebar-resizing={sidebar.resizing ? "true" : "false"}
      aria-label={ko ? "작업 사이드바" : "Work sidebar"}
      style={resizable ? { position: "relative", width: sidebar.width, flexBasis: sidebar.width } : undefined}>
      <div className="project-sidebar-drag titlebar-drag" />
      <div className="project-sidebar-head titlebar-nodrag"><ProductModeMenu current="work" />{toggle}</div>
      {dashboard}
      {newProject}
      <div className="project-sidebar-label">{ko ? "프로젝트" : "Projects"}</div>
      <nav className="project-sidebar-list" aria-label={ko ? "프로젝트" : "Projects"}>
        {projects.map((project) => {
          const projectTasks = tasks.filter((task) => task.projectId === project.id && task.originChatId).slice(0, 6);
          const chatsCollapsed = collapsedProjects[project.id] ?? false;
          return <div className="project-sidebar-project" key={project.id}>
            <div className="project-sidebar-project-row">
              <button type="button" className="project-sidebar-project-link" data-active={currentId === project.id} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><IconFolder size={15} /><span>{project.name}</span></button>
              <button type="button" className="project-sidebar-collapse" onClick={() => openProjectSettings({ mode: "edit", projectId: project.id })} aria-label={ko ? `${project.name} 설정` : `Settings for ${project.name}`} title={ko ? "프로젝트 설정" : "Project settings"} aria-haspopup="dialog"><IconSettings size={14} /></button>
              {projectTasks.length > 0 ? <button type="button" className="project-sidebar-collapse" onClick={() => toggleProjectChats(project.id)} aria-label={chatsCollapsed ? (ko ? `${project.name}의 채팅 펼치기` : `Expand chats for ${project.name}`) : (ko ? `${project.name}의 채팅 접기` : `Collapse chats for ${project.name}`)} aria-expanded={!chatsCollapsed}>{chatsCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}</button> : null}
            </div>
            {!chatsCollapsed && projectTasks.map((task) => <button type="button" className="project-sidebar-task" key={task.id} data-chat-id={task.originChatId ?? undefined} onClick={() => navigate(workTaskHref(task))}><span>{taskTitleForDisplay(task.title, ko)}</span><ChatRowAttentionDot chatId={task.originChatId} locale={ko ? "ko" : "en"} /></button>)}
          </div>;
        })}
        {unassignedTasks.length > 0 ? <div className="project-sidebar-project" data-unassigned-work="true">
          <div className="project-sidebar-label">{ko ? "프로젝트 없는 작업" : "Work without a project"}</div>
          {unassignedTasks.map((task) => <button type="button" className="project-sidebar-task" key={task.id} data-chat-id={task.originChatId ?? undefined} onClick={() => navigate(workTaskHref(task))}><span>{taskTitleForDisplay(task.title, ko)}</span><ChatRowAttentionDot chatId={task.originChatId} locale={ko ? "ko" : "en"} /></button>)}
        </div> : null}
        {loadFailed ? <div className="project-sidebar-empty" role="alert">{ko ? "프로젝트 목록을 불러오지 못했습니다" : "Projects are temporarily unavailable"}</div> : null}
        {!loadFailed && projects.length === 0 ? <button type="button" className="project-sidebar-empty" onClick={() => openProjectSettings()}>{ko ? "첫 프로젝트를 만들어 보세요" : "Create your first project"}</button> : null}
      </nav>
      <div className="project-sidebar-foot"><AccountChip /><VersionChip /></div>
      {resizable ? <SidebarResizeHandle sidebar={sidebar} /> : null}
    </aside>
  );
}

/** 이 대화가 화면 밖에서 오너를 기다리면(승인·질문·안 본 결과) 행 끝에 파란 점. */
function ChatRowAttentionDot({ chatId, locale }: { chatId: string | null | undefined; locale: "ko" | "en" }) {
  const counts = useChatAttention(chatId);
  return <AttentionDot counts={counts} locale={locale} className="project-sidebar-task-dot" />;
}
