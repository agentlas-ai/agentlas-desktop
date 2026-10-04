import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { fetchKimiMetadata, resolveKimiAuth } from "../runtime/kimi-auth";
import { toResetMs } from "./util";

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function windowFrom(raw: unknown, id: string, defaultLabel: string, duration?: number | null): UsageWindow | null {
  const row = object(raw);
  if (!row) return null;
  const limit = number(row.limit);
  const remaining = number(row.remaining);
  const used = number(row.used) ?? (limit != null && remaining != null ? Math.max(0, limit - remaining) : null);
  if (limit == null || limit <= 0 || used == null) return null;
  const resetAt = toResetMs(row.reset_at ?? row.resetAt ?? row.reset_time ?? row.resetTime);
  return {
    id, label: typeof row.name === "string" && row.name ? row.name : typeof row.title === "string" && row.title ? row.title : defaultLabel,
    kind: duration === 300 ? "5h" : duration === 10080 ? "7d" : duration === 1440 ? "daily" : "unknown",
    quotaRole: "subscription", usedPercent: Math.min(100, Math.max(0, used / limit * 100)), used, limit,
    ...(duration != null ? { windowDurationMins: duration } : {}), ...(resetAt != null ? { resetAt } : {}),
  };
}
function durationMinutes(value: Record<string, unknown>): number | null {
  const duration = number(value.duration);
  if (duration == null || typeof value.timeUnit !== "string") return null;
  const unit = value.timeUnit;
  return unit.includes("MINUTE") ? duration : unit.includes("HOUR") ? duration * 60 : unit.includes("DAY") ? duration * 1440 : unit.includes("SECOND") ? duration / 60 : null;
}

/** Official managed /usages schema. Missing ratios/windows/wallet controls stay
 * unknown; no local token count is converted into a subscription percentage. */
export function usageFromKimi(payload: unknown): Pick<ProviderUsage, "windows" | "credits"> {
  const root = object(payload) ?? {};
  const windows: UsageWindow[] = [];
  // Official source calls the summary Weekly limit; the API duration, if present,
  // is still the only authority for the precise rolling-window length.
  const summary = windowFrom(root.usage, "kimi-summary", "Usage", durationMinutes(object(root.usage) ?? {}));
  if (summary) windows.push(summary);
  if (Array.isArray(root.limits)) root.limits.forEach((value, index) => {
    const item = object(value);
    if (!item) return;
    const detail = object(item.detail) ?? item;
    const window = object(item.window) ?? {};
    const row = windowFrom(detail, `kimi-limit-${index}`, "Usage limit", durationMinutes({ ...detail, ...item, ...window }));
    if (row) windows.push(row);
  });
  const wallet = object(root.boosterWallet);
  const balance = object(wallet?.balance);
  const amountLeft = number(balance?.amountLeft);
  if (!wallet || balance?.type !== "BOOSTER" || amountLeft == null) return { windows };
  // Official v0.28 managed-usage converts fixed-point amount / 1,000,000 to cents.
  const balanceCents = amountLeft / 1_000_000;
  const monthlyLimit = object(wallet.monthlyChargeLimit);
  const monthlyUsed = object(wallet.monthlyUsed);
  const cap = number(monthlyLimit?.priceInCents);
  const spent = number(monthlyUsed?.priceInCents);
  const capped = wallet.monthlyChargeLimitEnabled;
  const knownControl = capped === false || (capped === true && cap != null && (cap === 0 || spent != null));
  const reached = capped === true && cap != null && cap > 0 && spent != null && spent >= cap;
  const currency = typeof monthlyLimit?.currency === "string" ? monthlyLimit.currency : typeof monthlyUsed?.currency === "string" ? monthlyUsed.currency : null;
  return { windows, credits: {
    hasCredits: balanceCents > 0, balance: balanceCents, unlimited: false,
    unit: currency && /^[A-Z]{3}$/u.test(currency) ? `${currency} cents` : "provider cents",
    spendAllowed: knownControl && !reached,
    ...(knownControl ? { overageLimitReached: reached } : {}),
  } };
}

export function currentKimiUsageCredentialFingerprint(): string | undefined {
  const auth = resolveKimiAuth();
  return auth.state === "resolved" && auth.managed ? auth.credentialFingerprint : undefined;
}

export async function getKimiUsage(): Promise<ProviderUsage | null> {
  const auth = resolveKimiAuth();
  if (auth.state !== "resolved" || !auth.managed) return null;
  const base = { provider: "kimi", backend: "kimi" as const, label: "Kimi Code", fetchedAt: Date.now(), credentialFingerprint: auth.credentialFingerprint };
  const result = await fetchKimiMetadata(auth, "usages");
  if (!result.ok) return { ...base, status: "error", windows: [],
    error: result.status === 401 || result.status === 403 ? "auth_expired" : result.status === 429 ? "rate_limited" : result.status != null ? "provider_error" : "network_error" };
  const usage = usageFromKimi(result.payload);
  return { ...base, ...usage, status: usage.windows.length ? "ok" : "no_quota" };
}
