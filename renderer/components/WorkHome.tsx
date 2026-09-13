"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { openProjectSettings } from "@/lib/project-settings";
import { useT } from "@/lib/i18n";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
import type { Project } from "@/lib/types";
import { IconFolder, IconSettings, IconChevronRight } from "./Icon";
import { ProjectSourceChoices } from "./ProjectSettingsModal";
import styles from "./WorkHome.module.css";

export function WorkHome() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [projects, setProjects] = useState<Project[]>(() => readViewData<Project[]>("dashboard.projects")?.value ?? []);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = async (force = false) => {
      setLoading(true);
      try {
        const api = ipc();
        if (!api) throw new Error("bridge unavailable");
        const rows = await loadViewData("dashboard.projects", () => api.projects.list(), { maxAgeMs: 10_000, force });
        if (!cancelled) { setProjects(rows); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
      finally { if (!cancelled) setLoading(false); }
    };
    void load(attempt > 0);
    const onChanged = () => { void load(true); };
    window.addEventListener("agentlas:projects-changed", onChanged);
    return () => { cancelled = true; window.removeEventListener("agentlas:projects-changed", onChanged); };
  }, [attempt]);

  return <div className={styles.page}>
    <header className={`${styles.topbar} titlebar-drag`}>Agentlas Work</header>
    <main className={styles.main}>
      <section className={styles.start}>
        <span className={styles.eyebrow}>{ko ? "나의 작업 공간" : "YOUR WORKSPACE"}</span>
        <h1>{ko ? "어디서 시작할까요?" : "Where would you like to start?"}</h1>
        <p>{ko ? "기존 폴더를 연결하거나, 새로운 프로젝트를 만들어 보세요." : "Connect an existing folder or make room for something new."}</p>
        <ProjectSourceChoices onSelect={(sourceType) => openProjectSettings({ mode: "create", sourceType })} />
      </section>
      <section className={styles.recent} aria-labelledby="work-project-list">
        <div className={styles.sectionHeading}><h2 id="work-project-list">{ko ? "프로젝트" : "Projects"}</h2><span>{projects.length}</span></div>
        {failed && <div className={styles.notice} role="alert"><span>{ko ? "프로젝트 목록을 불러오지 못했습니다. 기존 프로젝트는 삭제되지 않았습니다." : "Could not load projects. Your existing projects have not been deleted."}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>{ko ? "다시 시도" : "Retry"}</button></div>}
        {loading && projects.length === 0 ? <p className={styles.empty} role="status">{ko ? "프로젝트를 불러오는 중…" : "Loading projects…"}</p> : !failed && projects.length === 0 ? <p className={styles.empty}>{ko ? "아직 프로젝트가 없어요. 위에서 시작 방법을 골라 주세요." : "No projects yet. Choose a starting point above."}</p> : null}
        <div className={styles.list}>{projects.map((project) => <div className={styles.row} key={project.id}>
          <button type="button" className={styles.projectLink} onClick={() => navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}><span className={styles.folder}><IconFolder size={20} /></span><span><strong>{project.name}</strong><small>{project.sourceType === "github" ? "GitHub" : project.sourceType === "local" ? (ko ? "로컬 폴더" : "Local folder") : (ko ? "Agentlas 폴더" : "Agentlas folder")}</small></span><IconChevronRight size={16} /></button>
          <button type="button" className={styles.settings} onClick={() => openProjectSettings({ mode: "edit", projectId: project.id })} aria-label={ko ? `${project.name} 설정 열기` : `Open settings for ${project.name}`} aria-haspopup="dialog"><IconSettings size={16} /></button>
        </div>)}</div>
      </section>
    </main>
  </div>;
}
