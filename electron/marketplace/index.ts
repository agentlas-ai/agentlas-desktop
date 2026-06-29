// 마켓 소스 진입점. Hub-only wrapper.
//
// 모든 caller는 `getSource()`를 호출하고 인터페이스만 알면 됨.
// MCP 호출 실패 시 하드코딩 카탈로그로 대체하지 않는다. Desktop Hub는 실제 Hub 결과만 표시한다.
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
  constructor(
    private primary: MarketplaceSource,
    private baseUrl: string,
  ) {}

  private async tryPrimary<T>(
    fn: (s: MarketplaceSource) => Promise<T>,
    method: string,
    offlineValue: T,
  ): Promise<T> {
    try {
      const result = await fn(this.primary);
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
        usingFallback: false,
        lastError: message,
      });
      console.warn(
        `[marketplace] mcp(${this.baseUrl}) ${method} failed; Hub-only mode returns an empty result:`,
        message,
      );
      return offlineValue;
    }
  }

  listFirms(): Promise<FirmListing[]> {
    return this.tryPrimary(
      (s) => s.listFirms(),
      "listFirms",
      [],
    );
  }
  listBundles(): Promise<TeamBundle[]> {
    return this.tryPrimary(
      (s) => s.listBundles(),
      "listBundles",
      [],
    ).then(publicBundles);
  }
  searchAgents(q: string): Promise<MarketplaceListing[]> {
    return this.tryPrimary(
      (s) => s.searchAgents(q),
      "searchAgents",
      [],
    ).then(publicListings);
  }
  getListingBySlug(slug: string): Promise<(SeedListingFull & MarketplaceListing) | null> {
    if (!isPublicDesktopAgent({ slug })) return Promise.resolve(null);
    return this.tryPrimary(
      (s) => s.getListingBySlug(slug),
      "getListingBySlug",
      null,
    ).then((listing) => (listing && isPublicDesktopAgent(listing) ? listing : null));
  }
  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    return this.tryPrimary(
      (s) => s.getFirmBySlug(slug),
      "getFirmBySlug",
      null,
    );
  }
}

let _source: MarketplaceSource | null = null;
// cargo.*(내 에이전트)는 인증 필수 + in-memory 폴백 금지 → raw McpSource를 따로 들고 있는다.
let _cargoSource: McpSource | null = null;

/** 내 에이전트(cargo) 호출용 raw 소스. */
export function getCargoSource(): McpSource | null {
  getSource();
  return _cargoSource;
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
