"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { navigate } from "@/lib/navigation";
import { requestNewChat } from "@/lib/new-chat-request";
import { listCopy } from "@/lib/workspace-list-copy";
import { useT } from "@/lib/i18n";
import { IconHome, IconPlus, IconSidebar } from "./Icon";
import { HomeTree } from "./HomeTree";
import { WorkspaceRulesRow } from "./workspace-rules/WorkspaceRulesRow";
import { NewChatHost } from "./NewChatHost";
import { PersonalAgentRow } from "./PersonalAgentRow";
import { AccountChip } from "./AccountChip";
import { VersionChip } from "./VersionChip";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { useWorkSidebarWidth } from "@/lib/work-sidebar-width";
import { useSidebarRail } from "@/lib/sidebar-rail";

/**
 * The Work sidebar (decision, F-D3): Dashboard, New chat, PROJECTS (+ = a new project), the list, account + version.
 * The file keeps its name because AppShell and the gates that bundle it import it; the list lives in HomeTree.
 * The top-left slot (where v1.3.139 had the "Agentlas Work" box) holds the personal agent row (F-D1), the same row SideNav draws.
 */
export function ProjectSidebar() {
  const { locale, t } = useT();
  const ko = locale === "ko";
  const params = useSearchParams();
  const pathname = usePathname() ?? "";
  // A narrow window keeps a rail with the way back (Dashboard) instead of hiding the panel (sidebar-rail.ts).
  const rail = useSidebarRail(`${pathname}?${params.toString()}`);
  const sidebar = useWorkSidebarWidth();
  const dashboardLabel = ko ? "대시보드" : "Dashboard";
  const newChatLabel = listCopy(ko ? "ko" : "en").newChat;
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
  // New chat: the start screen, outside every project (a chat in a project is the "+" on that project's row). A new project is the "+" on PROJECTS.
  const newChat = (
    <button type="button" className="project-sidebar-new" data-new-chat="top" onClick={() => requestNewChat({ projectId: null })}
      aria-label={rail.collapsed ? newChatLabel : undefined} title={rail.collapsed ? newChatLabel : undefined}>
      <IconPlus size={15} />{rail.collapsed ? null : newChatLabel}
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
        <div className="project-sidebar-head titlebar-nodrag"><PersonalAgentRow compact />{toggle}</div>
        {dashboard}
        {newChat}
        <NewChatHost locale={ko ? "ko" : "en"} />
      </aside>
    );
  }

  const resizable = !rail.compactViewport;
  return (
    <aside className="project-sidebar glass-thin" {...railState} data-sidebar-resizing={sidebar.resizing ? "true" : "false"}
      data-tour-id="workspace.sidebar"
      aria-label={ko ? "작업 사이드바" : "Work sidebar"}
      style={resizable ? { position: "relative", width: sidebar.width, flexBasis: sidebar.width } : undefined}>
      <div className="project-sidebar-drag titlebar-drag" />
      <div className="project-sidebar-head titlebar-nodrag"><PersonalAgentRow />{toggle}</div>
      {dashboard}
      {newChat}
      <NewChatHost locale={ko ? "ko" : "en"} />
      <HomeTree locale={ko ? "ko" : "en"} />
      <WorkspaceRulesRow />
      <div className="project-sidebar-foot"><AccountChip /><VersionChip /></div>
      {resizable ? <SidebarResizeHandle sidebar={sidebar} /> : null}
    </aside>
  );
}
