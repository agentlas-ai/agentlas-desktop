// 좌측 글로벌 내비게이션 사이드바 — 기존 상단 TopNavbar를 대체.
// 레퍼런스(Untitled UI) 패턴: 로고 헤더 → 검색 → 1차 메뉴 → 펼침 섹션 → 하단 설정/계정.
//   · 상단 드롭다운(Agent Forge/Studio/Hub/Environment)을 펼침 섹션으로 변환.
//   · 접기(collapsed) 모드: 아이콘만 + hover 툴팁. 상태는 localStorage 영속.
//   · 최상단은 titlebar-drag(맥 신호등 회피 + 창 드래그).
"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PawLogo } from "./PawLogo";
import { AccountChip } from "./AccountChip";
import { UpdateBanner } from "./UpdateBanner";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import {
  IconWand,
  IconUsers,
  IconStore,
  IconFileUp,
  IconLayers,
  IconHome,
  IconChat,
  IconBuilding,
  IconApps,
  IconBolt,
  IconKey,
  IconNetwork,
  IconSearch,
  IconSettings,
  IconChevronDown,
  IconSidebar,
} from "./Icon";
import type { ComponentType } from "react";

type IconType = ComponentType<{ size?: number }>;
const COLLAPSE_KEY = "agentlas.sidenav.collapsed";

interface Leaf {
  label: string;
  href: string;
  icon: IconType;
}
interface Group {
  id: string;
  label: string;
  href: string;
  icon: IconType;
  isActive: (p: string) => boolean;
  items: Leaf[];
}

export function SideNav({ pendingConfirmations = 0 }: { pendingConfirmations?: number }) {
  const { t } = useT();
  const pathname = usePathname() ?? "/";
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const primary: Leaf[] = useMemo(
    () => [
      { label: t("nav.dashboard"), href: "/dashboard", icon: IconHome },
      { label: t("nav.workspace"), href: "/chat", icon: IconChat },
    ],
    [t],
  );

  const groups: Group[] = useMemo(
    () => [
      {
        id: "agent_forge",
        label: t("nav.group.agent_forge"),
        href: "/build",
        icon: IconBuilding,
        isActive: (p) => p.startsWith("/build") || p.startsWith("/library/agents") || p.startsWith("/cloud"),
        items: [
          { label: t("nav.build"), href: "/build", icon: IconWand },
          { label: t("nav.agent"), href: "/library/agents", icon: IconUsers },
        ],
      },
      {
        id: "studio",
        label: t("nav.group.studio"),
        href: "/apps",
        icon: IconApps,
        isActive: (p) => p.startsWith("/apps") || p.startsWith("/automation"),
        items: [
          { label: t("nav.apps"), href: "/apps", icon: IconApps },
          { label: t("nav.automations"), href: "/automation", icon: IconBolt },
        ],
      },
      {
        id: "hub",
        label: t("nav.group.hub"),
        href: "/marketplace",
        icon: IconStore,
        isActive: (p) => p.startsWith("/marketplace"),
        items: [
          { label: t("nav.agent_hub"), href: "/marketplace", icon: IconStore },
          { label: t("nav.publish"), href: "/cloud", icon: IconFileUp },
        ],
      },
      {
        id: "environment",
        label: t("nav.group.environment"),
        href: "/library/env",
        icon: IconKey,
        isActive: (p) => p.startsWith("/library") && !p.startsWith("/library/agents"),
        items: [
          { label: t("nav.env_keys"), href: "/library/env", icon: IconKey },
          { label: t("nav.mcp_tools"), href: "/library/mcps", icon: IconNetwork },
          { label: t("nav.apps_library"), href: "/library/apps", icon: IconApps },
          { label: t("nav.tool_library"), href: "/library/tools", icon: IconWand },
          { label: t("nav.surfaces"), href: "/library/surfaces", icon: IconBuilding },
          { label: t("nav.assets"), href: "/library/assets", icon: IconLayers },
        ],
      },
    ],
    [t],
  );

  // 활성 그룹은 기본으로 펼친다(사용자가 명시적으로 토글하면 그 값 우선).
  function isGroupOpen(g: Group): boolean {
    return openGroups[g.id] ?? g.isActive(pathname);
  }
  function toggleGroup(id: string, fallbackOpen: boolean) {
    setOpenGroups((p) => ({ ...p, [id]: !(p[id] ?? fallbackOpen) }));
  }

  const hrefPath = (href: string) => href.split("?")[0] || href;
  const isLeafActive = (href: string) => {
    const path = hrefPath(href);
    if (path === "/chat") {
      return pathname.startsWith("/chat") || pathname.startsWith("/project");
    }
    if (path === "/dashboard") {
      return pathname.startsWith("/dashboard");
    }
    return pathname === path || pathname.startsWith(path + "/");
  };

  function submitSearch() {
    const q = query.trim();
    navigate(q ? `/marketplace?q=${encodeURIComponent(q)}` : "/marketplace");
  }

  return (
    <aside className="sidenav glass-thin" data-collapsed={collapsed ? "true" : "false"}>
      {/* 맥 신호등 회피 + 창 드래그 */}
      <div className="sidenav-drag titlebar-drag" />

      <div className="sidenav-header titlebar-nodrag">
        <Link href="/" className="sidenav-brand" title="Agentlas">
          <PawLogo size={22} />
          {!collapsed && (
            <span className="sidenav-brand-text">
              <strong>Agentlas</strong>
              <span>{t("nav.brand_sub")}</span>
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="sidenav-collapse"
          aria-label={collapsed ? t("nav.expand_sidebar") : t("nav.collapse_sidebar")}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
        >
          <IconSidebar size={16} />
        </button>
      </div>

      {!collapsed && (
        <form
          className="sidenav-search titlebar-nodrag"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("nav.search_placeholder")}
            aria-label={t("nav.search_placeholder")}
          />
        </form>
      )}

      <nav className="sidenav-scroll titlebar-nodrag">
        {/* 1차 메뉴 */}
        <div className="sidenav-list">
          {primary.map((it) => {
            const Icon = it.icon;
            const active = isLeafActive(it.href);
            const alertCount = it.href === "/dashboard" ? pendingConfirmations : 0;
            const alertLabel =
              alertCount > 0
                ? `${it.label}, ${t("nav.pending_approvals", { n: alertCount })}`
                : it.label;
            return (
              <Link
                key={it.href}
                href={it.href}
                className="sidenav-item"
                data-active={active ? "true" : "false"}
                data-alert={alertCount > 0 ? "true" : "false"}
                aria-label={alertLabel}
              >
                <span className="sidenav-ic"><Icon size={18} /></span>
                {!collapsed && <span className="sidenav-label">{it.label}</span>}
                {alertCount > 0 && (
                  <span className="sidenav-alert-badge" aria-hidden="true">
                    {alertCount > 99 ? "99+" : alertCount}
                  </span>
                )}
                {collapsed && <span className="sidenav-tooltip">{it.label}</span>}
              </Link>
            );
          })}
        </div>

        <div className="sidenav-divider" />

        {/* 펼침 섹션 */}
        <div className="sidenav-list">
          {groups.map((g) => {
            const Icon = g.icon;
            const active = g.isActive(pathname);
            const open = isGroupOpen(g);
            if (collapsed) {
              // 접힘: 그룹 대표 아이콘만 — 클릭 시 기본 경로로 이동, hover 툴팁.
              return (
                <Link key={g.id} href={g.href} className="sidenav-item" data-active={active ? "true" : "false"}>
                  <span className="sidenav-ic"><Icon size={18} /></span>
                  <span className="sidenav-tooltip">{g.label}</span>
                </Link>
              );
            }
            return (
              <div key={g.id} className="sidenav-group">
                <button
                  type="button"
                  className="sidenav-item sidenav-group-head"
                  data-active={active ? "true" : "false"}
                  onClick={() => toggleGroup(g.id, active)}
                >
                  <span className="sidenav-ic"><Icon size={18} /></span>
                  <span className="sidenav-label">{g.label}</span>
                  <span className="sidenav-caret" data-open={open ? "true" : "false"}>
                    <IconChevronDown size={14} />
                  </span>
                </button>
                {open && (
                  <div className="sidenav-sub">
                    {g.items.map((sub) => {
                      const active2 = isLeafActive(sub.href);
                      return (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          className="sidenav-subitem"
                          data-active={active2 ? "true" : "false"}
                        >
                          <span className="sidenav-sub-dot" />
                          <span className="sidenav-label">{sub.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* 하단: 설정 + 계정 */}
      <div className="sidenav-foot titlebar-nodrag">
        <UpdateBanner collapsed={collapsed} />
        <Link
          href="/settings"
          className="sidenav-item"
          data-active={pathname === "/settings" ? "true" : "false"}
        >
          <span className="sidenav-ic"><IconSettings size={18} /></span>
          {!collapsed && <span className="sidenav-label">{t("nav.settings")}</span>}
          {collapsed && <span className="sidenav-tooltip">{t("nav.settings")}</span>}
        </Link>
        <div className="sidenav-account">
          <AccountChip />
        </div>
      </div>
    </aside>
  );
}
