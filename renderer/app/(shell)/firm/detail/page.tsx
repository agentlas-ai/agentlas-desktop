// 회사 상세 — 조직도, 큐레이팅 메모리, 승인형 자산 진화, Experience/Ontology 관리.
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { isUserFacingAgentText, visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { AgentMemorySaveQueue, parseMemoryMarkdown, type ParsedMemory } from "@/lib/agent-memory";
import { classifyAgent } from "@/lib/ownership";
import type { Chat, InstalledAgent, InstalledFirm, ResolvedOrg, ResolvedNode, WorkspaceNode } from "@/lib/types";
import type { AgentEvolutionProposalUi, AgentLearningSummary, AgentMemoryEntryUi, ExperienceOntologyGraphSnapshot, ExperienceOntologySummary } from "@shared/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { ExperienceProfileCard } from "@/components/ExperienceProfileCard";
import {
  AgentLearningMetricGrid,
  AgentNameEditor,
  AgentOntologyGraphView,
  ExperienceOntologySummaryView,
  agentDisplayName,
} from "@/components/AgentExperienceInsights";
import { AgentLearningHistory, type AgentLearningEvent } from "@/components/AgentLearningHistory";
import { buildMemoryLearningEvent, formatLearningTime } from "@/lib/agent-learning-copy";
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
  IconPaperclip,
  IconRoute
} from "@/components/Icon";

export default function FirmDetailWrapper() {
  return (
    <Suspense fallback={null}>
      <FirmDetailRedirect />
    </Suspense>
  );
}

/**
 * Firm detail used to maintain a second, agent-centric copy of My Agents with
 * its own chat launcher, identity labels, and Experience semantics. Keep old
 * deep links working, but resolve them into the canonical project-toolbox
 * detail so a team has one user-facing model.
 */
function FirmDetailRedirect() {
  const searchParams = useSearchParams();
  const { locale } = useT();
  const id = searchParams.get("id") ?? "";

  useEffect(() => {
    navigate(id ? `/library/agents?firmId=${encodeURIComponent(id)}` : "/library/agents", "replace");
  }, [id]);

  return (
    <main role="status" style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 24, color: "var(--muted-deep)", fontSize: 13 }}>
      {locale === "ko" ? "팀 도구함으로 이동하는 중…" : "Opening the team toolbox…"}
    </main>
  );
}

function FirmDetailPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const { t, locale } = useT();
  const [firm, setFirm] = useState<InstalledFirm | null>(null);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState("");
  const [resolvedOrg, setResolvedOrg] = useState<ResolvedOrg | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState("");

  // 왼쪽 조직도 패널 너비 & 접기 상태 (localStorage 영속)
  const [orgWidth, setOrgWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 선택된 에이전트 노드 (null 이면 회사 오버뷰 노출)
  const [selectedNode, setSelectedNode] = useState<ResolvedNode | null>(null);
  const [activeTab, setActiveTab] = useState<"identity" | "memory" | "playbook" | "activity" | "ontology">("identity");

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
    setLoading(true);
    setLoadMessage("");
    if (!api || !id) {
      setLoadMessage(locale === "ko" ? "회사 정보를 열 수 없습니다. 바뀐 내용은 없습니다." : "Firm details could not be opened. Nothing changed.");
      setLoading(false);
      return;
    }
    try {
      const [f, ag, cs, org] = await Promise.all([
        api.firms.get(id),
        api.team.list(),
        api.chats.listByFirm(id),
        api.firms.getResolvedOrg(id),
      ]);
      if (!f) {
        navigate("/marketplace?tab=firms", "replace");
        return;
      }
      setFirm(f);
      setAgents(visibleAgents(ag));
      setChats(cs);
      setResolvedOrg(org);
    } catch (err) {
      setLoadMessage(locale === "ko" ? `회사 정보를 불러오지 못했습니다. 바뀐 내용은 없습니다. ${String(err)}` : `Firm details could not be loaded. Nothing changed. ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [id, locale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        }
      } catch (e) {
        // 파일 로드 실패 시에도 위에서 설정한 메타데이터 프롬프트가 남아있다.
        console.error("에이전트 파일 로드 실패:", e);
        if (!cancelled) showToast((locale === "ko" ? "에이전트 파일을 읽지 못했습니다. 메타데이터만 표시합니다: " : "Agent files could not be read. Showing metadata only: ") + String(e));
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

  async function startCeoChat() {
    const api = ipc();
    if (!api || !firm) return;
    navigate("/one");
  }

  async function resolveOrg() {
    const api = ipc();
    if (!api || !firm || resolving) return;
    setResolving(true);
    setResolveMsg("");
    try {
      const r = await api.firms.resolveOrg(firm.id);
      setResolveMsg(r.ok ? t("firm.resolve_ok") : r.error ?? "?");
      if (r.ok && r.org) setResolvedOrg(r.org);
    } catch (e) {
      setResolveMsg(String(e));
    } finally {
      setResolving(false);
    }
  }

  async function uninstall() {
    const api = ipc();
    if (!api || !firm) return;
    if (!confirm(t("firm.confirm_uninstall", { name: pickLocalized(firm, locale).name }))) return;
    await api.firms.uninstall(firm.id);
    navigate("/marketplace?tab=firms", "replace");
  }

  async function saveLocalDisplayName(agent: InstalledAgent, value: string) {
    const api = ipc();
    if (!api) throw new Error(locale === "ko" ? "Desktop 브리지를 사용할 수 없습니다." : "Desktop bridge is unavailable.");
    const updated = await api.team.setLocalDisplayName(agent.id, value);
    setAgents((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    setSelectedNode((current) => current?.agentId === updated.id
      ? { ...current, name: agentDisplayName(updated, locale) }
      : current);
    showToast(locale === "ko" ? "이 Mac의 표시 이름을 저장했습니다." : "Saved the display name for this Mac.");
  }

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
        source: { ...source, surface: "desktop.firm.agent_detail" },
        decisionNote: locale === "ko" ? "사용자가 검토 후보를 만들었습니다. 아직 적용되지 않았습니다." : "User created a review candidate. It is not applied yet.",
      });
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      showToast(locale === "ko" ? "검토 후보를 저장했습니다. 원본은 아직 유지됩니다." : "Review candidate saved. The original remains unchanged.");
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
          surface: "desktop.firm.skill_catalog",
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
      const proposal = await api.agentEvolution.approveAndApply(proposalId, locale === "ko" ? "사용자가 diff와 해시를 검토하고 승인했습니다." : "User reviewed the diff and hashes, then approved.");
      setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
      if (proposal.proposalType === "rule") {
        setPromptContent(proposal.afterContent);
      } else if (proposal.proposalType === "skill" && selectedNode?.agentId) {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        setAgentFiles(listing.entries.filter((entry) => entry.kind === "file"));
      }
      showToast(locale === "ko" ? "승인 적용 및 영수증 저장 완료" : "Approved, applied, and receipted");
    } catch (e) {
      showToast((locale === "ko" ? "승인 적용 실패: " : "Approval/apply failed: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  async function rejectEvolutionProposal(proposalId: string) {
    const api = ipc();
    if (!api) return;
    const proposal = await api.agentEvolution.reject(proposalId, locale === "ko" ? "사용자가 검토 후 거절했습니다." : "User rejected after review.");
    setEvolutionProposals((prev) => [proposal, ...prev.filter((item) => item.id !== proposal.id)]);
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
      } else if (proposal.proposalType === "skill" && selectedNode?.agentId) {
        const listing = await api.agentFiles.list(selectedNode.agentId);
        setAgentFiles(listing.entries.filter((entry) => entry.kind === "file"));
      }
      showToast(locale === "ko" ? "검증된 영수증으로 롤백했습니다." : "Rolled back from the verified receipt.");
    } catch (e) {
      showToast((locale === "ko" ? "롤백 차단/실패: " : "Rollback blocked/failed: ") + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  // library/agents와 같은 공용 per-agent 저장 큐. 빠른 연속 변이는 최신 낙관 상태에
  // 누적되고, 디스크 저장은 해당 에이전트의 마지막 durable 원문부터 순서대로 진행된다.
  function saveMemory(updater: (previous: typeof memoryParsed) => typeof memoryParsed) {
    const api = ipc();
    const agentId = selectedNode?.agentId;
    if (!api || !agentId) return Promise.resolve();
    const memFile = agentFiles.find((entry) => entry.name.toLowerCase() === "memory.md");
    const path = memFile?.path ?? "memory.md";
    const header = locale === "ko"
      ? "# Oberon Film Studio — Memory\n\n작품 간(cross-production)에 유지할 학습·결정·게이트 근거를 적는다. 작품별 휘발 상태는 여기 두지 않는다.\n\n"
      : "# Oberon Film Studio — Memory\n\nLearnings, decisions, and gate rationale to keep across productions (cross-production). Per-production transient state doesn't belong here.\n\n";
    const { completion } = memorySaveQueueRef.current.enqueue({
      agentId,
      updater,
      locale,
      header,
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

  if (loading || !firm) {
    return (
      <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
        <section style={{ maxWidth: 720, margin: "24px auto", padding: "0 24px" }}>
          <div style={{ ...firmNotice, display: "grid", gap: 6 }}>
            <span>{loading
              ? locale === "ko" ? "회사 정보를 불러오는 중입니다…" : "Loading firm details…"
              : loadMessage || (locale === "ko" ? "회사 정보를 열 수 없습니다." : "Firm details could not be opened.")}</span>
            {loading && <LoadingEstimate locale={locale} operationKey="desktop-firm-detail" expectedSeconds={[1, 25]} />}
          </div>
        </section>
      </div>
    );
  }
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const firmLoc = pickLocalized(firm, locale);

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* 1. 왼쪽 접이식 사이드바 (조직도 구성) */}
      <aside
        className="glass-thin"
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
              <div
                onClick={() => setSelectedNode(null)}
                style={{ flex: 1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
              >
                <IconBuilding size={14} style={{ color: "var(--accent)" }} />
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {firmLoc.name}
                </div>
              </div>
              <button
                onClick={() => void resolveOrg()}
                disabled={resolving}
                style={{
                  fontSize: 10,
                  padding: "4px 8px",
                  borderRadius: 999,
                  background: "var(--paper-2)",
                  border: "1px solid var(--paper-edge)",
                  color: "var(--ink-soft)",
                  cursor: resolving ? "default" : "pointer",
                }}
              >
                {resolving ? "..." : (locale === "ko" ? "분석" : "Analyze")}
              </button>
            </div>
          )}
        </header>

        {/* 조직도 목록 */}
        <div style={{ flex: 1, overflowY: "auto", padding: sidebarCollapsed ? "12px 6px" : 12 }}>
          {sidebarCollapsed ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              {resolvedOrg ? (
                <>
                  <MiniNodeAvatar node={withAgentDisplayName(resolvedOrg.ceo, agentMap, locale)} active={selectedNode?.id === resolvedOrg.ceo.id} onClick={() => { setSelectedNode(withAgentDisplayName(resolvedOrg.ceo, agentMap, locale)); setActiveTab("identity"); }} />
                  {resolvedOrg.divisions.map((d) => (
                    <div key={d.id} style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--paper-edge)", paddingTop: 8 }}>
                      <MiniNodeAvatar node={withAgentDisplayName(d, agentMap, locale)} active={selectedNode?.id === d.id} onClick={() => { setSelectedNode(withAgentDisplayName(d, agentMap, locale)); setActiveTab("identity"); }} />
                      {d.specialists.map((s) => (
                        <MiniNodeAvatar key={s.id} node={withAgentDisplayName(s, agentMap, locale)} active={selectedNode?.id === s.id} onClick={() => { setSelectedNode(withAgentDisplayName(s, agentMap, locale)); setActiveTab("identity"); }} />
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                firm.orgChart.map((n) => {
                  const agent = agentMap.get(n.agentId);
                  return (
                    <MiniNodeAvatar
                      key={n.agentSlug}
                      node={{ name: agent ? agentDisplayName(agent, locale) : n.role, role: n.role }}
                      active={selectedNode?.id === n.agentSlug}
                      onClick={() => {
                        const resolved: ResolvedNode = { id: n.agentSlug, name: agent ? agentDisplayName(agent, locale) : n.role, role: n.role, agentId: n.agentId };
                        setSelectedNode(resolved);
                        setActiveTab("identity");
                      }}
                    />
                  );
                })
              )}
            </div>
          ) : resolvedOrg ? (
            <ResolvedOrgChart org={resolvedOrg} agentMap={agentMap} locale={locale} selectedId={selectedNode?.id ?? null} onSelect={(node) => { setSelectedNode(node); setActiveTab("identity"); }} />
          ) : (
            <OrgChart firm={firm} agentMap={agentMap} locale={locale} selectedId={selectedNode?.id ?? null} onSelect={(node) => { setSelectedNode(node); setActiveTab("identity"); }} />
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
          <div style={{ flex: 1, overflowY: "auto" }}>
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
                <div style={{ fontSize: 10, color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "var(--font-mono)" }}>
                  {t("firm.kind")} · {firm.persona}
                </div>
                <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {firmLoc.name}
                </h1>
              </div>
              <button
                onClick={() => void startCeoChat()}
                className="titlebar-nodrag"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 999, background: "var(--paper)", color: "var(--ink)", fontWeight: 600, fontSize: 13, border: "1px solid var(--paper-edge)", boxShadow: "var(--neu-raised)", cursor: "pointer" }}
              >
                <IconChat size={14} />
                {t("firm.ceo.command")}
              </button>
              <button onClick={() => void uninstall()} className="titlebar-nodrag" style={{ color: "var(--muted-deep)", padding: 6, background: "none", border: "none", cursor: "pointer" }}>
                <IconTrash size={16} />
              </button>
            </header>

            <section style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}>
              <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.6 }}>{firmLoc.tagline}</p>
              
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
                        href="/one"
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
            onSaveAlias={(value) => {
              const current = agents.find((item) => item.id === selectedNode.agentId);
              return current ? saveLocalDisplayName(current, value) : Promise.resolve();
            }}
          />
        )}
      </main>
    </div>
  );
}

const firmNotice: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: 16,
  fontSize: 13,
  lineHeight: 1.5,
};

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
function ResolvedOrgChart({ org, agentMap, locale, selectedId, onSelect }: { org: ResolvedOrg; agentMap: Map<string, InstalledAgent>; locale: Locale; selectedId: string | null; onSelect: (node: ResolvedNode) => void }) {
  const divisions = org.divisions.filter(
    (division) =>
      isUserFacingAgentText(division.name, division.role) ||
      division.specialists.some((specialist) => isUserFacingAgentText(specialist.name, specialist.role)),
  );
  const showCeo = isUserFacingAgentText(org.ceo.name, org.ceo.role);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {showCeo && <OrgNodeCard node={withAgentDisplayName(org.ceo, agentMap, locale)} tier={1} active={selectedId === org.ceo.id} onClick={() => onSelect(withAgentDisplayName(org.ceo, agentMap, locale))} />}
      {divisions.map((d) => {
        const specialists = d.specialists.filter((specialist) => isUserFacingAgentText(specialist.name, specialist.role));
        const showDivision = isUserFacingAgentText(d.name, d.role);
        return (
          <div key={d.id}>
            {showDivision ? (
              <OrgNodeCard node={withAgentDisplayName(d, agentMap, locale)} tier={2} active={selectedId === d.id} onClick={() => onSelect(withAgentDisplayName(d, agentMap, locale))} />
            ) : (
              <OrgGroupLabel node={d} />
            )}
            {specialists.length > 0 && (
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
              {specialists.map((s) => (
                <OrgNodeCard key={s.id} node={withAgentDisplayName(s, agentMap, locale)} tier={3} active={selectedId === s.id} onClick={() => onSelect(withAgentDisplayName(s, agentMap, locale))} />
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
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
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
          color: isCeo ? "var(--white)" : "var(--ink-soft)",
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
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <strong style={{ fontSize: tier === 3 ? 11.5 : 12.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {node.name}
          </strong>
          {node.role && node.role !== node.name && (
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--paper-2)", color: "var(--muted-deep)", whiteSpace: "nowrap" }}>
              {node.role}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function withAgentDisplayName(node: ResolvedNode, agentMap: Map<string, InstalledAgent>, locale: Locale): ResolvedNode {
  const agent = node.agentId ? agentMap.get(node.agentId) : null;
  return agent ? { ...node, name: agentDisplayName(agent, locale) } : node;
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
    return firm.orgChart.filter((n) => n.reportsTo === parentSlug && isUserFacingAgentText(n.agentSlug, n.role));
  }

  function renderNode(node: typeof firm.orgChart[number], depth: number): React.ReactNode {
    const agent = agentMap.get(node.agentId);
    const agentLoc = agent ? pickLocalized(agent, locale) : null;
    const kids = children(node.agentSlug);
    const isCeo = node.reportsTo === null;
    const active = selectedId === node.agentSlug;
    const displayName = agent ? agentDisplayName(agent, locale) : agentLoc?.name ?? node.role;

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
          style={{
            display: "flex",
            alignItems: "center",
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
              color: isCeo ? "var(--white)" : "var(--ink-soft)",
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
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <strong style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {displayName}
              </strong>
              <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--paper-2)", color: "var(--muted-deep)", whiteSpace: "nowrap" }}>
                {node.role}
              </span>
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

  if (isUserFacingAgentText(ceo.agentSlug, ceo.role)) return renderNode(ceo, 0);
  const roots = children(ceo.agentSlug);
  if (roots.length === 0) return <div style={{ fontSize: 12, color: "var(--muted)" }}>{locale === "ko" ? "표시할 에이전트가 없습니다." : "No agents to display."}</div>;
  return <>{roots.map((node) => renderNode(node, 0))}</>;
}

// ── 3. 에이전트 상세 컨트롤 타워 뷰 컴포넌트 ──────────
interface AgentDetailViewProps {
  node: ResolvedNode;
  agent: InstalledAgent | null;
  activeTab: "identity" | "memory" | "playbook" | "activity" | "ontology";
  onTabChange: (tab: "identity" | "memory" | "playbook" | "activity" | "ontology") => void;
  onBackToOverview: () => void;
  memoryParsed: ParsedMemory;
  onSaveMemory: (updater: (previous: ParsedMemory) => ParsedMemory) => Promise<void>;
  promptContent: string;
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
  onSaveAlias: (value: string) => Promise<void>;
}

// ── 3.5 정보 흐름 연결 맵 (Information Flow Mapper) ──
// upstream/downstream 은 Hephaestus AO(Agent Ontology) 그래프의 실제 엣지에서 도출하고,
// 그래프가 없으면 역할 휴리스틱으로 폴백한다. (library/agents 의 동일 컴포넌트와 짝)
function flowHeuristic(role: string): { upstream: string; downstream: string } {
  const r = role.toLowerCase();
  if (r.includes("dp") || r.includes("planner") || role.includes("카메라")) return { upstream: "Screenwriter / Director", downstream: "Keyframe Generator" };
  if (r.includes("writer") || r.includes("creative") || role.includes("작가")) return { upstream: "Executive Producer / CEO", downstream: "DP / Shot Planner" };
  if (r.includes("keyframe") || r.includes("animator") || role.includes("키프레임")) return { upstream: "DP / Shot Planner", downstream: "QA Supervisor" };
  if (r.includes("qa") || r.includes("supervisor") || role.includes("검증")) return { upstream: "Keyframe Generator", downstream: "Video Compositor" };
  if (r.includes("compositor") || r.includes("editor") || role.includes("편집")) return { upstream: "QA Supervisor", downstream: "Audio & Sync Master" };
  if (r.includes("audio") || r.includes("sound") || role.includes("오디오")) return { upstream: "Video Compositor", downstream: "Delivery Agent (Publish)" };
  return { upstream: "EP / CEO (Showrunner)", downstream: "Production Engine" };
}

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
  const [flow, setFlow] = useState<{ upstream: string; downstream: string }>(flowHeuristic(node.role));
  const [fromEngine, setFromEngine] = useState(false);

  useEffect(() => {
    setFlow(flowHeuristic(node.role));
    setFromEngine(false);
    let cancelled = false;
    const api = ipc();
    if (!api) return;
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
      .catch(() => {});
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
          <span style={{ fontSize: 8.5, padding: "1px 6px", borderRadius: 999, background: "rgba(12,166,120,0.12)", color: "var(--green-deep, var(--ok))", letterSpacing: 0.3 }}>
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

// ── 3. 에이전트 상세 컨트롤 타워 뷰 컴포넌트 ──────────
interface AgentDetailViewProps {
  node: ResolvedNode;
  agent: InstalledAgent | null;
  activeTab: "identity" | "memory" | "playbook" | "activity" | "ontology";
  onTabChange: (tab: "identity" | "memory" | "playbook" | "activity" | "ontology") => void;
  onBackToOverview: () => void;
  memoryParsed: ParsedMemory;
  onSaveMemory: (updater: (previous: ParsedMemory) => ParsedMemory) => Promise<void>;
  promptContent: string;
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
  onSaveAlias: (value: string) => Promise<void>;
  agentFiles: WorkspaceNode[];
  /** 런타임 durable 메모리(큐레이터 DB) — memory.md 없이도 진화 타임라인을 채우는 실측 소스. */
  memoryEntries: AgentMemoryEntryUi[];
  evolutionProposals: AgentEvolutionProposalUi[];
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
  onSaveAlias,
  agentFiles
}: AgentDetailViewProps) {
  const { locale } = useT();

  // 규칙 카드별 열림/닫힘(Accordion) 관리 상태
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  
  // 헤바이스토스 네트워크 전체 싱크 모드 토글
  const [globalHubSync, setGlobalHubSync] = useState(true);
  const [learningSummary, setLearningSummary] = useState<AgentLearningSummary | null>(null);
  const [learningSummaryLoading, setLearningSummaryLoading] = useState(false);
  const [learningSummaryError, setLearningSummaryError] = useState("");
  const [ontologySummary, setOntologySummary] = useState<ExperienceOntologySummary | null>(null);
  const [ontologySummaryLoading, setOntologySummaryLoading] = useState(false);
  const [ontologySummaryError, setOntologySummaryError] = useState("");
  const [ontologyGraph, setOntologyGraph] = useState<ExperienceOntologyGraphSnapshot | null>(null);
  const [ontologyGraphLoading, setOntologyGraphLoading] = useState(false);
  const [ontologyGraphError, setOntologyGraphError] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api || !agent?.id) {
      setLearningSummary(null);
      setLearningSummaryLoading(false);
      setLearningSummaryError(locale === "ko" ? "설치된 에이전트의 학습 기록만 볼 수 있습니다." : "Learning history is available only for installed agents.");
      return;
    }
    let cancelled = false;
    setLearningSummaryLoading(true);
    setLearningSummaryError("");
    void api.agentLearning.summary(agent.id)
      .then((summary) => { if (!cancelled) setLearningSummary(summary); })
      .catch((reason) => {
        if (!cancelled) {
          setLearningSummary(null);
          setLearningSummaryError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => { if (!cancelled) setLearningSummaryLoading(false); });
    return () => { cancelled = true; };
  }, [agent?.id, locale]);

  useEffect(() => {
    if (activeTab !== "ontology") return;
    const api = ipc();
    if (!api || !agent?.id) {
      setOntologyGraph(null);
      setOntologyGraphLoading(false);
      setOntologyGraphError(true);
      return;
    }
    let cancelled = false;
    setOntologyGraph(null);
    setOntologyGraphLoading(true);
    setOntologyGraphError(false);
    void api.experience.ontologyGraph(agent.id)
      .then((snapshot) => {
        if (!cancelled) {
          setOntologyGraph(snapshot);
          setOntologyGraphError(false);
        }
      })
      .catch((reason) => {
        console.warn("[ontology-atlas] relation graph unavailable", reason);
        if (!cancelled) {
          setOntologyGraph(null);
          setOntologyGraphError(true);
        }
      })
      .finally(() => { if (!cancelled) setOntologyGraphLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, agent?.id]);

  useEffect(() => {
    if (activeTab !== "ontology") return;
    const api = ipc();
    if (!api || !agent?.id) {
      setOntologySummary(null);
      setOntologySummaryLoading(false);
      setOntologySummaryError(locale === "ko" ? "설치된 에이전트만 경험 요약을 조회할 수 있습니다." : "Only installed agents have an experience summary.");
      return;
    }
    let cancelled = false;
    setOntologySummaryLoading(true);
    setOntologySummaryError("");
    void api.experience.ontologySummary(agent.id)
      .then((summary) => { if (!cancelled) setOntologySummary(summary); })
      .catch((reason) => {
        if (!cancelled) {
          setOntologySummary(null);
          setOntologySummaryError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => { if (!cancelled) setOntologySummaryLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, agent?.id, locale]);

  // 메모리 진화 타임라인 관리 상태
  const [timelineEvents, setTimelineEvents] = useState<AgentLearningEvent[]>([
    { id: "timeline-1", timestamp: "2026-06-26 10:15", title: locale === "ko" ? "에이전트 준비 완료" : "Agent is ready", desc: locale === "ko" ? "이 컴퓨터에서 에이전트를 사용할 준비를 마쳤습니다." : "This agent is ready to use on this computer.", type: "sync" },
    { id: "timeline-2", timestamp: "2026-06-26 11:20", title: locale === "ko" ? "기억 불러오기 완료" : "Memory is ready", desc: locale === "ko" ? "에이전트의 역할과 기존 기억을 불러왔습니다." : "Loaded the agent's role and existing memory.", type: "sync" }
  ]);

  // 카메라 연출 인터랙션 칩 상태
  const [selectedTechnique, setSelectedTechnique] = useState<"orbit" | "crane" | "dolly-zoom" | "pan-tilt">("orbit");

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

  // 런타임 durable 메모리(큐레이터 DB) → 타임라인 행(최신순) 합류 — memory.md 없이도 실제 학습이 보인다.
  const displayTimelineEvents = useMemo(() => {
    const dbRows: AgentLearningEvent[] = [...memoryEntries]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((entry) => buildMemoryLearningEvent(entry, locale));
    const proposalRows: typeof dbRows = [...evolutionProposals]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((proposal) => ({
        id: `proposal-${proposal.id}`,
        timestamp: formatLearningTime(proposal.appliedAt || proposal.updatedAt, locale),
        title: locale === "ko" ? "에이전트 개선 기록" : "Agent improvement recorded",
        desc: proposal.summary,
        detail: `${proposal.status} · ${proposal.targetPath}`,
        type: "evolution",
      }));
    const merged: typeof dbRows = [...timelineEvents, ...proposalRows, ...dbRows];
    return merged;
  }, [evolutionProposals, memoryEntries, timelineEvents, locale]);

  const toggleItemExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // 메모리 규칙 개별 비활성화/활성화 토글
  const handleToggleRule = (section: "decisions" | "gotchas", id: string) => {
    let targetItem: ParsedMemory["decisions"][number] | undefined;
    void onSaveMemory((previous) => {
      const updatedSection = previous[section].map((item) => {
        if (item.id !== id) return item;
        targetItem = { ...item, enabled: item.enabled === false };
        return targetItem;
      });
      return { ...previous, [section]: updatedSection };
    });

    const toggledItem = targetItem;
    if (toggledItem) {
      setTimelineEvents(prev => [
        {
          id: `timeline-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          title: toggledItem.enabled !== false ? (locale === "ko" ? "규칙 활성화" : "Rule activated") : (locale === "ko" ? "규칙 비활성화" : "Rule deactivated"),
          desc: locale === "ko" ? `'${toggledItem.title}' 규칙의 런타임 적용 여부를 전환했습니다.` : `Toggled runtime application of rule '${toggledItem.title}'.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(locale === "ko" ? "규칙 설정이 저장되었습니다." : "Rule settings saved.");
  };

  // 개별 규칙 클라우드 허브(MongoDB) 공유/로컬전용 토글
  const handleToggleSync = (section: "decisions" | "gotchas", id: string) => {
    let targetItem: ParsedMemory["decisions"][number] | undefined;
    void onSaveMemory((previous) => {
      const updatedSection = previous[section].map((item) => {
        if (item.id !== id) return item;
        targetItem = { ...item, synced: !item.synced };
        return targetItem;
      });
      return { ...previous, [section]: updatedSection };
    });

    const toggledItem = targetItem;
    if (toggledItem) {
      setTimelineEvents(prev => [
        {
          id: `timeline-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          title: toggledItem.synced ? (locale === "ko" ? "클라우드 허브 공유" : "Shared to cloud hub") : (locale === "ko" ? "로컬 전용 전환" : "Switched to local-only"),
          desc: locale === "ko" ? `'${toggledItem.title}' 규칙을 Hephaestus 클라우드 데이터베이스에 연동/격리했습니다.` : `Synced/isolated rule '${toggledItem.title}' with the Hephaestus cloud database.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(toggledItem?.synced ? (locale === "ko" ? "Hephaestus 클라우드 허브에 연동 공유되었습니다." : "Shared to the Hephaestus cloud hub.") : (locale === "ko" ? "로컬 프로젝트 전용으로 변경되었습니다." : "Changed to local-project only."));
  };

  // 미결 과제를 결정 사항(Decision)으로 반영 승격
  const handleResolveOpen = (id: string) => {
    let target: ParsedMemory["openQuestions"][number] | undefined;
    void onSaveMemory((previous) => {
      target = previous.openQuestions.find((item) => item.id === id);
      if (!target) return previous;
      const newDecision = {
        id: target.id,
        title: target.title,
        content: target.content + (locale === "ko" ? " (미결 항목 승격 반영)" : " (promoted from an open question)"),
        synced: globalHubSync,
        enabled: true,
      };
      return {
        ...previous,
        decisions: [...previous.decisions, newDecision],
        openQuestions: previous.openQuestions.filter((item) => item.id !== id),
      };
    });
    const resolvedTarget = target;
    if (!resolvedTarget) return;
    
    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: locale === "ko" ? "의사결정 공식 반영" : "Decision formally recorded",
        desc: locale === "ko" ? `미결 과제였던 '${resolvedTarget.title}'건을 검토 후 공식 Decisions 룰로 승격 처리했습니다.` : `Reviewed the open question '${resolvedTarget.title}' and promoted it to a formal Decisions rule.`,
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

    void onSaveMemory((previous) => target.type === "gotcha"
      ? { ...previous, gotchas: [...previous.gotchas, newItem] }
      : { ...previous, decisions: [...previous.decisions, newItem] });
    
    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: target.source === "cloud" ? (locale === "ko" ? "허브 공유 지식 풀(Pull)" : "Pulled shared hub knowledge") : (locale === "ko" ? "로컬 자동 학습 병합" : "Merged local auto-learning"),
        desc: locale === "ko" ? `'${target.title}' 경험 추천 피드백을 에이전트 지식베이스에 승인 및 결합 완료했습니다.` : `Approved and merged the experience recommendation '${target.title}' into the agent's knowledge base.`,
        type: "resolve"
      },
      ...prev
    ]);

    showToast(locale === "ko" ? `학습 제안 '${target.title}'이 메모리에 병합 반영되었습니다.` : `Learning suggestion '${target.title}' merged into memory.`);
  };

  // 수동 스킬 주입도 승인 전에는 candidate/diff만 만든다.
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
  const detailDisplayName = agent ? agentDisplayName(agent, locale) : node.name;
  const letters = detailDisplayName.slice(0, 2).toUpperCase();
  const getGradient = (tone?: string) => {
    switch (tone) {
      case "blue": return "linear-gradient(135deg, var(--info), var(--info-soft))";
      case "green": return "linear-gradient(135deg, var(--ok), var(--ok-soft))";
      case "purple": return "linear-gradient(135deg, var(--purple-deep), var(--purple-soft))";
      case "amber": return "linear-gradient(135deg, var(--warn), var(--warn-soft))";
      case "peach": return "linear-gradient(135deg, var(--danger), var(--danger-soft))";
      default: return "linear-gradient(135deg, var(--info), var(--info-soft))";
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      
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
            {locale === "ko" ? "← 회사 개요" : "← Firm overview"}
          </button>
          <div style={{ height: 12, width: 1, background: "var(--paper-edge)" }} />
          <div style={{ fontSize: 13, color: "var(--muted-deep)" }}>
            {agent?.kind === "team" ? (locale === "ko" ? "팀 에이전트" : "Team agent") : (locale === "ko" ? "개별 전문가 에이전트" : "Individual specialist agent")}
          </div>
        </div>
        
        {/* 에이전트 마스터 헤더 */}
        <header style={{ padding: "20px 24px", background: "var(--paper)", borderBottom: "var(--hairline)", display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "var(--radius-md)",
              background: getGradient(agent?.tone),
              color: "var(--white)",
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
              {agent ? (
                <AgentNameEditor agent={agent} locale={locale} onSave={onSaveAlias} />
              ) : (
                <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{detailDisplayName}</h1>
              )}
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "var(--fill-1)", color: "var(--accent)", fontWeight: 700 }}>
                {node.role}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)" }}>
              {agent?.tagline || (locale === "ko" ? `${detailDisplayName}의 규칙 지식베이스 및 계약 런타임` : `${detailDisplayName}'s rule knowledge base and contract runtime`)}
            </p>
          </div>
        </header>

        {/* 탭 네비게이션 */}
        <nav data-testid="agent-detail-tabs" style={{ display: "flex", gap: 4, padding: "8px 24px", background: "var(--paper)", borderBottom: "var(--hairline)", overflowX: "auto", flexShrink: 0 }}>
          {(["identity", "memory", "playbook", "activity", "ontology"] as const).map((tab) => {
            const active = activeTab === tab;
            const labels = {
              identity: locale === "ko" ? "정체성 & 페르소나" : "Identity & Persona",
              memory: locale === "ko" ? "큐레이팅된 메모리" : "Curated Memory",
              playbook: locale === "ko" ? "플레이북 & 워크플로우" : "Playbook & Workflow",
              activity: locale === "ko" ? "활동과 개선" : "Activity & Improvements",
              ontology: locale === "ko" ? "경험" : "Experience",
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
                  transition: "all 0.15s ease",
                  whiteSpace: "nowrap",
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

              <div data-testid="governed-agent-identity" style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h3 style={{ margin: "0 0 7px", fontSize: 14 }}>{locale === "ko" ? "거버넌스된 에이전트 정체성" : "Governed agent identity"}</h3>
                <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>
                  {locale === "ko"
                    ? "내부 지시 원문은 이 화면에 노출하지 않습니다. 학습으로 바뀌는 내용은 ‘활동과 개선’에서 비교하고, 직접 승인한 뒤에만 적용됩니다. 적용 후에도 되돌릴 수 있습니다."
                    : "Raw internal instructions are not shown here. Learning-driven changes are compared under Activity & Improvements and applied only after explicit approval. Applied changes can still be reverted."}
                </p>
              </div>

              {/* 매핑 메타 데이터 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>{locale === "ko" ? "런타임 정보" : "Runtime info"}</h4>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "var(--ink-soft)" }}>
                    <div><strong>{locale === "ko" ? "에이전트 ID:" : "Agent ID:"}</strong> {node.agentId ?? (locale === "ko" ? "미설치(임시)" : "Not installed (temporary)")}</div>
                    <div><strong>{locale === "ko" ? "권장 엔진:" : "Preferred engine:"}</strong> {agent?.preferredBackend ?? (locale === "ko" ? "자동 라우팅" : "Auto-routing")}</div>
                    <div><strong>{locale === "ko" ? "신뢰 등급:" : "Trust grade:"}</strong> Trust {agent?.trustGrade ?? "B"}</div>
                    {agent && (() => {
                      const own = classifyAgent(agent, locale);
                      return (
                        <div className="agent-ownership-row" data-owned={own.owned ? "true" : "false"}>
                          <strong>{locale === "ko" ? "소유:" : "Ownership:"}</strong>{" "}
                          <span className="agent-ownership-badge" data-owned={own.owned ? "true" : "false"}>
                            {own.owned ? `${own.label} · owned` : (locale === "ko" ? "빌린 게스트 · borrowed" : "Borrowed guest · borrowed")}
                          </span>
                          <div className="agent-ownership-path">{own.origin}</div>
                          {own.localPath && own.origin !== own.localPath && (
                            <div className="agent-ownership-path">{own.localPath}</div>
                          )}
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
                      (locale === "ko" ? "연동된 외부 MCP 서버 도구가 없습니다." : "No external MCP server tools connected.")
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 탭 2: 큐레이팅된 메모리 */}
          {activeTab === "memory" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 840 }}>
              
              {/* 온톨로지 인박스 알림 영역 */}
              {ontologyInbox.length > 0 && (
                <div style={{ border: "1px solid var(--accent-soft)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
                  <div style={{ background: "var(--fill-1)", padding: "10px 16px", display: "flex", alignItems: "center", justifyItems: "space-between", borderBottom: "1px solid var(--accent-soft)" }}>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>
                      <IconBrain size={14} />
                      {locale === "ko" ? "경험 인박스 (학습된 정보 추천)" : "Experience inbox (learned suggestions)"}
                    </div>
                    <span style={{ fontSize: 10, background: "var(--accent)", color: "var(--white)", padding: "1px 6px", borderRadius: 999 }}>{ontologyInbox.length}</span>
                  </div>
                  <div style={{ background: "var(--paper)", display: "flex", flexDirection: "column" }}>
                    {ontologyInbox.map((item) => (
                      <div key={item.id} style={{ padding: "12px 16px", display: "flex", alignItems: "flex-start", justifyItems: "space-between", gap: 12, borderBottom: "1px solid var(--paper-edge)" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: item.source === "cloud" ? "var(--accent)" : "var(--fill-2)", color: item.source === "cloud" ? "var(--white)" : "var(--accent)" }}>
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
                            color: "var(--white)",
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
                                  title={item.synced ? (locale === "ko" ? "허브 동기화됨" : "Synced to hub") : (locale === "ko" ? "로컬 전용 규칙" : "Local-only rule")}
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


              {/* 사용자에게 이해하기 쉬운 학습 기록. 원본 기술 로그는 각 항목 안에서만 펼친다. */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <div style={{ marginBottom: 14 }}>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 750, display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
                    <IconRoute size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "에이전트가 배운 내용" : "What this agent learned"}
                  </h4>
                  <p style={{ margin: "4px 0 0 20px", fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.45 }}>
                    {locale === "ko" ? "다음 작업에 활용할 기억과 개선 내용을 확인하세요." : "Review memories and improvements that can help with future work."}
                  </p>
                </div>
                <AgentLearningHistory events={displayTimelineEvents} locale={locale} />
              </div>

            </div>
          )}

          {/* 탭 3: 플레이북 & 워크플로우 */}
          {activeTab === "playbook" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 840 }}>
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 12px", fontSize: 13.5 }}>{locale === "ko" ? "실제 학습·파일·영수증" : "Actual learning, files & receipts"}</h4>
                <AgentLearningMetricGrid
                  summary={learningSummary}
                  loading={learningSummaryLoading}
                  error={learningSummaryError}
                  locale={locale}
                  context="playbook"
                />
                {agentFiles.length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 7, marginTop: 12 }}>
                    {agentFiles.slice(0, 10).map((file) => (
                      <div key={file.path} style={{ minWidth: 0, padding: "8px 9px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5, fontWeight: 700 }}>{file.name}</div>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--muted-deep)", fontSize: 10 }}>{file.path}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              {/* 수평 파이프라인 단계 표시기 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, overflowX: "auto" }}>
                <h4 style={{ margin: "0 0 16px 0", fontSize: 13.5, fontWeight: 700 }}>{locale === "ko" ? "생성 프로세스 매핑 (Pipeline Stepper)" : "Production Pipeline Stepper"}</h4>
                
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", minWidth: 600 }}>
                  
                  {/* 중앙 선 */}
                  <div style={{ position: "absolute", left: 0, right: 0, top: 12, height: 2, background: "var(--paper-edge)", zIndex: 1 }} />
                  
                  {/* 각 단계 스텝 */}
                  {Array.from({ length: 11 }).map((_, stepIdx) => {
                    const stepName = [
                      "Brief", "Script", "Shotlist", "Continuity", "Keyframe", 
                      "Approval", "Generation", "QA", "Edit", "Audio", "Delivery"
                    ][stepIdx];
                    
                    // DP 에이전트 역할에 따른 하이라이트 (단계 2, 3)
                    const isDP = node.role.includes("DP") || node.role.includes("Planner");
                    const isCeo = node.role.includes("CEO") || node.role.includes("Showrunner");
                    const highlight = isDP ? (stepIdx === 2 || stepIdx === 3) : isCeo ? (stepIdx === 0 || stepIdx === 5 || stepIdx === 10) : false;
                    
                    return (
                      <div key={stepIdx} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, zIndex: 2 }}>
                        <div
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 999,
                            background: highlight ? "var(--accent)" : "var(--paper)",
                            border: highlight ? "2px solid var(--accent)" : "2px solid var(--muted)",
                            color: highlight ? "var(--white)" : "var(--muted-deep)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 10,
                            fontWeight: 700
                          }}
                        >
                          {String(stepIdx).padStart(2, "0")}
                        </div>
                        <span style={{ fontSize: 9.5, marginTop: 4, fontWeight: highlight ? 700 : 500, color: highlight ? "var(--accent)" : "var(--muted-deep)" }}>
                          {stepName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 영화적 연출 문법 및 대화형 시각화 */}
              <div>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700 }}>{locale === "ko" ? "연출 및 문법 룰셋 (Playbook Spec)" : "Direction & Grammar Ruleset (Playbook Spec)"}</h4>
                
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
                  
                  {/* Left: 규칙 설명 카드 */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 13, fontWeight: 700 }}>
                        <IconRoute size={14} style={{ color: "var(--accent)" }} />
                        {locale === "ko" ? "카메라 지오메트리 룰" : "Camera geometry rules"}
                      </div>
                      <p style={{ margin: 0, fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.6 }}>
                        {locale === "ko" ? (
                          <>
                            - **180° 법칙 준수**: Eyeline 매치 및 스크린 디렉션 축 고정.<br />
                            - **30° 법칙 준수**: 인접 샷 연결 시 카메라 각도 30도 이상 이동.<br />
                            - **매치 온 액션**: 프레임 연속 동작 연결을 위한 컷 아웃포인트 정밀 배치.
                          </>
                        ) : (
                          <>
                            - **Follow the 180° rule**: Maintain eyeline match and a fixed screen-direction axis.<br />
                            - **Follow the 30° rule**: Move the camera angle by at least 30° between adjacent shots.<br />
                            - **Match on action**: Precisely place cut points to connect continuous motion across frames.
                          </>
                        )}
                      </p>
                    </div>
                    
                    <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 13, fontWeight: 700 }}>
                        <IconLayers size={14} style={{ color: "var(--accent)" }} />
                        {locale === "ko" ? "비디오 컷 아웃 핸들" : "Video cut-out handles"}
                      </div>
                      <p style={{ margin: 0, fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.6 }}>
                        {locale === "ko" ? (
                          <>
                            - **모션 버퍼**: 안전한 컷 크로싱용 0.3초간의 후반 정적 핸들 확보.<br />
                            - **TTS 자막 매핑**: 립싱크 대사 처리 시 SRT 번인 오프셋 자동 큐잉.<br />
                            - **샷 일관성**: 극 클로즈업 상태에서의 인스턴트 가파른 줌인 억제.
                          </>
                        ) : (
                          <>
                            - **Motion buffer**: Reserve a 0.3s static handle at the tail for safe cut crossings.<br />
                            - **TTS subtitle mapping**: Auto-queue SRT burn-in offsets when handling lip-sync dialogue.<br />
                            - **Shot consistency**: Suppress instant, abrupt zoom-ins during extreme close-ups.
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Right: 대화형 카메라 연출 시각화 */}
                  <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                      <IconWand size={14} style={{ color: "var(--accent)" }} />
                      {locale === "ko" ? "카메라 무브먼트 궤적 뷰어 (Interactive)" : "Camera Movement Path Viewer (Interactive)"}
                    </div>

                    {/* 무브먼트 전환 칩 */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {(["orbit", "crane", "dolly-zoom", "pan-tilt"] as const).map((tech) => {
                        const active = selectedTechnique === tech;
                        const labels = {
                          orbit: locale === "ko" ? "Orbit (공전)" : "Orbit",
                          crane: locale === "ko" ? "Crane (상승/하강)" : "Crane (rise/fall)",
                          "dolly-zoom": "Dolly Zoom",
                          "pan-tilt": locale === "ko" ? "Pan/Tilt (패닝)" : "Pan/Tilt"
                        };
                        return (
                          <button
                            key={tech}
                            onClick={() => setSelectedTechnique(tech)}
                            style={{
                              fontSize: 10.5,
                              padding: "4px 8px",
                              borderRadius: 6,
                              background: active ? "var(--accent)" : "var(--paper-2)",
                              color: active ? "var(--white)" : "var(--ink-soft)",
                              border: active ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
                              cursor: "pointer"
                            }}
                          >
                            {labels[tech]}
                          </button>
                        );
                      })}
                    </div>

                    {/* SVG/CSS 애니메이션 뷰포트 */}
                    <div style={{
                      flex: 1,
                      minHeight: 160,
                      background: "var(--paper-2)",
                      borderRadius: 8,
                      border: "1px solid var(--paper-edge)",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden"
                    }}>
                      <style>{`
                        @keyframes orbitMotion {
                          from { transform: rotate(0deg); }
                          to { transform: rotate(360deg); }
                        }
                        @keyframes craneMotion {
                          0% { transform: translateY(15px) rotate(-8deg); }
                          50% { transform: translateY(-15px) rotate(10deg); }
                          100% { transform: translateY(15px) rotate(-8deg); }
                        }
                        @keyframes dollyZoomBg {
                          0% { transform: scale(1); opacity: 0.2; }
                          50% { transform: scale(1.6); opacity: 0.7; }
                          100% { transform: scale(1); opacity: 0.2; }
                        }
                        @keyframes panTiltMotion {
                          0% { transform: rotate(-25deg); }
                          50% { transform: rotate(25deg); }
                          100% { transform: rotate(-25deg); }
                        }
                      `}</style>

                      {selectedTechnique === "orbit" && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 80, height: 80, borderRadius: "50%", border: "1.5px dashed var(--accent-soft)", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {/* 피사체 */}
                            <div style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--amber-deep)" }} />
                            {/* 공전하는 카메라 */}
                            <div style={{
                              position: "absolute",
                              width: "100%",
                              height: "100%",
                              animation: "orbitMotion 4s linear infinite",
                              display: "flex",
                              alignItems: "center",
                              left: 0,
                              top: 0
                            }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", marginLeft: -4 }} />
                            </div>
                          </div>
                          <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>{locale === "ko" ? "대상을 중심으로 원형 공전하는 카메라 궤적" : "Circular camera path orbiting around the subject"}</span>
                        </div>
                      )}

                      {selectedTechnique === "crane" && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 120, height: 80, position: "relative" }}>
                            {/* 바닥 지표 */}
                            <div style={{ width: "100%", height: 1.5, background: "var(--paper-edge)", position: "absolute", bottom: 10 }} />
                            {/* 지브 크레인 암 */}
                            <div style={{
                              position: "absolute",
                              left: 45,
                              top: 10,
                              animation: "craneMotion 4s ease-in-out infinite",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center"
                            }}>
                              <div style={{ width: 30, height: 15, background: "var(--accent)", borderRadius: 3, position: "relative" }}>
                                <div style={{ width: 6, height: 10, background: "var(--accent)", position: "absolute", left: -4, top: 2 }} />
                                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--white)", position: "absolute", right: 4, top: 4 }} />
                              </div>
                              <div style={{ width: 2, height: 35, background: "var(--accent-soft)" }} />
                            </div>
                          </div>
                          <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>{locale === "ko" ? "수직 상승/하강 및 틸트 다운 연출" : "Vertical rise/fall with tilt-down framing"}</span>
                        </div>
                      )}

                      {selectedTechnique === "dolly-zoom" && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: "100%" }}>
                          <div style={{ width: "100%", height: 80, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {/* 원근 변화 격자배경 */}
                            <div style={{
                              width: 140,
                              height: 70,
                              position: "absolute",
                              border: "1.5px solid var(--paper-edge)",
                              animation: "dollyZoomBg 3s ease-in-out infinite",
                              background: "radial-gradient(circle, transparent 20%, var(--paper-edge) 80%)",
                              borderRadius: 4
                            }} />
                            {/* 크기 고정 피사체 */}
                            <div style={{ width: 24, height: 24, borderRadius: 4, background: "linear-gradient(135deg, var(--accent), var(--blue))", zIndex: 2, boxShadow: "var(--glass-shadow-lift)" }} />
                          </div>
                          <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>{locale === "ko" ? "피사체는 고정되고 배경의 심도 및 왜곡만 급변" : "Subject stays fixed while background depth and distortion shift sharply"}</span>
                        </div>
                      )}

                      {selectedTechnique === "pan-tilt" && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 100, height: 80, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {/* 카메라 Pan 시야각 */}
                            <div style={{
                              width: 60,
                              height: 60,
                              animation: "panTiltMotion 3.5s ease-in-out infinite",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center"
                            }}>
                              <svg style={{ width: 50, height: 50, overflow: "visible" }}>
                                <path d="M 25,25 L 5,5 A 20,20 0 0,1 45,5 Z" fill="rgba(90, 86, 220, 0.12)" stroke="var(--accent-soft)" strokeWidth="1" />
                                <rect x="18" y="20" width="14" height="10" rx="1.5" fill="var(--accent)" />
                              </svg>
                            </div>
                          </div>
                          <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>{locale === "ko" ? "카메라 삼각대 축 기준 좌우 수평 회전(Pan)" : "Horizontal left-right rotation around the tripod axis (Pan)"}</span>
                        </div>
                      )}

                    </div>
                  </div>

                </div>
              </div>


            </div>
          )}

          {/* 탭 4: 활동과 개선 */}
          {activeTab === "activity" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 840 }}>
              
              <AgentLearningMetricGrid
                summary={learningSummary}
                loading={learningSummaryLoading}
                error={learningSummaryError}
                locale={locale}
                context="activity"
              />

              {/* 자체 진화 프롬프트 디프 제안 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <div style={{ display: "flex", justifyItems: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconWand size={14} style={{ color: "var(--accent)" }} />
                    {locale === "ko" ? "에이전트 개선안" : "Agent improvements"}
                  </h4>
                  <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(245,201,122,0.16)", color: "var(--amber-deep)", fontWeight: 700 }}>
                    {pendingProposal
                      ? (locale === "ko" ? "승인 대기" : "Awaiting approval")
                      : recoveryProposal
                        ? (locale === "ko" ? "확인 필요" : "Needs review")
                      : displayedProposal?.status === "applied" || displayedProposal?.status === "measured"
                        ? (locale === "ko" ? "적용됨 · 되돌릴 수 있음" : "Applied · can be reverted")
                        : displayedProposal?.status === "rolled_back"
                          ? (locale === "ko" ? "되돌림 완료" : "Reverted")
                          : hasPendingEvolution ? (locale === "ko" ? "새 개선안 있음" : "Improvement available") : (locale === "ko" ? "변경 없음" : "No changes")}
                  </span>
                </div>

                {!hasPendingEvolution && !displayedProposal && (
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "12px 4px", lineHeight: 1.6 }}>
                    {locale === "ko"
                      ? "현재 기억한 내용이 모두 에이전트에 반영되어 있습니다. 새 기준이나 주의할 점을 배우면 여기에 개선안이 나타납니다."
                      : "Everything currently remembered is already reflected in the agent. New decisions or cautions will appear here as improvements."}
                  </div>
                )}

                {(hasPendingEvolution || displayedProposal) && (
                <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                  {/* 기존 버젼 */}
                  <div style={{ background: "rgba(255,138,138,0.04)" }}>
                    <div style={{ background: "rgba(255,138,138,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--red-deep)" }}>
                      {locale === "ko" ? "현재 설정" : "Current settings"}
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {displayedEvolutionDiff.old}
                    </pre>
                  </div>
                  {/* 제안 버젼 */}
                  <div style={{ background: "rgba(168,217,155,0.04)", borderLeft: "1px solid var(--paper-edge)" }}>
                    <div style={{ background: "rgba(168,217,155,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--green-deep)" }}>
                      {locale === "ko" ? "바뀔 설정" : "Proposed settings"}
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {displayedEvolutionDiff.new}
                    </pre>
                  </div>
                </div>

                {!pendingProposal && hasPendingEvolution && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                    <button
                      onClick={() => void onCreateEvolution(evolutionDiff.new, { changeOrigin: "curated_memory_rules" })}
                      disabled={saving}
                      style={{
                        padding: "8px 14px",
                        background: "var(--accent)",
                        color: "var(--white)",
                        border: "none",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: saving ? "default" : "pointer",
                        opacity: saving ? 0.6 : 1,
                      }}
                    >
                      {locale === "ko" ? "개선안 만들기" : "Create improvement"}
                    </button>
                  </div>
                )}

                {pendingProposal && (
                  <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                    <div style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.55, marginBottom: 10 }}>
                      {locale === "ko"
                        ? `${pendingProposal.targetPath} · before ${pendingProposal.beforeHash.slice(0, 12)} · after ${pendingProposal.afterHash.slice(0, 12)} · 승인 전 원본 유지`
                        : `${pendingProposal.targetPath} · before ${pendingProposal.beforeHash.slice(0, 12)} · after ${pendingProposal.afterHash.slice(0, 12)} · original retained until approval`}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <button type="button" disabled={saving} onClick={() => void onRejectEvolution(pendingProposal.id)} style={{ padding: "8px 12px", border: "1px solid var(--paper-edge)", borderRadius: 6, background: "var(--paper)", color: "var(--ink-soft)", fontSize: 12, fontWeight: 650 }}>
                        {locale === "ko" ? "개선안 삭제" : "Discard improvement"}
                      </button>
                      <button type="button" disabled={saving} onClick={() => void onApproveEvolution(pendingProposal.id)} style={{ padding: "8px 14px", background: "var(--accent)", color: "var(--white)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 650 }}>
                        {locale === "ko" ? "확인하고 적용" : "Review and apply"}
                      </button>
                    </div>
                  </div>
                )}

                {recoveryProposal?.lastError && (
                  <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--red-deep)", borderRadius: 8, background: "rgba(255,138,138,0.06)", color: "var(--red-deep)", fontSize: 11.5, lineHeight: 1.55 }}>
                    {locale === "ko"
                      ? `자동 덮어쓰기를 중단하고 현재 파일을 보존했습니다. Identity 탭 원문과 hash를 직접 비교하세요. ${recoveryProposal.lastError}`
                      : `Automatic overwrite stopped and the current file was preserved. Compare the Identity source and hashes manually. ${recoveryProposal.lastError}`}
                  </div>
                )}

                {displayedProposal && displayedProposal.receipts.length > 0 && (
                  <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)" }}>
                    {displayedProposal.receipts.map((receipt) => (
                      <div key={receipt.id} style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
                        {receipt.action.toUpperCase()} · asset v{receipt.versionBefore}→v{receipt.versionAfter} · governed {receipt.governedAssetHashBefore.slice(0, 12)}→{receipt.governedAssetHashAfter.slice(0, 12)} · {receipt.id}
                      </div>
                    ))}
                    {(displayedProposal.status === "applied" || displayedProposal.status === "measured") && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                        <button type="button" disabled={saving} onClick={() => void onRollbackEvolution(displayedProposal.id)} style={{ padding: "7px 12px", border: "1px solid var(--red-deep)", borderRadius: 6, background: "var(--paper)", color: "var(--red-deep)", fontSize: 11.5, fontWeight: 650 }}>
                          {locale === "ko" ? "이 영수증으로 롤백" : "Rollback from this receipt"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                </>
                )}
              </div>

            </div>
          )}

          {activeTab === "ontology" && (
            <div style={{ maxWidth: 1180, display: "flex", flexDirection: "column", gap: 14 }}>
              <ExperienceProfileCard
                agent={agent}
                summary={ontologySummary}
                hub={null}
                locale={locale}
              />
              <AgentOntologyGraphView
                summary={ontologySummary}
                graphSnapshot={ontologyGraph}
                hub={null}
                agentName={agent ? agentDisplayName(agent, locale) : (locale === "ko" ? "에이전트" : "Agent")}
                locale={locale}
                graphLoading={ontologyGraphLoading}
                graphError={ontologyGraphError}
              />
              <ExperienceOntologySummaryView
                summary={ontologySummary}
                loading={ontologySummaryLoading}
                error={ontologySummaryError}
                locale={locale}
              />
            </div>
          )}

        </div>
      </div>

    </div>
  );
}
