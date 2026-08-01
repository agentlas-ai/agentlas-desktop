// 좌측 글로벌 내비게이션 사이드바 — 기존 상단 TopNavbar를 대체.
// 레퍼런스(Untitled UI) 패턴: 로고 헤더 → 검색 → 1차 메뉴 → 펼침 섹션 → 하단 설정/계정.
//   · 상단 드롭다운(Agent Cloud/Environment)을 펼침 섹션으로 변환.
//   · 접기(collapsed) 모드: 아이콘만 + hover 툴팁. 상태는 localStorage 영속.
//   · 최상단은 titlebar-drag(맥 신호등 회피 + 창 드래그).
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProductModeMenu } from "./one/ProductModeMenu";
import { AccountChip } from "./AccountChip";
import { CreditBalanceWidget } from "./CreditBalanceWidget";
import { UpdateBanner } from "./UpdateBanner";
import { navigate } from "@/lib/navigation";
import { ipc } from "@/lib/ipc";
import { classifyHubEntity, entityClassShortLabel } from "@/lib/agent-entity-kind";
import { pickLocalized, useT } from "@/lib/i18n";
import {
  IconWand,
  IconUsers,
  IconFileUp,
  IconHome,
  IconChat,
  IconAtSign,
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
import type { MarketplaceListing } from "@/lib/types";
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

export function SideNav({
  pendingConfirmations = 0,
  forceCollapsed = false,
}: {
  pendingConfirmations?: number;
  /** 워크스페이스(채팅) 병합 레일 — 채팅 Sidebar와 나란히 둘 때 아이콘 전용으로 강제 축소. */
  forceCollapsed?: boolean;
}) {
  const { t, locale } = useT();
  const pathname = usePathname() ?? "/";
  const [collapsedPref, setCollapsed] = useState(false);
  const collapsed = forceCollapsed || collapsedPref;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchSuggestions, setSearchSuggestions] = useState<MarketplaceListing[]>([]);
  const [searchSuggestionQuery, setSearchSuggestionQuery] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchGenerationRef = useRef(0);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  // 글로벌 Hub 검색은 Enter 제출 전용이 아니다. 입력 중 실제 Hub 결과를 짧게
  // debounce해 보여주고, 늦은 이전 응답은 generation으로 폐기한다.
  useEffect(() => {
    const q = query.trim();
    const generation = ++searchGenerationRef.current;
    setSearchSuggestions([]);
    setSearchSuggestionQuery(q);
    setSearchActiveIndex(0);
    if (collapsed || !q) {
      setSearchLoading(false);
      return;
    }
    const api = ipc();
    if (!api) return;
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void api.marketplace
        .search(q)
        .then((items) => {
          if (searchGenerationRef.current !== generation) return;
          setSearchSuggestions(items.slice(0, 6));
          setSearchSuggestionQuery(q);
          setSearchActiveIndex(0);
        })
        .catch(() => {
          if (searchGenerationRef.current === generation) setSearchSuggestions([]);
        })
        .finally(() => {
          if (searchGenerationRef.current === generation) setSearchLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [collapsed, query]);

  function toggleCollapsed() {
    if (forceCollapsed) return;
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
      { label: t("nav.workspace"), href: "/workspace", icon: IconChat },
      { label: t("nav.agent_hub"), href: "/marketplace", icon: IconUsers },
      { label: t("nav.automations"), href: "/automation", icon: IconBolt },
      { label: t("nav.site"), href: "/site", icon: IconApps },
    ],
    [t],
  );

  const groups: Group[] = useMemo(
    () => [
      {
        id: "connect",
        label: t("nav.group.connect"),
        href: "/connect",
        icon: IconAtSign,
        isActive: (p) => p.startsWith("/connect") || p.startsWith("/browser"),
        items: [
          { label: t("nav.telegram"), href: "/connect", icon: IconAtSign },
          { label: t("nav.browser"), href: "/browser", icon: IconNetwork },
        ],
      },
      {
        id: "agent_cloud",
        label: t("nav.group.agent_cloud"),
        href: "/build",
        icon: IconBuilding,
        isActive: (p) => p.startsWith("/build") || p.startsWith("/library/agents") || p.startsWith("/cloud"),
        items: [
          { label: t("nav.build"), href: "/build", icon: IconWand },
          { label: t("nav.agent"), href: "/library/agents", icon: IconUsers },
          { label: t("nav.agent_upload"), href: "/cloud", icon: IconFileUp },
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
    if (path === "/workspace") {
      return pathname.startsWith("/workspace") || pathname.startsWith("/project");
    }
    if (path === "/dashboard") {
      return pathname.startsWith("/dashboard");
    }
    return pathname === path || pathname.startsWith(path + "/");
  };

  function submitSearch() {
    const q = query.trim();
    setSearchFocused(false);
    navigate(q ? `/marketplace?q=${encodeURIComponent(q)}` : "/marketplace");
  }

  function chooseSearchSuggestion(listing: MarketplaceListing) {
    setQuery(listing.slug);
    setSearchFocused(false);
    navigate(`/marketplace?q=${encodeURIComponent(listing.slug)}`);
  }

  const currentSearchQuery = query.trim();
  const currentSearchSuggestions = searchSuggestionQuery === currentSearchQuery ? searchSuggestions : [];
  const searchSuggestionsOpen = searchFocused && Boolean(currentSearchQuery);

  return (
    <aside className="sidenav glass-thin" data-collapsed={collapsed ? "true" : "false"} data-merged={forceCollapsed ? "true" : "false"}>
      {/* 맥 신호등 회피 + 창 드래그 */}
      <div className="sidenav-drag titlebar-drag" />

      <div className="sidenav-header titlebar-nodrag">
        <ProductModeMenu current="work" compact={collapsed} />
        {!forceCollapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            className="sidenav-collapse"
            aria-label={collapsed ? t("nav.expand_sidebar") : t("nav.collapse_sidebar")}
            title={collapsed ? t("nav.expand") : t("nav.collapse")}
          >
            <IconSidebar size={16} />
          </button>
        )}
      </div>

      {!collapsed && (
        <form
          className="sidenav-search titlebar-nodrag"
          style={{ position: "relative" }}
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchFocused(false);
          }}
        >
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchFocused(true);
              setSearchActiveIndex(0);
            }}
            onFocus={() => setSearchFocused(true)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                setSearchFocused(false);
                return;
              }
              if (currentSearchSuggestions.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setSearchActiveIndex((index) => (index + delta + currentSearchSuggestions.length) % currentSearchSuggestions.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                chooseSearchSuggestion(currentSearchSuggestions[searchActiveIndex] ?? currentSearchSuggestions[0]);
              }
            }}
            placeholder={t("nav.search_placeholder")}
            aria-label={t("nav.search_placeholder")}
            role="combobox"
            aria-expanded={searchSuggestionsOpen}
            aria-controls="sidenav-hub-search-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={searchSuggestionsOpen && currentSearchSuggestions.length > 0 ? `sidenav-hub-option-${searchActiveIndex}` : undefined}
          />
          {searchSuggestionsOpen && (
            <div
              id="sidenav-hub-search-suggestions"
              role="listbox"
              aria-label={locale === "ko" ? "Hub 자동완성" : "Hub suggestions"}
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                right: 0,
                zIndex: 120,
                maxHeight: 300,
                overflowY: "auto",
                padding: 6,
                borderRadius: 12,
                background: "var(--paper)",
                border: "1px solid var(--paper-edge)",
                boxShadow: "0 16px 42px rgba(11,11,15,0.16)",
              }}
            >
              {searchLoading && currentSearchSuggestions.length === 0 ? (
                <div style={{ padding: "10px 9px", fontSize: 11.5, color: "var(--muted-deep)" }}>
                  {locale === "ko" ? "Hub에서 찾는 중…" : "Searching Hub…"}
                </div>
              ) : currentSearchSuggestions.length === 0 ? (
                <div style={{ padding: "10px 9px", fontSize: 11.5, color: "var(--muted-deep)" }}>
                  {locale === "ko" ? "일치하는 Hub 항목이 없습니다." : "No matching Hub items."}
                </div>
              ) : (
                currentSearchSuggestions.map((listing, index) => {
                  const loc = pickLocalized(listing, locale);
                  const entityClass = classifyHubEntity(listing);
                  return (
                    <button
                      id={`sidenav-hub-option-${index}`}
                      key={`${entityClass}-${listing.slug}`}
                      type="button"
                      role="option"
                      aria-selected={index === searchActiveIndex}
                      onMouseEnter={() => setSearchActiveIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseSearchSuggestion(listing)}
                      style={{
                        width: "100%",
                        display: "grid",
                        gridTemplateColumns: "minmax(0,1fr) auto",
                        gap: 8,
                        padding: "8px 9px",
                        borderRadius: 8,
                        background: index === searchActiveIndex ? "var(--fill-1)" : "transparent",
                        color: "var(--ink)",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                          {loc.name}
                        </strong>
                        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, color: "var(--muted-deep)", marginTop: 2 }}>
                          {loc.tagline || listing.slug}
                        </span>
                      </span>
                      <span style={{ fontSize: 9.5, color: "var(--muted-deep)", alignSelf: "center" }}>
                        {entityClassShortLabel(entityClass, locale)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
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
          <CreditBalanceWidget collapsed={collapsed} />
          <AccountChip />
        </div>
      </div>
    </aside>
  );
}
