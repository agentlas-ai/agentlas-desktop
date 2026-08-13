"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ipc } from "@/lib/ipc";
import type {
  CanonicalTaskWorkTarget,
  ExternalCliSessionSummary,
  FsPathGrant,
  Project,
} from "@shared/types";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./OneProjectSessionSheet.module.css";

type Props = {
  open: boolean;
  locale: "ko" | "en";
  chatId: string | null;
  workspaceGrant: FsPathGrant | null;
  workspacePath: string | null;
  onClose: () => void;
  onWorkspaceSelected: (grant: FsPathGrant) => void | Promise<void>;
  onImported: (target: CanonicalTaskWorkTarget) => void | Promise<void>;
};

function folderName(value: string | null): string {
  if (!value) return "";
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function sameFolder(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

export function OneProjectSessionSheet({
  open,
  locale,
  chatId,
  workspaceGrant,
  workspacePath,
  onClose,
  onWorkspaceSelected,
  onImported,
}: Props) {
  const api = ipc();
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<ExternalCliSessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = locale === "ko" ? {
    eyebrow: "프로젝트 컨텍스트",
    title: "프로젝트와 이전 세션 가져오기",
    description: "One을 떠나지 않고 작업 폴더를 프로젝트로 연결하고, 같은 폴더에서 진행한 Codex 또는 Claude Code 세션을 이어옵니다.",
    close: "프로젝트와 세션 시트 닫기",
    folder: "작업 폴더",
    chooseFolder: "폴더 선택",
    noFolder: "먼저 프로젝트 폴더를 선택하세요.",
    existingProject: "연결된 프로젝트",
    createProject: "프로젝트 만들기",
    projectName: "프로젝트 이름",
    creating: "프로젝트 만드는 중…",
    sessions: "가져올 수 있는 세션",
    search: "Codex 또는 Claude Code 세션 검색",
    noSessions: "이 폴더에서 가져올 수 있는 세션이 없습니다.",
    import: "One으로 가져오기",
    importing: "가져오는 중…",
    codex: "Codex",
    claude: "Claude Code",
    messages: "개 메시지",
    truncated: "최근 안전 범위만 가져옵니다",
    unavailable: "Desktop 연결을 사용할 수 없습니다.",
    failed: "프로젝트 또는 세션을 불러오지 못했습니다. 다시 시도하세요.",
  } : {
    eyebrow: "PROJECT CONTEXT",
    title: "Bring in a project and prior session",
    description: "Stay in One while connecting a working folder as a project and continuing a Codex or Claude Code session from that same folder.",
    close: "Close project and session sheet",
    folder: "Working folder",
    chooseFolder: "Choose folder",
    noFolder: "Choose the project folder first.",
    existingProject: "Connected project",
    createProject: "Create project",
    projectName: "Project name",
    creating: "Creating project…",
    sessions: "Sessions available to import",
    search: "Search Codex or Claude Code sessions",
    noSessions: "No importable session was found for this folder.",
    import: "Import into One",
    importing: "Importing…",
    codex: "Codex",
    claude: "Claude Code",
    messages: "messages",
    truncated: "Only the latest safe window will be imported",
    unavailable: "The Desktop connection is unavailable.",
    failed: "The project or session could not be loaded. Try again.",
  };

  const matchingProject = useMemo(
    () => projects.find((item) => sameFolder(item.folderPath, workspacePath)) ?? null,
    [projects, workspacePath],
  );
  const canCreateProject = Boolean(workspaceGrant || (chatId && workspacePath));

  const loadProjects = useCallback(async () => {
    if (!open) return;
    if (!api) {
      setError(copy.unavailable);
      return;
    }
    setLoading(true);
    setError(null);
    setProject(null);
    setSessions([]);
    try {
      const next = await api.projects.list();
      setProjects(next);
      const match = next.find((item) => sameFolder(item.folderPath, workspacePath)) ?? null;
      setProject(match);
      setProjectName(match?.name ?? folderName(workspacePath));
    } catch {
      setError(copy.failed);
    } finally {
      setLoading(false);
    }
  }, [api, copy.failed, copy.unavailable, open, workspacePath]);

  const loadSessions = useCallback(async (target: Project | null, search = "") => {
    if (!api || !target) {
      setSessions([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSessions(await api.externalCliSessions.list({ projectId: target.id, query: search, limit: 80 }));
    } catch {
      setError(copy.failed);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [api, copy.failed]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSessions([]);
    void loadProjects();
  }, [loadProjects, open]);

  useEffect(() => {
    if (!open || !project) return;
    const timer = window.setTimeout(() => void loadSessions(project, query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [loadSessions, open, project, query]);

  const chooseFolder = async () => {
    if (!api) {
      setError(copy.unavailable);
      return;
    }
    const grant = await api.fs.pickDirectory().catch(() => null);
    if (!grant?.path) return;
    await onWorkspaceSelected(grant);
  };

  const createProject = async () => {
    if (!api || !canCreateProject || !projectName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = workspaceGrant
        ? await api.projects.create({
          name: projectName.trim(),
          sourceType: "local",
          sourceRef: null,
          folderGrant: workspaceGrant,
          agentPool: [],
        })
        : await api.projects.createFromWorkspace({
          chatId: chatId as string,
          name: projectName.trim(),
          agentPool: [],
        });
      setProjects((current) => [...current.filter((item) => item.id !== created.id), created]);
      setProject(created);
      await loadSessions(created);
      window.dispatchEvent(new Event("agentlas:projects-changed"));
    } catch {
      setError(copy.failed);
    } finally {
      setCreating(false);
    }
  };

  const importSession = async (session: ExternalCliSessionSummary) => {
    if (!api || !project || importing) return;
    setImporting(session.sourceKey);
    setError(null);
    try {
      const target = await api.externalCliSessions.importToProject({
        projectId: project.id,
        sourceKey: session.sourceKey,
        originSurface: "one",
      });
      window.dispatchEvent(new Event("agentlas:tasks-changed"));
      await onImported(target);
      onClose();
    } catch {
      setError(copy.failed);
    } finally {
      setImporting(null);
    }
  };

  return (
    <OneBottomSheet
      open={open}
      onClose={onClose}
      closeLabel={copy.close}
      ariaLabelledBy="one-project-session-title"
      size="wide"
      closeDisabled={creating || Boolean(importing)}
      closeOnBackdrop={!creating && !importing}
      closeOnEscape={!creating && !importing}
      eyebrow={copy.eyebrow}
      title={copy.title}
      titleId="one-project-session-title"
      description={copy.description}
    >
      <div className={styles.content}>
        {error && <p className={styles.error} role="alert">{error}</p>}

        <section className={styles.section} aria-labelledby="one-project-folder-title">
          <div className={styles.sectionHeading}>
            <div>
              <h3 id="one-project-folder-title">{copy.folder}</h3>
              <p>{workspacePath ? folderName(workspacePath) : copy.noFolder}</p>
            </div>
            <button type="button" className={styles.secondaryButton} onClick={() => void chooseFolder()} disabled={creating || Boolean(importing)}>
              {copy.chooseFolder}
            </button>
          </div>
        </section>

        {workspacePath && !loading && !matchingProject && !project && (
          <section className={styles.section} aria-labelledby="one-project-create-title">
            <h3 id="one-project-create-title">{copy.createProject}</h3>
            <label className={styles.field}>
              <span>{copy.projectName}</span>
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={120} />
            </label>
            <button type="button" className={styles.primaryButton} disabled={!canCreateProject || !projectName.trim() || creating} onClick={() => void createProject()}>
              {creating ? copy.creating : copy.createProject}
            </button>
          </section>
        )}

        {project && (
          <section className={styles.section} aria-labelledby="one-project-session-list-title">
            <div className={styles.projectReceipt}>
              <span>{copy.existingProject}</span>
              <strong>{project.name}</strong>
            </div>
            <div className={styles.sessionHeading}>
              <h3 id="one-project-session-list-title">{copy.sessions}</h3>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={copy.search}
                aria-label={copy.search}
              />
            </div>
            <div className={styles.sessionList} aria-busy={loading ? "true" : "false"}>
              {!loading && sessions.length === 0 && <p className={styles.empty}>{copy.noSessions}</p>}
              {sessions.map((session) => (
                <article key={session.sourceKey} className={styles.sessionCard}>
                  <div>
                    <span>{session.provider === "codex" ? copy.codex : copy.claude}</span>
                    <strong>{session.title}</strong>
                    <p>{session.preview}</p>
                    <small>{locale === "ko" ? `${session.messageCount}${copy.messages}` : `${session.messageCount} ${copy.messages}`}{session.truncated ? ` · ${copy.truncated}` : ""}</small>
                  </div>
                  <button type="button" className={styles.primaryButton} disabled={Boolean(importing)} onClick={() => void importSession(session)}>
                    {importing === session.sourceKey ? copy.importing : copy.import}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </OneBottomSheet>
  );
}
