// AI 사용 크레딧 잔액은 공개 Hub 에이전트의 가격과 별개다.
// 과거 Hub 렌트 수익 전송은 마켓플레이스 정산 영구 폐쇄로 비활성화한다.
// 인증은 auth.ts의 세션 쿠키를 사용한다.
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "./auth";
import type { EarningsTransferResult, HubCreditBalance } from "../shared/types";

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

export type AliveAgentAccess = "allowed" | "alive-sign-in-required" | "alive-plan-required" | "alive-entitlement-unavailable";

/** Fresh Main-side check for both enabling a life and admitting its next wake. */
export async function checkAliveAgentAccess(): Promise<AliveAgentAccess> {
  const balance = await getBillingCredits();
  if (!balance.authenticated) return "alive-sign-in-required";
  if (balance.error || typeof balance.entitlements?.aliveAgent !== "boolean") return "alive-entitlement-unavailable";
  return balance.entitlements.aliveAgent ? "allowed" : "alive-plan-required";
}

/** Legacy IPC method stays typed for older renderers but can never transfer. */
export async function transferEarnings(_credits: number): Promise<EarningsTransferResult> {
  return { ok: false, error: "marketplace_settlement_retired" };
}
