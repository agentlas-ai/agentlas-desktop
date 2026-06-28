// 마켓 소스 진입점. 환경변수 분기 + fallback wrapper.
//
// 모든 caller는 `getSource()`를 호출하고 인터페이스만 알면 됨.
// MCP 호출 실패 → 마지막 성공 캐시 → InMemory로 자동 fallback (오프라인 보호).
import { InMemorySource } from "./in-memory-source";
import { McpSource } from "./mcp-source";
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

let _status: MarketplaceSourceStatus = {
  mode: "memory",
  baseUrl: null,
  // 아직 실제 Hub 호출이 한 번도 성공하지 않았으므로 "미연결"로 시작한다.
  // 초기값을 online:true로 두면 검증 전/오프라인에도 "허브 실시간 연결됨"으로 거짓 표시된다.
  online: false,
  usingFallback: true,
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

class FallbackSource implements MarketplaceSource {
  private firmListCache: FirmListing[] | null = null;
  private bundleListCache: TeamBundle[] | null = null;
  private searchCache = new Map<string, MarketplaceListing[]>();
  private agentManifestCache = new Map<string, (SeedListingFull & MarketplaceListing) | null>();
  private firmManifestCache = new Map<string, FirmListing | null>();

  constructor(
    private primary: MarketplaceSource,
    private fallback: MarketplaceSource,
    private baseUrl: string,
  ) {}

  private async tryPrimary<T>(
    fn: (s: MarketplaceSource) => Promise<T>,
    method: string,
    cacheRead?: () => T | undefined,
    cacheWrite?: (value: T) => void,
  ): Promise<T> {
    try {
      const result = await fn(this.primary);
      cacheWrite?.(result);
      setStatus({
        mode: "mcp",
        baseUrl: this.baseUrl,
        online: true,
        usingFallback: false,
        lastError: null,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({
        mode: "mcp",
        baseUrl: this.baseUrl,
        online: false,
        usingFallback: true,
        lastError: message,
      });
      console.warn(
        `[marketplace] mcp(${this.baseUrl}) ${method} failed, falling back to in-memory:`,
        message,
      );
      const cached = cacheRead?.();
      if (cached !== undefined) return cached;
      return fn(this.fallback);
    }
  }

  listFirms(): Promise<FirmListing[]> {
    return this.tryPrimary(
      (s) => s.listFirms(),
      "listFirms",
      () => this.firmListCache ?? undefined,
      (firms) => {
        this.firmListCache = firms;
      },
    );
  }
  listBundles(): Promise<TeamBundle[]> {
    return this.tryPrimary(
      (s) => s.listBundles(),
      "listBundles",
      () => this.bundleListCache ?? undefined,
      (bundles) => {
        this.bundleListCache = publicBundles(bundles);
      },
    ).then(publicBundles);
  }
  searchAgents(q: string): Promise<MarketplaceListing[]> {
    const key = q.trim().toLowerCase();
    return this.tryPrimary(
      (s) => s.searchAgents(q),
      "searchAgents",
      () => this.searchCache.get(key),
      (listings) => {
        this.searchCache.set(key, publicListings(listings));
      },
    ).then(publicListings);
  }
  getListingBySlug(slug: string): Promise<(SeedListingFull & MarketplaceListing) | null> {
    if (!isPublicDesktopAgent({ slug })) return Promise.resolve(null);
    return this.tryPrimary(
      (s) => s.getListingBySlug(slug),
      "getListingBySlug",
      () => (this.agentManifestCache.has(slug) ? this.agentManifestCache.get(slug)! : undefined),
      (listing) => {
        this.agentManifestCache.set(slug, listing && isPublicDesktopAgent(listing) ? listing : null);
      },
    ).then((listing) => (listing && isPublicDesktopAgent(listing) ? listing : null));
  }
  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    return this.tryPrimary(
      (s) => s.getFirmBySlug(slug),
      "getFirmBySlug",
      () => (this.firmManifestCache.has(slug) ? this.firmManifestCache.get(slug)! : undefined),
      (firm) => {
        this.firmManifestCache.set(slug, firm);
      },
    );
  }
}

let _source: MarketplaceSource | null = null;
// cargo.*(내 에이전트)는 인증 필수 + in-memory 폴백 금지 → raw McpSource를 따로 들고 있는다.
let _cargoSource: McpSource | null = null;

/** 내 에이전트(cargo) 호출용 raw 소스. memory 모드면 null. */
export function getCargoSource(): McpSource | null {
  getSource();
  return _cargoSource;
}

export function getSource(): MarketplaceSource {
  if (_source) return _source;
  const mode = (process.env.AGENTLAS_MARKET_SOURCE ?? "mcp").toLowerCase();
  const memory = new InMemorySource();
  if (mode === "mcp") {
    const baseUrl = process.env.AGENTLAS_MCP_BASE_URL ?? DEFAULT_BASE_URL;
    // cookieProvider는 함수로 — 로그인 상태가 런타임 중 바뀌므로 매 호출마다 평가.
    const mcp = new McpSource({
      baseUrl,
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
    _source = new FallbackSource(mcp, memory, baseUrl);
  } else {
    setStatus({
      // 명시적 in-memory 모드 = 실제 Hub 연결이 아니라 앱 내장 카탈로그.
      mode: "memory",
      baseUrl: null,
      online: false,
      usingFallback: true,
      lastError: null,
    });
    _source = memory;
  }
  return _source;
}

export function getSourceStatus(): MarketplaceSourceStatus {
  getSource();
  return _status;
}
