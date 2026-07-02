// 엔진 사용량 매니저 — 구독형 프로바이더(Claude/Codex/Gemini)의 usage를 모아
// 정규화된 UsageSnapshot으로. main에서 60초 캐시(엔드포인트 과호출 방지).
//
// 일시 장애 내성: HTTP 429/네트워크류 실패는 "조회 실패" UI로 떨어뜨리지 않고
// 마지막 정상 스냅샷(30분 내)을 유지한다 — 429는 5분 백오프, force 폴링(재로그인 감지
// 5초 폴링 등)도 프로바이더당 최소 10초 간격으로 묶어 rate-limit 자체를 유발하지 않게 한다.
//
// API 키형(DeepSeek·GLM·Grok·Pi 등)은 구독 rate-limit 창이 없어(키 과금) 여기서 다루지 않고,
// 로컬(Ollama)은 무제한 — 둘 다 대시보드 "연결" 칩은 runtime.detect가 담당한다.
// 향후 프로바이더는 이 배열에 어댑터만 추가하면 됨.
import type { ProviderUsage, UsageSnapshot } from "../../shared/types";
import { getClaudeUsage } from "./claude";
import { getCodexUsage } from "./codex";
import { getGeminiUsage } from "./gemini";

const TTL_MS = 60_000;
const FORCE_MIN_MS = 10_000; // force여도 프로바이더당 최소 재조회 간격
const LAST_GOOD_MAX_MS = 30 * 60_000; // 일시 장애 시 정상 스냅샷을 대신 보여줄 최대 나이
const BACKOFF_429_MS = 5 * 60_000; // rate-limit 맞으면 그 프로바이더만 쉰다
// 인증 문제(auth_expired)는 일시 장애가 아니다 — 그건 그대로 표면화해 재로그인 액션을 준다.
const TRANSIENT_RE = /HTTP (408|425|429|5\d\d)|fetch failed|timed? ?out|abort|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i;

let cache: { snapshot: UsageSnapshot; at: number } | null = null;
const lastResult = new Map<string, { usage: ProviderUsage; at: number }>();
const lastGood = new Map<string, { usage: ProviderUsage; at: number }>();
const backoffUntil = new Map<string, number>();

const ADAPTERS: Array<{ id: string; fn: () => Promise<ProviderUsage | null> }> = [
  { id: "claude-code", fn: getClaudeUsage },
  { id: "codex", fn: getCodexUsage },
  { id: "gemini", fn: getGeminiUsage },
];

async function fetchProvider(
  id: string,
  fn: () => Promise<ProviderUsage | null>,
  now: number,
): Promise<ProviderUsage | null> {
  const last = lastResult.get(id);
  if ((backoffUntil.get(id) ?? 0) > now && last) return last.usage;
  if (last && now - last.at < FORCE_MIN_MS) return last.usage;

  let usage: ProviderUsage | null = null;
  try {
    usage = await fn();
  } catch (err) {
    usage = null;
    console.warn(`[usage] adapter ${id} threw:`, err instanceof Error ? err.message : err);
  }
  if (!usage) return null; // 미연결 — 스냅샷에서 제외

  if (usage.status === "error" && usage.error && TRANSIENT_RE.test(usage.error)) {
    if (/HTTP 429/.test(usage.error)) backoffUntil.set(id, now + BACKOFF_429_MS);
    const good = lastGood.get(id);
    if (good && now - good.at < LAST_GOOD_MAX_MS) {
      // 일시 장애 — 에러 UI 대신 마지막 정상 수치를 유지(다음 주기에 자연 회복).
      lastResult.set(id, { usage: good.usage, at: now });
      return good.usage;
    }
  }
  if (usage.status === "ok" || usage.status === "no_quota") {
    lastGood.set(id, { usage, at: now });
    backoffUntil.delete(id);
  }
  lastResult.set(id, { usage, at: now });
  return usage;
}

export async function getUsageSnapshot(opts?: { force?: boolean }): Promise<UsageSnapshot> {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.at < TTL_MS) {
    return cache.snapshot;
  }
  const results = await Promise.allSettled(ADAPTERS.map((a) => fetchProvider(a.id, a.fn, now)));
  const providers: ProviderUsage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) providers.push(r.value);
  }
  const snapshot: UsageSnapshot = { providers, fetchedAt: now };
  cache = { snapshot, at: now };
  return snapshot;
}
