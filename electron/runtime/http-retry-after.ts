/** Largest representable JavaScript date. An overflowing server wait must exhaust a retry budget, never become zero. */
const MAX_RETRY_AT_MS = 8_640_000_000_000_000;

/** HTTP Retry-After is nonnegative integer seconds or a date, never a number parsed from provider prose. */
export function httpRetryAfterTimestamp(value: string | null | undefined, now = Date.now()): number | null {
  const text = String(value ?? "").trim();
  if (!text || !Number.isFinite(now)) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    // Number() may overflow, and finite seconds can still overflow Date. Saturating the timestamp preserves the
    // bounded deciders' "too long to retry" outcome without an invalid date or an early default-delay resend.
    return !Number.isFinite(seconds) || seconds > (MAX_RETRY_AT_MS - now) / 1_000
      ? MAX_RETRY_AT_MS : Math.min(MAX_RETRY_AT_MS, now + seconds * 1_000);
  }
  // Date.parse accepts numeric-looking invalid delay-seconds such as "-1" and "1.5" as calendar dates.
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

export function httpRetryAfterIso(value: string | null | undefined, now = Date.now()): string | undefined {
  const at = httpRetryAfterTimestamp(value, now);
  return at === null ? undefined : new Date(at).toISOString();
}
