import type { FinanceAsset, FinanceDataRequest, FinanceDataResult, FinanceWorkspace } from '../../shared/finance';
import { latestFinanceQuote } from '../../shared/finance';
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
/** The longest stated wait the host sits out inside one tool call; a longer block is reported with its facts (the model cannot wait, and a call must not hold a turn for minutes). */
export const FINANCE_HOST_WAIT_MAX_SECONDS = 20;
/** First read + wait must fit this; a slow first read means the failure is reported, not waited out. */
export const FINANCE_HOST_WAIT_BUDGET_MS = 40_000;
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
/**
 * A read that failed for a temporary reason with a short stated wait (a source blocked for a few seconds after a rate limit) is waited out
 * and read once more by the host, not handed to the model as "repeat after N seconds": a model cannot wait, so that instruction ended as
 * "could not be read". `waitSeconds` reads the stated wait from the result (null: not a temporary failure, or no stated wait). Stop ends the
 * wait. Reads only: the caller passes a read that has no effect.
 */
export async function readAfterShortWait<T>(read: () => Promise<T>, waitSeconds: (result: T) => number | null, signal?: AbortSignal,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep, now: () => number = Date.now): Promise<{ result: T; waited: boolean }> {
  const started = now();
  const first = await read();
  const seconds = waitSeconds(first);
  if (seconds === null || !(seconds > 0) || seconds > FINANCE_HOST_WAIT_MAX_SECONDS) return { result: first, waited: false };
  // The first read, the wait and the second read together must stay inside one tool call's time (the Codex MCP default is 60 s): when the first read
  // was slow, the failure is returned with its facts instead of waiting.
  const wait = (seconds + 1) * 1000;
  if (now() - started + wait > FINANCE_HOST_WAIT_BUDGET_MS) return { result: first, waited: false };
  await sleep(wait, signal);
  signal?.throwIfAborted();
  return { result: await read(), waited: true };
}
/** The stated wait of a price-history read that failed for a temporary reason (null: it did not, or no host is blocked). Used by calculate. */
export function historyReadWaitSeconds(result: Pick<FinanceDataResult, 'status' | 'rows' | 'warnings' | 'sourceUrls'>): number | null {
  if (['ok', 'partial'].includes(result.status) && result.rows.length) return null;
  return transientFinanceCode(result.warnings) ? financeRetryAfterSeconds(result.sourceUrls) : null;
}
/** A batch of reads that all failed for a temporary reason: nothing was learned, so the batch is not written up as "no evidence" and is read again later. */
export function batchAllTransient(results: readonly Pick<FinanceDataResult, 'status' | 'rows' | 'warnings'>[]): boolean {
  return results.length > 0 && results.every(result => !(['ok', 'partial'].includes(result.status) && result.rows.length) && transientFinanceCode(result.warnings) !== null);
}
/**
 * One price read failed for a temporary reason: answer with the last price this workspace saved for the asset, marked as saved (its own
 * warning code, row label and observation time, never presented as a live read), or return the failure unchanged when there is none.
 * Reads the workspace only; nothing is written.
 */
export function savedPriceOnTransientFailure(result: FinanceDataResult, input: FinanceDataRequest, workspace: FinanceWorkspace, asset: FinanceAsset | undefined): FinanceDataResult {
  if (result.status !== 'error' || result.rows.length || input.metrics.length !== 1 || input.metrics[0] !== 'price' || input.assetIds.length !== 1 || !asset || asset.id !== input.assetIds[0]) return result;
  const code = transientFinanceCode(result.warnings);
  if (!code || !workspace.watchlist.some(item => item.id === asset.id)) return result;
  const quote = latestFinanceQuote(workspace, asset.id);
  if (!quote || quote.currency !== asset.currency) return result;
  const source = workspace.sources.find(item => item.id === quote.sourceId);
  const label = 'Last saved quote';
  return {
    ...result, status: 'partial', asOf: quote.asOf, retrievedAt: source?.retrievedAt ?? quote.asOf,
    sourceUrls: source?.url ? [source.url] : result.sourceUrls,
    columns: ['Symbol', 'Price', 'Currency', 'Observed at', 'Price basis'], rows: [[asset.symbol, quote.price, quote.currency, quote.asOf, label]],
    warnings: [`finance_price_from_saved_quote: the live read failed (${code}); this is the last saved price, observed at ${quote.asOf}${source ? ` from ${source.name}` : ''}. It is not a live price; say so with its time.`, ...result.warnings],
    providers: [{ id: 'finance-saved-quote', label, status: 'partial', coverage: 'The last price saved in this Finance workspace for the selected asset, with the time it was observed; the live read failed.', rights: 'Subject to the terms of the source that supplied it.', sourceUrls: source?.url ? [source.url] : [] }, ...(result.providers ?? [])],
  };
}
