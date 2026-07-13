// Grok CLI는 구독 사용량 퍼센트/리셋 시각을 기계 판독 가능한 API로 제공하지 않는다.
// 대신 실제 추론의 HTTP 402가 확인된 경우에만, "소진"이라는 확정 사실을 표시한다.
import type { ProviderUsage } from "../../shared/types";
import { readProviderHealth } from "./provider-health";

export async function getGrokUsage(): Promise<ProviderUsage | null> {
  const health = readProviderHealth("grok");
  if (health?.code !== "grok_quota_exhausted") return null;
  return {
    provider: "grok",
    backend: "custom",
    label: "Grok",
    status: "error",
    error: "quota_exhausted",
    fetchedAt: Date.now(),
    // HTTP 402 proves exhaustion only. It does not expose a measured percentage,
    // quota window, or reset timestamp, so the Dashboard must remain status-only.
    windows: [],
  };
}
