import type { FinanceAsset } from '../../../shared/finance';
import { ReadCache, type ReadOptions } from './read-cache';

/**
 * The SEC reads every Finance path shares: the ticker directory, one issuer's recent submissions, one issuer's company facts.
 *
 * Before this module the asset search/identity path (data.ts) and the dashboard filings feed (dashboard-feeds.ts) each downloaded the
 * whole directory, and every company_facts question downloaded the issuer's full facts file again. Each read is now made once
 * per lifetime below and shared by whoever asks while it is in flight; a failed read is not kept. Each caller still passes
 * its own transport (its own rate limit, size cap and cancellation), so nothing here fetches by itself.
 */
export const SEC_DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const DIRECTORY_TTL = 60 * 60_000, SUBMISSIONS_TTL = 5 * 60_000, FACTS_TTL = 15 * 60_000;

export interface SecIssuer { cik: string; ticker: string; name: string; exchange: string }
export interface SecDirectory {
  issuers: readonly SecIssuer[];
  /** Exact ticker (as listed) to the issuers that list it. */
  byTicker: ReadonlyMap<string, readonly SecIssuer[]>;
  /** Search strings built once: the issuers whose ticker or name contains `needle` (lower case), in directory order, exact tickers first. */
  search(needle: string, limit: number): SecIssuer[];
  /** FinanceAsset for an issuer: the SEC registration identifies an issuer, not a security's fund classification. */
  asset(issuer: SecIssuer): FinanceAsset;
}
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';

/** The directory document as EDGAR publishes it (`fields` + `data` rows), validated and indexed. */
export function parseSecDirectory(value: unknown): SecDirectory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finance_source_shape');
  const { fields, data } = value as { fields?: unknown; data?: unknown };
  if (!Array.isArray(fields) || !Array.isArray(data)) throw new Error('finance_source_shape');
  const at = (name: string) => { const index = fields.indexOf(name); if (index < 0) throw new Error('finance_source_shape'); return index; };
  const cik = at('cik'), ticker = at('ticker'), name = at('name'), exchange = at('exchange');
  const issuers: SecIssuer[] = [], lower: Array<{ ticker: string; name: string }> = [], byTicker = new Map<string, SecIssuer[]>(), byLowerTicker = new Map<string, SecIssuer[]>();
  const assets = new WeakMap<SecIssuer, FinanceAsset>();
  for (const row of data.slice(0, 50000)) {
    if (!Array.isArray(row) || !/^\d{1,10}$/.test(String(row[cik])) || !text(row[ticker], 20000) || !text(row[name], 20000)) continue;
    const issuer: SecIssuer = { cik: String(row[cik]).padStart(10, '0'), ticker: text(row[ticker], 80), name: text(row[name], 300), exchange: text(row[exchange], 80) };
    issuers.push(issuer); lower.push({ ticker: issuer.ticker.toLowerCase(), name: issuer.name.toLowerCase() });
    const same = byTicker.get(issuer.ticker); if (same) same.push(issuer); else byTicker.set(issuer.ticker, [issuer]);
    const sameLower = byLowerTicker.get(issuer.ticker.toLowerCase()); if (sameLower) sameLower.push(issuer); else byLowerTicker.set(issuer.ticker.toLowerCase(), [issuer]);
  }
  return {
    issuers, byTicker,
    search(needle, limit) {
      const exact = (byLowerTicker.get(needle) ?? []).slice(0, limit), taken = new Set(exact), rest: SecIssuer[] = [];
      for (let i = 0; i < issuers.length && exact.length + rest.length < limit; i++) {
        if (taken.has(issuers[i])) continue;
        if (lower[i].ticker.includes(needle) || lower[i].name.includes(needle)) rest.push(issuers[i]);
      }
      return [...exact, ...rest];
    },
    asset(issuer) {
      let asset = assets.get(issuer);
      if (!asset) { asset = { id: `sec:${issuer.cik}:${issuer.ticker}`, symbol: issuer.ticker, name: issuer.name, exchange: issuer.exchange, currency: 'XXX', kind: 'other' }; assets.set(issuer, asset); }
      return asset;
    },
  };
}

const directories = new ReadCache<SecDirectory>({ ttlMs: DIRECTORY_TTL, max: 1 });
/** A kept document and the moment it was actually read: an answer reused within its lifetime says so (retrievedAt is never moved forward). */
export interface SecDocument { body: string; at: string }
const submissions = new ReadCache<SecDocument>({ ttlMs: SUBMISSIONS_TTL, max: 24 });
const facts = new ReadCache<SecDocument>({ ttlMs: FACTS_TTL, max: 4 });
const stamped = (load: (signal: AbortSignal) => Promise<string>) => async (signal: AbortSignal): Promise<SecDocument> => ({ body: await load(signal), at: new Date().toISOString() });

/** The indexed directory: one download per hour for the whole app. `load` returns the parsed document and receives the read's own signal. */
export function readSecDirectory(load: (signal: AbortSignal) => Promise<unknown>, options: ReadOptions = {}): Promise<SecDirectory> {
  return directories.get(SEC_DIRECTORY_URL, async (signal) => parseSecDirectory(await load(signal)), options);
}
/** One issuer's submissions document as text (kept as text so no caller can change what another one reads). */
export function readSecSubmissionsText(url: string, load: (signal: AbortSignal) => Promise<string>, options: ReadOptions = {}): Promise<SecDocument> {
  return submissions.get(url, stamped(load), options);
}
/** One issuer's company facts document as text. */
export function readSecCompanyFactsText(url: string, load: (signal: AbortSignal) => Promise<string>, options: ReadOptions = {}): Promise<SecDocument> {
  return facts.get(url, stamped(load), options);
}
/** Test seam: drop every kept SEC read. */
export function clearSecReads(): void { directories.clear(); submissions.clear(); facts.clear(); }
