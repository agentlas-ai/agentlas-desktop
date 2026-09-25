// Marketplace settlement and per-agent prices were permanently retired.
// Keep the old IPC types for installed clients, but never read or mutate rates.

export const PRICE_KINDS = ["RENT", "INGEST", "FORK"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

export type AgentPrices = Partial<Record<PriceKind, number>>;
export type AgentPricePatch = Partial<Record<PriceKind, number | null>>;

export type SetAgentPricesResult =
  | { ok: true; prices: AgentPrices; changed: boolean }
  | { ok: false; code: string; message: string; kind?: string; maxCredits?: number; minCredits?: number };

export async function readAgentPrices(_slug: string): Promise<{
  ok: boolean;
  prices: AgentPrices;
  legacyUnpriced: boolean;
  agentDefinitionId?: string;
}> {
  return { ok: false, prices: {}, legacyUnpriced: true };
}

// Older Desktop/Mobile clients receive a refusal; there is no rate mutation.
export async function setAgentPrices(_input: {
  slug: string;
  patch: AgentPricePatch;
}): Promise<SetAgentPricesResult> {
  return { ok: false, code: "marketplace_pricing_retired", message: "Hub agent pricing is retired." };
}
