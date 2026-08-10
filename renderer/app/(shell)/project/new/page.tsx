"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { IconBuilding, IconChevronDown, IconChevronRight, IconUsers } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import {
  buildProjectRosterSections,
  projectPoolMemberKey,
  type ProjectRosterCandidate,
  type ProjectRosterSource,
} from "@/lib/project-agent-roster";
import type {
  FsPathGrant,
  HubAgentBookmark,
  InstalledAgent,
  InstalledAgentExactBinding,
  InstalledFirm,
  MarketplaceListing,
  ProjectAgentPoolMember,
  ProjectSourceType,
} from "@/lib/types";

type DraftStep = "source" | "instructions" | "agents";

const PROJECT_DRAFT_KEY = "agentlas.project-create.draft.v2";

interface PersistedProjectDraft {
  step: DraftStep;
  name: string;
  nameEdited: boolean;
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
  const [nameEdited, setNameEdited] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sourceType, setSourceType] = useState<ProjectSourceType>("local");
  const [githubUrl, setGithubUrl] = useState("");
  const [sampleName, setSampleName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderGrant, setFolderGrant] = useState<FsPathGrant | null>(null);
  const [githubConnectedUrl, setGithubConnectedUrl] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [cloudListings, setCloudListings] = useState<MarketplaceListing[]>([]);
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>([]);
  const [exactBindings, setExactBindings] = useState<InstalledAgentExactBinding[]>([]);
  const [agentPool, setAgentPool] = useState<ProjectAgentPoolMember[]>([]);
  const [openRosterSources, setOpenRosterSources] = useState<Record<ProjectRosterSource, boolean>>({ local: true, cloud: true, hub: false });
  const [openRosterFirms, setOpenRosterFirms] = useState<Record<string, boolean>>({});
  const [draggedCandidateKey, setDraggedCandidateKey] = useState<string | null>(null);
  const [draggedMemberKey, setDraggedMemberKey] = useState<string | null>(null);
  const pointerDragRef = useRef<{ kind: "candidate" | "member"; id: string; startX: number; startY: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsHelp, setNeedsHelp] = useState(false);
  const [draftHydrated, setDraftHydrated] = useState(false);

  const rosterSections = useMemo(
    () => buildProjectRosterSections(agents, firms, cloudListings, hubBookmarks, locale, exactBindings),
    [agents, cloudListings, exactBindings, firms, hubBookmarks, locale],
  );
  const candidateByKey = useMemo(() => {
    const rows = rosterSections.flatMap((section) => [
      ...section.standalone,
      ...section.firms.flatMap((firm) => [firm.team, ...firm.members]),
    ]);
    return new Map(rows.map((candidate) => [candidate.key, candidate]));
  }, [rosterSections]);
  const selectedMemberKeys = useMemo(() => new Set(agentPool.map(projectPoolMemberKey)), [agentPool]);
  const rosterCount = useMemo(() => rosterSections.reduce(
    (sum, section) => sum + section.standalone.length + section.firms.reduce((firmSum, firm) => firmSum + 1 + firm.members.length, 0),
    0,
  ), [rosterSections]);

  function recoverMissingBridge(_scope: string) {
    setNeedsHelp(true);
  }

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(PROJECT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<PersistedProjectDraft>;
      if (draft.step === "source" || draft.step === "instructions" || draft.step === "agents") setStep(draft.step);
      if (typeof draft.name === "string") setName(draft.name);
      if (typeof draft.nameEdited === "boolean") setNameEdited(draft.nameEdited);
      if (typeof draft.systemPrompt === "string") setSystemPrompt(draft.systemPrompt);
      if (draft.sourceType === "local" || draft.sourceType === "github" || draft.sourceType === "sample") setSourceType(draft.sourceType);
      if (typeof draft.githubUrl === "string") setGithubUrl(draft.githubUrl);
      if (typeof draft.sampleName === "string") setSampleName(draft.sampleName);
      if (Array.isArray(draft.agentPool)) {
        const restored: ProjectAgentPoolMember[] = [];
        for (const member of draft.agentPool) {
          if (!member || (member.source !== "local" && member.source !== "cloud" && member.source !== "hub") || typeof member.nameSnapshot !== "string") continue;
          if (member.entityKind === "team" && typeof member.targetId === "string") {
            restored.push(member);
            continue;
          }
          if (typeof member.agentId !== "string" || !member.agentId) continue;
          restored.push({
            entityKind: "agent" as const,
            targetId: typeof member.targetId === "string" && member.targetId ? member.targetId : member.agentId,
            agentId: member.agentId,
            firmId: null,
            controllerAgentId: null,
            source: member.source,
            releaseId: typeof member.releaseId === "string" ? member.releaseId : null,
            nameSnapshot: member.nameSnapshot,
          });
        }
        setAgentPool(restored);
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
      nameEdited,
      systemPrompt,
      sourceType,
      githubUrl,
      sampleName,
      agentPool,
    };
    try {
      window.sessionStorage.setItem(PROJECT_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Draft storage is optional and must not block project creation.
    }
  }, [agentPool, draftHydrated, githubUrl, name, nameEdited, sampleName, sourceType, step, systemPrompt]);

  useEffect(() => {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-create-agent-list");
      return;
    }
    void Promise.all([
      api.team.list(),
      api.firms.list().catch(() => [] as InstalledFirm[]),
      api.marketplace.listMine().catch(() => [] as MarketplaceListing[]),
      api.marketplace.bookmarks().catch(() => [] as HubAgentBookmark[]),
      api.agents.exactBindings().catch(() => [] as InstalledAgentExactBinding[]),
    ]).then(([agentRows, firmRows, mine, bookmarks, bindings]) => {
      setAgents(agentRows);
      setFirms(firmRows);
      setCloudListings(mine);
      setHubBookmarks(bookmarks);
      setExactBindings(bindings);
    }).catch(() => setNeedsHelp(true));
  }, []);

  function addCandidate(candidate: ProjectRosterCandidate) {
    setAgentPool((current) => {
      if (current.some((member) => projectPoolMemberKey(member) === candidate.key)) return current;
      if (!candidate.callable) return current;
      return [...current, candidate.member];
    });
  }

  function addCandidates(candidates: ProjectRosterCandidate[]) {
    setAgentPool((current) => {
      const next = [...current];
      const selected = new Set(next.map(projectPoolMemberKey));
      for (const candidate of candidates) {
        if (!candidate.callable || selected.has(candidate.key)) continue;
        next.push(candidate.member);
        selected.add(candidate.key);
      }
      return next;
    });
  }

  function movePoolMember(memberKey: string, targetIndex: number) {
    setAgentPool((current) => {
      const sourceIndex = current.findIndex((member) => projectPoolMemberKey(member) === memberKey);
      if (sourceIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, moved);
      return next;
    });
  }

  function beginPointerDrag(event: ReactPointerEvent<HTMLElement>, kind: "candidate" | "member", id: string) {
    pointerDragRef.current = { kind, id, startX: event.clientX, startY: event.clientY };
    if (kind === "candidate") setDraggedCandidateKey(id);
    else setDraggedMemberKey(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function completePointerDrag(clientX: number, clientY: number) {
    const drag = pointerDragRef.current;
    if (!drag || Math.hypot(clientX - drag.startX, clientY - drag.startY) <= 4) return;
    pointerDragRef.current = null;
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const pool = target?.closest<HTMLElement>("[data-project-agent-pool]");
    const memberRow = target?.closest<HTMLElement>("[data-project-member-index]");
    if (pool) {
      if (drag.kind === "member" && memberRow) {
        movePoolMember(drag.id, Number(memberRow.dataset.projectMemberIndex));
      } else if (drag.kind === "candidate") {
        const candidate = candidateByKey.get(drag.id);
        if (candidate) addCandidate(candidate);
      }
    }
    setDraggedCandidateKey(null);
    setDraggedMemberKey(null);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLElement>) {
    completePointerDrag(event.clientX, event.clientY);
  }

  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => completePointerDrag(event.clientX, event.clientY);
    const onMouseUp = (event: MouseEvent) => completePointerDrag(event.clientX, event.clientY);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [candidateByKey]);

  async function chooseFolder() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-create-folder");
      return;
    }
    setNeedsHelp(false);
    try {
      const picked = await api.workspace.selectFolder();
      if (!picked) return;
      setFolderGrant(picked);
      setFolderPath(picked.path);
      setGithubConnectedUrl("");
      if (!nameEdited) setName(picked.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
    } catch {
      setNeedsHelp(true);
    }
  }

  async function connectGithub() {
    const api = ipc();
    if (!api) {
      recoverMissingBridge("project-create-github");
      return;
    }
    if (!githubUrl.trim() || busy) return;
    setBusy(true);
    setNeedsHelp(false);
    try {
      const result = await api.projects.connectGithub(githubUrl.trim());
      if (result.status === "connected") {
        setGithubUrl(result.repositoryUrl);
        setGithubConnectedUrl(result.repositoryUrl);
        setFolderGrant(result.folderGrant);
        setFolderPath(result.folderGrant.path);
        if (!nameEdited) setName(result.folderGrant.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
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
    if (!api) {
      recoverMissingBridge("project-create-submit");
      return;
    }
    if (!name.trim() || busy) return;
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
  const steps: DraftStep[] = ["source", "instructions", "agents"];

  return (
    <div className="project-create rd">
      <header className="project-create-head titlebar-drag">
        <div>
          <span>{ko ? "새 프로젝트" : "New project"}</span>
          <h1>{ko ? "프로젝트를 연결하고 도구를 붙이세요" : "Connect your project and attach its tools"}</h1>
        </div>
        <button type="button" className="project-create-close titlebar-nodrag" onClick={() => router.back()}>
          {ko ? "닫기" : "Close"}
        </button>
      </header>

      <nav className="project-create-steps" aria-label={ko ? "프로젝트 생성 단계" : "Project setup steps"}>
        {steps.map((item, index) => {
          const unavailable = item === "instructions"
            ? !sourceReady
            : item === "agents"
              ? !sourceReady || !name.trim()
              : false;
          const label = item === "source"
              ? (ko ? "소스" : "Source")
              : item === "instructions"
                ? (ko ? "프로젝트 지시" : "Instructions")
                : (ko ? "도구" : "Tools");
          return (
            <button key={item} type="button" data-active={step === item} disabled={unavailable} onClick={() => setStep(item)}>
              <span>{index + 1}</span>{label}
            </button>
          );
        })}
      </nav>

      <main className="project-create-body titlebar-nodrag">
        {step === "source" ? (
          <section className="project-create-section">
            <div className="project-create-copy">
              <span className="project-create-kicker">01</span>
              <h2>{ko ? "프로젝트 소스를 연결하세요" : "Connect your project source"}</h2>
              <p>{ko ? "코드, 문서, 게임을 포함해 모든 작업은 하나의 프로젝트로 시작합니다." : "Every kind of work, including code, documents, and games, starts as one project."}</p>
            </div>
            <div className="project-source-grid">
              {([
                ["local", ko ? "로컬 폴더" : "Local folder", ko ? "이 Mac에 있는 코드와 파일" : "Code and files on this Mac"],
                ["github", "GitHub", ko ? "저장소 주소로 연결" : "Connect with a repository URL"],
                ["sample", ko ? "샘플로 시작" : "Start with a sample", ko ? "연결 없이 구조를 먼저 경험" : "Explore the structure without a connection"],
              ] as Array<[ProjectSourceType, string, string]>).map(([value, label, detail]) => (
                <button key={value} type="button" className="project-source-card" data-selected={sourceType === value} onClick={() => {
                  setSourceType(value);
                  if (!nameEdited && value === "sample") setName(sampleName);
                }}>
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
                <input value={sampleName} onChange={(event) => { const next = event.target.value; setSampleName(next); if (!nameEdited) setName(next); }} placeholder={ko ? "예: 첫 번째 웹앱" : "e.g. My first web app"} />
              </label>
            )}
            <div className="project-create-actions">
              <button type="button" disabled={!sourceReady} onClick={() => setStep("instructions")}>{ko ? "다음" : "Continue"}</button>
            </div>
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
              <input value={name} onChange={(event) => { setName(event.target.value); setNameEdited(true); }} autoFocus />
            </label>
            <label className="project-field">
              <span>{ko ? "프로젝트 시스템 프롬프트" : "Project system prompt"}</span>
              <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={8} placeholder={ko ? "예: 기존 디자인 시스템을 유지하고, 변경 후 테스트 결과까지 보여줘." : "e.g. Preserve the design system and show test results after each change."} />
            </label>
            <div className="project-create-actions">
              <button type="button" className="secondary" onClick={() => setStep("source")}>{ko ? "이전" : "Back"}</button>
              <button type="button" disabled={!name.trim()} onClick={() => setStep("agents")}>{ko ? "다음" : "Continue"}</button>
            </div>
          </section>
        ) : (
          <section className="project-create-section project-agent-step">
            <div className="project-create-copy">
              <span className="project-create-kicker">03</span>
              {/* 작업 주체는 프로젝트다. 여기서 고르는 팀과 에이전트는 프로젝트에
                  연결해 두는 재사용 도구이며 세션 소유자나 책임자가 아니다. */}
              <h2>{ko ? "이 프로젝트에 도구를 붙이세요" : "Attach tools to this project"}</h2>
              <p>{ko ? `실행 가능한 팀과 에이전트 ${rosterCount}개가 있습니다. 필요한 도구만 붙이면 되며, 지금 비워 두고 프로젝트를 만든 뒤 추가해도 됩니다. 작업은 프로젝트가 소유하고 내장 오케스트레이터가 분배하며, 부족한 역량은 Network에서 보강합니다.` : `${rosterCount} callable teams and agents are available. Attach only the tools this project needs, or leave this empty and add them later. The project owns the work, its built-in orchestrator delegates it, and Network can fill capability gaps.`}</p>
            </div>
            <div className="project-agent-workbench project-agent-workbench-org">
              <div className="project-agent-pool project-team-org-create" data-project-agent-pool data-empty={agentPool.length === 0}>
                <div className="project-agent-pool-head"><strong>{ko ? "프로젝트 도구" : "Project tools"}</strong><span>{agentPool.length}</span></div>
                {agentPool.length === 0 ? (
                  <div className="project-agent-drop-copy">{ko ? "선택 사항입니다. 오른쪽에서 팀이나 에이전트를 추가하거나 그대로 진행하세요." : "Optional. Add a team or agent from the right, or continue without one."}</div>
                ) : (
                  <div className="project-team-create-tree">
                    {agentPool.map((member, index) => {
                      const key = projectPoolMemberKey(member);
                      return (
                        <div
                          className="project-agent-member project-team-create-node"
                          data-project-member-index={index}
                          data-member-index={index}
                          data-dragging={draggedMemberKey === key}
                          key={key}
                          draggable={false}
                          onPointerDown={(event) => beginPointerDrag(event, "member", key)}
                          onPointerUp={finishPointerDrag}
                          onPointerCancel={() => { pointerDragRef.current = null; setDraggedMemberKey(null); }}
                        >
                          {/* No ordinal: the pool has no ranking. The orchestrator LLM picks whom to
                              call per task, so a number here would invite the user to curate an
                              order that changes nothing. */}
                          <span className="project-agent-order" aria-hidden="true">·</span>
                          <span className="project-team-create-copy"><strong>{member.nameSnapshot}</strong><small>{ko ? "프로젝트 도구 · 필요할 때 호출" : "Project tool · invoked when needed"}</small></span>
                          <span className="project-team-create-actions">
                            <button type="button" onClick={() => setAgentPool((current) => current.filter((item) => projectPoolMemberKey(item) !== key))}>{ko ? "제거" : "Remove"}</button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <aside className="project-agent-library project-agent-library-tree-create" aria-label={ko ? "실행 가능한 팀과 에이전트" : "Callable teams and agents"}>
                <div className="project-agent-pool-head"><strong>{ko ? "팀과 에이전트" : "Teams and agents"}</strong><span>{rosterCount}</span></div>
                {rosterSections.map((section) => {
                  const count = section.standalone.length + section.firms.reduce((sum, firm) => sum + 1 + firm.members.length, 0);
                  const open = openRosterSources[section.source];
                  return (
                    <div key={section.source} className="project-roster-create-section">
                      <button type="button" className="project-roster-source-row-create" onClick={() => setOpenRosterSources((current) => ({ ...current, [section.source]: !open }))} aria-expanded={open}>
                        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                        <span>{ko ? section.labelKo : section.labelEn}</span><span>{count}</span>
                      </button>
                      {open ? (
                        <div>
                          {section.firms.map((firm) => {
                            const firmOpen = openRosterFirms[firm.id] ?? false;
                            const teamAddable = firm.team.callable && !selectedMemberKeys.has(firm.team.key);
                            return (
                              <div key={firm.id} className="project-roster-firm-create">
                                <div className="project-roster-firm-row-create">
                                  {/* Self-referential firm: its only member is the team
                                      itself, so a chevron would disclose a duplicate of
                                      this same row and the count would be the team
                                      counting itself. */}
                                  {firm.selfReferential ? (
                                    <span aria-hidden="true" />
                                  ) : (
                                    <button type="button" onClick={() => setOpenRosterFirms((current) => ({ ...current, [firm.id]: !firmOpen }))} aria-expanded={firmOpen}>{firmOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}</button>
                                  )}
                                  <IconBuilding size={12} /><strong>{firm.name}</strong>{firm.selfReferential ? null : <span>{firm.members.length}</span>}
                                  <button type="button" disabled={!teamAddable} onClick={() => addCandidate(firm.team)}>{ko ? "팀 도구 추가" : "Add team tool"}</button>
                                </div>
                                {firmOpen && !firm.selfReferential ? <div className="project-roster-children-create">{firm.members.map((candidate) => (
                                  <RosterCandidateButton key={candidate.key} candidate={candidate} ko={ko} selected={selectedMemberKeys.has(candidate.key)} dragging={draggedCandidateKey === candidate.key} onAdd={addCandidate} onPointerDown={beginPointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={() => { pointerDragRef.current = null; setDraggedCandidateKey(null); }} />
                                ))}</div> : null}
                              </div>
                            );
                          })}
                          {section.standalone.length > 0 && section.firms.length > 0 ? (
                            <div className="project-roster-standalone-head">{ko ? "단일 에이전트" : "Single agents"}</div>
                          ) : null}
                          <div className="project-roster-standalone-create">{section.standalone.map((candidate) => (
                            <RosterCandidateButton key={candidate.key} candidate={candidate} ko={ko} selected={selectedMemberKeys.has(candidate.key)} dragging={draggedCandidateKey === candidate.key} onAdd={addCandidate} onPointerDown={beginPointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={() => { pointerDragRef.current = null; setDraggedCandidateKey(null); }} />
                          ))}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </aside>
            </div>
            <div className="project-create-actions">
              <button type="button" className="secondary" onClick={() => setStep("instructions")}>{ko ? "이전" : "Back"}</button>
              <button type="button" disabled={busy} onClick={() => void submit()}>{busy ? (ko ? "만드는 중…" : "Creating…") : (ko ? "프로젝트 만들기" : "Create project")}</button>
            </div>
          </section>
        )}

        {needsHelp ? <aside className="project-help-slot" role="alert">{ko ? "프로젝트 연결을 완료하지 못했습니다. 입력 내용은 유지했으니 연결 상태를 확인하고 다시 시도하세요." : "The project could not be connected. Your entries are preserved; check the connection and try again."}</aside> : null}
      </main>
    </div>
  );
}

function RosterCandidateButton({
  candidate,
  ko,
  selected,
  dragging,
  onAdd,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
}: {
  candidate: ProjectRosterCandidate;
  ko: boolean;
  selected: boolean;
  dragging: boolean;
  onAdd: (candidate: ProjectRosterCandidate) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, kind: "candidate", id: string) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}) {
  const disabled = selected || !candidate.callable;
  const helper = selected
    ? (ko ? "프로젝트에 추가됨" : "Added to project")
    : !candidate.callable
      ? candidate.blockedReason ?? (ko ? "실행할 수 없는 항목" : "Not callable")
    : candidate.tagline;
  return (
    <button
      type="button"
      className="project-roster-candidate-create"
      data-selected={selected}
      data-dragging={dragging}
      disabled={disabled}
      title={helper}
      onPointerDown={(event) => { if (!disabled) onPointerDown(event, "candidate", candidate.key); }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={() => { if (!disabled) onAdd(candidate); }}
    >
      <span>{candidate.kind === "team" ? <IconBuilding size={12} /> : <IconUsers size={12} />}</span>
      <span><strong>{candidate.name}</strong><small>{helper}</small></span>
      <em>{candidate.kind === "team" ? "multi" : candidate.source}</em>
    </button>
  );
}
