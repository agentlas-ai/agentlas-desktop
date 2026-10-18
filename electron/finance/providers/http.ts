import { isVerifiedIsharesUrl } from './ishares-catalog';
/** Fixed public/provider endpoints only. Never accepts a renderer-chosen host or follows redirects. */
const LIMIT = 8 * 1024 * 1024;
let active = 0;
const nextHostRequest = new Map<string, number>();
const blockedUntil = new Map<string, number>();
export function isFinanceSourceUrlAllowed(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  if (url.hostname === 'www.sec.gov') return url.pathname === '/files/company_tickers_exchange.json' && !url.search;
  if (url.hostname === 'data.sec.gov') return /^(?:\/submissions\/CIK\d{10}|\/api\/xbrl\/companyfacts\/CIK\d{10})\.json$/.test(url.pathname) && !url.search;
  if (url.hostname === 'www.alphavantage.co') return url.pathname === '/query' && keys.every(key => ['function','apikey','keywords','symbol','tickers','limit','outputsize'].includes(key)) && ['SYMBOL_SEARCH','GLOBAL_QUOTE','NEWS_SENTIMENT','ETF_PROFILE','TIME_SERIES_DAILY'].includes(url.searchParams.get('function') || '');
  if (url.hostname === 'public.api.bsky.app') {
    if (url.pathname === '/xrpc/app.bsky.feed.getAuthorFeed') return keys.every(key => ['actor','limit','filter','includePins'].includes(key)) && /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}$/.test(url.searchParams.get('actor') || '') && /^([1-9]|[12]\d|30)$/.test(url.searchParams.get('limit') || '');
    return url.pathname === '/xrpc/app.bsky.feed.searchPosts' && keys.every(key => ['q','limit','sort'].includes(key)) && !!url.searchParams.get('q') && (url.searchParams.get('q') || '').length <= 300 && url.searchParams.get('limit') === '20' && url.searchParams.get('sort') === 'latest';
  }
  if (url.hostname === 'www.federalreserve.gov') return url.pathname === '/feeds/press_all.xml' && !url.search;
  if (url.hostname === 'home.treasury.gov') return url.pathname === '/resource-center/data-chart-center/interest-rates/pages/xml' && url.searchParams.get('data') === 'daily_treasury_yield_curve' && keys.length === 2 && keys.every(key => ['data','field_tdr_date_value','field_tdr_date_value_month'].includes(key)) && /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])?$/.test(url.searchParams.get('field_tdr_date_value') || url.searchParams.get('field_tdr_date_value_month') || '');
  return isVerifiedIsharesUrl(url);
}
export async function fetchFinanceText(url: URL, fetcher: typeof fetch = fetch): Promise<string> {
  if (!isFinanceSourceUrlAllowed(url)) throw new Error('finance_source_url_rejected');
  if (Date.now() < (blockedUntil.get(url.hostname) || 0)) throw new Error('finance_source_rate_limited');
  if (active >= 2) throw new Error('finance_source_busy');
  active++;
  // Reserve slots synchronously. SEC stays well below its documented ten requests/second.
  const start = Math.max(Date.now(), nextHostRequest.get(url.hostname) || 0);
  nextHostRequest.set(url.hostname, start + (url.hostname.includes('sec.gov') ? 250 : 500));
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
  try {
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, start - Date.now())));
    const response = await fetcher(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json, text/csv, application/xml, text/xml;q=0.9', 'User-Agent': 'Agentlas Finance (https://agentlas.cloud)' } });
    if (response.status === 429 || response.status === 503) {
      const retry = response.headers.get('retry-after'); const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 60;
      blockedUntil.set(url.hostname, Date.now() + Math.max(1000, Math.min(seconds * 1000, 15 * 60000)));
      throw new Error('finance_source_rate_limited');
    }
    if (!response.ok) throw new Error(`finance_source_http_${response.status}`);
    if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('finance_source_too_large');
    if (!response.body) throw new Error('finance_source_empty');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > LIMIT) throw new Error('finance_source_too_large'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); active--; }
}
export async function fetchFinanceJson(url: URL, fetcher: typeof fetch = fetch): Promise<unknown> {
  const text = await fetchFinanceText(url, fetcher);
  try { return JSON.parse(text); } catch { throw new Error('finance_source_shape'); }
}
