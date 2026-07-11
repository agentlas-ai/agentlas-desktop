// 회사 상세 — 접고 펴기 가능한 왼쪽 사이드바 조직도 + 오른쪽 에이전트 상세 통제 센터 (메모리 큐레이션, 프롬프트 에디터, 스킬 주입, 클라우드 싱크)
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { ipc } from "@/lib/ipc";
import { mapWithConcurrency } from "@/lib/concurrency";
import { isUserFacingAgentText } from "@/lib/agent-visibility";
import { buildAgentRoster, isRosterVisibleAgent, visibleRosterAgents } from "@/lib/agent-roster";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { AgentMemorySaveQueue, parseMemoryMarkdown, type ParsedMemory } from "@/lib/agent-memory";
import { classifyAgent } from "@/lib/ownership";
import { cliModelTagLabel } from "@shared/models";
import type { AgentEvolutionProposalUi, AgentMemoryEntryUi } from "@shared/types";
import type {
  AgentRuntimeOverride,
  AgentRuntimeOverrideScope,
  AgentGroupResolved,
  Chat,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  ResolvedOrg,
  ResolvedNode,
  RuntimeSelection,
  RuntimeStatus,
  WorkspaceNode,
} from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  IconBuilding,
  IconChat,
  IconTrash,
  IconChevronRight,
  IconChevronDown,
  IconSidebar,
  IconBrain,
  IconShield,
  IconCheck,
  IconWand,
  IconLayers,
  IconEdit,
  IconClose,
  IconPlus,
  IconFileUp,
  IconPaperclip,
  IconRoute,
} from "@/components/Icon";

type ManageView = "general" | "published";

// ── 런타임 durable 메모리(큐레이터 DB) 표시 헬퍼 ──
// createdAt(ISO) → 타임라인 timestamp 자리의 상대시간. 오래된 항목은 채팅 목록과 동일한 toLocaleString 포맷 폴백.
function formatMemoryEntryTime(iso: string, locale: Locale): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return locale === "ko" ? "방금 전" : "just now";
  if (diffMin < 60) return locale === "ko" ? `${diffMin}분 전` : `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return locale === "ko" ? `${diffHour}시간 전` : `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return locale === "ko" ? `${diffDay}일 전` : `${diffDay}d ago`;
  return new Date(ts).toLocaleString(locale === "en" ? "en-US" : "ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
}

// DB kind(raw 문자열) → 기존 타임라인 colorMap 타입 매핑. 미지의 kind 는 sync 색으로 안전 강등.
function memoryKindToTimelineType(kind: string): "skill" | "sync" | "evolution" | "resolve" {
  const k = (kind || "").toLowerCase();
  if (k === "decision") return "resolve";
  if (k === "gotcha") return "evolution";
  if (k === "procedure") return "skill";
  return "sync";
}

// 신뢰도 배지 색 — high=green, medium=amber, low=muted.
function memoryConfidenceColor(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return "var(--green-deep)";
  if (confidence === "medium") return "var(--amber-deep)";
  return "var(--muted-deep)";
}

const rosterNameStyle: CSSProperties = {
  display: "-webkit-box",
  overflow: "hidden",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  lineHeight: 1.22,
};

function readableRoleLabel(role: string | undefined, displayName: string, agentSlug?: string): string | null {
  const label = role?.trim();
  if (!label) return null;
  const normalized = label.toLowerCase();
  if (normalized === displayName.trim().toLowerCase()) return null;
  if (agentSlug && normalized === agentSlug.toLowerCase()) return null;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(normalized)) return null;
  return label;
}

// 프롬프트 진화 후보로 승격 가능한 DB kind — 규칙성 있는 학습만(사실/가설 제외).
const EVOLUTION_CANDIDATE_KINDS = new Set(["decision", "gotcha", "procedure"]);

export default function LibraryAgentsPage() {
  return (
    <Suspense fallback={null}>
      <LibraryAgentsView />
    </Suspense>
  );
}

function LibraryAgentsView() {
  
  const { t, locale } = useT();
  const searchParams = useSearchParams();
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [firmCollapsed, setFirmCollapsed] = useState<Record<string, boolean>>({});
  const [teamExpanded, setTeamExpanded] = useState<Record<string, boolean>>({});
  const [teamSubs, setTeamSubs] = useState<Record<string, { name: string; role: string }[] | "loading">>({});
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const rosterRefreshGenerationRef = useRef(0);
  const [chats, setChats] = useState<Chat[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [resolvedOrgs, setResolvedOrgs] = useState<Record<string, ResolvedOrg>>({});
  const [agentGroups, setAgentGroups] = useState<AgentGroupResolved[]>([]);
  const [runtimeStatuses, setRuntimeStatuses] = useState<RuntimeStatus[]>([]);
  const [runtimeOverrides, setRuntimeOverrides] = useState<AgentRuntimeOverride[]>([]);

  // 왼쪽 조직도 패널 너비 & 접기 상태 (localStorage 영속)
  const [orgWidth, setOrgWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 좌측 로스터 탭 — 멀티(에이전트 팀=firm) / 싱글(개별 에이전트). 대시보드 조직도와 동일한 분리.
  const [rosterTab, setRosterTab] = useState<"multi" | "single">("multi");

  // 선택된 에이전트 노드 (null 이면 회사 오버뷰 노출)
  const [selectedNode, setSelectedNode] = useState<ResolvedNode | null>(null);
  const [activeTab, setActiveTab] = useState<"identity" | "memory" | "playbook" | "activity">("identity");
  const targetAgentId = searchParams.get("agentId") ?? "";
  const targetNodeId = searchParams.get("nodeId") ?? "";
  const targetFirmId = searchParams.get("firmId") ?? "";
  const manageView: ManageView = searchParams.get("view") === "published" ? "published" : "general";
  const [publishedAgents, setPublishedAgents] = useState<MarketplaceListing[]>([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedSignedIn, setPublishedSignedIn] = useState<boolean | null>(null);
  const [publishedInstalling, setPublishedInstalling] = useState<string | null>(null);

  // 파일 핸들링 및 상태
  const [agentFiles, setAgentFiles] = useState<WorkspaceNode[]>([]);
  // 런타임 durable 메모리(큐레이터가 실행 후 DB에 적재) — memory.md 와 별개의 실측 학습 소스.
  const [memoryEntries, setMemoryEntries] = useState<AgentMemoryEntryUi[]>([]);
  const [evolutionProposals, setEvolutionProposals] = useState<AgentEvolutionProposalUi[]>([]);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryParsed, setMemoryParsed] = useState<ParsedMemory>({ decisions: [], gotchas: [], openQuestions: [] });
  const memorySaveQueueRef = useRef(new AgentMemorySaveQueue());
  const selectedMemoryAgentRef = useRef<string | null>(null);

  const [promptContent, setPromptContent] = useState("");
  const [promptSourcePath, setPromptSourcePath] = useState("");
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [savingFiles, setSavingFiles] = useState(false);

  // 스킬 주입 서랍 (Skill Evolution Drawer)
  // 하드코딩 목록이 아니라 엔진 skills/ 디렉토리를 실제로 스캔한 카탈로그를 쓴다(실측 원칙).
  const [skillDrawerOpen, setSkillDrawerOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<{ slug: string; name: string; description: string }[]>([]);
  useEffect(() => {
    ipc()?.skills?.listCatalog?.()
      .then((list) => setAvailableSkills(list ?? []))
      .catch(() => setAvailableSkills([]));
  }, []);

  // 온톨로지 인박스 — 실제 보류 중인 학습 제안만 표출(가짜 데이터 없음).
  // selectedNode 의 메모리 미결 과제(openQuestions)에서 도출 → 정식 규칙 승격 후보.
  const [ontologyInbox, setOntologyInbox] = useState<
    { id: string; type: "gotcha" | "decision"; title: string; content: string; source: "local" | "cloud" }[]
  >([]);

  // 허브 연동 글로벌 알림용 토스트 상태
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    try {
      const w = parseInt(window.localStorage.getItem("agentlas.firm.orgWidth") ?? "", 10);
      if (Number.isFinite(w) && w >= 200 && w <= 500) setOrgWidth(w);
      const c = window.localStorage.getItem("agentlas.firm.sidebarCollapsed") === "true";
      setSidebarCollapsed(c);
    } catch {
      // ignore
    }
  }, []);

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem("agentlas.firm.sidebarCollapsed", String(next));
    } catch {
      // ignore
    }
  };

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (sidebarCollapsed) return;
      const startX = e.clientX;
      const startW = orgWidth;
      let finalW = startW;
      function onMove(ev: MouseEvent) {
        const dx = ev.clientX - startX; // 좌측에서 우측으로 확장
        finalW = Math.max(200, Math.min(500, startW + dx));
        setOrgWidth(finalW);
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          window.localStorage.setItem("agentlas.firm.orgWidth", String(finalW));
        } catch {
          // ignore
        }
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    },
    [orgWidth, sidebarCollapsed],
  );

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const generation = ++rosterRefreshGenerationRef.current;
    const [fList, agList, runtimes, overrides, groupRows] = await Promise.all([
      api.firms.list(),
      api.team.list(),
      api.runtime.detect().catch(() => []),
      api.agentRuntime?.list ? api.agentRuntime.list().catch(() => []) : Promise.resolve([]),
      api.agentGroups?.listResolved ? api.agentGroups.listResolved().catch(() => []) : Promise.resolve([]),
    ]);
    if (rosterRefreshGenerationRef.current !== generation) return;
    setFirms(fList);
    setAgents(visibleRosterAgents(agList));
    setAgentGroups(groupRows);
    setRuntimeStatuses(runtimes);
    setRuntimeOverrides(overrides);

    // 순차 for-await(20개면 ~4s 프리즈) → 동시성 3 병렬. 실패/null firm 은 기존처럼 누락(worker 내부 try/catch 로 null 반환). 순서 보존.
    const orgs: Record<string, ResolvedOrg> = {};
    const orgPairs = await mapWithConcurrency(fList, 3, async (f) => {
      try {
        const o = await api.firms.getResolvedOrg(f.id);
        return o ? ([f.id, o] as const) : null;
      } catch {
        return null;
      }
    });
    if (rosterRefreshGenerationRef.current !== generation) return;
    for (const pair of orgPairs) {
      if (pair) orgs[pair[0]] = pair[1];
    }
    setResolvedOrgs(orgs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onAgentRosterChange((change) => {
        // Do not wait for the slower firm/org resolution pass before showing a
        // just-built local agent under My Agents.
        setAgents((previous) =>
          visibleRosterAgents([change.agent, ...previous.filter((agent) => agent.id !== change.agent.id)]),
        );
        setRosterTab((change.agent.kind ?? "agent") === "team" ? "multi" : "single");
        void refresh();
      }),
    [refresh],
  );

  const loadPublishedAgents = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setPublishedLoading(true);
    try {
      const session = await api.auth.getSession();
      setPublishedSignedIn(session.signedIn);
      if (!session.signedIn) {
        setPublishedAgents([]);
        return;
      }
      setPublishedAgents(await api.marketplace.listMine());
    } catch {
      setPublishedAgents([]);
    } finally {
      setPublishedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (manageView === "published") void loadPublishedAgents();
  }, [loadPublishedAgents, manageView]);

  async function signInForPublishedAgents() {
    const api = ipc();
    if (!api) return;
    setPublishedLoading(true);
    try {
      const session = await api.auth.signInWithGoogle();
      setPublishedSignedIn(session.signedIn);
      if (session.signedIn) await loadPublishedAgents();
    } finally {
      setPublishedLoading(false);
    }
  }

  async function installPublishedAgent(slug: string) {
    const api = ipc();
    if (!api) return;
    setPublishedInstalling(slug);
    try {
      const installed = await api.team.installMine(slug);
      await refresh();
      const loc = pickLocalized(installed, locale);
      setSelectedNode({
        id: installed.id,
        name: loc.name,
        role: loc.tagline || installed.slug,
        agentId: installed.id,
      });
      setActiveTab("identity");
      showToast(locale === "ko" ? `${loc.name} 설치 완료` : `Installed ${loc.name}`);
    } catch (err) {
      showToast((locale === "ko" ? "퍼블리시 에이전트 설치 실패: " : "Failed to install published agent: ") + String(err));
    } finally {
      setPublishedInstalling(null);
    }
  }

  function openInstalledAgent(agent: InstalledAgent) {
    const loc = pickLocalized(agent, locale);
    setSelectedNode({
      id: agent.id,
      name: loc.name,
      role: loc.tagline || agent.slug,
      agentId: agent.id,
    });
    setActiveTab("identity");
  }

  useEffect(() => {
    if (!targetAgentId && !targetNodeId) return;
    const target = findAgentRouteNode({
      agentId: targetAgentId,
      nodeId: targetNodeId,
      firmId: targetFirmId,
      firms,
      agents,
      resolvedOrgs,
      locale,
    });
    if (!target) return;
    setSelectedNode((current) => {
      if (current?.id === target.id && current.agentId === target.agentId) return current;
      return target;
    });
    setActiveTab("identity");
    if (targetFirmId) {
      setFirmCollapsed((prev) => ({ ...prev, [targetFirmId]: false }));
    }
  }, [agents, firms, locale, resolvedOrgs, targetAgentId, targetFirmId, targetNodeId]);

  // 에이전트 선택 변경 시 파일 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !selectedNode || !selectedNode.agentId) {
      selectedMemoryAgentRef.current = null;
      setAgentFiles([]);
      setMemoryContent("");
      setMemoryParsed({ decisions: [], gotchas: [], openQuestions: [] });
      setPromptContent("");
      setPromptSourcePath("");
      setPromptDraft("");
      setEditingPrompt(false);
      return;
    }
    selectedMemoryAgentRef.current = selectedNode.agentId;

    let cancelled = false;
    async function loadAgentAssets() {
      if (!selectedNode?.agentId || !api) return;
      // 메타데이터 systemPrompt를 먼저 기본값으로 — 파일 로드가 실패해도 "내용 없음"이 되지 않게.
      const curAgent = agents.find((a) => a.id === selectedNode.agentId);
      if (curAgent?.systemPrompt?.trim()) {
        setPromptContent(curAgent.systemPrompt);
        setPromptDraft(curAgent.systemPrompt);
      }
      try {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        if (cancelled) return;
        const fileEntries = listing.entries.filter((e) => e.kind === "file");
        setAgentFiles(fileEntries);

        // memory.md 탐색 및 로드
        const memFile = fileEntries.find((e) => e.name.toLowerCase() === "memory.md");
        if (memFile) {
          const m = await api.agentFiles.read(selectedNode.agentId, memFile.path);
          if (cancelled) return;
          const parsed = parseMemoryMarkdown(m.content);
          const visible = memorySaveQueueRef.current.hydrate(selectedNode.agentId, parsed, m.content);
          setMemoryContent(m.content);
          setMemoryParsed(visible);
        } else {
          const empty: ParsedMemory = { decisions: [], gotchas: [], openQuestions: [] };
          const visible = memorySaveQueueRef.current.hydrate(selectedNode.agentId, empty, "");
          setMemoryContent("");
          setMemoryParsed(visible);
        }

        // Import/restore/runtime과 동일한 main-owned canonical resolver.
        const promptSource = await api.agentFiles.promptSource(selectedNode.agentId);
        if (cancelled) return;
        setPromptSourcePath(promptSource?.relativePath ?? "");
        if (promptSource) {
          setPromptContent(promptSource.content);
          setPromptDraft(promptSource.content);
        }
      } catch (e) {
        // 파일 로드 실패 시에도 위에서 설정한 메타데이터 프롬프트가 남아있다.
        console.error("에이전트 파일 로드 실패:", e);
      }
    }

    void loadAgentAssets();
    return () => {
      cancelled = true;
    };
  }, [selectedNode, agents]);

  // 런타임 durable 메모리(큐레이터 DB) 로드 — 파일 로드와 독립·비차단, 에이전트 전환 시 취소.
  useEffect(() => {
    const api = ipc();
    if (!api || !selectedNode?.agentId) {
      setMemoryEntries([]);
      return;
    }
    let cancelled = false;
    setMemoryEntries([]);
    // 구버전 preload(agentMemory 미노출)에서도 죽지 않게 옵셔널 호출.
    Promise.resolve(api.agentMemory?.entries?.(selectedNode.agentId, 100))
      .then((rows) => {
        if (!cancelled) setMemoryEntries(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setMemoryEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  useEffect(() => {
    const api = ipc();
    if (!api || !selectedNode?.agentId) {
      setEvolutionProposals([]);
      return;
    }
    let cancelled = false;
    setEvolutionProposals([]);
    Promise.resolve(api.agentEvolution?.list?.(selectedNode.agentId, 50))
      .then((rows) => {
        if (!cancelled) setEvolutionProposals(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setEvolutionProposals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);


  // 프롬프트 수정 반영
  async function savePrompt() {
    const proposal = await createEvolutionProposal(promptDraft, {
      changeOrigin: "manual_prompt_editor",
    });
    if (!proposal) return;
    setEditingPrompt(false);
    setActiveTab("activity");
  }

  // 후보 생성은 파일을 쓰지 않는다. 승인/적용은 아래 별도 사용자 액션에서만 수행한다.
  async function createEvolutionProposal(
    newPromptContent: string,
    source: Record<string, unknown> = {},
  ): Promise<AgentEvolutionProposalUi | undefined> {
    const api = ipc();
    if (!api || !selectedNode || !selectedNode.agentId) return;
    setSavingFiles(true);
    try {
      if (!promptSourcePath) throw new Error(locale === "ko" ? "런타임 프롬프트 원본 파일을 찾지 못했습니다." : "The runtime prompt source file could not be found.");
      const path = promptSourcePath;
      const proposal = await api.agentEvolution.createProposal({
        agentId: selectedNode.agentId,
        targetPath: path,
        currentContent: promptContent,
        proposedContent: newPromptContent,
        proposalType: "rule",
        risk: "medium",
        summary: locale === "ko" ? "프롬프트 진화 검토 후보" : "Prompt evolution review candidate",
        source: { ...source, surface: "desktop.library.agent_detail" },
        decisionNote: locale === "ko" ? "사용자가 검토 후보를 만들었습니다. 아직 적용되지 않았습니다." : "User created a review candidate. It is not applied yet.",
      });
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      showToast(locale === "ko" ? "검토 후보를 저장했습니다. 원본 프롬프트는 아직 바뀌지 않았습니다." : "Review candidate saved. The original prompt is unchanged.");
      return proposal;
    } catch (e) {
      showToast((locale === "ko" ? "진화 후보 생성 실패: " : "Failed to create evolution candidate: ") + String(e));
      return undefined;
    } finally {
      setSavingFiles(false);
    }
  }

  async function createSkillEvolutionProposal(skill: { slug?: string; name: string; description: string }): Promise<boolean> {
    const api = ipc();
    if (!api || !selectedNode?.agentId) return false;
    const slug = (skill.slug ?? skill.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const targetPath = `skills/${slug}/SKILL.md`;
    setSavingFiles(true);
    try {
      const catalogAsset = await api.skills.readCatalog(slug);
      const current = await api.agentFiles.read(selectedNode.agentId, targetPath).catch(() => ({ content: "" }));
      const proposal = await api.agentEvolution.createProposal({
        agentId: selectedNode.agentId,
        targetPath,
        currentContent: current.content ?? "",
        proposedContent: catalogAsset.content,
        proposalType: "skill",
        risk: "medium",
        summary: locale === "ko" ? `${skill.name} 수동 스킬 주입 검토` : `Review manual ${skill.name} skill injection`,
        source: {
          surface: "desktop.library.skill_catalog",
          skillSlug: catalogAsset.slug,
          catalogContentHash: catalogAsset.contentHash,
          catalogByteLength: catalogAsset.byteLength,
        },
        decisionNote: locale === "ko" ? "사용자가 스킬 후보를 만들었습니다. 아직 파일은 생성되지 않았습니다." : "User created a skill candidate. No file has been created yet.",
      });
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      setSkillDrawerOpen(false);
      setActiveTab("activity");
      showToast(locale === "ko" ? "스킬 diff 후보를 만들었습니다. 승인 전에는 주입되지 않습니다." : "Skill diff candidate created. It is not injected until approval.");
      return true;
    } catch (error) {
      showToast((locale === "ko" ? "스킬 후보 생성 실패: " : "Failed to create skill candidate: ") + String(error));
      return false;
    } finally {
      setSavingFiles(false);
    }
  }

  async function approveEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    setSavingFiles(true);
    try {
      const proposal = await api.agentEvolution.approveAndApply(
        proposalId,
        locale === "ko" ? "사용자가 diff와 해시를 검토하고 승인했습니다." : "User reviewed the diff and hashes, then approved.",
      );
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      if (proposal.proposalType === "rule") {
        setPromptContent(proposal.afterContent);
        setPromptDraft(proposal.afterContent);
      } else if (proposal.proposalType === "skill" && selectedNode?.agentId) {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        setAgentFiles(listing.entries.filter((entry) => entry.kind === "file"));
      }
      const receipt = proposal.receipts.find((item) => item.action === "apply");
      showToast(receipt
        ? proposal.proposalType === "skill"
          ? (locale === "ko" ? `스킬 주입 완료 · 자산 v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}` : `Skill injected · asset v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}`)
          : (locale === "ko" ? `적용 완료 · 자산 v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}` : `Applied · asset v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}`)
        : (locale === "ko" ? "적용은 완료됐지만 영수증을 확인할 수 없습니다." : "Applied, but no receipt was returned."));
    } catch (e) {
      showToast((locale === "ko" ? "승인 적용 실패: " : "Approval/apply failed: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  async function rejectEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    setSavingFiles(true);
    try {
      const proposal = await api.agentEvolution.reject(
        proposalId,
        locale === "ko" ? "사용자가 검토 후 거절했습니다." : "User rejected after review.",
      );
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      setPromptDraft(proposal.beforeContent);
      showToast(locale === "ko" ? "후보를 거절했습니다. 파일은 변경되지 않았습니다." : "Candidate rejected. No file was changed.");
    } catch (e) {
      showToast((locale === "ko" ? "후보 거절 실패: " : "Failed to reject candidate: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  async function rollbackEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    setSavingFiles(true);
    try {
      const proposal = await api.agentEvolution.rollback(proposalId);
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      if (proposal.proposalType === "rule") {
        setPromptContent(proposal.beforeContent);
        setPromptDraft(proposal.beforeContent);
      } else if (proposal.proposalType === "skill" && selectedNode?.agentId) {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        setAgentFiles(listing.entries.filter((entry) => entry.kind === "file"));
      }
      const receipt = proposal.receipts.find((item) => item.action === "rollback");
      showToast(receipt
        ? proposal.proposalType === "skill"
          ? (locale === "ko" ? `스킬 제거 롤백 완료 · 자산 v${receipt.versionAfter}` : `Skill removal rollback complete · asset v${receipt.versionAfter}`)
          : (locale === "ko" ? `롤백 완료 · 자산 v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}` : `Rolled back · asset v${receipt.versionAfter} · ${receipt.governedAssetHashAfter.slice(0, 12)}`)
        : (locale === "ko" ? "롤백 완료" : "Rollback complete"));
    } catch (e) {
      showToast((locale === "ko" ? "롤백 차단/실패: " : "Rollback blocked/failed: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  // 공용 per-agent 저장 큐가 React 렌더보다 먼저 최신 상태를 누적하고, 각 에이전트의
  // durable 원문을 기준으로 직렬화한다. 빠른 토글과 에이전트 전환이 서로 덮어쓰지 않는다.
  function saveMemory(updater: (prev: typeof memoryParsed) => typeof memoryParsed) {
    const agentId = selectedNode?.agentId;
    const api = ipc();
    if (!agentId || !api) return Promise.resolve();
    const memFile = agentFiles.find((entry) => entry.name.toLowerCase() === "memory.md");
    const path = memFile?.path ?? "memory.md";
    const { completion } = memorySaveQueueRef.current.enqueue({
      agentId,
      updater,
      locale,
      write: async (serialized) => { await api.agentFiles.write(agentId, path, serialized); },
      onOptimistic: (next) => {
        if (selectedMemoryAgentRef.current === agentId) setMemoryParsed(next);
      },
      onDurable: (_next, serialized) => {
        if (selectedMemoryAgentRef.current === agentId) setMemoryContent(serialized);
      },
      onRollback: (durable) => {
        if (selectedMemoryAgentRef.current === agentId) setMemoryParsed(durable);
      },
      onPendingChange: (pending) => {
        if (selectedMemoryAgentRef.current === agentId) setSavingFiles(pending);
      },
    });
    return completion.catch((error) => {
      if (selectedMemoryAgentRef.current === agentId) {
        showToast((locale === "ko" ? "메모리 갱신 실패: " : "Failed to update memory: ") + String(error));
      }
    });
  }

  function showToast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  }

  async function importAgentFolder() {
    const api = ipc();
    if (!api || importBusy) return;
    setImportBusy(true);
    try {
      const dir = await api.fs.pickDirectory();
      if (!dir) return;
      const imported = await api.team.importLocalFolder({ path: dir.path, scope: dir.scope });
      await refresh();
      const loc = pickLocalized(imported, locale);
      setSelectedNode({
        id: imported.id,
        name: loc.name,
        role: loc.tagline || imported.slug,
        agentId: imported.id,
      });
      setActiveTab("identity");
      showToast(locale === "ko" ? `${loc.name} 가져오기 완료` : `Imported ${loc.name}`);
    } catch (err) {
      showToast((locale === "ko" ? "에이전트 가져오기 실패: " : "Import failed: ") + String(err));
    } finally {
      setImportBusy(false);
    }
  }

  async function removeInstalledAgent(agent: InstalledAgent | null) {
    const api = ipc();
    if (!api || !agent) return;
    const loc = pickLocalized(agent, locale);
    if (!window.confirm(locale === "ko" ? `'${loc.name}' 에이전트를 설치 목록에서 제거할까요? 원본 폴더는 삭제하지 않습니다.` : `Remove '${loc.name}' from installed agents? The source folder will not be deleted.`)) return;
    try {
      await api.team.uninstall(agent.id);
      setSelectedNode(null);
      await refresh();
      showToast(locale === "ko" ? "에이전트를 설치 목록에서 제거했습니다." : "Agent removed from installed agents.");
    } catch (err) {
      showToast((locale === "ko" ? "에이전트 제거 실패: " : "Failed to remove agent: ") + String(err));
    }
  }

  const roster = useMemo(() => buildAgentRoster(agents, firms), [agents, firms]);
  const agentMap = roster.agentById;

  // 팀 에이전트 펼치기 — 하위 서브에이전트를 백엔드(즉시 결정적 + 백그라운드 LLM)로 해석.
  const toggleTeam = useCallback(
    async (agentId: string) => {
      setTeamExpanded((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
      if (teamSubs[agentId] !== undefined) return; // 이미 로드됨/로딩중
      const api = ipc();
      if (!api?.team?.resolveSubAgents) return;
      setTeamSubs((prev) => ({ ...prev, [agentId]: "loading" }));
      try {
        const res = await api.team.resolveSubAgents(agentId);
        setTeamSubs((prev) => ({ ...prev, [agentId]: res?.subAgents ?? [] }));
      } catch {
        setTeamSubs((prev) => ({ ...prev, [agentId]: [] }));
      }
    },
    [teamSubs],
  );
  const installedAgentSlugs = new Set(agents.map((a) => a.slug));
  const selectedContext = useMemo(
    () => (selectedNode ? findSelectedNodeContext(selectedNode, firms, resolvedOrgs) : null),
    [selectedNode, firms, resolvedOrgs],
  );

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* 1. 왼쪽 접이식 사이드바 (조직도 구성) */}
      <aside
        className="glass-thin"
        data-tour-id="agents.roster"
        style={{
          position: "relative",
          width: sidebarCollapsed ? 64 : orgWidth,
          flexShrink: 0,
          borderRight: "1px solid var(--glass-border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          height: "100%",
          transition: "width 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <header
          style={{
            padding: sidebarCollapsed ? "16px 0" : "14px 16px 10px",
            borderBottom: "1px solid var(--glass-border)",
            display: "flex",
            flexDirection: "column",
            alignItems: sidebarCollapsed ? "center" : "stretch",
            gap: 8,
          }}
        >
          {sidebarCollapsed ? (
            <button onClick={() => setSelectedNode(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--accent)" }}>
              <IconBuilding size={20} />
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%" }}>
              <div
                onClick={() => setSelectedNode(null)}
                style={{ flex: 1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
              >
                <IconLayers size={14} style={{ color: "var(--accent)" }} />
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {locale === "ko" ? "내 에이전트" : "My Agents"}
                </div>
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void importAgentFolder();
                }}
                disabled={importBusy}
                className="titlebar-nodrag"
                data-tour-id="agents.import"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minHeight: 30,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: "1px solid var(--paper-edge)",
                  background: "var(--paper)",
                  color: "var(--ink)",
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: importBusy ? "default" : "pointer",
                  opacity: importBusy ? 0.62 : 1,
                  flexShrink: 0,
                }}
              >
                <IconFileUp size={13} />
                {importBusy ? (locale === "ko" ? "가져오는 중" : "Importing") : locale === "ko" ? "가져오기" : "Import"}
              </button>
            </div>
          )}
        </header>

        {!sidebarCollapsed && (
          <div className="library-roster-tabs">
            {(["general", "published"] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => navigate(`/library/agents?view=${view}`)}
                className="library-roster-tab"
                data-active={manageView === view ? "true" : "false"}
              >
                {view === "general"
                  ? locale === "ko" ? "일반 에이전트" : "Regular agents"
                  : locale === "ko" ? "퍼블리시한 에이전트" : "Published agents"}
              </button>
            ))}
          </div>
        )}

        {/* 멀티/싱글 로스터 탭 (일반 에이전트 안에서만 표시) */}
        {manageView === "general" && !sidebarCollapsed && (
          <div className="library-roster-tabs">
            {(["multi", "single"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRosterTab(tab)}
                className="library-roster-tab"
                data-active={rosterTab === tab ? "true" : "false"}
              >
                {tab === "multi"
                  ? locale === "ko" ? "멀티 · 에이전트 팀" : "Multi · teams"
                  : locale === "ko" ? "싱글 · 에이전트" : "Single · agents"}
              </button>
            ))}
          </div>
        )}

        {/* 조직도 목록 */}
        <div style={{ flex: 1, overflowY: "auto", padding: sidebarCollapsed ? "12px 6px" : 12 }}>
          {manageView === "published" ? (
            <PublishedAgentsRoster
              items={publishedAgents}
              loading={publishedLoading}
              signedIn={publishedSignedIn}
              installedSlugs={installedAgentSlugs}
              installedAgents={agents}
              installingSlug={publishedInstalling}
              collapsed={sidebarCollapsed}
              locale={locale}
              onSignIn={() => void signInForPublishedAgents()}
              onInstall={(slug) => void installPublishedAgent(slug)}
              onOpen={openInstalledAgent}
            />
          ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {(sidebarCollapsed || rosterTab === "multi") && agentGroups.length > 0 && (
              <div>
                {!sidebarCollapsed && (
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 8 }}>
                    {locale === "ko" ? "에이전트 조합" : "Agent groups"}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: sidebarCollapsed ? 0 : 12, alignItems: sidebarCollapsed ? "center" : "stretch" }}>
                  {agentGroups.map((group) => {
                    if (sidebarCollapsed) {
                      return (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() => navigate("/library/agent-groups")}
                          title={group.name}
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 10,
                            border: group.warningCount ? "1px solid var(--amber-deep)" : "1px solid var(--paper-edge)",
                            background: group.warningCount ? "var(--peach-soft)" : "var(--fill-1)",
                            color: group.warningCount ? "var(--amber-deep)" : "var(--accent-strong)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                          }}
                        >
                          <IconLayers size={16} />
                        </button>
                      );
                    }
                    return (
                      <button
                        key={group.id}
                        type="button"
                        onClick={() => navigate("/library/agent-groups")}
                        style={{
                          width: "100%",
                          display: "grid",
                          gridTemplateColumns: "auto minmax(0, 1fr) auto",
                          alignItems: "center",
                          gap: 9,
                          padding: "8px 10px",
                          borderRadius: "var(--radius-md)",
                          border: group.warningCount ? "1px solid var(--amber-deep)" : "1px solid var(--paper-edge)",
                          background: group.warningCount ? "var(--peach-soft)" : "var(--paper)",
                          color: "var(--ink)",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 8,
                            background: "var(--fill-1)",
                            color: "var(--accent-strong)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <IconLayers size={14} />
                        </span>
                        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                          <strong style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.name}</strong>
                          <small style={{ fontSize: 11, color: "var(--muted-deep)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {group.orchestratorName}
                          </small>
                        </span>
                        <span style={{ fontSize: 10, fontWeight: 800, color: group.warningCount ? "var(--amber-deep)" : "var(--muted-deep)" }}>
                          {group.warningCount ? "!" : group.members.length}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {(sidebarCollapsed || rosterTab === "multi") && roster.multiFirms.map(firm => {
              const rOrg = resolvedOrgs[firm.id];
              const fLoc = pickLocalized(firm, locale);
              const isCollapsed = firmCollapsed[firm.id];
              return (
                <div key={firm.id}>
                  {!sidebarCollapsed && (
                    <div
                      onClick={() => setFirmCollapsed(prev => ({ ...prev, [firm.id]: !isCollapsed }))}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", borderRadius: "var(--radius-sm)", background: "var(--paper-2)", marginBottom: 8, minWidth: 0 }}
                    >
                      <IconChevronDown size={14} style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.2s" }} />
                      <IconBuilding size={14} style={{ color: "var(--accent)" }} />
                      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fLoc.name}</span>
                    </div>
                  )}
                  {(!isCollapsed || sidebarCollapsed) && (
                    sidebarCollapsed ? (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                        {rOrg ? (
                          <>
                            {isVisibleResolvedNode(rOrg.ceo, agentMap) && (
                              <MiniNodeAvatar node={rOrg.ceo} active={selectedNode?.id === rOrg.ceo.id} onClick={() => { setSelectedNode(rOrg.ceo); setActiveTab("identity"); }} />
                            )}
                            {rOrg.divisions
                              .filter((d) => isVisibleResolvedNode(d, agentMap) || d.specialists.some((s) => isVisibleResolvedNode(s, agentMap)))
                              .map((d) => (
                              <div key={d.id} style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                                {isVisibleResolvedNode(d, agentMap) && (
                                  <MiniNodeAvatar node={d} active={selectedNode?.id === d.id} onClick={() => { setSelectedNode(d); setActiveTab("identity"); }} />
                                )}
                                {d.specialists.filter((s) => isVisibleResolvedNode(s, agentMap)).map((s) => (
                                  <MiniNodeAvatar key={s.id} node={s} active={selectedNode?.id === s.id} onClick={() => { setSelectedNode(s); setActiveTab("identity"); }} />
                                ))}
                              </div>
                            ))}
                          </>
                        ) : (
                          firm.orgChart.filter((n) => isVisibleFirmOrgNode(n, agentMap)).map((n) => {
                            const agent = agentMap.get(n.agentId);
                            return (
                              <MiniNodeAvatar
                                key={n.agentSlug}
                                node={{ name: agent ? pickLocalized(agent, locale).name : n.role, role: n.role }}
                                active={selectedNode?.id === n.agentSlug}
                                onClick={() => {
                                  const resolved: ResolvedNode = { id: n.agentSlug, name: agent ? pickLocalized(agent, locale).name : n.role, role: n.role, agentId: n.agentId };
                                  setSelectedNode(resolved);
                                  setActiveTab("identity");
                                }}
                              />
                            );
                          })
                        )}
                      </div>
                    ) : rOrg ? (
                      <div style={{ paddingLeft: 12 }}>
                        <ResolvedOrgChart org={rOrg} agentMap={agentMap} selectedId={selectedNode?.id ?? null} onSelect={(node) => { setSelectedNode(node); setActiveTab("identity"); }} />
                      </div>
                    ) : (
                      <div style={{ paddingLeft: 12 }}>
                        <OrgChart firm={firm} agentMap={agentMap} locale={locale} selectedId={selectedNode?.id ?? null} onSelect={(node) => { setSelectedNode(node); setActiveTab("identity"); }} />
                      </div>
                    )
                  )}
                </div>
              );
            })}

            {(sidebarCollapsed || rosterTab === "multi") && roster.standaloneMultiAgents.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {!sidebarCollapsed && (
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 8 }}>
                    {t("library.agents.team_section")}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: sidebarCollapsed ? 0 : 12, alignItems: sidebarCollapsed ? "center" : "stretch" }}>
                  {roster.standaloneMultiAgents.map((a) => {
                    const loc = pickLocalized(a, locale);
                    const isAct = selectedNode?.agentId === a.id;
                    if (sidebarCollapsed) {
                      return <MiniNodeAvatar key={a.id} node={{ name: loc.name, role: loc.tagline }} active={isAct} onClick={() => {
                        setSelectedNode({ id: a.id, name: loc.name, role: loc.tagline, agentId: a.id });
                        setActiveTab("identity");
                      }} />;
                    }
                    const expanded = !!teamExpanded[a.id];
                    const subs = teamSubs[a.id];
                    return (
                      <div key={a.id}>
                        <div
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer",
                            borderRadius: "var(--radius-md)", background: isAct ? "var(--fill-1)" : "transparent",
                            border: isAct ? "1px solid var(--accent)" : "1px solid transparent"
                          }}
                        >
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void toggleTeam(a.id); }}
                            title={expanded ? (locale === "ko" ? "접기" : "Collapse") : (locale === "ko" ? "하위 에이전트 펼치기" : "Show sub-agents")}
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, border: "none", background: "transparent", cursor: "pointer", color: "var(--muted-deep)" }}
                          >
                            <IconChevronDown size={13} style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 0.2s" }} />
                          </button>
                          <div
                            onClick={() => {
                              setSelectedNode({ id: a.id, name: loc.name, role: loc.tagline, agentId: a.id });
                              setActiveTab("identity");
                            }}
                            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}
                          >
                            <AgentAvatar name={loc.name} tone={a.tone} size={28} />
                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                              <span style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.tagline}</span>
                            </div>
                          </div>
                          <IconLayers size={14} style={{ color: "var(--accent)" }} />
                        </div>
                        {expanded && (
                          <div style={{ paddingLeft: 34, display: "flex", flexDirection: "column", gap: 3, marginTop: 2, marginBottom: 4 }}>
                            {subs === "loading" || subs === undefined ? (
                              <span style={{ fontSize: 11, color: "var(--muted-deep)", padding: "4px 0" }}>
                                {locale === "ko" ? "하위 에이전트 확인 중…" : "Resolving sub-agents…"}
                              </span>
                            ) : subs.length === 0 ? (
                              <span style={{ fontSize: 11, color: "var(--muted-deep)", padding: "4px 0" }}>
                                {locale === "ko" ? "하위 에이전트가 없습니다 (실제로는 싱글일 수 있어요)" : "No sub-agents (may actually be single)"}
                              </span>
                            ) : (
                              subs.map((s, i) => (
                                <div key={`${a.id}-sub-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                                  <span style={{ width: 20, textAlign: "center", color: "var(--muted-deep)", fontSize: 11 }}>└</span>
                                  <span style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                                  {s.role && s.role !== s.name ? (
                                    <span style={{ fontSize: 10.5, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>· {s.role}</span>
                                  ) : null}
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Independent Agents (싱글 탭) */}
            {(sidebarCollapsed || rosterTab === "single") && (
            <div style={{ marginTop: 8 }}>
              {!sidebarCollapsed && roster.singleModeAgents.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "8px 12px" }}>
                  {t("library.agents.single_empty")}
                </div>
              )}
              {!sidebarCollapsed && roster.singleModeAgents.length > 0 && (
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 8 }}>
                  {t("library.agents.single_section")}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: sidebarCollapsed ? 0 : 12, alignItems: sidebarCollapsed ? "center" : "stretch" }}>
                {roster.singleModeAgents.map(a => {
                  const loc = pickLocalized(a, locale);
                  const isAct = selectedNode?.agentId === a.id;
                  if (sidebarCollapsed) {
                    return <MiniNodeAvatar key={a.id} node={{ name: loc.name, role: loc.tagline }} active={isAct} onClick={() => {
                      setSelectedNode({ id: a.id, name: loc.name, role: loc.tagline, agentId: a.id });
                      setActiveTab("identity");
                    }} />;
                  }
                  return (
                    <div
                      key={a.id}
                      onClick={() => {
                        setSelectedNode({ id: a.id, name: loc.name, role: loc.tagline, agentId: a.id });
                        setActiveTab("identity");
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer",
                        borderRadius: "var(--radius-md)", background: isAct ? "var(--fill-1)" : "transparent",
                        border: isAct ? "1px solid var(--accent)" : "1px solid transparent"
                      }}
                    >
                      <AgentAvatar name={loc.name} tone={a.tone} size={28} />
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                        <span style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.tagline}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            )}
          </div>
          )}
        </div>

        {/* 사이드바 접기 하단 컨트롤 */}
        <footer style={{ borderTop: "1px solid var(--glass-border)", padding: 8, display: "flex", justifyContent: sidebarCollapsed ? "center" : "flex-end" }}>
          <button
            onClick={toggleSidebar}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted-deep)",
              padding: 4,
              borderRadius: 4,
            }}
          >
            <IconSidebar size={16} style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "none" }} />
          </button>
        </footer>

        {/* 리사이즈 드래그 핸들 */}
        {!sidebarCollapsed && (
          <div
            role="separator"
            onMouseDown={startResize}
            style={{
              position: "absolute",
              right: -3,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: "col-resize",
              zIndex: 10,
            }}
          />
        )}
      </aside>

      {/* 2. 오른쪽 메인 콘텐츠 제어판 */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--paper-2)", overflow: "hidden", position: "relative" }}>
        
        {/* 토스트 알림창 */}
        {toastMsg && (
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              zIndex: 999,
              background: "var(--accent)",
              color: "var(--paper)",
              padding: "10px 18px",
              borderRadius: "var(--radius-md)",
              fontSize: 12.5,
              fontWeight: 600,
              boxShadow: "var(--glass-shadow-lift)",
            }}
          >
            {toastMsg}
          </div>
        )}

        {selectedNode === null ? (
          /* A. 에이전트 미선택 시: 기존 회사 오버뷰 화면 */
          <div style={{ flex: 1, overflowY: "auto" }} data-tour-id="agents.detail">
            <header
              className="titlebar-drag"
              style={{
                padding: "16px 32px",
                minHeight: 56,
                borderBottom: "var(--hairline)",
                background: "var(--paper)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--fill-1)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <IconBuilding size={18} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {manageView === "published"
                    ? locale === "ko" ? "퍼블리시한 에이전트 관리" : "Published Agents"
                    : locale === "ko" ? "에이전트 라이브러리" : "My Agents Library"}
                </h1>
              </div>
              <button
                onClick={() => manageView === "published" ? navigate("/cloud") : void importAgentFolder()}
                disabled={manageView !== "published" && importBusy}
                className="titlebar-nodrag"
                data-tour-id="agents.import"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 34,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid var(--accent)",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 750,
                  cursor: manageView !== "published" && importBusy ? "default" : "pointer",
                  opacity: manageView !== "published" && importBusy ? 0.72 : 1,
                }}
              >
                <IconFileUp size={14} />
                {manageView === "published"
                  ? locale === "ko" ? "에이전트 업로드" : "Upload agent"
                  : importBusy ? (locale === "ko" ? "가져오는 중..." : "Importing...") : locale === "ko" ? "에이전트 가져오기" : "Import agent"}
              </button>
            </header>

            <section style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}>
              <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.6 }}>
                {manageView === "published"
                  ? locale === "ko"
                    ? "왼쪽 목록에서 내가 agentlas.cloud에 퍼블리시한 에이전트를 확인하고, 로컬에 설치해 상세 관리로 이어갈 수 있습니다."
                    : "Select an agent you published on agentlas.cloud, install it locally, then manage it in the detail view."
                  : locale === "ko"
                    ? "로컬 환경에 설치된 모든 에이전트와 조직(Team) 목록입니다. 좌측 조직도에서 개별 에이전트를 클릭하여 세부 통제 센터를 열어보세요."
                    : "List of all agents and organizations (Teams). Click an agent to open its detailed control center."}
              </p>
              
              {manageView === "published" ? (
                <div style={{ padding: 22, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.6 }}>
                  {locale === "ko"
                    ? "퍼블리시 목록은 계정 기준입니다. 아직 목록이 비어 있다면 오른쪽 위 업로드 버튼으로 로컬 에이전트 폴더를 먼저 등록하세요."
                    : "Published agents are account-based. If the list is empty, use Upload agent to register a local agent folder first."}
                </div>
              ) : (
              <>
              {/* 회사 관련 채팅 리스트 */}
              <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 6 }}>
                <IconChat size={14} style={{ color: "var(--accent)" }} />
                {t("firm.section.chats")} ({chats.length})
              </h2>
              {chats.length === 0 ? (
                <div style={{ padding: 32, border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", color: "var(--muted-deep)", textAlign: "center", fontSize: 13 }}>
                  {t("firm.empty_chats")}
                </div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {chats.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/chat?id=${c.id}`}
                        style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", textDecoration: "none", color: "var(--ink)", transition: "border 0.2s" }}
                      >
                        <span style={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.title.trim() || t("chat.untitled")}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>
                          {new Date(c.updatedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              </>
              )}
            </section>
          </div>
        ) : (
          /* B. 에이전트 노드 선택 시: 에이전트 상세 통제 센터 */
          <AgentDetailView
            node={selectedNode}
            agent={agents.find((a) => a.id === selectedNode.agentId) ?? null}
            agentFiles={agentFiles}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onBackToOverview={() => setSelectedNode(null)}
            memoryParsed={memoryParsed}
            memoryEntries={memoryEntries}
            evolutionProposals={evolutionProposals}
            onSaveMemory={saveMemory}
            promptContent={promptContent}
            promptDraft={promptDraft}
            onPromptDraftChange={setPromptDraft}
            editingPrompt={editingPrompt}
            onSetEditingPrompt={setEditingPrompt}
            onSavePrompt={savePrompt}
            onCreateEvolution={createEvolutionProposal}
            onCreateSkillEvolution={createSkillEvolutionProposal}
            onApproveEvolution={approveEvolutionProposal}
            onRejectEvolution={rejectEvolutionProposal}
            onRollbackEvolution={rollbackEvolutionProposal}
            saving={savingFiles}
            availableSkills={availableSkills}
            skillDrawerOpen={skillDrawerOpen}
            onSetSkillDrawerOpen={setSkillDrawerOpen}
            ontologyInbox={ontologyInbox}
            onSetOntologyInbox={setOntologyInbox}
            showToast={showToast}
            runtimeStatuses={runtimeStatuses}
            runtimeOverrides={runtimeOverrides}
            nodeContext={selectedContext}
            onRuntimeOverridesChange={setRuntimeOverrides}
            onRemoveAgent={() => void removeInstalledAgent(agents.find((a) => a.id === selectedNode.agentId) ?? null)}
          />
        )}
      </main>
    </div>
  );
}

function PublishedAgentsRoster({
  items,
  loading,
  signedIn,
  installedSlugs,
  installedAgents,
  installingSlug,
  collapsed,
  locale,
  onSignIn,
  onInstall,
  onOpen,
}: {
  items: MarketplaceListing[];
  loading: boolean;
  signedIn: boolean | null;
  installedSlugs: Set<string>;
  installedAgents: InstalledAgent[];
  installingSlug: string | null;
  collapsed: boolean;
  locale: Locale;
  onSignIn: () => void;
  onInstall: (slug: string) => void;
  onOpen: (agent: InstalledAgent) => void;
}) {
  const ko = locale === "ko";

  if (loading) {
    return (
      <div style={{ padding: collapsed ? "10px 0" : 14, fontSize: 12, color: "var(--muted-deep)", textAlign: collapsed ? "center" : "left" }}>
        {ko ? "불러오는 중..." : "Loading..."}
      </div>
    );
  }

  if (signedIn === false) {
    return (
      <div style={{ padding: collapsed ? "8px 2px" : 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {!collapsed && (
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            {ko ? "agentlas.cloud 계정으로 로그인하면 내가 퍼블리시한 에이전트를 볼 수 있습니다." : "Sign in to see the agents you published on agentlas.cloud."}
          </div>
        )}
        <button
          type="button"
          onClick={onSignIn}
          style={{
            minHeight: 34,
            borderRadius: 8,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 750,
            cursor: "pointer",
          }}
        >
          {collapsed ? "↗" : ko ? "로그인" : "Sign in"}
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: collapsed ? "10px 0" : 14, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5, textAlign: collapsed ? "center" : "left" }}>
        {collapsed ? "0" : ko ? "아직 퍼블리시한 에이전트가 없습니다." : "No published agents yet."}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        {items.map((item) => {
          const installed = installedAgents.find((agent) => agent.slug === item.slug);
          const loc = pickLocalized(item, locale);
          return (
            <MiniNodeAvatar
              key={item.slug}
              node={{ name: loc.name, role: loc.tagline }}
              active={false}
              onClick={() => installed ? onOpen(installed) : onInstall(item.slug)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 4px 2px" }}>
        {ko ? `퍼블리시 ${items.length}개` : `${items.length} published`}
      </div>
      {items.map((item) => {
        const loc = pickLocalized(item, locale);
        const installed = installedAgents.find((agent) => agent.slug === item.slug);
        const isInstalled = installedSlugs.has(item.slug);
        const busy = installingSlug === item.slug;
        return (
          <div
            key={item.slug}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 10px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
            }}
          >
            <AgentAvatar name={loc.name} tone={item.trustGrade === "A" ? "green" : "blue"} size={28} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
              <span style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loc.tagline}</span>
            </div>
            <button
              type="button"
              onClick={() => installed ? onOpen(installed) : onInstall(item.slug)}
              disabled={busy}
              style={{
                minHeight: 28,
                padding: "0 9px",
                borderRadius: 7,
                border: `1px solid ${isInstalled ? "var(--paper-edge)" : "var(--accent)"}`,
                background: isInstalled ? "var(--paper-2)" : "var(--accent)",
                color: isInstalled ? "var(--ink)" : "#fff",
                fontSize: 11.5,
                fontWeight: 750,
                cursor: busy ? "default" : "pointer",
                flexShrink: 0,
              }}
            >
              {busy ? (ko ? "설치 중" : "Installing") : isInstalled ? (ko ? "열기" : "Open") : (ko ? "설치" : "Install")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── 미니 사이드바 노드 아바타 ────────────────────────────
function MiniNodeAvatar({ node, active, onClick }: { node: { name: string; role?: string }; active: boolean; onClick: () => void }) {
  const letters = node.name.slice(0, 2).toUpperCase();
  return (
    <button
      onClick={onClick}
      title={`${node.name} (${node.role ?? ""})`}
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        background: active ? "var(--accent)" : "var(--paper)",
        color: active ? "var(--paper)" : "var(--ink)",
        border: active ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        fontWeight: 700,
        boxShadow: "var(--shadow-1)",
      }}
    >
      {letters}
    </button>
  );
}

// ── 정규화된 3-tier 조직 렌더 (사이드바 내부) ──────────
function ResolvedOrgChart({
  org,
  agentMap,
  selectedId,
  onSelect,
}: {
  org: ResolvedOrg;
  agentMap: Map<string, InstalledAgent>;
  selectedId: string | null;
  onSelect: (node: ResolvedNode) => void;
}) {
  const visibleDivisions = org.divisions.filter(
    (division) =>
      isVisibleResolvedNode(division, agentMap) ||
      division.specialists.some((specialist) => isVisibleResolvedNode(specialist, agentMap)),
  );
  const showCeo = isVisibleResolvedNode(org.ceo, agentMap);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {showCeo && <OrgNodeCard node={org.ceo} tier={1} active={selectedId === org.ceo.id} onClick={() => onSelect(org.ceo)} />}
      {visibleDivisions.map((d) => {
        const visibleSpecialists = d.specialists.filter((specialist) => isVisibleResolvedNode(specialist, agentMap));
        const showDivision = isVisibleResolvedNode(d, agentMap);
        return (
        <div key={d.id}>
          {showDivision ? (
            <OrgNodeCard node={d} tier={2} active={selectedId === d.id} onClick={() => onSelect(d)} />
          ) : (
            <OrgGroupLabel node={d} />
          )}
          {visibleSpecialists.length > 0 && (
            <div
              style={{
                marginLeft: 16,
                paddingLeft: 10,
                borderLeft: "1px solid var(--paper-edge)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                marginTop: 6,
              }}
            >
              {visibleSpecialists.map((s) => (
                <OrgNodeCard key={s.id} node={s} tier={3} active={selectedId === s.id} onClick={() => onSelect(s)} />
              ))}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

function OrgGroupLabel({ node }: { node: ResolvedNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", color: "var(--muted-deep)" }}>
      <span style={{ width: 26, height: 1, background: "var(--paper-edge)", flexShrink: 0 }} />
      <strong style={{ fontSize: 11.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</strong>
      <span style={{ marginLeft: "auto", fontSize: 9.5, fontFamily: "var(--font-mono)" }}>HQ</span>
    </div>
  );
}

function OrgNodeCard({ node, tier, active, onClick }: { node: ResolvedNode; tier: 1 | 2 | 3; active: boolean; onClick: () => void }) {
  const isCeo = tier === 1;
  const roleLabel = readableRoleLabel(node.role, node.name);
  return (
    <div
      onClick={onClick}
      title={[node.name, roleLabel].filter(Boolean).join(" - ")}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        background: active ? "var(--accent-soft)" : isCeo ? "var(--fill-1)" : "var(--paper)",
        border: active ? "1px solid var(--accent)" : isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      <div
        style={{
          width: tier === 3 ? 20 : 26,
          height: tier === 3 ? 20 : 26,
          borderRadius: 6,
          background: isCeo ? "linear-gradient(135deg, var(--accent), var(--blue))" : "var(--paper-2)",
          color: isCeo ? "#fff" : "var(--ink-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: tier === 3 ? 9 : 10,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {node.name.slice(0, 1).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, minWidth: 0 }}>
          <strong style={{ ...rosterNameStyle, fontSize: tier === 3 ? 11.5 : 12.5, color: "var(--ink)", fontWeight: 750 }}>
            {node.name}
          </strong>
          {roleLabel && (
            <span style={{ maxWidth: "100%", fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--paper-2)", color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {roleLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function isVisibleResolvedNode(node: ResolvedNode, agentMap: Map<string, InstalledAgent>): boolean {
  if (!isUserFacingAgentText(node.name, node.role)) return false;
  if (!node.agentId) return true;
  const agent = agentMap.get(node.agentId);
  return Boolean(agent && isRosterVisibleAgent(agent));
}

function isVisibleFirmOrgNode(
  node: InstalledFirm["orgChart"][number],
  agentMap: Map<string, InstalledAgent>,
): boolean {
  if (!isUserFacingAgentText(node.agentSlug, node.role)) return false;
  const agent = agentMap.get(node.agentId);
  return Boolean(agent && isRosterVisibleAgent(agent));
}

// ── 일반 트리 재귀 렌더 (사이드바 내부) ─────────────────
function OrgChart({
  firm,
  agentMap,
  locale,
  selectedId,
  onSelect,
}: {
  firm: InstalledFirm;
  agentMap: Map<string, InstalledAgent>;
  locale: Locale;
  selectedId: string | null;
  onSelect: (node: ResolvedNode) => void;
}) {
  const ceo = firm.orgChart.find((n) => n.reportsTo === null);
  if (!ceo) return <div style={{ fontSize: 12, color: "var(--muted)" }}>{locale === "ko" ? "조직도가 비어있습니다." : "The org chart is empty."}</div>;

  function children(parentSlug: string) {
    return firm.orgChart.filter((n) => n.reportsTo === parentSlug && isVisibleFirmOrgNode(n, agentMap));
  }

  function renderNode(node: typeof firm.orgChart[number], depth: number): React.ReactNode {
    const agent = agentMap.get(node.agentId);
    const agentLoc = agent ? pickLocalized(agent, locale) : null;
    const kids = children(node.agentSlug);
    const isCeo = node.reportsTo === null;
    const active = selectedId === node.agentSlug;
    const displayName = agentLoc?.name ?? node.role;
    const roleLabel = readableRoleLabel(node.role, displayName, agent?.slug ?? node.agentSlug);

    const resolved: ResolvedNode = {
      id: node.agentSlug,
      name: displayName,
      role: node.role,
      agentId: node.agentId,
    };

    return (
      <div key={node.agentSlug} style={{ marginTop: depth === 0 ? 0 : 6 }}>
        <div
          onClick={() => onSelect(resolved)}
          title={[displayName, roleLabel].filter(Boolean).join(" - ")}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 10px",
            background: active ? "var(--accent-soft)" : isCeo ? "var(--fill-1)" : "var(--paper)",
            border: active ? "1px solid var(--accent)" : isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: isCeo ? "linear-gradient(135deg, var(--accent), var(--blue))" : "var(--paper-2)",
              color: isCeo ? "#fff" : "var(--ink-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, minWidth: 0 }}>
              <strong style={{ ...rosterNameStyle, fontSize: 12, color: "var(--ink)", fontWeight: 750 }}>
                {displayName}
              </strong>
              {roleLabel && (
                <span style={{ maxWidth: "100%", fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--paper-2)", color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {roleLabel}
                </span>
              )}
            </div>
          </div>
        </div>
        {kids.length > 0 && (
          <div
            style={{
              marginLeft: 16,
              paddingLeft: 10,
              borderLeft: "1px dashed var(--paper-edge)",
              marginTop: 4,
            }}
          >
            {kids.map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  if (isVisibleFirmOrgNode(ceo, agentMap)) return renderNode(ceo, 0);
  const visibleRoots = children(ceo.agentSlug);
  if (visibleRoots.length === 0) return <div style={{ fontSize: 12, color: "var(--muted)" }}>{locale === "ko" ? "표시할 에이전트가 없습니다." : "No agents to display."}</div>;
  return <>{visibleRoots.map((node) => renderNode(node, 0))}</>;
}

type SelectedNodeContext = {
  firm: InstalledFirm | null;
  division: ResolvedNode | null;
  isDivision: boolean;
};

function findResolvedNode(org: ResolvedOrg, matches: (node: ResolvedNode) => boolean): ResolvedNode | null {
  if (matches(org.ceo)) return org.ceo;
  for (const division of org.divisions) {
    if (matches(division)) return division;
    const specialist = division.specialists.find(matches);
    if (specialist) return specialist;
  }
  return null;
}

function findAgentRouteNode({
  agentId,
  nodeId,
  firmId,
  firms,
  agents,
  resolvedOrgs,
  locale,
}: {
  agentId: string;
  nodeId: string;
  firmId: string;
  firms: InstalledFirm[];
  agents: InstalledAgent[];
  resolvedOrgs: Record<string, ResolvedOrg>;
  locale: Locale;
}): ResolvedNode | null {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const matches = (node: ResolvedNode) =>
    isVisibleResolvedNode(node, agentMap) &&
    Boolean((agentId && node.agentId === agentId) || (nodeId && node.id === nodeId));
  const scopedFirms = firmId ? firms.filter((firm) => firm.id === firmId) : firms;

  for (const firm of scopedFirms) {
    const resolved = resolvedOrgs[firm.id];
    if (resolved) {
      const node = findResolvedNode(resolved, matches);
      if (node) return node;
    }

    const raw = firm.orgChart.find(
      (node) =>
        (agentId && node.agentId === agentId) ||
        (nodeId && (node.agentSlug === nodeId || node.role === nodeId)),
    );
    if (raw && isVisibleFirmOrgNode(raw, agentMap)) {
      const agent = agents.find((item) => item.id === raw.agentId);
      const localized = agent ? pickLocalized(agent, locale) : null;
      return {
        id: raw.agentSlug,
        name: localized?.name ?? raw.role,
        role: raw.role,
        agentId: raw.agentId,
      };
    }
  }

  if (agentId) {
    const agent = agents.find((item) => item.id === agentId);
    if (agent) {
      const localized = pickLocalized(agent, locale);
      return {
        id: agent.id,
        name: localized.name,
        role: localized.tagline,
        agentId: agent.id,
      };
    }
  }

  return null;
}

function nodeMatches(candidate: ResolvedNode, selected: ResolvedNode): boolean {
  return (
    candidate.id === selected.id ||
    (!!candidate.agentId && candidate.agentId === selected.agentId) ||
    (!!selected.agentId && candidate.id === selected.agentId)
  );
}

function divisionTargetId(firmId: string, divisionId: string): string {
  return `${firmId}:${divisionId}`;
}

function findSelectedNodeContext(
  selected: ResolvedNode,
  firms: InstalledFirm[],
  orgs: Record<string, ResolvedOrg>,
): SelectedNodeContext {
  for (const firm of firms) {
    const org = orgs[firm.id];
    if (org) {
      if (nodeMatches(org.ceo, selected)) return { firm, division: null, isDivision: false };
      for (const division of org.divisions) {
        if (nodeMatches(division, selected)) return { firm, division, isDivision: true };
        if (division.specialists.some((specialist) => nodeMatches(specialist, selected))) {
          return { firm, division, isDivision: false };
        }
      }
    }

    const rawNode = firm.orgChart.find(
      (node) => node.agentSlug === selected.id || (!!selected.agentId && node.agentId === selected.agentId),
    );
    if (rawNode) {
      const children = firm.orgChart.filter((node) => node.reportsTo === rawNode.agentSlug);
      const parent = rawNode.reportsTo
        ? firm.orgChart.find((node) => node.agentSlug === rawNode.reportsTo)
        : null;
      const parentAsDivision = parent && parent.reportsTo !== null
        ? { id: parent.agentSlug, name: parent.role, role: parent.role, agentId: parent.agentId }
        : null;
      return {
        firm,
        division: children.length > 0
          ? { id: rawNode.agentSlug, name: rawNode.role, role: rawNode.role, agentId: rawNode.agentId }
          : parentAsDivision,
        isDivision: children.length > 0,
      };
    }
  }
  return { firm: null, division: null, isDivision: false };
}

function MetricMini({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", padding: "8px 10px" }}>
      <div style={{ fontSize: 10.5, color: "var(--muted-deep)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 750, color: "var(--ink)" }}>{value}</div>
    </div>
  );
}

// ── 3.5 정보 흐름 연결 맵 (Information Flow Mapper) ──
// upstream/downstream 은 우선 Hephaestus AO(Agent Ontology) 그래프의 실제 produces/consumes
// 엣지에서 도출하고, 그래프가 없으면 역할 휴리스틱으로 폴백한다.
function flowHeuristic(role: string): { upstream: string; downstream: string } {
  const r = role.toLowerCase();
  if (r.includes("ceo") || r.includes("orchestrator") || role.includes("오케스트")) return { upstream: "User / Hub request", downstream: "Specialist agents" };
  if (r.includes("pm") || r.includes("planner") || role.includes("기획")) return { upstream: "Orchestrator", downstream: "Worker agents" };
  if (r.includes("research") || role.includes("리서치")) return { upstream: "Brief / query", downstream: "Synthesis agent" };
  if (r.includes("qa") || r.includes("review") || role.includes("검증")) return { upstream: "Worker output", downstream: "Approval / delivery" };
  if (r.includes("deploy") || r.includes("publish") || role.includes("배포")) return { upstream: "Verified package", downstream: "Cloud / Hub" };
  return { upstream: "Chat / Team route", downstream: "Workspace output" };
}

/** AO 그래프 JSON 에서 이 노드의 upstream(공급자)/downstream(수신자)를 도출. 못 찾으면 null. */
function flowFromAoGraph(graph: unknown, node: ResolvedNode): { upstream: string; downstream: string } | null {
  if (!graph || typeof graph !== "object") return null;
  const g = graph as Record<string, unknown>;
  const edges = (g.edges ?? g.relations ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const me = (node.agentId ?? node.id ?? node.name ?? "").toLowerCase();
  const role = node.role.toLowerCase();
  const matches = (v: unknown) => {
    const s = String(v ?? "").toLowerCase();
    return s && (s === me || (me && s.includes(me)) || (role && s.includes(role)));
  };
  let upstream = "";
  let downstream = "";
  for (const e of edges) {
    const type = String(e.type ?? e.kind ?? e.rel ?? "").toLowerCase();
    const from = e.from ?? e.source ?? e.src;
    const to = e.to ?? e.target ?? e.dst;
    // produces/consumes/feeds 류 엣지에서 방향 도출
    if (type.includes("consume") || type.includes("depends") || type.includes("input")) {
      if (matches(from) && !downstream) downstream = String(to);
      if (matches(to) && !upstream) upstream = String(from);
    } else if (type.includes("produce") || type.includes("feed") || type.includes("output") || type.includes("hands_off") || type.includes("handoff")) {
      if (matches(from) && !downstream) downstream = String(to);
      if (matches(to) && !upstream) upstream = String(from);
    }
  }
  if (!upstream && !downstream) return null;
  return { upstream: upstream || "—", downstream: downstream || "—" };
}

function InformationFlowMapper({ node }: { node: ResolvedNode }) {
  const { locale } = useT();
  const fallback = flowHeuristic(node.role);
  const [flow, setFlow] = useState<{ upstream: string; downstream: string }>(fallback);
  const [fromEngine, setFromEngine] = useState(false);

  useEffect(() => {
    setFlow(flowHeuristic(node.role));
	    setFromEngine(false);
	    let cancelled = false;
	    const api = ipc();
	    if (!api?.hephaestus?.aoGraph) return;
	    void api.hephaestus
      .aoGraph({ agent: node.agentId ?? node.id })
      .then((res) => {
        if (cancelled || !res?.ok) return;
        const real = flowFromAoGraph(res.json, node);
        if (real) {
          setFlow(real);
          setFromEngine(true);
        }
      })
      .catch(() => {
        /* AO 그래프 없음 — 휴리스틱 유지 */
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, node.agentId, node.role]);

  const upstreamName = flow.upstream;
  const downstreamName = flow.downstream;

  return (
    <div style={{
      background: "var(--paper)",
      borderBottom: "1px solid var(--paper-edge)",
      padding: "12px 24px",
      display: "flex",
      flexDirection: "column",
      gap: 6
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 8 }}>
        <span>{locale === "ko" ? "정보 흐름 연결 맵 (Information Flow Mapper)" : "Information Flow Mapper"}</span>
        {fromEngine && (
          <span style={{ fontSize: 8.5, padding: "1px 6px", borderRadius: 999, background: "rgba(12,166,120,0.12)", color: "var(--green-deep, #0ca678)", letterSpacing: 0.3 }}>
            AO GRAPH
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", padding: "4px 0", gap: 12 }}>
        
        {/* Upstream Node */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "6px 12px",
          background: "var(--paper-2)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 6,
          flex: 1,
          minWidth: 100,
          textAlign: "center"
        }}>
          <span style={{ fontSize: 8.5, color: "var(--muted-deep)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>Upstream</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{upstreamName}</span>
        </div>

        {/* SVG Flow Connection 1 */}
        <div style={{ width: 60, height: 16, position: "relative", flexShrink: 0 }}>
          <svg style={{ width: "100%", height: "100%", overflow: "visible" }}>
            <defs>
              <linearGradient id="flowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="var(--paper-edge)" />
                <stop offset="50%" stopColor="var(--accent)" stopOpacity="0.8" />
                <stop offset="100%" stopColor="var(--paper-edge)" />
              </linearGradient>
            </defs>
            <line
              x1="0"
              y1="8"
              x2="100%"
              y2="8"
              fill="none"
              stroke="url(#flowGrad)"
              strokeWidth="2.5"
              strokeDasharray="6 4"
              style={{
                animation: "dashFlow 1.5s linear infinite"
              }}
            />
          </svg>
        </div>

        {/* Selected Current Node */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "6px 16px",
          background: "var(--accent-soft)",
          border: "1px solid var(--accent)",
          borderRadius: 8,
          flex: 1.2,
          minWidth: 120,
          textAlign: "center",
          boxShadow: "var(--glass-shadow-lift)"
        }}>
          <span style={{ fontSize: 8.5, color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>Active Specialist</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{node.name}</span>
        </div>

        {/* SVG Flow Connection 2 */}
        <div style={{ width: 60, height: 16, position: "relative", flexShrink: 0 }}>
          <svg style={{ width: "100%", height: "100%", overflow: "visible" }}>
            <line
              x1="0"
              y1="8"
              x2="100%"
              y2="8"
              fill="none"
              stroke="url(#flowGrad)"
              strokeWidth="2.5"
              strokeDasharray="6 4"
              style={{
                animation: "dashFlow 1.5s linear infinite"
              }}
            />
          </svg>
        </div>

        {/* Downstream Node */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "6px 12px",
          background: "var(--paper-2)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 6,
          flex: 1,
          minWidth: 100,
          textAlign: "center"
        }}>
          <span style={{ fontSize: 8.5, color: "var(--muted-deep)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>Downstream</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{downstreamName}</span>
        </div>

      </div>
      <style>{`
        @keyframes dashFlow {
          to {
            stroke-dashoffset: -20;
          }
        }
      `}</style>
    </div>
  );
}

type RuntimeTargetOption = {
  scope: AgentRuntimeOverrideScope;
  targetId: string;
  label: string;
  note: string;
};

function runtimeStatusKey(runtime: Pick<RuntimeStatus, "kind" | "backend">): string {
  return `${runtime.kind}:${runtime.backend}`;
}

function runtimeDisplayName(runtime: Pick<RuntimeStatus, "kind" | "backend" | "model">): string {
  if (runtime.kind === "claude-code") return "Claude Code";
  if (runtime.kind === "codex") return "Codex";
  if (runtime.kind === "gemini") return "Gemini";
  if (runtime.kind === "ollama") return runtime.model ? `Ollama · ${runtime.model}` : "Ollama";
  if (runtime.kind === "byok") return `BYOK · ${runtime.backend}`;
  return runtime.kind;
}

function selectionSummary(selection?: RuntimeSelection | null, locale: Locale = "ko"): string {
  if (!selection) return locale === "ko" ? "전역 활성 런타임" : "Global active runtime";
  const base = selection.kind === "byok" ? `BYOK · ${selection.backend ?? "provider"}` : selection.kind;
  return [base, selection.model, selection.effort ? `effort ${selection.effort}` : ""].filter(Boolean).join(" · ");
}

function RuntimeAssignmentPanel({
  node,
  agent,
  nodeContext,
  runtimeStatuses,
  runtimeOverrides,
  onRuntimeOverridesChange,
  showToast,
}: {
  node: ResolvedNode;
  agent: InstalledAgent | null;
  nodeContext: SelectedNodeContext | null;
  runtimeStatuses: RuntimeStatus[];
  runtimeOverrides: AgentRuntimeOverride[];
  onRuntimeOverridesChange: (items: AgentRuntimeOverride[]) => void;
  showToast: (msg: string) => void;
}) {
  const { locale } = useT();
  const targets = useMemo<RuntimeTargetOption[]>(() => {
    const items: RuntimeTargetOption[] = [];
    if (node.agentId) {
      items.push({
        scope: "agent",
        targetId: node.agentId,
        label: locale === "ko" ? `${node.name}만` : `${node.name} only`,
        note: locale === "ko" ? "선택한 개별 에이전트에만 적용" : "Applies only to the selected individual agent",
      });
    }
    if (nodeContext?.firm && nodeContext.division) {
      items.push({
        scope: "division",
        targetId: divisionTargetId(nodeContext.firm.id, nodeContext.division.id),
        label: locale === "ko" ? `${nodeContext.division.name} 디비전` : `${nodeContext.division.name} division`,
        note: locale === "ko" ? "해당 디비전과 하위 전문가 기본값" : "Default for this division and its specialists",
      });
    }
    if (nodeContext?.firm) {
      items.push({
        scope: "firm",
        targetId: nodeContext.firm.id,
        label: locale === "ko" ? `${nodeContext.firm.name} 전체` : `All of ${nodeContext.firm.name}`,
        note: locale === "ko" ? "조직 전체 기본값" : "Default for the whole organization",
      });
    }
    return items;
  }, [node.agentId, node.name, nodeContext, locale]);

  const [targetKey, setTargetKey] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; label: string; tag?: string }>>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (targets.length === 0) {
      setTargetKey("");
      return;
    }
    setTargetKey((current) => (targets.some((target) => `${target.scope}:${target.targetId}` === current) ? current : `${targets[0].scope}:${targets[0].targetId}`));
  }, [targets]);

  const selectedTarget = targets.find((target) => `${target.scope}:${target.targetId}` === targetKey) ?? targets[0] ?? null;
  const selectedOverride = selectedTarget
    ? runtimeOverrides.find((item) => item.scope === selectedTarget.scope && item.targetId === selectedTarget.targetId) ?? null
    : null;

  useEffect(() => {
    const fallback = runtimeStatuses.find((runtime) => runtime.active) ?? runtimeStatuses[0];
    const source = selectedOverride
      ? runtimeStatuses.find(
          (runtime) =>
            runtime.kind === selectedOverride.selection.kind &&
            (!selectedOverride.selection.backend || runtime.backend === selectedOverride.selection.backend),
        ) ?? fallback
      : fallback;
    setRuntimeKey(source ? runtimeStatusKey(source) : "");
    setSelectedModel(selectedOverride?.selection.model ?? source?.model ?? "");
    setSelectedEffort(selectedOverride?.selection.effort ?? source?.effort ?? "");
  }, [selectedOverride, runtimeStatuses]);

  const selectedRuntime = runtimeStatuses.find((runtime) => runtimeStatusKey(runtime) === runtimeKey) ?? null;
  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api || !selectedRuntime) {
      setModelOptions([]);
      return;
    }
    void api.runtime
      .listModels({
        kind: selectedRuntime.kind,
        backend: selectedRuntime.backend,
        availableModels: selectedRuntime.availableModels,
      })
      .then((items) => {
        if (!cancelled) setModelOptions(items);
      })
      .catch(() => {
        if (!cancelled) setModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRuntime]);

  const effortOptions = selectedRuntime?.efforts ?? [];

  async function refreshOverrides() {
    const api = ipc();
    if (!api) return;
    onRuntimeOverridesChange(await api.agentRuntime.list());
  }

  async function saveOverride() {
    const api = ipc();
    if (!api || !selectedTarget || !selectedRuntime) return;
    setSaving(true);
    try {
      const selection: RuntimeSelection = {
        kind: selectedRuntime.kind,
        backend: selectedRuntime.backend,
        source: selectedRuntime.source,
        model: selectedModel || undefined,
        longContext: selectedRuntime.kind === "byok" ? selectedRuntime.longContextEnabled ?? false : undefined,
        effort: selectedEffort || undefined,
      };
      await api.agentRuntime.set({
        scope: selectedTarget.scope,
        targetId: selectedTarget.targetId,
        label: selectedTarget.label,
        selection,
      });
      await refreshOverrides();
      showToast(locale === "ko" ? "런타임 모델 지정이 저장되었습니다." : "Runtime model assignment saved.");
    } catch (err) {
      showToast((locale === "ko" ? "런타임 지정 저장 실패: " : "Failed to save runtime assignment: ") + String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride() {
    const api = ipc();
    if (!api || !selectedTarget) return;
    setSaving(true);
    try {
      await api.agentRuntime.remove(selectedTarget.scope, selectedTarget.targetId);
      await refreshOverrides();
      showToast(locale === "ko" ? "런타임 모델 지정을 해제했습니다." : "Runtime model assignment cleared.");
    } finally {
      setSaving(false);
    }
  }

  if (targets.length === 0) {
    return (
      <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "실행 모델 지정" : "Runtime Model Assignment"}</h4>
        <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>{locale === "ko" ? "설치된 에이전트 노드를 선택하면 CLI 모델을 고정할 수 있습니다." : "Select an installed agent node to pin its CLI model."}</p>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "실행 모델 지정" : "Runtime Model Assignment"}</h4>
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--muted-deep)" }}>
            {locale === "ko"
              ? "저장된 값은 다음 Chat, Team 라우팅, Hub 후보 호출부터 우선 적용됩니다."
              : "Saved values take priority from the next Chat, Team routing, and Hub candidate invocation onward."}
          </p>
        </div>
        <span style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, background: selectedOverride ? "rgba(12,166,120,0.12)" : "var(--fill-2)", color: selectedOverride ? "var(--green-deep)" : "var(--muted-deep)", fontWeight: 700 }}>
          {selectedOverride ? (locale === "ko" ? "고정됨" : "Pinned") : (locale === "ko" ? "전역 기본" : "Global default")}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          {locale === "ko" ? "적용 범위" : "Scope"}
          <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} style={runtimeSelectStyle}>
            {targets.map((target) => (
              <option key={`${target.scope}:${target.targetId}`} value={`${target.scope}:${target.targetId}`}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          CLI / Runtime
          <select value={runtimeKey} onChange={(e) => setRuntimeKey(e.target.value)} style={runtimeSelectStyle}>
            {runtimeStatuses.map((runtime) => (
              <option key={runtimeStatusKey(runtime)} value={runtimeStatusKey(runtime)}>
                {runtimeDisplayName(runtime)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: effortOptions.length > 0 ? "1fr 1fr" : "1fr", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          {locale === "ko" ? "모델" : "Model"}
          <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} style={runtimeSelectStyle}>
            <option value="">{locale === "ko" ? "구독/전역 기본" : "Subscription / global default"}</option>
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}{model.tag ? ` · ${cliModelTagLabel(model.tag, locale)}` : ""}
              </option>
            ))}
          </select>
        </label>
        {effortOptions.length > 0 && (
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
            {locale === "ko" ? "작업량" : "Effort"}
            <select value={selectedEffort} onChange={(e) => setSelectedEffort(e.target.value)} style={runtimeSelectStyle}>
              <option value="">{locale === "ko" ? "기본" : "Default"}</option>
              {effortOptions.map((effort) => (
                <option key={effort.id} value={effort.id}>{effort.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--paper-2)", border: "1px solid var(--paper-edge)", fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
        <strong style={{ color: "var(--ink)" }}>{locale === "ko" ? "현재 저장값:" : "Current saved value:"}</strong> {selectionSummary(selectedOverride?.selection, locale)}
        {selectedTarget && <span style={{ color: "var(--muted-deep)" }}> · {selectedTarget.note}</span>}
      </div>

      {/* 독립성: 키는 내 OS 키체인에 저장되고 Agentlas 서버를 거치지 않으며, 모델 호출은 내 구독/키로 직접 나간다. */}
      <div className="runtime-independence-note">
        {locale === "ko"
          ? "키는 내 OS 키체인에 저장되고 Agentlas 서버를 거치지 않습니다 · 모델 호출은 내 구독/키로 직접 나갑니다"
          : "Keys are stored in your OS keychain and never pass through Agentlas servers · model calls go out directly with your own subscription/key"}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button onClick={clearOverride} disabled={saving || !selectedOverride} style={{ ...runtimeButtonStyle, opacity: selectedOverride ? 1 : 0.45 }}>
          {locale === "ko" ? "전역 기본" : "Global default"}
        </button>
        <button onClick={saveOverride} disabled={saving || !selectedRuntime} style={{ ...runtimeButtonStyle, background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)" }}>
          {saving ? (locale === "ko" ? "저장 중..." : "Saving...") : (locale === "ko" ? "저장" : "Save")}
        </button>
      </div>
    </div>
  );
}

const runtimeSelectStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "8px 9px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  fontSize: 12,
};

const runtimeButtonStyle: React.CSSProperties = {
  padding: "7px 11px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

// ── 3. 에이전트 상세 컨트롤 타워 뷰 컴포넌트 ──────────
interface AgentDetailViewProps {
  node: ResolvedNode;
  agent: InstalledAgent | null;
  activeTab: "identity" | "memory" | "playbook" | "activity";
  onTabChange: (tab: "identity" | "memory" | "playbook" | "activity") => void;
  onBackToOverview: () => void;
  memoryParsed: {
    decisions: { id: string; title: string; content: string; synced?: boolean; enabled?: boolean }[];
    gotchas: { id: string; title: string; content: string; synced?: boolean; enabled?: boolean }[];
    openQuestions: { id: string; title: string; content: string }[];
  };
  /** 런타임 durable 메모리(큐레이터 DB) — memory.md 없이도 타임라인/진화 후보를 채우는 실측 소스. */
  memoryEntries: AgentMemoryEntryUi[];
  evolutionProposals: AgentEvolutionProposalUi[];
  onSaveMemory: (updater: (prev: any) => any) => Promise<void>;
  promptContent: string;
  promptDraft: string;
  onPromptDraftChange: (v: string) => void;
  editingPrompt: boolean;
  onSetEditingPrompt: (v: boolean) => void;
  onSavePrompt: () => Promise<void>;
  onCreateEvolution: (newPrompt: string, source?: Record<string, unknown>) => Promise<AgentEvolutionProposalUi | undefined>;
  onCreateSkillEvolution: (skill: { slug?: string; name: string; description: string }) => Promise<boolean>;
  onApproveEvolution: (proposalId: string) => Promise<void>;
  onRejectEvolution: (proposalId: string) => Promise<void>;
  onRollbackEvolution: (proposalId: string) => Promise<void>;
  saving: boolean;
  availableSkills: { slug: string; name: string; description: string }[];
  skillDrawerOpen: boolean;
  onSetSkillDrawerOpen: (v: boolean) => void;
  ontologyInbox: { id: string; type: "gotcha" | "decision"; title: string; content: string; source: "local" | "cloud" }[];
  onSetOntologyInbox: (v: any) => void;
  showToast: (msg: string) => void;
  agentFiles: WorkspaceNode[];
  runtimeStatuses: RuntimeStatus[];
  runtimeOverrides: AgentRuntimeOverride[];
  nodeContext: SelectedNodeContext | null;
  onRuntimeOverridesChange: (items: AgentRuntimeOverride[]) => void;
  onRemoveAgent: () => void;
}

function AgentDetailView({
  node,
  agent,
  activeTab,
  onTabChange,
  onBackToOverview,
  memoryParsed,
  memoryEntries,
  evolutionProposals,
  onSaveMemory,
  promptContent,
  promptDraft,
  onPromptDraftChange,
  editingPrompt,
  onSetEditingPrompt,
  onSavePrompt,
  onCreateEvolution,
  onCreateSkillEvolution,
  onApproveEvolution,
  onRejectEvolution,
  onRollbackEvolution,
  saving,
  availableSkills,
  skillDrawerOpen,
  onSetSkillDrawerOpen,
  ontologyInbox,
  onSetOntologyInbox,
  showToast,
  agentFiles,
  runtimeStatuses,
  runtimeOverrides,
  nodeContext,
  onRuntimeOverridesChange,
  onRemoveAgent,
}: AgentDetailViewProps) {
  const { locale } = useT();

  // 규칙 카드별 열림/닫힘(Accordion) 관리 상태
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  
  // Hub 공유 상태 메타데이터 기본값 토글. 실제 원격 업로드는 Hub/Cloud publish 흐름에서 수행한다.
  const [globalHubSync, setGlobalHubSync] = useState(true);
  const effectiveRuntimeOverride = useMemo(() => {
    const orderedTargets: Array<{ scope: AgentRuntimeOverrideScope; targetId?: string | null }> = [
      { scope: "agent", targetId: node.agentId },
      {
        scope: "division",
        targetId: nodeContext?.firm && nodeContext.division
          ? divisionTargetId(nodeContext.firm.id, nodeContext.division.id)
          : null,
      },
      { scope: "firm", targetId: nodeContext?.firm?.id },
    ];
    for (const target of orderedTargets) {
      if (!target.targetId) continue;
      const found = runtimeOverrides.find((item) => item.scope === target.scope && item.targetId === target.targetId);
      if (found) return found;
    }
    return null;
  }, [node.agentId, nodeContext, runtimeOverrides]);

  // 메모리 진화 타임라인 관리 상태 — 사용자가 수행한 액션만 state로 보관하고,
  // 로드 상태는 아래 observedTimelineEvents에서 현재 파일 상태로 파생한다.
  const [timelineEvents, setTimelineEvents] = useState<Array<{ id: string; timestamp: string; title: string; desc: string; type: "skill" | "sync" | "evolution" | "resolve" }>>([]);

  // 셀프에볼루션 — 실제 메모리(활성 결정·주의 규칙) 중 아직 시스템 프롬프트에 반영되지 않은
  // 학습 규칙을 프롬프트 부록으로 접어 넣는 실데이터 기반 진화 제안. (가짜 텍스트 아님)
  const learnedRules = [...memoryParsed.decisions, ...memoryParsed.gotchas].filter(
    (r) => r.enabled !== false && r.title && !promptContent.includes(r.title),
  );
  const evolutionAppendix = learnedRules.length
    ? "\n\n## Learned rules (folded from memory)\n" +
      learnedRules.map((r) => `- **${r.title}** — ${r.content}`).join("\n")
    : "";
  const hasPendingEvolution = learnedRules.length > 0;
  const evolutionDiff = { old: promptContent, new: promptContent + evolutionAppendix };
  const pendingProposal = evolutionProposals.find((proposal) => proposal.status === "candidate") ?? null;
  const recoveryProposal = evolutionProposals.find((proposal) => proposal.status === "recovery_required" || proposal.status === "conflicted") ?? null;
  const latestReceiptedProposal = evolutionProposals.find((proposal) => proposal.receipts.length > 0) ?? null;
  const displayedProposal = pendingProposal ?? recoveryProposal ?? latestReceiptedProposal;
  const displayedEvolutionDiff = pendingProposal || recoveryProposal
    ? { old: (pendingProposal ?? recoveryProposal)!.beforeContent, new: (pendingProposal ?? recoveryProposal)!.afterContent }
    : hasPendingEvolution
      ? evolutionDiff
      : latestReceiptedProposal
      ? { old: latestReceiptedProposal.beforeContent, new: latestReceiptedProposal.afterContent }
      : evolutionDiff;

  // 런타임 학습(자동 수집) — 큐레이터 DB durable 메모리 중 아직 프롬프트에 반영되지 않은 진화 후보.
  // 반영 여부는 trim 된 본문이 프롬프트에 그대로 포함되는지로 판정(아래 반영 액션이 본문을 그대로 append 하므로 자기 일관적).
  const runtimeEvolutionCandidates = useMemo(
    () =>
      memoryEntries.filter((entry) => {
        const body = entry.content.trim();
        return (
          entry.scope === "agent_repo" &&
          entry.projectPath === null &&
          EVOLUTION_CANDIDATE_KINDS.has((entry.kind || "").toLowerCase()) &&
          (entry.confidence === "high" || entry.confidence === "medium") &&
          body.length > 0 &&
          !promptContent.includes(body)
        );
      }),
    [memoryEntries, promptContent],
  );
  const [selectedRuntimeIds, setSelectedRuntimeIds] = useState<Record<string, boolean>>({});
  const selectedRuntimeEntries = runtimeEvolutionCandidates.filter((e) => selectedRuntimeIds[e.id]);

  // 자동 수집은 검토 후보만 만든다. 승인 전에는 프롬프트/스킬/플레이북 파일을 쓰지 않는다.
  const applyRuntimeEntries = async () => {
    if (selectedRuntimeEntries.length === 0) return;
    const appendix =
      "\n\n## Runtime learnings (auto-collected)\n" +
      selectedRuntimeEntries.map((e) => `- [${e.kind}] ${e.content.trim()}`).join("\n");
    const proposal = await onCreateEvolution(promptContent + appendix, {
      changeOrigin: "runtime_memory_selection",
      memoryEntryIds: selectedRuntimeEntries.map((entry) => entry.id),
    });
    if (!proposal) return;
    setSelectedRuntimeIds({});
    setTimelineEvents((prev) => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "런타임 학습 검토 후보 생성" : "Runtime learning review candidate created",
        desc: locale === "ko"
          ? `자동 수집된 학습 ${selectedRuntimeEntries.length}건으로 후보를 만들었습니다. 승인 전에는 프롬프트가 바뀌지 않습니다.`
          : `Created a candidate from ${selectedRuntimeEntries.length} auto-collected learnings. The prompt stays unchanged until approval.`,
        type: "evolution",
      },
      ...prev,
    ]);
  };

  const observedTimelineEvents = useMemo(() => {
    const derived: Array<{ id: string; timestamp: string; title: string; desc: string; type: "skill" | "sync" | "evolution" | "resolve"; kind?: string; confidence?: "high" | "medium" | "low" }> = [];
    if (agentFiles.length > 0) {
      derived.push({
        id: "observed-files",
        timestamp: "loaded",
        title: locale === "ko" ? "로컬 에이전트 파일 연결" : "Local agent files linked",
        desc: locale === "ko"
          ? `${agentFiles.length}개 파일을 읽어 프롬프트, 메모리, 플레이북 탭에 반영했습니다.`
          : `Read ${agentFiles.length} files and reflected them into the Prompt, Memory, and Playbook tabs.`,
        type: "sync",
      });
    }
    if (promptContent.trim()) {
      derived.push({
        id: "observed-prompt",
        timestamp: "loaded",
        title: locale === "ko" ? "프롬프트 소스 확인" : "Prompt source confirmed",
        desc: locale === "ko"
          ? "AGENT.md 또는 system-prompt.md 기준으로 현재 런타임 정체성을 표시 중입니다."
          : "Showing the current runtime identity based on AGENT.md or system-prompt.md.",
        type: "sync",
      });
    }
    const memoryCount = memoryParsed.decisions.length + memoryParsed.gotchas.length + memoryParsed.openQuestions.length;
    if (memoryCount > 0) {
      derived.push({
        id: "observed-memory",
        timestamp: "loaded",
        title: locale === "ko" ? "메모리 규칙 로드" : "Memory rules loaded",
        desc: locale === "ko"
          ? `${memoryCount}개 메모리 항목을 규칙, 주의사항, 미결 과제로 분류했습니다.`
          : `Classified ${memoryCount} memory items into decisions, gotchas, and open questions.`,
        type: "sync",
      });
    }
    // 런타임 durable 메모리(큐레이터 DB) → 실제 학습 타임라인 행(최신순). 파일 파생 이벤트와 나란히 합류.
    const dbRows = [...memoryEntries]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((entry) => ({
        id: `db-${entry.id}`,
        timestamp: formatMemoryEntryTime(entry.createdAt, locale),
        title: locale === "ko" ? "런타임 학습 수집" : "Runtime learning captured",
        desc: entry.content,
        type: memoryKindToTimelineType(entry.kind),
        kind: entry.kind,
        confidence: entry.confidence,
      }));
    const proposalRows = [...evolutionProposals]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((proposal) => ({
        id: `proposal-${proposal.id}`,
        timestamp: formatMemoryEntryTime(proposal.appliedAt || proposal.updatedAt, locale),
        title: locale === "ko" ? "자가진화 proposal 원장 기록" : "Self-evolution proposal recorded",
        desc: locale === "ko"
          ? `${proposal.status} · ${proposal.summary} · ${proposal.targetPath}`
          : `${proposal.status} · ${proposal.summary} · ${proposal.targetPath}`,
        type: "evolution" as const,
      }));
    const merged: typeof derived = [...timelineEvents, ...proposalRows, ...dbRows, ...derived];
    return merged;
  }, [agentFiles.length, evolutionProposals, memoryEntries, memoryParsed.decisions.length, memoryParsed.gotchas.length, memoryParsed.openQuestions.length, promptContent, timelineEvents, locale]);

  // 프롬프트 복사 핸들러
  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(promptContent);
    showToast(locale === "ko" ? "시스템 프롬프트가 클립보드에 복사되었습니다." : "System prompt copied to clipboard.");
  };

  // 프롬프트 기본값 재설정 핸들러
  const handleResetPrompt = async () => {
    if (!confirm(locale === "ko" ? "시스템 프롬프트를 에이전트 기본 룰셋 정의서 프로필로 재설정하시겠습니까?" : "Reset the system prompt to the agent's default ruleset profile?")) return;
    const defaultVal = agent?.systemPrompt ?? "# Default Prompt\nNo default instruction available.";
    onPromptDraftChange(defaultVal);
    
    const proposal = await onCreateEvolution(defaultVal, { changeOrigin: "reset_to_default" });
    if (!proposal) return;
    onTabChange("activity");
    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "초기화 검토 후보 생성" : "Reset review candidate created",
        desc: locale === "ko"
          ? "기본 프로필과 현재 프롬프트의 diff를 검토한 뒤 승인할 수 있습니다. 원본은 아직 유지됩니다."
          : "Review the default-profile diff before approval. The original remains intact.",
        type: "evolution"
      },
      ...prev
    ]);
  };

  const toggleItemExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // 메모리 규칙 개별 비활성화/활성화 토글
  const handleToggleRule = (section: "decisions" | "gotchas", id: string) => {
    void onSaveMemory((prev: typeof memoryParsed) => ({
      ...prev,
      [section]: prev[section].map(item => (item.id === id ? { ...item, enabled: item.enabled === false } : item)),
    }));

    const targetItem = memoryParsed[section].find(item => item.id === id);
    if (targetItem) {
      setTimelineEvents(prev => [
        {
          id: `timeline-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          title: targetItem.enabled === false
            ? (locale === "ko" ? "규칙 활성화" : "Rule enabled")
            : (locale === "ko" ? "규칙 비활성화" : "Rule disabled"),
          desc: locale === "ko"
            ? `'${targetItem.title}' 규칙의 런타임 적용 여부를 전환했습니다.`
            : `Toggled whether the '${targetItem.title}' rule applies at runtime.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(locale === "ko" ? "규칙 설정이 저장되었습니다." : "Rule setting saved.");
  };

  // 개별 규칙 Hub 공유 후보/로컬전용 토글
  const handleToggleSync = (section: "decisions" | "gotchas", id: string) => {
    void onSaveMemory((prev: typeof memoryParsed) => ({
      ...prev,
      [section]: prev[section].map(item => (item.id === id ? { ...item, synced: !item.synced } : item)),
    }));

    const targetItem = memoryParsed[section].find(item => item.id === id);
    const nextSynced = targetItem ? !targetItem.synced : false; // 토글 후 상태
    if (targetItem) {
      setTimelineEvents(prev => [
        {
          id: `timeline-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          title: nextSynced
            ? (locale === "ko" ? "클라우드 허브 공유" : "Shared to Cloud Hub")
            : (locale === "ko" ? "로컬 전용 전환" : "Switched to local-only"),
          desc: locale === "ko"
            ? `'${targetItem.title}' 규칙의 Hub 공유 후보 상태를 전환했습니다.`
            : `Toggled the Hub share candidate status of the '${targetItem.title}' rule.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(nextSynced
      ? (locale === "ko" ? "Hub 공유 후보로 표시했습니다." : "Marked as a Hub share candidate.")
      : (locale === "ko" ? "로컬 프로젝트 전용으로 변경되었습니다." : "Changed to local-project-only."));
  };

  // 미결 과제를 결정 사항(Decision)으로 반영 승격
  const handleResolveOpen = (id: string) => {
    const target = memoryParsed.openQuestions.find(item => item.id === id);
    if (!target) return;
    void onSaveMemory((prev: typeof memoryParsed) => {
      const t = prev.openQuestions.find(item => item.id === id);
      if (!t) return prev; // 이미 다른 변이로 처리됨
      return {
        ...prev,
        decisions: [...prev.decisions, { id: t.id, title: t.title, content: t.content + (locale === "ko" ? " (미결 항목 승격 반영)" : " (promoted from an open question)"), synced: globalHubSync, enabled: true }],
        openQuestions: prev.openQuestions.filter(item => item.id !== id),
      };
    });

    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "의사결정 공식 반영" : "Decision formally applied",
        desc: locale === "ko"
          ? `미결 과제였던 '${target.title}'건을 검토 후 공식 Decisions 룰로 승격 처리했습니다.`
          : `Reviewed the open question '${target.title}' and promoted it to an official Decisions rule.`,
        type: "resolve"
      },
      ...prev
    ]);

    showToast(locale === "ko" ? "미결 과제가 결정 사항(Decision)으로 승격 저장되었습니다." : "Open question promoted and saved as a Decision.");
  };

  // 온톨로지 인박스 제안 승인 & 메모리 병합
  const handleApproveInbox = (id: string) => {
    const target = ontologyInbox.find(item => item.id === id);
    if (!target) return;
    const updatedInbox = ontologyInbox.filter(item => item.id !== id);
    onSetOntologyInbox(updatedInbox);

    const newItem = {
      id: target.id,
      title: target.title,
      content: target.content,
      synced: target.source === "cloud" ? true : globalHubSync,
      enabled: true
    };

    void onSaveMemory((prev: typeof memoryParsed) =>
      target.type === "gotcha"
        ? { ...prev, gotchas: [...prev.gotchas, newItem] }
        : { ...prev, decisions: [...prev.decisions, newItem] },
    );

    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: target.source === "cloud"
          ? (locale === "ko" ? "허브 공유 지식 풀(Pull)" : "Pulled shared knowledge from Hub")
          : (locale === "ko" ? "로컬 자동 학습 병합" : "Merged local auto-learning"),
        desc: locale === "ko"
          ? `'${target.title}' 온톨로지 추천 피드백을 에이전트 지식베이스에 승인 및 결합 완료했습니다.`
          : `Approved and merged the ontology suggestion '${target.title}' into the agent's knowledge base.`,
        type: "resolve"
      },
      ...prev
    ]);

    showToast(locale === "ko"
      ? `학습 제안 '${target.title}'이 메모리에 병합 반영되었습니다.`
      : `Learning suggestion '${target.title}' merged into memory.`);
  };

  // 수동 스킬 주입도 먼저 durable candidate만 만든다. 파일/"완료" 메모리는
  // 별도 diff 승인 뒤 main-process CAS + receipt가 성공해야 생긴다.
  const handleInjectSkill = async (skill: { slug?: string; name: string; description: string }) => {
    const created = await onCreateSkillEvolution(skill);
    if (!created) return;
    setTimelineEvents((prev) => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "스킬 주입 검토 후보" : "Skill injection review candidate",
        desc: locale === "ko"
          ? `'${skill.name}' diff 후보를 만들었습니다. 승인 전에는 SKILL.md가 생성되지 않습니다.`
          : `Created a '${skill.name}' diff candidate. SKILL.md is not created before approval.`,
        type: "skill",
      },
      ...prev,
    ]);
  };


  // 아바타 그라데이션 모노그램
  const letters = node.name.slice(0, 2).toUpperCase();
  const getGradient = (tone?: string) => {
    switch (tone) {
      case "blue": return "linear-gradient(135deg, #5a56dc, #8a86e8)";
      case "green": return "linear-gradient(135deg, #56a14a, #a8d99b)";
      case "purple": return "linear-gradient(135deg, #7b4ed1, #c9a8ff)";
      case "amber": return "linear-gradient(135deg, #c98c1a, #f5c97a)";
      case "peach": return "linear-gradient(135deg, #c24a28, #ff7a55)";
      default: return "linear-gradient(135deg, #5a56dc, #c9a8ff)";
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }} data-tour-id="agents.detail">
      
      {/* 본 영역 (좌측 탭 컨텐츠) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100%", overflow: "hidden" }}>
        
        {/* 상단 액션 바 */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "var(--hairline)", background: "var(--paper)" }}>
          <button
            onClick={onBackToOverview}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 6,
              background: "var(--paper-2)",
              border: "1px solid var(--paper-edge)",
              color: "var(--ink-soft)",
              cursor: "pointer"
            }}
          >
            {locale === "ko" ? "← 회사 개요" : "← Company overview"}
          </button>
          <div style={{ height: 12, width: 1, background: "var(--paper-edge)" }} />
          <div style={{ fontSize: 13, color: "var(--muted-deep)" }}>
            {agent?.kind === "team" ? (locale === "ko" ? "팀 에이전트" : "Team agent") : (locale === "ko" ? "개별 전문가 에이전트" : "Individual specialist agent")}
          </div>
          {node.agentId && (
            <button
              className="agent-run-button"
              onClick={async () => {
                const api = ipc();
                if (!api || !node.agentId) return;
                try {
                  // 보유→가동 전환: 이 일꾼과 새 작업 채팅을 열어 바로 일을 시킨다.
                  const chat = await api.chats.create({ agentId: node.agentId });
                  navigate(`/chat?id=${chat.id}`);
                } catch {
                  /* 무시 */
                }
              }}
              title={locale === "ko" ? "이 에이전트와 새 작업을 시작합니다" : "Start a new task with this agent"}
            >
              {locale === "ko" ? "▶ 일 시키기" : "▶ Put to work"}
            </button>
          )}
          {agent && (
            <button
              className="titlebar-nodrag"
              onClick={onRemoveAgent}
              title={locale === "ko" ? "설치 목록에서 제거합니다. 원본 폴더는 삭제하지 않습니다." : "Remove from installed agents. The source folder is not deleted."}
              style={{
                marginLeft: node.agentId ? 0 : "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                minHeight: 30,
                padding: "0 10px",
                borderRadius: 7,
                border: "1px solid color-mix(in srgb, var(--red-deep, #b83b2f) 30%, var(--paper-edge))",
                background: "var(--paper)",
                color: "var(--red-deep, #b83b2f)",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <IconTrash size={13} />
              {locale === "ko" ? "제거" : "Remove"}
            </button>
          )}
        </div>

        {/* 에이전트 마스터 헤더 */}
        <header style={{ padding: "20px 24px", background: "var(--paper)", borderBottom: "var(--hairline)", display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "var(--radius-md)",
              background: getGradient(agent?.tone),
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              fontWeight: 700,
              boxShadow: "var(--glass-shadow)"
            }}
          >
            {letters}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
              <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>
                {node.name}
              </h1>
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "var(--fill-1)", color: "var(--accent)", fontWeight: 700 }}>
                {node.role}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)" }}>
              {agent?.tagline || (locale === "ko" ? `${node.name}의 규칙 지식베이스 및 계약 런타임` : `${node.name}'s rule knowledge base and contract runtime`)}
            </p>
          </div>
        </header>

        {/* 탭 네비게이션 */}
        <nav style={{ display: "flex", gap: 4, padding: "8px 24px", background: "var(--paper)", borderBottom: "var(--hairline)" }}>
          {(["identity", "memory", "playbook", "activity"] as const).map((tab) => {
            const active = activeTab === tab;
            const labels = {
              identity: locale === "ko" ? "정체성 & 페르소나" : "Identity & Persona",
              memory: locale === "ko" ? "큐레이팅된 메모리" : "Curated Memory",
              playbook: locale === "ko" ? "플레이북 & 워크플로우" : "Playbook & Workflow",
              activity: locale === "ko" ? "활동 및 자체 진화" : "Activity & Self-Evolution"
            };
            return (
              <button
                key={tab}
                onClick={() => onTabChange(tab)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12.5,
                  fontWeight: active ? 700 : 500,
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent)" : "var(--ink-soft)",
                  border: "none",
                  cursor: "pointer",
                  transition: "all 0.15s ease"
                }}
              >
                {labels[tab]}
              </button>
            );
          })}
        </nav>

        {/* 탭 콘텐츠 영역 */}
        <div style={{ flex: 1, overflowY: "auto", padding: 24, position: "relative" }}>
          
          {/* 탭 1: 정체성 & 페르소나 */}
          {activeTab === "identity" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 840 }}>
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h3 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700 }}>{locale === "ko" ? "시스템 프롬프트 (System Prompt)" : "System Prompt"}</h3>
                
                {editingPrompt ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <textarea
                      value={promptDraft}
                      onChange={(e) => onPromptDraftChange(e.target.value)}
                      style={{
                        width: "100%",
                        height: 280,
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        lineHeight: 1.6,
                        padding: 12,
                        borderRadius: "var(--radius-sm)",
                        background: "var(--paper-2)",
                        border: "1px solid var(--accent)",
                        color: "var(--ink)"
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => onSetEditingPrompt(false)}
                        style={{ padding: "6px 12px", border: "1px solid var(--paper-edge)", background: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                      >
                        {locale === "ko" ? "취소" : "Cancel"}
                      </button>
                      <button
                        onClick={() => void onSavePrompt()}
                        disabled={saving}
                        style={{ padding: "6px 12px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                      >
                        {saving ? (locale === "ko" ? "저장 중..." : "Saving...") : (locale === "ko" ? "반영하기" : "Apply")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    {(() => {
                      const promptSections = parsePromptSections(promptContent);
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          {/* 프롬프트 세부 분석 카드 3열 뷰 */}
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                            
                            {/* Directives */}
                            <div style={{ background: "rgba(90, 86, 220, 0.03)", border: "1px solid rgba(90, 86, 220, 0.15)", borderRadius: 8, padding: 12 }}>
                              <h4 style={{ margin: "0 0 8px 0", fontSize: 12, fontWeight: 700, color: "var(--accent)", display: "flex", alignItems: "center", gap: 4 }}>
                                <IconWand size={12} />
                                {locale === "ko" ? "지시사항 (Directives)" : "Directives"}
                              </h4>
                              {promptSections.directives.length === 0 ? (
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>{locale === "ko" ? "감지된 지시사항이 없습니다." : "No directives detected."}</span>
                              ) : (
                                <ul style={{ paddingLeft: 14, margin: 0, fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                                  {promptSections.directives.slice(0, 5).map((d, idx) => (
                                    <li key={idx} style={{ marginBottom: 4 }}>{d}</li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            {/* Constraints */}
                            <div style={{ background: "rgba(194, 74, 40, 0.03)", border: "1px solid rgba(194, 74, 40, 0.15)", borderRadius: 8, padding: 12 }}>
                              <h4 style={{ margin: "0 0 8px 0", fontSize: 12, fontWeight: 700, color: "var(--peach-ink)", display: "flex", alignItems: "center", gap: 4 }}>
                                <IconShield size={12} />
                                {locale === "ko" ? "제약조건 (Constraints)" : "Constraints"}
                              </h4>
                              {promptSections.constraints.length === 0 ? (
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>{locale === "ko" ? "감지된 제약사항이 없습니다." : "No constraints detected."}</span>
                              ) : (
                                <ul style={{ paddingLeft: 14, margin: 0, fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                                  {promptSections.constraints.slice(0, 5).map((c, idx) => (
                                    <li key={idx} style={{ marginBottom: 4 }}>{c}</li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            {/* Output Formats */}
                            <div style={{ background: "rgba(86, 161, 74, 0.03)", border: "1px solid rgba(86, 161, 74, 0.15)", borderRadius: 8, padding: 12 }}>
                              <h4 style={{ margin: "0 0 8px 0", fontSize: 12, fontWeight: 700, color: "var(--green-deep)", display: "flex", alignItems: "center", gap: 4 }}>
                                <IconLayers size={12} />
                                {locale === "ko" ? "입출력 형태 (Formats)" : "I/O Formats"}
                              </h4>
                              {promptSections.formats.length === 0 ? (
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>{locale === "ko" ? "감지된 규격정보가 없습니다." : "No format info detected."}</span>
                              ) : (
                                <ul style={{ paddingLeft: 14, margin: 0, fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                                  {promptSections.formats.slice(0, 5).map((f, idx) => (
                                    <li key={idx} style={{ marginBottom: 4 }}>{f}</li>
                                  ))}
                                </ul>
                              )}
                            </div>

                          </div>

                          {/* 전체 원문 아코디언 */}
                          <details style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                            <summary style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, color: "var(--ink-soft)", cursor: "pointer", outline: "none" }}>
                              {locale === "ko" ? "시스템 프롬프트 전체 원문(Source) 보기" : "View full system prompt source"}
                            </summary>
                            <pre
                              style={{
                                margin: 0,
                                padding: 12,
                                borderTop: "1px solid var(--paper-edge)",
                                fontSize: 11,
                                fontFamily: "var(--font-mono)",
                                lineHeight: 1.6,
                                whiteSpace: "pre-wrap",
                                overflowX: "auto",
                                color: "var(--ink-soft)",
                                maxHeight: 200,
                                overflowY: "auto"
                              }}
                            >
                              {promptContent || (locale === "ko" ? "로드된 프롬프트 내용이 없습니다." : "No prompt content loaded.")}
                            </pre>
                          </details>

                          {/* 컨트롤 액션 바 */}
                          <div style={{ display: "flex", justifyItems: "space-between", alignItems: "center", marginTop: 4 }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button
                                onClick={handleCopyPrompt}
                                style={{
                                  padding: "6px 12px",
                                  background: "var(--paper)",
                                  border: "1px solid var(--paper-edge)",
                                  borderRadius: 6,
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  boxShadow: "var(--shadow-1)",
                                  color: "var(--ink-soft)"
                                }}
                              >
                                {locale === "ko" ? "프롬프트 복사" : "Copy prompt"}
                              </button>
                              <button
                                onClick={handleResetPrompt}
                                style={{
                                  padding: "6px 12px",
                                  background: "var(--paper)",
                                  border: "1px solid var(--paper-edge)",
                                  borderRadius: 6,
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  boxShadow: "var(--shadow-1)",
                                  color: "var(--peach-ink)"
                                }}
                              >
                                {locale === "ko" ? "기본값 재설정" : "Reset to default"}
                              </button>
                            </div>
                            {agent?.localPath && (
                              <button
                                onClick={() => { onPromptDraftChange(promptContent); onSetEditingPrompt(true); }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  padding: "6px 12px",
                                  background: "var(--paper)",
                                  border: "1px solid var(--paper-edge)",
                                  borderRadius: 6,
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  boxShadow: "var(--shadow-1)",
                                  color: "var(--accent)"
                                }}
                              >
                                <IconEdit size={12} />
                                {locale === "ko" ? "프롬프트 편집" : "Edit prompt"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              <RuntimeAssignmentPanel
                node={node}
                agent={agent}
                nodeContext={nodeContext}
                runtimeStatuses={runtimeStatuses}
                runtimeOverrides={runtimeOverrides}
                onRuntimeOverridesChange={onRuntimeOverridesChange}
                showToast={showToast}
              />

              {/* 매핑 메타 데이터 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "런타임 정보" : "Runtime info"}</h4>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "var(--ink-soft)" }}>
                    <div><strong>{locale === "ko" ? "에이전트 ID:" : "Agent ID:"}</strong> {node.agentId ?? (locale === "ko" ? "미설치(임시)" : "Not installed (temporary)")}</div>
                    <div><strong>{locale === "ko" ? "적용 런타임:" : "Active runtime:"}</strong> {effectiveRuntimeOverride ? selectionSummary(effectiveRuntimeOverride.selection, locale) : (locale === "ko" ? "전역 자동 라우팅" : "Global auto-routing")}</div>
                    <div><strong>{locale === "ko" ? "신뢰 등급:" : "Trust grade:"}</strong> Trust {agent?.trustGrade ?? "B"}</div>
                    {agent && (() => {
                      const own = classifyAgent(agent, locale);
                      return (
                        <div className="agent-ownership-row" data-owned={own.owned ? "true" : "false"}>
                          <strong>{locale === "ko" ? "소유:" : "Ownership:"}</strong>{" "}
                          <span className="agent-ownership-badge" data-owned={own.owned ? "true" : "false"}>
                            {own.owned
                              ? `${own.label} · owned`
                              : (locale === "ko" ? "빌린 게스트 · borrowed" : "Borrowed guest · borrowed")}
                          </span>
                          <div className="agent-ownership-path">{own.origin}</div>
                          {own.localPath && own.origin !== own.localPath && (
                            <div className="agent-ownership-path">{own.localPath}</div>
                          )}
                          <div className="agent-ownership-note">
                            {own.owned
                              ? own.klass === "owned-cloud"
                                ? (locale === "ko" ? "검증된 package hash의 로컬 실행 사본 — Cloud 원본과 버전을 구분해 복원합니다." : "A local execution copy of the verified package hash — restored with its Cloud origin and version intact.")
                                : own.localPath
                                ? (locale === "ko" ? "내 디스크의 실제 폴더 — 게시자가 사라져도 안 죽는다." : "A real folder on my disk — it survives even if the publisher disappears.")
                                : (locale === "ko" ? "내 라이브러리에 설치됨 — 내 자산이다." : "Installed in my library — it's my asset.")
                              : (locale === "ko" ? "원격 게스트 — 게시자가 내리면 사용 불가. Fork 하면 내 것이 된다." : "Remote guest — unusable if the publisher takes it down. Fork it to make it yours.")}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "외부 도구연동" : "External tool integrations"}</h4>
                  <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    {agent?.mcpServers && agent.mcpServers.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        {agent.mcpServers.map((s) => (
                          <span key={s} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--fill-1)", color: "var(--accent)" }}>{s}</span>
                        ))}
                      </div>
                    ) : (
                      locale === "ko" ? "연동된 외부 MCP 서버 도구가 없습니다." : "No external MCP server tools connected."
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 탭 2: 큐레이팅된 메모리 */}
          {activeTab === "memory" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 840 }}>

              {/* 메모리 요약 — 비개발자 어휘로 한 문장. 그래프는 아래의 2차(고급) 보기에서. */}
              <div className="memory-summary">
                <div className="memory-summary-line">
                  {locale === "ko" ? "이 에이전트가 기억하는 것: 결정 " : "What this agent remembers: Decisions "}<strong>{memoryParsed.decisions.length}</strong>
                  {" · "}{locale === "ko" ? "주의 " : "Gotchas "}<strong>{memoryParsed.gotchas.length}</strong>
                  {" · "}{locale === "ko" ? "미결 " : "Open "}<strong>{memoryParsed.openQuestions.length}</strong>
                  {(() => {
                    const synced = [...memoryParsed.decisions, ...memoryParsed.gotchas].filter((r) => r.synced).length;
                    return synced > 0 ? <> · {locale === "ko" ? "허브 공유 " : "Hub-shared "}<strong>{synced}</strong></> : null;
                  })()}
                </div>
                <div className="memory-summary-note">
                  {locale === "ko"
                    ? "기억은 내 디스크의 markdown 파일로 저장됩니다 — 켜고 끈 상태도 파일에 함께 남아 새로고침해도 유지됩니다."
                    : "Memory is stored as markdown files on my disk — the on/off state is saved with the file too, so it persists across refreshes."}
                </div>
              </div>

              {/* 온톨로지 인박스 알림 영역 */}
              {ontologyInbox.length > 0 && (
                <div style={{ border: "1px solid var(--accent-soft)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
                  <div style={{ background: "var(--fill-1)", padding: "10px 16px", display: "flex", alignItems: "center", justifyItems: "space-between", borderBottom: "1px solid var(--accent-soft)" }}>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>
                      <IconBrain size={14} />
                      {locale === "ko" ? "온톨로지 인박스 (학습된 정보 추천)" : "Ontology inbox (learned-info suggestions)"}
                    </div>
                    <span style={{ fontSize: 10, background: "var(--accent)", color: "#fff", padding: "1px 6px", borderRadius: 999 }}>{ontologyInbox.length}</span>
                  </div>
                  <div style={{ background: "var(--paper)", display: "flex", flexDirection: "column" }}>
                    {ontologyInbox.map((item) => (
                      <div key={item.id} style={{ padding: "12px 16px", display: "flex", alignItems: "flex-start", justifyItems: "space-between", gap: 12, borderBottom: "1px solid var(--paper-edge)" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: item.source === "cloud" ? "var(--accent)" : "var(--fill-2)", color: item.source === "cloud" ? "#fff" : "var(--accent)" }}>
                              {item.source === "cloud" ? (locale === "ko" ? "허브 추천" : "Hub suggestion") : (locale === "ko" ? "로컬 학습" : "Local learning")}
                            </span>
                            <strong style={{ fontSize: 12.5, color: "var(--ink)" }}>{item.title}</strong>
                          </div>
                          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-soft)" }}>{item.content}</p>
                        </div>
                        <button
                          onClick={() => handleApproveInbox(item.id)}
                          style={{
                            padding: "6px 12px",
                            background: "var(--accent)",
                            color: "#fff",
                            border: "none",
                            borderRadius: 6,
                            fontSize: 11.5,
                            fontWeight: 600,
                            cursor: "pointer",
                            flexShrink: 0
                          }}
                        >
                          {locale === "ko" ? "반영 승인" : "Approve"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 메모리 리스트 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                
                {/* Decisions 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconCheck size={14} style={{ color: "var(--green-deep)" }} />
                    {locale === "ko" ? "결정 사항 (Decisions)" : "Decisions"}
                  </h3>
                  {memoryParsed.decisions.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      {locale === "ko" ? "기록된 결정 사항이 없습니다." : "No decisions recorded."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {memoryParsed.decisions.map((item) => {
                        const expanded = expandedItems[item.id];
                        const enabled = item.enabled !== false;
                        return (
                          <div
                            key={item.id}
                            style={{
                              background: "var(--paper)",
                              border: "1px solid var(--paper-edge)",
                              borderRadius: "var(--radius-sm)",
                              opacity: enabled ? 1 : 0.6,
                              transition: "all 0.15s"
                            }}
                          >
                            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyItems: "space-between", gap: 8 }}>
                              <button
                                onClick={() => toggleItemExpand(item.id)}
                                style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "none", border: "none", cursor: "pointer", color: "var(--ink)", textAlign: "left" }}
                              >
                                {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                                <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                              </button>
                              
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                {/* 클라우드 허브 공유 상태 */}
                                <button
                                  onClick={() => handleToggleSync("decisions", item.id)}
                                  title={item.synced ? (locale === "ko" ? "허브 동기화됨" : "Synced to Hub") : (locale === "ko" ? "로컬 전용 규칙" : "Local-only rule")}
                                  style={{
                                    border: "none",
                                    background: "none",
                                    cursor: "pointer",
                                    color: item.synced ? "var(--accent)" : "var(--muted)"
                                  }}
                                >
                                  <IconPaperclip size={12} />
                                </button>
                                {/* 규칙 활성 토글 */}
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={() => handleToggleRule("decisions", item.id)}
                                  style={{ width: 14, height: 14, cursor: "pointer" }}
                                />
                              </div>
                            </div>
                            
                            {expanded && (
                              <div style={{ padding: "0 14px 12px 34px", fontSize: 12, color: "var(--ink-soft)", borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                                <p style={{ margin: 0, lineHeight: 1.6 }}>{item.content}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Gotchas 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconShield size={14} style={{ color: "var(--peach-ink)" }} />
                    {locale === "ko" ? "주의 사항 (Gotchas)" : "Gotchas"}
                  </h3>
                  {memoryParsed.gotchas.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      {locale === "ko" ? "기록된 주의 사항이 없습니다." : "No gotchas recorded."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {memoryParsed.gotchas.map((item) => {
                        const expanded = expandedItems[item.id];
                        const enabled = item.enabled !== false;
                        return (
                          <div
                            key={item.id}
                            style={{
                              background: "var(--paper)",
                              border: "1px solid var(--paper-edge)",
                              borderRadius: "var(--radius-sm)",
                              opacity: enabled ? 1 : 0.6,
                              transition: "all 0.15s"
                            }}
                          >
                            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyItems: "space-between", gap: 8 }}>
                              <button
                                onClick={() => toggleItemExpand(item.id)}
                                style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "none", border: "none", cursor: "pointer", color: "var(--ink)", textAlign: "left" }}
                              >
                                {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                                <strong style={{ fontSize: 12.5, color: "var(--peach-ink)" }}>{item.title}</strong>
                              </button>
                              
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <button
                                  onClick={() => handleToggleSync("gotchas", item.id)}
                                  style={{ border: "none", background: "none", cursor: "pointer", color: item.synced ? "var(--accent)" : "var(--muted)" }}
                                >
                                  <IconPaperclip size={12} />
                                </button>
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={() => handleToggleRule("gotchas", item.id)}
                                  style={{ width: 14, height: 14, cursor: "pointer" }}
                                />
                              </div>
                            </div>
                            
                            {expanded && (
                              <div style={{ padding: "0 14px 12px 34px", fontSize: 12, color: "var(--ink-soft)", borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                                <p style={{ margin: 0, lineHeight: 1.6 }}>{item.content}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Open Questions 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconWand size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "미결 과제 (Open Questions)" : "Open Questions"}
                  </h3>
                  {memoryParsed.openQuestions.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      {locale === "ko" ? "기록된 미결 과제가 없습니다." : "No open questions recorded."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {memoryParsed.openQuestions.map((item) => (
                        <div
                          key={item.id}
                          style={{
                            background: "var(--paper)",
                            border: "1px solid var(--paper-edge)",
                            borderRadius: "var(--radius-sm)",
                            padding: "10px 14px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 12
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                            <p style={{ margin: "2px 0 0 0", fontSize: 11.5, color: "var(--ink-soft)" }}>{item.content}</p>
                          </div>
                          <button
                            onClick={() => handleResolveOpen(item.id)}
                            style={{
                              padding: "4px 10px",
                              background: "var(--fill-1)",
                              color: "var(--accent)",
                              border: "1px solid var(--accent-soft)",
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: "pointer",
                              whiteSpace: "nowrap"
                            }}
                          >
                            {locale === "ko" ? "결정 승격" : "Promote to decision"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

              {/* 메모리 진화 히스토리 타임라인 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 16px 0", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
                  <IconRoute size={14} style={{ color: "var(--accent)" }} />
                  {locale === "ko" ? "메모리 진화 히스토리 (Evolution Timeline)" : "Memory Evolution Timeline"}
                </h4>
                
                <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "relative", paddingLeft: 16, borderLeft: "2px solid var(--paper-edge)", marginLeft: 6 }}>
                  {observedTimelineEvents.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                      {locale === "ko"
                        ? "아직 기록된 진화 이벤트가 없습니다. 메모리 승격, 스킬 주입, 프롬프트 진화를 실행하면 여기에 남습니다."
                        : "No evolution events recorded yet. Promoting memory, injecting skills, or evolving the prompt will appear here."}
                    </div>
                  )}
                  {observedTimelineEvents.map((evt) => {
                    const colorMap = {
                      skill: "var(--purple-deep)",
                      sync: "var(--accent)",
                      evolution: "var(--amber-deep)",
                      resolve: "var(--green-deep)"
                    };
                    // DB 유래 행(kind 有)은 본문을 2줄로 접고 클릭 시 펼친다.
                    const isDbEntry = Boolean(evt.kind);
                    const expanded = !!expandedItems[evt.id];

                    return (
                      <div key={evt.id} style={{ position: "relative" }}>
                        {/* 타임라인 점 */}
                        <div style={{
                          position: "absolute",
                          left: -23,
                          top: 4,
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          background: "var(--paper)",
                          border: `3px solid ${colorMap[evt.type]}`,
                          zIndex: 2
                        }} />

                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
                            {evt.timestamp}
                          </span>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: colorMap[evt.type] }}>
                            {evt.title}
                          </span>
                          {evt.kind && (
                            <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 999, background: "var(--fill-1)", color: colorMap[evt.type], fontWeight: 700, fontFamily: "var(--font-mono)" }}>
                              {evt.kind}
                            </span>
                          )}
                          {evt.confidence && (
                            <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--paper-edge)", color: memoryConfidenceColor(evt.confidence), fontWeight: 700 }}>
                              {evt.confidence}
                            </span>
                          )}
                        </div>
                        <p
                          onClick={isDbEntry ? () => toggleItemExpand(evt.id) : undefined}
                          title={isDbEntry ? (locale === "ko" ? "클릭하여 펼치기/접기" : "Click to expand/collapse") : undefined}
                          style={{
                            margin: 0,
                            fontSize: 11.5,
                            color: "var(--ink-soft)",
                            lineHeight: 1.4,
                            ...(isDbEntry ? { cursor: "pointer" } : {}),
                            ...(isDbEntry && !expanded
                              ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }
                              : {}),
                          }}
                        >
                          {evt.desc}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          )}

          {/* 탭 3: 플레이북 & 워크플로우 */}
          {activeTab === "playbook" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 840 }}>
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 14px 0", fontSize: 13.5, fontWeight: 700 }}>{locale === "ko" ? "실행 루프 (Runtime Loop)" : "Runtime Loop"}</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                  {[
                    { label: "Route", desc: locale === "ko" ? "Chat 또는 Hub 호출에서 이 에이전트가 후보가 됩니다." : "This agent becomes a candidate on Chat or Hub invocations.", icon: IconRoute },
                    { label: "Context", desc: locale === "ko" ? "프로젝트, Env, 메모리 규칙이 invocation에 주입됩니다." : "Project, env, and memory rules are injected into the invocation.", icon: IconBrain },
                    { label: "Tools", desc: locale === "ko" ? "필요한 MCP 서버와 로컬 권한을 확인합니다." : "Checks the required MCP servers and local permissions.", icon: IconLayers },
                    { label: "Persist", desc: locale === "ko" ? "결정, 주의사항, 진화 로그를 로컬 파일에 남깁니다." : "Records decisions, gotchas, and evolution logs to local files.", icon: IconPaperclip },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.label} style={{ border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper-2)", padding: 12, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                          <Icon size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                          <strong style={{ fontSize: 12.5 }}>{item.label}</strong>
                        </div>
                        <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--ink-soft)" }}>{item.desc}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconRoute size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "라우팅 카드" : "Routing card"}
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55 }}>
                    <div><strong>{locale === "ko" ? "역할:" : "Role:"}</strong> {node.role || (locale === "ko" ? "자동 라우팅" : "Auto-routing")}</div>
                    <div><strong>Agent ID:</strong> {node.agentId ?? (locale === "ko" ? "미설치 노드" : "Uninstalled node")}</div>
                    <div><strong>{locale === "ko" ? "적용 런타임:" : "Active runtime:"}</strong> {effectiveRuntimeOverride ? selectionSummary(effectiveRuntimeOverride.selection, locale) : (locale === "ko" ? "런타임 자동 선택" : "Automatic runtime selection")}</div>
                    <div><strong>{locale === "ko" ? "신뢰 등급:" : "Trust grade:"}</strong> Trust {agent?.trustGrade ?? "B"}</div>
                    {agent && (() => {
                      const own = classifyAgent(agent, locale);
                      return (
                        <div>
                          <strong>{locale === "ko" ? "소유:" : "Ownership:"}</strong>{" "}
                          <span className="agent-ownership-badge" data-owned={own.owned ? "true" : "false"}>
                            {own.owned
                              ? `${own.label} · owned`
                              : (locale === "ko" ? "빌린 게스트 · borrowed" : "Borrowed guest · borrowed")}
                          </span>
                        </div>
                      );
                    })()}
                    <div><strong>{locale === "ko" ? "호출 경로:" : "Invocation paths:"}</strong> {locale === "ko" ? "Chat 멘션, Team 라우팅, Hub 후보 검색" : "Chat mentions, Team routing, Hub candidate search"}</div>
                  </div>
                </div>

                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconLayers size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "도구와 파일" : "Tools & files"}
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                    <MetricMini label="Files" value={agentFiles.length} />
                    <MetricMini label="MCP" value={agent?.mcpServers?.length ?? 0} />
                    <MetricMini label="Memory" value={memoryParsed.decisions.length + memoryParsed.gotchas.length} />
                    <MetricMini label="Open Q" value={memoryParsed.openQuestions.length} />
                  </div>
                  {(agent?.mcpServers?.length ?? 0) > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {agent!.mcpServers.map((server) => (
                        <span key={server} style={{ fontSize: 11, padding: "3px 7px", borderRadius: 999, background: "var(--fill-1)", color: "var(--ink-soft)", border: "1px solid var(--paper-edge)" }}>
                          {server}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                      {locale === "ko"
                        ? "연결된 MCP 서버가 없습니다. Hub Plugin에서 필요한 도구를 설치하면 이 에이전트의 도구 레이어와 함께 확인할 수 있습니다."
                        : "No MCP servers connected. Install the tools you need from Hub Plugin to see them alongside this agent's tool layer."}
                    </p>
                  )}
                </div>
              </div>

              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700 }}>{locale === "ko" ? "로컬 플레이북 소스" : "Local playbook source"}</h4>
                {agentFiles.length === 0 ? (
                  <div style={{ padding: 14, border: "1px dashed var(--paper-edge)", borderRadius: 10, color: "var(--muted-deep)", fontSize: 12 }}>
                    {locale === "ko"
                      ? "아직 읽힌 로컬 파일이 없습니다. 설치된 에이전트를 선택하면 AGENT.md, memory.md, skill 파일을 여기에서 확인합니다."
                      : "No local files read yet. Select an installed agent to view its AGENT.md, memory.md, and skill files here."}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    {agentFiles.slice(0, 12).map((file) => (
                      <div key={file.path} style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, padding: "8px 10px", background: "var(--paper-2)", minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{file.path}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 탭 4: 활동 및 자체 진화 */}
          {activeTab === "activity" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 840 }}>
              
              {/* 실 지표 — 이 에이전트의 실제 메모리·타임라인에서 도출 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>{locale === "ko" ? "활성 규칙 (Active rules)" : "Active rules"}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--green-deep)" }}>
                    {[...memoryParsed.decisions, ...memoryParsed.gotchas].filter((r) => r.enabled !== false).length}
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>{locale === "ko" ? "메모리 항목 (Memory items)" : "Memory items"}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--accent)" }}>
                    {memoryParsed.decisions.length + memoryParsed.gotchas.length + memoryParsed.openQuestions.length}
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>{locale === "ko" ? "진화·활동 이력 (Events)" : "Evolution & activity log (Events)"}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--peach-ink)" }}>{observedTimelineEvents.length}</div>
                </div>
              </div>

              {/* 자체 진화 프롬프트 디프 제안 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <div style={{ display: "flex", justifyItems: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconWand size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "에이전트 자산 진화 제안 (Agent Asset Proposal)" : "Agent Asset Evolution Proposal"}
                  </h4>
                  <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(245,201,122,0.16)", color: "var(--amber-deep)", fontWeight: 700 }}>
                    {pendingProposal
                      ? (locale === "ko" ? "승인 대기" : "Awaiting approval")
                      : recoveryProposal
                        ? (locale === "ko" ? "수동 비교·복구 필요" : "Manual diff/recovery required")
                      : displayedProposal?.status === "applied" || displayedProposal?.status === "measured"
                        ? (locale === "ko" ? "적용됨 · 롤백 가능" : "Applied · rollback available")
                        : displayedProposal?.status === "rolled_back"
                          ? (locale === "ko" ? "롤백 완료" : "Rolled back")
                      : hasPendingEvolution || runtimeEvolutionCandidates.length > 0
                        ? (locale === "ko" ? "후보 생성 가능" : "Candidate available")
                        : (locale === "ko" ? "최신 상태" : "Up to date")}
                  </span>
                </div>

                {!hasPendingEvolution && !displayedProposal && runtimeEvolutionCandidates.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "12px 4px", lineHeight: 1.6 }}>
                    {memoryEntries.length === 0 && memoryParsed.decisions.length + memoryParsed.gotchas.length === 0
                      ? (locale === "ko"
                          ? "아직 축적된 학습이 없습니다 — 에이전트가 작업을 수행하면 여기에 쌓입니다."
                          : "No learnings accumulated yet — they will build up here as the agent performs work.")
                      : (locale === "ko"
                          ? "메모리의 활성 규칙이 모두 시스템 프롬프트에 반영되어 있습니다. 메모리 탭에서 새 결정·주의 규칙이 학습되면 여기에 프롬프트 진화 제안이 나타납니다."
                          : "All active memory rules are already reflected in the system prompt. When new decision or gotcha rules are learned in the Memory tab, a prompt evolution proposal will appear here.")}
                  </div>
                )}

                {/* 런타임 학습(자동 수집) — 큐레이터 DB에서 온 진화 후보. memory.md 가 비어도 이 목록이 채워진다. */}
                {runtimeEvolutionCandidates.length > 0 && (
                  <div style={{ marginBottom: hasPendingEvolution || displayedProposal ? 14 : 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <strong style={{ fontSize: 12 }}>
                        {locale === "ko" ? "런타임 학습(자동 수집)" : "Runtime learnings (auto-collected)"}
                      </strong>
                      <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 700 }}>
                        {runtimeEvolutionCandidates.length}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {runtimeEvolutionCandidates.map((entry) => (
                        <label key={entry.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={!!selectedRuntimeIds[entry.id]}
                            onChange={() => setSelectedRuntimeIds((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))}
                            style={{ marginTop: 2, flexShrink: 0 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 999, background: "var(--fill-1)", color: "var(--accent)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
                                {entry.kind}
                              </span>
                              <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--paper-edge)", color: memoryConfidenceColor(entry.confidence), fontWeight: 700 }}>
                                {entry.confidence}
                              </span>
                              <span style={{ fontSize: 10, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
                                {formatMemoryEntryTime(entry.createdAt, locale)}
                              </span>
                              <span style={{ fontSize: 9.5, color: "var(--muted-deep)" }}>
                                {locale === "ko" ? "에이전트 전역 학습" : "Agent-global learning"}
                              </span>
                            </div>
                            <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{entry.content}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                      <button
                        onClick={() => void applyRuntimeEntries()}
                        disabled={selectedRuntimeEntries.length === 0 || saving || !!pendingProposal}
                        style={{
                          padding: "7px 12px",
                          background: selectedRuntimeEntries.length === 0 || saving || !!pendingProposal ? "var(--paper-2)" : "var(--accent)",
                          color: selectedRuntimeEntries.length === 0 || saving || !!pendingProposal ? "var(--muted-deep)" : "#fff",
                          border: "1px solid var(--paper-edge)",
                          borderRadius: 6,
                          fontSize: 11.5,
                          fontWeight: 650,
                          cursor: selectedRuntimeEntries.length === 0 || saving || !!pendingProposal ? "default" : "pointer",
                        }}
                      >
                        {locale === "ko"
                          ? `선택한 학습으로 검토 후보 만들기 (${selectedRuntimeEntries.length})`
                          : `Create review candidate (${selectedRuntimeEntries.length})`}
                      </button>
                    </div>
                  </div>
                )}

                {(hasPendingEvolution || displayedProposal) && (
                <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                  {/* 기존 버젼 */}
                  <div style={{ background: "rgba(255,138,138,0.04)" }}>
                    <div style={{ background: "rgba(255,138,138,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--red-deep)" }}>
                      {locale === "ko" ? "기존 버전 (Current)" : "Current"}
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {displayedEvolutionDiff.old}
                    </pre>
                  </div>
                  {/* 제안 버젼 */}
                  <div style={{ background: "rgba(168,217,155,0.04)", borderLeft: "1px solid var(--paper-edge)" }}>
                    <div style={{ background: "rgba(168,217,155,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--green-deep)" }}>
                      {locale === "ko" ? "개선 제안 (Evolved Draft)" : "Evolved Draft"}
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {displayedEvolutionDiff.new}
                    </pre>
                  </div>
                </div>

                {!pendingProposal && hasPendingEvolution && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                    <button
                      onClick={async () => {
                        await onCreateEvolution(evolutionDiff.new, { changeOrigin: "curated_memory_rules" });
                      }}
                      disabled={saving}
                      style={{
                        padding: "8px 14px",
                        background: "var(--accent)",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: saving ? "default" : "pointer",
                        opacity: saving ? 0.6 : 1,
                      }}
                    >
                      {locale === "ko" ? "diff 검토 후보 만들기" : "Create diff review candidate"}
                    </button>
                  </div>
	                )}

                  {pendingProposal && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                      <div style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.55, marginBottom: 10 }}>
                        {locale === "ko"
                          ? `후보 ${pendingProposal.id} · ${pendingProposal.targetPath} · before ${pendingProposal.beforeHash.slice(0, 12)} · after ${pendingProposal.afterHash.slice(0, 12)}. 승인 전에는 원본 파일과 패키지 버전이 유지됩니다.`
                          : `Candidate ${pendingProposal.id} · ${pendingProposal.targetPath} · before ${pendingProposal.beforeHash.slice(0, 12)} · after ${pendingProposal.afterHash.slice(0, 12)}. The original file and package version remain unchanged until approval.`}
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => void onRejectEvolution(pendingProposal.id)}
                          disabled={saving}
                          style={{ padding: "8px 12px", border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--ink-soft)", fontSize: 12, fontWeight: 650, cursor: saving ? "default" : "pointer" }}
                        >
                          {locale === "ko" ? "후보 거절" : "Reject candidate"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void onApproveEvolution(pendingProposal.id)}
                          disabled={saving}
                          style={{ padding: "8px 14px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 650, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}
                        >
                          {locale === "ko" ? "검토 완료 · 승인 및 적용" : "Review complete · approve & apply"}
                        </button>
                      </div>
                    </div>
                  )}

                  {recoveryProposal?.lastError && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--red-deep)", borderRadius: 8, background: "rgba(255,138,138,0.06)", color: "var(--red-deep)", fontSize: 11.5, lineHeight: 1.55 }}>
                      {locale === "ko"
                        ? `자동 덮어쓰기를 중단하고 현재 파일을 보존했습니다. Identity 탭의 현재 원문과 before/after hash를 직접 비교하세요. ${recoveryProposal.lastError}`
                        : `Automatic overwrite stopped and the current file was preserved. Compare the current Identity source with the before/after hashes. ${recoveryProposal.lastError}`}
                    </div>
                  )}

                  {displayedProposal && displayedProposal.receipts.length > 0 && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                      {displayedProposal.receipts.map((receipt) => (
                        <div key={receipt.id} style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.55, fontFamily: "var(--font-mono)", marginBottom: 6 }}>
                          {receipt.action.toUpperCase()} · asset v{receipt.versionBefore}→v{receipt.versionAfter} · governed {receipt.governedAssetHashBefore.slice(0, 12)}→{receipt.governedAssetHashAfter.slice(0, 12)} · receipt {receipt.id}
                        </div>
                      ))}
                      {(displayedProposal.status === "applied" || displayedProposal.status === "measured") && (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                          <button
                            type="button"
                            onClick={() => void onRollbackEvolution(displayedProposal.id)}
                            disabled={saving}
                            style={{ padding: "7px 12px", border: "1px solid var(--red-deep)", borderRadius: 6, background: "var(--paper)", color: "var(--red-deep)", fontSize: 11.5, fontWeight: 650, cursor: saving ? "default" : "pointer" }}
                          >
                            {locale === "ko" ? "이 영수증으로 롤백" : "Rollback from this receipt"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
	                </>
	                )}
	              </div>

	              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
	                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: skillDrawerOpen ? 12 : 0 }}>
	                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
	                    <IconLayers size={14} style={{ color: "var(--accent)" }} />
	                    {locale === "ko" ? "스킬 주입" : "Skill injection"}
	                  </h4>
	                  <button
	                    type="button"
	                    onClick={() => onSetSkillDrawerOpen(!skillDrawerOpen)}
	                    style={{
	                      padding: "7px 12px",
	                      background: skillDrawerOpen ? "var(--paper-2)" : "var(--accent)",
	                      color: skillDrawerOpen ? "var(--ink-soft)" : "#fff",
	                      border: skillDrawerOpen ? "1px solid var(--paper-edge)" : "1px solid var(--accent)",
	                      borderRadius: 6,
	                      fontSize: 12,
	                      fontWeight: 650,
	                      cursor: "pointer",
	                    }}
	                  >
	                    {skillDrawerOpen
	                      ? (locale === "ko" ? "닫기" : "Close")
	                      : (locale === "ko" ? "스킬 고르기" : "Choose skill")}
	                  </button>
	                </div>
	                {skillDrawerOpen && (
	                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
	                    {availableSkills.length === 0 ? (
	                      <div style={{ padding: 12, border: "1px dashed var(--paper-edge)", borderRadius: 8, color: "var(--muted-deep)", fontSize: 12 }}>
	                        {locale === "ko" ? "주입 가능한 스킬이 없습니다." : "No skills available to inject."}
	                      </div>
	                    ) : (
	                      availableSkills.map((skill) => (
	                        <div key={skill.slug ?? skill.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
	                          <div style={{ flex: 1, minWidth: 0 }}>
	                            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{skill.name}</div>
	                            <div style={{ fontSize: 11.5, color: "var(--ink-soft)", marginTop: 2, lineHeight: 1.45 }}>{skill.description}</div>
	                          </div>
	                          <button
	                            type="button"
	                            onClick={() => void handleInjectSkill(skill)}
	                            style={{
	                              padding: "6px 10px",
	                              background: "var(--accent)",
	                              color: "#fff",
	                              border: "none",
	                              borderRadius: 6,
	                              fontSize: 11.5,
	                              fontWeight: 650,
	                              cursor: "pointer",
	                              flexShrink: 0,
	                            }}
	                          >
	                            {locale === "ko" ? "주입" : "Inject"}
	                          </button>
	                        </div>
	                      ))
	                    )}
	                  </div>
	                )}
	              </div>

	              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
	                <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700 }}>
	                  {locale === "ko" ? "최근 활동" : "Recent activity"}
	                </h4>
	                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
	                  {observedTimelineEvents.slice(0, 6).map((evt) => (
	                    <div key={evt.id} style={{ border: "1px solid var(--paper-edge)", borderRadius: 8, padding: "9px 10px", background: "var(--paper-2)" }}>
	                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
	                        <span style={{ fontSize: 10.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>{evt.timestamp}</span>
	                        <strong style={{ fontSize: 12, color: "var(--ink)" }}>{evt.title}</strong>
	                      </div>
	                      <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{evt.desc}</div>
	                    </div>
	                  ))}
	                </div>
	              </div>

	            </div>
	          )}

        </div>
      </div>

    </div>
  );
}


// ── 시스템 프롬프트 세부 지시 구조화 파서 ──
function parsePromptSections(content: string) {
  const sections = {
    directives: [] as string[],
    constraints: [] as string[],
    formats: [] as string[],
    general: [] as string[],
  };
  
  if (!content) return sections;

  const lines = content.split("\n");
  let currentSec: "directives" | "constraints" | "formats" | "general" = "general";
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    if (trimmed.startsWith("#")) {
      const lower = trimmed.toLowerCase();
      if (lower.includes("directive") || lower.includes("instruction") || lower.includes("지시") || lower.includes("역할") || lower.includes("role")) {
        currentSec = "directives";
      } else if (lower.includes("constraint") || lower.includes("limit") || lower.includes("제약") || lower.includes("금지") || lower.includes("gotcha") || lower.includes("주의")) {
        currentSec = "constraints";
      } else if (lower.includes("output") || lower.includes("format") || lower.includes("포맷") || lower.includes("형태") || lower.includes("결과")) {
        currentSec = "formats";
      } else {
        currentSec = "general";
      }
      continue;
    }
    
    // 리스트 마커 및 강조 볼드 제거
    const cleanLine = trimmed
      .replace(/^-\s*\*\*[^*]+\*\*:\s*/, "")
      .replace(/^-\s*\*\*[^*]+\*\*\s*/, "")
      .replace(/^-\s*/, "")
      .replace(/^\*\s*/, "");
      
    if (!cleanLine) continue;
    sections[currentSec].push(cleanLine);
  }
  
  if (sections.directives.length === 0 && sections.constraints.length === 0 && sections.formats.length === 0) {
    sections.general.forEach(line => {
      if (line.includes("해야") || line.includes("하라") || line.includes("must") || line.includes("should") || line.includes("요구")) {
        sections.directives.push(line);
      } else if (line.includes("하지") || line.includes("금지") || line.includes("avoid") || line.includes("never") || line.includes("않는다") || line.includes("제한")) {
        sections.constraints.push(line);
      } else if (line.includes("포맷") || line.includes("json") || line.includes("형식") || line.includes("output") || line.includes("xml") || line.includes("구조")) {
        sections.formats.push(line);
      } else {
        sections.directives.push(line);
      }
    });
  }
  
  return sections;
}
