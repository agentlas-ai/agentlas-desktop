import { hostBlockedSeconds } from './providers/http';
/**
 * Whether a failed read may work again later, and when. Nothing here reads a source: callers hand over the warnings and URLs a
 * result already carries. One list decides "temporary" for every Finance caller (chat tools, monitor, add-asset, price fallback).
 */
const TRANSIENT = /^finance_(?:source_(?:rate_limited|timeout|http_5\d\d|unavailable|busy)|yahoo_(?:rate_limited|timeout|source_unavailable)|feed_(?:rate_limited|timeout))$/;
/** The first warning that names a temporary failure (the code alone, or a code followed by its explanation), otherwise null. */
export function transientFinanceCode(warnings: readonly string[]): string | null {
  for (const warning of warnings) {
    const code = /^finance_[a-z0-9_]+/.exec(warning)?.[0];
    if (code && TRANSIENT.test(code)) return code;
  }
  return null;
}
/** Seconds until the longest-blocked host among `urls` may be read again; null when none is blocked. */
export function financeRetryAfterSeconds(urls: readonly string[]): number | null {
  let longest = 0;
  for (const href of urls) { try { longest = Math.max(longest, hostBlockedSeconds(new URL(href).hostname)); } catch { /* not a URL */ } }
  return longest > 0 ? longest : null;
}
