// 마켓 데이터 소스 추상화. registry.ts·firms.ts·UI는 인터페이스에만 의존.
// 구현체:
//   - McpSource      : agentlas.cloud/api/mcp/v1 HTTPS 호출 (production 기본)
//
// 환경변수:
//   AGENTLAS_MCP_BASE_URL  = "https://agentlas.cloud/api/mcp/v1" (기본)
//
// Desktop Hub 경로는 원격 호출 실패 시 하드코딩 시드로 대체하지 않는다.
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
