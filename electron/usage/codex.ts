// Codex(ChatGPT) 구독 사용량 — ChatGPT Codex usage 엔드포인트.
// 자격증명: ~/.codex/auth.json → tokens.access_token + account_id
// 응답 모양은 프로바이더가 바꿀 수 있어 방어적으로 파싱한다. primary/secondary는
// 순서일 뿐 창 길이가 아니다. 공급자가 준 duration으로만 5h/7d를 판정한다.
// (방식 출처: oss agentcat-connectors / 정확한 필드는 라이브 응답으로 보강)
import { usageAccountFingerprint } from "./account-fingerprint";
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

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function windowDurationMins(window: JsonObject): number | null {
  const minutes = positiveNumber(
    window.window_duration_mins
      ?? window.windowDurationMins
      ?? window.limit_window_minutes
      ?? window.limitWindowMinutes,
  );
  if (minutes != null) return minutes;
  const seconds = positiveNumber(
    window.limit_window_seconds
      ?? window.limitWindowSeconds
      ?? window.window_seconds
      ?? window.windowSeconds,
  );
  return seconds == null ? null : seconds / 60;
}

function windowKind(durationMins: number | null): UsageWindow["kind"] {
  if (durationMins === 5 * 60) return "5h";
  if (durationMins === 7 * 24 * 60) return "7d";
  return "unknown";
}

function baseWindowLabel(kind: UsageWindow["kind"]): string {
  if (kind === "5h") return "5-hour";
  if (kind === "7d") return "Weekly (7d)";
  return "Usage limit";
}

function windowsFromRateLimit(
  rawLimit: JsonObject,
  inheritedLimitId: string | null,
  inheritedLimitName: string | null,
): UsageWindow[] {
  const limit = object(rawLimit.rate_limit ?? rawLimit.rateLimit) ?? rawLimit;
  const limitId = text(rawLimit.limit_id ?? rawLimit.limitId ?? limit.limit_id ?? limit.limitId) ?? inheritedLimitId;
  const limitName = text(rawLimit.limit_name ?? rawLimit.limitName ?? limit.limit_name ?? limit.limitName) ?? inheritedLimitName;
  const out: UsageWindow[] = [];
  for (const field of ["primary", "secondary"] as const) {
    const window = object(limit[`${field}_window`] ?? limit[`${field}Window`] ?? limit[field]);
    if (!window) continue;
    const pct = toPercent(
      window.used_percent
        ?? window.usedPercent
        ?? window.utilization
        ?? window.used_percentage
        ?? window.usedPercentage,
    );
    if (pct == null) continue;
    let resetAt = toResetMs(window.reset_at ?? window.resetAt ?? window.resets_at ?? window.resetsAt);
    const resetsInSeconds = positiveNumber(window.resets_in_seconds ?? window.resetsInSeconds);
    if (resetAt == null && resetsInSeconds != null) resetAt = Date.now() + resetsInSeconds * 1000;
    const durationMins = windowDurationMins(window);
    const kind = windowKind(durationMins);
    const baseLabel = baseWindowLabel(kind);
    out.push({
      id: `${limitId ?? "codex"}:${field}`,
      label: limitName ? `${limitName} · ${baseLabel}` : baseLabel,
      kind,
      usedPercent: pct,
      resetAt,
      windowDurationMins: durationMins,
      limitId,
      limitName,
    });
  }
  return out;
}

export function windowsFromCodex(payload: unknown): UsageWindow[] {
  const root = object(payload) ?? {};
  const byLimitId = object(root.rate_limits_by_limit_id ?? root.rateLimitsByLimitId);
  if (byLimitId && Object.keys(byLimitId).length > 0) {
    return Object.entries(byLimitId).flatMap(([mapLimitId, rawLimit]) => {
      const limit = object(rawLimit);
      if (!limit) return [];
      return windowsFromRateLimit(
        limit,
        text(limit.limit_id ?? limit.limitId) ?? mapLimitId,
        text(limit.limit_name ?? limit.limitName),
      );
    });
  }

  // Legacy endpoint: `rate_limit` (or `rate_limits`) owns primary/secondary windows.
  const rateLimit = object(root.rate_limit ?? root.rateLimit ?? root.rate_limits ?? root.rateLimits);
  if (!rateLimit) return [];
  return windowsFromRateLimit(
    rateLimit,
    text(root.limit_id ?? root.limitId ?? rateLimit.limit_id ?? rateLimit.limitId),
    text(root.limit_name ?? root.limitName ?? rateLimit.limit_name ?? rateLimit.limitName),
  );
}

export async function getCodexUsage(): Promise<ProviderUsage | null> {
  const auth = await readCodexAuth();
  if (!auth) return null;

  const accountFingerprint = usageAccountFingerprint("codex", auth.accountId);
  const base = {
    provider: "codex",
    backend: "openai" as const,
    label: "Codex",
    fetchedAt: Date.now(),
    ...(accountFingerprint ? { accountFingerprint } : {}),
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
