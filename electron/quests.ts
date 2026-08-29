// 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체). 웹 /api/quests를 세션 쿠키로 프록시한다.
// 완료 판정: server형은 웹이 DB 증거를 검증, client-attested형은 데스크탑 로컬 행동(첫 빌드 등)을
// 근거로 1회 클레임을 수용한다(워크스페이스×퀘스트당 1회, 서버가 고정 트랜잭션 id로 이중지급 차단).
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "./auth";
import type { QuestClaimInput, QuestClaimResult, QuestListResult } from "../shared/types";

const TIMEOUT_MS = 8000;
const CLAIM_INTENT_RE = /^questclaim_[A-Za-z0-9_-]{16,120}$/u;

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

function validClaimInput(input: unknown): input is QuestClaimInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const row = input as Record<string, unknown>;
  return typeof row.questId === "string"
    && Boolean(row.questId.trim())
    && row.questId.length <= 200
    && typeof row.claimIntentId === "string"
    && CLAIM_INTENT_RE.test(row.claimIntentId);
}

function normalizeClaimReceipt(value: unknown, expected: QuestClaimInput): QuestClaimResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true
    || row.receiptVersion !== 1
    || row.questId !== expected.questId
    || row.claimIntentId !== expected.claimIntentId
    || typeof row.status !== "string") return null;
  if (row.status === "ready") {
    return {
      ok: false,
      receiptVersion: 1,
      status: "ready",
      questId: expected.questId,
      claimIntentId: expected.claimIntentId,
      code: "not_started",
    };
  }
  if (row.status !== "completed"
    || !Number.isSafeInteger(row.rewardCredits)
    || (row.rewardCredits as number) <= 0
    || typeof row.claimedAt !== "string"
    || !Number.isFinite(Date.parse(row.claimedAt))
    || typeof row.replayed !== "boolean") return null;
  return {
    ok: true,
    receiptVersion: 1,
    status: "completed",
    questId: expected.questId,
    claimIntentId: expected.claimIntentId,
    rewardCredits: row.rewardCredits as number,
    claimedAt: row.claimedAt,
    replayed: row.replayed,
  };
}

function normalizeKnownRefusal(
  status: number,
  value: unknown,
  expected: QuestClaimInput,
): QuestClaimResult | null {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const code = typeof row.code === "string" ? row.code : `http_${status}`;
  if (status === 409) {
    if ((row.code !== "already_claimed" && row.status !== "already_claimed")
      || row.questId !== expected.questId) return null;
    return {
      ok: false,
      receiptVersion: 1,
      status: "already_claimed",
      questId: expected.questId,
      claimIntentId: expected.claimIntentId,
      code: "already_claimed",
      error: typeof row.error === "string" ? row.error : undefined,
    };
  }
  if (![400, 401, 403, 404, 422, 429].includes(status)) return null;
  return {
    ok: false,
    questId: expected.questId,
    claimIntentId: expected.claimIntentId,
    code: status === 401 || status === 403 ? "unauthenticated" : code,
    error: typeof row.error === "string" ? row.error : undefined,
  };
}

function unknownClaim(input: QuestClaimInput): QuestClaimResult {
  return {
    ok: false,
    questId: input.questId,
    claimIntentId: input.claimIntentId,
    code: "outcome_unknown",
    outcomeUnknown: true,
  };
}

/** GET one stable claim intent. This is the only recovery path after an ambiguous POST. */
export async function getQuestClaimStatus(input: QuestClaimInput): Promise<QuestClaimResult> {
  if (!validClaimInput(input)) return { ok: false, code: "invalid_claim_intent" };
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const query = new URLSearchParams({ questId: input.questId, claimIntentId: input.claimIntentId });
    const res = await timedFetch(cookie, `${base}/api/quests/claim?${query.toString()}`);
    const raw = await res.json().catch(() => null);
    if (res.ok) return normalizeClaimReceipt(raw, input) ?? unknownClaim(input);
    return normalizeKnownRefusal(res.status, raw, input) ?? unknownClaim(input);
  } catch {
    return unknownClaim(input);
  }
}

/** POST one persist-before-send claim intent, then reconcile that same intent on ambiguity. */
export async function claimQuest(input: QuestClaimInput): Promise<QuestClaimResult> {
  if (!validClaimInput(input)) return { ok: false, code: "invalid_claim_intent" };
  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, code: "unauthenticated" };
  try {
    const base = webBaseUrl();
    const res = await timedFetch(cookie, `${base}/api/quests/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(input),
    });
    const raw = await res.json().catch(() => null);
    if (res.ok) {
      const exact = normalizeClaimReceipt(raw, input);
      if (exact?.ok) return exact;
    } else {
      const known = normalizeKnownRefusal(res.status, raw, input);
      if (known) return known;
    }
  } catch {
    // The server may have committed before the transport failed. Never issue a
    // fresh mutation here; query the exact same action below.
  }
  return getQuestClaimStatus(input);
}
