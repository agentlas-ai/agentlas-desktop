"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { IconBuilding, IconChevronDown, IconChevronRight, IconUsers } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
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
  InstalledFirm,
  MarketplaceListing,
  ProjectAgentPoolMember,
  ProjectSourceType,
} from "@/lib/types";

type DraftStep = "kind" | "source" | "instructions" | "agents";
type ProjectKind = "general" | "game";

const PROJECT_DRAFT_KEY = "agentlas.project-create.draft.v1";

function gameProjectContract(ko: boolean): string {
  return ko
    ? `이 프로젝트는 완성된 브라우저 게임을 만드는 Game 프로젝트입니다.

- 책임자는 프로젝트 전체 결과와 검증을 소유합니다. 작업을 실제 슬롯으로 나누고 프로젝트 선호 팀을 먼저 활용하되, 역량이나 도구가 부족한 슬롯만 Network에서 최소 인원으로 보강합니다.
- 설치와 실행 방법이 명확한 로컬 웹 게임을 완성합니다. 시작, 조작 안내, 점수 또는 진행, 승리/패배 또는 명확한 완료 상태, 재시작을 포함합니다.
- 키보드와 포인터 조작, 일반 데스크톱과 좁은 창, 소리 끄기와 일시정지를 고려합니다.
- 플레이스홀더나 깨진 화면 없이 일관된 시각 디자인과 읽기 쉬운 UI를 만듭니다. 멀티모달 이미지 도구가 실제 연결되어 있으면 필요한 에셋 제작에 사용하고, 없으면 사용했다고 주장하지 않습니다.
- 직접 실행하고 최소 한 판을 플레이 테스트하며 콘솔 오류, 입력, 완료 조건, 재시작을 확인합니다.
- 최종 답변에는 실행 방법, 참여한 에이전트와 역할, 사용한 도구, 멀티모달 사용 여부, 실제 테스트 결과와 남은 제한을 결과 중심으로 보고합니다.`
    : `This is a Game project for producing a complete browser-playable game.

- The controller owns the finished result and verification. It decomposes work into concrete slots, uses the preferred project team first, and recruits the minimum Network help only for a genuine capability or tool gap.
- Finish a local web game with clear install/run instructions, onboarding, controls, score or progression, a win/lose or explicit completion state, and restart.
- Support keyboard and pointer input, ordinary and narrow desktop widths, mute, and pause where appropriate.
- Deliver cohesive, readable visual design without placeholders or broken states. Use a connected multimodal image tool for assets when it is genuinely available; never claim it was used when unavailable.
- Launch the game and play at least one complete round, checking console errors, input, completion conditions, and restart.
- In the final response, report the run command, participating agents and roles, tools used, multimodal usage, actual test results, and remaining limitations in outcome-first language.`;
}

interface PersistedProjectDraft {
  step: DraftStep;
  projectKind: ProjectKind;
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
  const [step, setStep] = useState<DraftStep>("kind");
  const [projectKind, setProjectKind] = useState<ProjectKind>("general");
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
    () => buildProjectRosterSections(agents, firms, cloudListings, hubBookmarks, locale),
    [agents, cloudListings, firms, hubBookmarks, locale],
  );
  const candidateByKey = useMemo(() => {
    const rows = rosterSections.flatMap((section) => [
      ...section.standalone,
      ...section.firms.flatMap((firm) => firm.members),
    ]);
    return new Map(rows.map((candidate) => [candidate.key, candidate]));
  }, [rosterSections]);
  const selectedMemberKeys = useMemo(() => new Set(agentPool.map(projectPoolMemberKey)), [agentPool]);
  const rosterCount = useMemo(() => rosterSections.reduce(
    (sum, section) => sum + section.standalone.length + section.firms.reduce((firmSum, firm) => firmSum + firm.members.length, 0),
    0,
  ), [rosterSections]);

  function recoverMissingBridge(scope: string) {
    setNeedsHelp(true);
    requestOneOperationalRecovery(scope, new Error("Desktop bridge unavailable"));
  }

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(PROJECT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<PersistedProjectDraft>;
      if (draft.step === "kind" || draft.step === "source" || draft.step === "instructions" || draft.step === "agents") setStep(draft.step);
      if (draft.projectKind === "general" || draft.projectKind === "game") setProjectKind(draft.projectKind);
      if (typeof draft.name === "string") setName(draft.name);
      if (typeof draft.nameEdited === "boolean") setNameEdited(draft.nameEdited);
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
      projectKind,
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
  }, [agentPool, draftHydrated, githubUrl, name, nameEdited, projectKind, sampleName, sourceType, step, systemPrompt]);

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
    ]).then(([agentRows, firmRows, mine, bookmarks]) => {
      setAgents(agentRows);
      setFirms(firmRows);
      setCloudListings(mine);
      setHubBookmarks(bookmarks);
    }).catch(() => setNeedsHelp(true));
  }, []);

  function chooseProjectKind(kind: ProjectKind) {
    setProjectKind(kind);
    if (kind === "game") {
      if (sourceType === "sample") setSourceType("local");
      if (!systemPrompt.trim()) setSystemPrompt(gameProjectContract(ko));
    } else if (systemPrompt === gameProjectContract(ko)) {
      setSystemPrompt("");
    }
    setStep("source");
  }

  function addCandidate(candidate: ProjectRosterCandidate) {
    setAgentPool((current) => {
      if (current.some((member) => projectPoolMemberKey(member) === candidate.key)) return current;
      if (!candidate.callable || (current.length === 0 && !candidate.installed)) return current;
      return [...current, candidate.member];
    });
  }

  function addCandidates(candidates: ProjectRosterCandidate[]) {
    setAgentPool((current) => {
      const next = [...current];
      const selected = new Set(next.map(projectPoolMemberKey));
      for (const candidate of candidates) {
        if (!candidate.callable || selected.has(candidate.key) || (next.length === 0 && !candidate.installed)) continue;
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
        requestOneOperationalRecovery("project-create-github", result);
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
    if (!name.trim() || agentPool.length === 0 || busy) return;
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
    ? projectKind === "general" && Boolean(sampleName.trim())
    : sourceType === "github"
      ? Boolean(folderGrant && githubConnectedUrl === githubUrl.trim())
      : Boolean(folderGrant && !githubConnectedUrl);
  const steps: DraftStep[] = ["kind", "source", "instructions", "agents"];

  return (
    <div className="project-create rd">
      <header className="project-create-head titlebar-drag">
        <div>
          <span>{ko ? "새 프로젝트" : "New project"}</span>
          <h1>{ko ? "무엇을 만들지 정하고 팀을 구성하세요" : "Choose what to make and assemble its team"}</h1>
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
          const label = item === "kind"
            ? (ko ? "종류" : "Type")
            : item === "source"
              ? (ko ? "소스" : "Source")
              : item === "instructions"
                ? (ko ? "프로젝트 지시" : "Instructions")
                : (ko ? "조직도" : "Team");
          return (
            <button key={item} type="button" data-active={step === item} disabled={unavailable} onClick={() => setStep(item)}>
              <span>{index + 1}</span>{label}
            </button>
          );
        })}
      </nav>

      <main className="project-create-body titlebar-nodrag">
        {step === "kind" ? (
          <section className="project-create-section">
            <div className="project-create-copy">
              <span className="project-create-kicker">01</span>
              <h2>{ko ? "어떤 프로젝트를 만들까요?" : "What are you making?"}</h2>
              <p>{ko ? "프로젝트 종류에 맞는 작업 기준과 검증 흐름을 준비합니다." : "Agentlas prepares the right work contract and verification flow."}</p>
            </div>
            <div className="project-kind-grid">
              <button type="button" className="project-kind-card" data-selected={projectKind === "general"} onClick={() => chooseProjectKind("general")}>
                <span className="project-kind-icon">⌘</span>
                <strong>{ko ? "일반 프로젝트" : "General project"}</strong>
                <span>{ko ? "앱, 문서, 연구, 운영 등 자유로운 작업" : "Apps, documents, research, operations, and more"}</span>
              </button>
              <button type="button" className="project-kind-card project-kind-card-game" data-selected={projectKind === "game"} onClick={() => chooseProjectKind("game")}>
                <span className="project-kind-icon">◆</span>
                <strong>{ko ? "Game" : "Game"}</strong>
                <span>{ko ? "플레이 가능한 웹 게임과 실제 플레이 테스트" : "A playable web game with real play-testing"}</span>
                <em>{ko ? "게임 제작 기준 포함" : "Game quality contract included"}</em>
              </button>
            </div>
          </section>
        ) : step === "source" ? (
          <section className="project-create-section">
            <div className="project-create-copy">
              <span className="project-create-kicker">02</span>
              <h2>{projectKind === "game" ? (ko ? "게임을 만들 위치를 연결하세요" : "Connect the game workspace") : (ko ? "무엇을 작업할까요?" : "What are we working on?")}</h2>
              <p>{projectKind === "game" ? (ko ? "실행하고 플레이 테스트할 수 있도록 실제 폴더 또는 GitHub 저장소가 필요합니다." : "A real folder or GitHub repository is required so the game can run and be play-tested.") : (ko ? "프로젝트의 기준이 될 소스를 선택합니다." : "Choose the source that grounds this project.")}</p>
            </div>
            <div className="project-source-grid">
              {([
                ["local", ko ? "로컬 폴더" : "Local folder", ko ? "이 Mac에 있는 코드와 파일" : "Code and files on this Mac"],
                ["github", "GitHub", ko ? "저장소 주소로 연결" : "Connect with a repository URL"],
                ...(projectKind === "general" ? [["sample", ko ? "샘플로 시작" : "Start with a sample", ko ? "연결 없이 구조를 먼저 경험" : "Explore the structure without a connection"]] : []),
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
              <button type="button" className="secondary" onClick={() => setStep("kind")}>{ko ? "이전" : "Back"}</button>
              <button type="button" disabled={!sourceReady} onClick={() => setStep("instructions")}>{ko ? "다음" : "Continue"}</button>
            </div>
          </section>
        ) : step === "instructions" ? (
          <section className="project-create-section">
            <div className="project-create-copy">
              <span className="project-create-kicker">03</span>
              <h2>{projectKind === "game" ? (ko ? "게임의 목표를 정하세요" : "Set the game direction") : (ko ? "프로젝트의 기준을 알려주세요" : "Set the project direction")}</h2>
              <p>{projectKind === "game" ? (ko ? "기본 완성도 기준은 준비했습니다. 원하는 장르와 분위기를 더해도 됩니다." : "The completion contract is ready. Add the genre and mood you want.") : (ko ? "이 지시는 프로젝트의 모든 작업에 적용됩니다." : "These instructions apply to every task in this project.")}</p>
            </div>
            <label className="project-field">
              <span>{ko ? "프로젝트 이름" : "Project name"}</span>
              <input value={name} onChange={(event) => { setName(event.target.value); setNameEdited(true); }} autoFocus />
            </label>
            <label className="project-field">
              <span>{ko ? "프로젝트 시스템 프롬프트" : "Project system prompt"}</span>
              <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={projectKind === "game" ? 13 : 8} placeholder={ko ? "예: 기존 디자인 시스템을 유지하고, 변경 후 테스트 결과까지 보여줘." : "e.g. Preserve the design system and show test results after each change."} />
            </label>
            <div className="project-create-actions">
              <button type="button" className="secondary" onClick={() => setStep("source")}>{ko ? "이전" : "Back"}</button>
              <button type="button" disabled={!name.trim()} onClick={() => setStep("agents")}>{ko ? "다음" : "Continue"}</button>
            </div>
          </section>
        ) : (
          <section className="project-create-section project-agent-step">
            <div className="project-create-copy">
              <span className="project-create-kicker">04</span>
              <h2>{ko ? "프로젝트 책임 팀을 정하세요" : "Choose the project controller"}</h2>
              <p>{ko ? `실행 가능한 팀과 에이전트 ${rosterCount}개가 있습니다. 첫 번째 선택이 프로젝트 책임자입니다. 추가 선택은 선호 인력일 뿐이며, 책임자가 매 작업을 나누고 부족한 역량만 Network에서 자동으로 보강합니다.` : `${rosterCount} callable teams and agents are available. Your first choice owns the project. Additional choices are preferences; the controller decomposes each task and recruits from Network only for a real capability gap.`}</p>
            </div>
            <div className="project-agent-workbench project-agent-workbench-org">
              <div className="project-agent-pool project-team-org-create" data-project-agent-pool data-empty={agentPool.length === 0}>
                <div className="project-agent-pool-head"><strong>{ko ? "책임자와 선호 팀" : "Controller and preferences"}</strong><span>{agentPool.length}</span></div>
                {agentPool.length === 0 ? (
                  <div className="project-agent-drop-copy">{ko ? "오른쪽 조직도에서 책임자를 먼저 끌어오세요" : "Drag a controller from the organization tree"}</div>
                ) : (
                  <div className="project-team-create-tree">
                    {agentPool.map((member, index) => {
                      const key = projectPoolMemberKey(member);
                      return (
                        <div
                          className="project-agent-member project-team-create-node"
                          data-project-member-index={index}
                          data-controller={index === 0}
                          data-dragging={draggedMemberKey === key}
                          key={key}
                          draggable={false}
                          onPointerDown={(event) => beginPointerDrag(event, "member", key)}
                          onPointerUp={finishPointerDrag}
                          onPointerCancel={() => { pointerDragRef.current = null; setDraggedMemberKey(null); }}
                        >
                          <span className="project-agent-order">{index === 0 ? "C" : index}</span>
                          <span className="project-team-create-copy"><strong>{member.nameSnapshot}</strong><small>{index === 0 ? (ko ? "책임자 · 프로젝트 컨트롤러" : "Controller · project owner") : (ko ? `${index}순위 선호 인력 · 자동 투입 아님` : `Preference ${index} · not forced into every run`)}</small></span>
                          <span className="project-team-create-actions">
                            <button type="button" disabled={index === 0} aria-label={ko ? "위로 이동" : "Move up"} onClick={() => movePoolMember(key, index - 1)}>↑</button>
                            <button type="button" disabled={index === agentPool.length - 1} aria-label={ko ? "아래로 이동" : "Move down"} onClick={() => movePoolMember(key, index + 1)}>↓</button>
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
                  const count = section.standalone.length + section.firms.reduce((sum, firm) => sum + firm.members.length, 0);
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
                            const addable = firm.members.filter((member) => member.callable && !selectedMemberKeys.has(member.key));
                            return (
                              <div key={firm.id} className="project-roster-firm-create">
                                <div className="project-roster-firm-row-create">
                                  <button type="button" onClick={() => setOpenRosterFirms((current) => ({ ...current, [firm.id]: !firmOpen }))} aria-expanded={firmOpen}>{firmOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}</button>
                                  <IconBuilding size={12} /><strong>{firm.name}</strong><span>{firm.members.length}</span>
                                  <button type="button" disabled={addable.length === 0} onClick={() => addCandidates(addable)}>{ko ? "팀 추가" : "Add team"}</button>
                                </div>
                                {firmOpen ? <div className="project-roster-children-create">{firm.members.map((candidate) => (
                                  <RosterCandidateButton key={candidate.key} candidate={candidate} ko={ko} selected={selectedMemberKeys.has(candidate.key)} requiresController={!candidate.installed && agentPool.length === 0} dragging={draggedCandidateKey === candidate.key} onAdd={addCandidate} onPointerDown={beginPointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={() => { pointerDragRef.current = null; setDraggedCandidateKey(null); }} />
                                ))}</div> : null}
                              </div>
                            );
                          })}
                          <div className="project-roster-standalone-create">{section.standalone.map((candidate) => (
                            <RosterCandidateButton key={candidate.key} candidate={candidate} ko={ko} selected={selectedMemberKeys.has(candidate.key)} requiresController={!candidate.installed && agentPool.length === 0} dragging={draggedCandidateKey === candidate.key} onAdd={addCandidate} onPointerDown={beginPointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={() => { pointerDragRef.current = null; setDraggedCandidateKey(null); }} />
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
              <button type="button" disabled={agentPool.length === 0 || busy} onClick={() => void submit()}>{busy ? (ko ? "만드는 중…" : "Creating…") : (ko ? "프로젝트 만들기" : "Create project")}</button>
            </div>
          </section>
        )}

        {needsHelp ? <aside className="project-help-slot" aria-live="polite"><div data-one-content-slot data-capability="project-create-recovery" /></aside> : null}
      </main>
    </div>
  );
}

function RosterCandidateButton({
  candidate,
  ko,
  selected,
  requiresController,
  dragging,
  onAdd,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
}: {
  candidate: ProjectRosterCandidate;
  ko: boolean;
  selected: boolean;
  requiresController: boolean;
  dragging: boolean;
  onAdd: (candidate: ProjectRosterCandidate) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, kind: "candidate", id: string) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}) {
  const disabled = selected || requiresController || !candidate.callable;
  const helper = selected
    ? (ko ? "프로젝트에 추가됨" : "Added to project")
    : !candidate.callable
      ? (ko ? "조직 역할 · 팀 책임자를 통해 실행" : "Organization role · runs through its team controller")
    : requiresController
      ? (ko ? "설치된 책임자를 먼저 선택하세요" : "Choose an installed controller first")
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
