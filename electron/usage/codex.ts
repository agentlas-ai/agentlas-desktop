// Codex(ChatGPT) 구독 사용량 — ChatGPT Codex usage 엔드포인트.
// 자격증명: 런타임과 같은 CODEX_HOME/auth.json → tokens.access_token + account_id
// 응답 모양은 프로바이더가 바꿀 수 있어 방어적으로 파싱한다. primary/secondary는
// 순서일 뿐 창 길이가 아니다. 공급자가 준 duration으로만 5h/7d를 판정한다.
// (방식 출처: oss agentcat-connectors / 정확한 필드는 라이브 응답으로 보강)
import { usageAccountFingerprint } from "./account-fingerprint";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { getJson, normalizeUsageError, toPercent, toResetMs } from "./util";

const CODEX_USAGE_URLS = [
  "https://chatgpt.com/backend-api/codex/usage",
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/api/codex/usage",
];

function codexAuthFile(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
}

function parseCodexAuth(raw: string): { token: string; accountId: string } | null {
  const auth = JSON.parse(raw) as Record<string, unknown>;
  const tokens = (auth?.tokens ?? auth) as Record<string, unknown>;
  const token = tokens?.access_token ?? auth?.access_token;
  const accountId = tokens?.account_id ?? auth?.account_id;
  return typeof token === "string" && token
    ? { token, accountId: typeof accountId === "string" ? accountId : "" }
    : null;
}

/** Local identity check only: credentials and raw account id never leave Main. */
export function currentCodexUsageAccountFingerprint(): string | undefined {
  try {
    const auth = parseCodexAuth(readFileSync(codexAuthFile(), "utf8"));
    return usageAccountFingerprint("codex", auth?.accountId);
  } catch {
    return undefined;
  }
}

async function readCodexAuth(): Promise<{ token: string; accountId: string } | null> {
  try {
    return parseCodexAuth(await readFile(codexAuthFile(), "utf8"));
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

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function creditsFromCodex(value: unknown): ProviderUsage["credits"] {
  const credits = object(value);
  if (!credits) return undefined;
  const hasCredits = boolean(credits.has_credits ?? credits.hasCredits);
  const unlimited = boolean(credits.unlimited);
  if (hasCredits == null || unlimited == null) return undefined;
  const rawBalance = credits.balance;
  const balance = typeof rawBalance === "number"
    ? rawBalance
    : typeof rawBalance === "string" && rawBalance.trim() ? Number(rawBalance) : Number.NaN;
  const overageLimitReached = boolean(credits.overage_limit_reached ?? credits.overageLimitReached);
  return {
    hasCredits,
    unlimited,
    balance: Number.isFinite(balance) && balance >= 0 ? balance : null,
    ...(overageLimitReached != null ? { overageLimitReached } : {}),
  };
}

function codexRateLimits(root: JsonObject): Array<{ limit: JsonObject; id: string | null; name: string | null }> {
  const byLimitId = object(root.rate_limits_by_limit_id ?? root.rateLimitsByLimitId);
  if (byLimitId && Object.keys(byLimitId).length > 0) {
    return Object.entries(byLimitId).flatMap(([id, value]) => {
      const limit = object(value);
      return limit ? [{ limit, id: text(limit.limit_id ?? limit.limitId) ?? id, name: text(limit.limit_name ?? limit.limitName) }] : [];
    });
  }
  const rateLimit = object(root.rate_limit ?? root.rateLimit ?? root.rate_limits ?? root.rateLimits);
  const limits = rateLimit ? [{
    limit: rateLimit,
    id: text(root.limit_id ?? root.limitId ?? rateLimit.limit_id ?? rateLimit.limitId) ?? "codex",
    name: text(root.limit_name ?? root.limitName ?? rateLimit.limit_name ?? rateLimit.limitName),
  }] : [];
  const additional = root.additional_rate_limits ?? root.additionalRateLimits;
  const entries = Array.isArray(additional) ? additional.map((value) => [null, value] as const)
    : Object.entries(object(additional) ?? {});
  for (const [index, [id, value]] of entries.entries()) {
    const limit = object(value);
    if (limit) limits.push({
      limit,
      id: text(limit.limit_id ?? limit.limitId ?? limit.metered_feature ?? limit.meteredFeature)
        ?? id ?? text(limit.limit_name ?? limit.limitName) ?? `codex-additional-${index}`,
      name: text(limit.limit_name ?? limit.limitName),
    });
  }
  return limits;
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
  const model = text(rawLimit.normal_model_slug ?? rawLimit.normalModelSlug ?? rawLimit.model ?? limit.normal_model_slug ?? limit.normalModelSlug);
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
    const resetsInSeconds = positiveNumber(window.reset_after_seconds ?? window.resetAfterSeconds ?? window.resets_in_seconds ?? window.resetsInSeconds);
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
      ...(model ? { model } : {}),
    });
  }
  return out;
}

export function windowsFromCodex(payload: unknown): UsageWindow[] {
  const root = object(payload) ?? {};
  return codexRateLimits(root).flatMap(({ limit, id, name }) => windowsFromRateLimit(limit, id, name));
}

export function quotaMetadataFromCodex(payload: unknown): Pick<ProviderUsage, "credits" | "limits" | "spendControlReached"> {
  const root = object(payload) ?? {};
  const legacy = object(root.rate_limit ?? root.rateLimit ?? root.rate_limits ?? root.rateLimits);
  const rateLimits = codexRateLimits(root);
  const generalLimit = rateLimits.find(({ id, limit }) => id === "codex"
    && !text(limit.normal_model_slug ?? limit.normalModelSlug ?? limit.model));
  const credits = creditsFromCodex(root.credits) ?? creditsFromCodex(legacy?.credits)
    ?? creditsFromCodex(generalLimit?.limit.credits);
  const spendControlReached = boolean(root.spend_control_reached ?? root.spendControlReached
    ?? object(root.spend_control)?.reached ?? legacy?.spendControlReached);
  const limits = rateLimits.map(({ limit: raw, id }) => {
    const limit = object(raw.rate_limit ?? raw.rateLimit) ?? raw;
    // HTTP's legacy envelope puts account-wide credits next to rate_limit.
    // Additional/model limits must keep their own allowance instead of borrowing it.
    const scopedCredits = creditsFromCodex(raw.credits ?? limit.credits)
      ?? (raw === legacy ? credits : undefined);
    const scopedSpend = boolean(raw.spend_control_reached ?? raw.spendControlReached
      ?? object(raw.spend_control)?.reached ?? limit.spendControlReached
      ?? (raw === legacy ? spendControlReached : null));
    const model = text(raw.normal_model_slug ?? raw.normalModelSlug ?? raw.model ?? limit.normalModelSlug);
    return {
      limitId: id,
      ...(model ? { model } : {}),
      ...(scopedCredits ? { credits: scopedCredits } : {}),
      allowed: boolean(raw.allowed ?? limit.allowed),
      limitReached: boolean(raw.limit_reached ?? raw.limitReached ?? limit.limit_reached ?? limit.limitReached),
      ...(scopedSpend != null ? { spendControlReached: scopedSpend } : {}),
    };
  });
  return {
    ...(credits ? { credits } : {}),
    ...(limits.length ? { limits } : {}),
    ...(spendControlReached != null ? { spendControlReached } : {}),
  };
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
    "Cache-Control": "no-cache",
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;

  let lastErr = "";
  for (const url of CODEX_USAGE_URLS) {
    try {
      const payload = await getJson(url, headers);
      const windows = windowsFromCodex(payload);
      return { ...base, fetchedAt: Date.now(), status: windows.length ? "ok" : "no_quota", windows, ...quotaMetadataFromCodex(payload) };
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
