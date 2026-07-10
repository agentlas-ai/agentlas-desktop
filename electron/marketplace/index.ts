// 마켓 소스 진입점. Hub-only wrapper.
//
// 모든 caller는 `getSource()`를 호출하고 인터페이스만 알면 됨.
// MCP 호출 실패 시 하드코딩 카탈로그로 대체하지 않는다. Desktop Hub는 실제 Hub 결과만 표시한다.
import { McpSource, PartialHubResultError } from "./mcp-source";
import type { MarketplaceSource, SeedListingFull } from "./source";
import { getSessionCookieHeader } from "../auth";
import { isPublicDesktopAgent } from "../agents/policy";
import type {
  FirmListing,
  MarketplaceListing,
  MarketplaceSourceStatus,
  TeamBundle,
} from "../../shared/types";

const DEFAULT_BASE_URL = "https://agentlas.cloud/api/mcp/v1";
const HUB_CACHE_TTL_MS = 5 * 60_000;

type TimedCache<T> = { value: T; at: number };
type PrimaryAttempt<T> = { value: T; cacheable: boolean };

function cacheFresh<T>(entry: TimedCache<T> | undefined, now = Date.now()): T | undefined {
  return entry && now - entry.at < HUB_CACHE_TTL_MS ? entry.value : undefined;
}

let _status: MarketplaceSourceStatus = {
  mode: "mcp",
  baseUrl: DEFAULT_BASE_URL,
  // 아직 실제 Hub 호출이 한 번도 성공하지 않았으므로 "미연결"로 시작한다.
  // 초기값을 online:true로 두면 검증 전/오프라인에도 "허브 실시간 연결됨"으로 거짓 표시된다.
  online: false,
  usingFallback: false,
  lastError: null,
  lastCheckedAt: null,
};

function setStatus(patch: Partial<MarketplaceSourceStatus>) {
  _status = {
    ..._status,
    ...patch,
    lastCheckedAt: new Date().toISOString(),
  };
}

function publicListings<T extends MarketplaceListing>(listings: T[]): T[] {
  // 원격 소스가 배열이 아닌 응답을 줘도 깨지지 않도록 방어(listings.filter is not a function 방지).
  if (!Array.isArray(listings)) return [];
  return listings.filter((listing) => isPublicDesktopAgent(listing));
}

function publicBundles(bundles: TeamBundle[]): TeamBundle[] {
  if (!Array.isArray(bundles)) return [];
  return bundles
    .map((bundle) => ({
      ...bundle,
      agents: bundle.agents.filter((agent) => isPublicDesktopAgent(agent)),
    }))
    .filter((bundle) => bundle.agents.length > 0);
}

class HubOnlySource implements MarketplaceSource {
  private firmCache?: TimedCache<FirmListing[]>;
  private bundleCache?: TimedCache<TeamBundle[]>;
  private searchCache = new Map<string, TimedCache<MarketplaceListing[]>>();
  private listingCache = new Map<string, TimedCache<(SeedListingFull & MarketplaceListing) | null>>();
  private firmBySlugCache = new Map<string, TimedCache<FirmListing | null>>();

  constructor(
    private primary: MarketplaceSource,
    private baseUrl: string,
  ) {}

  private async tryPrimary<T>(
    fn: (s: MarketplaceSource) => Promise<T>,
    method: string,
    offlineValue: T,
  ): Promise<PrimaryAttempt<T>> {
    try {
      const result = await fn(this.primary);
      setStatus({
        mode: "mcp",
        baseUrl: this.baseUrl,
        online: true,
        usingFallback: false,
        lastError: null,
      });
      return { value: result, cacheable: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PartialHubResultError) {
        setStatus({
          mode: "mcp",
          baseUrl: this.baseUrl,
          online: true,
          usingFallback: false,
          lastError: message,
        });
        console.warn(
          `[marketplace] mcp(${this.baseUrl}) ${method} partially failed; showing live Hub partial result without caching:`,
          message,
        );
        return { value: err.partialValue as T, cacheable: false };
      }
      setStatus({
        mode: "mcp",
        baseUrl: this.baseUrl,
        online: false,
        usingFallback: false,
        lastError: message,
      });
      console.warn(
        `[marketplace] mcp(${this.baseUrl}) ${method} failed; Hub-only mode returns an empty result:`,
        message,
      );
      return { value: offlineValue, cacheable: false };
    }
  }

  listFirms(): Promise<FirmListing[]> {
    const cached = cacheFresh(this.firmCache);
    if (cached) return Promise.resolve(cached);
    return this.tryPrimary((s) => s.listFirms(), "listFirms", []).then(({ value, cacheable }) => {
      if (cacheable) this.firmCache = { value, at: Date.now() };
      return value;
    });
  }
  listBundles(): Promise<TeamBundle[]> {
    const cached = cacheFresh(this.bundleCache);
    if (cached) return Promise.resolve(cached);
    return this.tryPrimary((s) => s.listBundles(), "listBundles", []).then(({ value, cacheable }) => {
      const bundles = publicBundles(value);
      if (cacheable) this.bundleCache = { value: bundles, at: Date.now() };
      return bundles;
    });
  }
  searchAgents(q: string): Promise<MarketplaceListing[]> {
    const key = q.trim().toLowerCase();
    const cached = cacheFresh(this.searchCache.get(key));
    if (cached) {
      // 캐시 값은 직전 성공(tryPrimary)에서만 생성되므로 online 상태를 동기화한다 —
      // 캐시 히트가 status를 갱신하지 않아 마켓 배지가 최대 5분간 stale로 굳는 버그 방지.
      setStatus({ mode: "mcp", baseUrl: this.baseUrl, online: true, usingFallback: false, lastError: null });
      return Promise.resolve(cached);
    }
    return this.tryPrimary((s) => s.searchAgents(q), "searchAgents", []).then(({ value, cacheable }) => {
      const listings = publicListings(value);
      if (cacheable) this.searchCache.set(key, { value: listings, at: Date.now() });
      return listings;
    });
  }
  getListingBySlug(slug: string): Promise<(SeedListingFull & MarketplaceListing) | null> {
    if (!isPublicDesktopAgent({ slug })) return Promise.resolve(null);
    const cached = cacheFresh(this.listingCache.get(slug));
    if (cached !== undefined) return Promise.resolve(cached);
    return this.tryPrimary((s) => s.getListingBySlug(slug), "getListingBySlug", null).then(({ value, cacheable }) => {
      const listing = value && isPublicDesktopAgent(value) ? value : null;
      if (cacheable) this.listingCache.set(slug, { value: listing, at: Date.now() });
      return listing;
    });
  }
  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    const cached = cacheFresh(this.firmBySlugCache.get(slug));
    if (cached !== undefined) return Promise.resolve(cached);
    return this.tryPrimary((s) => s.getFirmBySlug(slug), "getFirmBySlug", null).then(({ value, cacheable }) => {
      if (cacheable) this.firmBySlugCache.set(slug, { value, at: Date.now() });
      return value;
    });
  }
}

let _source: MarketplaceSource | null = null;
// cargo.*(내 에이전트)는 인증 필수 + in-memory 폴백 금지 → raw McpSource를 따로 들고 있는다.
let _cargoSource: McpSource | null = null;
let _myAgentsCache: TimedCache<{ cookie: string | null; agents: MarketplaceListing[] }> | null = null;

/** 내 에이전트(cargo) 호출용 raw 소스. */
export function getCargoSource(): McpSource | null {
  getSource();
  return _cargoSource;
}

/** 로그인 사용자의 실제 복원 가능한 Agent Cloud 패키지 목록. 세션별로 짧게 캐시한다. */
export async function listMyAgentsCached(): Promise<MarketplaceListing[]> {
  const source = getCargoSource();
  if (!source) return [];
  const cookie = getSessionCookieHeader();
  const cached = cacheFresh(_myAgentsCache ?? undefined);
  if (cached && cached.cookie === cookie) return cached.agents;
  const agents = (await source.listMyCloudPackages()).filter((agent) => isPublicDesktopAgent(agent));
  _myAgentsCache = { value: { cookie, agents }, at: Date.now() };
  return agents;
}

export function getSource(): MarketplaceSource {
  if (_source) return _source;
  const requestedMode = (process.env.AGENTLAS_MARKET_SOURCE ?? "mcp").toLowerCase();
  if (requestedMode !== "mcp") {
    console.warn(`[marketplace] AGENTLAS_MARKET_SOURCE=${requestedMode} ignored; Desktop Hub is Hub-only.`);
  }
  const baseUrl = process.env.AGENTLAS_MCP_BASE_URL ?? DEFAULT_BASE_URL;
  // cookieProvider는 함수로 — 로그인 상태가 런타임 중 바뀌므로 매 호출마다 평가.
  const mcp = new McpSource({
    baseUrl,
    publicAgentsUrl: process.env.AGENTLAS_MARKETPLACE_AGENTS_URL,
    publicPluginsUrl: process.env.AGENTLAS_MARKETPLACE_PLUGINS_URL,
    timeoutMs: 15000,
    cookieProvider: () => getSessionCookieHeader(),
  });
  _cargoSource = mcp;
  setStatus({
    mode: "mcp",
    baseUrl,
    online: false,
    usingFallback: false,
    lastError: null,
  });
  _source = new HubOnlySource(mcp, baseUrl);
  return _source;
}

export function getSourceStatus(): MarketplaceSourceStatus {
  getSource();
  return _status;
}
