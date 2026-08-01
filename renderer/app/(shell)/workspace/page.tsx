"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import type { Project } from "@/lib/types";

export default function WorkspacePage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => { void ipc()?.projects.list().then(setProjects).catch(() => setProjects([])); }, []);
  return <div className="workspace-portfolio rd">
    <header className="workspace-portfolio-head titlebar-drag"><div><span>Agentlas Work</span><h1>{ko ? "프로젝트" : "Projects"}</h1><p>{ko ? "소스, 지시, 에이전트와 작업 경험이 프로젝트 안에서 이어집니다." : "Source, instructions, agents, and work history stay together."}</p></div><button className="titlebar-nodrag" type="button" onClick={() => navigate("/project/new")}>{ko ? "새 프로젝트" : "New project"}</button></header>
    <main className="workspace-project-grid titlebar-nodrag">
      {projects.map((project) => <button type="button" className="workspace-project-card" key={project.id} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><span>{project.sourceType === "github" ? "GitHub" : project.sourceType === "sample" ? (ko ? "샘플" : "Sample") : (ko ? "로컬" : "Local")}</span><h2>{project.name}</h2><p>{ko ? `${project.agentPool.length}명의 에이전트` : `${project.agentPool.length} ${project.agentPool.length === 1 ? "agent" : "agents"}`}</p><small>{new Date(project.updatedAt).toLocaleDateString(ko ? "ko-KR" : "en-US")}</small></button>)}
      <button type="button" className="workspace-project-card workspace-project-add" onClick={() => navigate("/project/new")}><strong>＋</strong><h2>{ko ? "프로젝트 연결" : "Connect a project"}</h2></button>
    </main>
  </div>;
}
