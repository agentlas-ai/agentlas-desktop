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

export async function setAgentPrices(input: {
  slug: string;
  patch: AgentPricePatch;
}): Promise<SetAgentPricesResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) {
    return { ok: false, code: "signed_out", message: "Sign in to agentlas.cloud to set a price." };
  }

  // Only the kinds actually named travel. Resending every field would turn one
  // edit into three and could revert a change made elsewhere a moment ago.
  const patch: AgentPricePatch = {};
  for (const kind of PRICE_KINDS) {
    if (!(kind in input.patch)) continue;
    const value = input.patch[kind];
    if (value === null || value === undefined) {
      patch[kind] = null;
      continue;
    }
    const problem = checkPriceLocally(kind, value);
    if (problem) {
      const bounds = PRICE_KIND_BOUNDS[kind];
      return {
        ok: false,
        code: "INVALID_PRICE",
        kind,
        message: `${kind} must be between ${bounds.min} and ${bounds.max ?? "∞"} credits.`,
        ...(bounds.max !== null ? { maxCredits: bounds.max } : {}),
        minCredits: bounds.min,
      };
    }
    patch[kind] = value;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: true, prices: {}, changed: false };
  }

  try {
    const base = webBase();
    const response = await fetch(`${base}/api/account/rates`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ slug: input.slug, prices: patch }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) {
      const rejection = (body.rejection ?? {}) as { maxCredits?: number; minCredits?: number };
      return {
        ok: false,
        code: String(body.error ?? `http_${response.status}`),
        // The bound travels with the refusal. "Could not save" alone sends
        // someone to guess numbers until one is accepted.
        message: describe(body, response.status),
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof rejection.maxCredits === "number" ? { maxCredits: rejection.maxCredits } : {}),
        ...(typeof rejection.minCredits === "number" ? { minCredits: rejection.minCredits } : {}),
      };
    }
    return {
      ok: true,
      prices: (body.prices ?? {}) as AgentPrices,
      changed: body.changed === true,
    };
  } catch (error) {
    return {
      ok: false,
      code: "network",
      message: error instanceof Error ? error.message : "Could not reach agentlas.cloud.",
    };
  }
}

function describe(body: Record<string, unknown>, status: number): string {
  const rejection = (body.rejection ?? {}) as { code?: string; maxCredits?: number; minCredits?: number };
  if (rejection.code === "ABOVE_MAXIMUM") return `Up to ${rejection.maxCredits} credits.`;
  if (rejection.code === "BELOW_MINIMUM") return `From ${rejection.minCredits} credits.`;
  if (body.error === "NOT_OWNER") return "Not permitted.";
  if (body.error === "not_found") return "That agent is not published under this account.";
  if (body.error === "not_enabled") return "Pricing is not enabled yet.";
  if (status === 401) return "Sign in to agentlas.cloud to set a price.";
  return "Could not save the price.";
}
