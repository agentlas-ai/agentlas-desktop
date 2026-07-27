// 엔진 사용량 매니저 — 구독형 프로바이더(Claude/Codex/Gemini/Grok)의 usage를 모아
// 정규화된 UsageSnapshot으로. main에서 60초 캐시(엔드포인트 과호출 방지).
//
// 일시 장애 내성: HTTP 429/네트워크류 실패는 "조회 실패" UI로 떨어뜨리지 않고
// 마지막 정상 스냅샷(30분 내)을 유지한다 — 429는 5분 백오프, force 폴링(재로그인 감지
// 5초 폴링 등)도 프로바이더당 최소 10초 간격으로 묶어 rate-limit 자체를 유발하지 않게 한다.
//
// API 키형(DeepSeek·GLM·Pi 등)은 구독 rate-limit 창이 없어(키 과금) 여기서 다루지 않고,
// Grok CLI는 실제 추론에서 확인된 402 소진 상태만 별도 어댑터가 표시하고,
// 로컬(Ollama)은 무제한 — 둘 다 대시보드 "연결" 칩은 runtime.detect가 담당한다.
// 향후 프로바이더는 이 배열에 어댑터만 추가하면 됨.
import fs from "node:fs";
import path from "node:path";
import type {
  ModelRoleUsageSnapshot,
  ProviderUsage,
  UsageRetryProviderId,
  UsageRetryResult,
  UsageSnapshot,
  UsageWindow,
} from "../../shared/types";
import { getDb } from "../store/db";
import { getClaudeUsage } from "./claude";
import { getCodexUsage } from "./codex";
import { getGeminiUsage } from "./gemini";
import { getGrokUsage } from "./grok";
import { localTokensFor } from "./local-logs";
import { readProviderHealth } from "./provider-health";
import { UsageRetryGate } from "./retry-policy";

// 하이브리드 사용량(ccusage + agentcat 절충):
//  - 서버 usage API = 정확한 리밋 %·리셋 시각. 단 rate limit이 짜서 자주 못 친다.
//  - 로컬 로그(local-logs) = rate-limit 0의 실시간 토큰. 단 "한도 대비 %"는 모른다.
// 평상시 서버 조회는 10분 간격으로 급감시켜 429를 예방하고(그 사이 last-good 재사용),
// 서버가 완전히 죽었을 때만(429/네트워크 + last-good 만료) 로컬 토큰으로 폴백해 빈손을 막는다.
const TTL_MS = 120_000; // 전체 스냅샷 캐시(여러 위젯이 공유)
const SERVER_MIN_INTERVAL_MS = 10 * 60_000; // 프로바이더별 실제 서버 재조회 최소 간격(비-force)
const FORCE_MIN_MS = 10_000; // force여도 프로바이더당 최소 재조회 간격
const LAST_GOOD_MAX_MS = 2 * 60 * 60_000; // 일시 장애 시 정상 스냅샷을 대신 보여줄 최대 나이(재시작·장기 429 커버)
const BACKOFF_429_MS = 5 * 60_000; // rate-limit 맞으면 그 프로바이더만 쉰다
// 인증 문제(auth_expired)는 일시 장애가 아니다 — 그건 그대로 표면화해 재로그인 액션을 준다.
const TRANSIENT_ERRORS = new Set(["rate_limited", "network_error"]);

let cache: { snapshot: UsageSnapshot; at: number } | null = null;
const lastResult = new Map<string, { usage: ProviderUsage; at: number }>();
const lastGood = new Map<string, { usage: ProviderUsage; at: number }>();
const backoffUntil = new Map<string, number>();
const providerFetchInFlight = new Map<string, Promise<ProviderUsage | null>>();
const explicitRetryGate = new UsageRetryGate(FORCE_MIN_MS);
const explicitRetryInFlight = new Map<UsageRetryProviderId, Promise<UsageRetryResult>>();
const MODEL_ROLE_USAGE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export function modelRoleUsageSnapshot(now: number): ModelRoleUsageSnapshot {
  const sinceMs = now - MODEL_ROLE_USAGE_WINDOW_MS;
  const empty = (role: "orchestrator" | "worker") => ({
    role,
    observedTokens: 0,
    invocationCount: 0,
  });
  const buckets = {
    orchestrator: empty("orchestrator"),
    worker: empty("worker"),
  };
  let outputOnlyRows = 0;
  try {
    const rows = getDb().prepare(
      `SELECT
         json_extract(payload_json, '$.modelRole') AS role,
         COUNT(*) AS invocation_count,
         COALESCE(SUM(CASE
           WHEN json_type(payload_json, '$.tokens') = 'integer'
             THEN json_extract(payload_json, '$.tokens')
           ELSE 0
         END), 0) AS observed_tokens,
         COALESCE(SUM(CASE
           WHEN json_extract(payload_json, '$.measurement') = 'output-only' THEN 1
           ELSE 0
         END), 0) AS output_only_rows
       FROM run_events
       WHERE kind = 'invoke_result'
         AND ts >= ?
         AND json_extract(payload_json, '$.modelRole') IN ('orchestrator', 'worker')
       GROUP BY json_extract(payload_json, '$.modelRole')`,
    ).all(new Date(sinceMs).toISOString()) as Array<{
      role: "orchestrator" | "worker";
      invocation_count: number;
      observed_tokens: number;
      output_only_rows: number;
    }>;
    for (const row of rows) {
      const bucket = buckets[row.role];
      bucket.invocationCount = Math.max(0, Math.trunc(Number(row.invocation_count) || 0));
      bucket.observedTokens = Math.max(0, Math.trunc(Number(row.observed_tokens) || 0));
      outputOnlyRows += Math.max(0, Math.trunc(Number(row.output_only_rows) || 0));
    }
  } catch {
    // Older or partially migrated profiles get an explicit zero snapshot.
  }
  const totalObservedTokens =
    buckets.orchestrator.observedTokens + buckets.worker.observedTokens;
  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(now).toISOString(),
    measurement: outputOnlyRows > 0 ? "output-only" : "total",
    orchestrator: buckets.orchestrator,
    worker: buckets.worker,
    totalObservedTokens,
    workerSharePercent: totalObservedTokens > 0
      ? Math.round((buckets.worker.observedTokens / totalObservedTokens) * 100)
      : 0,
  };
}

// ── last-good 디스크 영속화 ────────────────────────────────────────────────
// 메모리 전용이면 앱 재시작 직후 첫 조회가 429/네트워크 장애를 맞을 때 보여줄 게 없어
// "조회 실패"부터 뜬다. 마지막 정상 수치를 userData에 남겨 재시작을 건너 유지한다.
function lastGoodFile(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    return path.join(app.getPath("userData"), "usage-last-good.json");
  } catch {
    return null; // electron 밖(헤드리스 스크립트) — 영속화 생략
  }
}
let lastGoodLoaded = false;
function loadLastGood(): void {
  if (lastGoodLoaded) return;
  lastGoodLoaded = true;
  const file = lastGoodFile();
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      { usage: ProviderUsage; at: number }
    >;
    for (const [id, entry] of Object.entries(raw)) {
      if (entry?.usage && typeof entry.at === "number") lastGood.set(id, entry);
    }
  } catch {
    // 없음/손상 — 무시
  }
}
function saveLastGood(): void {
  const file = lastGoodFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(lastGood)), "utf8");
  } catch {
    // best-effort
  }
}

const ADAPTERS: Array<{ id: UsageRetryProviderId; fn: () => Promise<ProviderUsage | null> }> = [
  { id: "claude-code", fn: getClaudeUsage },
  { id: "codex", fn: getCodexUsage },
  { id: "gemini", fn: getGeminiUsage },
  { id: "grok", fn: getGrokUsage },
];

/** 로컬 로그 토큰만으로 구성한 폴백 ProviderUsage. 서버가 아예 안 될 때만 쓴다.
 *  usedPercent는 알 수 없어(로컬엔 한도 없음) 서버 last-good %를 빌려 근사, 없으면 0(토큰 절대량 표시). */
function localFallback(id: string, base: ProviderUsage | null, now: number): ProviderUsage | null {
  const local = localTokensFor(id);
  if (!local || local.lastActivity == null || (local.fiveHour === 0 && local.sevenDay === 0)) return null;
  const goodWindows = base?.windows ?? [];
  const pctOf = (kind: string) => goodWindows.find((w) => w.kind === kind)?.usedPercent ?? 0;
  const mk = (kind: UsageWindow["kind"], label: string, tokens: number): UsageWindow => ({
    id: `${id}-local-${kind}`,
    label,
    kind,
    usedPercent: pctOf(kind),
    used: tokens,
    unit: "tokens",
  });
  return {
    provider: id,
    backend: base?.backend,
    label: base?.label ?? id,
    status: "ok",
    fetchedAt: now,
    error: "local_estimate", // status=ok라 UI엔 에러 아님 — 렌더가 '로컬 추정' 배지로만 쓴다
    windows: [mk("5h", "Last 5h (local)", local.fiveHour), mk("7d", "Last 7d (local)", local.sevenDay)],
  };
}

/** Main 내부에서 재로그인/실행 영수증 직후 호출 — Renderer에는 직접 노출하지 않는다.
 *  스냅샷 캐시와 프로바이더별 lastResult/backoff를
 *  즉시 무효화해, 다음 조회(force든 일반 폴링이든)가 새 토큰으로 서버를 실제로 다시 치게 한다.
 *  (이게 없으면 429 백오프(최대 15분)·lastResult 체인이 로그인 성공을 가려 "앱 재시작해야 반영"이 된다.)
 *  lastGood(마지막 정상 수치)은 지우지 않는다 — 여전히 유효한 표시 폴백이다. */
export function invalidateUsage(providerId?: string): void {
  cache = null;
  if (providerId) {
    lastResult.delete(providerId);
    backoffUntil.delete(providerId);
  } else {
    lastResult.clear();
    backoffUntil.clear();
  }
}

async function fetchProvider(
  id: UsageRetryProviderId,
  fn: () => Promise<ProviderUsage | null>,
  now: number,
  force: boolean,
): Promise<ProviderUsage | null> {
  // 실제 실행에서 확인된 terminal 상태는 과거 정상/비할당 last-good보다 권위가 높다.
  // runtime이 전체 cache를 비운 직후뿐 아니라 앱 재시작 후에도 바로 어댑터를 읽는다.
  const terminalHealth = readProviderHealth(id);
  const hasTerminalHealth =
    terminalHealth?.code === "grok_quota_exhausted" ||
    terminalHealth?.code === "gemini_unsupported_client";
  const last = lastResult.get(id);
  if (!hasTerminalHealth && (backoffUntil.get(id) ?? 0) > now && last) return last.usage;
  if (!hasTerminalHealth && last && now - last.at < FORCE_MIN_MS) return last.usage;
  // 평상시(비-force)엔 서버를 10분에 한 번만 친다 — 그 사이 last-good을 그대로 재사용해 429 예방.
  const good = lastGood.get(id);
  if (!hasTerminalHealth && !force && good && now - good.at < SERVER_MIN_INTERVAL_MS) {
    lastResult.set(id, { usage: good.usage, at: now });
    return good.usage;
  }

  // Snapshot refresh와 명시 retry가 겹쳐도 동일 Provider 네트워크 요청은 하나만 실행한다.
  const existingFetch = providerFetchInFlight.get(id);
  if (existingFetch) return existingFetch;

  const task = (async (): Promise<ProviderUsage | null> => {
    let usage: ProviderUsage | null = null;
    try {
      usage = await fn();
    } catch (err) {
      usage = null;
      // Renderer에는 원문을 반환하지 않지만 main 진단 로그에는 오류 원인을 남긴다.
      console.warn(`[usage] adapter ${id} threw:`, err instanceof Error ? err.message : err);
    }
    if (!usage) return null; // 미연결 — 스냅샷에서 제외

    if (usage.status === "error" && usage.error && TRANSIENT_ERRORS.has(usage.error)) {
      if (usage.error === "rate_limited") {
        // 서버가 Retry-After를 주면 그대로(최소 1분/최대 15분), 없으면 기본 5분.
        const ra = Number(usage.retryAfterSeconds);
        const waitMs = Number.isFinite(ra) && ra > 0
          ? Math.min(Math.max(ra * 1000, 60_000), 15 * 60_000)
          : BACKOFF_429_MS;
        backoffUntil.set(id, now + waitMs);
      }
      if (good && now - good.at < LAST_GOOD_MAX_MS) {
        // 일시 장애 — 에러 UI 대신 마지막 정상 수치를 유지(다음 주기에 자연 회복).
        lastResult.set(id, { usage: good.usage, at: now });
        return good.usage;
      }
      // last-good도 없다 — 로컬 로그로라도 표시(빈 "조회 실패" 방지). 로컬조차 없으면 원래 에러.
      const fb = localFallback(id, good?.usage ?? null, now);
      if (fb) {
        lastResult.set(id, { usage: fb, at: now });
        return fb;
      }
    }
    if (usage.status === "ok" || usage.status === "no_quota") {
      lastGood.set(id, { usage, at: now });
      backoffUntil.delete(id);
      saveLastGood();
    }
    lastResult.set(id, { usage, at: now });
    return usage;
  })();

  providerFetchInFlight.set(id, task);
  try {
    return await task;
  } finally {
    if (providerFetchInFlight.get(id) === task) providerFetchInFlight.delete(id);
  }
}

async function buildUsageSnapshot(options?: {
  forceAll?: boolean;
  forceProviderId?: UsageRetryProviderId;
}): Promise<UsageSnapshot> {
  loadLastGood();
  const now = Date.now();
  const forced = options?.forceAll === true || options?.forceProviderId != null;
  if (!forced && cache && now - cache.at < TTL_MS) {
    return cache.snapshot;
  }
  const results = await Promise.allSettled(ADAPTERS.map((adapter) => fetchProvider(
    adapter.id,
    adapter.fn,
    now,
    options?.forceAll === true || options?.forceProviderId === adapter.id,
  )));
  const providers: ProviderUsage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) providers.push(r.value);
  }
  const snapshot: UsageSnapshot = {
    providers,
    fetchedAt: now,
    modelRoleUsage: modelRoleUsageSnapshot(now),
  };
  cache = { snapshot, at: now };
  return snapshot;
}

export async function getUsageSnapshot(opts?: { force?: boolean }): Promise<UsageSnapshot> {
  return buildUsageSnapshot({ forceAll: opts?.force === true });
}

/** Renderer가 호출할 수 있는 유일한 캐시 무효화 경로. Provider별 cooldown과 singleflight를 main이 소유한다. */
export async function retryUsageProvider(providerId: UsageRetryProviderId): Promise<UsageRetryResult> {
  const active = explicitRetryInFlight.get(providerId);
  if (active) {
    const shared = await active;
    return {
      ...shared,
      attempted: false,
      retryAfterMs: explicitRetryGate.remaining(providerId),
    };
  }

  const claim = explicitRetryGate.claim(providerId);
  if (!claim.allowed) {
    return {
      snapshot: await getUsageSnapshot(),
      attempted: false,
      retryAfterMs: claim.retryAfterMs,
    };
  }

  const task = (async (): Promise<UsageRetryResult> => {
    // Gate claim 이후에만 내부 캐시/백오프를 지운다. Gate deadline 자체는 invalidateUsage와 분리돼 있다.
    invalidateUsage(providerId);
    const snapshot = await buildUsageSnapshot({ forceProviderId: providerId });
    return {
      snapshot,
      attempted: true,
      retryAfterMs: explicitRetryGate.remaining(providerId),
    };
  })();
  explicitRetryInFlight.set(providerId, task);
  try {
    return await task;
  } finally {
    if (explicitRetryInFlight.get(providerId) === task) explicitRetryInFlight.delete(providerId);
  }
}
