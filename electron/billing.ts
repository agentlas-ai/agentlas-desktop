// AI 사용 크레딧 잔액은 공개 Hub 에이전트의 가격과 별개다.
// 과거 Hub 렌트 수익 전송은 마켓플레이스 정산 영구 폐쇄로 비활성화한다.
// 인증은 auth.ts의 세션 쿠키를 사용한다.
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "./auth";
import type { BillingPlanCatalog, BillingPlanOffer, EarningsTransferResult, HubCreditBalance } from "../shared/types";

const TIMEOUT_MS = 8000;

// 세션 쿠키 호출은 전부 auth.fetchWithHubSession 경유 — 401이면 auth 캐시 세션까지 폐기된다.
// (직접 fetch로 돌아가면 "크레딧만 사라지고 계정 칩은 로그인 상태" 불일치가 되살아난다.)
async function timedFetch(cookie: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithHubSession(cookie, url, init, TIMEOUT_MS);
}

/** GET /api/billing/credits — AI 사용 잔액 조회. 미로그인은 authenticated:false. */
export async function getBillingCredits(): Promise<HubCreditBalance> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { authenticated: false };
  try {
    const res = await timedFetch(cookie, `${webBaseUrl()}/api/billing/credits`);
    // 401 = 세션 무효 — 미인증으로 강등. 세션 폐기는 fetchWithHubSession이 이미 처리했으므로
    // 계정 칩도 같은 틱에 로그아웃 상태로 내려간다.
    if (res.status === 401) return { authenticated: false };
    if (!res.ok) return { authenticated: true, error: `http_${res.status}` };
    const balance = (await res.json()) as HubCreditBalance;
    // The server may still include a historic creator wallet. Never project it
    // into current Desktop or paired Mobile clients after settlement closure.
    delete balance.earningsCredits;
    return balance;
  } catch {
    return { authenticated: true, error: "network" };
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

export type AliveAgentAccess = "allowed" | "alive-sign-in-required" | "alive-plan-required" | "alive-entitlement-unavailable";

/** Fresh Main-side check for both enabling a life and admitting its next wake. */
export async function checkAliveAgentAccess(): Promise<AliveAgentAccess> {
  const balance = await getBillingCredits();
  if (!balance.authenticated) return "alive-sign-in-required";
  if (balance.error || typeof balance.entitlements?.aliveAgent !== "boolean") return "alive-entitlement-unavailable";
  return balance.entitlements.aliveAgent ? "allowed" : "alive-plan-required";
}

/** A short-lived, single-use result from the server, never supplied by renderer input. */
export interface ProjectAgentLimitGrant {
  readonly limit: number;
  readonly checkedAtMs: number;
}

const projectAgentGrants = new WeakSet<ProjectAgentLimitGrant>();
const PROJECT_AGENT_GRANT_MAX_AGE_MS = 10_000;

export async function getFreshProjectAgentLimitGrant(): Promise<ProjectAgentLimitGrant> {
  const balance = await getBillingCredits();
  if (!balance.authenticated) throw new Error("[agentlas:code=project-agent-sign-in-required] Sign in to add project agents or teams.");
  const limit = balance.entitlements?.projectAgents;
  if (balance.error || !Number.isSafeInteger(limit) || limit === undefined || limit < 0 || limit > 32) {
    throw new Error("[agentlas:code=project-agent-entitlement-unavailable] Could not verify the project agent limit. Check your connection and try again.");
  }
  const grant = Object.freeze({ limit, checkedAtMs: Date.now() });
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
