import type { FinanceAIResult, FinanceAsset, FinanceDataRequest, FinanceDataResult, FinanceOperation, FinanceSearchResult, FinanceWorkspace } from '../../shared/finance';

import { fetchFinanceJson } from './providers/http';
export { fetchFinanceJson } from './providers/http';
import { PUBLIC_FUND, queryBluesky, queryFedNews, queryIvvHoldings, queryIvvNav, queryTreasury, parseCompanyFacts } from './providers/public-data';

const AV_DOC = 'https://www.alphavantage.co/documentation/';
const SEC_INDEX = 'https://www.sec.gov/files/company_tickers_exchange.json';
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finance_source_shape'); return value as ObjectValue; }
function string(value: unknown): string { return typeof value === 'string' ? value.slice(0, 20000) : ''; }
function numeric(value: unknown): number | null { const n = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : null; }
function publicUrl(value: unknown): string | null { try { const url = new URL(string(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } }
export function financeSecDocumentUrl(cik: string, accession: string, primaryDocument: unknown): string | null {
  if (!/^\d{1,10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || typeof primaryDocument !== 'string' || primaryDocument.length > 2000) return null;
  const segments = primaryDocument.split('/');
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment))) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
}
async function providerKey(): Promise<string | null> {
  try {
    const { readEnvVar } = await import('../secrets/vault');
    return (await readEnvVar('ALPHAVANTAGE_API_KEY'))?.trim() || process.env.ALPHAVANTAGE_API_KEY?.trim() || null;
  } catch {
    const configured = process.env.ALPHAVANTAGE_API_KEY?.trim();
    if (configured) return configured;
    throw new Error('finance_provider_credentials_unavailable');
  }
}
async function avUrl(fn: string, params: Record<string, string>): Promise<URL | null> {
  const key = await providerKey(); if (!key) return null;
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', fn); url.searchParams.set('apikey', key);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}
function avResult(value: unknown): ObjectValue {
  const data = object(value);
  if (data.Note || data.Information || data['Error Message']) throw new Error('finance_provider_limit_or_entitlement');
  return data;
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^finance_[a-z0-9_]+$/.test(message) ? message : 'finance_source_unavailable';
}
let secCache: { at: number; assets: FinanceAsset[] } | null = null;
async function secAssets(): Promise<FinanceAsset[]> {
  if (secCache && Date.now() - secCache.at < 3600000) return secCache.assets;
  const response = object(await fetchFinanceJson(new URL(SEC_INDEX)));
  if (!Array.isArray(response.fields) || !Array.isArray(response.data)) throw new Error('finance_source_shape');
  const fields = response.fields;
  const index = (name: string) => { const result = fields.indexOf(name); if (result < 0) throw new Error('finance_source_shape'); return result; };
  const cik = index('cik'), ticker = index('ticker'), name = index('name'), exchange = index('exchange');
  const assets: FinanceAsset[] = [];
  for (const row of response.data.slice(0, 50000)) {
    if (!Array.isArray(row) || !/^\d{1,10}$/.test(String(row[cik])) || !string(row[ticker]) || !string(row[name])) continue;
    // SEC registration identifies an issuer; it does not establish a security's fund classification.
    assets.push({ id: `sec:${String(row[cik]).padStart(10, '0')}:${string(row[ticker])}`, symbol: string(row[ticker]).slice(0, 80), name: string(row[name]).slice(0, 300), exchange: string(row[exchange]).slice(0, 80), currency: 'XXX', kind: 'other' });
  }
  secCache = { at: Date.now(), assets }; return assets;
}
export async function searchFinanceAssets(query: string): Promise<FinanceSearchResult> {
  const normalized = query.trim(); if (!normalized || normalized.length > 200) throw new Error('finance_query_invalid');
  const warnings: string[] = [];
  if (normalized.toUpperCase() === PUBLIC_FUND.symbol) return { assets: [{ ...PUBLIC_FUND }], provider: 'iShares official product catalog', asOf: null, warnings: ['Fund identity, listing and currency are issuer product metadata, not a live quote. Keyless issuer coverage is IVV only. Source: https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf'] };
  let url: URL | null = null;
  try { url = await avUrl('SYMBOL_SEARCH', { keywords: normalized }); }
  catch { warnings.push('Alpha Vantage credentials are unavailable. Searching the public SEC directory instead.'); }
  if (url) {
    try {
      const result = avResult(await fetchFinanceJson(url));
      if (!Array.isArray(result.bestMatches)) throw new Error('finance_source_shape');
      const assets = result.bestMatches.slice(0, 30).map(raw => {
        const row = object(raw), symbol = string(row['1. symbol']), currency = string(row['8. currency']);
        if (!/^[A-Z]{3}$/.test(currency) || !/^[A-Za-z0-9.^_-]{1,80}$/.test(symbol)) throw new Error('finance_source_shape');
        return { id: `av:${symbol}`, symbol, name: string(row['2. name']).slice(0, 300), currency, exchange: string(row['4. region']).slice(0, 80), kind: /ETF/i.test(string(row['3. type'])) ? 'etf' as const : /Equity/i.test(string(row['3. type'])) ? 'stock' as const : 'other' as const };
      });
      return { assets, provider: 'Alpha Vantage', asOf: null, warnings: ['Search metadata has no market-price timestamp. Region is provider metadata, not a verified listing venue.'] };
    } catch (error) { warnings.push(safeError(error)); }
  }
  try {
    const q = normalized.toLocaleLowerCase(); const catalog = [PUBLIC_FUND].filter(asset => asset.symbol.toLowerCase().includes(q) || asset.name.toLowerCase().includes(q)); const assets = [...catalog, ...(await secAssets()).filter(asset => asset.symbol.toLowerCase().includes(q) || asset.name.toLowerCase().includes(q)).sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q)).slice(0, 30)].slice(0, 30);
    return { assets, provider: catalog.length ? 'iShares official product catalog + SEC EDGAR issuer directory' : 'SEC EDGAR issuer directory', asOf: null, warnings: [...warnings, 'SEC records identify US issuers; their security type and currency (XXX) are unknown. The separate IVV catalog entry is verified against its issuer page. No price data or ETF completeness is implied.'] };
  } catch (error) { return { assets: [], provider: 'SEC EDGAR', asOf: null, warnings: [...warnings, safeError(error)] }; }
}
async function queryFinanceDataRaw(input: FinanceDataRequest, assets: FinanceAsset[]): Promise<FinanceDataResult> {
  const result: FinanceDataResult = { status: 'unconnected', sourceUrls: [], asOf: null, retrievedAt: new Date().toISOString(), columns: [], rows: [], warnings: [] };
  const metric = input.metrics[0];
  if (input.metrics.length !== 1) return { ...result, warnings: ['Choose exactly one metric per source query; results are not silently combined.'] };
  try {
    // Global feeds are explicitly independent of a selected security.
    if (metric === 'social' || metric === 'social_search') return await queryBluesky(input.query, metric === 'social_search');
    if (metric === 'macro_news') return await queryFedNews();
    if (metric === 'treasury_yields') return await queryTreasury(input.period);
    if (input.assetIds.length !== 1) return { ...result, warnings: ['Select exactly one asset for this source query. Global social, macro_news and treasury_yields do not require an asset.'] };
    const asset = assets.find(item => item.id === input.assetIds[0]);
    if (!asset) throw new Error('finance_asset_not_found');
    if (metric === 'nav' && asset.id === PUBLIC_FUND.id && asset.symbol === PUBLIC_FUND.symbol) return await queryIvvNav();
    if (metric === 'nav') return { ...result, warnings: ['Keyless issuer NAV coverage currently includes the issuer-resolved IVV catalog entry only; no NAV was inferred from market price.'] };
    if (metric === 'etf_holdings' && asset.id === PUBLIC_FUND.id && asset.symbol === PUBLIC_FUND.symbol) return await queryIvvHoldings();
    if (metric === 'filings' || metric === 'company_facts') {
      let cik = /^sec:(\d{10}):/.exec(asset.id)?.[1];
      if (!cik && asset.id === `av:${asset.symbol}` && asset.exchange === 'United States') {
        const matches = (await secAssets()).filter(item => item.symbol === asset.symbol);
        if (matches.length === 1) cik = /^sec:(\d{10}):/.exec(matches[0].id)?.[1];
      }
      if (!cik) return { ...result, warnings: ['No unambiguous SEC issuer mapping is available.'] };
      if (metric === 'company_facts') return parseCompanyFacts(await fetchFinanceJson(new URL(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)), cik);
      const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
      result.sourceUrls = [url];
      const recent = object(object(object(await fetchFinanceJson(new URL(url))).filings).recent);
      if (!Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) throw new Error('finance_source_shape');
      result.columns = ['Form', 'Filed', 'Accession', 'Document'];
      result.rows = recent.accessionNumber.slice(0, 40).map((accession, i) => {
        const document = string(Array.isArray(recent.primaryDocument) ? recent.primaryDocument[i] : '');
        const link = financeSecDocumentUrl(cik!, string(accession), document);
        return [string((recent.form as unknown[])[i]), string((recent.filingDate as unknown[])[i]), string(accession), link];
      });
      result.status = 'partial'; result.warnings = ['Latest 40 recent SEC filing records only; older filing archive pages are not exhausted. Filing date is day precision, not a market-price or availability timestamp. Current feed is not a historical point-in-time vintage.', 'SEC public API access is subject to fair-access policy. No blanket redistribution right to third-party filing exhibits is implied.']; return result;
    }
    const functions: Record<string, string> = { price: 'GLOBAL_QUOTE', price_history: 'TIME_SERIES_DAILY', news: 'NEWS_SENTIMENT', etf_holdings: 'ETF_PROFILE' };
    if (!functions[metric] || input.metrics.length !== 1) return { ...result, warnings: ['Supported source metrics: price, price_history, nav, news, filings, company_facts, etf_holdings, social, social_search, macro_news, treasury_yields. Unsupported data is never synthesized.'] };
    if (!/^[A-Za-z0-9.^_-]{1,80}$/.test(asset.symbol)) throw new Error('finance_symbol_invalid');
    let url: URL | null = null;
    try { url = await avUrl(functions[metric], metric === 'news' ? { tickers: asset.symbol, limit: '30' } : metric === 'price_history' ? { symbol: asset.symbol, outputsize: 'compact' } : { symbol: asset.symbol }); } catch (error) { if (metric !== 'news') throw error; }
    result.sourceUrls = [AV_DOC];
    if (!url) {
      if (metric === 'news') { const global = await queryFedNews(); global.warnings.unshift('Company news provider is unavailable. This fallback contains Federal Reserve macro announcements, not news about the selected company.'); return global; }
      return { ...result, warnings: ['Alpha Vantage connection is not configured. Connect your licensed data provider. No quotes, history, or holdings were fabricated.'] };
    }
    const data = avResult(await fetchFinanceJson(url));
    if (metric === 'price') {
      const quote = object(data['Global Quote']); const price = numeric(quote['05. price']), day = string(quote['07. latest trading day']);
      if (price === null || price < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day) || string(quote['01. symbol']) !== asset.symbol) throw new Error('finance_source_shape');
      result.columns = ['Symbol', 'Price', 'Latest trading day', 'Volume']; result.rows = [[asset.symbol, price, day, numeric(quote['06. volume'])]];
      result.asOf = day;
      result.warnings.push('Provider trading-day quote; not asserted real-time. Currency, adjustment basis, and exact observation time are not supplied by this endpoint. No quote is imported automatically.');
    } else if (metric === 'price_history') {
      const series = object(data['Time Series (Daily)']);
      result.columns = ['Observation date', 'Symbol', 'Open', 'High', 'Low', 'Close (raw)', 'Volume'];
      result.rows = Object.entries(series).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort(([a],[b]) => a.localeCompare(b)).slice(-100).map(([day, raw]) => { const row = object(raw); return [day, asset.symbol, numeric(row['1. open']), numeric(row['2. high']), numeric(row['3. low']), numeric(row['4. close']), numeric(row['5. volume'])]; });
      if (!result.rows.length || string(object(data['Meta Data'])['2. Symbol']) !== asset.symbol) throw new Error('finance_source_shape');
      result.asOf = String(result.rows.at(-1)![0]);
      result.warnings.push('At most 100 raw daily OHLC observations from the compact endpoint. The requested display period is not an assurance of historical coverage. Raw closes are not dividend/split-adjusted total returns; do not infer performance across corporate actions. Currency is not reverified by this endpoint. Provider entitlements and redistribution terms apply.');
    } else if (metric === 'news') {
      if (!Array.isArray(data.feed)) throw new Error('finance_source_shape');
      result.columns = ['Title', 'Publisher', 'Published', 'URL']; result.rows = data.feed.slice(0, 30).map(raw => { const row = object(raw); return [string(row.title), string(row.source), string(row.time_published), publicUrl(row.url)]; });
      result.warnings.push('Provider-selected news metadata; coverage is incomplete and article redistribution rights are not granted.');
    } else {
      if (!Array.isArray(data.holdings)) throw new Error('finance_source_shape');
      result.columns = ['Symbol', 'Description', 'Weight']; result.rows = data.holdings.slice(0, 1000).map(raw => { const row = object(raw); return [string(row.symbol), string(row.description), numeric(row.weight)]; });
      result.warnings.push('Provider ETF holdings snapshot; composition effective date is unavailable. Weights are preserved as reported, not inferred to sum to 100%.');
    }
    result.status = 'partial'; return result;
  } catch (error) { return { ...result, status: 'error', rows: [], warnings: [...result.warnings, safeError(error)] }; }
}

/** Every result carries an explicit provider/coverage/rights status, including failures. */
export async function queryFinanceData(input: FinanceDataRequest, assets: FinanceAsset[]): Promise<FinanceDataResult> {
  const result = await queryFinanceDataRaw(input, assets), metric = input.metrics[0];
  let id = '', label = '', coverage = '', rights = '';
  if (result.sourceUrls.some(url => url === 'https://www.federalreserve.gov/feeds/press_all.xml') || metric === 'macro_news') {
    id = 'federal-reserve-rss'; label = 'Federal Reserve Board RSS'; coverage = 'Latest 40 official macro announcements; one publisher, independent of selected securities.';
    rights = 'RSS headline/link metadata. No license to republish third-party material or linked full articles is established.';
  } else if (metric === 'social' || metric === 'social_search') {
    id = 'bluesky-public'; label = 'Bluesky public API'; coverage = metric === 'social' ? 'One explicit author feed or the default official Federal Reserve account; latest 20 posts, not security-specific search.' : 'Latest 20 keyword search results if the public endpoint permits access; relevance and complete pagination are not verified.';
    rights = 'Public read access is not a blanket redistribution license. Author attribution and original links retained; posts are unverified claims.';
    if (!result.sourceUrls.length) result.sourceUrls = [metric === 'social_search' ? 'https://docs.bsky.app/docs/api/app-bsky-feed-search-posts' : 'https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed'];
  } else if (metric === 'filings' || metric === 'company_facts') {
    id = 'sec-edgar'; label = 'SEC EDGAR'; coverage = metric === 'filings' ? 'Latest 40 recent issuer filing records; archive pages not exhausted.' : 'Selected standardized US-GAAP concepts with original units, periods and filed dates; current feed, not a historical vintage.';
    rights = 'SEC fair-access policy applies. Third-party filing exhibits and issuer materials may carry separate rights.';
    if (!result.sourceUrls.length) result.sourceUrls = ['https://www.sec.gov/search-filings/edgar-application-programming-interfaces'];
  } else if (result.sourceUrls.some(url => url.includes('ishares.com')) || (metric === 'nav' || metric === 'etf_holdings') && input.assetIds.includes(PUBLIC_FUND.id)) {
    id = 'ishares-ivv'; label = 'iShares IVV official issuer'; coverage = metric === 'nav' ? 'One IVV NAV observation; not market price or a historical series.' : 'One IVV issuer holdings file, including reported cash/derivative rows; weights preserved without normalization.';
    rights = 'Public issuer download does not grant blanket redistribution rights. Issuer terms and current prospectus apply.';
  } else if (metric === 'treasury_yields') {
    id = 'us-treasury'; label = 'U.S. Treasury daily par curve'; coverage = 'Latest 22 observed days in one requested month; not an individual bond price or YTM.';
    rights = 'Official Treasury public data with attribution; third-party materials may have separate rights.';
    if (!result.sourceUrls.length) result.sourceUrls = ['https://home.treasury.gov/treasury-daily-interest-rate-xml-feed'];
  } else if (['price','price_history','news','etf_holdings'].includes(metric)) {
    id = 'alpha-vantage'; label = 'Alpha Vantage'; coverage = 'Provider-resolved selected security only; daily quote, compact raw history, selected news, or reported ETF profile according to metric and entitlement.';
    rights = 'A configured key does not establish entitlement to every endpoint or external redistribution. Provider terms and account license apply.';
  }
  if (id) result.providers = [{ id, label, status: result.status === 'unconnected' ? 'unavailable' : result.status, coverage, rights, sourceUrls: [...result.sourceUrls] }];
  result.retrievedAt = new Date().toISOString();
  return result;
}

/** Source-derived proposals share the same renderer CAS path; no AI supplies these numbers. */
export async function refreshFinanceQuotes(workspace: FinanceWorkspace): Promise<FinanceAIResult> {
  const base = { baseRevision: workspace.revision };
  try {
    if (!await providerKey()) return { ...base, status: 'unavailable', message: 'Alpha Vantage connection is not configured. Connect your data provider. No quotes were imported.', operations: [] };
  } catch { return { ...base, status: 'unavailable', message: 'Alpha Vantage credentials are unavailable. Check your data connection. No quotes were imported.', operations: [] }; }
  const operations: FinanceOperation[] = [], warnings: string[] = [];
  // Bounded explicit refresh, never background polling or an unlimited provider bill.
  const eligible = workspace.watchlist.filter(asset => asset.id === `av:${asset.symbol}`).slice(0, 5);
  for (const asset of eligible) {
    try {
      const search = avResult(await fetchFinanceJson((await avUrl('SYMBOL_SEARCH', { keywords: asset.symbol }))!));
      if (!Array.isArray(search.bestMatches)) throw new Error('finance_source_shape');
      const matches = search.bestMatches.map(object).filter(row => row['1. symbol'] === asset.symbol && row['4. region'] === asset.exchange);
      if (matches.length !== 1 || matches[0]['8. currency'] !== asset.currency || !/^[A-Z]{3}$/.test(asset.currency) || asset.currency === 'XXX') { warnings.push(`${asset.symbol}: currency or listing metadata could not be verified.`); continue; }
      const data = avResult(await fetchFinanceJson((await avUrl('GLOBAL_QUOTE', { symbol: asset.symbol }))!));
      const quote = object(data['Global Quote']), price = numeric(quote['05. price']), day = string(quote['07. latest trading day']);
      if (string(quote['01. symbol']) !== asset.symbol || price === null || price < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))) throw new Error('finance_source_shape');
      const sourceId = `alpha-vantage:${asset.symbol}`;
      operations.push({ type: 'source.upsert', source: { id: sourceId, name: `Alpha Vantage · ${asset.symbol}`, kind: 'provider', status: 'connected', asOf: day, retrievedAt: new Date().toISOString(), url: AV_DOC,
        note: 'GLOBAL_QUOTE, day precision; currency verified by exact SYMBOL_SEARCH symbol and region. Not asserted real-time. Adjustment/split policy is not guaranteed; dividends are not included and this is not a total-return series.' } });
      operations.push({ type: 'quotes.import', quotes: [{ assetId: asset.id, price, currency: asset.currency, asOf: day, sourceId, priceBasis: 'price' }] });
    } catch (error) { warnings.push(`${asset.symbol}: ${safeError(error)}`); }
  }
  if (!eligible.length) warnings.push('No provider-resolved Alpha Vantage asset is selected. Search and add a provider result first.');
  if (workspace.watchlist.length > eligible.length) warnings.push('Refresh is limited to five provider-resolved assets; unsupported or remaining assets were skipped.');
  return { ...base, status: operations.length ? 'ok' : 'unavailable', message: `${operations.length / 2} daily quotes retrieved. ${warnings.join(' ')}`.trim(), operations };
}
