/** User-facing metadata inventory. It carries no execution grant or server configuration. */
export type ScienceCapabilityCatalogKind = "skills" | "connectors" | "specialists";
export interface ScienceCapabilityCatalogInput {
  kind: ScienceCapabilityCatalogKind;
  query?: string;
  offset?: number;
  limit?: number;
  expectedCatalogSha256?: string;
}
export interface ScienceCapabilityCatalogItem {
  id: string;
  name: string;
  summary: string;
  origin: string;
  registration: "enabled" | "disabled" | "unregistered" | "registered" | "source-unavailable" | "invalid";
  execution: "on-demand" | "unknown";
}
export interface ScienceCapabilityCatalogResult {
  schema: "agentlas.science-capability-catalog.v1";
  kind: ScienceCapabilityCatalogKind;
  query: string;
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  catalogSha256: string;
  items: ScienceCapabilityCatalogItem[];
}
export interface ScienceCapabilityManagerInput {
  manager: "specialist-library" | "specialist-build" | "specialist-files" | "connector-library";
  agentId?: string;
}
