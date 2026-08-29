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

const TASTE_INTENT_RE = /^taste_[A-Za-z0-9_-]{24,120}$/u;
const UNLOCK_INTENT_RE = /^unlock_[A-Za-z0-9_-]{24,120}$/u;

function validTasteInput(input: { slug?: unknown; tasteIntentId?: unknown }): input is { slug: string; tasteIntentId: string } {
  return typeof input?.slug === "string"
    && Boolean(input.slug.trim())
    && input.slug.length <= 160
    && typeof input.tasteIntentId === "string"
    && TASTE_INTENT_RE.test(input.tasteIntentId);
}

function validUnlockInput(input: { slug?: unknown; unlockIntentId?: unknown }): input is { slug: string; unlockIntentId: string } {
  return typeof input?.slug === "string"
    && Boolean(input.slug.trim())
    && input.slug.length <= 160
    && typeof input.unlockIntentId === "string"
    && UNLOCK_INTENT_RE.test(input.unlockIntentId);
}

function normalizeUnlockStatus(
  value: unknown,
  expected: { slug: string; unlockIntentId: string },
): HubPromptOpenResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true
    || row.receiptVersion !== 1
    || row.slug !== expected.slug
    || row.unlockIntentId !== expected.unlockIntentId
    || typeof row.status !== "string") return null;

  const copy = {
    ok: true as const,
    receiptVersion: 1 as const,
    slug: expected.slug,
    unlockIntentId: expected.unlockIntentId,
    ...(typeof row.tipsKo === "string" ? { tipsKo: row.tipsKo } : {}),
    ...(typeof row.tipsEn === "string" ? { tipsEn: row.tipsEn } : {}),
  };
  if (row.status === "ready") {
    return row.unlocked === false
      ? { ...copy, status: "ready", unlocked: false }
      : null;
  }
  if (row.status === "not_required") {
    return row.unlocked === true
      && row.alreadyUnlocked === true
      && row.isOwner === true
      && typeof row.body === "string"
      ? {
          ...copy,
          status: "not_required",
          unlocked: true,
          alreadyUnlocked: true,
          isOwner: true,
          body: row.body,
        }
      : null;
  }
  if (row.status === "already_unlocked") {
    return row.unlocked === true
      && row.alreadyUnlocked === true
      && row.isOwner === false
      && typeof row.body === "string"
      ? {
          ...copy,
          status: "already_unlocked",
          unlocked: true,
          alreadyUnlocked: true,
          isOwner: false,
          body: row.body,
        }
      : null;
  }
  if (row.status !== "completed"
    || row.unlocked !== true
    || typeof row.alreadyUnlocked !== "boolean"
    || row.isOwner !== false
    || typeof row.replayed !== "boolean"
    || row.charged !== 0
    || typeof row.body !== "string"
    || typeof row.completedAt !== "string"
    || !Number.isFinite(Date.parse(row.completedAt))) return null;
  return {
    ...copy,
    status: "completed",
    unlocked: true,
    alreadyUnlocked: row.alreadyUnlocked,
    isOwner: false,
    replayed: row.replayed,
    charged: 0,
    body: row.body,
    completedAt: row.completedAt,
  };
}

function normalizeTasteStatus(
  value: unknown,
  expected: { slug: string; tasteIntentId: string },
): HubPromptOpenResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true
    || row.receiptVersion !== 1
    || row.slug !== expected.slug
    || row.tasteIntentId !== expected.tasteIntentId
    || typeof row.status !== "string") return null;
  if (row.status === "ready" || row.status === "not_required") {
    if (row.tasted !== false) return null;
    if (row.body !== undefined && typeof row.body !== "string") return null;
    if (row.tipsKo !== undefined && typeof row.tipsKo !== "string") return null;
    if (row.tipsEn !== undefined && typeof row.tipsEn !== "string") return null;
    return {
      ok: true,
      receiptVersion: 1,
      status: row.status,
      slug: expected.slug,
      tasteIntentId: expected.tasteIntentId,
      tasted: false,
      ...(typeof row.body === "string" ? { body: row.body } : {}),
      ...(typeof row.tipsKo === "string" ? { tipsKo: row.tipsKo } : {}),
      ...(typeof row.tipsEn === "string" ? { tipsEn: row.tipsEn } : {}),
    };
  }
  if (row.status === "processing" || row.status === "consumed") {
    if (row.tasted !== true) return null;
    return {
      ok: true,
      receiptVersion: 1,
      status: row.status,
      slug: expected.slug,
      tasteIntentId: expected.tasteIntentId,
      tasted: true,
    };
  }
  if (row.status !== "completed"
    || row.tasted !== true
    || typeof row.replayed !== "boolean"
    || typeof row.body !== "string"
    || typeof row.completedAt !== "string"
    || !Number.isFinite(Date.parse(row.completedAt))) return null;
  if (row.tipsKo !== undefined && typeof row.tipsKo !== "string") return null;
  if (row.tipsEn !== undefined && typeof row.tipsEn !== "string") return null;
  return {
    ok: true,
    receiptVersion: 1,
    status: "completed",
    slug: expected.slug,
    tasteIntentId: expected.tasteIntentId,
    tasted: true,
    replayed: row.replayed,
    body: row.body,
    completedAt: row.completedAt,
    ...(typeof row.tipsKo === "string" ? { tipsKo: row.tipsKo } : {}),
    ...(typeof row.tipsEn === "string" ? { tipsEn: row.tipsEn } : {}),
  };
}

/** Read-only recovery/replay for one stable paid-open intent. */
export async function getHubPromptUnlockStatus(
  input: { slug: string; unlockIntentId: string },
): Promise<HubPromptOpenResult> {
  if (!validUnlockInput(input)) return { ok: false, code: "invalid_unlock_intent" };
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const query = new URLSearchParams({ unlockIntentId: input.unlockIntentId });
    const res = await timedFetch(`${base}/api/prompts/${encodeURIComponent(input.slug)}/unlock?${query.toString()}`, {
      headers: { cookie },
    });
    const raw = await res.json().catch(() => null);
    if (!res.ok) {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        ok: false,
        slug: input.slug,
        unlockIntentId: input.unlockIntentId,
        code: typeof row.code === "string" ? row.code : `http_${res.status}`,
        error: typeof row.error === "string" ? row.error : undefined,
        upgradeUrl: typeof row.upgradeUrl === "string" ? row.upgradeUrl : undefined,
      };
    }
    return normalizeUnlockStatus(raw, input) ?? {
      ok: false,
      slug: input.slug,
      unlockIntentId: input.unlockIntentId,
      code: "outcome_unknown",
      outcomeUnknown: true,
    };
  } catch {
    return {
      ok: false,
      slug: input.slug,
      unlockIntentId: input.unlockIntentId,
      code: "outcome_unknown",
      outcomeUnknown: true,
    };
  }
}

/** POST a stable paid-open intent, then reconcile the same intent after ambiguous transport. */
export async function unlockHubPrompt(
  input: { slug: string; unlockIntentId: string },
): Promise<HubPromptOpenResult> {
  if (!validUnlockInput(input)) return { ok: false, code: "invalid_unlock_intent" };
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  let knownRefusal: HubPromptOpenResult | null = null;
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/${encodeURIComponent(input.slug)}/unlock`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ unlockIntentId: input.unlockIntentId }),
    });
    const raw = await res.json().catch(() => null);
    if (res.ok) {
      const exact = normalizeUnlockStatus(raw, input);
      if (exact) return exact;
    } else {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const code = typeof row.code === "string" ? row.code : `http_${res.status}`;
      if ([400, 401, 402, 403, 404, 409, 429].includes(res.status)) {
        knownRefusal = {
          ok: false,
          slug: input.slug,
          unlockIntentId: input.unlockIntentId,
          code,
          error: typeof row.error === "string" ? row.error : undefined,
          upgradeUrl: typeof row.upgradeUrl === "string" ? row.upgradeUrl : undefined,
        };
      }
    }
  } catch {
    // The server may have committed ownership before the response was lost.
  }
  if (knownRefusal) return knownRefusal;

  const status = await getHubPromptUnlockStatus(input);
  if (!status.ok) return status;
  if (status.status === "completed"
    || status.status === "already_unlocked"
    || status.status === "not_required") return status;
  if (status.status === "ready") return { ...status, ok: false, code: "not_started" };
  return { ...status, ok: false, code: "outcome_unknown", outcomeUnknown: true };
}

/** Read-only recovery for one stable taste intent. */
export async function getHubPromptTasteStatus(
  input: { slug: string; tasteIntentId: string },
): Promise<HubPromptOpenResult> {
  if (!validTasteInput(input)) return { ok: false, code: "invalid_taste_intent" };
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const query = new URLSearchParams({ tasteIntentId: input.tasteIntentId });
    const res = await timedFetch(`${base}/api/prompts/${encodeURIComponent(input.slug)}/taste?${query.toString()}`, {
      headers: { cookie },
    });
    const raw = await res.json().catch(() => null);
    if (!res.ok) {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        ok: false,
        slug: input.slug,
        tasteIntentId: input.tasteIntentId,
        code: typeof row.code === "string" ? row.code : `http_${res.status}`,
      };
    }
    return normalizeTasteStatus(raw, input) ?? {
      ok: false,
      slug: input.slug,
      tasteIntentId: input.tasteIntentId,
      code: "outcome_unknown",
      outcomeUnknown: true,
    };
  } catch {
    return {
      ok: false,
      slug: input.slug,
      tasteIntentId: input.tasteIntentId,
      code: "outcome_unknown",
      outcomeUnknown: true,
    };
  }
}

/** POST a stable taste intent, then reconcile the same intent on ambiguous transport/receipts. */
export async function tasteHubPrompt(
  input: { slug: string; tasteIntentId: string },
): Promise<HubPromptOpenResult> {
  if (!validTasteInput(input)) return { ok: false, code: "invalid_taste_intent" };
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  let knownRefusal: HubPromptOpenResult | null = null;
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/${encodeURIComponent(input.slug)}/taste`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ tasteIntentId: input.tasteIntentId }),
    });
    const raw = await res.json().catch(() => null);
    if (res.ok) {
      const exact = normalizeTasteStatus(raw, input);
      if (exact) return exact;
    } else {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const code = typeof row.code === "string" ? row.code : `http_${res.status}`;
      if ([400, 401, 402, 403, 404, 409, 429].includes(res.status)) {
        knownRefusal = {
          ok: false,
          slug: input.slug,
          tasteIntentId: input.tasteIntentId,
          code,
          error: typeof row.error === "string" ? row.error : undefined,
          upgradeUrl: typeof row.upgradeUrl === "string" ? row.upgradeUrl : undefined,
        };
      }
    }
  } catch {
    // The server may have durably completed the exact intent. Reconcile below.
  }
  if (knownRefusal) return knownRefusal;

  const status = await getHubPromptTasteStatus(input);
  if (!status.ok) return status;
  if (status.status === "completed") return status;
  if (status.status === "ready") {
    return { ...status, ok: false, code: "not_started" };
  }
  if (status.status === "consumed") {
    return { ...status, ok: false, code: "already_tasted" };
  }
  if (status.status === "not_required") {
    return { ...status, ok: false, code: "not_required" };
  }
  return { ...status, ok: false, code: "processing", outcomeUnknown: true };
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
  if (!cookie) return { ok: false, slug, bookmarked: false, code: "unauthenticated" };
  let mutationKnownRefusal: HubPromptBookmarkResult | null = null;
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/bookmarks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ slug }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.code === "string" ? json.code : `http_${res.status}`;
      if (["unauthenticated", "authentication_required", "subscription_required", "invalid_slug", "not_found"].includes(code)) {
        mutationKnownRefusal = {
          ok: false,
          slug,
          bookmarked: false,
          code,
          error: typeof json.error === "string" ? json.error : undefined,
        };
      }
    } else if (json.bookmarked !== true
      || !json.bookmark
      || typeof json.bookmark !== "object"
      || (json.bookmark as Record<string, unknown>).promptSlug !== slug) {
      // The mutation may have committed even when its receipt was malformed.
      // Fall through to the authoritative bookmark projection below.
    }
  } catch {
    // A transport failure can happen after the server committed the mutation.
    // Never invite a repeat until an authoritative read resolves the outcome.
  }

  if (mutationKnownRefusal) return mutationKnownRefusal;
  const projected = await listHubPromptBookmarks();
  if (!projected.ok) {
    return {
      ok: false,
      slug,
      code: "outcome_unknown",
      outcomeUnknown: true,
      error: projected.code,
    };
  }
  const bookmarked = projected.slugs.includes(slug);
  if (!bookmarked) {
    return {
      ok: false,
      slug,
      bookmarked: false,
      verified: true,
      code: "state_mismatch",
    };
  }
  return { ok: true, slug, bookmarked: true, verified: true };
}

/** DELETE /api/prompts/bookmarks/[slug] — 저장 해제. */
export async function removeHubPromptBookmark(slug: string): Promise<HubPromptBookmarkResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, slug, bookmarked: true, code: "unauthenticated" };
  let mutationKnownRefusal: HubPromptBookmarkResult | null = null;
  try {
    const base = webBaseUrl();
    const res = await timedFetch(`${base}/api/prompts/bookmarks/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { cookie, origin: base },
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.code === "string" ? json.code : `http_${res.status}`;
      if (["unauthenticated", "authentication_required", "subscription_required", "invalid_slug", "not_found"].includes(code)) {
        mutationKnownRefusal = {
          ok: false,
          slug,
          bookmarked: true,
          code,
          error: typeof json.error === "string" ? json.error : undefined,
        };
      }
    } else if (json.bookmarked !== false || json.promptSlug !== slug || typeof json.deleted !== "boolean") {
      // Malformed success is ambiguous until the authoritative projection is read.
    }
  } catch {
    // See addHubPromptBookmark: reconcile before a user-visible retry.
  }

  if (mutationKnownRefusal) return mutationKnownRefusal;
  const projected = await listHubPromptBookmarks();
  if (!projected.ok) {
    return {
      ok: false,
      slug,
      code: "outcome_unknown",
      outcomeUnknown: true,
      error: projected.code,
    };
  }
  const bookmarked = projected.slugs.includes(slug);
  if (bookmarked) {
    return {
      ok: false,
      slug,
      bookmarked: true,
      verified: true,
      code: "state_mismatch",
    };
  }
  return { ok: true, slug, bookmarked: false, verified: true };
}
