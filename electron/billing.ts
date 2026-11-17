// AI 사용 크레딧 잔액은 공개 Hub 에이전트의 가격과 별개다.
// 과거 Hub 렌트 수익 전송은 마켓플레이스 정산 영구 폐쇄로 비활성화한다.
// 인증은 auth.ts의 세션 쿠키를 사용한다.
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "./auth";
import type { BillingCheckoutReadiness, BillingPlanCatalog, BillingPlanOffer, EarningsTransferResult, HubCreditBalance, HubFriendInviteClaimResult, HubFriendInviteResult, HubUsage, HubUsageResetResult } from "../shared/types";
import { PROJECT_AGENT_POOL_MAX } from "../shared/project-agent-pool";

const TIMEOUT_MS = 8000;
const CREDIT_OBSERVATION_MAX_MS = 60_000;
let creditObservation: { cookie: string; at: number; balance: HubCreditBalance } | null = null;

/** Read-only admission hint; serving reservation and settlement stay server-owned.
 * Never reuse a previous account's wallet or an old/error balance for fallback. */
export function peekAgentlasCreditsAvailable(now = Date.now()): boolean {
  const observed = creditObservation;
  if (!observed || now < observed.at || now - observed.at > CREDIT_OBSERVATION_MAX_MS
    || observed.cookie !== getSessionCookieHeader()) return false;
  const balance = observed.balance;
  return balance.authenticated === true && !balance.error
    && typeof balance.remainingCredits === "number" && Number.isFinite(balance.remainingCredits) && balance.remainingCredits > 0;
}

// 세션 쿠키 호출은 전부 auth.fetchWithHubSession 경유 — 401이면 auth 캐시 세션까지 폐기된다.
// (직접 fetch로 돌아가면 "크레딧만 사라지고 계정 칩은 로그인 상태" 불일치가 되살아난다.)
async function timedFetch(cookie: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithHubSession(cookie, url, init, TIMEOUT_MS);
}

/** Background readers (phone bridge, first-run, wait paths) share a read this young. */
const CREDIT_SHARE_MAX_AGE_MS = 10_000;
/** One entry only (the current session); a different session cookie replaces it. */
let creditShared: { cookie: string; at: number; balance: HubCreditBalance } | null = null;
let creditFlight: { cookie: string; promise: Promise<HubCreditBalance> } | null = null;

export interface BillingCreditsReadOptions {
  /** Skip the shared read and the running read: used right after a provider quota rejection. */
  force?: boolean;
  /** Accept a shared read at most this old (default 10 s). */
  maxAgeMs?: number;
}

/** Test seam: forget the shared read (sign-out already does this through the cookie key). */
export function resetBillingCreditsShareForTests(): void { creditShared = null; creditFlight = null; creditObservation = null; }

/** The server's `usage` object, or undefined when it is absent or not the contract shape (old server / switch off:
 * the UI then draws credits as before and never a 0%). Unknown extra keys are dropped. */
export function parseHubUsage(value: unknown): HubUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const kind = u.kind === "week" || u.kind === "month" || u.kind === "trial" ? u.kind : null;
  const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (!kind || typeof u.usedPercent !== "number" || !Number.isFinite(u.usedPercent) || typeof u.exhausted !== "boolean"
    || !iso(u.windowStart) || !iso(u.windowEnd) || typeof u.extraUsage !== "boolean") return undefined;
  const usage: HubUsage = {
    kind, usedPercent: Math.min(100, Math.max(0, Math.floor(u.usedPercent))), exhausted: u.exhausted,
    windowStart: u.windowStart, windowEnd: u.windowEnd, extraUsage: u.extraUsage,
  };
  const t = u.resetTickets;
  if (t && typeof t === "object") {
    const r = t as Record<string, unknown>;
    if (typeof r.available === "number" && Number.isFinite(r.available) && typeof r.canUse === "boolean") {
      const blocked = r.blocked === "trial_active" || r.blocked === "already_reset_this_window" || r.blocked === "nothing_to_reset" || r.blocked === "no_ticket" ? r.blocked : undefined;
      usage.resetTickets = {
        available: Math.max(0, Math.floor(r.available)),
        nextExpiresAt: iso(r.nextExpiresAt) ? r.nextExpiresAt : null,
        usedThisWindow: r.usedThisWindow === true, canUse: r.canUse,
        ...(blocked ? { blocked } : {}),
      };
    }
  }
  return usage;
}

async function fetchBillingCredits(cookie: string): Promise<HubCreditBalance> {
  creditObservation = null;
  try {
    const res = await timedFetch(cookie, `${webBaseUrl()}/api/billing/credits`);
    // 401 = 세션 무효 — 미인증으로 강등. 세션 폐기는 fetchWithHubSession이 이미 처리했으므로
    // 계정 칩도 같은 틱에 로그아웃 상태로 내려간다.
    if (res.status === 401) { creditShared = null; return { authenticated: false }; }
    if (!res.ok) return { authenticated: true, error: `http_${res.status}` };
    const balance = (await res.json()) as HubCreditBalance;
    // The server may still include a historic creator wallet. Never project it
    // into current Desktop or paired Mobile clients after settlement closure.
    delete balance.earningsCredits;
    const usage = parseHubUsage((balance as { usage?: unknown }).usage);
    if (usage) balance.usage = usage; else delete balance.usage;
    // Only a read for the session that is still current is kept; an error answer is never kept.
    if (cookie === getSessionCookieHeader()) {
      const at = Date.now();
      creditObservation = { cookie, at, balance: { ...balance } };
      creditShared = { cookie, at, balance: { ...balance } };
    }
    return balance;
  } catch {
    return { authenticated: true, error: "network" };
  }
}

/** GET /api/billing/credits — AI 사용 잔액 조회. 미로그인은 authenticated:false.
 * Concurrent readers of the same session share one request and a read younger than
 * `maxAgeMs` (10 s) is reused; `force` always asks the server. */
export async function getBillingCredits(options: BillingCreditsReadOptions = {}): Promise<HubCreditBalance> {
  const cookie = getSessionCookieHeader();
  if (!cookie) { creditObservation = null; creditShared = null; creditFlight = null; return { authenticated: false }; }
  if (!options.force) {
    const maxAge = typeof options.maxAgeMs === "number" && options.maxAgeMs >= 0 ? options.maxAgeMs : CREDIT_SHARE_MAX_AGE_MS;
    const shared = creditShared;
    const now = Date.now();
    if (shared && shared.cookie === cookie && now >= shared.at && now - shared.at <= maxAge) return { ...shared.balance };
    const running = creditFlight;
    if (running && running.cookie === cookie) return { ...(await running.promise) };
  }
  const promise = fetchBillingCredits(cookie);
  const entry = { cookie, promise };
  if (!options.force || !creditFlight || creditFlight.cookie !== cookie) creditFlight = entry;
  try {
    return await promise;
  } finally {
    if (creditFlight === entry) creditFlight = null;
  }
}

const DESKTOP_CLIENT_HEADERS = { "x-agentlas-client": "desktop", "content-type": "application/json", accept: "application/json" };
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

async function readCode(res: Response): Promise<string> {
  try { const code = ((await res.json()) as { code?: unknown }).code; return typeof code === "string" ? code : ""; } catch { return ""; }
}

/** POST /api/billing/usage/reset — runs in Main (the session cookie never reaches the renderer). The same key
 * again answers the same 200, so a retry after a lost answer cannot spend a second ticket. */
export async function resetBillingUsage(input: { idempotencyKey?: unknown }): Promise<HubUsageResetResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "signed_out" };
  const key = typeof input?.idempotencyKey === "string" && IDEMPOTENCY_KEY.test(input.idempotencyKey) ? input.idempotencyKey : null;
  if (!key) return { ok: false, code: "unavailable" };
  try {
    const res = await timedFetch(cookie, `${webBaseUrl()}/api/billing/usage/reset`, {
      method: "POST", headers: DESKTOP_CLIENT_HEADERS, body: JSON.stringify({ idempotencyKey: key }),
    });
    if (res.status === 401) return { ok: false, code: "signed_out" };
    if (res.status === 429) return { ok: false, code: "rate_limited" };
    if (res.status === 200) {
      const usage = parseHubUsage(((await res.json()) as { usage?: unknown }).usage);
      if (!usage) return { ok: false, code: "unavailable" };
      creditShared = null; creditObservation = null; // the balance changed: the next reader asks the server
      return { ok: true, usage };
    }
    const code = await readCode(res);
    const known = ["already_reset_this_window", "nothing_to_reset", "trial_active", "no_ticket", "ticket_expired"] as const;
    const hit = known.find((c) => c === code);
    return { ok: false, code: hit ?? "unavailable" };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** GET /api/friend-invite/me — 404 (switch off / old server) and any other non-200 answer is "unavailable": the panel hides. */
export async function getFriendInvite(): Promise<HubFriendInviteResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "signed_out" };
  try {
    const res = await timedFetch(cookie, `${webBaseUrl()}/api/friend-invite/me`, { headers: DESKTOP_CLIENT_HEADERS });
    if (res.status === 401) return { ok: false, code: "signed_out" };
    if (!res.ok) return { ok: false, code: "unavailable" };
    const body = (await res.json()) as { code?: unknown; url?: unknown; joined?: unknown };
    if (typeof body.code !== "string" || !/^[A-Z2-9]{8}$/.test(body.code) || typeof body.url !== "string" || !/^https:\/\/agentlas\.cloud\/i\//.test(body.url)) {
      return { ok: false, code: "unavailable" };
    }
    return { ok: true, code: body.code, url: body.url, joined: typeof body.joined === "number" && Number.isFinite(body.joined) ? Math.max(0, Math.floor(body.joined)) : 0 };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** POST /api/friend-invite/claim — every refusal is one of the contract's words; the UI never explains why a ticket was not issued. */
export async function claimFriendInvite(input: { inviteCode?: unknown }): Promise<HubFriendInviteClaimResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "signed_out" };
  const code = typeof input?.inviteCode === "string" ? input.inviteCode.trim().toUpperCase() : "";
  if (!/^[A-Z2-9]{8}$/.test(code)) return { ok: false, code: "invalid_code" };
  try {
    const res = await timedFetch(cookie, `${webBaseUrl()}/api/friend-invite/claim`, {
      method: "POST", headers: DESKTOP_CLIENT_HEADERS, body: JSON.stringify({ inviteCode: code }),
    });
    if (res.status === 401) return { ok: false, code: "signed_out" };
    if (res.status === 200) return { ok: true, ticketIssued: ((await res.json()) as { ticketIssued?: unknown }).ticketIssued === true };
    const reason = await readCode(res);
    const known = ["invalid_code", "account_too_old", "already_claimed"] as const;
    return { ok: false, code: known.find((c) => c === reason) ?? "unavailable" };
  } catch {
    return { ok: false, code: "network" };
  }
}

function isPlanOffer(value: unknown): value is BillingPlanOffer {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  const count = (key: string) => typeof plan[key] === "number" && Number.isFinite(plan[key]) && (plan[key] as number) >= 0;
  return typeof plan.id === "string" && /^[a-z]{2,16}$/.test(plan.id)
    && typeof plan.name === "string" && plan.name.length > 0 && plan.name.length <= 40
    && plan.currency === "USD"
    && count("priceMonthly") && count("priceAnnual") && count("monthlyCredits")
    && count("cloudAgentLimit") && count("projectAgentLimit")
    && typeof plan.aliveAgent === "boolean" && typeof plan.highlighted === "boolean";
}

/**
 * GET /api/billing/catalog — the deployed web's public plan catalog. No session
 * is needed; prices and allowances come from the server's own plan table so the
 * Desktop never hardcodes them. A missing or malformed response is an error the
 * UI must show as "could not load", never a guessed price.
 */
export async function getBillingPlans(): Promise<BillingPlanCatalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${webBaseUrl()}/api/billing/catalog`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "http" };
    const body = (await res.json()) as { schemaVersion?: unknown; plans?: unknown };
    if (body.schemaVersion !== 1 || !Array.isArray(body.plans) || body.plans.length === 0 || !body.plans.every(isPlanOffer)) {
      return { ok: false, error: "invalid" };
    }
    return { ok: true, plans: body.plans.map((plan) => ({ ...plan })), fetchedAt: Date.now() };
  } catch {
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/billing/config?plan=&cycle= — asked only after the owner pressed
 * "Upgrade" in the plan picker (the paywall itself is never gated on this,
 * owner 2026-09-29). `configured` and `code` are the machine fields; the
 * server's `reason` prose is never read. A failed read is its own state so the
 * picker can say "try again" instead of pretending checkout is closed.
 */
export async function getBillingCheckoutReadiness(input: { plan?: unknown; cycle?: unknown }): Promise<BillingCheckoutReadiness> {
  const plan = typeof input?.plan === "string" && /^[a-z]{2,16}$/.test(input.plan) ? input.plan : null;
  const cycle = input?.cycle === "annual" ? "annual" : "monthly";
  if (!plan) return { ok: false, error: "invalid" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${webBaseUrl()}/api/billing/config?plan=${encodeURIComponent(plan)}&cycle=${cycle}`;
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "http" };
    const body = (await res.json()) as { configured?: unknown; code?: unknown };
    if (typeof body.configured !== "boolean") return { ok: false, error: "invalid" };
    const code = typeof body.code === "string" && /^[a-z0-9_]{1,64}$/.test(body.code) ? body.code : null;
    return { ok: true, plan, cycle, open: body.configured, code: body.configured ? null : code ?? "checkout_not_configured" };
  } catch {
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** A short-lived, single-use result from the server, never supplied by renderer input. */
export interface ProjectAgentLimitGrant {
  readonly limit: number;
  readonly checkedAtMs: number;
}

const projectAgentGrants = new WeakSet<ProjectAgentLimitGrant>();
const PROJECT_AGENT_GRANT_MAX_AGE_MS = 10_000;

/*
 * Work 에이전트는 무료다(오너 결정 2026-09-25, docs/2026-09-25-onboarding-redesign/PLAN.md §3·§6).
 * 예전에는 서버 요금제의 projectAgents(Free 3 / Pro 10 …)를 받아 프로젝트 팀 크기를
 * 막았다. 이제 요금제·로그인과 무관하게 저장소 안전 상한(32)만 적용한다. grant 모양은
 * 그대로 두어 저장 경로(store/projects.ts)의 "한 번 쓰고 버리는" 계약을 바꾸지 않는다.
 */
export async function getFreshProjectAgentLimitGrant(): Promise<ProjectAgentLimitGrant> {
  const grant = Object.freeze({ limit: PROJECT_AGENT_POOL_MAX, checkedAtMs: Date.now() });
  projectAgentGrants.add(grant);
  return grant;
}

/** A store mutation consumes the grant so later writes must read the server again. */
export function consumeProjectAgentLimitGrant(grant: ProjectAgentLimitGrant | undefined): number | null {
  if (!grant || !projectAgentGrants.has(grant)) return null;
  projectAgentGrants.delete(grant);
  return Date.now() - grant.checkedAtMs <= PROJECT_AGENT_GRANT_MAX_AGE_MS ? grant.limit : null;
}

/** Legacy IPC method stays typed for older renderers but can never transfer. */
export async function transferEarnings(_credits: number): Promise<EarningsTransferResult> {
  return { ok: false, error: "marketplace_settlement_retired" };
}
