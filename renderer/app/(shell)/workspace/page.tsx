"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { isUserFacingProjectPoolMember } from "@/lib/project-agent-roster";
import type { InstalledAgent, Project } from "@/lib/types";

export default function WorkspacePage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  /*
   * ★못 읽었는데 화면은 프로젝트가 **하나도 없는 것처럼** 그렸다 (읽기 실패 실측
   *   2026-09-08). 지워진 것과 구별되지 않는다. 목록을 비우되 사실을 말한다.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    void Promise.all([
      ipc()?.projects.list() ?? Promise.resolve([]),
      ipc()?.team.list() ?? Promise.resolve([]),
    ]).then(([p, a]) => { setProjects(p); setAgents(a); setLoadFailed(false); })
      .catch(() => { setProjects([]); setAgents([]); setLoadFailed(true); });
  }, []);
  return <div className="workspace-portfolio rd">
    <header className="workspace-portfolio-head titlebar-drag"><div><span>Agentlas Work</span><h1>{ko ? "프로젝트" : "Projects"}</h1><p>{ko ? "소스, 지시, 도구와 작업 경험이 프로젝트 안에서 이어집니다." : "Source, instructions, tools, and work history stay together."}</p></div><button className="titlebar-nodrag" type="button" onClick={() => navigate("/project/new")}>{ko ? "새 프로젝트" : "New project"}</button></header>
    {loadFailed && (
      <p role="alert" className="titlebar-nodrag" style={{ margin: "0 24px 12px", padding: "10px 12px", borderRadius: 10, background: "var(--fill-1)", color: "var(--ink)", fontSize: 12.5, lineHeight: 1.6 }}>
        {ko
          ? "프로젝트를 불러오지 못했습니다. 지워진 것이 아니라 읽지 못한 것입니다 — 잠시 뒤 다시 열어 보세요."
          : "Projects could not be loaded. Nothing was deleted — the read failed. Try again in a moment."}
      </p>
    )}
    <main className="workspace-project-grid titlebar-nodrag">
      {projects.map((project) => {
        const memberCount = project.agentPool.filter((member) => isUserFacingProjectPoolMember(member, agents)).length;
        return <button type="button" className="workspace-project-card" key={project.id} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><span>{project.sourceType === "github" ? "GitHub" : project.sourceType === "sample" ? (ko ? "샘플" : "Sample") : (ko ? "로컬" : "Local")}</span><h2>{project.name}</h2><p>{ko ? `연결된 도구 ${memberCount}` : `${memberCount} project tool${memberCount === 1 ? "" : "s"}`}</p><small>{new Date(project.updatedAt).toLocaleDateString(ko ? "ko-KR" : "en-US")}</small></button>;
      })}
      <button type="button" className="workspace-project-card workspace-project-add" onClick={() => navigate("/project/new")}><strong>＋</strong><h2>{ko ? "프로젝트 연결" : "Connect a project"}</h2></button>
    </main>
  </div>;
}
