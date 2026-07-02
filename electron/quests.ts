// 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체). 웹 /api/quests를 세션 쿠키로 프록시한다.
// 완료 판정: server형은 웹이 DB 증거를 검증, client-attested형은 데스크탑 로컬 행동(첫 빌드 등)을
// 근거로 1회 클레임을 수용한다(워크스페이스×퀘스트당 1회, 서버가 고정 트랜잭션 id로 이중지급 차단).
import { getSessionCookieHeader, webBaseUrl } from "./auth";
import type { QuestClaimResult, QuestListResult } from "../shared/types";

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

/** GET /api/quests — 퀘스트 정의 + 내 클레임 상태. 미로그인은 authenticated:false. */
export async function listQuests(): Promise<QuestListResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, authenticated: false, quests: [] };
  try {
    const res = await timedFetch(`${webBaseUrl()}/api/quests`, { headers: { cookie } });
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
    const res = await timedFetch(`${base}/api/quests/claim`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ questId }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        code: typeof json.code === "string" ? json.code : `http_${res.status}`,
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
