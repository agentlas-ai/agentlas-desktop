// 회사 상세 — 접고 펴기 가능한 왼쪽 사이드바 조직도 + 오른쪽 에이전트 상세 통제 센터 (메모리 큐레이션, 프롬프트 에디터, 스킬 주입, 클라우드 싱크)
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { ipc } from "@/lib/ipc";
import { isVisibleAgent, isUserFacingAgentText, visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "@/lib/agent-memory";
import { classifyAgent } from "@/lib/ownership";
import { MARGIN_LINE_KO } from "@/lib/receipts";
import type {
  AgentRuntimeOverride,
  AgentRuntimeOverrideScope,
  Chat,
  InstalledAgent,
  InstalledFirm,
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
  IconRoute
} from "@/components/Icon";

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
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [resolvedOrgs, setResolvedOrgs] = useState<Record<string, ResolvedOrg>>({});
  const [runtimeStatuses, setRuntimeStatuses] = useState<RuntimeStatus[]>([]);
  const [runtimeOverrides, setRuntimeOverrides] = useState<AgentRuntimeOverride[]>([]);

  // 왼쪽 조직도 패널 너비 & 접기 상태 (localStorage 영속)
  const [orgWidth, setOrgWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 선택된 에이전트 노드 (null 이면 회사 오버뷰 노출)
  const [selectedNode, setSelectedNode] = useState<ResolvedNode | null>(null);
  const [activeTab, setActiveTab] = useState<"identity" | "memory" | "playbook" | "activity">("identity");
  const targetAgentId = searchParams.get("agentId") ?? "";
  const targetNodeId = searchParams.get("nodeId") ?? "";
  const targetFirmId = searchParams.get("firmId") ?? "";

  // 파일 핸들링 및 상태
  const [agentFiles, setAgentFiles] = useState<WorkspaceNode[]>([]);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryParsed, setMemoryParsed] = useState<{
    decisions: { id: string; title: string; content: string; synced?: boolean; enabled?: boolean }[];
    gotchas: { id: string; title: string; content: string; synced?: boolean; enabled?: boolean }[];
    openQuestions: { id: string; title: string; content: string }[];
  }>({ decisions: [], gotchas: [], openQuestions: [] });

  const [promptContent, setPromptContent] = useState("");
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
    const [fList, agList, runtimes, overrides] = await Promise.all([
      api.firms.list(),
      api.team.list(),
      api.runtime.detect().catch(() => []),
      api.agentRuntime?.list ? api.agentRuntime.list().catch(() => []) : Promise.resolve([]),
    ]);
    setFirms(fList);
    setAgents(visibleAgents(agList));
    setRuntimeStatuses(runtimes);
    setRuntimeOverrides(overrides);

    const orgs: Record<string, ResolvedOrg> = {};
    for (const f of fList) {
      const o = await api.firms.getResolvedOrg(f.id);
      if (o) orgs[f.id] = o;
    }
    setResolvedOrgs(orgs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      setAgentFiles([]);
      setMemoryContent("");
      setMemoryParsed({ decisions: [], gotchas: [], openQuestions: [] });
      setPromptContent("");
      setPromptDraft("");
      setEditingPrompt(false);
      return;
    }

    let cancelled = false;
    async function loadAgentAssets() {
      if (!selectedNode?.agentId || !api) return;
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
          setMemoryContent(m.content);
          setMemoryParsed(parseMemoryMarkdown(m.content));
        }

        // AGENT.md 또는 system-prompt.md 로드
        const promptFile = fileEntries.find(
          (e) => e.name.toLowerCase() === "agent.md" || e.name.toLowerCase() === "system-prompt.md"
        );
        if (promptFile) {
          const p = await api.agentFiles.read(selectedNode.agentId, promptFile.path);
          if (cancelled) return;
          setPromptContent(p.content);
          setPromptDraft(p.content);
        } else {
          // Fallback to agent metadata
          const curAgent = agents.find((a) => a.id === selectedNode.agentId);
          if (curAgent) {
            setPromptContent(curAgent.systemPrompt);
            setPromptDraft(curAgent.systemPrompt);
          }
        }
      } catch (e) {
        console.error("에이전트 파일 로드 실패:", e);
      }
    }

    void loadAgentAssets();
    return () => {
      cancelled = true;
    };
  }, [selectedNode, agents]);


  // 프롬프트 수정 반영
  async function savePrompt() {
    const api = ipc();
    if (!api || !selectedNode || !selectedNode.agentId) return;
    setSavingFiles(true);
    try {
      const promptFile = agentFiles.find(
        (e) => e.name.toLowerCase() === "agent.md" || e.name.toLowerCase() === "system-prompt.md"
      );
      const path = promptFile ? promptFile.path : "AGENT.md";
      await api.agentFiles.write(selectedNode.agentId, path, promptDraft);
      setPromptContent(promptDraft);
      setEditingPrompt(false);
      showToast("시스템 프롬프트가 성공적으로 반영되었습니다.");
    } catch (e) {
      showToast("프롬프트 저장 실패: " + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  // 자가 진화용 저장 기능
  async function saveEvolution(newPromptContent: string) {
    const api = ipc();
    if (!api || !selectedNode || !selectedNode.agentId) return;
    setSavingFiles(true);
    try {
      const promptFile = agentFiles.find(
        (e) => e.name.toLowerCase() === "agent.md" || e.name.toLowerCase() === "system-prompt.md"
      );
      const path = promptFile ? promptFile.path : "AGENT.md";
      await api.agentFiles.write(selectedNode.agentId, path, newPromptContent);
      setPromptContent(newPromptContent);
      setPromptDraft(newPromptContent);
      showToast("자가 진화 제안이 성공적으로 프롬프트에 병합되었습니다.");
    } catch (e) {
      showToast("진화 적용 실패: " + String(e));
    } finally {
      setSavingFiles(false);
    }
  }

  // 메모리 저장 직렬화 큐 + 최신-상태 ref — 빠른 연속 변이가 stale 클로저로 서로를 덮어쓰지 않게 한다.
  const memorySaveChain = useRef<Promise<void>>(Promise.resolve());
  const memoryParsedRef = useRef(memoryParsed);
  useEffect(() => {
    memoryParsedRef.current = memoryParsed;
  }, [memoryParsed]);

  // 메모리 데이터 저장 핸들러. updater 는 "최신" 상태를 받아 다음 상태를 만든다(stale prop 미사용).
  // 다음 상태를 ref(최신 누적본) 기준으로 동기 계산해 낙관적 반영하고, 디스크 쓰기는 큐로
  // 직렬화해 순서/원자성을 보장한다(lost update 방지).
  function saveMemory(updater: (prev: typeof memoryParsed) => typeof memoryParsed) {
    const next = updater(memoryParsedRef.current);
    memoryParsedRef.current = next; // 다음 동기 호출이 이 결과 위에 쌓이도록 즉시 갱신.
    setMemoryParsed(next);
    const run = memorySaveChain.current.then(async () => {
      const api = ipc();
      if (!api || !selectedNode || !selectedNode.agentId) return;
      setSavingFiles(true);
      try {
        const serialized = serializeMemoryMarkdown(next.decisions, next.gotchas, next.openQuestions);
        const memFile = agentFiles.find((e) => e.name.toLowerCase() === "memory.md");
        const path = memFile ? memFile.path : "memory.md";
        await api.agentFiles.write(selectedNode.agentId, path, serialized);
        setMemoryContent(serialized);
      } catch (e) {
        showToast("메모리 갱신 실패: " + String(e));
      } finally {
        setSavingFiles(false);
      }
    });
    memorySaveChain.current = run.catch(() => {});
    return run;
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
      const imported = await api.team.importLocalFolder(dir);
      await refresh();
      const loc = pickLocalized(imported, locale);
      setSelectedNode({
        id: imported.id,
        name: loc.name,
        role: loc.tagline || imported.slug,
        agentId: imported.id,
      });
      setActiveTab("identity");
      showToast(`${loc.name} 가져오기 완료`);
    } catch (err) {
      showToast("에이전트 가져오기 실패: " + String(err));
    } finally {
      setImportBusy(false);
    }
  }

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const selectedContext = useMemo(
    () => (selectedNode ? findSelectedNodeContext(selectedNode, firms, resolvedOrgs) : null),
    [selectedNode, firms, resolvedOrgs],
  );

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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%" }}>
              <div
                onClick={() => setSelectedNode(null)}
                style={{ flex: 1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
              >
                <IconLayers size={14} style={{ color: "var(--accent)" }} />
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  My Agents
                </div>
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void importAgentFolder();
                }}
                disabled={importBusy}
                className="titlebar-nodrag"
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
                {importBusy ? "가져오는 중" : "가져오기"}
              </button>
            </div>
          )}
        </header>

        {/* 조직도 목록 */}
        <div style={{ flex: 1, overflowY: "auto", padding: sidebarCollapsed ? "12px 6px" : 12 }}>
          {/* Multi-Firm & Independent Agents Org Tree */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {firms.map(firm => {
              const rOrg = resolvedOrgs[firm.id];
              const fLoc = pickLocalized(firm, locale);
              const isCollapsed = firmCollapsed[firm.id];
              return (
                <div key={firm.id}>
                  {!sidebarCollapsed && (
                    <div
                      onClick={() => setFirmCollapsed(prev => ({ ...prev, [firm.id]: !isCollapsed }))}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", borderRadius: "var(--radius-sm)", background: "var(--paper-2)", marginBottom: 8 }}
                    >
                      <IconChevronDown size={14} style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.2s" }} />
                      <IconBuilding size={14} style={{ color: "var(--accent)" }} />
                      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)" }}>{fLoc.name}</span>
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

            {/* Independent Agents */}
            <div style={{ marginTop: 8 }}>
              {!sidebarCollapsed && agents.filter(a => !firms.some(f => f.orgChart.some(n => n.agentId === a.id))).length > 0 && (
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-deep)", textTransform: "uppercase", padding: "0 12px", marginBottom: 8 }}>
                  {t("library.agents.subtitle") || "Independent Agents"}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: sidebarCollapsed ? 0 : 12, alignItems: sidebarCollapsed ? "center" : "stretch" }}>
                {agents.filter(a => !firms.some(f => f.orgChart.some(n => n.agentId === a.id))).map(a => {
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
          </div>
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
                <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  My Agents Library
                </h1>
              </div>
              <button
                onClick={() => void importAgentFolder()}
                disabled={importBusy}
                className="titlebar-nodrag"
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
                  cursor: importBusy ? "default" : "pointer",
                  opacity: importBusy ? 0.72 : 1,
                }}
              >
                <IconFileUp size={14} />
                {importBusy ? "가져오는 중..." : "에이전트 가져오기"}
              </button>
            </header>

            <section style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}>
              <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.6 }}>로컬 환경에 설치된 모든 에이전트와 조직(Team) 목록입니다. 좌측 조직도에서 개별 에이전트를 클릭하여 세부 통제 센터를 열어보세요.</p>
              
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
            onSaveMemory={saveMemory}
            promptContent={promptContent}
            promptDraft={promptDraft}
            onPromptDraftChange={setPromptDraft}
            editingPrompt={editingPrompt}
            onSetEditingPrompt={setEditingPrompt}
            onSavePrompt={savePrompt}
            onSaveEvolution={saveEvolution}
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
          />
        )}
      </main>
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

function isVisibleResolvedNode(node: ResolvedNode, agentMap: Map<string, InstalledAgent>): boolean {
  if (!isUserFacingAgentText(node.name, node.role)) return false;
  if (!node.agentId) return true;
  const agent = agentMap.get(node.agentId);
  return Boolean(agent && isVisibleAgent(agent));
}

function isVisibleFirmOrgNode(
  node: InstalledFirm["orgChart"][number],
  agentMap: Map<string, InstalledAgent>,
): boolean {
  if (!isUserFacingAgentText(node.agentSlug, node.role)) return false;
  const agent = agentMap.get(node.agentId);
  return Boolean(agent && isVisibleAgent(agent));
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
  if (!ceo) return <div style={{ fontSize: 12, color: "var(--muted)" }}>조직도가 비어있습니다.</div>;

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

  if (isVisibleFirmOrgNode(ceo, agentMap)) return renderNode(ceo, 0);
  const visibleRoots = children(ceo.agentSlug);
  if (visibleRoots.length === 0) return <div style={{ fontSize: 12, color: "var(--muted)" }}>표시할 에이전트가 없습니다.</div>;
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
        <span>정보 흐름 연결 맵 (Information Flow Mapper)</span>
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

function selectionSummary(selection?: RuntimeSelection | null): string {
  if (!selection) return "전역 활성 런타임";
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
  const targets = useMemo<RuntimeTargetOption[]>(() => {
    const items: RuntimeTargetOption[] = [];
    if (node.agentId) {
      items.push({
        scope: "agent",
        targetId: node.agentId,
        label: `${node.name}만`,
        note: "선택한 개별 에이전트에만 적용",
      });
    }
    if (nodeContext?.firm && nodeContext.division) {
      items.push({
        scope: "division",
        targetId: divisionTargetId(nodeContext.firm.id, nodeContext.division.id),
        label: `${nodeContext.division.name} 디비전`,
        note: "해당 디비전과 하위 전문가 기본값",
      });
    }
    if (nodeContext?.firm) {
      items.push({
        scope: "firm",
        targetId: nodeContext.firm.id,
        label: `${nodeContext.firm.name} 전체`,
        note: "조직 전체 기본값",
      });
    }
    return items;
  }, [node.agentId, node.name, nodeContext]);

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
      showToast("런타임 모델 지정이 저장되었습니다.");
    } catch (err) {
      showToast("런타임 지정 저장 실패: " + String(err));
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
      showToast("런타임 모델 지정을 해제했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (targets.length === 0) {
    return (
      <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>실행 모델 지정</h4>
        <p style={{ margin: 0, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>설치된 에이전트 노드를 선택하면 CLI 모델을 고정할 수 있습니다.</p>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>실행 모델 지정</h4>
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--muted-deep)" }}>
            저장된 값은 다음 Chat, Team 라우팅, Hub 후보 호출부터 우선 적용됩니다.
          </p>
        </div>
        <span style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, background: selectedOverride ? "rgba(12,166,120,0.12)" : "var(--fill-2)", color: selectedOverride ? "var(--green-deep)" : "var(--muted-deep)", fontWeight: 700 }}>
          {selectedOverride ? "고정됨" : "전역 기본"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
          적용 범위
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
          모델
          <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} style={runtimeSelectStyle}>
            <option value="">구독/전역 기본</option>
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}{model.tag ? ` · ${model.tag}` : ""}
              </option>
            ))}
          </select>
        </label>
        {effortOptions.length > 0 && (
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
            작업량
            <select value={selectedEffort} onChange={(e) => setSelectedEffort(e.target.value)} style={runtimeSelectStyle}>
              <option value="">기본</option>
              {effortOptions.map((effort) => (
                <option key={effort.id} value={effort.id}>{effort.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--paper-2)", border: "1px solid var(--paper-edge)", fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
        <strong style={{ color: "var(--ink)" }}>현재 저장값:</strong> {selectionSummary(selectedOverride?.selection)}
        {selectedTarget && <span style={{ color: "var(--muted-deep)" }}> · {selectedTarget.note}</span>}
      </div>

      {/* 가치5(독립): 키는 내 OS 키체인에, 모델 호출은 내 구독으로 — Agentlas 마진 ₩0. */}
      <div className="runtime-independence-note">
        키는 내 OS 키체인에 저장되고 Agentlas 서버를 거치지 않습니다 · 모델 호출은 내 구독/키로 — {MARGIN_LINE_KO}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button onClick={clearOverride} disabled={saving || !selectedOverride} style={{ ...runtimeButtonStyle, opacity: selectedOverride ? 1 : 0.45 }}>
          전역 기본
        </button>
        <button onClick={saveOverride} disabled={saving || !selectedRuntime} style={{ ...runtimeButtonStyle, background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)" }}>
          {saving ? "저장 중..." : "저장"}
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
  onSaveMemory: (updater: (prev: any) => any) => Promise<void>;
  promptContent: string;
  promptDraft: string;
  onPromptDraftChange: (v: string) => void;
  editingPrompt: boolean;
  onSetEditingPrompt: (v: boolean) => void;
  onSavePrompt: () => Promise<void>;
  onSaveEvolution: (newPrompt: string) => Promise<void>;
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
}

function AgentDetailView({
  node,
  agent,
  activeTab,
  onTabChange,
  onBackToOverview,
  memoryParsed,
  onSaveMemory,
  promptContent,
  promptDraft,
  onPromptDraftChange,
  editingPrompt,
  onSetEditingPrompt,
  onSavePrompt,
  onSaveEvolution,
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
  onRuntimeOverridesChange
}: AgentDetailViewProps) {
  
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
  const [evolutionApproved, setEvolutionApproved] = useState(false);
  const learnedRules = [...memoryParsed.decisions, ...memoryParsed.gotchas].filter(
    (r) => r.enabled !== false && r.title && !promptContent.includes(r.title),
  );
  const evolutionAppendix = learnedRules.length
    ? "\n\n## Learned rules (folded from memory)\n" +
      learnedRules.map((r) => `- **${r.title}** — ${r.content}`).join("\n")
    : "";
  const hasPendingEvolution = learnedRules.length > 0;
  const evolutionDiff = { old: promptContent, new: promptContent + evolutionAppendix };
  const observedTimelineEvents = useMemo(() => {
    const derived: Array<{ id: string; timestamp: string; title: string; desc: string; type: "skill" | "sync" | "evolution" | "resolve" }> = [];
    if (agentFiles.length > 0) {
      derived.push({
        id: "observed-files",
        timestamp: "loaded",
        title: "로컬 에이전트 파일 연결",
        desc: `${agentFiles.length}개 파일을 읽어 프롬프트, 메모리, 플레이북 탭에 반영했습니다.`,
        type: "sync",
      });
    }
    if (promptContent.trim()) {
      derived.push({
        id: "observed-prompt",
        timestamp: "loaded",
        title: "프롬프트 소스 확인",
        desc: "AGENT.md 또는 system-prompt.md 기준으로 현재 런타임 정체성을 표시 중입니다.",
        type: "sync",
      });
    }
    const memoryCount = memoryParsed.decisions.length + memoryParsed.gotchas.length + memoryParsed.openQuestions.length;
    if (memoryCount > 0) {
      derived.push({
        id: "observed-memory",
        timestamp: "loaded",
        title: "메모리 규칙 로드",
        desc: `${memoryCount}개 메모리 항목을 규칙, 주의사항, 미결 과제로 분류했습니다.`,
        type: "sync",
      });
    }
    return [...timelineEvents, ...derived];
  }, [agentFiles.length, memoryParsed.decisions.length, memoryParsed.gotchas.length, memoryParsed.openQuestions.length, promptContent, timelineEvents]);

  // 프롬프트 복사 핸들러
  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(promptContent);
    showToast("시스템 프롬프트가 클립보드에 복사되었습니다.");
  };

  // 프롬프트 기본값 재설정 핸들러
  const handleResetPrompt = async () => {
    if (!confirm("시스템 프롬프트를 에이전트 기본 룰셋 정의서 프로필로 재설정하시겠습니까?")) return;
    const defaultVal = agent?.systemPrompt ?? "# Default Prompt\nNo default instruction available.";
    onPromptDraftChange(defaultVal);
    
    const api = ipc();
    if (api && node && node.agentId) {
      try {
        const promptFile = agentFiles.find(
          (e) => e.name.toLowerCase() === "agent.md" || e.name.toLowerCase() === "system-prompt.md"
        );
        const path = promptFile ? promptFile.path : "AGENT.md";
        await api.agentFiles.write(node.agentId, path, defaultVal);
        await onSaveEvolution(defaultVal);
        
        setTimelineEvents(prev => [
          {
            id: `timeline-${Date.now()}`,
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            title: "시스템 프롬프트 초기화",
            desc: "프롬프트를 로컬 런타임 내의 에이전트 팩토리 기본 프로필로 강제 재설정했습니다.",
            type: "evolution"
          },
          ...prev
        ]);
        
        showToast("프롬프트가 초기 사양으로 재설정되었습니다.");
      } catch (e) {
        showToast("재설정 반영 실패: " + String(e));
      }
    }
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
          title: targetItem.enabled === false ? "규칙 활성화" : "규칙 비활성화",
          desc: `'${targetItem.title}' 규칙의 런타임 적용 여부를 전환했습니다.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(`규칙 설정이 저장되었습니다.`);
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
          title: nextSynced ? "클라우드 허브 공유" : "로컬 전용 전환",
          desc: `'${targetItem.title}' 규칙의 Hub 공유 후보 상태를 전환했습니다.`,
          type: "sync"
        },
        ...prev
      ]);
    }
    showToast(nextSynced ? "Hub 공유 후보로 표시했습니다." : "로컬 프로젝트 전용으로 변경되었습니다.");
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
        decisions: [...prev.decisions, { id: t.id, title: t.title, content: t.content + " (미결 항목 승격 반영)", synced: globalHubSync, enabled: true }],
        openQuestions: prev.openQuestions.filter(item => item.id !== id),
      };
    });

    setTimelineEvents(prev => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: "의사결정 공식 반영",
        desc: `미결 과제였던 '${target.title}'건을 검토 후 공식 Decisions 룰로 승격 처리했습니다.`,
        type: "resolve"
      },
      ...prev
    ]);
    
    showToast("미결 과제가 결정 사항(Decision)으로 승격 저장되었습니다.");
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
        title: target.source === "cloud" ? "허브 공유 지식 풀(Pull)" : "로컬 자동 학습 병합",
        desc: `'${target.title}' 온톨로지 추천 피드백을 에이전트 지식베이스에 승인 및 결합 완료했습니다.`,
        type: "resolve"
      },
      ...prev
    ]);
    
    showToast(`학습 제안 '${target.title}'이 메모리에 병합 반영되었습니다.`);
  };

  // 스킬 주입 — 에이전트 폴더에 실제 스킬 파일(.agentlas/skills/<slug>/SKILL.md)을 쓰고,
  // 메모리·타임라인에도 기록한다. (writeAgentFile 이 중첩 디렉터리를 생성)
  const handleInjectSkill = async (skill: { slug?: string; name: string; description: string }) => {
    const api = ipc();
    const slug = (skill.slug ?? skill.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    let fileWritten = false;
    if (api && node?.agentId) {
      const skillMd = `# ${skill.name}\n\n${skill.description}\n\n## When to use\nInjected into this agent from the skill catalog. Apply this skill's guidance when the task matches its scope.\n`;
      try {
        await api.agentFiles.write(node.agentId, `.agentlas/skills/${slug}/SKILL.md`, skillMd);
        fileWritten = true;
      } catch (e) {
        showToast(`스킬 파일 작성 실패: ${String(e)}`);
      }
    }

    const newDecision = {
      id: `skill-${slug}`,
      title: `${skill.name} 스킬 주입`,
      content: `${skill.description} — .agentlas/skills/${slug}/SKILL.md 로 주입됨.`,
      synced: globalHubSync,
      enabled: true,
    };
    void onSaveMemory((prev: typeof memoryParsed) => ({
      ...prev,
      decisions: [...prev.decisions, newDecision],
    }));
    onSetSkillDrawerOpen(false);

    setTimelineEvents((prev) => [
      {
        id: `timeline-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: "수동 스킬 주입 (Skill Injection)",
        desc: fileWritten
          ? `'${skill.name}' 스킬을 .agentlas/skills/${slug}/SKILL.md 로 에이전트 폴더에 작성했습니다.`
          : `'${skill.name}' 스킬을 메모리에 기록했습니다(파일 작성은 건너뜀).`,
        type: "skill",
      },
      ...prev,
    ]);

    showToast(fileWritten ? `${skill.name} 스킬이 에이전트 폴더에 주입되었습니다.` : `${skill.name} 스킬을 메모리에 기록했습니다.`);
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
            ← 회사 개요
          </button>
          <div style={{ height: 12, width: 1, background: "var(--paper-edge)" }} />
          <div style={{ fontSize: 13, color: "var(--muted-deep)" }}>
            {agent?.kind === "team" ? "팀 에이전트" : "개별 전문가 에이전트"}
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
              title="이 일꾼과 새 작업을 시작합니다"
            >
              ▶ 일 시키기
            </button>
          )}
        </div>

        {/* 정보 흐름 연결 맵 (Information Flow Mapper) */}
        <InformationFlowMapper node={node} />

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
              {agent?.tagline || `${node.name}의 규칙 지식베이스 및 계약 런타임`}
            </p>
          </div>
        </header>

        {/* 탭 네비게이션 */}
        <nav style={{ display: "flex", gap: 4, padding: "8px 24px", background: "var(--paper)", borderBottom: "var(--hairline)" }}>
          {(["identity", "memory", "playbook", "activity"] as const).map((tab) => {
            const active = activeTab === tab;
            const labels = {
              identity: "정체성 & 페르소나",
              memory: "큐레이팅된 메모리",
              playbook: "플레이북 & 워크플로우",
              activity: "활동 및 자체 진화"
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
                <h3 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700 }}>시스템 프롬프트 (System Prompt)</h3>
                
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
                        취소
                      </button>
                      <button
                        onClick={() => void onSavePrompt()}
                        disabled={saving}
                        style={{ padding: "6px 12px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                      >
                        {saving ? "저장 중..." : "반영하기"}
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
                                지시사항 (Directives)
                              </h4>
                              {promptSections.directives.length === 0 ? (
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>감지된 지시사항이 없습니다.</span>
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
                                제약조건 (Constraints)
                              </h4>
                              {promptSections.constraints.length === 0 ? (
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>감지된 제약사항이 없습니다.</span>
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
                                입출력 형태 (Formats)
                              </h4>
                              {promptSections.formats.length === 0 ? (
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>감지된 규격정보가 없습니다.</span>
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
                              시스템 프롬프트 전체 원문(Source) 보기
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
                              {promptContent || "로드된 프롬프트 내용이 없습니다."}
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
                                프롬프트 복사
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
                                기본값 재설정
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
                                프롬프트 편집
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
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>런타임 정보</h4>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "var(--ink-soft)" }}>
                    <div><strong>에이전트 ID:</strong> {node.agentId ?? "미설치(임시)"}</div>
                    <div><strong>적용 런타임:</strong> {effectiveRuntimeOverride ? selectionSummary(effectiveRuntimeOverride.selection) : "전역 자동 라우팅"}</div>
                    <div><strong>신뢰 등급:</strong> Trust {agent?.trustGrade ?? "B"}</div>
                    {agent && (() => {
                      const own = classifyAgent(agent);
                      return (
                        <div className="agent-ownership-row" data-owned={own.owned ? "true" : "false"}>
                          <strong>소유:</strong>{" "}
                          <span className="agent-ownership-badge" data-owned={own.owned ? "true" : "false"}>
                            {own.owned ? "내 직원 · owned" : "빌린 게스트 · borrowed"}
                          </span>
                          <div className="agent-ownership-path">{own.localPath ?? own.origin}</div>
                          <div className="agent-ownership-note">
                            {own.owned
                              ? own.localPath
                                ? "내 디스크의 실제 폴더 — 게시자가 사라져도 안 죽는다."
                                : "내 라이브러리에 설치됨 — 내 자산이다."
                              : "원격 게스트 — 게시자가 내리면 사용 불가. Fork 하면 내 것이 된다."}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 700 }}>외부 도구연동</h4>
                  <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    {agent?.mcpServers && agent.mcpServers.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        {agent.mcpServers.map((s) => (
                          <span key={s} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--fill-1)", color: "var(--accent)" }}>{s}</span>
                        ))}
                      </div>
                    ) : (
                      "연동된 외부 MCP 서버 도구가 없습니다."
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
                  이 일꾼이 기억하는 것: 결정 <strong>{memoryParsed.decisions.length}</strong>
                  {" · "}주의 <strong>{memoryParsed.gotchas.length}</strong>
                  {" · "}미결 <strong>{memoryParsed.openQuestions.length}</strong>
                  {(() => {
                    const synced = [...memoryParsed.decisions, ...memoryParsed.gotchas].filter((r) => r.synced).length;
                    return synced > 0 ? <> · 허브 공유 <strong>{synced}</strong></> : null;
                  })()}
                </div>
                <div className="memory-summary-note">
                  기억은 내 디스크의 markdown 파일로 저장됩니다 — 켜고 끈 상태도 파일에 함께 남아 새로고침해도 유지됩니다.
                </div>
              </div>

              {/* 온톨로지 인박스 알림 영역 */}
              {ontologyInbox.length > 0 && (
                <div style={{ border: "1px solid var(--accent-soft)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
                  <div style={{ background: "var(--fill-1)", padding: "10px 16px", display: "flex", alignItems: "center", justifyItems: "space-between", borderBottom: "1px solid var(--accent-soft)" }}>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>
                      <IconBrain size={14} />
                      온톨로지 인박스 (학습된 정보 추천)
                    </div>
                    <span style={{ fontSize: 10, background: "var(--accent)", color: "#fff", padding: "1px 6px", borderRadius: 999 }}>{ontologyInbox.length}</span>
                  </div>
                  <div style={{ background: "var(--paper)", display: "flex", flexDirection: "column" }}>
                    {ontologyInbox.map((item) => (
                      <div key={item.id} style={{ padding: "12px 16px", display: "flex", alignItems: "flex-start", justifyItems: "space-between", gap: 12, borderBottom: "1px solid var(--paper-edge)" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: item.source === "cloud" ? "var(--accent)" : "var(--fill-2)", color: item.source === "cloud" ? "#fff" : "var(--accent)" }}>
                              {item.source === "cloud" ? "허브 추천" : "로컬 학습"}
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
                          반영 승인
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Hub 공유 상태 제어 헤더 */}
              <div style={{ display: "flex", alignItems: "center", justifyItems: "space-between", padding: "12px 16px", background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)" }}>
                <div style={{ flex: 1 }}>
                  <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>Hub 공유 상태 설정</h4>
                  <p style={{ margin: 0, fontSize: 11, color: "var(--muted-deep)" }}>규칙 생성 시 공유 후보 플래그를 함께 저장합니다. 실제 원격 업로드는 Hub/Cloud publish 단계에서 처리됩니다.</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: globalHubSync ? "var(--green-deep)" : "var(--muted)" }}>
                    {globalHubSync ? "Hub 공유 후보" : "로컬 단독"}
                  </span>
                  <input
                    type="checkbox"
                    checked={globalHubSync}
                    onChange={(e) => setGlobalHubSync(e.target.checked)}
                    style={{ width: 34, height: 18, cursor: "pointer" }}
                  />
                </div>
              </div>

              {/* 메모리 리스트 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                
                {/* Decisions 리스트 */}
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconCheck size={14} style={{ color: "var(--green-deep)" }} />
                    결정 사항 (Decisions)
                  </h3>
                  {memoryParsed.decisions.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      기록된 결정 사항이 없습니다.
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
                                  title={item.synced ? "허브 동기화됨" : "로컬 전용 규칙"}
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
                    주의 사항 (Gotchas)
                  </h3>
                  {memoryParsed.gotchas.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      기록된 주의 사항이 없습니다.
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
                    미결 과제 (Open Questions)
                  </h3>
                  {memoryParsed.openQuestions.length === 0 ? (
                    <div style={{ padding: 16, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted)" }}>
                      기록된 미결 과제가 없습니다.
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
                            결정 승격
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

              {/* 스킬 주입 활성화 버튼 */}
              <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 8 }}>
                <button
                  onClick={() => onSetSkillDrawerOpen(true)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "10px 16px",
                    background: "var(--paper)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    boxShadow: "var(--shadow-1)"
                  }}
                >
                  <IconPlus size={12} />
                  수동 스킬 주입 (Manual Skill Evolution)
                </button>
              </div>

              {/* 메모리 진화 히스토리 타임라인 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 16px 0", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
                  <IconRoute size={14} style={{ color: "var(--accent)" }} />
                  메모리 진화 히스토리 (Evolution Timeline)
                </h4>
                
                <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "relative", paddingLeft: 16, borderLeft: "2px solid var(--paper-edge)", marginLeft: 6 }}>
                  {observedTimelineEvents.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                      아직 기록된 진화 이벤트가 없습니다. 메모리 승격, 스킬 주입, 프롬프트 진화를 실행하면 여기에 남습니다.
                    </div>
                  )}
                  {observedTimelineEvents.map((evt) => {
                    const colorMap = {
                      skill: "var(--purple-deep)",
                      sync: "var(--accent)",
                      evolution: "var(--amber-deep)",
                      resolve: "var(--green-deep)"
                    };
                    
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
                        
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
                            {evt.timestamp}
                          </span>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: colorMap[evt.type] }}>
                            {evt.title}
                          </span>
                        </div>
                        <p style={{ margin: 0, fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.4 }}>
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
                <h4 style={{ margin: "0 0 14px 0", fontSize: 13.5, fontWeight: 700 }}>실행 루프 (Runtime Loop)</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                  {[
                    { label: "Route", desc: "Chat 또는 Hub 호출에서 이 에이전트가 후보가 됩니다.", icon: IconRoute },
                    { label: "Context", desc: "프로젝트, Env, 메모리 규칙이 invocation에 주입됩니다.", icon: IconBrain },
                    { label: "Tools", desc: "필요한 MCP 서버와 로컬 권한을 확인합니다.", icon: IconLayers },
                    { label: "Persist", desc: "결정, 주의사항, 진화 로그를 로컬 파일에 남깁니다.", icon: IconPaperclip },
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
                    라우팅 카드
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55 }}>
                    <div><strong>역할:</strong> {node.role || "자동 라우팅"}</div>
                    <div><strong>Agent ID:</strong> {node.agentId ?? "미설치 노드"}</div>
                    <div><strong>적용 런타임:</strong> {effectiveRuntimeOverride ? selectionSummary(effectiveRuntimeOverride.selection) : "런타임 자동 선택"}</div>
                    <div><strong>신뢰 등급:</strong> Trust {agent?.trustGrade ?? "B"}</div>
                    {agent && (
                      <div>
                        <strong>소유:</strong>{" "}
                        <span className="agent-ownership-badge" data-owned={classifyAgent(agent).owned ? "true" : "false"}>
                          {classifyAgent(agent).owned ? "내 직원 · owned" : "빌린 게스트 · borrowed"}
                        </span>
                      </div>
                    )}
                    <div><strong>호출 경로:</strong> Chat 멘션, Team 라우팅, Hub 후보 검색</div>
                  </div>
                </div>

                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                  <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconLayers size={14} style={{ color: "var(--accent)" }} />
                    도구와 파일
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
                      연결된 MCP 서버가 없습니다. Hub Plugin에서 필요한 도구를 설치하면 이 에이전트의 도구 레이어와 함께 확인할 수 있습니다.
                    </p>
                  )}
                </div>
              </div>

              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 13.5, fontWeight: 700 }}>로컬 플레이북 소스</h4>
                {agentFiles.length === 0 ? (
                  <div style={{ padding: 14, border: "1px dashed var(--paper-edge)", borderRadius: 10, color: "var(--muted-deep)", fontSize: 12 }}>
                    아직 읽힌 로컬 파일이 없습니다. 설치된 에이전트를 선택하면 AGENT.md, memory.md, skill 파일을 여기에서 확인합니다.
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
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>활성 규칙 (Active rules)</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--green-deep)" }}>
                    {[...memoryParsed.decisions, ...memoryParsed.gotchas].filter((r) => r.enabled !== false).length}
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>메모리 항목 (Memory items)</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--accent)" }}>
                    {memoryParsed.decisions.length + memoryParsed.gotchas.length + memoryParsed.openQuestions.length}
                  </div>
                </div>
                <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 4 }}>진화·활동 이력 (Events)</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "var(--peach-ink)" }}>{observedTimelineEvents.length}</div>
                </div>
              </div>

              {/* 자체 진화 프롬프트 디프 제안 */}
              <div style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 16 }}>
                <div style={{ display: "flex", justifyItems: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                    <IconWand size={14} style={{ color: "var(--accent)" }} />
                    자가 프롬프트 진화 제안 (Agent Evolution Proposal)
                  </h4>
                  <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(245,201,122,0.16)", color: "var(--amber-deep)", fontWeight: 700 }}>
                    {evolutionApproved ? "적용 완료" : hasPendingEvolution ? "업그레이드 대기" : "최신 상태"}
                  </span>
                </div>

                {!hasPendingEvolution && !evolutionApproved && (
                  <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "12px 4px", lineHeight: 1.6 }}>
                    메모리의 활성 규칙이 모두 시스템 프롬프트에 반영되어 있습니다. 메모리 탭에서 새 결정·주의 규칙이
                    학습되면 여기에 프롬프트 진화 제안이 나타납니다.
                  </div>
                )}

                {(hasPendingEvolution || evolutionApproved) && (
                <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                  {/* 기존 버젼 */}
                  <div style={{ background: "rgba(255,138,138,0.04)" }}>
                    <div style={{ background: "rgba(255,138,138,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--red-deep)" }}>
                      기존 버전 (Current)
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {evolutionDiff.old}
                    </pre>
                  </div>
                  {/* 제안 버젼 */}
                  <div style={{ background: "rgba(168,217,155,0.04)", borderLeft: "1px solid var(--paper-edge)" }}>
                    <div style={{ background: "rgba(168,217,155,0.08)", padding: "6px 12px", borderBottom: "1px solid var(--paper-edge)", fontSize: 11.5, fontWeight: 600, color: "var(--green-deep)" }}>
                      개선 제안 (Evolved Draft)
                    </div>
                    <pre style={{ margin: 0, padding: 12, fontSize: 10.5, fontFamily: "var(--font-mono)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                      {evolutionDiff.new}
                    </pre>
                  </div>
                </div>

                {!evolutionApproved && hasPendingEvolution && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                    <button
                      onClick={async () => {
                        await onSaveEvolution(evolutionDiff.new);
                        setEvolutionApproved(true);
                        setTimelineEvents(prev => [
                          {
                            id: `timeline-${Date.now()}`,
                            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                            title: "자가 프롬프트 진화 승인",
                            desc: "AI 개선 제안 드래프트를 에이전트 마스터 정의서(AGENT.md)에 정식 적용 및 저장했습니다.",
                            type: "evolution"
                          },
                          ...prev
                        ]);
                      }}
                      style={{
                        padding: "8px 14px",
                        background: "var(--accent)",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer"
                      }}
                    >
                      진화 제안 승인 및 적용
                    </button>
                  </div>
                )}
                </>
                )}
              </div>

            </div>
          )}

        </div>
      </div>

      {/* 4. 우측 스킬 인젝션 서랍 (Skill Drawer) */}
      {skillDrawerOpen && (
        <aside
          className="glass-thin"
          style={{
            width: 280,
            flexShrink: 0,
            borderLeft: "1px solid var(--glass-border)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <header style={{ padding: "14px 16px", borderBottom: "1px solid var(--glass-border)", display: "flex", justifyItems: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", flex: 1 }}>사용 가능한 스킬 카탈로그</span>
            <button onClick={() => onSetSkillDrawerOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted-deep)" }}>
              <IconClose size={16} />
            </button>
          </header>
          <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {availableSkills.map((sk) => (
              <div
                key={sk.slug}
                onClick={() => handleInjectSkill(sk)}
                style={{
                  background: "var(--paper)",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-sm)",
                  padding: 10,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", marginBottom: 2 }}>{sk.name}</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{sk.description}</div>
              </div>
            ))}
          </div>
        </aside>
      )}

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
