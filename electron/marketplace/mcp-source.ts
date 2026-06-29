// MCP source — agentlas.cloud/api/mcp/v1 HTTPS 호출.
// Node 20+ 글로벌 fetch. 인증 토큰은 옵션 (anonymous read-only).
//
// Desktop Hub는 공개 Hub 프로필 전체 목록을 우선 읽고, 실패 시에만 live MCP 검색을 보조로 사용한다.
// 응답 실패/타임아웃 시 하드코딩 카탈로그로 대체하지 않는다.
import type { FirmListing, MarketplaceListing, TeamBundle } from "../../shared/types";
import type { MarketplaceSource, SeedListingFull } from "./source";

const PUBLIC_AGENT_CACHE_MS = 60_000;

interface McpSourceOptions {
  baseUrl: string;
  /** Public full Hub list endpoint. Defaults to `${origin}/api/marketplace/agents`. */
  publicAgentsUrl?: string;
  /** Public Hub plugin endpoint. Defaults to `${origin}/api/plugins`. */
  publicPluginsUrl?: string;
  /** 인증 토큰 (있으면 cargo/builder 호출 가능) */
  bearer?: string;
  /** 요청 타임아웃 (ms) — 기본 15000 */
  timeoutMs?: number;
  /** 매 호출 직전에 평가되는 cookie 헤더 — agentlas_session=... 또는 null. 로그인 상태가 바뀔 수 있어 함수로 받는다. */
  cookieProvider?: () => string | null;
}

/** 원격 result를 배열로 정규화. 서버가 배열을 직접 주거나 {agents|firms|bundles|listings|items|results:[...]}
 *  로 감싸 주거나, 단일 객체를 줄 수 있다. 어떤 경우든 caller(.filter 등)가 깨지지 않도록 배열로 만든다. */
function asArray<T>(raw: unknown, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const k of [...keys, "items", "results", "data"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanIsoString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trustGrade(value: unknown): MarketplaceListing["trustGrade"] {
  return value === "A" || value === "B" || value === "C" || value === "unknown" ? value : "unknown";
}

function normalizeListing(raw: MarketplaceListing): MarketplaceListing | null {
  const record = raw as MarketplaceListing & Record<string, unknown>;
  const slug = cleanString(record.slug);
  if (!slug) return null;

  const name = cleanString(record.name, slug);
  const nameEn = cleanString(record.nameEn, name);
  const isHubCallable = record.kind === "cloud-callable" || record.callable === true || record.source === "hub-index" || record.source === "hub-profile";
  const entityKind = cleanString(record.entityKind, "agent");
  const fallbackTagline = isHubCallable
    ? entityKind === "team"
      ? "Callable Hub team"
      : "Callable Hub agent"
    : "Installable Agentlas agent";
  const tagline = cleanString(record.tagline, fallbackTagline);
  const taglineEn = cleanString(record.taglineEn, tagline);
  const manifestUrl = cleanString(
    record.manifestUrl,
    `https://agentlas.cloud/api/mcp/v1/manifest/agent/${slug}`,
  );

  return {
    ...record,
    slug,
    name,
    nameEn,
    tagline,
    taglineEn,
    trustGrade: trustGrade(record.trustGrade),
    installCount: cleanNumber(record.installCount, cleanNumber(record.verifiedInvocations)),
    manifestUrl,
  };
}

function normalizeListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  return listings
    .map(normalizeListing)
    .filter((listing): listing is MarketplaceListing => Boolean(listing));
}

function isLiveHubRecord(record: Record<string, unknown>): boolean {
  return (
    record.source === "hub-index" ||
    record.source === "hub-profile" ||
    record.kind === "cloud-callable" ||
    record.callable === true
  );
}

function liveHubListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  return normalizeListings(listings).filter((listing) => isLiveHubRecord(listing as unknown as Record<string, unknown>));
}

function liveHubTeams<T extends FirmListing | TeamBundle>(items: T[]): T[] {
  return items.filter((item) => isLiveHubRecord(item as unknown as Record<string, unknown>));
}

function publicAgentsUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/api/marketplace/agents`;
  } catch {
    return "https://agentlas.cloud/api/marketplace/agents";
  }
}

function publicPluginsUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/api/plugins`;
  } catch {
    return "https://agentlas.cloud/api/plugins";
  }
}

function marketPublicAgentToListing(raw: Record<string, unknown>): MarketplaceListing | null {
  const slug = cleanString(raw.slug);
  if (!slug) return null;
  const entityKind = cleanString(raw.kind, "agent") === "team" ? "team" : "agent";
  const titleEn = cleanString(raw.titleEn, cleanString(raw.title, slug));
  const titleKo = cleanString(raw.titleKo, titleEn);
  const name = titleKo || titleEn || slug;
  const taglineEn = cleanString(raw.taglineEn, cleanString(raw.tagline, entityKind === "team" ? "Callable Hub team" : "Callable Hub agent"));
  const taglineKo = cleanString(raw.taglineKo, taglineEn);
  const totalBorrows = cleanNumber(raw.totalBorrows);
  const perCallCredits = cleanNumber(raw.perCallCredits, entityKind === "team" ? 10 : 3);

  return {
    slug,
    name,
    nameEn: titleEn || name,
    tagline: taglineKo || taglineEn,
    taglineEn,
    trustGrade: "A",
    installCount: totalBorrows,
    manifestUrl: `https://agentlas.cloud/p/${slug}`,
    ownerName: cleanString(raw.ownerName),
    publishedAt: cleanIsoString(raw.publishedAt),
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    routingStatus: "public-profile",
    source: "hub-profile",
    entityKind,
    perCallCredits,
    verifiedInvocations: totalBorrows,
    totalBorrows,
    todayBorrows: cleanNumber(raw.todayBorrows),
    assetCount: cleanNumber(raw.assetCount),
    agentCount: cleanNumber(raw.agentCount, entityKind === "team" ? 1 : 0),
    lastRoutingSuccessAt: cleanIsoString(raw.lastBorrowedAt),
  };
}

function marketPublicPluginToListing(raw: Record<string, unknown>): MarketplaceListing | null {
  const slug = cleanString(raw.slug);
  if (!slug) return null;
  const name = cleanString(raw.name, slug);
  const tagline = cleanString(raw.tagline, "Hub plugin");
  const developer = cleanString(raw.developer, "Agentlas Hub");
  const detailUrl = cleanString(raw.detailUrl, cleanString(raw.manifestHref, `/api/plugins/${slug}`));
  const install = raw.install && typeof raw.install === "object" ? raw.install as Record<string, unknown> : {};

  return {
    slug,
    name,
    nameEn: name,
    tagline,
    taglineEn: tagline,
    trustGrade: "A",
    installCount: 0,
    manifestUrl: detailUrl.startsWith("http") ? detailUrl : `https://agentlas.cloud${detailUrl}`,
    ownerName: developer,
    kind: "hub-plugin",
    callable: false,
    routingReady: true,
    routingStatus: "public-plugin",
    source: "hub-plugin",
    entityKind: "plugin",
    perCallCredits: 0,
    category: cleanString(raw.category),
    developer,
    detailUrl: detailUrl.startsWith("http") ? detailUrl : `https://agentlas.cloud${detailUrl}`,
    installCli: cleanString(install.cli, `npx agentlas@latest plugin add ${slug}`),
  };
}

function matchesQuery(listing: MarketplaceListing, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [
    listing.slug,
    listing.name,
    listing.nameEn,
    listing.tagline,
    listing.taglineEn,
    listing.ownerName,
    listing.entityKind,
    listing.category,
    listing.developer,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export class McpSource implements MarketplaceSource {
  private publicAgentCache: { fetchedAt: number; listings: MarketplaceListing[] } | null = null;
  private publicPluginCache: { fetchedAt: number; listings: MarketplaceListing[] } | null = null;

  constructor(private opts: McpSourceOptions) {}

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.opts.baseUrl}/tools/call`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.bearer) headers.authorization = `Bearer ${this.opts.bearer}`;
      // 로그인되어 있으면 세션 cookie를 첨부 — server-side에서 인증된 사용자로 인식
      const cookie = this.opts.cookieProvider?.();
      if (cookie) headers.cookie = cookie;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params: { name: method, arguments: params ?? {} } }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`MCP ${method} ${resp.status}`);
      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async listPublicHubAgents(): Promise<MarketplaceListing[]> {
    const now = Date.now();
    if (this.publicAgentCache && now - this.publicAgentCache.fetchedAt < PUBLIC_AGENT_CACHE_MS) {
      return this.publicAgentCache.listings;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    const url = this.opts.publicAgentsUrl || publicAgentsUrlFor(this.opts.baseUrl);
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`public marketplace agents ${resp.status}`);
      const json = (await resp.json()) as unknown;
      const rawAgents = asArray<Record<string, unknown>>(json, "agents", "listings");
      const listings = liveHubListings(rawAgents.map(marketPublicAgentToListing).filter((item): item is MarketplaceListing => Boolean(item)));
      this.publicAgentCache = { fetchedAt: now, listings };
      return listings;
    } finally {
      clearTimeout(timer);
    }
  }

  private async listPublicHubPlugins(): Promise<MarketplaceListing[]> {
    const now = Date.now();
    if (this.publicPluginCache && now - this.publicPluginCache.fetchedAt < PUBLIC_AGENT_CACHE_MS) {
      return this.publicPluginCache.listings;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    const url = this.opts.publicPluginsUrl || publicPluginsUrlFor(this.opts.baseUrl);
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`public marketplace plugins ${resp.status}`);
      const json = (await resp.json()) as unknown;
      const rawPlugins = asArray<Record<string, unknown>>(json, "plugins", "items", "listings");
      const listings = normalizeListings(rawPlugins.map(marketPublicPluginToListing).filter((item): item is MarketplaceListing => Boolean(item)));
      this.publicPluginCache = { fetchedAt: now, listings };
      return listings;
    } finally {
      clearTimeout(timer);
    }
  }

  async listFirms(): Promise<FirmListing[]> {
    return liveHubTeams(asArray<FirmListing>(await this.call<unknown>("marketplace.list_firms", {}), "firms"));
  }

  async listBundles(): Promise<TeamBundle[]> {
    return liveHubTeams(asArray<TeamBundle>(await this.call<unknown>("marketplace.list_bundles", {}), "bundles"));
  }

  async searchAgents(q: string): Promise<MarketplaceListing[]> {
    // 에이전트: 작동하는 MCP marketplace.search_agents 사용.
    //   공개 REST /api/marketplace/agents 는 서버에 존재하지 않아 404 → 과거엔 검색이 항상 빈 결과였다.
    // 플러그인: 공개 /api/plugins (정상 동작).
    const [agents, plugins] = await Promise.all([
      this.searchHubAgents(q).catch(() => [] as MarketplaceListing[]),
      this.listPublicHubPlugins().catch(() => [] as MarketplaceListing[]),
    ]);
    return [...agents, ...plugins].filter((listing) => matchesQuery(listing, q));
  }

  /** 허브 에이전트 검색 — MCP marketplace.search_agents.
   *  서버는 query를 느슨히 적용하고 limit 상한이 작으므로 넉넉히 받아 client matchesQuery로 최종 필터한다.
   *  install-only 에이전트도 정당한 허브 결과이므로 liveHub 필터를 적용하지 않는다. */
  private async searchHubAgents(q: string): Promise<MarketplaceListing[]> {
    // 게이트웨이 스키마는 `q`(limit≤20)지만 `query`도 받는다 — 양쪽 모두 보내 안전하게.
    const raw = await this.call<unknown>("marketplace.search_agents", { query: q, q, limit: 60 });
    // 서버 응답은 { count, total, results, ... } 형태 — asArray가 "results"를 추출한다.
    const rows = asArray<MarketplaceListing>(raw, "results", "agents", "listings");
    // search_agents 결과엔 source 마커가 없어(렌더러의 isLiveHubListing 필터가 source∈{hub-*}/cloud-callable/
    // callable 만 통과시킴) install-only 허브 에이전트가 마켓 화면에서 전부 걸러진다 → 허브 인덱스 출처로 명시.
    const stamped = rows.map((row) => {
      const rec = row as MarketplaceListing & Record<string, unknown>;
      return { ...rec, source: typeof rec.source === "string" && rec.source ? rec.source : "hub-index" } as MarketplaceListing;
    });
    return normalizeListings(stamped);
  }

  async getListingBySlug(
    slug: string,
  ): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>(
      "marketplace.get_manifest",
      { kind: "agent", slug },
    );
  }

  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    return this.call<FirmListing | null>("marketplace.get_manifest", {
      kind: "firm",
      slug,
    });
  }

  // ── cargo.* — 로그인한 사용자가 만든 자기 에이전트 (인증 필요) ──────────
  /** 내 에이전트 목록 (cookieProvider가 세션 쿠키 첨부). */
  async listMyAgents(): Promise<MarketplaceListing[]> {
    return asArray<MarketplaceListing>(await this.call<unknown>("cargo.list_agents", {}), "agents", "listings");
  }

  /** 내 에이전트 풀 매니페스트 (설치용). slug 또는 "cargo:<id>" 모두 허용. */
  getMyAgentManifest(id: string): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>("cargo.get_manifest", { id });
  }
}
