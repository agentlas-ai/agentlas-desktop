import type { FinanceAIResult, FinanceAsset, FinanceDataRequest, FinanceDataResult, FinanceOperation, FinanceSearchResult, FinanceWorkspace } from '../../shared/finance';

import { fetchFinanceJson } from './providers/http';
export { fetchFinanceJson } from './providers/http';
import { queryBluesky, queryFedNews, queryIsharesHoldings, queryIsharesNav, queryTreasury, parseCompanyFacts } from './providers/public-data';

import { ISHARES_FUNDS, findIsharesFund, searchIsharesCatalog } from './providers/ishares-catalog';
import { financeProviderKey as providerKey } from './provider-credentials';
import { searchYahooFinanceAssets, queryYahooFinanceData, refreshYahooFinanceQuotes } from './providers/yahoo-market';

/** Host-selected owner preference, not accepted as a caller URL, credential or executable. */
export interface FinanceDataRoute { sourceId: string; signal?: AbortSignal; assertCurrent?:()=>void }

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
export async function searchFinanceAssets(query: string, route?: FinanceDataRoute): Promise<FinanceSearchResult> {
  const normalized = query.trim(); if (!normalized || normalized.length > 200) throw new Error('finance_query_invalid');
  if(route?.sourceId.startsWith('toolchain:')){const {searchFinanceAdapter}=await import('./source-adapters');return searchFinanceAdapter(route.sourceId,normalized,route.signal,route.assertCurrent);}
  if(route?.sourceId==='finance-yfinance'){
    const result=await searchYahooFinanceAssets(normalized,{signal:route.signal}),issuer=searchIsharesCatalog(normalized);
    return issuer.length?{...result,assets:[...issuer,...result.assets.filter(asset=>!issuer.some(fund=>fund.symbol===asset.symbol))].slice(0,30),provider:'Free market data · Yahoo chart + verified issuer catalog',warnings:[...result.warnings,'Issuer catalog entries identify supported iShares funds; their metadata is not a live quote or a complete ETF directory.']}:result;
  }
  if(route&&route.sourceId!=='alpha-vantage')return{assets:[],provider:'Selected data source',asOf:null,warnings:['finance_data_source_unsupported']};
  const catalog=searchIsharesCatalog(normalized),catalogWarnings=catalog.length?[
    `Issuer catalog verified 2026-10-18: ${ISHARES_FUNDS.map(fund=>fund.asset.symbol).join(', ')} only. Fund identity, listing and currency metadata are not live quotes or a complete ETF directory.`,
    ...catalog.map(asset=>{const fund=findIsharesFund(asset.id)!;return `${asset.symbol}: NAV supported; ${fund.holdingsUrl?'issuer holdings CSV supported':'no supported holdings CSV observed'}; source ${fund.pageUrl}`;}),
    ...(catalog.some(asset=>asset.symbol==='IAU')?['IAU is a gold grantor trust and is cataloged as a fund, not a registered 1940 Act ETF or a direct gold position.']:[]),
  ]:[];
  const warnings: string[] = [];
  const exact=catalog.find(asset=>asset.symbol===normalized.toUpperCase());
  if(exact)return {assets:[exact],provider:'iShares official product catalog',asOf:null,warnings:catalogWarnings};
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
      return { assets: [...catalog,...assets.filter(asset=>!catalog.some(issuer=>issuer.symbol===asset.symbol))].slice(0,30), provider: catalog.length?'iShares official product catalog + Alpha Vantage':'Alpha Vantage', asOf: null, warnings: [...catalogWarnings,'Search metadata has no market-price timestamp. Region is provider metadata, not a verified listing venue.'] };
    } catch (error) { warnings.push(safeError(error)); }
  }
  try {
    const q = normalized.toLocaleLowerCase(); const assets = [...catalog, ...(await secAssets()).filter(asset => asset.symbol.toLowerCase().includes(q) || asset.name.toLowerCase().includes(q)).sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q)).slice(0, 30)].slice(0, 30);
    return { assets, provider: catalog.length ? 'iShares official product catalog + SEC EDGAR issuer directory' : 'SEC EDGAR issuer directory', asOf: null, warnings: [...warnings,...catalogWarnings, 'SEC records identify US issuers; their security type and currency (XXX) are unknown. Separate issuer catalog entries are verified against issuer pages. No price data or ETF completeness is implied.'] };
  } catch (error) { return { assets: catalog, provider: catalog.length?'iShares official product catalog':'SEC EDGAR', asOf: null, warnings: [...warnings,...catalogWarnings,safeError(error)] }; }
}
async function queryFinanceDataRaw(input: FinanceDataRequest, assets: FinanceAsset[], route?: FinanceDataRoute): Promise<FinanceDataResult> {
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
    const fund=findIsharesFund(asset.id);
    if(fund&&(asset.symbol!==fund.asset.symbol||asset.currency!==fund.asset.currency||asset.kind!==fund.asset.kind))throw new Error('finance_source_identity_mismatch');
    if(metric==='nav'&&fund)return await queryIsharesNav(fund);
    if(metric==='etf_holdings'&&fund)return await queryIsharesHoldings(fund);
    if(metric==='nav')return {...result,warnings:['Keyless issuer NAV coverage is limited to issuer-resolved IVV, IEF, TLT, IWM and IAU catalog entries. No NAV was inferred from market price.']};
    if (metric === 'filings' || metric === 'company_facts') {
      let cik = /^sec:(\d{10}):/.exec(asset.id)?.[1];
      if (!cik && (asset.id === `av:${asset.symbol}` && asset.exchange === 'United States' || asset.id === `yahoo:${encodeURIComponent(asset.symbol)}`)) {
        const matches = (await secAssets()).filter(item => item.symbol === asset.symbol);
        if (matches.length === 1) cik = /^sec:(\d{10}):/.exec(matches[0].id)?.[1];
        else return {...result,warnings:['No sole exact SEC directory ticker match is available. No issuer CIK was inferred from country, currency, name or a similar ticker.']};
      }
      if (!cik) return { ...result, warnings: ['No unambiguous SEC issuer mapping is available.'] };
      if (metric === 'company_facts') return parseCompanyFacts(await fetchFinanceJson(new URL(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)), cik);
      const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
      result.sourceUrls = [url];
      const submission=object(await fetchFinanceJson(new URL(url)));
      if(String(submission.cik).padStart(10,'0')!==cik)throw new Error('finance_source_identity_mismatch');
      const recent = object(object(submission.filings).recent);
      if (!Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) throw new Error('finance_source_shape');
      result.columns = ['Form', 'Filed', 'Accession', 'Document'];
      result.rows = recent.accessionNumber.slice(0, 40).map((accession, i) => {
        const document = string(Array.isArray(recent.primaryDocument) ? recent.primaryDocument[i] : '');
        const link = financeSecDocumentUrl(cik!, string(accession), document);
        return [string((recent.form as unknown[])[i]), string((recent.filingDate as unknown[])[i]), string(accession), link];
      });
      result.status = 'partial'; result.warnings = [`SEC issuer CIK ${cik}; exact directory ticker mapping where the selected listing was not already SEC-resolved. This is an issuer mapping, not a corporate-action or security-lineage guarantee.`, 'Latest 40 recent SEC filing records only; older filing archive pages are not exhausted. Filing date is day precision, not a market-price or availability timestamp. Current feed is not a historical point-in-time vintage.', 'SEC public API access is subject to fair-access policy. No blanket redistribution right to third-party filing exhibits is implied.']; return result;
    }
    if(route?.sourceId==='finance-yfinance')return{...result,warnings:['The selected free market engine does not supply this metric for this listing. No Alpha Vantage request or macro-news substitution was made.']};
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
export async function queryFinanceData(input: FinanceDataRequest, assets: FinanceAsset[], route?: FinanceDataRoute): Promise<FinanceDataResult> {
  if(route?.sourceId.startsWith('toolchain:')){const {queryFinanceAdapter}=await import('./source-adapters');return queryFinanceAdapter(route.sourceId,input,assets,route.signal,route.assertCurrent);}
  if(route?.signal?.aborted)throw new Error('finance_yahoo_cancelled');
  if(route?.sourceId==='finance-yfinance'&&['price','price_history'].includes(input.metrics[0]))return queryYahooFinanceData(input,assets,{signal:route.signal});
  if(route&& !['finance-yfinance','alpha-vantage'].includes(route.sourceId))return{status:'unconnected',sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:['finance_data_source_unsupported']};
  const result = await queryFinanceDataRaw(input, assets, route), metric = input.metrics[0];
  if(route?.signal?.aborted)throw new Error('finance_yahoo_cancelled');
  const issuer=input.assetIds.length===1?findIsharesFund(input.assetIds[0]):undefined;
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
  } else if ((metric==='nav'||metric==='etf_holdings')&&!!issuer) {
    id = `ishares-${issuer!.asset.symbol.toLowerCase()}`; label = `iShares ${issuer!.asset.symbol} official issuer`; coverage = metric === 'nav' ? `One ${issuer!.asset.symbol} NAV observation; not market price or a historical series.` : issuer!.holdingsUrl?`One ${issuer!.asset.symbol} issuer ${issuer!.holdingsSchema} holdings file; selected fields, at most 5000 recognized rows, weights preserved without normalization.`:`${issuer!.asset.symbol}: no supported holdings CSV observed; no inferred gold inventory or proxy holdings.`;
    if(!result.sourceUrls.length)result.sourceUrls=[issuer!.pageUrl];
    rights = 'Public issuer download does not grant blanket redistribution rights. Issuer terms and current prospectus apply.';
  } else if (metric === 'treasury_yields') {
    id = 'us-treasury'; label = 'U.S. Treasury daily par curve'; coverage = 'Latest 22 observed days in one requested month; not an individual bond price or YTM.';
    rights = 'Official Treasury public data with attribution; third-party materials may have separate rights.';
    if (!result.sourceUrls.length) result.sourceUrls = ['https://home.treasury.gov/treasury-daily-interest-rate-xml-feed'];
  } else if(route?.sourceId==='finance-yfinance'){
    id='finance-yfinance';label='Free market data · Yahoo chart';coverage='Search, regular-market snapshots and bounded daily price history. Unsupported metrics remain unavailable for the selected source.';rights='Yahoo personal-use data terms apply; public access is not exchange real-time or redistribution entitlement.';
  } else if (['price','price_history','news','etf_holdings'].includes(metric)) {
    id = 'alpha-vantage'; label = 'Alpha Vantage'; coverage = 'Provider-resolved selected security only; daily quote, compact raw history, selected news, or reported ETF profile according to metric and entitlement.';
    rights = 'A configured key does not establish entitlement to every endpoint or external redistribution. Provider terms and account license apply.';
  }
  if (id) result.providers = [{ id, label, status: result.status === 'unconnected' ? 'unavailable' : result.status, coverage, rights, sourceUrls: [...result.sourceUrls] }];
  result.retrievedAt = new Date().toISOString();
  return result;
}

/** Source-derived proposals share the same renderer CAS path; no AI supplies these numbers. */
export async function refreshFinanceQuotes(workspace: FinanceWorkspace, route?: FinanceDataRoute): Promise<FinanceAIResult> {
  if(route?.sourceId==='finance-yfinance')return refreshYahooFinanceQuotes(workspace,{signal:route.signal});
  if(route?.sourceId.startsWith('toolchain:')){
    const operations:FinanceOperation[]=[],warnings:string[]=[];
    for(const asset of workspace.watchlist.slice(0,5)){
      route.signal?.throwIfAborted();const result=await queryFinanceData({query:asset.symbol,assetIds:[asset.id],metrics:['price'],period:'1M'},workspace.watchlist,route);
      const row=result.rows[0],column=(name:string)=>result.columns.indexOf(name),price=row?.[column('Price')],currency=row?.[column('Currency')],asOf=row?.[column('Observed at')];
      if(!['ok','partial'].includes(result.status)||result.rows.length!==1||row?.[column('Symbol')]!==asset.symbol||typeof price!=='number'||price<0||currency!==asset.currency||typeof asOf!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(asOf)||!Number.isFinite(Date.parse(asOf))||!result.sourceUrls.length){warnings.push(`${asset.symbol}: finance_adapter_quote_schema_unsupported`);continue;}
      const sourceId=`adapter-quote:${encodeURIComponent(asset.id)}`.slice(0,200);operations.push({type:'source.upsert',source:{id:sourceId,name:'선택한 데이터 도구',kind:'provider',status:'connected',asOf,retrievedAt:result.retrievedAt,url:result.sourceUrls[0],note:result.sourceUrls.join('\n')}},{type:'quotes.import',quotes:[{assetId:asset.id,price,currency:asset.currency,asOf,sourceId,priceBasis:'price'}]});
    }
    return{baseRevision:workspace.revision,status:operations.length?'ok':'unavailable',operations,message:`${operations.length/2}개 시세를 조회했습니다. ${warnings.join(' ')}`.trim()};
  }
  if(route&&route.sourceId!=='alpha-vantage')return{baseRevision:workspace.revision,status:'unavailable',operations:[],message:'finance_data_source_unsupported'};
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
