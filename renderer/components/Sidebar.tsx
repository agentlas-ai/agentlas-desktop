// 좌측 사이드바 — Claude Desktop / Codex / Antigravity 스타일.
// 섹션: 새 채팅 / 최근 채팅 / 프로젝트 / 자동화 / 라이브러리. Footer = 런타임 상태 + 설정.
"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import type {
  Automation,
  Chat,
  InstalledAgent,
  InstalledFirm,
  Project,
  RuntimeStatus,
} from "@/lib/types";
import {
  IconApps,
  IconBolt,
  IconBuilding,
  IconChat,
  IconChevronRight,
  IconFolder,
  IconKey,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconStore,
  IconSun,
} from "./Icon";
import { PawLogo } from "./PawLogo";
import { ChatRow } from "./ChatRow";
import { AccountChip } from "./AccountChip";
import { VersionChip } from "./VersionChip";
import { pickLocalized, useT } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";

const COLLAPSE_KEY = "agentlas.sidebar.collapsed";
const COLLAPSED_WIDTH = 60;
const EXPANDED_WIDTH = 248;

interface SidebarData {
  chats: Chat[];
  projects: Project[];
  firms: InstalledFirm[];
  automations: Automation[];
  agents: InstalledAgent[];
  runtime: RuntimeStatus | null;
}

const EMPTY: SidebarData = {
  chats: [],
  projects: [],
  firms: [],
  automations: [],
  agents: [],
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

  // 사용자 선호 영구화 — localStorage. SSR 안전.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSE_KEY);
      if (stored === "1") setCollapsed(true);
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
      api.firms.list(),
      api.automations.list(),
      api.team.list(),
      api.runtime.detect(),
    ]).then(([chats, projects, firms, automations, agents, runtimes]) => {
      if (cancelled) return;
      const active = runtimes.find((r) => r.active) ?? runtimes[0] ?? null;
      setData({ chats, projects, firms, automations, agents, runtime: active });
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, pathname]);

  async function handleNewChat() {
    const api = ipc();
    if (!api) return;
    if (data.agents.length === 0) {
      navigate("/onboarding");
      return;
    }
    const agentId =
      data.agents.find((a) => a.slug === "agentlas-orchestrator")?.id ??
      data.chats[0]?.agentId ??
      data.agents[0].id;
    const chat = await api.chats.create({ agentId });
    navigate(`/chat?id=${chat.id}`);
  }

  // ── 접힘 모드: 아이콘만 ───────────────────────────────
  if (collapsed) {
    return (
      <aside
        className="glass-thin"
        style={{
          width: COLLAPSED_WIDTH,
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
          <CollapsedNav pathname={pathname} agentCount={data.agents.length} />
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
    );
  }

  // ── 펼침 모드: 풀 사이드바 ─────────────────────────────
  return (
    <aside
      className="glass-thin"
      style={{
        width: EXPANDED_WIDTH,
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
          paddingLeft: 72, // macOS 신호등 자리
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
            letterSpacing: -0.1,
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
        <SidebarSection
          title={t("sidebar.chats")}
          icon={<IconChat size={12} />}
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
            data.chats.slice(0, 12).map((c) => {
              const agent = data.agents.find((a) => a.id === c.agentId);
              const active = pathname === "/chat" && currentChatId === c.id;
              return (
                <ChatRow
                  key={c.id}
                  chat={c}
                  agent={agent}
                  active={active}
                  running={runningChats.has(c.id)}
                  onChanged={triggerRefresh}
                />
              );
            })
          )}
        </SidebarSection>

        <SidebarSection
          title={t("sidebar.firms")}
          icon={<IconBuilding size={12} />}
          action={
            <Link
              href="/marketplace?tab=firms"
              style={{ color: "var(--muted-deep)", display: "inline-flex" }}
              title={t("sidebar.empty_firms_install")}
            >
              <IconPlus size={12} />
            </Link>
          }
        >
          {data.firms.length === 0 ? (
            <EmptyHint>
              <Link
                href="/marketplace?tab=firms"
                style={{ color: "var(--accent)", fontWeight: 600 }}
              >
                + {t("sidebar.empty_firms_install")}
              </Link>
              <br />
              <span style={{ fontSize: 10, color: "var(--muted)" }}>
                {t("sidebar.empty_firms_hint")}
              </span>
            </EmptyHint>
          ) : (
            data.firms.slice(0, 6).map((f) => {
              const active = pathname === "/firm/detail" && currentFirmId === f.id;
              return (
                <SidebarLink key={f.id} href={`/firm/detail?id=${f.id}`} active={active}>
                  <IconBuilding size={12} style={{ color: "var(--accent)" }} />
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {pickLocalized(f, locale).name}
                  </span>
                </SidebarLink>
              );
            })
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
          action={
            <Link
              href="/automation/new"
              style={{ color: "var(--muted-deep)", display: "inline-flex" }}
            >
              <IconPlus size={12} />
            </Link>
          }
        >
          {data.automations.length === 0 ? (
            <EmptyHint>
              <Link href="/automation" style={{ color: "var(--accent)", fontWeight: 600 }}>
                + {t("sidebar.empty_automations")}
              </Link>
            </EmptyHint>
          ) : (
            data.automations.slice(0, 6).map((a) => {
              const active = pathname === "/automation/detail" && currentAutomationId === a.id;
              return (
                <SidebarLink key={a.id} href={`/automation/detail?id=${a.id}`} active={active}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: a.enabled ? "var(--green-deep)" : "var(--paper-edge)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {a.name}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>{a.scheduleHuman}</span>
                </SidebarLink>
              );
            })
          )}
        </SidebarSection>

        <SidebarSection title={t("sidebar.apps")} icon={<IconApps size={12} />}>
          <SidebarLink href="/apps" active={pathname.startsWith("/apps")}>
            <IconSparkles size={13} style={{ color: "var(--accent)" }} />
            <span style={{ flex: 1 }}>{t("sidebar.apps_installed")}</span>
            <span style={{ fontSize: 10, color: "var(--muted)" }}>{data.agents.length}</span>
          </SidebarLink>
          <SidebarLink href="/marketplace" active={pathname === "/marketplace"}>
            <IconStore size={13} style={{ color: "var(--peach-ink)" }} />
            <span style={{ flex: 1 }}>{t("sidebar.apps_store")}</span>
            <IconChevronRight size={11} style={{ color: "var(--muted)" }} />
          </SidebarLink>
          <SidebarLink href="/library/env" active={pathname.startsWith("/library/env")}>
            <IconKey size={13} style={{ color: "var(--peach-ink)" }} />
            <span style={{ flex: 1 }}>{t("sidebar.apps_vault")}</span>
          </SidebarLink>
          <SidebarLink href="/library/mcps" active={pathname.startsWith("/library/mcps")}>
            <IconSparkles size={13} style={{ color: "var(--purple-deep)" }} />
            <span style={{ flex: 1 }}>{t("sidebar.apps_engines")}</span>
          </SidebarLink>
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
  );
}

function SidebarSection({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
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
        {icon}
        <span style={{ flex: 1 }}>{title}</span>
        {action}
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>{children}</div>
    </section>
  );
}

function SidebarLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        margin: "0 4px",
        borderRadius: 8,
        fontSize: 12.5,
        color: active ? "var(--ink)" : "var(--ink-soft)",
        background: active ? "var(--fill-1)" : "transparent",
        textDecoration: "none",
        fontWeight: active ? 600 : 500,
        transition: "background 0.12s",
      }}
    >
      {children}
    </Link>
  );
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
    gemini: "Gemini",
    byok: "API",
    ollama: "Ollama",
  }[s.kind];
  const backend = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    ollama: "Ollama",
    upstage: "Solar",
  }[s.backend];
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

function CollapsedNav({
  pathname,
  agentCount,
}: {
  pathname: string;
  agentCount: number;
}) {
  const { t } = useT();
  const items: Array<{
    href: string;
    label: string;
    icon: React.ReactNode;
    isActive: boolean;
    badge?: string | number;
  }> = [
    {
      href: "/",
      label: t("sidebar.chats"),
      icon: <IconChat size={16} />,
      isActive: pathname === "/",
    },
    {
      href: "/marketplace?tab=firms",
      label: t("sidebar.firms"),
      icon: <IconBuilding size={16} />,
      isActive: pathname.startsWith("/firm"),
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
    {
      href: "/apps",
      label: t("sidebar.apps"),
      icon: <IconApps size={16} />,
      isActive: pathname.startsWith("/apps") || pathname.startsWith("/library") || pathname === "/marketplace",
      badge: agentCount > 0 ? agentCount : undefined,
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
          style={{ position: "relative", ...iconBtnStyle(it.isActive), textDecoration: "none" }}
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
