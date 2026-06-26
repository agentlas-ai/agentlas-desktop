// 엔진 사용량 커넥터 공용 헬퍼.
// 프로바이더 usage 응답의 퍼센트/리셋 시각 정규화 + 타임아웃 JSON GET.

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

/** 타임아웃 있는 JSON GET. non-2xx면 throw. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
