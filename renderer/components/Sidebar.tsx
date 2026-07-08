// 좌측 사이드바 — Claude Desktop / Codex / Antigravity 스타일.
// 섹션: 새 채팅 / 최근 채팅 / 프로젝트 / 자동화 / 라이브러리. Footer = 런타임 상태 + 설정.
"use client";
import { Suspense, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { navigate } from "@/lib/navigation";
import type {
  Chat,
  AgentGroupResolved,
  Automation,
  InstalledAgent,
  Project,
  RuntimeStatus,
} from "@/lib/types";
import {
  IconChat,
  IconChevronRight,
  IconBolt,
  IconFolder,
  IconHome,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconSun,
  IconTrash,
} from "./Icon";
import { PromptPickerDialog } from "./PromptPickerDialog";
import { PawLogo } from "./PawLogo";
import { ChatRow } from "./ChatRow";
import { AccountChip } from "./AccountChip";
import { VersionChip } from "./VersionChip";
import { pickLocalized, useT } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";

const COLLAPSE_KEY = "agentlas.sidebar.collapsed";
const CHATS_SECTION_COLLAPSE_KEY = "agentlas.sidebar.section.chats.collapsed";
const AUTOMATIONS_SECTION_COLLAPSE_KEY = "agentlas.sidebar.section.automations.collapsed";
const WIDTH_KEY = "agentlas.sidebar.width";
const COLLAPSED_WIDTH = 60;
const EXPANDED_WIDTH = 248;
const SIDEBAR_MIN_WIDTH = 204;
const SIDEBAR_MAX_WIDTH = 380;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
interface SidebarData {
  chats: Chat[];
  projects: Project[];
  automations: Automation[];
  agents: InstalledAgent[];
  agentGroups: AgentGroupResolved[];
  runtime: RuntimeStatus | null;
}

const EMPTY: SidebarData = {
  chats: [],
  projects: [],
  automations: [],
  agents: [],
  agentGroups: [],
  runtime: null,
};

export function Sidebar({ refreshKey = 0 }: { refreshKey?: number }) {
  // useSearchParams는 Suspense boundary가 필요 — 정적 익스포트 모드에서 client-render 강제됨
  return (
    <Suspense fallback={<SidebarSkeleton />}>
      <SidebarInner refreshKey={refreshKey} />
    </Suspense>
  );
}

function SidebarSkeleton() {
  return (
    <aside
      className="glass-thin"
      style={{
        width: EXPANDED_WIDTH,
        flexShrink: 0,
        borderRight: "1px solid var(--glass-border)",
        borderTop: "none",
        borderBottom: "none",
        borderLeft: "none",
        height: "100vh",
      }}
    />
  );
}

function SidebarInner({ refreshKey: refreshKeyProp = 0 }: { refreshKey?: number }) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const { t, locale } = useT();
  // 모든 detail 라우트가 ?id= 패턴을 쓰므로 한 변수 재사용 가능 (pathname으로 구분)
  const currentChatId = searchParams.get("id");
  const currentProjectId = searchParams.get("id");
  const currentFirmId = searchParams.get("id");
  const currentAutomationId = searchParams.get("id");
  const [data, setData] = useState<SidebarData>(EMPTY);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(EXPANDED_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [automationsCollapsed, setAutomationsCollapsed] = useState(false);
  const [chatListLimit, setChatListLimit] = useState(12);
  const [newChatDialogOpen, setNewChatDialogOpen] = useState(false);
  // 프롬프트 저장소에서 북마크/소장 프롬프트를 골라 새 채팅을 시작하는 팝업.
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshKey = refreshKeyProp + refreshTick;
  const triggerRefresh = () => setRefreshTick((n) => n + 1);
  // 실행 중인 chatId 집합 — 백그라운드 멀티세션 "실행 중" 인디케이터. main이 방송.
  const [runningChats, setRunningChats] = useState<Set<string>>(new Set());

  // 실행 중 chatId를 시드 + 구독 — 다른 채팅이 백그라운드로 돌고 있으면 펄스 점 표시.
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events) return;
    let cancelled = false;
    void api.invoke.activeChats().then((ids) => {
      if (!cancelled) setRunningChats(new Set(ids));
    });
    const off = events.onActiveChats((ids) => setRunningChats(new Set(ids)));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    try {
      setChatsCollapsed(window.localStorage.getItem(CHATS_SECTION_COLLAPSE_KEY) === "1");
      setAutomationsCollapsed(window.localStorage.getItem(AUTOMATIONS_SECTION_COLLAPSE_KEY) === "1");
    } catch {
      // ignore
    }
    function onRemoved(e: Event) {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      setData((prev) => ({ ...prev, chats: prev.chats.filter((chat) => chat.id !== id) }));
    }
    function onChanged() {
      triggerRefresh();
    }
    window.addEventListener("agentlas:chat-removed", onRemoved);
    window.addEventListener("agentlas:chat-changed", onChanged);
    window.addEventListener("agentlas:automation-changed", onChanged);
    return () => {
      window.removeEventListener("agentlas:chat-removed", onRemoved);
      window.removeEventListener("agentlas:chat-changed", onChanged);
      window.removeEventListener("agentlas:automation-changed", onChanged);
    };
  }, []);

  function toggleChatsCollapsed() {
    setChatsCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(CHATS_SECTION_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  function toggleAutomationsCollapsed() {
    setAutomationsCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(AUTOMATIONS_SECTION_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  // 사용자 선호 영구화 — localStorage. SSR 안전.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSE_KEY);
      if (stored === "1") setCollapsed(true);
      const storedWidth = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) {
        setSidebarWidth(clampSidebarWidth(storedWidth));
      }
    } catch {
      // sandbox/private mode — 그냥 기본값 사용
    }
    // 메뉴/단축키에서 외부 토글 시 storage 이벤트로 동기화
    function onStorage(e: StorageEvent) {
      if (e.key !== COLLAPSE_KEY) return;
      setCollapsed(e.newValue === "1");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  function persistSidebarWidth(width: number) {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // ignore
    }
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      persistSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  // ⌘[ 또는 Ctrl+[ 단축키로 토글
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        toggleCollapsed();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void Promise.all([
      api.chats.listRecent(20),
      api.projects.list(),
      api.automations.list(),
      api.team.list(),
      api.agentGroups.listResolved(),
      api.runtime.detect(),
    ]).then(([chats, projects, automations, agents, agentGroups, runtimes]) => {
      if (cancelled) return;
      const active = runtimes.find((r) => r.active) ?? runtimes[0] ?? null;
      setData({ chats, projects, automations, agents, agentGroups, runtime: active });
    }).catch(() => {
      if (!cancelled) setData((prev) => ({ ...prev, projects: [], automations: [] }));
    }).finally(() => {
      if (!cancelled) setProjectsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // currentChatId 포함: soft navigation(같은 /chat 라우트, ?id만 변경)으로 새 채팅을
    // 만들 때도 최근 목록이 갱신되도록. (hard navigation은 full reload라 자동 갱신됐음)
  }, [refreshKey, pathname, currentChatId]);

  // 팀(멀티에이전트)도 좌측 목록에 노출한다 — 팀 채팅 진입점이 사이드바뿐인 사용자가
  // "에이전트가 아무것도 안 보인다"고 겪은 실사고(0.7.21). 시스템/background만 숨긴다.
  const displayAgents = visibleAgents(data.agents, { includeTeams: true });
  // ChatRow마다 O(n) find 대신 id→agent Map으로 O(1) 조회(채팅 많을수록 효과).
  const agentById = useMemo(() => new Map(displayAgents.map((a) => [a.id, a])), [displayAgents]);

  function defaultAgentIdFor(project?: Project | null): string | undefined {
    return (
      project?.defaultAgentId ??
      data.agents.find((a) => a.slug === "agentlas-orchestrator")?.id ??
      data.chats[0]?.agentId ??
      data.agents[0]?.id
    );
  }

  async function createNewChat(project?: Project | null) {
    const api = ipc();
    if (!api) return;
    try {
      const agentId = defaultAgentIdFor(project);
      const chat = await api.chats.create({
        ...(agentId ? { agentId } : {}),
        ...(project ? { projectId: project.id } : {}),
      });
      if (project?.folderPath) await api.workspace.set(chat.id, project.folderPath);
      navigate(`/chat?id=${chat.id}`);
      // soft navigation은 full reload가 없으므로 명시적으로 최근 목록을 갱신한다.
      triggerRefresh();
    } catch {
      // 정말 호출 가능한 에이전트가 하나도 없을 때만 — 그래도 채팅 화면으로(허브 아님).
      navigate("/chat");
    }
  }

  function handleNewChat() {
    if (!projectsLoaded || data.projects.length > 0) {
      setNewChatDialogOpen(true);
      return;
    }
    void createNewChat(null);
  }

  async function openAutomationChat(automation: Automation) {
    const api = ipc();
    if (!api) return;
    const chat = await api.automations.getSession(automation.id);
    window.dispatchEvent(new CustomEvent("agentlas:chat-changed", { detail: { id: chat.id } }));
    navigate(`/chat?id=${chat.id}`);
  }

  async function deleteAutomation(automation: Automation) {
    const api = ipc();
    if (!api) return;
    const message =
      locale === "ko"
        ? `'${automation.name}' 자동화를 삭제할까요?\n\n자동화가 사라지며, 이 자동화가 사용하던 실행 채팅과 기록도 같이 삭제됩니다.`
        : `Delete '${automation.name}'?\n\nThis removes the automation and also deletes its linked run chat and messages.`;
    if (!window.confirm(message)) return;
    await api.automations.remove(automation.id);
    setData((prev) => ({
      ...prev,
      automations: prev.automations.filter((item) => item.id !== automation.id),
    }));
    window.dispatchEvent(new CustomEvent("agentlas:automation-changed", { detail: { id: automation.id } }));
    if (pathname.startsWith("/automation") && currentAutomationId === automation.id) navigate("/automation");
  }

  const newChatDialog = newChatDialogOpen ? (
    <NewChatScopeDialog
      projects={data.projects}
      projectsLoaded={projectsLoaded}
      locale={locale}
      onCancel={() => setNewChatDialogOpen(false)}
      onGlobal={() => {
        setNewChatDialogOpen(false);
        void createNewChat(null);
      }}
      onProject={(project) => {
        setNewChatDialogOpen(false);
        void createNewChat(project);
      }}
    />
  ) : null;

  // 프롬프트 불러오기 — 선택한 프롬프트 body로 새 채팅을 만들고 이동(내부에서 처리).
  const promptPickerDialog = promptPickerOpen ? (
    <PromptPickerDialog
      onClose={() => setPromptPickerOpen(false)}
      onStarted={() => {
        setPromptPickerOpen(false);
        // soft navigation은 full reload가 없으므로 최근 채팅 목록을 명시적으로 갱신.
        triggerRefresh();
      }}
    />
  ) : null;

  // ── 접힘 모드: 아이콘만 ───────────────────────────────
  if (collapsed) {
    return (
      <>
      <aside
        className="glass-thin"
        data-tour-id="workspace.sidebar"
        style={{
          width: COLLAPSED_WIDTH,
          flexShrink: 0,
          borderRight: "1px solid var(--glass-border)",
          borderTop: "none",
          borderBottom: "none",
          borderLeft: "none",
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
          transition: "width 0.18s ease",
        }}
      >
        <div
          className="titlebar-drag"
          style={{
            height: 44,
            flexShrink: 0,
            // macOS 신호등(close/min/max)이 좌상단 (12-72px, 12-22px) 자리잡음.
            // collapsed 60px라 신호등이 사이드바를 살짝 넘어가지만, drag 영역만 비워두면 동작 OK.
          }}
        />
        <div
          className="titlebar-nodrag"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            padding: "4px 0 8px",
          }}
        >
          {/* 1) 펴기 버튼 — 명시적 chevron, hover에 fill */}
          <button
            onClick={toggleCollapsed}
            aria-label={t("sidebar.expand")}
            title={`${t("sidebar.expand")} (⌘[)`}
            style={{
              ...iconBtnStyle(false),
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              color: "var(--ink-soft)",
              boxShadow: "var(--shadow-1)",
            }}
          >
            <IconChevronRight size={16} />
          </button>
          {/* 2) 로고 — 장식, 클릭 안 됨 */}
          <div
            aria-hidden
            style={{
              width: 36,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <PawLogo size={22} />
          </div>
          {/* 3) 새 채팅 */}
          <button
            onClick={() => void handleNewChat()}
            aria-label={t("sidebar.new_chat")}
            title={t("sidebar.new_chat")}
            style={{
              ...iconBtnStyle(false),
              background: "var(--paper)",
              color: "var(--ink)",
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
            }}
          >
            <IconPlus size={16} />
          </button>
        </div>
        <nav
          className="titlebar-nodrag"
          style={{
            flex: 1,
            overflowY: "auto",
            paddingTop: 12,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
        <CollapsedNav
            pathname={pathname}
          />
        </nav>
        <footer
          className="titlebar-nodrag"
          style={{
            padding: 8,
            borderTop: "var(--hairline)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
          }}
          title={data.runtime ? labelOfRuntime(data.runtime) : t("sidebar.backend_none")}
        >
          <RuntimeDot status={data.runtime} />
          <ThemeToggleButton collapsed />
          <Link
            href="/settings"
            aria-label={t("sidebar.settings")}
            title={t("sidebar.settings")}
            style={iconBtnStyle(pathname === "/settings")}
          >
            <IconSettings size={15} />
          </Link>
        </footer>
      </aside>
      {newChatDialog}
      {promptPickerDialog}
      </>
    );
  }

  // ── 펼침 모드: 풀 사이드바 ─────────────────────────────
  return (
    <>
    <aside
      className="glass-thin"
      data-tour-id="workspace.sidebar"
      style={{
        position: "relative",
        width: sidebarWidth,
        flexShrink: 0,
        borderRight: "1px solid var(--glass-border)",
        borderTop: "none",
        borderBottom: "none",
        borderLeft: "none",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        transition: resizing ? "none" : "width 0.18s ease",
      }}
    >
      <div
        className="titlebar-nodrag"
        role="separator"
        aria-orientation="vertical"
        title={locale === "en" ? "Resize sidebar" : "사이드바 너비 조절"}
        onPointerDown={beginSidebarResize}
        onDoubleClick={() => persistSidebarWidth(EXPANDED_WIDTH)}
        style={sidebarResizeHandleStyle}
      />
      <div
        className="titlebar-drag"
        style={{
          height: 44,
          flexShrink: 0,
          // hiddenInset titlebar 신호등 영역을 피한다. 워크스페이스에서는 SideNav가 없으므로
          // Sidebar 자체가 좌상단 macOS 컨트롤 여백을 책임진다.
          paddingLeft: 76,
          paddingRight: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <PawLogo size={20} style={{ flexShrink: 0 }} />
        <span
          style={{
            fontFamily: "var(--font-head)",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: 0,
            flex: 1,
          }}
        >
          Agentlas
        </span>
        <button
          onClick={toggleCollapsed}
          aria-label={t("sidebar.collapse")}
          title={`${t("sidebar.collapse")} (⌘[)`}
          className="titlebar-nodrag"
          style={{
            ...iconBtnStyle(false),
            width: 24,
            height: 24,
            color: "var(--muted-deep)",
          }}
        >
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>

      <div style={{ padding: "8px 10px 4px" }} className="titlebar-nodrag">
        <button
          onClick={() => void handleNewChat()}
          className="neu-btn-primary"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: "9px 12px",
            borderRadius: "var(--radius-md)",
            fontSize: 13,
          }}
        >
          <IconPlus size={15} />
          {t("sidebar.new_chat")}
        </button>
        {/* 프롬프트 저장소의 북마크·소장 프롬프트로 바로 새 채팅 시작 */}
        <button
          onClick={() => setPromptPickerOpen(true)}
          className="neu-btn"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: "8px 12px",
            marginTop: 6,
            borderRadius: "var(--radius-md)",
            fontSize: 12.5,
          }}
        >
          <IconSparkles size={14} />
          {t("sidebar.load_prompt")}
        </button>
      </div>

      <nav
        className="titlebar-nodrag"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 6px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >

        <SidebarLink href="/dashboard" active={pathname === "/dashboard"} prominent>
          <IconHome size={14} style={{ flexShrink: 0, color: "currentColor" }} />
          <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {locale === "en" ? "Dashboard" : "대시보드"}
          </span>
        </SidebarLink>

        <SidebarSection
          title={t("sidebar.chats")}
          icon={<IconChat size={12} />}
          collapsible
          collapsed={chatsCollapsed}
          onToggle={toggleChatsCollapsed}
          action={
            <Link
              href="/chat/archived"
              style={{
                color: "var(--muted-deep)",
                display: "inline-flex",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.6,
                textDecoration: "none",
              }}
              title={t("sidebar.archive")}
            >
              {t("sidebar.archive")}
            </Link>
          }
        >
          {data.chats.length === 0 ? (
            <EmptyHint>{t("sidebar.empty_chats")}</EmptyHint>
          ) : (
            <>
              {data.chats.slice(0, chatListLimit).map((c) => {
                const agent = c.agentId ? agentById.get(c.agentId) : undefined;
                const group = c.agentGroupId ? data.agentGroups.find((item) => item.id === c.agentGroupId) : null;
                const active = pathname === "/chat" && currentChatId === c.id;
                return (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    agent={agent}
                    targetLabel={group?.name ?? undefined}
                    active={active}
                    running={runningChats.has(c.id)}
                    onChanged={triggerRefresh}
                  />
                );
              })}
              {data.chats.length > 12 && (
                <button
                  type="button"
                  onClick={() => setChatListLimit((limit) => limit >= data.chats.length ? 12 : Math.min(data.chats.length, limit + 12))}
                  style={{
                    margin: "4px 8px 0",
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: "1px solid var(--paper-edge)",
                    background: "var(--paper)",
                    color: "var(--ink-soft)",
                    fontSize: 11.5,
                    fontWeight: 650,
                    cursor: "pointer",
                  }}
                >
                  {chatListLimit >= data.chats.length
                    ? locale === "en" ? "Show less" : "접기"
                    : locale === "en" ? `Show more (${data.chats.length - chatListLimit})` : `더 보기 (${data.chats.length - chatListLimit})`}
                </button>
              )}
            </>
          )}
        </SidebarSection>



        <SidebarSection
          title={t("sidebar.projects")}
          icon={<IconFolder size={12} />}
          action={
            <Link
              href="/project/new"
              style={{ color: "var(--muted-deep)", display: "inline-flex" }}
            >
              <IconPlus size={12} />
            </Link>
          }
        >
          {data.projects.length === 0 ? (
            <EmptyHint>
              <Link href="/project/new" style={{ color: "var(--accent)", fontWeight: 600 }}>
                + {t("sidebar.empty_projects")}
              </Link>
            </EmptyHint>
          ) : (
            data.projects.slice(0, 8).map((p) => {
              const active = pathname === "/project/detail" && currentProjectId === p.id;
              return (
                <SidebarLink key={p.id} href={`/project/detail?id=${p.id}`} active={active}>
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.name}
                  </span>
                </SidebarLink>
              );
            })
          )}
        </SidebarSection>

        <SidebarSection
          title={t("sidebar.automations")}
          icon={<IconBolt size={12} />}
          collapsible
          collapsed={automationsCollapsed}
          onToggle={toggleAutomationsCollapsed}
          action={
            <Link
              href="/automation/new"
              style={{ color: "var(--muted-deep)", display: "inline-flex" }}
              title={locale === "en" ? "New automation" : "새 자동화"}
            >
              <IconPlus size={12} />
            </Link>
          }
        >
          {data.automations.length === 0 ? (
            <EmptyHint>
              <Link href="/automation/new" style={{ color: "var(--accent)", fontWeight: 600 }}>
                + {locale === "en" ? "Create automation" : "자동화 만들기"}
              </Link>
            </EmptyHint>
          ) : (
            data.automations.slice(0, 8).map((automation) => {
              const active = pathname.startsWith("/automation") && currentAutomationId === automation.id;
              return (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  active={active}
                  locale={locale}
                  onOpen={() => void openAutomationChat(automation)}
                  onDelete={() => void deleteAutomation(automation)}
                />
              );
            })
          )}
        </SidebarSection>


      </nav>

      <div
        className="titlebar-nodrag"
        style={{
          padding: "8px 12px 0",
          flexShrink: 0,
        }}
      >
        <AccountChip />
      </div>

      <footer
        className="titlebar-nodrag"
        style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--glass-border)",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
          marginTop: 8,
        }}
      >
        <RuntimeDot status={data.runtime} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {data.runtime ? (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ink-soft)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {labelOfRuntime(data.runtime)}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  minWidth: 0,
                  flexWrap: "nowrap",
                  fontSize: 10,
                  color: "var(--muted-deep)",
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("sidebar.byoc_free")}
                </span>
                <span style={{ flex: "0 0 auto" }}>·</span>
                <VersionChip />
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: 11, color: "var(--red-deep)" }}>
                {t("sidebar.backend_none")}
              </div>
              <VersionChip />
            </div>
          )}
        </div>
        <ThemeToggleButton />
        <Link
          href="/settings"
          style={{
            display: "inline-flex",
            padding: 6,
            borderRadius: 8,
            color: "var(--muted-deep)",
            background: pathname === "/settings" ? "var(--fill-1)" : "transparent",
          }}
          aria-label={t("sidebar.settings")}
          title={t("sidebar.settings")}
        >
          <IconSettings size={16} />
        </Link>
      </footer>
    </aside>
    {newChatDialog}
    {promptPickerDialog}
    </>
  );
}

function SidebarSection({
  title,
  icon,
  children,
  action,
  collapsible,
  collapsed,
  onToggle,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section style={{ marginTop: 8 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--muted-deep)",
        }}
      >
        {collapsible ? (
          <button
            onClick={onToggle}
            aria-expanded={!collapsed}
            title={title}
            style={{
              minWidth: 0,
              flex: 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: 0,
              background: "transparent",
              border: "none",
              color: "inherit",
              font: "inherit",
              letterSpacing: "inherit",
              textTransform: "inherit",
              cursor: "pointer",
            }}
          >
            {icon}
            <span style={{ flex: 1, textAlign: "left" }}>{title}</span>
            <IconChevronRight
              size={10}
              style={{
                color: "var(--muted)",
                transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                transition: "transform 0.12s ease",
              }}
            />
          </button>
        ) : (
          <>
            {icon}
            <span style={{ flex: 1 }}>{title}</span>
          </>
        )}
        {action}
      </header>
      {!collapsed && <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>{children}</div>}
    </section>
  );
}

function SidebarLink({
  href,
  active,
  prominent,
  children,
}: {
  href: string;
  active?: boolean;
  prominent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={prominent ? "neu-btn-primary" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: prominent ? "center" : undefined,
        gap: 8,
        padding: prominent ? "9px 12px" : "6px 10px",
        margin: "0 4px",
        borderRadius: prominent ? "var(--radius-md)" : 8,
        fontSize: prominent ? 13 : 12.5,
        color: prominent || active ? "var(--ink)" : "var(--ink-soft)",
        background: prominent ? "var(--paper)" : active ? "var(--fill-1)" : "transparent",
        border: prominent ? "1px solid var(--paper-edge)" : "none",
        boxShadow: prominent ? "var(--neu-raised-strong)" : undefined,
        textDecoration: "none",
        fontWeight: prominent || active ? 600 : 500,
        transition: "background 0.12s, box-shadow 0.13s ease, transform 0.05s ease",
      }}
    >
      {children}
    </Link>
  );
}

function AutomationRow({
  automation,
  active,
  locale,
  onOpen,
  onDelete,
}: {
  automation: Automation;
  active: boolean;
  locale: "ko" | "en";
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const nextRun = formatAutomationTime(automation.nextRunAt, locale);
  const state = automation.enabled
    ? nextRun || (locale === "ko" ? "활성" : "Active")
    : locale === "ko" ? "꺼짐" : "Off";
  return (
    <div
      style={{ position: "relative", margin: "0 4px" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        title={automation.name}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          paddingRight: hovered ? 32 : 10,
          borderRadius: 8,
          border: "none",
          background: active ? "var(--fill-2)" : "transparent",
          color: active ? "var(--ink)" : "var(--ink-soft)",
          fontSize: 12.5,
          fontWeight: active ? 650 : 500,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: automation.enabled ? "var(--green-deep)" : "var(--muted)",
            boxShadow: automation.enabled
              ? "0 0 0 3px color-mix(in srgb, var(--green-deep) 12%, transparent)"
              : undefined,
          }}
        />
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {automation.name}
        </span>
        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--muted)", maxWidth: 78, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {state}
        </span>
      </button>
      {hovered && (
        <button
          type="button"
          aria-label={locale === "ko" ? "자동화 삭제" : "Delete automation"}
          title={locale === "ko" ? "자동화 삭제" : "Delete automation"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            width: 22,
            height: 22,
            borderRadius: 6,
            border: "none",
            background: "transparent",
            color: "var(--red-deep)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <IconTrash size={12} />
        </button>
      )}
    </div>
  );
}

function formatAutomationTime(value: string | null, locale: "ko" | "en"): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const formatter = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return formatter.format(new Date(time));
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        fontSize: 11,
        color: "var(--muted-deep)",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function NewChatScopeDialog({
  projects,
  projectsLoaded,
  locale,
  onCancel,
  onGlobal,
  onProject,
}: {
  projects: Project[];
  projectsLoaded: boolean;
  locale: "ko" | "en";
  onCancel: () => void;
  onGlobal: () => void;
  onProject: (project: Project) => void;
}) {
  const ko = locale === "ko";
  return (
    <div
      className="titlebar-nodrag"
      role="dialog"
      aria-modal="true"
      aria-label={ko ? "새 채팅 시작 위치" : "New chat scope"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0, 21, 25, 0.18)",
      }}
      onMouseDown={(e) => {
        if (e.currentTarget === e.target) onCancel();
      }}
    >
      <div
        style={{
          width: "min(460px, 100%)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 12,
          background: "var(--paper)",
          boxShadow: "0 18px 60px rgba(0, 21, 25, 0.20)",
          padding: 14,
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ display: "grid", gap: 4, padding: "2px 2px 6px" }}>
          <strong style={{ fontSize: 15, color: "var(--ink)" }}>
            {ko ? "새 채팅을 어디에서 시작할까요?" : "Where should this new chat start?"}
          </strong>
          <span style={{ fontSize: 12.5, color: "var(--muted-deep)", lineHeight: 1.45 }}>
            {ko
              ? "일반 대화로 시작하거나, 프로젝트 메모리와 작업 폴더를 이어받아 시작합니다."
              : "Start a global chat, or attach project memory and its working folder."}
          </span>
        </div>
        <button type="button" onClick={onGlobal} style={scopeButtonStyle}>
          <span style={scopeIconStyle}><IconChat size={15} /></span>
          <span style={{ minWidth: 0 }}>
            <strong style={scopeTitleStyle}>{ko ? "그냥 새 채팅" : "Global chat"}</strong>
            <span style={scopeSubStyle}>{ko ? "프로젝트 메모리 없이 시작" : "No project memory attached"}</span>
          </span>
        </button>
        <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
          {!projectsLoaded ? (
            <div style={{ padding: "8px 10px", color: "var(--muted-deep)", fontSize: 12 }}>
              {ko ? "프로젝트 불러오는 중..." : "Loading projects..."}
            </div>
          ) : (
            projects.map((project) => (
              <button key={project.id} type="button" onClick={() => onProject(project)} style={scopeButtonStyle}>
                <span style={scopeIconStyle}><IconFolder size={15} /></span>
                <span style={{ minWidth: 0 }}>
                  <strong style={scopeTitleStyle}>{project.name}</strong>
                  <span style={scopeSubStyle}>
                    {project.folderPath
                      ? project.folderPath
                      : ko ? "프로젝트 메모리만 연결" : "Project memory only"}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={cancelButtonStyle}>
            {ko ? "취소" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuntimeDot({ status }: { status: RuntimeStatus | null }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: status ? "var(--green-deep)" : "var(--red-deep)",
        flexShrink: 0,
      }}
    />
  );
}

// 라이트/다크 빠른 전환 — 푸터에 배치 (접힘/펼침 공용)
function ThemeToggleButton({ collapsed }: { collapsed?: boolean }) {
  const { t } = useT();
  const { resolved, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label={t("sidebar.theme_toggle")}
      title={t("sidebar.theme_toggle")}
      style={
        collapsed
          ? iconBtnStyle(false)
          : {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 6,
              borderRadius: 8,
              color: "var(--muted-deep)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }
      }
    >
      {resolved === "dark" ? (
        <IconSun size={collapsed ? 15 : 16} />
      ) : (
        <IconMoon size={collapsed ? 15 : 16} />
      )}
    </button>
  );
}

function labelOfRuntime(s: RuntimeStatus): string {
  // Ollama는 "Ollama · <model>"로 단독 표기 (백엔드 라벨 중복 회피).
  if (s.kind === "ollama") {
    return s.model ? `Ollama · ${s.model}` : "Ollama";
  }
  const kind = {
    "claude-code": "Claude Code",
    codex: "Codex",
    gemini: "Antigravity",
    grok: "Grok",
    byok: "API",
    ollama: "Ollama",
  }[s.kind];
  const backend = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    ollama: "Ollama",
    upstage: "Upstage",
    custom: "Custom",
    glm: "GLM",
    kimi: "Kimi",
    deepseek: "DeepSeek",
  }[s.backend ?? ""];
  return `${kind} · ${backend}`;
}

function iconBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: 10,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: active ? "var(--fill-1)" : "transparent",
    color: active ? "var(--accent)" : "var(--ink-soft)",
    border: "none",
    cursor: "pointer",
    transition: "background 0.12s",
  };
}

const scopeButtonStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  display: "grid",
  gridTemplateColumns: "32px minmax(0, 1fr)",
  alignItems: "center",
  gap: 10,
  padding: "10px 11px",
  borderRadius: 10,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  textAlign: "left",
  cursor: "pointer",
};

const scopeIconStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 9,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--fill-1)",
  color: "var(--accent)",
};

const scopeTitleStyle: React.CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 13,
  fontWeight: 700,
};

const scopeSubStyle: React.CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  marginTop: 2,
  fontSize: 11.5,
  color: "var(--muted-deep)",
};

const cancelButtonStyle: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 999,
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: "7px 12px",
  fontSize: 12.5,
  fontWeight: 650,
  cursor: "pointer",
};

const sidebarResizeHandleStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  width: 7,
  cursor: "col-resize",
  zIndex: 8,
  touchAction: "none",
};

function CollapsedNav({
  pathname,
}: {
  pathname: string;
}) {
  const { t } = useT();
  const items: Array<{
    href: string;
    label: string;
    icon: React.ReactNode;
    isActive: boolean;
    badge?: string | number;
    prominent?: boolean;
  }> = [
    {
      href: "/dashboard",
      label: "Dashboard",
      icon: <IconHome size={16} />,
      isActive: pathname === "/dashboard",
      prominent: true,
    },
    {
      href: "/chat",
      label: t("sidebar.chats"),
      icon: <IconChat size={16} />,
      isActive: pathname === "/chat",
    },
    {
      href: "/project/new",
      label: t("sidebar.projects"),
      icon: <IconFolder size={16} />,
      isActive: pathname.startsWith("/project"),
    },
    {
      href: "/automation",
      label: t("sidebar.automations"),
      icon: <IconBolt size={16} />,
      isActive: pathname.startsWith("/automation"),
    },
  ];
  return (
    <>
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          aria-label={it.label}
          title={it.label}
          style={{
            position: "relative",
            ...iconBtnStyle(it.isActive),
            ...(it.prominent
              ? {
                  background: "var(--paper)",
                  color: it.isActive ? "var(--ink)" : "var(--ink-soft)",
                  border: "1px solid var(--paper-edge)",
                  boxShadow: "var(--neu-raised)",
                }
              : {}),
            textDecoration: "none",
          }}
        >
          {it.icon}
          {it.badge !== undefined && (
            <span
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                minWidth: 14,
                height: 14,
                padding: "0 4px",
                borderRadius: 999,
                background: "var(--ink)",
                color: "var(--paper)",
                fontSize: 9,
                fontWeight: 700,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {it.badge}
            </span>
          )}
        </Link>
      ))}
    </>
  );
}
