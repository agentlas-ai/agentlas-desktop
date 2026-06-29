// Agentlas Hub 크레딧 — main 프로세스에서 세션 쿠키로 Hub HTTP API를 호출한다.
//
// 인증은 auth.ts가 보관하는 agentlas_session 쿠키를 재첨부하는 방식(= fetchAccountMeta와
// 동일 패턴). 두 계좌 정책:
//   · 구독 계좌(A): remainingCredits — 월 초기화 + 톱업 + 전송받은 렌트수익. 사용 가능.
//   · 렌트수익 계좌(B): earningsCredits — 내 업로드를 남이 빌려 쓸 때만 쌓임. 이동 가능.
//   · 전송은 B → A 한 방향뿐(서버에 역방향 타입 자체가 없음).
import { getSessionCookieHeader, webBaseUrl } from "./auth";
import type { EarningsTransferResult, HubCreditBalance } from "../shared/types";

const TIMEOUT_MS = 8000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/billing/credits — 구독(A) + 렌트수익(B) 잔액을 한 번에. 미로그인은 authenticated:false. */
export async function getBillingCredits(): Promise<HubCreditBalance> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { authenticated: false };
  try {
    const res = await timedFetch(`${webBaseUrl()}/api/billing/credits`, {
      headers: { cookie },
    });
    if (!res.ok) return { authenticated: true, error: `http_${res.status}` };
    return (await res.json()) as HubCreditBalance;
  } catch {
    return { authenticated: true, error: "network" };
  }
}

/** POST /api/billing/earnings/transfer — 렌트수익(B) → 구독(A) 일방 전송.
 *  미들웨어의 same-origin 변형 가드(403)를 통과하도록 Origin 헤더를 사이트 오리진으로 보낸다. */
export async function transferEarnings(credits: number): Promise<EarningsTransferResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, error: "unauthenticated" };
  const amount = Math.floor(Number(credits));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/billing/earnings/transfer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ credits: amount }),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<EarningsTransferResult> & {
      error?: string;
    };
    if (!res.ok) return { ok: false, error: json.error || `http_${res.status}` };
    return {
      ok: true,
      moved: json.moved,
      earningsCredits: json.earningsCredits,
      remainingCredits: json.remainingCredits,
    };
  } catch {
    return { ok: false, error: "network" };
  }
}
