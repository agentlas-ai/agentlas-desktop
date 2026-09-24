// Long-term day-based agent leases (owner decision 2026-08-18).
//
// The 24-hour auto-lease is retired: RENT is charged per work order, and a
// long-term lease is an explicit day-based purchase. This module is the only
// Desktop client of the web lease API and reuses the same authenticated
// cookie-fetch pattern as pricing.ts (never hand-rolled auth).
//
// The lease is account-bound: active in EVERY project (only the per-project
// 렌트허용 consent toggle is project-scoped). "INGEST" survives only as the
// legacy wire id of the per-day price kind.
//
// Server contract (implemented in parallel in the web repo, 2026-08-18):
//   POST /api/account/agent-leases {slug, days:1..30, expectedPerDayCredits, expectedTotalCredits, idempotencyKey}
//     → 200 {leasedUntil, days, perDayCredits, chargedCredits, priceKind:"INGEST"}
//       (same-day repurchase EXTENDS the lease — 409 lease_already_purchased_today
//       no longer exists)
//     → 402 {error:"lease_not_offered"|"insufficient_credits", needed?, have?}
//   GET  /api/account/agent-leases?slug=<slug>
//     → {active, leasedUntil, perDayCredits, leaseOffered}   (works signed-out)
//   GET  /api/account/agent-leases
//     → [{slug, leasedUntil}]

import type { AgentLeasePurchaseInput } from "../../shared/types";

import { getAuthSession, getSessionCookieHeader } from "../auth";

export interface AgentLeaseQuote {
  ok: boolean;
  active: boolean;
  leasedUntil: string | null;
  perDayCredits: number | null;
  leaseOffered: boolean;
  code?: "signed_out" | "network" | "http" | "invalid_slug" | "lease_not_offered" | "account_changed" | string;
  message?: string;
}

export type AgentLeasePurchaseResult =
  | { ok: true; leasedUntil: string; days: number; perDayCredits: number; chargedCredits: number }
  | { ok: false; code: "lease_not_offered" | "insufficient_credits" | "signed_out" | "network" | string; needed?: number; have?: number; message: string };

export interface AgentLeaseRow {
  slug: string;
  leasedUntil: string;
}

function validCredits(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validExpiry(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function webBase(): string {
  return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
}

type LeaseAuthIdentity = {
  cookie: string;
  accountScope: string;
};

/**
 * A quote is a read, but it is still account authority: One uses `active` to
 * decide whether it may create a standing seat without another purchase.
 * Capture both the credential and the renderer-safe account scope before the
 * request, then reject a late response from the account that was active when
 * the request started. Cookie equality alone is not enough for diagnostics;
 * account scope also catches an auth cache transition before its cookie is
 * replaced, while the cookie catches two identities sharing a workspace.
 */
function captureLeaseAuthIdentity(): LeaseAuthIdentity | null {
  const cookie = getSessionCookieHeader();
  const session = getAuthSession();
  if (!cookie || !session.signedIn) return null;
  const fingerprint = session.accountFingerprint?.trim();
  const workspaceId = session.workspaceId?.trim();
  const accountScope = fingerprint
    ? `account:${fingerprint}:workspace:${workspaceId ?? ""}`
    : workspaceId
      ? `workspace:${workspaceId}`
      : null;
  return accountScope ? { cookie, accountScope } : null;
}

function leaseAuthIdentityCurrent(start: LeaseAuthIdentity): boolean {
  const current = captureLeaseAuthIdentity();
  return current?.cookie === start.cookie && current.accountScope === start.accountScope;
}

function accountChangedQuote(): AgentLeaseQuote {
  return {
    ok: false,
    active: false,
    leasedUntil: null,
    perDayCredits: null,
    leaseOffered: false,
    code: "account_changed",
    message: "The signed-in account changed while checking the Hub lease.",
  };
}

export async function getAgentLeaseQuote(slug: string): Promise<AgentLeaseQuote> {
  const missing: AgentLeaseQuote = { ok: false, active: false, leasedUntil: null, perDayCredits: null, leaseOffered: false };
  const authAtRequest = captureLeaseAuthIdentity();
  if (!authAtRequest) return { ...missing, code: "signed_out", message: "Sign in to agentlas.cloud to check the lease." };
  if (!slug.trim()) return { ...missing, code: "invalid_slug", message: "The Hub agent identifier is invalid." };
  try {
    const base = webBase();
    const response = await fetch(
      `${base}/api/account/agent-leases?slug=${encodeURIComponent(slug.trim())}`,
      { headers: { cookie: authAtRequest.cookie, origin: base } },
    );
    if (!leaseAuthIdentityCurrent(authAtRequest)) return accountChangedQuote();
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? { ...missing, code: "signed_out", message: "Sign in to agentlas.cloud to check the lease." }
        : { ...missing, code: "http", message: "Could not check the Hub lease right now." };
    }
    const body = (await response.json()) as {
      active?: boolean;
      leasedUntil?: string | null;
      perDayCredits?: number | null;
      leaseOffered?: boolean;
    };
    // The account may switch while the response body is being read. Do this
    // second check before interpreting `active` as authority for One seating.
    if (!leaseAuthIdentityCurrent(authAtRequest)) return accountChangedQuote();
    if (!body || typeof body !== "object" || typeof body.active !== "boolean" || typeof body.leaseOffered !== "boolean"
      || (body.active && !validExpiry(body.leasedUntil))
      || (body.leaseOffered && !validCredits(body.perDayCredits))) {
      return { ...missing, code: "http", message: "Could not read the Hub lease terms right now." };
    }
    const leaseOffered = body.leaseOffered === true;
    const quote: AgentLeaseQuote = {
      ok: true,
      active: body.active === true && Date.parse(body.leasedUntil!) > Date.now(),
      leasedUntil: typeof body.leasedUntil === "string" ? body.leasedUntil : null,
      perDayCredits: validCredits(body.perDayCredits)
        ? body.perDayCredits
        : null,
      leaseOffered,
    };
    if (body.leaseOffered === false) {
      return { ...quote, code: "lease_not_offered", message: "This Hub agent does not offer long-term leases." };
    }
    if (body.leaseOffered !== true) {
      return { ...quote, code: "http", message: "Could not read the Hub lease terms right now." };
    }
    return quote;
  } catch {
    if (!leaseAuthIdentityCurrent(authAtRequest)) return accountChangedQuote();
    return { ...missing, code: "network", message: "Could not reach agentlas.cloud to check the lease." };
  }
}

// Marketplace settlement and paid Hub leases were permanently retired.
// Legacy IPC callers are refused before a network request can bill credits.
export async function purchaseAgentLease(_input: AgentLeasePurchaseInput): Promise<AgentLeasePurchaseResult> {
  return { ok: false, code: "marketplace_leases_retired", message: "Paid Hub leases are retired." };
}

export async function listAgentLeases(): Promise<AgentLeaseRow[]> {
  const authAtRequest = captureLeaseAuthIdentity();
  if (!authAtRequest) return [];
  try {
    const base = webBase();
    const response = await fetch(`${base}/api/account/agent-leases`, {
      headers: { cookie: authAtRequest.cookie, origin: base },
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as unknown;
    if (!leaseAuthIdentityCurrent(authAtRequest)) return [];
    // 서버 계약(2026-08-18): bare GET은 {leases:[...]} 봉투로 온다. 과거 가정이던
    // 맨 배열도 수용한다 — 형태가 다르다고 조용히 빈 목록을 돌려주면 대여가
    // 있는데도 유료 견적이 나가는 거짓이 된다.
    const body = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { leases?: unknown })?.leases)
        ? ((parsed as { leases: unknown[] }).leases)
        : [];
    return body.flatMap((row) => {
      const item = row as { slug?: unknown; leasedUntil?: unknown };
      return typeof item?.slug === "string" && item.slug.trim() && typeof item?.leasedUntil === "string"
        ? [{ slug: item.slug.trim(), leasedUntil: item.leasedUntil }]
        : [];
    });
  } catch {
    return [];
  }
}

// ── TTL cache for cost estimation ──────────────────────────────────────────
// The route-preview path treats actively leased slugs as 0-cost. That check
// runs on every auto-routed send, so the list is cached briefly. A stale cache
// only OVER-states cost (a fresh lease not yet seen) or keeps a just-expired
// lease at 0 for at most the TTL — the server bill remains the authority.
const LEASE_CACHE_TTL_MS = 60_000;
let leaseGeneration = 0;
let leaseCache: { fetchedAt: number; rows: AgentLeaseRow[]; auth: LeaseAuthIdentity } | null = null;
let leaseCacheInFlight: { auth: LeaseAuthIdentity; generation: number; promise: Promise<AgentLeaseRow[]> } | null = null;

export function invalidateAgentLeaseCache(): void {
  leaseGeneration += 1;
  leaseCache = null;
  leaseCacheInFlight = null;
}

export async function listAgentLeasesCached(): Promise<AgentLeaseRow[]> {
  const auth = captureLeaseAuthIdentity();
  if (!auth) { invalidateAgentLeaseCache(); return []; }
  if (leaseCache && leaseAuthIdentityCurrent(leaseCache.auth) && Date.now() - leaseCache.fetchedAt < LEASE_CACHE_TTL_MS) return leaseCache.rows;
  if (leaseCacheInFlight && leaseCacheInFlight.generation === leaseGeneration && leaseAuthIdentityCurrent(leaseCacheInFlight.auth)) return leaseCacheInFlight.promise;
  const generation = leaseGeneration;
  const promise = listAgentLeases().then(rows => {
    if (!leaseAuthIdentityCurrent(auth) || generation !== leaseGeneration) return [];
    leaseCache = { fetchedAt: Date.now(), rows, auth };
    return rows;
  }).finally(() => {
    if (leaseCacheInFlight?.promise === promise) leaseCacheInFlight = null;
  });
  leaseCacheInFlight = { auth, generation, promise };
  return promise;
}

/** Slugs whose lease is active RIGHT NOW (leasedUntil in the future). */
export async function activeLeasedSlugs(): Promise<Set<string>> {
  const now = Date.now();
  const rows = await listAgentLeasesCached();
  return new Set(
    rows
      .filter((row) => {
        const until = Date.parse(row.leasedUntil);
        return Number.isFinite(until) && until > now;
      })
      .map((row) => row.slug.toLowerCase()),
  );
}
