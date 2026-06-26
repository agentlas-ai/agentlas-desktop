// 엔진 사용량 매니저 — 구독형 프로바이더(Claude/Codex/Gemini)의 usage를 모아
// 정규화된 UsageSnapshot으로. main에서 60초 캐시(엔드포인트 과호출 방지).
//
// API 키형(DeepSeek·GLM·Grok·Pi 등)은 구독 rate-limit 창이 없어(키 과금) 여기서 다루지 않고,
// 로컬(Ollama)은 무제한 — 둘 다 대시보드 "연결" 칩은 runtime.detect가 담당한다.
// 향후 프로바이더는 이 배열에 어댑터만 추가하면 됨.
import type { ProviderUsage, UsageSnapshot } from "../../shared/types";
import { getClaudeUsage } from "./claude";
import { getCodexUsage } from "./codex";
import { getGeminiUsage } from "./gemini";

const TTL_MS = 60_000;
let cache: { snapshot: UsageSnapshot; at: number } | null = null;

const ADAPTERS: Array<() => Promise<ProviderUsage | null>> = [
  getClaudeUsage,
  getCodexUsage,
  getGeminiUsage,
];

export async function getUsageSnapshot(opts?: { force?: boolean }): Promise<UsageSnapshot> {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.at < TTL_MS) {
    return cache.snapshot;
  }
  const results = await Promise.allSettled(ADAPTERS.map((fn) => fn()));
  const providers: ProviderUsage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) providers.push(r.value);
  }
  const snapshot: UsageSnapshot = { providers, fetchedAt: now };
  cache = { snapshot, at: now };
  return snapshot;
}
