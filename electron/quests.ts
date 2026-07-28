// 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체). 웹 /api/quests를 세션 쿠키로 프록시한다.
// 완료 판정: server형은 웹이 DB 증거를 검증, client-attested형은 데스크탑 로컬 행동(첫 빌드 등)을
// 근거로 1회 클레임을 수용한다(워크스페이스×퀘스트당 1회, 서버가 고정 트랜잭션 id로 이중지급 차단).
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "./auth";
import type { QuestClaimResult, QuestListResult } from "../shared/types";

const TIMEOUT_MS = 8000;

// 세션 쿠키 호출은 전부 auth.fetchWithHubSession 경유 — 401이면 auth 캐시 세션까지 폐기된다.
// (퀘스트만 조용히 비면 계정 칩은 로그인 상태로 남아 "로그인됐는데 아무것도 없음"이 된다.)
async function timedFetch(cookie: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithHubSession(cookie, url, init, TIMEOUT_MS);
}

/** GET /api/quests — 퀘스트 정의 + 내 클레임 상태. 미로그인은 authenticated:false. */
export async function listQuests(): Promise<QuestListResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, authenticated: false, quests: [] };
  try {
    const res = await timedFetch(cookie, `${webBaseUrl()}/api/quests`);
    // 쿠키가 있어도 서버가 401/403이면 세션은 죽은 것 — authenticated:true로 보고하면
    // 렌더러가 로그인 CTA 대신 일반 에러만 띄우는 막다른 길이 된다(쿠키 부재 경로와 동일 상태).
    if (res.status === 401 || res.status === 403) {
      return { ok: false, authenticated: false, quests: [], error: `http_${res.status}` };
    }
    if (!res.ok) return { ok: false, authenticated: true, quests: [], error: `http_${res.status}` };
    const json = (await res.json()) as { quests?: QuestListResult["quests"] };
    return { ok: true, authenticated: true, quests: json.quests ?? [] };
  } catch {
    return { ok: false, authenticated: true, quests: [], error: "network" };
  }
}

/** POST /api/quests/claim {questId} — 보상 크레딧 수령. 409 already_claimed / 422 not_completed. */
export async function claimQuest(questId: string): Promise<QuestClaimResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(cookie, `${base}/api/quests/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ questId }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // 만료 세션(401/403)은 "수령 실패"가 아니라 미로그인이다 — 렌더러가 로그인 상태를
      // 되돌릴 수 있도록 code를 unauthenticated로 정규화한다.
      const authFailed = res.status === 401 || res.status === 403;
      return {
        ok: false,
        code: typeof json.code === "string" ? json.code : authFailed ? "unauthenticated" : `http_${res.status}`,
        error: typeof json.error === "string" ? json.error : undefined,
      };
    }
    return {
      ok: true,
      questId: typeof json.questId === "string" ? json.questId : questId,
      rewardCredits: typeof json.rewardCredits === "number" ? json.rewardCredits : undefined,
    };
  } catch {
    return { ok: false, code: "network" };
  }
}
