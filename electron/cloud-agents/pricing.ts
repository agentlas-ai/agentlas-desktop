// Setting what a published agent charges.
//
// WHY IT IS KEYED BY SLUG
//   Because a slug is all we have. The registration receipt is validated
//   strictly in package.ts and keeps cloudId, slug, revision and packageHash —
//   it has never carried an agentDefinitionId, and pricing on the server is
//   stored against that id. The web endpoint therefore accepts a slug and
//   resolves it against the caller's own definitions, which is what lets this
//   be one call instead of resolve-then-price. A two-call sequence is where the
//   second call gets skipped.
//
// WHY A FAILURE HERE IS NOT A FAILED PUBLISH
//   The agent is already on the Hub by the time this runs. If pricing fails,
//   the listing is live and free — which is exactly the state every agent
//   published before pricing existed is in, and a state the product handles.
//   Turning that into "publish failed" would be a lie about what happened and
//   would send someone to re-publish something already published.
//
// WHAT ABSENT MEANS
//   A kind left out of the patch is untouched; a kind sent as null is removed.
//   Blank is NOT zero — an agent with no fork price cannot be forked, whereas a
//   fork priced at zero would be giving copies away.

import { getSessionCookieHeader } from "../auth";

export const PRICE_KINDS = ["RENT", "INGEST", "FORK"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** Mirrors the server's PRICE_KIND_SPEC. The server checks again and wins. */
export const PRICE_KIND_BOUNDS: Record<PriceKind, { min: number; max: number | null }> = {
  RENT: { min: 1, max: 100 },
  INGEST: { min: 1, max: 2_000 },
  FORK: { min: 1, max: null },
};

export type AgentPrices = Partial<Record<PriceKind, number>>;
export type AgentPricePatch = Partial<Record<PriceKind, number | null>>;

export type SetAgentPricesResult =
  | { ok: true; prices: AgentPrices; changed: boolean }
  | { ok: false; code: string; message: string; kind?: string; maxCredits?: number; minCredits?: number };

function webBase(): string {
  return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
}

export function isPriceKind(value: unknown): value is PriceKind {
  return typeof value === "string" && (PRICE_KINDS as readonly string[]).includes(value);
}

/**
 * Local bounds check, so an obviously bad number does not cost a round trip.
 * Returns null when acceptable. The SERVER is still the authority — this only
 * saves a request, it never grants one.
 */
export function checkPriceLocally(kind: PriceKind, credits: number): string | null {
  const bounds = PRICE_KIND_BOUNDS[kind];
  if (!Number.isFinite(credits) || !Number.isInteger(credits)) return "not_an_integer";
  if (credits < bounds.min) return "below_minimum";
  if (bounds.max !== null && credits > bounds.max) return "above_maximum";
  return null;
}

export async function readAgentPrices(slug: string): Promise<{
  ok: boolean;
  prices: AgentPrices;
  legacyUnpriced: boolean;
  agentDefinitionId?: string;
}> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, prices: {}, legacyUnpriced: true };
  try {
    const response = await fetch(
      `${webBase()}/api/account/rates?slug=${encodeURIComponent(slug)}`,
      { headers: { cookie, origin: webBase() } },
    );
    if (!response.ok) return { ok: false, prices: {}, legacyUnpriced: true };
    const body = (await response.json()) as {
      prices?: AgentPrices;
      legacyUnpriced?: boolean;
      agentDefinitionId?: string;
    };
    return {
      ok: true,
      prices: body.prices ?? {},
      legacyUnpriced: body.legacyUnpriced !== false,
      ...(body.agentDefinitionId ? { agentDefinitionId: body.agentDefinitionId } : {}),
    };
  } catch {
    return { ok: false, prices: {}, legacyUnpriced: true };
  }
}

// Marketplace settlement and per-agent pricing were permanently retired.
// Preserve the typed method so older Desktop/Mobile clients receive a refusal,
// while the former rate mutation has no executable path.
export async function setAgentPrices(_input: {
  slug: string;
  patch: AgentPricePatch;
}): Promise<SetAgentPricesResult> {
  return { ok: false, code: "marketplace_pricing_retired", message: "Hub agent pricing is retired." };
}
