// 프롬프트 저장소 — main 프로세스에서 세션 쿠키로 웹(agentlas.cloud) 프롬프트 API를 호출한다.
// billing.ts와 동일 패턴: agentlas_session 쿠키 재첨부 + 변이(POST/DELETE)는 CSRF 미들웨어의
// same-origin 가드를 통과하도록 Origin 헤더를 사이트 오리진으로 보낸다.
//
// 수익화 정책(2026-07 개편): 크레딧 언락 폐지 —
//   · 유료 구독(paidAccess): 언락 무제한(과금 0) + 북마크 저장 가능
//   · 무료: 프롬프트당 1회 맛보기(taste, body는 taste 응답에서만) + 저장 불가
//   · 402 subscription_required / 409 already_tasted → 렌더러가 /pricing CTA 표시
import { getSessionCookieHeader, webBaseUrl } from "./auth";
import type {
  HubPromptBookmarkResult,
  HubPromptCatalog,
  HubPromptDetailResult,
  HubPromptOpenResult,
  HubPromptTastesResult,
} from "../shared/types";

const TIMEOUT_MS = 10_000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(): Record<string, string> {
  const cookie = getSessionCookieHeader();
  return cookie ? { cookie } : {};
}

/** GET /api/prompts — 공개 카탈로그(비로그인 가능). 로그인 시 unlocked/tasted/bookmarked/viewer 포함. */
export async function listHubPrompts(params?: { q?: string; category?: string }): Promise<HubPromptCatalog> {
  try {
    const qs = new URLSearchParams();
    if (params?.q?.trim()) qs.set("q", params.q.trim());
    if (params?.category?.trim()) qs.set("category", params.category.trim());
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    const res = await timedFetch(`${webBaseUrl()}/api/prompts${suffix}`, { headers: authHeaders() });
    if (!res.ok) return { ok: false, prompts: [], viewer: null, error: `http_${res.status}` };
    const json = (await res.json()) as { prompts?: HubPromptCatalog["prompts"]; viewer?: HubPromptCatalog["viewer"] };
    return { ok: true, prompts: json.prompts ?? [], viewer: json.viewer ?? null };
  } catch {
    return { ok: false, prompts: [], viewer: null, error: "network" };
  }
}

/** GET /api/prompts/[slug] — 상세(공개). body/tips는 언락/소유 시에만 포함. */
export async function getHubPrompt(slug: string): Promise<HubPromptDetailResult> {
  try {
    const res = await timedFetch(`${webBaseUrl()}/api/prompts/${encodeURIComponent(slug)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = (await res.json()) as { prompt?: HubPromptDetailResult["prompt"] } & Record<string, unknown>;
    // 응답이 {prompt} 래핑 또는 평평한 형태 둘 다 방어적으로 수용
    const prompt = (json.prompt ?? json) as HubPromptDetailResult["prompt"];
    return { ok: true, prompt };
  } catch {
    return { ok: false, error: "network" };
  }
}

function normalizeOpen(json: Record<string, unknown>, httpOk: boolean, status: number): HubPromptOpenResult {
  return {
    ok: httpOk && json.ok !== false,
    body: typeof json.body === "string" ? json.body : undefined,
    tipsKo: typeof json.tipsKo === "string" ? json.tipsKo : undefined,
    tipsEn: typeof json.tipsEn === "string" ? json.tipsEn : undefined,
    alreadyUnlocked: json.alreadyUnlocked === true,
    tasted: json.tasted === true,
    code: typeof json.code === "string" ? json.code : httpOk ? undefined : `http_${status}`,
    error: typeof json.error === "string" ? json.error : undefined,
    upgradeUrl: typeof json.upgradeUrl === "string" ? json.upgradeUrl : undefined,
  };
}

/** POST /api/prompts/[slug]/unlock — 구독자 열람(과금 0). 무료 플랜은 402 subscription_required. */
export async function unlockHubPrompt(slug: string): Promise<HubPromptOpenResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/${encodeURIComponent(slug)}/unlock`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: "{}",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return normalizeOpen(json, res.ok, res.status);
  } catch {
    return { ok: false, code: "network" };
  }
}

/** POST /api/prompts/[slug]/taste — 무료 1회 맛보기. body는 이 응답에서만 온다. 재시도 409. */
export async function tasteHubPrompt(slug: string): Promise<HubPromptOpenResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/${encodeURIComponent(slug)}/taste`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: "{}",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return normalizeOpen(json, res.ok, res.status);
  } catch {
    return { ok: false, code: "network" };
  }
}

/** GET /api/prompts/tastes — 내 맛보기 사용 이력(CTA 판단용: 3회 이상이면 구독 유도). */
export async function listHubPromptTastes(): Promise<HubPromptTastesResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, count: 0, slugs: [], code: "unauthenticated" };
  try {
    const res = await timedFetch(`${webBaseUrl()}/api/prompts/tastes`, { headers: { cookie } });
    if (!res.ok) return { ok: false, count: 0, slugs: [], code: `http_${res.status}` };
    const json = (await res.json()) as { tastes?: Array<{ promptSlug?: string }>; count?: number };
    const slugs = (json.tastes ?? []).map((t) => t.promptSlug ?? "").filter(Boolean);
    return { ok: true, count: json.count ?? slugs.length, slugs };
  } catch {
    return { ok: false, count: 0, slugs: [], code: "network" };
  }
}

/** GET /api/prompts/bookmarks — 내 저장 목록(유료 전용 기능). */
export async function listHubPromptBookmarks(): Promise<{ ok: boolean; slugs: string[]; code?: string }> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, slugs: [], code: "unauthenticated" };
  try {
    const res = await timedFetch(`${webBaseUrl()}/api/prompts/bookmarks`, { headers: { cookie } });
    if (!res.ok) return { ok: false, slugs: [], code: `http_${res.status}` };
    const json = (await res.json()) as { bookmarks?: Array<{ promptSlug?: string }> };
    return { ok: true, slugs: (json.bookmarks ?? []).map((b) => b.promptSlug ?? "").filter(Boolean) };
  } catch {
    return { ok: false, slugs: [], code: "network" };
  }
}

/** POST /api/prompts/bookmarks {slug} — 저장. 무료 플랜 402 subscription_required. */
export async function addHubPromptBookmark(slug: string): Promise<HubPromptBookmarkResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/bookmarks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ slug }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        code: typeof json.code === "string" ? json.code : `http_${res.status}`,
        error: typeof json.error === "string" ? json.error : undefined,
      };
    }
    return { ok: true, bookmarked: true };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** DELETE /api/prompts/bookmarks/[slug] — 저장 해제. */
export async function removeHubPromptBookmark(slug: string): Promise<HubPromptBookmarkResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/bookmarks/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { cookie, origin: base },
    });
    if (!res.ok) return { ok: false, code: `http_${res.status}` };
    return { ok: true, bookmarked: false };
  } catch {
    return { ok: false, code: "network" };
  }
}
