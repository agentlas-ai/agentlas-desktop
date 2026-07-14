// 엔진 사용량 커넥터 공용 헬퍼.
// 프로바이더 usage 응답의 퍼센트/리셋 시각 정규화 + 타임아웃 JSON GET.
import type { UsageProviderErrorCode } from "../../shared/types";

export interface NormalizedUsageError {
  code: UsageProviderErrorCode;
  retryAfterSeconds?: number;
}

const SAFE_ERROR_CODES = new Set<UsageProviderErrorCode>([
  "auth_expired",
  "credentials_corrupt",
  "keychain_blocked",
  "quota_exhausted",
  "unsupported_client",
  "rate_limited",
  "network_error",
  "provider_error",
  "local_estimate",
]);

/** Provider/OS 원문 오류를 Renderer-safe enum으로 축약한다. 원문·URL·로컬 경로는 반환하지 않는다. */
export function normalizeUsageError(value: unknown): NormalizedUsageError {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (SAFE_ERROR_CODES.has(message as UsageProviderErrorCode)) {
    return { code: message as UsageProviderErrorCode };
  }
  if (/HTTP 40[13]/i.test(message)) return { code: "auth_expired" };
  if (/HTTP 429/i.test(message)) {
    const parsed = Number(/retry-after=(\d+)/i.exec(message)?.[1]);
    return {
      code: "rate_limited",
      ...(Number.isFinite(parsed) && parsed > 0 ? { retryAfterSeconds: parsed } : {}),
    };
  }
  if (/HTTP (408|425|5\d\d)|fetch failed|timed? ?out|abort|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(message)) {
    return { code: "network_error" };
  }
  return { code: "provider_error" };
}

// 0–100 퍼센트로 정규화. 프로바이더 usage 엔드포인트는 이미 0–100 스케일을 주므로
// 분수(×100) 변환을 하지 않는다(그러면 1% → 100% 식으로 오스케일됨). 숫자/"NN%" 문자열 허용, 클램프.
// (agentcat float_percent와 동일.)
export function toPercent(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") n = parseFloat(v.replace(/%\s*$/, "").trim());
  else return null;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** 리셋 시각을 epoch ms로. 초(<1e12)는 ×1000, ISO 문자열은 Date.parse. */
export function toResetMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// Electron net.fetch 우선 — Chromium 네트워크 스택은 시스템 프록시·OS 신뢰 인증서를 따른다.
// (터미널 CLI는 되는데 GUI 앱의 Node fetch만 "fetch failed" 나는 프록시/보안장비 머신 대응.)
// 헤드리스/테스트 등 electron 미가용 환경은 전역 fetch 폴백.
type JsonFetch = (url: string, init?: RequestInit) => Promise<Response>;
function pickFetch(): JsonFetch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require("electron") as typeof import("electron");
    if (net && typeof net.fetch === "function") return (url, init) => net.fetch(url, init);
  } catch {
    // electron 밖(스크립트 실행 등)
  }
  return (url, init) => fetch(url, init);
}

/** 네트워크 실패의 숨은 원인(err.cause)을 메시지로 승격 — "fetch failed"만으론 진단 불가. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: string; message?: string };
    const detail = c.code || c.message;
    if (detail) return `${err.message} (${detail})`;
  }
  return err.message;
}

/** 타임아웃 있는 form-encoded POST(JSON 응답). non-2xx면 throw — OAuth 토큰 갱신용. */
export async function postForm(
  url: string,
  form: Record<string, string>,
  timeoutMs = 12000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await pickFetch()(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error(describeFetchError(err));
  } finally {
    clearTimeout(timer);
  }
}

/** 타임아웃 있는 JSON POST(JSON 본문/응답). non-2xx면 throw.
 *  net.fetch 경유(pickFetch) — Gemini 어댑터가 raw Node fetch를 쓰면 프록시/보안장비 머신에서
 *  GUI만 "fetch failed"가 나는 함정(getJson과 동일 근본원인)이 재발한다. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await pickFetch()(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error(describeFetchError(err));
  } finally {
    clearTimeout(timer);
  }
}

/** 타임아웃 있는 JSON GET. non-2xx면 throw. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await pickFetch()(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      // 429는 Retry-After를 메시지에 실어 상위(스냅샷 백오프)가 서버 지시대로 쉬게 한다.
      const retryAfter = res.status === 429 ? res.headers.get("retry-after") : null;
      throw new Error(`HTTP ${res.status}${retryAfter ? ` retry-after=${retryAfter}` : ""}`);
    }
    return await res.json();
  } catch (err) {
    throw new Error(describeFetchError(err));
  } finally {
    clearTimeout(timer);
  }
}
