// Claude Code 구독 사용량 — Claude Code OAuth usage 엔드포인트.
// 토큰: macOS Keychain "Claude Code-credentials" → claudeAiOauth.accessToken
//       (폴백 ~/.claude/.credentials.json · credentials.json)
// 응답: { five_hour, seven_day, seven_day_opus, seven_day_sonnet, extra_usage }
//       각 창 used_percentage·resets_at·is_enabled / extra_usage는 월 추가 사용 지출.
// (방식 출처: oss agentcat-connectors)
import { usageAccountFingerprint } from "./account-fingerprint";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { getJson, normalizeUsageError, toPercent, toResetMs } from "./util";
import { isSupportedClaudeSubscriptionWindow } from "../../shared/runtime-quota";

const execFileP = promisify(execFile);
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/*
 * An E2E/QA app keeps its own credentials in memory (vault.ts USE_MEMORY_VAULT, same switch).
 * This adapter read the owner's login keychain item regardless, so an isolated QA desktop could
 * read — or raise the macOS access prompt for — the owner's Claude Code credential (independent
 * review 2026-10-04). AGENTLAS_E2E_KEYCHAIN=1 opts back in, exactly as it does for the vault.
 */
const NATIVE_KEYCHAIN_READS = !(process.env.AGENTLAS_E2E === "1" && process.env.AGENTLAS_E2E_KEYCHAIN !== "1");

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function currentClaudeUsageIdentity(): { kind: "uuid" | "email"; value: string } | undefined {
  try {
    const file = process.env.CLAUDE_CONFIG_DIR ? path.join(claudeConfigDir(), ".claude.json") : path.join(os.homedir(), ".claude.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const account = parsed?.oauthAccount;
    if (typeof account?.accountUuid === "string" && account.accountUuid.trim()) return { kind: "uuid", value: account.accountUuid };
    if (typeof account?.emailAddress === "string" && account.emailAddress.trim()) return { kind: "email", value: account.emailAddress };
    return undefined;
  } catch { return undefined; }
}

/** Local identity is used only to compare a selected token's server profile. */
export function currentClaudeUsageAccountFingerprint(): string | undefined {
  return usageAccountFingerprint("claude-code", currentClaudeUsageIdentity()?.value);
}

/** Official Claude Code /api/oauth/profile exposes account.uuid and email.
 * Unknown schema cannot authorize cached paid continuation. */
export function claudeProfileAccountFingerprint(payload: unknown, identityKind: "uuid" | "email" = "uuid"): string | undefined {
  const account = object(object(payload)?.account);
  const value = identityKind === "uuid" ? account?.uuid : account?.email;
  return usageAccountFingerprint("claude-code", typeof value === "string" ? value : undefined);
}

interface TokenCandidate {
  token: string;
  /** epoch ms, 알 수 없으면 null */
  expiresAt: number | null;
  source: string;
}

// 후보 전부 수집(keychain 우선, 파일 폴백) — 첫 후보만 쓰면 파일에 남은 옛 만료 토큰이
// keychain의 새 토큰을 영원히 가리는 함정("재로그인해도 fetch failed")이 생긴다.
async function readClaudeTokens(): Promise<{ candidates: TokenCandidate[]; keychainBlocked: boolean }> {
  const items: Array<{ item: Record<string, unknown>; source: string }> = [];
  // "항목이 없다"(=진짜 미로그인)와 "GUI 프로세스가 키체인 접근을 거부당함/응답 못 받음"을 구분한다 —
  // 후자를 null(미연결)로 삼키면 대시보드가 영원히 "연결됨"만 보여주고 사용량 바가 안 뜬다.
  let keychainBlocked = false;
  // The default Keychain service belongs to the default profile. A custom
  // config directory must not silently borrow that account's credentials.
  if (process.platform === "darwin" && NATIVE_KEYCHAIN_READS && !process.env.CLAUDE_CONFIG_DIR) {
    try {
      const { stdout } = await execFileP(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        // GUI 앱 최초 접근은 macOS 키체인 허용 다이얼로그가 뜬다 — 5초 타임아웃이면 사용자가
        // "허용"을 누르기 전에 죽어 영구 실패처럼 보인다. 다이얼로그 응답 여유를 준다.
        { timeout: 20_000 },
      );
      items.push({ item: JSON.parse(stdout), source: "keychain" });
    } catch (err) {
      // exit 44("could not be found") = 항목 없음(정상 미로그인). 그 외(거부/타임아웃/잠김)는 접근 차단.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/could not be found/i.test(msg)) keychainBlocked = true;
    }
  }
  for (const name of [".credentials.json", "credentials.json"]) {
    try {
      const raw = await readFile(path.join(claudeConfigDir(), name), "utf8");
      items.push({ item: JSON.parse(raw), source: name });
    } catch {
      // 없음
    }
  }
  const out: TokenCandidate[] = [];
  const seen = new Set<string>();
  for (const { item, source } of items) {
    const oauth = (item?.claudeAiOauth ?? item?.claude_ai_oauth) as
      | Record<string, unknown>
      | undefined;
    const token =
      (oauth?.accessToken as string) ??
      (oauth?.access_token as string) ??
      (item?.accessToken as string) ??
      (item?.access_token as string);
    if (typeof token !== "string" || !token || seen.has(token)) continue;
    seen.add(token);
    const rawExp = oauth?.expiresAt ?? oauth?.expires_at ?? item?.expiresAt ?? item?.expires_at;
    const exp = Number(rawExp);
    out.push({ token, expiresAt: Number.isFinite(exp) && exp > 0 ? exp : null, source });
  }
  return { candidates: out, keychainBlocked };
}

// 안정 id → 영문 기본 라벨. 표시 로컬라이즈는 렌더러가 kind/model로 재계산.
const LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly (7d)",
  seven_day_opus: "Opus 7d",
  seven_day_sonnet: "Sonnet 7d",
  seven_day_haiku: "Haiku 7d",
  extra_usage: "Extra usage",
};

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonnegativeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Preserve the provider's spend controls; no funded credit balance is inferred. */
export function extraUsageFromClaude(payload: unknown): ProviderUsage["extraUsage"] {
  const extra = object(object(payload)?.extra_usage);
  if (!extra) return undefined;
  const enabled = extra.is_enabled === true;
  return {
    enabled,
    monthlyLimit: nonnegativeNumber(extra.monthly_limit),
    usedCredits: nonnegativeNumber(extra.used_credits),
    utilization: nonnegativeNumber(extra.utilization) != null ? toPercent(nonnegativeNumber(extra.utilization)) : null,
    unlimited: enabled && Object.hasOwn(extra, "monthly_limit") && extra.monthly_limit === null,
  };
}

export function windowsFromClaude(payload: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [key, raw] of Object.entries(object(payload) ?? {})) {
    const e = object(raw);
    if (!e || e.is_enabled === false || !isSupportedClaudeSubscriptionWindow({ id: key })) continue;
    const pct = toPercent(e.utilization ?? e.used_percentage);
    if (pct == null) continue;
    windows.push({
      id: key,
      label: LABELS[key] ?? key,
      kind: key === "five_hour" ? "5h" : key.startsWith("seven_day") ? "7d" : "unknown",
      quotaRole: "subscription",
      usedPercent: pct,
      resetAt: toResetMs(e.resets_at),
      model: key === "seven_day_opus" ? "opus" : key === "seven_day_sonnet" ? "sonnet" : key === "seven_day_haiku" ? "haiku" : null,
    });
  }
  const extra = extraUsageFromClaude(payload);
  const e = object(object(payload)?.extra_usage);
  // Official Claude Code 2.1.69 /usage divides these API cent values by 100
  // before USD formatting. Keep raw cents in metadata for spending controls.
  const knownUsd = e?.currency == null || e.currency === "USD";
  if (extra?.enabled) {
    const ratio = extra.monthlyLimit != null && extra.monthlyLimit > 0 && extra.usedCredits != null
      ? (extra.usedCredits / extra.monthlyLimit) * 100 : null;
    const pct = extra.utilization ?? (ratio != null ? toPercent(ratio) : null);
    // Missing/unlimited spend observations do not imply a fresh zero-percent bar.
    if (pct != null) windows.push({
      id: "extra_usage", label: LABELS.extra_usage, kind: "monthly", quotaRole: "paid-overage", usedPercent: pct,
      ...(knownUsd && extra.usedCredits != null ? { used: extra.usedCredits / 100 } : {}),
      ...(knownUsd && extra.monthlyLimit != null ? { limit: extra.monthlyLimit / 100 } : {}),
      ...(knownUsd ? { unit: "USD" } : {}),
      resetAt: toResetMs(e?.resets_at),
    });
  }
  const rank = (window: UsageWindow) => window.id === "five_hour" ? 0 : window.id === "seven_day" ? 1 : window.kind === "monthly" ? 2 : 5;
  return windows.sort((a, b) => rank(a) - rank(b));
}

export async function getClaudeUsage(): Promise<ProviderUsage | null> {
  const { candidates, keychainBlocked } = await readClaudeTokens();

  const localIdentity = currentClaudeUsageIdentity();
  const accountFingerprint = usageAccountFingerprint("claude-code", localIdentity?.value);
  const base = {
    provider: "claude-code",
    backend: "anthropic" as const,
    label: "Claude Code",
    fetchedAt: Date.now(),
    ...(accountFingerprint ? { accountFingerprint } : {}),
  };
  // 토큰 후보 0 + 키체인 접근 차단 = 미연결이 아니라 "조회 불가" — 정직하게 표면화(재시도/재로그인 액션).
  if (!candidates.length && keychainBlocked) {
    return { ...base, status: "error", windows: [], error: "keychain_blocked" };
  }
  // 토큰 없음 = 미연결 → 스냅샷에서 제외 (연결 칩은 runtime.detect가 담당)
  if (!candidates.length) return null;

  // 만료 안 된 후보만 — 전부 만료면 재로그인 안내(auth_expired).
  const now = Date.now();
  const fresh = candidates.filter((c) => c.expiresAt == null || c.expiresAt > now + 30_000);
  if (!fresh.length) return { ...base, status: "error", windows: [], error: "auth_expired" };

  let lastErr = "";
  for (const cand of fresh) {
    try {
      let measuredFingerprint: string | undefined;
      try {
        const profile = await getJson(CLAUDE_PROFILE_URL, { Authorization: `Bearer ${cand.token}`, "Content-Type": "application/json" });
        const profileFingerprint = claudeProfileAccountFingerprint(profile, localIdentity?.kind);
        if (accountFingerprint && profileFingerprint && accountFingerprint !== profileFingerprint) {
          // A stale fallback credential belongs to another account. Do not
          // show its usage or attribute its paid allowance to this profile.
          lastErr = "credentials_corrupt";
          continue;
        }
        if (accountFingerprint && profileFingerprint === accountFingerprint) measuredFingerprint = profileFingerprint;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/HTTP 40[13]/.test(message)) { lastErr = message; continue; }
        // Usage remains useful when profile lookup is unavailable, but an
        // opaque candidate then has no identity-bound cache admission grant.
      }
      const { accountFingerprint: _localFingerprint, ...unboundBase } = base;
      return await fetchUsageWith(cand.token, { ...unboundBase, ...(measuredFingerprint ? { accountFingerprint: measuredFingerprint } : {}) });
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // 401/403 = 이 토큰이 죽은 것 → 다음 후보. 그 외(네트워크 등)는 후보 무관 → 중단.
      if (!/HTTP 40[13]/.test(lastErr)) break;
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

async function fetchUsageWith(
  token: string,
  base: Omit<ProviderUsage, "status" | "windows">,
): Promise<ProviderUsage> {
  {
    const payload = (await getJson(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    })) as Record<string, unknown>;

    const windows = windowsFromClaude(payload);
    const extraUsage = extraUsageFromClaude(payload);
    return { ...base, status: windows.length ? "ok" : "no_quota", windows, ...(extraUsage ? { extraUsage } : {}) };
  }
}
