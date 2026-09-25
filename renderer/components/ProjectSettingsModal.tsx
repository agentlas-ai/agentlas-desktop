"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { invalidateViewData } from "@/lib/view-data-cache";
import { projectAgentLimitMessage } from "@/lib/project-agent-roster";
import type { NewProjectSource, ProjectSettingsRequest, ProjectSettingsSection } from "@/lib/project-settings";
import type { FsPathGrant, Project, ProjectAgentPoolMember } from "@/lib/types";
import { IconArrowLeft, IconCheck, IconChevronRight, IconClose, IconFolder, IconGithub, IconPlus, IconUsers } from "./Icon";
import { ProjectAgentPicker } from "./ProjectAgentPicker";
import styles from "./ProjectSettingsModal.module.css";

export function ProjectSourceChoices({ onSelect }: { onSelect: (source: NewProjectSource) => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const choices = [
    { id: "local" as const, icon: <IconFolder size={23} />, title: ko ? "로컬 폴더" : "Local folder", detail: ko ? "내 컴퓨터의 파일로 시작" : "Work with files on your computer" },
    { id: "github" as const, icon: <IconGithub size={23} />, title: "GitHub", detail: ko ? "저장소 주소로 연결" : "Connect a repository URL" },
    { id: "empty" as const, icon: <IconPlus size={23} />, title: ko ? "빈 프로젝트" : "Empty project", detail: ko ? "새 폴더에서 자유롭게 시작" : "Start fresh in a new folder" },
  ];
  return <div className={styles.choices}>
    {choices.map((choice) => <button key={choice.id} type="button" className={styles.choice} onClick={() => onSelect(choice.id)} aria-haspopup="dialog" data-project-source={choice.id}>
      <span className={styles.choiceIcon}>{choice.icon}</span>
      <strong>{choice.title}</strong><span>{choice.detail}</span><IconChevronRight size={16} />
    </button>)}
  </div>;
}

export function ProjectSettingsModal({ request, onClose, onSaved, onBackgroundError }: {
  request: ProjectSettingsRequest;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onBackgroundError?: (message: string) => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const editing = request.mode === "edit";
  const [source, setSource] = useState<NewProjectSource | "sample" | null>(request.mode === "create" ? request.sourceType ?? null : null);
  const [section, setSection] = useState<ProjectSettingsSection>(request.mode === "edit" ? request.section ?? "source" : request.sourceType === "empty" ? "agents" : "source");
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(editing);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [goal, setGoal] = useState("");
  const [agentPool, setAgentPool] = useState<ProjectAgentPoolMember[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [folderGrant, setFolderGrant] = useState<FsPathGrant | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [connectedGithub, setConnectedGithub] = useState("");
  const [pending, setPending] = useState<"folder" | "github" | "save" | null>(null);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const operation = useRef(false);
  const nameEdited = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onBackgroundErrorRef = useRef(onBackgroundError);
  onBackgroundErrorRef.current = onBackgroundError;

  function requestClose() {
    onCloseRef.current();
  }

  function reportFailure(visibleMessage: string, backgroundMessage: string) {
    if (mounted.current) setError(visibleMessage);
    else onBackgroundErrorRef.current?.(backgroundMessage);
  }

  useEffect(() => {
    mounted.current = true;
    const element = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      mounted.current = false;
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (request.mode !== "edit") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const api = ipc();
    void (api ? api.projects.get(request.projectId) : Promise.reject(new Error("bridge unavailable"))).then((saved) => {
      if (cancelled) return;
      if (!saved) throw new Error("project unavailable");
      setProject(saved);
      setSource(saved.sourceType);
      setName(saved.name);
      setInstructions(saved.systemPrompt ?? "");
      setGoal(saved.description ?? "");
      setAgentPool(saved.agentPool ?? []);
      setFolderPath(saved.folderPath ?? "");
      setGithubUrl(saved.sourceType === "github" ? saved.sourceRef ?? "" : "");
      setConnectedGithub(saved.sourceType === "github" ? saved.sourceRef ?? "" : "");
      if (saved.sourceType === "empty" || saved.sourceType === "sample") setSection("agents");
    }).catch(() => {
      if (!cancelled) setError(ko ? "프로젝트를 불러오지 못했습니다. 다시 시도해 주세요." : "Could not load this project. Please try again.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request.mode === "edit" ? request.projectId : null, loadAttempt, ko]);

  const managed = source === "empty" || source === "sample";
  const sourceReady = managed || (source === "local"
    ? Boolean(folderGrant || (project?.sourceType === "local" && project.folderPath))
    : source === "github" && Boolean(folderPath && connectedGithub && connectedGithub === githubUrl.trim()));
  const canSave = Boolean(source && sourceReady && name.trim() && !pending && (!editing || project));

  function selectSource(next: NewProjectSource) {
    setSource(next);
    setSection(next === "empty" ? "agents" : "source");
    setError("");
    setFolderGrant(null);
    setFolderPath("");
    setConnectedGithub("");
  }

  async function chooseFolder() {
    if (operation.current) return;
    operation.current = true;
    setPending("folder"); setError("");
    try {
      const api = ipc();
      if (!api) throw new Error("bridge unavailable");
      const picked = await api.workspace.selectFolder();
      if (!mounted.current || !picked) return;
      setFolderGrant(picked); setFolderPath(picked.path);
      if (!editing && !nameEdited.current) setName(picked.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
    } catch {
      reportFailure(
        ko ? "폴더를 연결하지 못했습니다. 다시 선택해 주세요." : "Could not connect the folder. Please select it again.",
        ko ? "백그라운드 폴더 연결에 실패했습니다. 프로젝트 설정을 다시 열어 시도해 주세요." : "The background folder connection failed. Reopen project settings to try again.",
      );
    } finally {
      operation.current = false;
      if (mounted.current) setPending(null);
    }
  }

  function githubFailure(capability: "repository" | "github_client" | "github_auth" | "destination" | "clone" | "ready") {
    const messages = {
      repository: ko ? "GitHub 저장소 주소를 확인해 주세요." : "Check the GitHub repository URL.",
      github_client: ko ? "GitHub 연결에 필요한 GitHub CLI를 사용할 수 없습니다." : "The GitHub CLI required to connect is unavailable.",
      github_auth: ko ? "GitHub 로그인이 필요합니다. 로그인 후 다시 연결해 주세요." : "Sign in to GitHub and connect again.",
      destination: ko ? "저장할 폴더를 선택해 주세요." : "Choose a folder to save the repository.",
      clone: ko ? "저장소를 복제하지 못했습니다. 접근 권한과 연결을 확인해 주세요." : "Could not clone the repository. Check access and connection.",
      ready: "",
    };
    return messages[capability];
  }

  async function connectGithub() {
    if (operation.current || !githubUrl.trim()) return;
    operation.current = true;
    setPending("github"); setError("");
    try {
      const api = ipc();
      if (!api) throw new Error("bridge unavailable");
      const result = await api.projects.connectGithub(githubUrl.trim());
      if (result.status === "connected") {
        if (!mounted.current) return;
        setGithubUrl(result.repositoryUrl); setConnectedGithub(result.repositoryUrl);
        setFolderGrant(result.folderGrant); setFolderPath(result.folderGrant.path);
        if (!editing && !nameEdited.current) setName(result.folderGrant.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
      } else if (result.status === "action_required") {
        const message = githubFailure(result.capability);
        reportFailure(message, ko ? `백그라운드 GitHub 연결 실패: ${message}` : `Background GitHub connection failed: ${message}`);
      }
    } catch {
      reportFailure(
        ko ? "저장소를 연결하지 못했습니다. 주소와 연결 상태를 확인해 주세요." : "Could not connect the repository. Check its URL and your connection.",
        ko ? "백그라운드 GitHub 연결에 실패했습니다. 프로젝트 설정을 다시 열어 시도해 주세요." : "The background GitHub connection failed. Reopen project settings to try again.",
      );
    } finally {
      operation.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function save() {
    if (!canSave || operation.current || !source) return;
    operation.current = true;
    setPending("save"); setError("");
    try {
      const api = ipc();
      if (!api) throw new Error("bridge unavailable");
      const common = { name: name.trim(), description: goal.trim() || null, systemPrompt: instructions.trim() || null, agentPool };
      const saved = project
        ? await api.projects.update(project.id, { ...common, ...(folderGrant ? { folderGrant, ...(source === "github" ? { sourceRef: connectedGithub } : {}) } : {}) })
        : await api.projects.create({ ...common, sourceType: source, sourceRef: source === "github" ? connectedGithub : null, folderGrant: managed ? null : folderGrant });
      invalidateViewData("dashboard.projects");
      window.dispatchEvent(new CustomEvent("agentlas:projects-changed", { detail: { projectId: saved.id } }));
      if (mounted.current) onSaved(saved);
    } catch (failure) {
      const planMessage = projectAgentLimitMessage(failure, ko);
      reportFailure(
        planMessage ?? (ko ? "저장하지 못했습니다. 입력은 유지되어 있으니 다시 시도해 주세요." : "Could not save. Your entries are preserved; please try again."),
        planMessage ?? (ko ? "백그라운드 저장에 실패했습니다. 프로젝트 설정을 다시 열어 시도해 주세요." : "The background save failed. Reopen project settings to try again."),
      );
    } finally {
      operation.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const nameField = <label className={styles.field}><span>{ko ? "프로젝트 이름" : "Project name"}</span>
    <input value={name} maxLength={160} onChange={(event) => { nameEdited.current = true; setName(event.target.value); }} placeholder={ko ? "예: 고양이 왕국" : "e.g. Cat Kingdom"} disabled={Boolean(pending)} />
  </label>;
  // Work 자동 팀(PLAN §6)은 이름과 목표로 역할을 정한다. 목표는 project.description 에 저장된다.
  const goalField = <label className={`${styles.field} ${styles.goalField}`}><span>{ko ? "프로젝트 목표" : "Project goal"}</span>
    <textarea value={goal} rows={2} maxLength={1200} onChange={(event) => setGoal(event.target.value)} placeholder={ko ? "예: 쇼핑몰 홈페이지를 새로 만들고 SNS로 알리기" : "e.g. Rebuild my store homepage and promote it on social media"} disabled={Boolean(pending)} data-project-goal />
  </label>;
  const instructionField = <details className={styles.instructions}>
    <summary>{ko ? "프로젝트 지시" : "Project instructions"}<span>{ko ? "선택" : "Optional"}</span></summary>
    <label className={styles.field}><span>{ko ? "이 프로젝트에서 지킬 기준" : "Guidelines for this project"}</span>
      <textarea value={instructions} rows={3} onChange={(event) => setInstructions(event.target.value)} placeholder={ko ? "예: 한국어로 설명하고, 기존 디자인을 유지해 주세요." : "e.g. Keep the existing design and explain changes clearly."} disabled={Boolean(pending)} />
    </label>
  </details>;

  return typeof document === "undefined" ? null : createPortal(
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="project-settings-title" aria-busy={Boolean(pending)} data-project-settings
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); requestClose(); }}>
      <div className={styles.layout}>
        <aside className={styles.nav}>
          <div className={styles.projectMark}><IconFolder size={20} /></div>
          <strong className={styles.projectName}>{project?.name || (ko ? "새 프로젝트" : "New project")}</strong>
          <span className={styles.navCaption}>{editing ? (ko ? "프로젝트 설정" : "Project settings") : source === "github" ? "GitHub" : source === "local" ? (ko ? "로컬 폴더 연결" : "Local folder") : source ? (ko ? "빈 프로젝트" : "Empty project") : "Agentlas Work"}</span>
          <nav aria-label={ko ? "프로젝트 설정 메뉴" : "Project settings sections"}>
            {source && !managed && <button type="button" aria-current={section === "source" ? "page" : undefined} disabled={Boolean(pending)} onClick={() => setSection("source")}>
              {source === "github" ? <IconGithub size={17} /> : <IconFolder size={17} />}{source === "github" ? (ko ? "저장소 연결" : "Repository") : (ko ? "폴더 선택" : "Folder")}{sourceReady && <span className={styles.navCheck}><IconCheck size={13} /></span>}
            </button>}
            {source && <button type="button" aria-current={section === "agents" ? "page" : undefined} disabled={Boolean(pending)} onClick={() => setSection("agents")}><IconUsers size={17} />{ko ? "에이전트 연결" : "Agents"}</button>}
          </nav>
          <div className={styles.navFoot}>
            {!editing && source && <button type="button" onClick={() => { setSource(null); setError(""); }} disabled={Boolean(pending)}><IconArrowLeft size={13} />{ko ? "시작 방법 변경" : "Change source"}</button>}
            <span>Agentlas Work</span>
          </div>
        </aside>
        <div className={styles.right}>
          <header className={styles.header}>
            <div><h2 id="project-settings-title">{!source ? (ko ? "어디서 시작할까요?" : "Where would you like to start?") : section === "agents" ? (ko ? "에이전트 연결" : "Connect agents") : source === "github" ? (ko ? "GitHub 저장소 연결" : "Connect a GitHub repository") : (ko ? "로컬 폴더 연결" : "Connect a local folder")}</h2>
              <p>{!source ? (ko ? "프로젝트에 필요한 파일과 에이전트를 한곳에 모으세요." : "Bring your project's files and agents together.") : section === "agents" ? (ko ? "함께할 팀과 에이전트를 골라 주세요. 나중에 바꿀 수 있어요." : "Choose your teams and agents. You can change them later.") : source === "github" ? (ko ? "저장소를 내 컴퓨터에 복제해 작업합니다." : "Work with a local clone of your repository.") : (ko ? "작업할 폴더를 연결하세요. 원래 위치에서 이어서 작업합니다." : "Connect a folder to work with its files in place.")}</p>
            </div>
            <button className={styles.close} type="button" onClick={requestClose} aria-label={pending ? (ko ? "설정을 닫고 작업은 백그라운드에서 계속" : "Close settings; operation continues in background") : (ko ? "프로젝트 설정 닫기" : "Close project settings")}><IconClose size={19} /></button>
          </header>
          <div className={styles.content}>
            {loading ? <p role="status">{ko ? "프로젝트를 불러오는 중…" : "Loading project…"}</p> : editing && !project ? <div role="alert"><p>{error}</p><button className={styles.secondary} onClick={() => setLoadAttempt((value) => value + 1)}>{ko ? "다시 시도" : "Retry"}</button></div> : !source ? <ProjectSourceChoices onSelect={selectSource} /> : <>
              {section === "source" ? <div className={styles.sourceBody}>
                {source === "github" ? <>
                  <label className={styles.field}><span>{ko ? "GitHub 주소" : "GitHub URL"}</span><div className={styles.urlRow}>
                    <input type="url" aria-label={ko ? "GitHub 주소" : "GitHub URL"} value={githubUrl} placeholder="https://github.com/owner/repository" disabled={Boolean(pending)} onChange={(event) => { setGithubUrl(event.target.value); setConnectedGithub(""); setFolderGrant(null); setFolderPath(""); }} />
                    <button type="button" className={styles.secondary} onClick={() => void connectGithub()} disabled={!githubUrl.trim() || Boolean(pending)}>{pending === "github" ? (ko ? "연결 중…" : "Connecting…") : (ko ? "연결" : "Connect")}</button>
                  </div></label>
                  <p className={styles.hint}>{ko ? "연결할 때 저장 위치를 선택합니다." : "Choose where to save when connecting."}</p>
                </> : null}
                <div className={styles.folder} data-connected={Boolean(folderPath)}>
                  <span className={styles.folderIcon}><IconFolder size={26} /></span>
                  <div><strong>{folderPath ? folderPath.split(/[\\/]/).filter(Boolean).at(-1) : (ko ? "연결된 폴더가 없어요" : "No folder connected")}</strong><span>{folderPath || (ko ? "프로젝트에 사용할 폴더를 선택해 주세요." : "Choose a folder for this project.")}</span></div>
                  {source === "local" ? <button type="button" className={styles.secondary} onClick={() => void chooseFolder()} disabled={Boolean(pending)}>{pending === "folder" ? (ko ? "선택 중…" : "Selecting…") : folderPath ? (ko ? "변경" : "Change") : (ko ? "폴더 선택" : "Choose folder")}</button> : folderPath ? <IconCheck size={18} /> : null}
                </div>
                {nameField}{instructionField}
              </div> : <>
                {managed && <div className={styles.managedHeading}>{nameField}<p className={styles.hint}>{project?.folderPath || (ko ? "만들기를 누르면 ~/.agentlas/projects/에 전용 폴더를 준비합니다." : "Creating the project prepares its own folder in ~/.agentlas/projects/.")}</p></div>}
                {goalField}
                <ProjectAgentPicker value={agentPool} onChange={setAgentPool} disabled={Boolean(pending)} autoTeam={{ name, goal }} />
                {managed && instructionField}
              </>}
            </>}
          </div>
          {source && !loading && (!editing || project) && <footer className={styles.footer}>
            <div className={styles.feedback} aria-live="polite">{error ? <span role="alert" className={styles.error}>{error}</span> : pending ? (ko ? "닫아도 작업은 백그라운드에서 계속됩니다." : "You can close this window; the operation will continue in the background.") : !sourceReady ? (ko ? "먼저 작업할 폴더를 연결해 주세요." : "Connect your project folder first.") : !name.trim() ? (ko ? "프로젝트 이름을 적어 주세요." : "Give your project a name.") : managed && !editing ? (ko ? "폴더는 자동으로 준비됩니다." : "Your folder will be prepared automatically.") : (ko ? "저장 후 프로젝트에 적용됩니다." : "Changes apply after saving.")}</div>
            <button className={styles.secondary} type="button" onClick={requestClose}>{pending ? (ko ? "백그라운드에서 계속" : "Continue in background") : (ko ? "취소" : "Cancel")}</button>
            {!editing && section === "source" ? <button className={styles.primary} type="button" onClick={() => setSection("agents")} disabled={!sourceReady || !name.trim() || Boolean(pending)}>{ko ? "에이전트 연결" : "Connect agents"}<IconChevronRight size={15} /></button>
              : <button className={styles.primary} type="button" onClick={() => void save()} disabled={!canSave}>{pending === "save" ? (ko ? "저장 중…" : "Saving…") : editing ? (ko ? "저장" : "Save changes") : (ko ? "프로젝트 만들기" : "Create project")}</button>}
          </footer>}
        </div>
      </div>
    </dialog>, document.body,
  );
}
