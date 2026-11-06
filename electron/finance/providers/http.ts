import { isVerifiedIsharesUrl } from './ishares-catalog';
/** Fixed public/provider endpoints only. Never accepts a renderer-chosen host or follows redirects. */
const LIMIT = 8 * 1024 * 1024;
let active = 0;
/** At most four provider requests run at once. Others wait their turn (a monitor, the dashboard feeds and a chat can all ask together); only a wait of a minute without a free slot is reported as busy. */
const MAX_ACTIVE = 4, MAX_WAIT_MS = 60_000;
const waiting: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (active < MAX_ACTIVE && !waiting.length) { active++; return; }
  await new Promise<void>((resolve, reject) => {
    const turn = () => { clearTimeout(timer); active++; resolve(); };
    const timer = setTimeout(() => { const index = waiting.indexOf(turn); if (index >= 0) waiting.splice(index, 1); reject(new Error('finance_source_busy')); }, MAX_WAIT_MS);
    waiting.push(turn);
  });
}
function releaseSlot(): void { active--; while (active < MAX_ACTIVE && waiting.length) waiting.shift()!(); }
const nextHostRequest = new Map<string, number>();
const blockedUntil = new Map<string, number>();
const MAX_BLOCK_MS = 15 * 60_000;
/** Every Finance reader (this file, Yahoo, the world map, the dashboard feeds) shares one block per host, so a refusal seen by one stops the others at once. A block never gets shorter. */
export function blockHost(host: string, ms: number): void {
  const until = Date.now() + Math.max(1000, Math.min(ms, MAX_BLOCK_MS));
  if (until > (blockedUntil.get(host) || 0)) blockedUntil.set(host, until);
}
/** Whole seconds until the host may be read again; 0 when it is not blocked. */
export function hostBlockedSeconds(host: string): number {
  const left = (blockedUntil.get(host) || 0) - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
export function isFinanceSourceUrlAllowed(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  if (url.hostname === 'www.sec.gov') return url.pathname === '/files/company_tickers_exchange.json' && !url.search;
  if (url.hostname === 'data.sec.gov') return /^(?:\/submissions\/CIK\d{10}|\/api\/xbrl\/companyfacts\/CIK\d{10})\.json$/.test(url.pathname) && !url.search;
  if (url.hostname === 'hn.algolia.com') {
    const query=url.searchParams.get('query')||'',filter=url.searchParams.get('numericFilters')||'';
    const range=/^(?:created_at_i>=(\d{1,10}),)?created_at_i<=(\d{1,10})$/.exec(filter);
    return url.pathname==='/api/v1/search_by_date'&&keys.length===4&&keys.every(key=>['query','tags','hitsPerPage','numericFilters'].includes(key))&&!!query.trim()&&query.length<=300&&!/[\u0000-\u001f\u007f]/.test(query)&&url.searchParams.get('tags')==='story'&&url.searchParams.get('hitsPerPage')==='20'&&!!range&&Number(range[2])<=4102444800&&(!range[1]||Number(range[1])<=Number(range[2]));
  }
  if (url.hostname === 'public.api.bsky.app') {
    if (url.pathname === '/xrpc/app.bsky.feed.getAuthorFeed') return keys.every(key => ['actor','limit','filter','includePins'].includes(key)) && /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}$/.test(url.searchParams.get('actor') || '') && /^([1-9]|[12]\d|30)$/.test(url.searchParams.get('limit') || '');
    return url.pathname === '/xrpc/app.bsky.feed.searchPosts' && keys.every(key => ['q','limit','sort'].includes(key)) && !!url.searchParams.get('q') && (url.searchParams.get('q') || '').length <= 300 && url.searchParams.get('limit') === '20' && url.searchParams.get('sort') === 'latest';
  }
  // Free sources with no key (providers/free-sources.ts): fixed host, fixed path, closed query grammar.
  if (url.hostname === 'fred.stlouisfed.org') return url.pathname === '/graph/fredgraph.csv' && keys.includes('id') && keys.every(key => ['id', 'cosd'].includes(key)) && /^[A-Z0-9]{1,25}$/.test(url.searchParams.get('id') || '') && (!url.searchParams.has('cosd') || /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('cosd') || ''));
  if (url.hostname === 'api.frankfurter.dev') return (url.pathname === '/v1/latest' || /^\/v1\/(?:19|20)\d{2}-\d{2}-\d{2}\.\.$/.test(url.pathname)) && keys.length === 2 && keys.every(key => ['base', 'symbols'].includes(key)) && /^[A-Z]{3}$/.test(url.searchParams.get('base') || '') && /^[A-Z]{3}$/.test(url.searchParams.get('symbols') || '');
  if (url.hostname === 'api.gdeltproject.org') {
    const query = url.searchParams.get('query') || '';
    return url.pathname === '/api/v2/doc/doc' && keys.length === 6 && keys.every(key => ['query', 'mode', 'format', 'maxrecords', 'sort', 'timespan'].includes(key)) && !!query.trim() && query.length <= 300 && !/[\u0000-\u001f\u007f]/.test(query)
      && url.searchParams.get('mode') === 'artlist' && url.searchParams.get('format') === 'json' && url.searchParams.get('maxrecords') === '25' && url.searchParams.get('sort') === 'datedesc' && /^[1-9]\d?[dwm]$/.test(url.searchParams.get('timespan') || '');
  }
  if (url.hostname === 'www.federalreserve.gov') return url.pathname === '/feeds/press_all.xml' && !url.search;
  if (url.hostname === 'home.treasury.gov') return url.pathname === '/resource-center/data-chart-center/interest-rates/pages/xml' && url.searchParams.get('data') === 'daily_treasury_yield_curve' && keys.length === 2 && keys.every(key => ['data','field_tdr_date_value','field_tdr_date_value_month'].includes(key)) && /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])?$/.test(url.searchParams.get('field_tdr_date_value') || url.searchParams.get('field_tdr_date_value_month') || '');
  return isVerifiedIsharesUrl(url);
}
/** A server error or a dropped connection may be gone a moment later; a refusal (429), a timeout, an oversized or malformed body is not read again. */
function readableAgain(error: unknown): boolean {
  return error instanceof Error && (/^finance_source_http_5\d\d$/.test(error.message) || error.name === 'TypeError');
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** One read, and after a server error or dropped connection one more, which goes through the host's request spacing and block again. GDELT asks for five seconds between requests, so its second read waits six. */
export async function fetchFinanceText(url: URL, fetcher: typeof fetch = fetch): Promise<string> {
  if (!isFinanceSourceUrlAllowed(url)) throw new Error('finance_source_url_rejected');
  try { return await fetchOnce(url, fetcher); }
  catch (error) {
    if (!readableAgain(error)) throw error;
    await wait(url.hostname === 'api.gdeltproject.org' ? 6000 : 1500);
    return fetchOnce(url, fetcher);
  }
}
async function fetchOnce(url: URL, fetcher: typeof fetch): Promise<string> {
  if (hostBlockedSeconds(url.hostname) > 0) throw new Error('finance_source_rate_limited');
  // Reserve the host's next start synchronously, wait for it, then take a slot: a slot is never held while sleeping. SEC stays well
  // below its documented ten requests/second. GDELT is already one at a time (free-sources.ts) and answers in 10-22 s, so it takes no
  // shared slot that SEC, FRED or Treasury reads would wait behind.
  const start = Math.max(Date.now(), nextHostRequest.get(url.hostname) || 0);
  nextHostRequest.set(url.hostname, start + (url.hostname.includes('sec.gov') ? 250 : 500));
  await wait(Math.max(0, start - Date.now()));
  // A block set while this read waited for its turn (another caller was refused) stops it here, before any request.
  if (hostBlockedSeconds(url.hostname) > 0) throw new Error('finance_source_rate_limited');
  const shared = url.hostname !== 'api.gdeltproject.org';
  if (shared) await acquireSlot();
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, shared ? 20000 : 35000);
  try {
    const response = await fetcher(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json, text/csv, application/xml, text/xml;q=0.9', 'User-Agent': 'Agentlas Finance (https://agentlas.cloud)' } });
    const retry = response.headers.get('retry-after'), retrySeconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
    // A 503 blocks the host only when the source says how long; without that it is an ordinary server error and is read once more.
    if (response.status === 429 || (response.status === 503 && retrySeconds !== null)) {
      // GDELT's rule is one request per five seconds and it sends no Retry-After; a minute's block would fail every news read in the turn.
      blockHost(url.hostname, (retrySeconds ?? (url.hostname === 'api.gdeltproject.org' ? 6 : 60)) * 1000);
      throw new Error('finance_source_rate_limited');
    }
    if (!response.ok) throw new Error(`finance_source_http_${response.status}`);
    if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('finance_source_too_large');
    if (!response.body) throw new Error('finance_source_empty');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > LIMIT) throw new Error('finance_source_too_large'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) { if (timedOut) throw new Error('finance_source_timeout'); throw error; }
  finally { clearTimeout(timer); if (shared) releaseSlot(); }
}
export async function fetchFinanceJson(url: URL, fetcher: typeof fetch = fetch): Promise<unknown> {
  const text = await fetchFinanceText(url, fetcher);
  try { return JSON.parse(text); } catch { throw new Error('finance_source_shape'); }
}
