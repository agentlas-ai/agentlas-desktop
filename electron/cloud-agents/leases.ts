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
//   POST /api/account/agent-leases {slug, days:1..30, idempotencyKey?: string ≤128}
//     → 200 {leasedUntil, days, perDayCredits, chargedCredits, priceKind:"INGEST"}
//       (same-day repurchase EXTENDS the lease — 409 lease_already_purchased_today
//       no longer exists)
//     → 402 {error:"lease_not_offered"|"insufficient_credits", needed?, have?}
//   GET  /api/account/agent-leases?slug=<slug>
//     → {active, leasedUntil, perDayCredits, leaseOffered}   (works signed-out)
//   GET  /api/account/agent-leases
//     → [{slug, leasedUntil}]

import { randomUUID } from "node:crypto";

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
    ? `account:${fingerprint}`
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
    const leaseOffered = body.leaseOffered === true;
    const quote: AgentLeaseQuote = {
      ok: true,
      active: body.active === true,
      leasedUntil: typeof body.leasedUntil === "string" ? body.leasedUntil : null,
      perDayCredits: typeof body.perDayCredits === "number" && Number.isFinite(body.perDayCredits)
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

export async function purchaseAgentLease(input: { slug: string; days: number; idempotencyKey?: string }): Promise<AgentLeasePurchaseResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) {
    return { ok: false, code: "signed_out", message: "Sign in to agentlas.cloud to lease an agent." };
  }
  const days = Math.trunc(input.days);
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    return { ok: false, code: "invalid_days", message: "A lease runs between 1 and 30 days." };
  }
  try {
    const base = webBase();
    // One key per user confirmation (this function runs once per confirmed
    // purchase click) — a network retry of the same confirmation must not
    // charge twice, while a deliberate second purchase gets a fresh key.
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
      return { ok: false, code: "invalid_idempotency_key", message: "The lease request identity is invalid." };
    }
    const response = await fetch(`${base}/api/account/agent-leases`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ slug: String(input.slug || "").trim(), days, idempotencyKey }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok && typeof body.leasedUntil === "string") {
      // The shelf just changed price-wise; auto-hire cost estimates must see it.
      invalidateAgentLeaseCache();
      return {
        ok: true,
        leasedUntil: body.leasedUntil,
        days: typeof body.days === "number" ? body.days : days,
        perDayCredits: typeof body.perDayCredits === "number" ? body.perDayCredits : 0,
        chargedCredits: typeof body.chargedCredits === "number" ? body.chargedCredits : 0,
      };
    }
    return {
      ok: false,
      code: typeof body.error === "string" ? body.error : `http_${response.status}`,
      ...(typeof body.needed === "number" ? { needed: body.needed } : {}),
      ...(typeof body.have === "number" ? { have: body.have } : {}),
      message: typeof body.error === "string" ? body.error : "The lease could not be purchased.",
    };
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Could not reach agentlas.cloud.",
    };
  }
}

export async function listAgentLeases(): Promise<AgentLeaseRow[]> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return [];
  try {
    const base = webBase();
    const response = await fetch(`${base}/api/account/agent-leases`, {
      headers: { cookie, origin: base },
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as unknown;
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
let leaseCache: { fetchedAt: number; rows: AgentLeaseRow[] } | null = null;
let leaseCacheInFlight: Promise<AgentLeaseRow[]> | null = null;

export function invalidateAgentLeaseCache(): void {
  leaseCache = null;
}

export async function listAgentLeasesCached(): Promise<AgentLeaseRow[]> {
  if (leaseCache && Date.now() - leaseCache.fetchedAt < LEASE_CACHE_TTL_MS) return leaseCache.rows;
  if (leaseCacheInFlight) return leaseCacheInFlight;
  leaseCacheInFlight = listAgentLeases()
    .then((rows) => {
      leaseCache = { fetchedAt: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      leaseCacheInFlight = null;
    });
  return leaseCacheInFlight;
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
