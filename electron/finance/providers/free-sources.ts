import type { FinanceDataResult } from '../../../shared/finance';
import { fetchFinanceText } from './http';
import { ReadCache, Slots } from './read-cache';

/**
 * Three public sources that need no account, key or payment, each reachable by a plain HTTPS GET to a fixed host:
 *   macro_series  FRED public series CSV (St. Louis Fed) for a closed list of U.S. agency series: rates, inflation, labor, growth, dollar, oil.
 *   fx_rates      ECB euro foreign exchange reference rates through Frankfurter (open source): 30 currencies, daily, history.
 *   news_search   GDELT DOC 2.0 article list: headline, publisher, link and time of news in any language (Korean, Japanese, Chinese, ...).
 * Each is global (no asset), returns literal observations with their original dates, and fails alone: an unreachable host is a
 * data result with status "error", never an exception that stops a run. Nothing is interpolated, converted or inferred.
 */
type Row = (string | number | null)[];
const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const FRANKFURTER = 'https://api.frankfurter.dev/v1';
const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const ROW_LIMIT = 5000, NEWS_LIMIT = 25;

export interface FredSeriesDefinition { title: string; unit: string; frequency: 'Daily' | 'Weekly' | 'Monthly' | 'Quarterly'; publisher: string }
/** A closed list: only series whose publisher is a U.S. government agency (public-domain data), so no third-party index terms apply. */
export const FRED_SERIES: Readonly<Record<string, FredSeriesDefinition>> = Object.freeze({
  FEDFUNDS: { title: 'Federal funds effective rate, monthly average', unit: '% per annum', frequency: 'Monthly', publisher: 'Board of Governors of the Federal Reserve System' },
  DFF: { title: 'Federal funds effective rate, daily', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DGS3MO: { title: 'Market yield on U.S. Treasury securities at 3-month constant maturity', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DGS2: { title: 'Market yield on U.S. Treasury securities at 2-year constant maturity', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DGS5: { title: 'Market yield on U.S. Treasury securities at 5-year constant maturity', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DGS10: { title: 'Market yield on U.S. Treasury securities at 10-year constant maturity', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DGS30: { title: 'Market yield on U.S. Treasury securities at 30-year constant maturity', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  T10Y2Y: { title: '10-year minus 2-year Treasury constant maturity spread', unit: 'percentage points', frequency: 'Daily', publisher: 'Federal Reserve Bank of St. Louis (from Board of Governors data)' },
  T10Y3M: { title: '10-year minus 3-month Treasury constant maturity spread', unit: 'percentage points', frequency: 'Daily', publisher: 'Federal Reserve Bank of St. Louis (from Board of Governors data)' },
  DFII10: { title: '10-year Treasury inflation-indexed security yield (TIPS, real yield)', unit: '% per annum', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  T10YIE: { title: '10-year breakeven inflation rate', unit: '% per annum', frequency: 'Daily', publisher: 'Federal Reserve Bank of St. Louis (from Board of Governors data)' },
  CPIAUCSL: { title: 'Consumer price index for all urban consumers, all items, seasonally adjusted', unit: 'index 1982-1984=100', frequency: 'Monthly', publisher: 'U.S. Bureau of Labor Statistics' },
  CPILFESL: { title: 'Consumer price index excluding food and energy (core), seasonally adjusted', unit: 'index 1982-1984=100', frequency: 'Monthly', publisher: 'U.S. Bureau of Labor Statistics' },
  PCEPI: { title: 'Personal consumption expenditures price index', unit: 'index 2017=100', frequency: 'Monthly', publisher: 'U.S. Bureau of Economic Analysis' },
  PCEPILFE: { title: 'Personal consumption expenditures price index excluding food and energy (core)', unit: 'index 2017=100', frequency: 'Monthly', publisher: 'U.S. Bureau of Economic Analysis' },
  UNRATE: { title: 'Unemployment rate, seasonally adjusted', unit: '%', frequency: 'Monthly', publisher: 'U.S. Bureau of Labor Statistics' },
  PAYEMS: { title: 'All employees, total nonfarm, seasonally adjusted', unit: 'thousands of persons', frequency: 'Monthly', publisher: 'U.S. Bureau of Labor Statistics' },
  ICSA: { title: 'Initial claims for unemployment insurance, seasonally adjusted', unit: 'claims', frequency: 'Weekly', publisher: 'U.S. Employment and Training Administration' },
  JTSJOL: { title: 'Job openings, total nonfarm', unit: 'thousands', frequency: 'Monthly', publisher: 'U.S. Bureau of Labor Statistics' },
  GDPC1: { title: 'Real gross domestic product, seasonally adjusted annual rate', unit: 'billions of chained 2017 dollars', frequency: 'Quarterly', publisher: 'U.S. Bureau of Economic Analysis' },
  INDPRO: { title: 'Industrial production index, seasonally adjusted', unit: 'index 2017=100', frequency: 'Monthly', publisher: 'Board of Governors of the Federal Reserve System' },
  RSAFS: { title: 'Advance retail sales: retail trade and food services, seasonally adjusted', unit: 'millions of dollars', frequency: 'Monthly', publisher: 'U.S. Census Bureau' },
  HOUST: { title: 'Housing starts: total new privately owned housing units, seasonally adjusted annual rate', unit: 'thousands of units', frequency: 'Monthly', publisher: 'U.S. Census Bureau' },
  DEXKOUS: { title: 'South Korean won per U.S. dollar, noon buying rate in New York', unit: 'KRW per USD', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DEXJPUS: { title: 'Japanese yen per U.S. dollar, noon buying rate in New York', unit: 'JPY per USD', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DEXCHUS: { title: 'Chinese yuan per U.S. dollar, noon buying rate in New York', unit: 'CNY per USD', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DEXUSEU: { title: 'U.S. dollars per euro, noon buying rate in New York', unit: 'USD per EUR', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  DTWEXBGS: { title: 'Nominal broad U.S. dollar index', unit: 'index Jan 2006=100', frequency: 'Daily', publisher: 'Board of Governors of the Federal Reserve System' },
  WALCL: { title: 'Federal Reserve total assets, Wednesday level', unit: 'millions of dollars', frequency: 'Weekly', publisher: 'Board of Governors of the Federal Reserve System' },
  M2SL: { title: 'M2 money stock, seasonally adjusted', unit: 'billions of dollars', frequency: 'Monthly', publisher: 'Board of Governors of the Federal Reserve System' },
  DCOILWTICO: { title: 'Crude oil price, West Texas Intermediate (WTI), Cushing, Oklahoma', unit: 'USD per barrel', frequency: 'Daily', publisher: 'U.S. Energy Information Administration' },
  DCOILBRENTEU: { title: 'Crude oil price, Brent, Europe', unit: 'USD per barrel', frequency: 'Daily', publisher: 'U.S. Energy Information Administration' },
  GASREGW: { title: 'U.S. regular all-formulations retail gasoline price', unit: 'USD per gallon', frequency: 'Weekly', publisher: 'U.S. Energy Information Administration' },
});
/** ECB reference-rate currencies (the set Frankfurter serves). */
export const ECB_CURRENCIES: readonly string[] = Object.freeze(['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR']);
const PERIOD_DAYS: Readonly<Record<string, number | null>> = Object.freeze({ '1M': 31, '3M': 93, '1Y': 366, '5Y': 1830, all: null });
const NEWS_TIMESPAN: Readonly<Record<string, string>> = Object.freeze({ '1D': '1d', '1W': '1w', '1M': '1m', '3M': '3m' });
export const FREE_SOURCE_METRICS = Object.freeze(['macro_series', 'fx_rates', 'news_search'] as const);
export type FreeSourceMetric = typeof FREE_SOURCE_METRICS[number];

const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const validDay = (value: unknown): value is string => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && day(time) === value; };
const clean = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max) : '';
const empty = (urls: string[], at: string): FinanceDataResult => ({ status: 'unconnected', sourceUrls: urls, asOf: null, retrievedAt: at, columns: [], rows: [], warnings: [] });
const unsupported = (warning: string): FinanceDataResult => ({ ...empty([], new Date().toISOString()), warnings: [warning] });
function startOf(period: string, now: number): string | null | undefined {
  if (!Object.hasOwn(PERIOD_DAYS, period)) return undefined;
  const days = PERIOD_DAYS[period]; return days === null ? null : day(now - days * 86400_000);
}
function provider(id: string, label: string, status: FinanceDataResult['status'], coverage: string, rights: string, urls: string[]): NonNullable<FinanceDataResult['providers']>[number] {
  return { id, label, status: status === 'unconnected' ? 'unavailable' : status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'partial', coverage, rights, sourceUrls: urls };
}

// ---- FRED ----
export function fredUrl(id: string, from: string | null): URL {
  const url = new URL(FRED); url.searchParams.set('id', id); if (from) url.searchParams.set('cosd', from); return url;
}
/** The series CSV: a header `observation_date,<ID>` (older exports say DATE) and one `YYYY-MM-DD,value` line per observation; "." marks a date with no observation. */
export function parseFredCsv(text: string, id: string, definition: FredSeriesDefinition, url: string, retrievedAt: string): FinanceDataResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(line => line.length > 0);
  const header = (lines[0] ?? '').split(',');
  if (header.length !== 2 || !['observation_date', 'DATE'].includes(header[0].trim()) || header[1].trim() !== id) throw new Error('finance_source_shape');
  const rows: Row[] = []; let missing = 0, malformed = 0;
  for (const line of lines.slice(1)) {
    const [date, raw, ...extra] = line.split(',');
    if (extra.length || !validDay(date)) { malformed++; continue; }
    const value = raw.trim();
    if (value === '.' || value === '') { missing++; continue; }
    const number = Number(value);
    if (!Number.isFinite(number)) { malformed++; continue; }
    rows.push([date, id, number, definition.unit]);
  }
  if (malformed > Math.max(2, lines.length / 10)) throw new Error('finance_source_shape');
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const kept = rows.slice(-ROW_LIMIT), coverage = `${id}: ${definition.title}. ${definition.frequency}, ${definition.unit}. Published by ${definition.publisher}; ${kept.length} observation${kept.length === 1 ? '' : 's'}${rows.length > ROW_LIMIT ? ` (latest ${ROW_LIMIT} of ${rows.length})` : ''}.`;
  const rights = 'FRED public series CSV. Series from U.S. government agencies are public domain; cite the original publisher and "Federal Reserve Bank of St. Louis, FRED". Values can be revised by the publisher.';
  const result: FinanceDataResult = {
    status: kept.length ? 'partial' : 'unconnected', sourceUrls: [url, `https://fred.stlouisfed.org/series/${id}`], asOf: kept.at(-1)?.[0] as string ?? null, retrievedAt,
    columns: ['Observation date', 'Series', 'Value', 'Unit'], rows: kept,
    warnings: [coverage, 'Literal published observations with their own dates; a revision or a later release can change them. No interpolation across dates without an observation.'],
  };
  if (rows.length > ROW_LIMIT) result.warnings.push(`Coverage truncated to the latest ${ROW_LIMIT} observations.`);
  if (missing) result.warnings.push(`${missing} date${missing === 1 ? '' : 's'} had no published value (holiday or not yet released) and are left out, not filled.`);
  if (malformed) result.warnings.push(`${malformed} unreadable line${malformed === 1 ? '' : 's'} skipped.`);
  if (!kept.length) result.warnings.push('finance_macro_series_empty');
  result.providers = [provider('fred-public-csv', 'FRED public series (St. Louis Fed)', result.status, coverage, rights, result.sourceUrls)];
  return result;
}

// ---- ECB reference rates through Frankfurter ----
export function parseFxQuery(query: string): { base: string; quote: string } | null {
  const match = /^([A-Za-z]{3})\s*[/\-\s]\s*([A-Za-z]{3})$/.exec(query.trim());
  if (!match) return null;
  const base = match[1].toUpperCase(), quote = match[2].toUpperCase();
  return base !== quote && ECB_CURRENCIES.includes(base) && ECB_CURRENCIES.includes(quote) ? { base, quote } : null;
}
export function frankfurterUrl(base: string, quote: string, from: string | null, current: boolean): URL {
  const url = new URL(`${FRANKFURTER}/${current ? 'latest' : `${from ?? '1999-01-04'}..`}`); url.searchParams.set('base', base); url.searchParams.set('symbols', quote); return url;
}
export function parseFrankfurter(value: unknown, base: string, quote: string, url: string, retrievedAt: string): FinanceDataResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finance_source_shape');
  const data = value as Record<string, unknown>;
  if (data.base !== base) throw new Error('finance_source_identity_mismatch');
  const pair = `${base}/${quote}`, unit = `${quote} per 1 ${base}`, rows: Row[] = [];
  const point = (date: unknown, rates: unknown) => {
    if (!validDay(date) || !rates || typeof rates !== 'object') return;
    const rate = (rates as Record<string, unknown>)[quote];
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rows.push([date, pair, rate, unit]);
  };
  if (data.rates && typeof data.rates === 'object' && !Array.isArray(data.rates) && ('start_date' in data)) for (const [date, rates] of Object.entries(data.rates as Record<string, unknown>).slice(0, 20000)) point(date, rates);
  else point(data.date, data.rates);
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const kept = rows.slice(-ROW_LIMIT);
  const coverage = `${pair}: European Central Bank euro foreign exchange reference rates through Frankfurter. ${kept.length} observation${kept.length === 1 ? '' : 's'}; published about 16:00 CET on TARGET working days.`;
  const result: FinanceDataResult = {
    status: kept.length ? 'partial' : 'unconnected', sourceUrls: [url, 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html'],
    asOf: kept.at(-1)?.[0] as string ?? null, retrievedAt, columns: ['Observation date', 'Pair', 'Rate', 'Unit'], rows: kept,
    warnings: [coverage, 'Reference rates, not a tradable or bank rate and not real time. Cross rates are derived by the ECB from euro rates. No conversion of any holding or price is made from this series.'],
  };
  if (rows.length > ROW_LIMIT) result.warnings.push(`Coverage truncated to the latest ${ROW_LIMIT} observations.`);
  if (!kept.length) result.warnings.push('finance_fx_rates_empty');
  result.providers = [provider('ecb-frankfurter', 'ECB reference rates (Frankfurter)', result.status, coverage, 'ECB reference rates are free to use with attribution to the European Central Bank. Frankfurter is a free open-source service with no uptime guarantee.', result.sourceUrls)];
  return result;
}

// ---- GDELT news search ----
const NEWS_FIELDS = ['Headline', 'Publisher', 'URL', 'Published at', 'Language', 'Country'];
export function gdeltQuery(query: string): string | null {
  const text = query.normalize('NFKC').replace(/[^\p{L}\p{N}\s.,&'"%$#@+\-]/gu, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
  return text && /[\p{L}\p{N}]/u.test(text) ? text : null;
}
export function gdeltUrl(query: string, timespan: string): URL {
  const url = new URL(GDELT);
  url.searchParams.set('query', query); url.searchParams.set('mode', 'artlist'); url.searchParams.set('format', 'json'); url.searchParams.set('maxrecords', String(NEWS_LIMIT));
  url.searchParams.set('sort', 'datedesc'); url.searchParams.set('timespan', timespan); return url;
}
const seenAt = (value: unknown): string | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(typeof value === 'string' ? value : '');
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  return validDay(`${match[1]}-${match[2]}-${match[3]}`) && Number.isFinite(Date.parse(iso)) ? iso : null;
};
export function parseGdelt(value: unknown, query: string, url: string, retrievedAt: string): FinanceDataResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finance_source_shape');
  const list = (value as Record<string, unknown>).articles;
  // No match is an empty object (no "articles" key), which is an answer, not a malformed document.
  if (list !== undefined && !Array.isArray(list)) throw new Error('finance_source_shape');
  const rows: Row[] = [], seen = new Set<string>(); let insecure = 0;
  for (const raw of (list ?? []).slice(0, 250) as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>, headline = clean(item.title, 400);
    let link: string | null = null; try { const parsed = new URL(clean(item.url, 2000)); link = !parsed.username && !parsed.password ? parsed.href : null; if (link && parsed.protocol !== 'https:') { insecure++; link = null; } } catch { link = null; }
    if (!headline || !link || seen.has(link)) continue;
    seen.add(link); rows.push([headline, clean(item.domain, 200) || null, link, seenAt(item.seendate), clean(item.language, 40) || null, clean(item.sourcecountry, 80) || null]);
    if (rows.length >= NEWS_LIMIT) break;
  }
  const coverage = `At most ${NEWS_LIMIT} articles matching "${query}" in any language, newest first, from the GDELT open news index. Relevance is provider-defined; headlines and links only, no article text was fetched.`;
  const result: FinanceDataResult = {
    status: rows.length ? 'partial' : 'unconnected', sourceUrls: [url, 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/'],
    asOf: rows.map(row => row[3]).filter((v): v is string => typeof v === 'string').sort().at(-1) ?? null, retrievedAt, columns: NEWS_FIELDS, rows,
    warnings: [coverage, 'Headlines are provider-indexed claims by publishers, not verified facts; a matching word does not make an article about the company. Read the headline against the asked entity before using it.'],
  };
  if (insecure) result.warnings.push(`${insecure} article link${insecure === 1 ? '' : 's'} without HTTPS left out.`);
  if (!rows.length) result.warnings.push('finance_news_search_no_articles');
  result.providers = [provider('gdelt-doc', 'GDELT DOC 2.0 news index', result.status, coverage, 'GDELT is free and open; publisher rights apply to every linked article. Headline and link metadata only.', result.sourceUrls)];
  return result;
}

// ---- reads ----
interface Reply { body: string; at: string }
const replies = new ReadCache<Reply>({ ttlMs: 30 * 60_000, max: 48 });
/** GDELT answers one request per five seconds per client: one at a time, six seconds apart. */
const newsSlot = new Slots(1);
let nextNewsAt = 0;
/** `check` rejects a body that is not the source's document before anything is kept (a refusal page is not an answer to remember). */
async function read(url: URL, ttlMs: number, signal: AbortSignal | undefined, check: (body: string) => void, spaced = false): Promise<Reply> {
  if (signal?.aborted) throw new Error('finance_source_cancelled');
  try {
    return await replies.get(url.href, async () => {
      if (!spaced) { const body = await fetchFinanceText(url); check(body); return { body, at: new Date().toISOString() }; }
      const release = await newsSlot.acquire(signal);
      try {
        // GDELT refuses about half of well-spaced requests (measured); one retry six seconds later (a third try rarely succeeded and doubled the wait).
        for (let attempt = 1; ; attempt++) {
          const wait = Math.max(0, nextNewsAt - Date.now()); if (wait) await new Promise<void>(resolve => setTimeout(resolve, wait));
          if (signal?.aborted) throw new Error('finance_source_cancelled');
          nextNewsAt = Date.now() + 6000;
          try { const body = await fetchFinanceText(url); check(body); return { body, at: new Date().toISOString() }; }
          catch (error) { if (attempt >= 2 || !(error instanceof Error) || error.message !== 'finance_source_rate_limited') throw error; nextNewsAt = Date.now() + 6000; }
        }
      } finally { release(); }
    }, { signal, ttlMs });
  } catch (error) { if (signal?.aborted) throw new Error('finance_source_cancelled'); throw error; }
}
const failure = (error: unknown): string => error instanceof Error && /^finance_[a-z0-9_]+$/.test(error.message) ? error.message : 'finance_source_unavailable';
function failed(urls: string[], error: unknown, label: string): FinanceDataResult {
  const code = failure(error);
  return { status: 'error', sourceUrls: urls, asOf: null, retrievedAt: new Date().toISOString(), columns: [], rows: [], warnings: [code],
    providers: [provider(label, label, 'error', 'The source could not be read; no rows.', 'See the source terms.', urls)] };
}

/** One global read. `query` and `period` are the request's own fields; anything outside the closed lists is answered with what is supported. */
export async function queryFreeSource(metric: FreeSourceMetric, query: string, period: string, signal?: AbortSignal, now = Date.now()): Promise<FinanceDataResult> {
  if (metric === 'macro_series') {
    const id = query.trim().toUpperCase();
    if (!Object.hasOwn(FRED_SERIES, id)) return unsupported(`finance_macro_series_unsupported: use one of ${Object.entries(FRED_SERIES).map(([key, item]) => `${key} (${item.title})`).join('; ')}.`);
    const from = startOf(period, now);
    if (from === undefined) return unsupported('finance_period_unsupported: macro_series periods are 1M, 3M, 1Y, 5Y, all.');
    const url = fredUrl(id, from);
    try { const reply = await read(url, 30 * 60_000, signal, body => { if (!/^\uFEFF?(?:observation_date|DATE),/.test(body)) throw new Error('finance_source_shape'); }); return parseFredCsv(reply.body, id, FRED_SERIES[id], url.href, reply.at); }
    catch (error) { return failed([url.href], error, 'fred-public-csv'); }
  }
  if (metric === 'fx_rates') {
    const pair = parseFxQuery(query);
    if (!pair) return unsupported(`finance_fx_pair_unsupported: query is BASE/QUOTE with ECB currencies (${ECB_CURRENCIES.join(', ')}), for example USD/KRW.`);
    const current = period === 'current', from = current ? null : startOf(period, now);
    if (from === undefined) return unsupported('finance_period_unsupported: fx_rates periods are current, 1M, 3M, 1Y, 5Y, all.');
    const url = frankfurterUrl(pair.base, pair.quote, from, current);
    try { const reply = await read(url, 30 * 60_000, signal, body => { try { JSON.parse(body); } catch { throw new Error('finance_source_shape'); } }); return parseFrankfurter(JSON.parse(reply.body), pair.base, pair.quote, url.href, reply.at); }
    catch (error) { return failed([url.href], error, 'ecb-frankfurter'); }
  }
  const text = gdeltQuery(query);
  if (!text) return unsupported('finance_news_search_query_invalid: give the words to search for (letters and digits, any language).');
  const timespan = Object.hasOwn(NEWS_TIMESPAN, period) ? NEWS_TIMESPAN[period] : undefined;
  if (!timespan) return unsupported('finance_period_unsupported: news_search periods are 1D, 1W, 1M, 3M.');
  const url = gdeltUrl(text, timespan);
  try {
    // The service answers a refused request with plain text and status 200, not JSON.
    const reply = await read(url, 5 * 60_000, signal, body => { try { JSON.parse(body); } catch { throw new Error(/limit requests|one every/i.test(body) ? 'finance_source_rate_limited' : 'finance_source_shape'); } }, true);
    return parseGdelt(JSON.parse(reply.body), text, url.href, reply.at);
  } catch (error) { return failed([url.href], error, 'gdelt-doc'); }
}
