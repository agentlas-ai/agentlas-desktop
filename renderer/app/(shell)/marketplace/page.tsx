"use client";
import { Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { classifyHubEntity, entityClassLabel } from "@/lib/agent-entity-kind";
import {
  announceHubBookmarkChange,
  hubBookmarkIdentityKey,
  hubBookmarkIdentityKeyFromParts,
  hubListingIdentityKey,
  onHubBookmarkChange,
} from "@/lib/hub-bookmark-events";
import {
  hubSecurityGradeExplanation,
  hubSecurityGradeLabel,
  hubVerificationFacts,
  isCallableHubListing,
} from "@/lib/hub-verification";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import type {
  ExperienceHubCatalogResult,
  HephaestusCommandResult,
  MarketplaceListing,
  MarketplaceSourceStatus,
} from "@/lib/types";

const TEAM_CALL_CREDITS = 10;
const AGENT_CALL_CREDITS = 3;

const C = {
  purple: "color-mix(in oklch, var(--rd-accent) 18%, var(--rd-surface))",
  peach: "var(--rd-accent-2)",
  green: "color-mix(in oklch, var(--rd-ok) 24%, var(--rd-surface))",
  blue: "color-mix(in oklch, #0284c7 18%, var(--rd-surface))",
};

type HubCategory = "all" | "agent" | "team" | "plugin";
type HubView = "agents" | "experience";

function isLiveHubListing(listing: MarketplaceListing): boolean {
  return listing.source === "hub-index" || listing.source === "hub-profile" || listing.source === "hub-plugin" || listing.kind === "cloud-callable" || listing.callable === true;
}

function hubCategoryFor(listing: MarketplaceListing): HubCategory {
  const entityClass = classifyHubEntity(listing);
  if (entityClass === "plugin") return "plugin";
  if (entityClass === "multi") return "team";
  return "agent";
}

function hubListingScore(listing: MarketplaceListing): number {
  if (!isLiveHubListing(listing)) return 0;
  const category = hubCategoryFor(listing);
  const base = category === "team" ? 1200 : category === "agent" ? 1100 : 900;
  return base + (listing.verifiedInvocations ?? listing.installCount ?? 0);
}

function orderListingsForHub(listings: MarketplaceListing[], hubLive: boolean): MarketplaceListing[] {
  if (!hubLive) return listings;
  return [...listings].sort((a, b) => {
    const score = hubListingScore(b) - hubListingScore(a);
    if (score !== 0) return score;
    return a.name.localeCompare(b.name);
  });
}

/** 같은 slug이 "호출 가능" 카드와 "설치 전용" 카드로 이중 인덱싱될 때(동일 패키지의 그림자)
 *  설치 전용 그림자를 숨긴다 — 호출 가능한 쪽이 상위호환(설치 없이 바로 실행)이라 중복 카드가 헷갈린다.
 *  둘 다 호출 가능한 진짜 별개 엔티티(팀+에이전트 동일 slug)는 그대로 둘 다 남겨 북마크 정체성을 보존한다. */
function dropInstallOnlyShadows(listings: MarketplaceListing[]): MarketplaceListing[] {
  const callableSlugs = new Set<string>();
  for (const l of listings) {
    if (l.callable === true || l.kind === "cloud-callable") {
      const slug = (l.slug || "").trim().toLowerCase();
      if (slug) callableSlugs.add(slug);
    }
  }
  return listings.filter((l) => {
    if (l.callable === true || l.kind === "cloud-callable") return true;
    const slug = (l.slug || "").trim().toLowerCase();
    return !(slug && callableSlugs.has(slug));
  });
}

// ── hep-search 폴백 — Hub 검색 0건(또는 실패) 시 엔진(hephaestus search) 후보를 보조 표기 ──
type HepFallbackItem = { slug: string; name: string; description: string; scope: string };
type HepFallbackState = { query: string; status: "loading" | "done"; items: HepFallbackItem[] };

/** hephaestus.search.v1 JSON(sections.cloud/bookmarks/hub[].results)을 단순 리스트로 정규화. */
function parseHepSearchResult(res: HephaestusCommandResult): HepFallbackItem[] {
  const json = res?.json as { sections?: Record<string, { results?: unknown[] }> } | null;
  const sections = json?.sections;
  if (!sections || typeof sections !== "object") return [];
  const items: HepFallbackItem[] = [];
  for (const key of ["cloud", "bookmarks", "hub"]) {
    const results = sections[key]?.results;
    if (!Array.isArray(results)) continue;
    for (const raw of results) {
      if (!raw || typeof raw !== "object") continue;
      const it = raw as Record<string, unknown>;
      const slug = typeof it.slug === "string" ? it.slug : "";
      if (!slug) continue;
      items.push({
        slug,
        name: typeof it.name === "string" && it.name ? it.name : slug,
        description: typeof it.description === "string" ? it.description : "",
        scope: key,
      });
    }
  }
  // 섹션 간 중복 slug 제거 후 상위 8개만.
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.slug) ? false : (seen.add(i.slug), true))).slice(0, 8);
}

export default function MarketplacePageWrapper() {
  return (
    <Suspense fallback={null}>
      <MarketplacePage />
    </Suspense>
  );
}

function MarketplacePage() {
  const { t, locale } = useT();
  const ko = locale === "ko";
  const router = useRouter();
  const searchParams = useSearchParams();

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;
  const [hubView, setHubView] = useState<HubView>(() => searchParams.get("view") === "experience" ? "experience" : "agents");
  const [category, setCategory] = useState<HubCategory>("all");
  const [experienceCatalog, setExperienceCatalog] = useState<ExperienceHubCatalogResult | null>(null);
  const [experienceCatalogLoading, setExperienceCatalogLoading] = useState(false);
  const [experienceCatalogRevision, setExperienceCatalogRevision] = useState(0);

  const [importNotice, setImportNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installedAgentSlugs, setInstalledAgentSlugs] = useState<Set<string>>(new Set());
  const [bookmarkedIdentities, setBookmarkedIdentities] = useState<Set<string>>(new Set());
  const [sourceStatus, setSourceStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [bookmarking, setBookmarking] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  // Hub 검색 0건/실패 시 hep-search(엔진) 보조 후보 — 카드와 별도의 단순 리스트로 표시.
  const [hepFallback, setHepFallback] = useState<HepFallbackState | null>(null);
  const hepSeqRef = useRef(0);
  // IPC 검색 자체는 AbortSignal을 받지 않으므로, AbortController로 이전 요청을 폐기하고
  // generation을 함께 확인해 늦은 search/status/fallback 응답이 최신 화면을 덮지 못하게 한다.
  const marketplaceSearchGenerationRef = useRef(0);
  const marketplaceSearchAbortRef = useRef<AbortController | null>(null);
  const bookmarkStateGenerationRef = useRef(0);

  // 좌측 사이드바 검색 등 외부에서 ?q= 로 진입하면 검색어를 반영.
  useEffect(() => {
    const urlQ = searchParams.get("q");
    if (urlQ != null) setQ(urlQ);
  }, [searchParams]);

  useEffect(() => {
    setPage(1);
  }, [q, category]);

  async function ensureSignedIn(): Promise<boolean> {
    const api = ipc();
    if (!api) return false;
    const current = await api.auth.getSession();
    if (current.signedIn) {
      if (!signedIn) setSignedIn(true);
      return true;
    }
    const next = await api.auth.signInWithGoogle();
    setSignedIn(next.signedIn);
    return next.signedIn;
  }

  async function refresh() {
    const api = ipc();
    if (!api) return;
    const bookmarkGeneration = ++bookmarkStateGenerationRef.current;
    const [ag, session, bookmarks] = await Promise.all([
      api.team.list(),
      api.auth.getSession(),
      api.marketplace.bookmarks?.().catch(() => []),
    ]);
    setInstalledAgentSlugs(new Set(visibleAgents(ag).map((a) => a.slug)));
    if (bookmarkStateGenerationRef.current === bookmarkGeneration) {
      setBookmarkedIdentities(new Set((bookmarks ?? []).map(hubBookmarkIdentityKey)));
    }
    setSignedIn(session.signedIn);
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (hubView !== "experience") return;
    let cancelled = false;
    setExperienceCatalogLoading(true);
    void ipc()?.experience.hubCatalog()
      .then((result) => {
        if (!cancelled) setExperienceCatalog(result);
      })
      .catch(() => {
        if (!cancelled) setExperienceCatalog({
          status: "unavailable",
          chips: [],
          checkedAt: new Date().toISOString(),
          message: ko ? "지금은 Hub 경험칩 목록을 불러오지 못했습니다." : "Experience Chips are temporarily unavailable.",
        });
      })
      .finally(() => {
        if (!cancelled) setExperienceCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [hubView, ko, experienceCatalogRevision]);

  useEffect(
    () => onHubBookmarkChange((change) => {
      bookmarkStateGenerationRef.current += 1;
      if (change.action === "synced") {
        setBookmarkedIdentities(new Set(change.bookmarks.map(hubBookmarkIdentityKey)));
      } else if (change.action === "added") {
        setBookmarkedIdentities((previous) => new Set(previous).add(hubBookmarkIdentityKey(change.bookmark)));
      } else {
        setBookmarkedIdentities((previous) => {
          const next = new Set(previous);
          if (change.entityKind) {
            next.delete(hubBookmarkIdentityKeyFromParts(change.slug, change.entityKind));
          } else {
            const slugSuffix = `:${change.slug.trim().toLowerCase()}`;
            for (const identity of next) {
              if (identity.endsWith(slugSuffix)) next.delete(identity);
            }
          }
          return next;
        });
      }
    }),
    [],
  );

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    marketplaceSearchAbortRef.current?.abort();
    const controller = new AbortController();
    const generation = ++marketplaceSearchGenerationRef.current;
    marketplaceSearchAbortRef.current = controller;
    const query = q.trim();
    // debounce 구간에도 이전 query의 fallback을 남겨두지 않는다.
    setHepFallback(null);
    const isCurrent = () =>
      !controller.signal.aborted && marketplaceSearchGenerationRef.current === generation;

    const timer = window.setTimeout(() => {
      void (async () => {
        let results: MarketplaceListing[] | null = null;
        try {
          const response = await api.marketplace.search(q);
          if (!isCurrent()) return;
          results = Array.isArray(response) ? response : [];
          setListings(results);
          // status는 이 검색이 Hub source 상태를 갱신한 뒤 읽되, status가 늦게 와도
          // 같은 generation일 때만 반영한다.
          const status = await api.marketplace.status();
          if (!isCurrent()) return;
          setSourceStatus(status);
        } catch {
          if (!isCurrent()) return;
          // 검색 실패 — 기존 목록은 유지하고 fallback 판정만 수행한다.
        }

        if (!isCurrent()) return;
        // hep-search 폴백: 검색어가 있는데 Hub 결과 0건이거나 검색이 던졌을 때만.
        if (!query) {
          setHepFallback(null);
          return;
        }
        // marketplace.search는 설명·역량·트리거·임베딩까지 사용한 서버 권위 검색이다.
        // 자연어 질의가 카드 문자열에 그대로 없다는 이유로 결과를 버리면 의미검색이 깨진다.
        const hasHubMatch = Array.isArray(results) && results.some(isLiveHubListing);
        if (hasHubMatch) {
          setHepFallback(null);
          return;
        }
        void runHepFallback(query, generation, controller.signal);
      })();
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (marketplaceSearchAbortRef.current === controller) {
        marketplaceSearchAbortRef.current = null;
      }
    };
  }, [q]);

  async function runHepFallback(query: string, generation: number, signal: AbortSignal) {
    const isCurrent = () =>
      !signal.aborted && marketplaceSearchGenerationRef.current === generation;
    if (!isCurrent()) return;
    const api = ipc();
    if (!api?.hephaestus?.search) {
      if (isCurrent()) setHepFallback(null);
      return;
    }
    const seq = ++hepSeqRef.current;
    setHepFallback({ query, status: "loading", items: [] });
    try {
      const res = await api.hephaestus.search({ query, limit: 8 });
      if (!isCurrent() || hepSeqRef.current !== seq) return; // 더 새 검색이 이미 시작됨
      setHepFallback({ query, status: "done", items: parseHepSearchResult(res) });
    } catch {
      if (!isCurrent() || hepSeqRef.current !== seq) return;
      setHepFallback({ query, status: "done", items: [] });
    }
  }

  async function bookmarkOne(listing: MarketplaceListing) {
    const api = ipc();
    if (!api?.marketplace?.bookmarkAdd) return;
    const listingIdentity = hubListingIdentityKey(listing);
    setBookmarking(listingIdentity);
    try {
      const bookmark = await api.marketplace.bookmarkAdd(listing);
      bookmarkStateGenerationRef.current += 1;
      setBookmarkedIdentities((prev) => new Set(prev).add(hubBookmarkIdentityKey(bookmark)));
      announceHubBookmarkChange({ action: "added", bookmark });
      setImportNotice({
        tone: "ok",
        text: ko ? "인재 풀에 저장했습니다." : "Saved to your candidate pool.",
      });
    } catch (err) {
      setImportNotice({
        tone: "error",
        text: ko ? `인재 풀에 저장하지 못했습니다. ${String(err)}` : `Could not save this candidate. ${String(err)}`,
      });
    } finally {
      setBookmarking(null);
    }
  }

  async function copyHubCall(listing: MarketplaceListing) {
    try {
      await navigator.clipboard.writeText(`/hep-call ${listing.slug}`);
      setImportNotice({
        tone: "ok",
        text: ko
          ? "채팅 호출어를 복사했습니다. 작업 공간의 채팅에 붙여넣으면 됩니다."
          : "Copied the chat call. Paste it into a Workspace conversation.",
      });
    } catch {
      setImportNotice({
        tone: "error",
        text: ko ? "채팅 호출어를 복사하지 못했습니다." : "Could not copy the chat call.",
      });
    }
  }

  const normalizedQuery = q.trim().toLowerCase();
  const hubPartial = Boolean(sourceStatus?.online && !sourceStatus.usingFallback && sourceStatus.lastError);
  const hubLive = sourceStatus ? sourceStatus.online && !sourceStatus.usingFallback && !sourceStatus.lastError : false;
  const hubAvailable = Boolean(sourceStatus?.online && !sourceStatus.usingFallback);

  const liveListings = dropInstallOnlyShadows(listings.filter(isLiveHubListing));
  // 검색 중에는 서버의 의미 순위를 그대로 보존한다. 유형/호출 수 기반 로컬 정렬은
  // 검색어가 없는 둘러보기 모드에서만 사용한다.
  const matchingListings = normalizedQuery
    ? liveListings
    : orderListingsForHub(liveListings, hubLive);

  // Agent Hub 정보구조: 에이전트·팀·플러그인은 같은 시장에서 검색하되,
  // 사용자가 필요한 고용 단위를 즉시 좁힐 수 있게 실제 엔티티 종류로 필터한다.
  const categoryCounts: Record<HubCategory, number> = {
    all: matchingListings.length,
    agent: matchingListings.filter((listing) => hubCategoryFor(listing) === "agent").length,
    team: matchingListings.filter((listing) => hubCategoryFor(listing) === "team").length,
    plugin: matchingListings.filter((listing) => hubCategoryFor(listing) === "plugin").length,
  };
  const activeListings = category === "all"
    ? matchingListings
    : matchingListings.filter((listing) => hubCategoryFor(listing) === category);
  const hubSuggestions = normalizedQuery ? matchingListings.slice(0, 6) : [];

  const activeTotal = activeListings.length;
  const totalPages = Math.max(1, Math.ceil(activeTotal / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;

  const pagedListings = activeListings.slice(pageStart, pageEnd);
  const sourceLabel = !sourceStatus
    ? ko ? "Hub 확인 중" : "Checking Hub"
    : hubLive
      ? ko ? "Hub 실시간" : "Hub live"
      : hubPartial
        ? ko ? "Hub 부분 연결" : "Hub partial"
      : ko ? "Hub 연결 안 됨" : "Hub unavailable";
  const accountLabel = signedIn
    ? ko ? "계정 로그인됨" : "Account signed in"
    : ko ? "로그인 필요" : "Signed out";

  async function openHubPage(pathname: string) {
    const api = ipc();
    if (!api?.fs?.openPath) return;
    let origin = "https://agentlas.cloud";
    try {
      if (sourceStatus?.baseUrl?.startsWith("http")) origin = new URL(sourceStatus.baseUrl).origin;
    } catch {
      // Keep the public Hub origin when a diagnostic base URL is malformed.
    }
    const result = await api.fs.openPath(`${origin}${pathname}`);
    if (!result.ok) {
      setImportNotice({
        tone: "error",
        text: result.message || (ko ? "Hub 페이지를 열지 못했습니다." : "Could not open the Hub page."),
      });
    }
  }

  return (
    <div className="rd hub-desktop-root">
      <div className="titlebar-nodrag hub-desktop-scroll">
        <div className="hub-web-frame">
          <div className="hub-web-main">
              <div className="hub-web-topbar" data-tour-id="hub.status">
              <div className="hub-web-topbar-heading">
                <div className="hub-web-topbar-title">Agent Hub</div>
                <div className="hub-web-topbar-subtitle">
                  {ko ? "프로젝트에 필요한 AI 동료·팀·플러그인을 찾고 고용하세요." : "Find and hire the AI talent, teams, and plugins your project needs."}
                </div>
              </div>
              <div className="hub-web-topbar-actions" aria-label={ko ? "허브 계정 상태" : "Hub account state"}>
                <span>{accountLabel}</span>
                <span
                  style={{
                    border: "1px solid var(--rd-hair)",
                    borderRadius: 999,
                    padding: "3px 8px",
                    color: hubAvailable ? (hubPartial ? "var(--rd-warn)" : "var(--rd-ok)") : "var(--rd-warn)",
                    background: "var(--rd-surface)",
                    fontSize: 12,
                    fontWeight: 650,
                    whiteSpace: "nowrap",
                  }}
                >
                  {sourceLabel}
                </span>
              </div>
            </div>
            <div
              role="tablist"
              aria-label={ko ? "Hub에서 찾을 것" : "What to find on Hub"}
              className="hub-view-tabs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={hubView === "agents"}
                className="hub-view-tab"
                data-active={hubView === "agents"}
                onClick={() => setHubView("agents")}
              >
                {ko ? "AI 인재·도구" : "AI talent & tools"}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={hubView === "experience"}
                className="hub-view-tab"
                data-active={hubView === "experience"}
                onClick={() => setHubView("experience")}
              >
                {ko ? "경험칩 사고팔기" : "Buy & sell Experience Chips"}
              </button>
            </div>
            <main className="rd-page hub-web-content">
              <div className="hub-page-root">
          {hubView === "experience" ? (
            <ExperienceChipHubIntro
              ko={ko}
              catalog={experienceCatalog}
              catalogLoading={experienceCatalogLoading}
              onRetry={() => {
                setExperienceCatalog(null);
                setExperienceCatalogRevision((current) => current + 1);
              }}
              onOpenChip={(detailPath) => void openHubPage(detailPath)}
              onBrowse={() => void openHubPage("/marketplace?category=ontology")}
              onSell={() => void openHubPage("/experience")}
              onManage={() => router.push("/library/agents?tab=ontology")}
            />
          ) : (
          <>
          <div
            className="card portal-search-panel rd-card-cream"
            data-tour-id="hub.search"
            style={{ position: "relative" }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchFocused(false);
            }}
          >
              <input
                className="portal-input"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
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
                  if (hubSuggestions.length === 0) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    setSearchActiveIndex((index) => (index + delta + hubSuggestions.length) % hubSuggestions.length);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = hubSuggestions[searchActiveIndex] ?? hubSuggestions[0];
                    setQ(selected.slug);
                    setSearchFocused(false);
                  }
                }}
                placeholder={ko ? "할 일을 설명하거나 에이전트·팀·플러그인 검색..." : "Describe the job or search agents, teams, and plugins..."}
                aria-label={ko ? "Agent Hub 검색" : "Search Agent Hub"}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={searchFocused && normalizedQuery.length > 0}
                aria-controls="desktop-hub-search-suggestions"
                aria-activedescendant={searchFocused && hubSuggestions.length > 0 ? `desktop-hub-option-${searchActiveIndex}` : undefined}
              />
            {searchFocused && normalizedQuery.length > 0 && (
              <div
                id="desktop-hub-search-suggestions"
                role="listbox"
                aria-label={ko ? "Hub 자동완성" : "Hub suggestions"}
                style={{
                  position: "absolute",
                  top: "calc(100% - 8px)",
                  left: 16,
                  right: 16,
                  zIndex: 40,
                  maxHeight: 320,
                  overflowY: "auto",
                  padding: 6,
                  borderRadius: 12,
                  background: "var(--rd-surface)",
                  border: "1px solid var(--rd-hair)",
                  boxShadow: "0 18px 46px rgba(11,11,15,0.16)",
                }}
              >
                {hubSuggestions.length === 0 ? (
                  <div style={{ padding: "10px 9px", fontSize: 12, color: "var(--rd-ink-3)" }}>
                    {ko ? "입력 중 자동으로 찾고 있습니다. 일치 항목이 없으면 아래 Hephaestus 후보를 확인하세요." : "Searching as you type. If nothing matches, check the Hephaestus suggestions below."}
                  </div>
                ) : (
                  hubSuggestions.map((listing, index) => {
                    const loc = pickLocalized(listing, locale);
                    const entityClass = classifyHubEntity(listing);
                    return (
                      <button
                        id={`desktop-hub-option-${index}`}
                        key={`${entityClass}-${listing.slug}`}
                        type="button"
                        role="option"
                        aria-selected={index === searchActiveIndex}
                        onMouseEnter={() => setSearchActiveIndex(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setQ(listing.slug);
                          setSearchFocused(false);
                        }}
                        style={{
                          width: "100%",
                          display: "grid",
                          gridTemplateColumns: "minmax(0,1fr) auto",
                          alignItems: "center",
                          gap: 10,
                          padding: "9px 10px",
                          borderRadius: 8,
                          background: index === searchActiveIndex ? "var(--rd-surface-2)" : "transparent",
                          color: "var(--rd-ink)",
                          textAlign: "left",
                        }}
                      >
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>
                            {loc.name}
                          </strong>
                          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--rd-ink-3)", marginTop: 2 }}>
                            {loc.tagline || listing.slug}
                          </span>
                        </span>
                        <span className="chip dashed" style={{ fontSize: 9.5 }}>
                          {entityClassLabel(entityClass, locale)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
            {sourceStatus && (
              <div className="hub-status-line" style={{ marginTop: 10 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: hubAvailable && !hubPartial ? "var(--rd-ok)" : "var(--rd-warn)",
                    flexShrink: 0,
                  }}
                />
                <span>
                  {hubAvailable
                    ? hubPartial
                      ? ko ? "Hub 일부만 연결됨 · 표시 가능한 Hub 항목만 보여줍니다" : "Hub partially connected · showing available Hub items"
                      : ko ? "허브 실시간 연결됨" : "Hub live source"
                    : ko ? "Hub 연결 안 됨 · 표시할 Hub 항목 없음" : "Hub unavailable · no Hub items shown"}
                </span>
                {sourceStatus.lastError && (
                  <span style={{ color: "var(--rd-accent-2-text)", overflowWrap: "anywhere" }}>
                    {sourceStatus.lastError}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="hub-market-toolbar" aria-label={ko ? "마켓 필터" : "Market filters"}>
            <div className="hub-market-filters" role="group" aria-label={ko ? "인재·도구 유형" : "Talent and tool type"}>
              {([
                ["all", ko ? "전체" : "All"],
                ["agent", ko ? "에이전트" : "Agents"],
                ["team", ko ? "팀" : "Teams"],
                ["plugin", ko ? "플러그인" : "Plugins"],
              ] as Array<[HubCategory, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="hub-market-filter"
                  data-active={category === value}
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                >
                  <span>{label}</span>
                  <span className="hub-market-filter-count">{categoryCounts[value]}</span>
                </button>
              ))}
            </div>
            <span className="hub-market-result-count">
              {ko ? `${activeListings.length}개 후보` : `${activeListings.length} candidates`}
            </span>
          </div>

          {sourceStatus && !hubAvailable && (
            <div className="hub-signin-notice" role="status" style={{ borderColor: "var(--rd-warn)", background: "color-mix(in oklch, var(--rd-warn) 10%, var(--rd-surface))" }}>
              <span>
                <strong style={{ color: "var(--rd-ink)", fontWeight: 650 }}>
                  {ko ? "실제 Hub에 연결되지 않았습니다." : "Live Hub is not connected."}
                </strong>
                <span style={{ marginLeft: 8 }}>
                  {ko
                    ? "Hub 연결이 복구되면 공개 Hub 에이전트만 다시 표시됩니다."
                    : "When the live Hub connection recovers, only public Hub items will appear."}
                </span>
                {sourceStatus.baseUrl && (
                  <span style={{ display: "block", marginTop: 4, color: "var(--rd-ink-3)", overflowWrap: "anywhere" }}>
                    {sourceStatus.baseUrl}
                  </span>
                )}
              </span>
            </div>
          )}

          {importNotice && (
            <div className="hub-import-notice" data-tone={importNotice.tone} role="status">
              <span>{importNotice.text}</span>
            </div>
          )}

          {signedIn === false && (
            <div className="hub-signin-notice" role="status">
              <span>
                <strong style={{ color: "var(--rd-ink)", fontWeight: 600 }}>{t("account.required.title")}</strong>
                <span style={{ marginLeft: 8 }}>{t("account.required.body")}</span>
              </span>
              <button type="button" className="btn sm" onClick={() => void ensureSignedIn()}>
                {t("account.sign_in")}
              </button>
            </div>
          )}

            <section className="portal-panel hub-results-panel" id="hub-agent" data-tour-id="hub.results">
              {pagedListings.length > 0 ? (
                <div className="market-card-grid">
                  {pagedListings.map((listing) => (
                    <AgentCard
                      key={hubListingIdentityKey(listing)}
                      listing={listing}
                      locale={locale}
                      sameSlugInstalled={installedAgentSlugs.has(listing.slug)}
                      bookmarked={bookmarkedIdentities.has(hubListingIdentityKey(listing))}
                      bookmarking={bookmarking === hubListingIdentityKey(listing)}
                      onBookmark={() => void bookmarkOne(listing)}
                      onCopyCall={() => void copyHubCall(listing)}
                    />
                  ))}
                </div>
              ) : (
                <div className="card portal-empty-panel" style={{ padding: 18 }}>
                  <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 20, fontWeight: 400 }}>
                    {!sourceStatus
                      ? ko ? "Hub 불러오는 중…" : "Loading the Hub…"
                      : ko ? "표시할 Hub 항목이 없습니다" : "No Hub items to show"}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--rd-ink-3)", lineHeight: 1.55, marginTop: 6 }}>
                    {!sourceStatus
                      ? ko ? "Hub 연결을 확인하는 중입니다…" : "Checking the Hub connection…"
                      : hubLive
                        ? ko ? "검색 조건에 맞는 Hub 항목이 없습니다." : "No Hub items match this search."
                        : ko ? "Hub 연결이 복구되기 전에는 표시할 항목이 없습니다." : "No items are shown while Hub is unavailable."}
                  </div>
                </div>
              )}
            </section>

          {/* hep-search 폴백 — Hub 검색 0건일 때만 엔진 후보를 단순 리스트로 보조 표기 */}
          {normalizedQuery.length > 0 && activeListings.length === 0 && hepFallback && hepFallback.query === q.trim() && (
            <section className="portal-panel" aria-label={ko ? "Hephaestus 보조 검색 결과" : "Hephaestus fallback results"}>
              <div className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <RdTag dashed size="s">{ko ? "Hephaestus 검색" : "Hephaestus search"}</RdTag>
                  <span style={{ fontSize: 12, color: "var(--rd-ink-3)" }}>
                    {hepFallback.status === "loading"
                      ? ko ? "Hub 검색 0건 · 엔진에서 후보를 찾는 중…" : "No Hub hits · searching the engine…"
                      : ko ? "Hub 검색 0건 · 엔진(hep-search) 후보" : "No Hub results · engine (hep-search) candidates"}
                  </span>
                </div>
                {hepFallback.status === "done" && hepFallback.items.length === 0 && (
                  <div style={{ fontSize: 12.5, color: "var(--rd-ink-3)" }}>
                    {ko ? "엔진 검색에서도 후보를 찾지 못했습니다." : "The engine search found no candidates either."}
                  </div>
                )}
                {hepFallback.items.map((item) => (
                  <div
                    key={item.slug}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--rd-hair)",
                      background: "var(--rd-surface-2)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontSize: 13, fontWeight: 650, color: "var(--rd-ink)" }}>{item.name}</div>
                      {item.description && (
                        <div style={{ fontSize: 12, color: "var(--rd-ink-3)", lineHeight: 1.45 }}>{item.description}</div>
                      )}
                    </div>
                    <RdTag dashed size="s">{item.scope}</RdTag>
                    <RdTag className="hub-command-chip" dashed size="s">{`/hep-call ${item.slug}`}</RdTag>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void navigator.clipboard.writeText(`/hep-call ${item.slug}`)}
                    >
                      {ko ? "명령 복사" : "Copy command"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {totalPages > 1 && (
            <nav className="hub-pager" aria-label={ko ? "페이지" : "Pagination"}>
              <button type="button" className="hub-pager-btn" disabled={safePage <= 1} onClick={() => setPage(Math.max(1, safePage - 1))}>{ko ? "이전" : "Prev"}</button>
              <span className="hub-pager-status">
                {ko ? `${safePage} / ${totalPages} 페이지` : `Page ${safePage} of ${totalPages}`}
                <span className="hub-pager-total">{ko ? ` · 총 ${activeTotal}개` : ` · ${activeTotal} total`}</span>
              </span>
              <button type="button" className="hub-pager-btn" disabled={safePage >= totalPages} onClick={() => setPage(Math.min(totalPages, safePage + 1))}>{ko ? "다음" : "Next"}</button>
            </nav>
          )}
          </>
          )}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExperienceChipHubIntro({
  ko,
  catalog,
  catalogLoading,
  onRetry,
  onOpenChip,
  onBrowse,
  onSell,
  onManage,
}: {
  ko: boolean;
  catalog: ExperienceHubCatalogResult | null;
  catalogLoading: boolean;
  onRetry: () => void;
  onOpenChip: (detailPath: string) => void;
  onBrowse: () => void;
  onSell: () => void;
  onManage: () => void;
}) {
  const benefits = ko
    ? [
        ["막혔던 일을 더 빨리 해결", "실제로 해결했던 순서와 확인 방법을 다음 작업에 다시 씁니다."],
        ["결과물의 취향을 일정하게 유지", "내가 고른 문체·구성·디자인 방향을 새 작업에도 이어갑니다."],
        ["구매 전에 효과와 가격 확인", "어떤 업무에서 무엇이 좋아지는지, 얼마인지 먼저 보고 결정합니다."],
      ]
    : [
        ["Solve familiar blockers faster", "Reuse steps and checks that already worked in real tasks."],
        ["Keep output style consistent", "Carry your preferred tone, structure, and visual direction into new work."],
        ["See the value and price first", "Review what improves, where it helps, and what it costs before buying."],
      ];
  return (
    <section data-testid="experience-chip-hub-entry" style={{ display: "grid", gap: 16 }}>
      <div className="card rd-card-cream" style={{ padding: 22, display: "grid", gap: 10 }}>
        <div className="portal-eyebrow">EXPERIENCE CHIP</div>
        <h1 style={{ margin: 0, fontFamily: "var(--rd-f-display)", fontSize: 30, fontWeight: 500 }}>
          {ko ? "에이전트에게, 이미 잘된 방법을 더하세요" : "Give your agent a method that already worked"}
        </h1>
        <p style={{ margin: 0, maxWidth: 760, color: "var(--rd-ink-2)", fontSize: 14, lineHeight: 1.65 }}>
          {ko
            ? "경험칩은 새로운 에이전트가 아닙니다. 내가 쓰는 에이전트에 문제 해결법이나 취향을 더해, 비슷한 일을 더 빠르고 일관되게 하도록 돕습니다."
            : "An Experience Chip is not another agent. It adds a proven method or preference to an agent you already use, helping it handle similar work faster and more consistently."}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
        {benefits.map(([title, body]) => (
          <article key={title} className="card" style={{ padding: 16, display: "grid", gap: 7 }}>
            <strong style={{ color: "var(--rd-ink)", fontSize: 14 }}>{title}</strong>
            <span style={{ color: "var(--rd-ink-3)", fontSize: 12.5, lineHeight: 1.55 }}>{body}</span>
          </article>
        ))}
      </div>

      <div className="card" data-testid="experience-hub-catalog" style={{ padding: 18, display: "grid", gap: 12 }}>
        <div>
          <strong style={{ display: "block", fontSize: 15 }}>{ko ? "Hub에서 판매 중인 경험칩" : "Experience Chips on Hub"}</strong>
          <span style={{ display: "block", marginTop: 4, color: "var(--rd-ink-3)", fontSize: 12.5 }}>
            {ko ? "효과와 가격을 먼저 보고, 필요한 칩만 고르세요." : "Compare the benefit and price before choosing a chip."}
          </span>
        </div>
        {catalogLoading || !catalog ? (
          <div role="status" style={{ padding: 14, borderRadius: 10, background: "var(--rd-surface-2)", color: "var(--rd-ink-3)", fontSize: 12.5 }}>
            {ko ? "판매 중인 경험칩을 확인하는 중…" : "Checking available Experience Chips…"}
          </div>
        ) : catalog.status === "unavailable" ? (
          <div role="status" style={{ padding: 14, borderRadius: 10, background: "var(--rd-surface-2)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <span style={{ color: "var(--rd-ink-3)", fontSize: 12.5 }}>{catalog.message || (ko ? "목록을 불러오지 못했습니다." : "The catalog is unavailable.")}</span>
            <button type="button" className="btn sm" onClick={onRetry}>{ko ? "다시 확인" : "Retry"}</button>
          </div>
        ) : catalog.status === "empty" ? (
          <div role="status" style={{ padding: 14, borderRadius: 10, background: "var(--rd-surface-2)", color: "var(--rd-ink-3)", fontSize: 12.5, lineHeight: 1.55 }}>
            {ko ? "현재 공개 판매 중인 경험칩이 없습니다. 비공개로 저장 중인 경험은 여기에 나타나지 않습니다." : "No Experience Chips are publicly on sale right now. Private drafts never appear here."}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
            {catalog.chips.slice(0, 6).map((chip) => (
              <article key={chip.detailPath} className="card" style={{ padding: 14, display: "grid", gap: 8 }}>
                <div>
                  <strong style={{ display: "block", fontSize: 14 }}>{chip.title}</strong>
                  <span style={{ display: "block", marginTop: 3, color: "var(--rd-ink-3)", fontSize: 11.5 }}>{ko ? `${chip.author}의 경험` : `Experience by ${chip.author}`}</span>
                </div>
                <span style={{ color: "var(--rd-ink-2)", fontSize: 12.5, lineHeight: 1.5 }}>{chip.benefits[0] || chip.summary}</span>
                {chip.workLabels.length > 0 ? (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {chip.workLabels.map((label) => <RdTag key={label} dashed size="s">{label}</RdTag>)}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {chip.offers.length > 0 ? chip.offers.map((offer) => (
                    <RdTag key={`${offer.mode}:${offer.durationDays ?? "forever"}:${offer.credits}`} bg={C.green} size="s">
                      {offer.mode === "purchase"
                        ? (ko ? `계속 사용 · ${offer.credits.toLocaleString()} 크레딧` : `Keep · ${offer.credits.toLocaleString()} credits`)
                        : (ko ? `${offer.durationDays}일 · ${offer.credits.toLocaleString()} 크레딧` : `${offer.durationDays} days · ${offer.credits.toLocaleString()} credits`)}
                    </RdTag>
                  )) : <RdTag dashed size="s">{ko ? "현재 판매 중 아님" : "Not currently for sale"}</RdTag>}
                </div>
                <button type="button" className="btn sm primary" onClick={() => onOpenChip(chip.detailPath)}>
                  {ko ? "좋아지는 점과 가격 보기" : "See benefits and price"}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="card" data-testid="experience-purchase-flow" style={{ padding: 18, display: "grid", gap: 14 }}>
        <div>
          <strong style={{ display: "block", fontSize: 15 }}>
            {ko ? "구매 후, 적용할 에이전트를 고릅니다" : "After buying, choose the agent that should use it"}
          </strong>
          <span style={{ display: "block", marginTop: 5, color: "var(--rd-ink-3)", fontSize: 12.5, lineHeight: 1.55 }}>
            {ko
              ? "결제만으로 자동 장착되지는 않습니다. Desktop의 내 에이전트에서 직접 확인한 뒤 새 대화부터 적용합니다."
              : "Payment never attaches a chip automatically. Confirm it in My Agents on Desktop, then apply it to new conversations."}
          </span>
        </div>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8 }}>
          {(
            ko
              ? [["1", "Hub에서 가격 선택", "7일·30일·90일·영구 사용 중 선택"], ["2", "내 에이전트에서 장착", "내 에이전트 › 온톨로지 칩 › 새 대화부터 적용"], ["3", "새 대화 시작", "지금 대화는 그대로 두고 다음 대화부터 사용"]]
              : [["1", "Choose a price on Hub", "Pick 7, 30, 90 days, or keep it"], ["2", "Attach in My Agents", "My Agents › Ontology Chips › Apply to new conversations"], ["3", "Start a new conversation", "The current chat stays unchanged"]]
          ).map(([number, title, body]) => (
            <li key={number} style={{ padding: 12, border: "1px solid var(--rd-hair)", borderRadius: 10, background: "var(--rd-surface-2)", display: "grid", gridTemplateColumns: "24px 1fr", columnGap: 8, alignItems: "start" }}>
              <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 999, background: "var(--rd-ink)", color: "var(--rd-surface)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800 }}>{number}</span>
              <span>
                <strong style={{ display: "block", color: "var(--rd-ink)", fontSize: 12.5 }}>{title}</strong>
                <span style={{ display: "block", marginTop: 3, color: "var(--rd-ink-3)", fontSize: 11.5, lineHeight: 1.45 }}>{body}</span>
              </span>
            </li>
          ))}
        </ol>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn sm primary" onClick={onBrowse}>
            {ko ? "경험칩과 가격 보기" : "Browse chips and prices"}
          </button>
          <button type="button" className="btn sm" onClick={onSell}>
            {ko ? "내 경험칩 소개·가격 정하기" : "Describe and price my chip"}
          </button>
          <button type="button" className="btn sm" onClick={onManage}>
            {ko ? "구매한 칩 장착하기" : "Attach a purchased chip"}
          </button>
        </div>
        <small style={{ color: "var(--rd-ink-3)", lineHeight: 1.5 }}>
          {ko
            ? "로그인과 결제 확인은 안전한 Hub 브라우저 화면에서 진행합니다. 판매도 ‘내 경험칩 소개·가격 정하기’에서 시작합니다."
            : "Sign-in and payment confirmation happen in the secure Hub browser page. Selling starts with ‘Describe and price my chip’."}
        </small>
      </div>
    </section>
  );
}

function RdTag({
  dashed,
  bg,
  size,
  className,
  style,
  title,
  children,
}: {
  dashed?: boolean;
  bg?: string;
  size?: "s" | "m";
  className?: string;
  style?: CSSProperties;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={["chip", dashed ? "dashed" : "", className || ""].filter(Boolean).join(" ")}
      title={title}
      style={{
        background: bg,
        fontSize: size === "s" ? 10.5 : undefined,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function AgentCard({
  listing,
  locale,
  sameSlugInstalled,
  bookmarked,
  bookmarking,
  onBookmark,
  onCopyCall,
}: {
  listing: MarketplaceListing;
  locale: Locale;
  sameSlugInstalled: boolean;
  bookmarked: boolean;
  bookmarking: boolean;
  onBookmark: () => void;
  onCopyCall: () => void;
}) {
  const loc = pickLocalized(listing, locale);
  const ko = locale === "ko";
  const entityKind = classifyHubEntity(listing);
  const plugin = entityKind === "plugin";
  const callable = !plugin && isCallableHubListing(listing);
  const perCallCredits = typeof listing.perCallCredits === "number" && Number.isFinite(listing.perCallCredits)
    ? listing.perCallCredits
    : entityKind === "multi" ? TEAM_CALL_CREDITS : plugin ? 0 : AGENT_CALL_CREDITS;
  const author = listing.ownerName ? (ko ? `${listing.ownerName} 제공` : `by ${listing.ownerName}`) : "Agentlas Hub";
  const command = plugin
    ? (listing.installCli || `npx agentlas@latest plugin add ${listing.slug}`)
    : callable
      ? `/hep-call ${listing.slug}`
      : listing.installCli || null;
  const cardLabel = entityClassLabel(entityKind, locale);
  const verificationFacts = hubVerificationFacts(listing, locale);
  return (
    <div className="card portal-entity-card hub-entity-card" data-entity-kind={entityKind}>
      <div className="hub-card-availability" data-callable={callable ? "true" : "false"}>
        <span className="hub-card-availability-dot" aria-hidden="true" />
        <span>
          {plugin
            ? (ko ? "도구 연결 가능" : "Tool available")
            : callable
              ? (ko ? "지금 호출 가능" : "Ready to call")
              : (ko ? "설치 후 사용" : "Install to use")}
        </span>
      </div>
      <div className="hub-card-head">
        <div className="hub-card-main">
          <div className="hub-card-kicker">
            {plugin
              ? (ko ? "허브 플러그인" : "HUB PLUGIN")
              : entityKind === "multi"
                ? (ko ? "Hub · 멀티 에이전트 팀" : "Hub · multi-agent team")
                : (ko ? "Hub · 싱글 에이전트" : "Hub · single agent")}
          </div>
          <div className="portal-card-title hub-card-title">{loc.name}</div>
          <div className="hub-card-author">{author}</div>
        </div>
        <RdTag className="hub-credit-tag" bg={plugin ? C.peach : entityKind === "multi" ? C.purple : C.green}>
          {plugin
            ? (ko ? "도구" : "Tool")
            : callable
              ? (ko ? `24시간 사용 · ${perCallCredits} 크레딧` : `24-hour use · ${perCallCredits} credits`)
              : (ko ? "설치 전용" : "Install only")}
        </RdTag>
      </div>
      <div className="hub-card-copy">{loc.tagline}</div>
      <div className="portal-chip-row hub-card-meta">
        {!plugin && <SecurityGradeTag listing={listing} locale={locale} />}
        {listing.cloudPackage && (
          <RdTag dashed>{ko ? `로컬 파일 ${listing.cloudPackage.fileCount}개` : `${listing.cloudPackage.fileCount} local files`}</RdTag>
        )}
        <RdTag dashed bg={plugin ? C.peach : entityKind === "multi" ? C.purple : C.green}>{plugin ? (listing.category || cardLabel) : cardLabel}</RdTag>
        {sameSlugInstalled && !plugin ? (
          <RdTag
            dashed
            title={callable
              ? (ko ? "Hub 사용권을 보유했다는 뜻이 아니라, 이 Mac에 같은 이름으로 가져온 로컬 에이전트가 있다는 뜻입니다." : "A same-name local agent exists on this Mac; this does not prove Hub access.")
              : undefined}
          >
            {callable
              ? (ko ? "같은 이름의 로컬 에이전트 있음" : "Same-name local agent")
              : (ko ? "이 Mac에 설치됨" : "Installed on this Mac")}
          </RdTag>
        ) : null}
        {listing.totalBorrows ? <RdTag dashed>{ko ? `전체 호출 ${listing.totalBorrows}회` : `${listing.totalBorrows} total calls`}</RdTag> : null}
        {verificationFacts.map((fact) => <RdTag key={fact} dashed>{fact}</RdTag>)}
        {plugin && command ? <RdTag className="hub-command-chip" dashed>{command}</RdTag> : null}
        {!plugin && !callable ? <RdTag dashed>{ko ? "Hub 호출 불가" : "Hub call unavailable"}</RdTag> : null}
      </div>
      <div className="hub-card-actions">
        <button
          type="button"
          className={"btn sm" + (!plugin && !bookmarked ? " primary" : "")}
          onClick={plugin ? () => command && void navigator.clipboard.writeText(command) : bookmarked ? undefined : onBookmark}
          disabled={!plugin && (bookmarking || bookmarked)}
        >
          {plugin
            ? (ko ? "설치 명령 복사" : "Copy install command")
            : bookmarking
              ? (ko ? "북마크 중…" : "Saving bookmark…")
              : bookmarked
                ? (ko ? "북마크됨" : "Bookmarked")
                : (ko ? "북마크" : "Bookmark")}
        </button>
        {callable ? (
          <button
            type="button"
            className="btn sm"
            onClick={onCopyCall}
            title={ko ? "복사한 호출어를 작업 공간의 채팅에 붙여넣으세요." : "Paste the copied call into a Workspace conversation."}
          >
            {ko ? "채팅에 붙여넣기" : "Paste into chat"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SecurityGradeTag({ listing, locale }: { listing: MarketplaceListing; locale: Locale }) {
  const risky = listing.trustGrade !== "A";
  return (
    <RdTag
      dashed
      style={risky ? { color: "var(--amber-deep)", borderColor: "rgba(186,116,44,0.36)" } : undefined}
      title={hubSecurityGradeExplanation(locale)}
    >
      {hubSecurityGradeLabel(listing, locale)}
    </RdTag>
  );
}
