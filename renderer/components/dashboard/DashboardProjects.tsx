"use client";

import { useEffect, useMemo, useState } from "react";
import { taskTitleForDisplay } from "@/lib/task-title";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { isUserFacingProjectPoolMember } from "@/lib/project-agent-roster";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
import type { CanonicalTask, InstalledAgent, Project } from "@/lib/types";

const DASHBOARD_DATA_MAX_AGE_MS = 15_000;

export function DashboardProjects() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [projects, setProjects] = useState<Project[]>(() => readViewData<Project[]>("dashboard.projects")?.value ?? []);
  const [tasks, setTasks] = useState<CanonicalTask[]>(() => readViewData<CanonicalTask[]>("dashboard.tasks.200")?.value ?? []);
  const [agents, setAgents] = useState<InstalledAgent[]>(() => readViewData<InstalledAgent[]>("dashboard.team")?.value ?? []);
  /*
   * ★못 읽었는데 화면은 "첫 프로젝트를 연결하세요" 를 그렸다 (실측 2026-09-08).
   *   프로젝트가 있는 사람에게 그건 거짓말이다 — 읽기 실패를 "없음" 으로 만들지 않는다.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let alive = true;
    void Promise.all([
      loadViewData("dashboard.projects", () => api.projects.list(), { maxAgeMs: DASHBOARD_DATA_MAX_AGE_MS }),
      loadViewData("dashboard.tasks.200", () => api.tasks.list({ limit: 200, reconcile: false }), { maxAgeMs: DASHBOARD_DATA_MAX_AGE_MS }),
      loadViewData("dashboard.team", () => api.team.list(), { maxAgeMs: DASHBOARD_DATA_MAX_AGE_MS }),
    ]).then(([nextProjects, nextTasks, nextAgents]) => {
      if (!alive) return;
      setProjects(nextProjects);
      setTasks(nextTasks);
      setAgents(nextAgents);
      setLoadFailed(false);
    }).catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, []);
  const taskMap = useMemo(() => new Map(projects.map((project) => [project.id, tasks.filter((task) => task.projectId === project.id)])), [projects, tasks]);
  return <section className="dashboard-projects dashboard-panel">
    <header><div><span>{ko ? "프로젝트" : "Projects"}</span><strong>{ko ? "진행 중인 일" : "Work in progress"}</strong></div><button type="button" onClick={() => navigate("/workspace")}>{ko ? "전체 보기" : "View all"}</button></header>
    <div>{projects.slice(0, 4).map((project) => {
      const rows = taskMap.get(project.id) ?? [];
      const active = rows.filter((task) => ["open", "running", "waiting-decision", "partial"].includes(task.status));
      const latest = rows[0];
      const agentCount = Array.isArray(project.agentPool)
        ? project.agentPool.filter((member) => isUserFacingProjectPoolMember(member, agents)).length
        : 0;
      return <button type="button" key={project.id} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><span data-active={active.length > 0 ? "true" : "false"} /><div><strong>{project.name}</strong><small>{latest ? taskTitleForDisplay(latest.title, ko) : (ko ? "아직 작업 없음" : "No tasks yet")}</small></div><em>{active.length > 0 ? (ko ? `미완료 ${active.length}개` : `${active.length} unfinished`) : `${agentCount}${ko ? "명" : ` agent${agentCount === 1 ? "" : "s"}`}`}</em></button>;
    })}</div>
    {loadFailed
      ? <p role="alert" className="dashboard-projects-empty">{ko
        ? "프로젝트를 불러오지 못했습니다. 지워진 것이 아니라 읽지 못한 것입니다."
        : "Projects could not be loaded. Nothing was deleted — the read failed."}</p>
      : projects.length === 0 ? <button type="button" className="dashboard-projects-empty" onClick={() => navigate("/project/new")}>{ko ? "첫 프로젝트를 연결하세요" : "Connect your first project"}</button> : null}
  </section>;
}
