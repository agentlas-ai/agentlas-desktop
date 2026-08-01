"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type {
  FsPathGrant,
  InstalledAgent,
  ProjectAgentPoolMember,
  ProjectSourceType,
} from "@/lib/types";

type DraftStep = "source" | "instructions" | "agents";

const PROJECT_DRAFT_KEY = "agentlas.project-create.draft.v1";

interface PersistedProjectDraft {
  step: DraftStep;
  name: string;
  systemPrompt: string;
  sourceType: ProjectSourceType;
  githubUrl: string;
  sampleName: string;
  agentPool: ProjectAgentPoolMember[];
}

export default function NewProjectPage() {
  const router = useRouter();
  const { locale } = useT();
  const ko = locale === "ko";
  const [step, setStep] = useState<DraftStep>("source");
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sourceType, setSourceType] = useState<ProjectSourceType>("local");
  const [githubUrl, setGithubUrl] = useState("");
  const [sampleName, setSampleName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderGrant, setFolderGrant] = useState<FsPathGrant | null>(null);
  const [githubConnectedUrl, setGithubConnectedUrl] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [agentPool, setAgentPool] = useState<ProjectAgentPoolMember[]>([]);
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
  const [draggedMemberId, setDraggedMemberId] = useState<string | null>(null);
  const pointerDragRef = useRef<{ kind: "agent" | "member"; id: string; startX: number; startY: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsHelp, setNeedsHelp] = useState(false);
  const [draftHydrated, setDraftHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(PROJECT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<PersistedProjectDraft>;
      if (draft.step === "source" || draft.step === "instructions" || draft.step === "agents") setStep(draft.step);
      if (typeof draft.name === "string") setName(draft.name);
      if (typeof draft.systemPrompt === "string") setSystemPrompt(draft.systemPrompt);
      if (draft.sourceType === "local" || draft.sourceType === "github" || draft.sourceType === "sample") setSourceType(draft.sourceType);
      if (typeof draft.githubUrl === "string") setGithubUrl(draft.githubUrl);
      if (typeof draft.sampleName === "string") setSampleName(draft.sampleName);
      if (Array.isArray(draft.agentPool)) {
        setAgentPool(draft.agentPool.filter((member): member is ProjectAgentPoolMember => (
          Boolean(member)
          && typeof member.agentId === "string"
          && (member.source === "local" || member.source === "cloud" || member.source === "hub")
          && typeof member.nameSnapshot === "string"
        )));
      }
    } catch {
      window.sessionStorage.removeItem(PROJECT_DRAFT_KEY);
    } finally {
      setDraftHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!draftHydrated) return;
    const draft: PersistedProjectDraft = {
      step,
      name,
      systemPrompt,
      sourceType,
      githubUrl,
      sampleName,
      agentPool,
    };
    try {
      window.sessionStorage.setItem(PROJECT_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // A draft is a convenience only; storage failure must not block project creation.
    }
  }, [agentPool, draftHydrated, githubUrl, name, sampleName, sourceType, step, systemPrompt]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.team.list().then((list) => setAgents(visibleAgents(list))).catch(() => setNeedsHelp(true));
  }, []);

  const availableAgents = useMemo(
    () => agents.filter((agent) => !agentPool.some((member) => member.agentId === agent.id)),
    [agentPool, agents],
  );

  function addAgent(agent: InstalledAgent) {
    setAgentPool((current) => current.some((member) => member.agentId === agent.id)
      ? current
      : [...current, {
          agentId: agent.id,
          source: "local",
          releaseId: null,
          nameSnapshot: pickLocalized(agent, locale).name,
        }]);
  }

  function dropAgent(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const memberId = event.dataTransfer.getData("application/x-agentlas-project-member");
    if (memberId) return;
    const agentId = event.dataTransfer.getData("application/x-agentlas-agent") || draggedAgentId;
    const agent = agents.find((item) => item.id === agentId);
    if (agent) addAgent(agent);
    setDraggedAgentId(null);
  }

  function movePoolMember(agentId: string, targetIndex: number) {
    setAgentPool((current) => {
      const sourceIndex = current.findIndex((member) => member.agentId === agentId);
      if (sourceIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function pointerDropToPool(targetIndex?: number) {
    if (draggedMemberId && targetIndex !== undefined) {
      movePoolMember(draggedMemberId, targetIndex);
    } else if (draggedAgentId) {
      const agent = agents.find((item) => item.id === draggedAgentId);
      if (agent) addAgent(agent);
    }
    setDraggedAgentId(null);
    setDraggedMemberId(null);
  }

  function beginPointerDrag(event: ReactPointerEvent<HTMLElement>, kind: "agent" | "member", id: string) {
    pointerDragRef.current = { kind, id, startX: event.clientX, startY: event.clientY };
    if (kind === "agent") setDraggedAgentId(id);
    else setDraggedMemberId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    if (!drag) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    if (moved) {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const memberRow = target?.closest<HTMLElement>("[data-project-member-index]");
      const pool = target?.closest<HTMLElement>("[data-project-agent-pool]");
      if (pool) {
        if (drag.kind === "member" && memberRow) {
          movePoolMember(drag.id, Number(memberRow.dataset.projectMemberIndex));
        } else if (drag.kind === "agent") {
          const agent = agents.find((item) => item.id === drag.id);
          if (agent) addAgent(agent);
        }
      }
    }
    setDraggedAgentId(null);
    setDraggedMemberId(null);
  }

  useEffect(() => {
    const finishAt = (clientX: number, clientY: number) => {
      const drag = pointerDragRef.current;
      if (!drag || Math.hypot(clientX - drag.startX, clientY - drag.startY) <= 4) return;
      pointerDragRef.current = null;
      const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const pool = target?.closest<HTMLElement>("[data-project-agent-pool]");
      const memberRow = target?.closest<HTMLElement>("[data-project-member-index]");
      if (pool) {
        if (drag.kind === "member" && memberRow) {
          movePoolMember(drag.id, Number(memberRow.dataset.projectMemberIndex));
        } else if (drag.kind === "agent") {
          const agent = agents.find((item) => item.id === drag.id);
          if (agent) addAgent(agent);
        }
      }
      setDraggedAgentId(null);
      setDraggedMemberId(null);
    };
    const onPointerUp = (event: PointerEvent) => finishAt(event.clientX, event.clientY);
    const onMouseUp = (event: MouseEvent) => finishAt(event.clientX, event.clientY);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [agents, locale]);

  async function chooseFolder() {
    const api = ipc();
    if (!api) return;
    setNeedsHelp(false);
    try {
      const picked = await api.workspace.selectFolder();
      if (!picked) return;
      setFolderGrant(picked);
      setFolderPath(picked.path);
      setGithubConnectedUrl("");
      if (!name.trim()) setName(picked.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
    } catch {
      setNeedsHelp(true);
    }
  }

  async function connectGithub() {
    const api = ipc();
    if (!api || !githubUrl.trim() || busy) return;
    setBusy(true);
    setNeedsHelp(false);
    try {
      const result = await api.projects.connectGithub(githubUrl.trim());
      if (result.status === "connected") {
        setGithubUrl(result.repositoryUrl);
        setGithubConnectedUrl(result.repositoryUrl);
        setFolderGrant(result.folderGrant);
        setFolderPath(result.folderGrant.path);
        if (!name.trim()) setName(result.folderGrant.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
      } else if (result.status === "action_required") {
        setNeedsHelp(true);
      }
    } catch {
      setNeedsHelp(true);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const api = ipc();
    if (!api || !name.trim() || agentPool.length === 0 || busy) return;
    setBusy(true);
    setNeedsHelp(false);
    try {
      const project = await api.projects.create({
        name: name.trim(),
        systemPrompt: systemPrompt.trim() || null,
        agentPool,
        sourceType,
        sourceRef: sourceType === "github" ? githubUrl.trim() || null : sourceType === "sample" ? sampleName.trim() || null : null,
        folderGrant: sourceType === "sample" ? null : folderGrant,
      });
      window.sessionStorage.removeItem(PROJECT_DRAFT_KEY);
      window.dispatchEvent(new Event("agentlas:projects-changed"));
      navigate(`/project/detail?id=${encodeURIComponent(project.id)}`, "replace");
    } catch {
      setNeedsHelp(true);
    } finally {
      setBusy(false);
    }
  }

  const sourceReady = sourceType === "sample"
    ? Boolean(sampleName.trim())
    : sourceType === "github"
      ? Boolean(folderGrant && githubConnectedUrl === githubUrl.trim())
      : Boolean(folderGrant && !githubConnectedUrl);

  return (
    <div className="project-create rd">
      <header className="project-create-head titlebar-drag">
        <div>
          <span>{ko ? "새 프로젝트" : "New project"}</span>
          <h1>{ko ? "일할 공간과 팀을 연결하세요" : "Connect the work and its team"}</h1>
        </div>
        <button type="button" className="project-create-close titlebar-nodrag" onClick={() => router.back()}>
          {ko ? "닫기" : "Close"}
        </button>
      </header>

      <nav className="project-create-steps" aria-label={ko ? "프로젝트 생성 단계" : "Project setup steps"}>
        {(["source", "instructions", "agents"] as DraftStep[]).map((item, index) => (
          <button key={item} type="button" data-active={step === item} onClick={() => setStep(item)}>
            <span>{index + 1}</span>
            {item === "source" ? (ko ? "소스" : "Source") : item === "instructions" ? (ko ? "프로젝트 지시" : "Instructions") : (ko ? "에이전트" : "Agents")}
          </button>
        ))}
      </nav>

      <main className="project-create-body titlebar-nodrag">
        {step === "source" ? (
          <section className="project-create-section">
            <div className="project-create-copy">
              <span className="project-create-kicker">01</span>
              <h2>{ko ? "무엇을 작업할까요?" : "What are we working on?"}</h2>
              <p>{ko ? "프로젝트의 기준이 될 소스를 먼저 선택합니다." : "Choose the source that grounds this project."}</p>
            </div>
            <div className="project-source-grid">
              {([
                ["local", ko ? "로컬 폴더" : "Local folder", ko ? "이 Mac에 있는 코드와 파일" : "Code and files on this Mac"],
                ["github", "GitHub", ko ? "저장소 주소로 연결" : "Connect with a repository URL"],
                ["sample", ko ? "샘플로 시작" : "Start with a sample", ko ? "연결 없이 구조를 먼저 경험" : "Explore the structure without a connection"],
              ] as Array<[ProjectSourceType, string, string]>).map(([value, label, detail]) => (
                <button key={value} type="button" className="project-source-card" data-selected={sourceType === value} onClick={() => setSourceType(value)}>
                  <strong>{label}</strong><span>{detail}</span>
                </button>
              ))}
            </div>
            {sourceType === "local" ? (
              <div className="project-source-connect">
                <div><strong>{folderPath || (ko ? "아직 폴더를 선택하지 않았습니다" : "No folder selected yet")}</strong></div>
                <button type="button" onClick={() => void chooseFolder()}>{ko ? "폴더 선택" : "Choose folder"}</button>
              </div>
            ) : sourceType === "github" ? (
              <div className="project-source-connect project-source-connect-stack">
                <label className="project-field">
                  <span>{ko ? "GitHub 저장소 주소" : "GitHub repository URL"}</span>
                  <input value={githubUrl} onChange={(event) => { setGithubUrl(event.target.value); setGithubConnectedUrl(""); setFolderGrant(null); setFolderPath(""); }} placeholder="https://github.com/owner/repository" />
                </label>
                <div>
                  <strong>{folderPath || (ko ? "로그인 후 복제할 위치를 선택합니다" : "Sign in, then choose where to clone")}</strong>
                  <button type="button" disabled={!githubUrl.trim() || busy} onClick={() => void connectGithub()}>{busy ? (ko ? "연결 중…" : "Connecting…") : folderPath ? (ko ? "다시 연결" : "Reconnect") : (ko ? "GitHub 연결" : "Connect GitHub")}</button>
                </div>
              </div>
            ) : (
              <label className="project-field">
                <span>{ko ? "샘플 이름" : "Sample name"}</span>
                <input value={sampleName} onChange={(event) => setSampleName(event.target.value)} placeholder={ko ? "예: 첫 번째 웹앱" : "e.g. My first web app"} />
              </label>
            )}
            <FooterAction disabled={!sourceReady} onNext={() => setStep("instructions")} ko={ko} />
          </section>
        ) : step === "instructions" ? (
          <section className="project-create-section">
            <div className="project-create-copy">
              <span className="project-create-kicker">02</span>
              <h2>{ko ? "프로젝트의 기준을 알려주세요" : "Set the project direction"}</h2>
              <p>{ko ? "이 지시는 프로젝트의 모든 작업에 적용됩니다." : "These instructions apply to every task in this project."}</p>
            </div>
            <label className="project-field">
              <span>{ko ? "프로젝트 이름" : "Project name"}</span>
              <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <label className="project-field">
              <span>{ko ? "프로젝트 시스템 프롬프트" : "Project system prompt"}</span>
              <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={8} placeholder={ko ? "예: 기존 디자인 시스템을 유지하고, 변경 후 테스트 결과까지 보여줘." : "e.g. Preserve the design system and show test results after each change."} />
            </label>
            <FooterAction disabled={!name.trim()} onNext={() => setStep("agents")} ko={ko} />
          </section>
        ) : (
          <section className="project-create-section project-agent-step">
            <div className="project-create-copy">
              <span className="project-create-kicker">03</span>
              <h2>{ko ? "이 프로젝트에서 사용할 에이전트" : "Agents for this project"}</h2>
              <p>{ko ? "오른쪽에서 에이전트를 직접 끌어오세요. 위에서부터 선호 순서로 저장됩니다." : "Drag agents from the right. The order is saved as the project preference."}</p>
            </div>
            <div className="project-agent-workbench">
              <div className="project-agent-pool" data-project-agent-pool onDragOver={(event) => event.preventDefault()} onDrop={dropAgent} data-empty={agentPool.length === 0}>
                <div className="project-agent-pool-head"><strong>{ko ? "프로젝트 팀" : "Project team"}</strong><span>{agentPool.length}</span></div>
                {agentPool.length === 0 ? <div className="project-agent-drop-copy">{ko ? "에이전트를 이곳으로 드래그하세요" : "Drag agents here"}</div> : agentPool.map((member, index) => (
                  <div
                    className="project-agent-member"
                    data-project-member-index={index}
                    key={`${member.source}:${member.agentId}`}
                    draggable={false}
                    onPointerDown={(event) => beginPointerDrag(event, "member", member.agentId)}
                    onPointerUp={finishPointerDrag}
                    onPointerCancel={() => { pointerDragRef.current = null; setDraggedMemberId(null); }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-agentlas-project-member", member.agentId);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      movePoolMember(event.dataTransfer.getData("application/x-agentlas-project-member"), index);
                    }}
                  >
                    <span className="project-agent-order">{index + 1}</span>
                    <strong>{member.nameSnapshot}</strong>
                    <button type="button" onClick={() => setAgentPool((current) => current.filter((item) => item.agentId !== member.agentId))}>{ko ? "제거" : "Remove"}</button>
                  </div>
                ))}
              </div>
              <aside className="project-agent-library">
                <div className="project-agent-pool-head"><strong>{ko ? "내 에이전트" : "My agents"}</strong><span>{availableAgents.length}</span></div>
                {availableAgents.map((agent) => {
                  const localized = pickLocalized(agent, locale);
                  return <button
                    type="button"
                    draggable={false}
                    className="project-agent-source"
                    key={agent.id}
                    onPointerDown={(event) => beginPointerDrag(event, "agent", agent.id)}
                    onMouseDown={(event) => {
                      if (!pointerDragRef.current) pointerDragRef.current = { kind: "agent", id: agent.id, startX: event.clientX, startY: event.clientY };
                    }}
                    onPointerUp={finishPointerDrag}
                    onPointerCancel={() => { pointerDragRef.current = null; setDraggedAgentId(null); }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-agentlas-agent", agent.id);
                      event.dataTransfer.effectAllowed = "copy";
                      setDraggedAgentId(agent.id);
                    }}
                    onDragEnd={() => setDraggedAgentId(null)}
                    onClick={() => addAgent(agent)}
                  ><strong>{localized.name}</strong><span>{localized.tagline}</span></button>;
                })}
              </aside>
            </div>
            <div className="project-create-actions">
              <button type="button" className="secondary" onClick={() => setStep("instructions")}>{ko ? "이전" : "Back"}</button>
              <button type="button" disabled={agentPool.length === 0 || busy} onClick={() => void submit()}>{busy ? (ko ? "만드는 중…" : "Creating…") : (ko ? "프로젝트 만들기" : "Create project")}</button>
            </div>
          </section>
        )}

        {needsHelp ? (
          <aside className="project-help-slot" aria-live="polite">
            <div data-one-content-slot />
            <button type="button" onClick={() => navigate("/one")}>{ko ? "One과 해결하기" : "Resolve with One"}</button>
          </aside>
        ) : null}
      </main>
    </div>
  );
}

function FooterAction({ disabled, onNext, ko }: { disabled: boolean; onNext: () => void; ko: boolean }) {
  return <div className="project-create-actions"><span /><button type="button" disabled={disabled} onClick={onNext}>{ko ? "다음" : "Continue"}</button></div>;
}
