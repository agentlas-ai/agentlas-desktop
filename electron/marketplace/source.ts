// 마켓 데이터 소스 추상화. registry.ts·firms.ts·UI는 인터페이스에만 의존.
// 구현체:
//   - InMemorySource : 시드 데이터를 메인 프로세스에 박아둠 (V0 dev/오프라인 fallback)
//   - McpSource      : agentlas.cloud/api/mcp/v1 HTTPS 호출 (production 기본)
//
// 환경변수 분기:
//   AGENTLAS_MARKET_SOURCE = "mcp" | "memory"  (기본: "mcp")
//   AGENTLAS_MCP_BASE_URL  = "https://agentlas.cloud/api/mcp/v1" (기본)
//
// MCP 호출 실패 시 마지막 성공 응답 캐시 → InMemory fallback 순으로 내려간다.
import type {
  AgentEnvRequirement,
  AgentVisibility,
  FirmListing,
  MarketplaceListing,
  TeamBundle,
} from "../../shared/types";

export interface SeedListingFull extends Omit<MarketplaceListing, "manifestUrl"> {
  mcpServers: string[];
  tone: "blue" | "green" | "purple" | "amber" | "peach";
  systemPrompt: string;
  envRequirements?: AgentEnvRequirement[];
  visibility?: AgentVisibility;
}

export interface MarketplaceSource {
  listFirms(): Promise<FirmListing[]>;
  listBundles(): Promise<TeamBundle[]>;
  searchAgents(q: string): Promise<MarketplaceListing[]>;
  /** registry/firms가 설치 시 호출하는 manifest lookup */
  getListingBySlug(slug: string): Promise<(SeedListingFull & MarketplaceListing) | null>;
  getFirmBySlug(slug: string): Promise<FirmListing | null>;
}
