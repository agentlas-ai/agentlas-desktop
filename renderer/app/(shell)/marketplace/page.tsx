"use client";
import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { detailForUser } from "@/lib/invocation-failure";
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
import { installedServerMatchesPluginSlug, normalizePluginSlug } from "@shared/plugin-slug";
import { PluginLogo } from "@/components/PluginLogo";
import { EntityKindIcon } from "@/components/EntityKindIcon";
import { IconAlertTriangle } from "@/components/Icon";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import type {
  HephaestusCommandResult,
  MarketplaceListing,
  McpToolCatalogEntry,
  MarketplaceSourceStatus,
} from "@/lib/types";


const C = {
  purple: "color-mix(in oklch, var(--rd-accent) 18%, var(--rd-surface))",
  peach: "var(--rd-accent-2)",
  green: "color-mix(in oklch, var(--rd-ok) 24%, var(--rd-surface))",
  blue: "color-mix(in oklch, var(--info) 18%, var(--rd-surface))",
};

/**
 * 이 시장이 다루는 고용 단위. "plugin"은 분류 결과로만 남아 있다 — 카테고리 탭에는
 * 없고, 목록에서 제외하는 판정에만 쓰인다(도구는 환경설정 MCP·플러그인이 맡는다).
 */
type HubCategory = "all" | "agent" | "team" | "graph";
type HubEntityCategory = HubCategory | "plugin";

function isLiveHubListing(listing: MarketplaceListing): boolean {
  return listing.source === "hub-index" || listing.source === "hub-profile" || listing.source === "hub-plugin" || listing.kind === "cloud-callable" || listing.callable === true;
}

/** 이 카드가 허브가 아니라 데스크탑 내장 카탈로그에서 온 것인가. */
const DESKTOP_CATALOG_SOURCE = "desktop-catalog";

function isDesktopCatalogListing(listing: MarketplaceListing): boolean {
  return listing.source === DESKTOP_CATALOG_SOURCE;
}

/**
 * 데스크탑 내장 카탈로그 → 허브 카드가 읽을 수 있는 리스팅.
 *
 * 허브에 같은 도구가 있으면 제외한다(정규화 slug로 판정 — github ↔ github-mcp).
 * 허브 것이 로고·상세를 달고 있어 상위호환이고, 둘 다 보이면 같은 도구가 두 장이 된다.
 */
function desktopCatalogListings(
  catalog: McpToolCatalogEntry[],
  hubListings: MarketplaceListing[],
  normalizedQuery: string,
  ko: boolean,
): MarketplaceListing[] {
  if (catalog.length === 0) return [];
  const hubSlugs = new Set(
    hubListings
      .filter((listing) => hubCategoryFor(listing) === "plugin")
      .map((listing) => normalizePluginSlug(listing.slug)),
  );
  return catalog
    .filter((entry) => !hubSlugs.has(normalizePluginSlug(entry.id)))
    .filter((entry) => {
      if (!normalizedQuery) return true;
      return [entry.id, entry.name, entry.nameEn, entry.description, entry.descriptionEn, entry.category]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .map((entry) => ({
      slug: entry.id,
      name: entry.name,
      nameEn: entry.nameEn || entry.name,
      tagline: entry.description,
      taglineEn: entry.descriptionEn || entry.description,
      trustGrade: "A" as const,
      installCount: 0,
      // 허브 매니페스트가 없다 — 설치는 로컬 카탈로그 id로 직접 간다.
      manifestUrl: "",
      ownerName: ko ? "Agentlas 기본 도구" : "Agentlas built-in",
      developer: ko ? "Agentlas 기본 도구" : "Agentlas built-in",
      kind: "hub-plugin",
      callable: false,
      routingReady: true,
      source: DESKTOP_CATALOG_SOURCE,
      entityKind: "plugin",
      perCallCredits: 0,
      category: entry.category,
      ...(entry.brandColor ? { brandColor: entry.brandColor } : {}),
      ...(entry.docsUrl ? { homepage: entry.docsUrl } : {}),
    }));
}

function hubCategoryFor(listing: MarketplaceListing): HubEntityCategory {
  const entityClass = classifyHubEntity(listing);
  if (entityClass === "plugin") return "plugin";
  if (entityClass === "graph") return "graph";
  if (entityClass === "multi") return "team";
  return "agent";
}

function hubListingScore(listing: MarketplaceListing): number {
  if (!isLiveHubListing(listing)) return 0;
  const category = hubCategoryFor(listing);
  // 종류는 절대 계층이다: 첫 화면(둘러보기)은 멀티 에이전트 팀 → 싱글 에이전트 →
  // 플러그인 순으로 이끈다. 호출 실적은 같은 종류 안에서만 순서를 정한다 —
  // 인기 에이전트가 팀 구역을 추월해 첫 화면을 차지하던 가산 방식은 폐기.
  const tier = category === "team" ? 3 : category === "agent" ? 2 : 1;
  return tier * 1_000_000 + (listing.verifiedInvocations ?? listing.installCount ?? 0);
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
  const [category, setCategory] = useState<HubCategory>("all");

  const [importNotice, setImportNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installedAgentSlugs, setInstalledAgentSlugs] = useState<Set<string>>(new Set());
  const [installedMcpServers, setInstalledMcpServers] = useState<
    Array<{ catalogId?: string | null; name?: string | null; enabled?: boolean }>
  >([]);
  // Agentlas 기본 도구(파일 시스템·브라우저·컴퓨터 유즈 등)는 허브 카탈로그에 없다.
  // MCP 관리 화면의 카탈로그 탭이 여기로 합쳐졌으므로, 이걸 안 실으면 그 도구들은
  // 앱 어디에서도 연결할 수 없게 된다.
  const [desktopCatalog, setDesktopCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [bookmarkedIdentities, setBookmarkedIdentities] = useState<Set<string>>(new Set());
  const [sourceStatus, setSourceStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [bookmarking, setBookmarking] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  // Hub 검색 0건/실패 시 hep-search(엔진) 보조 후보 — 카드와 별도의 단순 리스트로 표시.
  const [hepFallback, setHepFallback] = useState<HepFallbackState | null>(null);
  // Hub 검색은 10초 이상 걸린다. 그 동안 이전 질의 결과를 그대로 두면 사용자는
  // 그것을 새 질의의 답으로 읽는다. 무엇을 기다리는 중인지 화면에 남긴다.
  const [searchingFor, setSearchingFor] = useState<string | null>(null);
  /* ★읽기 실패를 "허브가 비었다" 로 그리지 않기 위한 표식 (실측 2026-09-08). */
  const [searchFailed, setSearchFailed] = useState(false);
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

  /*
   * 허브 웹의 설치 버튼 → agentlas://plugin/<family>/<slug> → main 이 이 라우트로 보낸다
   * (?install=<slug>). 그 플러그인을 검색어로 띄우고, 카드가 승인 화면을 한 번 연다.
   * 설치 자체는 여전히 사용자가 승인 화면에서 눌러야 일어난다 — 링크는 설치가 아니다.
   */
  const deepLinkInstallSlug = (searchParams.get("install") || "").trim().toLowerCase() || null;
  useEffect(() => {
    if (deepLinkInstallSlug) setQ(deepLinkInstallSlug);
  }, [deepLinkInstallSlug]);

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
    const [ag, session, bookmarks, mcpServers, localCatalog] = await Promise.all([
      api.team.list(),
      api.auth.getSession(),
      api.marketplace.bookmarks?.().catch(() => []),
      // 플러그인 카드가 "이미 설치됨"을 말할 수 있어야 한다. 이게 없으면 Desktop 카탈로그로
      // 이미 깐 도구에도 계속 "설치"를 권한다(hub:brave-search-mcp ↔ desktop:brave-search).
      api.mcpTools.listInstalled().catch(() => []),
      api.mcpTools.listCatalog().catch(() => []),
    ]);
    setInstalledAgentSlugs(new Set(visibleAgents(ag).map((a) => a.slug)));
    setInstalledMcpServers(mcpServers ?? []);
    setDesktopCatalog(localCatalog ?? []);
    if (bookmarkStateGenerationRef.current === bookmarkGeneration) {
      setBookmarkedIdentities(new Set((bookmarks ?? []).map(hubBookmarkIdentityKey)));
    }
    setSignedIn(session.signedIn);
  }

  useEffect(() => {
    void refresh();
  }, []);

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
        if (isCurrent()) setSearchingFor(query || null);
        let results: MarketplaceListing[] | null = null;
        try {
          const response = await api.marketplace.search(q);
          if (!isCurrent()) return;
          results = Array.isArray(response) ? response : [];
          setListings(results);
          setSearchFailed(false);
          // 결과가 화면에 놓인 순간 대기 표시를 거둔다. 뒤따르는 status 조회를
          // 기다리면 이미 답이 보이는데도 계속 "찾는 중"으로 남는다.
          setSearchingFor(null);
          // status는 이 검색이 Hub source 상태를 갱신한 뒤 읽되, status가 늦게 와도
          // 같은 generation일 때만 반영한다.
          const status = await api.marketplace.status();
          if (!isCurrent()) return;
          setSourceStatus(status);
        } catch {
          if (!isCurrent()) return;
          // 검색 실패 — 기존 목록은 유지하고 fallback 판정만 수행한다.
          setSearchingFor(null);
          /*
           * ★첫 조회가 실패하면 기존 목록이 아예 없어 화면이 **빈 허브**로 보였다
           *   (읽기 실패 실측 2026-09-08: 낱말 40개가 소리 없이 사라짐).
           *   "여기에 아무것도 없다" 와 "지금 못 읽었다" 는 완전히 다른 사실이다.
           */
          setSearchFailed(true);
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
        text: ko ? `인재 풀에 저장하지 못했습니다. ${detailForUser(err)}` : `Could not save this candidate. ${detailForUser(err)}`,
      });
    } finally {
      setBookmarking(null);
    }
  }

  /* 호출어 복사는 slug 하나면 된다 — 목록 행에서도 같은 알림 경로를 쓰려고 인자를 좁힌다. */
  async function copyHubCall(slug: string) {
    try {
      await navigator.clipboard.writeText(`/hep-call ${slug}`);
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
  const hubListings = normalizedQuery
    ? liveListings
    : orderListingsForHub(liveListings, hubLive);
  // 허브에 쌍이 없는 데스크탑 전용 도구만 뒤에 덧붙인다. 허브에 같은 도구가 있으면
  // (github ↔ github-mcp) 허브 쪽이 이긴다 — 로고와 상세가 붙어 있기 때문이다.
  const desktopOnlyListings = desktopCatalogListings(
    desktopCatalog,
    liveListings,
    normalizedQuery,
    ko,
  );
  /*
   * 플러그인은 이 시장에 나오지 않는다 (2026-08-19).
   *
   * 고용(에이전트·팀·그래프)과 배관(MCP 도구)은 사용자가 서로 다른 순간에, 서로 다른
   * 이유로 찾는다. 한 격자에 섞어 두니 도구를 붙이려는 사람이 인재 시장을 헤매고,
   * 사람을 뽑으려는 사람은 도구 카드에 밀려났다. 도구는 이제 환경설정의 MCP·플러그인
   * 화면과 그 팝업 한 곳에서만 다룬다 — 두 표면이 같은 목록을 다르게 보여주던 문제도
   * 함께 사라진다.
   *
   * 걸러내는 지점이 카테고리 필터가 아니라 목록 자체인 이유: 필터에서만 빼면
   * "전체"에 그대로 섞여 나와, 탭만 없앤 채 문제를 남긴다.
   */
  const matchingListings = [...hubListings, ...desktopOnlyListings]
    .filter((listing) => hubCategoryFor(listing) !== "plugin");

  // Agent Hub 정보구조: 에이전트·팀·그래프는 같은 시장에서 검색하되,
  // 사용자가 필요한 고용 단위를 즉시 좁힐 수 있게 실제 엔티티 종류로 필터한다.
  const categoryCounts: Record<HubCategory, number> = {
    all: matchingListings.length,
    agent: matchingListings.filter((listing) => hubCategoryFor(listing) === "agent").length,
    team: matchingListings.filter((listing) => hubCategoryFor(listing) === "team").length,
    graph: matchingListings.filter((listing) => hubCategoryFor(listing) === "graph").length,
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

  return (
    <div className="rd hub-desktop-root">
      <div className="titlebar-nodrag hub-desktop-scroll">
        <div className="hub-web-frame">
          <div className="hub-web-main">
              <div className="hub-web-topbar" data-tour-id="hub.status">
              <div className="hub-web-topbar-heading">
                <div className="hub-web-topbar-title">Agent Hub</div>
                <div className="hub-web-topbar-subtitle">
                  {ko ? "프로젝트에 필요한 AI 동료·팀·플러그인을 찾아 팀에 합류시키세요." : "Find agents, teams, and plugins for your project and add them to your team."}
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
            <main className="rd-page hub-web-content">
              <div className="hub-page-root">
          {/* Experience Chips belong to each agent's Agent Space, reached from a Hub card. */}
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
            <div className="hub-market-filters" role="group" aria-label={ko ? "인재 유형" : "Talent type"}>
              {(([
                ["all", ko ? "전체" : "All"],
                ["agent", ko ? "에이전트" : "Agents"],
                ["team", ko ? "팀" : "Teams"],
                ["graph", ko ? "그래프" : "Graphs"],
              ] satisfies Array<[HubCategory, string]>)).map(([value, label]) => (
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
              {searchFailed && !searchingFor && (
                <div className="hub-searching-notice" role="alert">
                  <span>
                    {ko
                      ? "허브 목록을 불러오지 못했습니다. 비어 있는 것이 아니라 읽지 못한 것입니다 — 잠시 뒤 다시 검색해 주세요."
                      : "The Hub list could not be loaded. It is not empty — the read failed. Search again in a moment."}
                  </span>
                </div>
              )}
              {searchingFor && (
                <div className="hub-searching-notice" role="status" aria-live="polite">
                  <span className="hub-searching-spinner" aria-hidden="true" />
                  <span>
                    {ko
                      ? `‘${searchingFor}’ 검색 중… 아래는 아직 이전 검색 결과입니다.`
                      : `Searching for “${searchingFor}”… the results below are still from your previous search.`}
                  </span>
                </div>
              )}
              {pagedListings.length > 0 ? (
                <div className="market-card-grid">
                  {pagedListings.map((listing) => (
                    <AgentCard
                      key={hubListingIdentityKey(listing)}
                      listing={listing}
                      locale={locale}
                      sameSlugInstalled={installedAgentSlugs.has(listing.slug)}
                pluginServerInstalled={installedMcpServers.some((server) =>
                  installedServerMatchesPluginSlug(server, listing.slug))}
                      bookmarked={bookmarkedIdentities.has(hubListingIdentityKey(listing))}
                      bookmarking={bookmarking === hubListingIdentityKey(listing)}
                      autoOpenInstall={
                        deepLinkInstallSlug !== null
                        && (listing.slug || "").toLowerCase() === deepLinkInstallSlug
                      }
                      onBookmark={() => void bookmarkOne(listing)}
                      onCopyCall={() => void copyHubCall(listing.slug)}
                      onOpenProfile={() => router.push(
                        `/marketplace/profile?slug=${encodeURIComponent(listing.slug)}`
                        + `&name=${encodeURIComponent(pickLocalized(listing, locale).name)}`,
                      )}
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
                      /* ★눌러도 아무 말이 없던 복사 (실측 2026-09-08) — 알림을 내는 쪽으로 통일한다. */
                      onClick={() => void copyHubCall(item.slug)}
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
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
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

// 카드 아바타 타일 — 슬러그에서 결정적으로 색을 뽑아 텍스트뿐인 카드에 시각 정체성을 준다.
// 카드 문법: 이름 + 한 줄 소개 + 실적 한 줄 + 배지 + CTA(텍스트·버튼 위주,
// 의미 없는 첫글자 로고 타일은 제거).

type HubPluginPreviewRow = {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
};

// 스킬 번들 절반 — 플러그인은 MCP 서버와 별개의 능력 패키지일 수 있다(오너 결정
// 2026-08-20). 브리지가 preview/install 결과에 얹는 확장 필드로, preload 계약
// (shared/types.ts)이 프리즈된 동안 렌더러는 이 로컬 타입으로 캐스팅해 읽는다.
type HubPluginPreviewSkill = { name: string; description?: string; fileCount: number };
type HubPluginPreviewExtras = {
  skills?: HubPluginPreviewSkill[];
  skillsAlreadyInstalled?: boolean;
};
type HubPluginInstallSkillsSummary = {
  dir: string;
  installed: string[];
  failed: Array<{ name: string; reason: string }>;
  verified: boolean;
};

/** 승인 화면에 보여줄 한 줄 — 원격은 접속할 주소, 로컬은 실행될 명령 원문. */
function describeHubPluginRow(row: HubPluginPreviewRow): string {
  if (row.transport === "stdio") {
    return [row.command, ...(row.args ?? [])].filter(Boolean).join(" ");
  }
  return row.url ?? "";
}

function AgentCard({
  listing,
  locale,
  sameSlugInstalled,
  pluginServerInstalled,
  bookmarked,
  bookmarking,
  autoOpenInstall = false,
  onBookmark,
  onCopyCall,
  onOpenProfile,
}: {
  listing: MarketplaceListing;
  locale: Locale;
  sameSlugInstalled: boolean;
  /** 허브 딥링크(agentlas://plugin/…)로 지목된 카드 — 승인 화면을 한 번 자동으로 연다. */
  autoOpenInstall?: boolean;
  /** 이 플러그인의 MCP 서버가 이미 이 Mac에 등록돼 있는가(Hub/Desktop 이름 차이 무시). */
  pluginServerInstalled: boolean;
  bookmarked: boolean;
  bookmarking: boolean;
  onBookmark: () => void;
  onCopyCall: () => void;
  /** 허브의 공개 소개 페이지를 앱 안에 띄운다. 데스크탑 전용 도구에는 소개가 없다. */
  onOpenProfile: () => void;
}) {
  const loc = pickLocalized(listing, locale);
  const ko = locale === "ko";
  const entityKind = classifyHubEntity(listing);
  const plugin = entityKind === "plugin";
  // 그래프는 호출·고용 대상이 아니라 받아서 내 계정에 채워 넣는 도면이다.
  // 카드의 주 행동은 [그래프 설치] 하나 — Agentlas Graph의 설치 배선을 그대로 쓴다.
  const graph = entityKind === "graph";
  const [graphInstall, setGraphInstall] = useState<
    | { phase: "idle" }
    | { phase: "installing" }
    | { phase: "done"; message: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  // Hub 플러그인 설치 — 이전에는 설치 명령을 클립보드에 복사만 해줘서, Desktop 사용자가
  // 터미널을 따로 열지 않으면 Hub 플러그인을 쓸 수 없었다(실측: Hub 140개 중 Desktop
  // 카탈로그와 겹쳐 클릭 설치가 되던 것은 9개뿐).
  // stdio 행은 이 기계에서 그 명령을 실행한다는 뜻이라, 명령 원문을 보여주기 전에는
  // 절대 설치하지 않는다 — 무엇에 동의하는지 모르고 누른 승인은 승인이 아니다.
  const [install, setInstall] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "confirm"; rows: HubPluginPreviewRow[]; needsLocalExecution: boolean; skills: HubPluginPreviewSkill[] }
    | { phase: "installing" }
    | { phase: "done"; message: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  /*
   * 설치 미리보기 열기 — 버튼 클릭과 허브 딥링크(agentlas://plugin/…)가 **같은** 경로를
   * 쓴다. 딥링크가 별도 경로를 타면 승인 화면을 건너뛰는 설치가 생긴다.
   */
  const openPluginInstallPreview = useCallback(() => {
    setInstall((current) => {
      if (current.phase === "loading" || current.phase === "installing") return current;
      return { phase: "loading" };
    });
    void window.agentlas.mcpTools
      .previewHubPlugin(listing.manifestUrl)
      .then((preview) => {
        // 스킬 번들은 더 이상 거절 사유가 아니다 — 실콘텐츠가 실린
        // 스킬은 ~/.agentlas/plugins/<slug>/ 에 설치되는 능력 패키지다.
        const skills = (preview as typeof preview & HubPluginPreviewExtras).skills ?? [];
        if (preview.rows.length === 0 && skills.length === 0) {
          setInstall({
            phase: "error",
            message: ko
              ? "이 플러그인에는 설치할 내용이 없습니다 (연결할 서버도, 스킬 콘텐츠도 없음)."
              : "This plugin ships nothing installable (no connectable server and no skill content).",
          });
          return;
        }
        setInstall({
          phase: "confirm",
          rows: preview.rows,
          needsLocalExecution: preview.needsLocalExecution,
          skills,
        });
      })
      .catch((error: unknown) => {
        setInstall({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [listing.manifestUrl, ko]);
  /*
   * 허브 웹의 설치 버튼이 연 딥링크로 들어온 경우 — 그 플러그인의 승인 화면을 한 번 연다.
   * 여는 것까지가 전부다. 설치는 사용자가 승인 화면에서 눌러야 일어난다.
   */
  const deepLinkOpenedRef = useRef(false);
  useEffect(() => {
    if (!autoOpenInstall || !plugin || deepLinkOpenedRef.current) return;
    if (isDesktopCatalogListing(listing)) return; // 로컬 카탈로그는 미리보기가 없다.
    deepLinkOpenedRef.current = true;
    openPluginInstallPreview();
  }, [autoOpenInstall, plugin, listing, openPluginInstallPreview]);
  // 그래프는 서버가 뭐라 광고했든 호출형이 아니다 — 낡은 인덱스 스냅샷이
  // callable:true를 실어 와도 여기서 끊는다(서버 normalizeEntry와 같은 경계).
  const callable = !plugin && !graph && isCallableHubListing(listing);
  const author = listing.ownerName ? (ko ? `${listing.ownerName} 제공` : `by ${listing.ownerName}`) : "Agentlas Hub";
  // 이 플러그인을 실제로 제공하는 사이트. Hub가 아직 homepage를 못 돌려주는 낡은 응답이면
  // 최소한 Hub 자체 상세 페이지(manifestUrl)로라도 보낸다 — 링크가 아예 없는 것보다 낫다.
  const builtIn = plugin && isDesktopCatalogListing(listing);
  // 기본 도구는 manifestUrl이 비어 있다 — 빈 주소로 창을 여는 버튼을 만들지 않는다.
  const websiteUrl = plugin ? (listing.homepage || listing.manifestUrl || null) : null;
  const cardOpensSpace = entityKind === "single" || entityKind === "multi";
  const cardLabel = entityClassLabel(entityKind, locale);
  const verificationFacts = hubVerificationFacts(listing, locale);
  /*
   * ★이 줄은 **늘** 잘리고 있었다 (실측 2026-09-08: 331px 자리에 영어 642px / 한국어 453px).
   *   "넘치면 말줄임 + 툴팁" 이 설계였는데, 넘치는 게 예외가 아니라 **언제나**여서
   *   화면에서는 뒷부분(최근 성공일·실패율)을 아무도 본 적이 없다.
   *   늘 잘리는 문장은 잘림이 아니라 잘못 쓴 문장이다 — 카드에는 짧은 형태를 쓰고,
   *   전체 문장은 지금처럼 툴팁이 그대로 말한다(정보는 하나도 안 버린다).
   */
  const statFacts = [
    listing.totalBorrows
      ? (ko ? `호출 ${listing.totalBorrows}` : `${listing.totalBorrows} calls`)
      : null,
    ...hubVerificationFacts(listing, locale, { compact: true }),
    listing.cloudPackage
      ? (ko ? `파일 ${listing.cloudPackage.fileCount}` : `${listing.cloudPackage.fileCount} files`)
      : null,
  ].filter((fact): fact is string => Boolean(fact));
  const statFactsFull = [
    listing.totalBorrows
      ? (ko ? `전체 호출 ${listing.totalBorrows}회` : `${listing.totalBorrows} total calls`)
      : null,
    ...verificationFacts,
    listing.cloudPackage
      ? (ko ? `로컬 파일 ${listing.cloudPackage.fileCount}개` : `${listing.cloudPackage.fileCount} local files`)
      : null,
  ].filter((fact): fact is string => Boolean(fact));
  return (
    <div
      className="card portal-entity-card hub-entity-card"
      data-entity-kind={entityKind}
      data-opens-space={cardOpensSpace ? "true" : undefined}
      role={cardOpensSpace ? "link" : undefined}
      tabIndex={cardOpensSpace ? 0 : undefined}
      aria-label={cardOpensSpace
        ? (ko ? `${loc.name} 에이전트 스페이스 열기` : `Open ${loc.name} Agent Space`)
        : undefined}
      onClick={(event) => {
        if (!cardOpensSpace) return;
        // Action buttons keep their own behavior; only the card's passive area opens Agent Space.
        const interactive = event.target instanceof Element
          ? event.target.closest("button, a, input, select, textarea, [role='button'], [role='link']")
          : null;
        if (interactive && interactive !== event.currentTarget) return;
        onOpenProfile();
      }}
      onKeyDown={(event) => {
        if (!cardOpensSpace || event.target !== event.currentTarget || event.key !== "Enter") return;
        event.preventDefault();
        onOpenProfile();
      }}
    >
      <EntityKindIcon kind={entityKind} locale={locale} className="hub-card-kind-icon" />
      <div className="hub-card-availability" data-callable={callable ? "true" : "false"}>
        <span className="hub-card-availability-dot" aria-hidden="true" />
        <span>
          {builtIn
            ? (ko ? "Agentlas 기본 도구" : "Agentlas built-in tool")
            : plugin
            ? (ko ? "도구 연결 가능" : "Tool available")
            : graph
              ? (ko ? "받아서 내 자동화로" : "Install as my automation")
              : callable
                ? (ko ? "공개 에이전트" : "Public agent")
                : (ko ? "설치 후 사용" : "Install to use")}
        </span>
      </div>
      {/* data-with-logo가 있어야 머리 영역이 2열에서 3열로 늘어난다 — 없으면 로고가
          제목 자리를 밀어내고 카테고리 태그가 다음 줄로 떨어진다. */}
      <div className="hub-card-head" data-with-logo={plugin ? "true" : undefined}>
        {/* 로고는 웹 카탈로그가 정본 — 데스크탑은 slug만 넘기고 main이 캐시해 준다.
            에이전트·팀에는 브랜드 자산이 없으므로 플러그인에만 붙는다. */}
        {plugin ? (
          <PluginLogo
            slug={listing.slug}
            name={loc.name}
            size={38}
            brandColor={listing.brandColor}
          />
        ) : null}
        <div className="hub-card-main">
          <div className="hub-card-kicker">
            {builtIn
              ? (ko ? "Agentlas · 내장 도구" : "AGENTLAS · BUILT-IN")
              : plugin
              ? (ko ? "허브 플러그인" : "HUB PLUGIN")
              : "Agentlas Hub"}
          </div>
          {/* 데스크탑 내장 도구는 허브에 공개 소개 페이지가 없다 — 눌러도 404가
              되는 제목을 링크처럼 보이게 두지 않는다. */}
          {builtIn ? (
            <div className="portal-card-title hub-card-title">{loc.name}</div>
          ) : (
            <button
              type="button"
              className="portal-card-title hub-card-title hub-card-title-link"
              onClick={onOpenProfile}
              title={ko ? "소개 페이지 열기" : "Open the profile page"}
            >
              {loc.name}
            </button>
          )}
          <div className="hub-card-author">{author}</div>
        </div>
        {/* Hub listing categories are shown without the retired credit price. */}
        {callable && !plugin ? null : plugin ? (
          <RdTag className="hub-credit-tag" bg={C.blue}>
            {listing.category || cardLabel}
          </RdTag>
        ) : (
          <RdTag className="hub-credit-tag" bg={C.purple}>
            {ko ? "설치 전용" : "Install only"}
          </RdTag>
        )}
      </div>
      <div className="hub-card-copy">{loc.tagline}</div>
      {statFacts.length > 0 && (
        // 실적은 칩 무더기 대신 이력서식 한 줄 요약 — 카드 높이를 흔들지 않고,
        // 넘치면 말줄임 + 툴팁으로 전체를 보여준다.
        <div className="hub-card-stats" title={statFactsFull.join(" · ")}>
          {statFacts.join(" · ")}
        </div>
      )}
      {/* 플러그인 카드는 카테고리 태그가 위(hub-card-head)로 옮겨갔고, 이 줄의 나머지
          배지(보안 등급·설치 상태·호출 가능 여부)는 전부 에이전트/팀 전용이라
          플러그인일 땐 이 줄 자체가 빈 채로 남는다 — 통째로 건너뛴다. */}
      {!plugin && (
        <div className="portal-chip-row hub-card-meta">
          <SecurityBlockedTag listing={listing} locale={locale} />
          {sameSlugInstalled ? (
            <RdTag
              dashed
              title={callable
                ? (ko ? "이 Mac에 같은 이름의 로컬 에이전트가 있다는 뜻이며, 공개 Hub 에이전트의 호출 가능 여부와는 별개입니다." : "A same-name local agent exists on this Mac; its presence does not determine whether the public Hub agent can be called.")
                : undefined}
            >
              {callable
                ? (ko ? "같은 이름의 로컬 에이전트 있음" : "Same-name local agent")
                : (ko ? "이 Mac에 설치됨" : "Installed on this Mac")}
            </RdTag>
          ) : null}
          {/* "호출 불가"는 결함 배지다 — 애초에 호출이 없는 그래프에 붙이면
              멀쩡한 도면이 고장난 에이전트처럼 읽힌다. */}
          {!callable && !graph ? <RdTag dashed>{ko ? "Hub 호출 불가" : "Hub call unavailable"}</RdTag> : null}
        </div>
      )}
      {plugin && install.phase === "confirm" ? (
        <div className="hub-plugin-approval">
          <div className="hub-plugin-approval-title">
            {install.needsLocalExecution
              ? (ko ? "이 명령이 이 Mac에서 실행됩니다" : "This command will run on this Mac")
              : install.rows.length > 0
                ? (ko ? "이 주소에 연결합니다" : "This endpoint will be connected")
                : (ko ? "이 스킬들이 이 Mac에 설치됩니다" : "These skills will be installed on this Mac")}
          </div>
          {install.rows.map((row) => (
            <div key={row.name} className="hub-plugin-approval-row">
              <code>{describeHubPluginRow(row)}</code>
              {row.envKeys && row.envKeys.length > 0 ? (
                <div className="hub-plugin-approval-note">
                  {ko
                    ? `설치 후 키 입력 필요: ${row.envKeys.join(", ")}`
                    : `Keys required after install: ${row.envKeys.join(", ")}`}
                </div>
              ) : null}
            </div>
          ))}
          {install.skills.length > 0 ? (
            <>
              {install.skills.map((skill) => (
                <div key={`skill:${skill.name}`} className="hub-plugin-approval-row">
                  <code>
                    {ko
                      ? `스킬 ${skill.name} (파일 ${skill.fileCount}개)`
                      : `skill ${skill.name} (${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"})`}
                  </code>
                  {skill.description ? (
                    <div className="hub-plugin-approval-note">{skill.description}</div>
                  ) : null}
                </div>
              ))}
              <div className="hub-plugin-approval-note">
                {ko
                  ? "스킬 파일은 ~/.agentlas/plugins/ 아래에 설치되어 데스크탑·터미널·OS 런타임이 함께 사용합니다."
                  : "Skill files land under ~/.agentlas/plugins/ and are shared by the desktop, terminal, and OS runtimes."}
              </div>
            </>
          ) : null}
          <div className="hub-card-actions">
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                setInstall({ phase: "installing" });
                void window.agentlas.mcpTools
                  .installHubPlugin({
                    slug: listing.slug,
                    manifestUrl: listing.manifestUrl,
                    approveLocalExecution: true,
                  })
                  .then((result) => {
                    const connected = result.receipts.filter((r) => r.action === "connected").length;
                    const already = result.receipts.filter((r) => r.action === "already-installed").length;
                    const failed = result.receipts.filter((r) => r.action === "skipped");
                    const skillSummary = (result as typeof result & { skills?: HubPluginInstallSkillsSummary }).skills;
                    const skillsInstalled = skillSummary?.installed.length ?? 0;
                    if (connected === 0 && already === 0 && skillsInstalled === 0) {
                      setInstall({
                        phase: "error",
                        message: failed[0]?.reason
                          ?? (ko ? "설치할 내용을 찾지 못했습니다." : "Nothing installable was found."),
                      });
                      return;
                    }
                    // 스킬만 설치된 경우와 서버 연결이 섞인 경우를 구분해 말한다 —
                    // "연결됨"은 서버가 붙었을 때만 정직한 문장이다.
                    const serverPart = connected - (skillsInstalled > 0 ? 1 : 0) > 0 || already > 0;
                    setInstall({
                      phase: "done",
                      message: skillsInstalled > 0 && !serverPart
                        ? (ko
                          ? `스킬 ${skillsInstalled}개 설치됨 — 모든 채널(데스크탑·터미널·OS)에서 바로 쓸 수 있습니다.`
                          : `${skillsInstalled} skill${skillsInstalled === 1 ? "" : "s"} installed — available to every channel (desktop, terminal, OS).`)
                        : ko
                          ? `연결됨 — 다음 대화부터 바로 쓸 수 있습니다${already ? " (이미 설치된 항목 포함)" : ""}${skillsInstalled ? ` (스킬 ${skillsInstalled}개 포함)` : ""}.`
                          : `Connected — usable from your next conversation${already ? " (some were already installed)" : ""}${skillsInstalled ? ` (plus ${skillsInstalled} skill${skillsInstalled === 1 ? "" : "s"})` : ""}.`,
                    });
                  })
                  .catch((error: unknown) => {
                    setInstall({
                      phase: "error",
                      message: error instanceof Error ? error.message : String(error),
                    });
                  });
              }}
            >
              {install.needsLocalExecution
                ? (ko ? "승인하고 설치" : "Approve and install")
                : (ko ? "연결" : "Connect")}
            </button>
            <button type="button" className="btn sm" onClick={() => setInstall({ phase: "idle" })}>
              {ko ? "취소" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
      {plugin && (install.phase === "done" || install.phase === "error") ? (
        <div
          className="hub-plugin-approval-note"
          data-tone={install.phase === "error" ? "error" : "ok"}
        >
          {install.message}
        </div>
      ) : null}
      {graph && (graphInstall.phase === "done" || graphInstall.phase === "error") ? (
        <div
          className="hub-plugin-approval-note"
          data-tone={graphInstall.phase === "error" ? "error" : "ok"}
        >
          {graphInstall.message}
        </div>
      ) : null}
      <div className="hub-card-actions">
        {graph ? (
          <button
            type="button"
            className={"btn sm hub-card-action-btn" + (graphInstall.phase === "idle" || graphInstall.phase === "error" ? " primary" : "")}
            disabled={graphInstall.phase === "installing" || graphInstall.phase === "done"}
            onClick={() => {
              if (graphInstall.phase === "installing" || graphInstall.phase === "done") return;
              setGraphInstall({ phase: "installing" });
              void window.agentlas.automations
                .installGraphFromHub(listing.slug)
                .then((res) => {
                  // 받아온 것은 꺼진 채로 들어온다 — 말해 주지 않으면 안 도는 이유를 모른다.
                  if (!res.ok) { setGraphInstall({ phase: "error", message: res.reason }); return; }
                  setGraphInstall({
                    phase: "done",
                    message: ko
                      ? `"${res.name}"을(를) 받았습니다. Agentlas Graph에 꺼진 상태로 들어왔으니 살펴본 뒤 켜 주세요.`
                      : `Installed "${res.name}". It arrived switched off in Agentlas Graph — look it over, then turn it on.`,
                  });
                })
                .catch((error: unknown) => {
                  setGraphInstall({
                    phase: "error",
                    message: error instanceof Error
                      ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
                      : String(error),
                  });
                });
            }}
          >
            {graphInstall.phase === "installing"
              ? (ko ? "받는 중…" : "Installing…")
              : graphInstall.phase === "done"
                ? (ko ? "설치됨" : "Installed")
                : (ko ? "그래프 설치" : "Install graph")}
          </button>
        ) : null}
        <button
          type="button"
          className={"btn sm hub-card-action-btn" + ((plugin && install.phase === "idle") || (!plugin && !graph && !bookmarked) ? " primary" : "")}
          onClick={
            // Agentlas 기본 도구는 허브 매니페스트가 없다 — 승인 미리보기를 거치지 않고
            // 로컬 카탈로그 id로 바로 연결한다(구 MCP 카탈로그 탭과 같은 동작).
            plugin && isDesktopCatalogListing(listing)
              ? () => {
                  if (install.phase === "loading" || install.phase === "installing") return;
                  setInstall({ phase: "installing" });
                  void window.agentlas.mcpTools
                    .install(listing.slug)
                    .then(() => {
                      setInstall({
                        phase: "done",
                        message: ko
                          ? "연결됨 — 다음 대화부터 바로 쓸 수 있습니다."
                          : "Connected — usable from your next conversation.",
                      });
                    })
                    .catch((error: unknown) => {
                      setInstall({
                        phase: "error",
                        message: error instanceof Error ? error.message : String(error),
                      });
                    });
                }
              : plugin
              ? openPluginInstallPreview
              : bookmarked
                ? undefined
                : onBookmark
          }
          disabled={
            plugin
              // confirm 중에도 잠근다 — 승인 화면이 떠 있는데 같은 버튼이 다시 눌리면
              // 사용자는 어느 쪽이 실제 행동인지 알 수 없다.
              ? install.phase === "loading" || install.phase === "installing"
                || install.phase === "done" || install.phase === "confirm"
                || (pluginServerInstalled && install.phase === "idle")
              : bookmarking || bookmarked
          }
        >
          {plugin
            ? install.phase === "loading"
              ? (ko ? "확인 중…" : "Checking…")
              : install.phase === "installing"
                ? (ko ? "설치 중…" : "Installing…")
                : install.phase === "done"
                  ? (ko ? "설치됨" : "Installed")
                  // Hub와 Desktop 카탈로그가 같은 도구를 다른 이름으로 부르므로
                  // (brave-search-mcp ↔ brave-search) slug를 정규화해 판정한다.
                  : pluginServerInstalled && install.phase === "idle"
                    ? (ko ? "설치됨" : "Installed")
                    : (ko ? "설치" : "Install")
            : bookmarking
              ? (ko ? "북마크 중…" : "Saving bookmark…")
              : bookmarked
                ? (ko ? "북마크됨" : "Bookmarked")
                : (ko ? "북마크" : "Bookmark")}
        </button>
        {plugin && websiteUrl ? (
          <button
            type="button"
            className="btn sm hub-card-action-btn"
            onClick={() => window.open(websiteUrl, "_blank", "noopener,noreferrer")}
            title={ko ? "이 플러그인을 제공하는 사이트로 이동합니다." : "Opens the site that provides this plugin."}
          >
            {ko ? "Website →" : "Website →"}
          </button>
        ) : null}
        {callable ? (
          <button
            type="button"
            className="btn sm hub-card-action-btn"
            onClick={onCopyCall}
            title={ko ? "복사한 호출어를 작업 공간의 채팅에 붙여넣으세요." : "Paste the copied call into a Workspace conversation."}
          >
            {ko ? "채팅에 붙여넣기" : "Paste into chat"}
          </button>
        ) : null}
        {/* Paid Hub leases were retired with marketplace settlement. */}
      </div>
    </div>
  );
}

/**
 * 보안 검사 결과는 카드에서 글자로 말하지 않는다 — "보안 검사 B · 경고 확인" 같은 줄은
 * 고르는 데 도움이 안 되고 자리만 먹었다(오너 지시 2026-09-13). 실제로 **차단된**(C)
 * 패키지만 경고 아이콘 하나로 표시하고, 등급 전문은 툴팁과 소개 페이지가 말한다.
 */
function SecurityBlockedTag({ listing, locale }: { listing: MarketplaceListing; locale: Locale }) {
  if (listing.trustGrade !== "C") return null;
  const label = hubSecurityGradeLabel(listing, locale);
  return (
    <span
      className="hub-card-blocked"
      role="img"
      aria-label={label}
      title={`${label} — ${hubSecurityGradeExplanation(locale)}`}
    >
      <IconAlertTriangle size={13} />
    </span>
  );
}
