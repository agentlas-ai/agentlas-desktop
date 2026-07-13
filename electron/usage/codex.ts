// Codex(ChatGPT) 구독 사용량 — ChatGPT Codex usage 엔드포인트.
// 자격증명: ~/.codex/auth.json → tokens.access_token + account_id
// 응답 모양은 프로바이더가 바꿀 수 있어 방어적으로 파싱(primary=5h, secondary=주간).
// (방식 출처: oss agentcat-connectors / 정확한 필드는 라이브 응답으로 보강)
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { getJson, normalizeUsageError, toPercent, toResetMs } from "./util";

const CODEX_USAGE_URLS = [
  "https://chatgpt.com/backend-api/codex/usage",
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/api/codex/usage",
];

async function readCodexAuth(): Promise<{ token: string; accountId: string } | null> {
  try {
    const raw = await readFile(path.join(os.homedir(), ".codex", "auth.json"), "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const tokens = (auth?.tokens ?? auth) as Record<string, unknown>;
    const token = (tokens?.access_token as string) ?? (auth?.access_token as string);
    const accountId =
      (tokens?.account_id as string) ?? (auth?.account_id as string) ?? "";
    if (typeof token === "string" && token) {
      return { token, accountId: String(accountId ?? "") };
    }
  } catch {
    // 미연결
  }
  return null;
}

function windowsFromCodex(payload: unknown): UsageWindow[] {
  const out: UsageWindow[] = [];
  const root = (payload ?? {}) as Record<string, unknown>;
  // 실제 키: rate_limit(단수) 또는 rate_limits, 창은 primary_window/secondary_window (or primary/secondary)
  const rl = ((root.rate_limit ?? root.rate_limits) ?? {}) as Record<string, unknown>;
  const specs: Array<["primary" | "secondary", "5h" | "7d", string]> = [
    ["primary", "5h", "5-hour"],
    ["secondary", "7d", "Weekly (7d)"],
  ];
  for (const [field, kind, label] of specs) {
    const w = (rl[`${field}_window`] ?? rl[field]) as Record<string, unknown> | undefined;
    if (!w || typeof w !== "object") continue;
    const pct = toPercent(w.used_percent ?? w.utilization ?? w.used_percentage);
    if (pct == null) continue;
    let resetAt = toResetMs(w.reset_at ?? w.resets_at);
    if (resetAt == null && typeof w.resets_in_seconds === "number") {
      resetAt = Date.now() + w.resets_in_seconds * 1000;
    }
    out.push({ id: field, label, kind, usedPercent: pct, resetAt });
  }
  return out;
}

export async function getCodexUsage(): Promise<ProviderUsage | null> {
  const auth = await readCodexAuth();
  if (!auth) return null;

  const base = {
    provider: "codex",
    backend: "openai" as const,
    label: "Codex",
    fetchedAt: Date.now(),
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "User-Agent": "Agentlas/1.0",
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;

  let lastErr = "";
  for (const url of CODEX_USAGE_URLS) {
    try {
      const payload = await getJson(url, headers);
      const windows = windowsFromCodex(payload);
      return { ...base, status: windows.length ? "ok" : "no_quota", windows };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  const normalized = normalizeUsageError(lastErr);
  return {
    ...base,
    status: "error",
    windows: [],
    error: normalized.code,
    ...(normalized.retryAfterSeconds ? { retryAfterSeconds: normalized.retryAfterSeconds } : {}),
  };
}
