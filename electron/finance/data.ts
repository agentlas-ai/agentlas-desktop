import { FINANCE_FREE_SOURCE_ID, canonicalFinanceSourceId, type FinanceAsset, type FinanceDataRequest, type FinanceDataResult, type FinanceOperation, type FinanceSearchResult, type FinanceWorkspace } from '../../shared/finance';
import type { FinanceQuoteCoverage, FinanceQuoteRefreshResult } from './quote-coverage';

import { fetchFinanceJson, fetchFinanceText } from './providers/http';
export { fetchFinanceJson } from './providers/http';
import { queryFreeSource, FREE_SOURCE_METRICS, type FreeSourceMetric } from './providers/free-sources';
import { readSecDirectory, readSecSubmissionsText, readSecCompanyFactsText, SEC_DIRECTORY_URL, type SecDirectory } from './providers/sec-reads';
import { queryPublicCommunity, queryFedNews, queryIsharesHoldings, queryIsharesNav, queryTreasury, parseCompanyFacts } from './providers/public-data';

import { findIsharesFund, searchIsharesCatalog } from './providers/ishares-catalog';
import { queryFinanceNews } from './dashboard-feeds';
import { searchYahooFinanceAssets, queryYahooFinanceData, refreshYahooFinanceQuotes, queryYahooFinanceNews, yahooRefreshLimit } from './providers/yahoo-market';
import { resolveFinanceDataSource, type FinanceDataSelection } from '../../shared/finance-data-routing';
import type { FinanceFeedId } from '../../shared/finance-feeds';

/** Host-selected owner preference, not accepted as a caller URL, credential or executable. */
export interface FinanceDataRoute extends FinanceDataSelection { signal?: AbortSignal; assertCurrent?:()=>void; includeQuoteCoverage?:boolean }

const SEC_INDEX = SEC_DIRECTORY_URL;
/** Every Finance data path runs on the keyless free engine unless the owner picked a data tool. No route, or a saved route that still names the retired 'alpha-vantage' source, is the free engine. */
function freeRoute(route?: FinanceDataRoute): FinanceDataRoute {
  const base: FinanceDataRoute = route ?? { sourceId: FINANCE_FREE_SOURCE_ID };
  return { ...base, sourceId: canonicalFinanceSourceId(base.sourceId), ...(base.sourceBindings ? { sourceBindings: Object.fromEntries(Object.entries(base.sourceBindings).map(([category, value]) => [category, canonicalFinanceSourceId(value)])) as FinanceDataRoute['sourceBindings'] } : {}) };
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finance_source_shape'); return value as ObjectValue; }
function string(value: unknown): string { return typeof value === 'string' ? value.slice(0, 20000) : ''; }
export function financeSecDocumentUrl(cik: string, accession: string, primaryDocument: unknown): string | null {
  if (!/^\d{1,10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || typeof primaryDocument !== 'string' || primaryDocument.length > 2000) return null;
  const segments = primaryDocument.split('/');
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment))) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
}
/**
 * The names an issuer's EDGAR entity record lists before the current one, each with the day EDGAR stopped using it, as one sentence from the payload the filings query
 * already fetched (null when the record lists none). The dates are the record's, not the legal effective dates of a name change.
 */
export function secNameHistory(submission: ObjectValue): string | null {
  const line = (value: unknown, limit: number) => string(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/"/g, "'").replace(/\s{2,}/g, ' ').trim().slice(0, limit);
  const day = (value: unknown) => { const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(string(value)); return match && new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) === match[1] ? match[1] : null; };
  const earlier = new Map<string, { name: string; until: string | null }>();
  for (const raw of Array.isArray(submission.formerNames) ? submission.formerNames.slice(0, 50) : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as ObjectValue, name = line(entry.name, 160), until = day(entry.to);
    const key = `${name.toLowerCase()}|${until ?? ''}`;
    if (name && !earlier.has(key)) earlier.set(key, { name, until });
  }
  if (!earlier.size) return null;
  const sorted = [...earlier.values()].sort((a, b) => (b.until ?? '').localeCompare(a.until ?? ''));
  const shown = sorted.slice(0, 5).map(item => `"${item.name}"${item.until ? ` (until ${item.until})` : ''}`), current = line(submission.name, 160);
  return `${current ? `SEC entity record: current name "${current}"; earlier names: ` : 'SEC entity record, earlier names: '}${shown.join(', ')}${sorted.length > 5 ? `, and ${sorted.length - 5} more` : ''}. These are EDGAR record dates, not legal effective dates.`;
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^finance_[a-z0-9_]+$/.test(message) ? message : 'finance_source_unavailable';
}
/** The SEC ticker directory, indexed: one download per hour shared with the dashboard filings feed (providers/sec-reads.ts). */
function secDirectory(route?: FinanceDataRoute): Promise<SecDirectory> { return readSecDirectory(() => fetchFinanceJson(new URL(SEC_INDEX)), { signal: route?.signal }); }
/** One SEC document (an issuer's submissions or company facts): the last answer within its lifetime, otherwise one request. The kept copy is text that already parsed. */
async function secDocument(read: typeof readSecSubmissionsText, url: URL, route?: FinanceDataRoute): Promise<{ value: unknown; at: string }> {
  const document = await read(url.href, async () => { const text = await fetchFinanceText(url); try { JSON.parse(text); } catch { throw new Error('finance_source_shape'); } return text; }, { signal: route?.signal });
  try { return { value: JSON.parse(document.body), at: document.at }; } catch { throw new Error('finance_source_shape'); }
}
/** When a result's source was actually read, where that is earlier than the moment the result was assembled (a SEC document reused within its lifetime). */
const readAt = new WeakMap<object, string>();
/** Join only an exact US listing and a sole SEC ticker/venue record; names never participate. */
async function enrichSearchIssuers(result:FinanceSearchResult,route?:FinanceDataRoute):Promise<FinanceSearchResult>{
  const venues:Record<string,string>={NMS:'nasdaq',NGM:'nasdaq',NCM:'nasdaq',NYQ:'nyse',ASE:'nyse american',PCX:'nyse arca'};
  const candidates=result.assets.filter(asset=>asset.id===`yahoo:${encodeURIComponent(asset.symbol)}`&&asset.kind==='stock'&&asset.currency==='USD'&&Object.prototype.hasOwnProperty.call(venues,asset.exchange));
  if(!candidates.length)return result;
  route?.signal?.throwIfAborted();route?.assertCurrent?.();
  try{
    const directory=await secDirectory(route);route?.signal?.throwIfAborted();route?.assertCurrent?.();
    const identities=candidates.flatMap(asset=>{
      const matches=directory.byTicker.get(asset.symbol)??[];
      if(matches.length!==1||matches[0].exchange.toLowerCase()!==venues[asset.exchange])return [];
      const cik=matches[0].cik;
      return [{assetId:asset.id,issuer:{id:`sec:cik:${cik}`,name:matches[0].name,authority:'SEC EDGAR issuer directory',sourceUrl:SEC_INDEX},securityType:null,sourceUrls:[SEC_INDEX],warnings:['Exact ticker and compatible US listing venue match in the SEC issuer directory; security class and legal instrument type remain unknown.']}];
    });
    return identities.length?{...result,identities}:result;
  }catch{route?.signal?.throwIfAborted();route?.assertCurrent?.();return {...result,warnings:[...result.warnings,'finance_issuer_identity_unavailable']};}
}
export async function searchFinanceAssets(query: string, route?: FinanceDataRoute): Promise<FinanceSearchResult> {
  route=freeRoute(route);route={...route,sourceId:resolveFinanceDataSource(route,'market')};
  route.assertCurrent?.();const normalized = query.trim(); if (!normalized || normalized.length > 200) throw new Error('finance_query_invalid');
  if(route.sourceId.startsWith('toolchain:')){const {searchFinanceAdapter}=await import('./source-adapters');return searchFinanceAdapter(route.sourceId,normalized,route.signal,route.assertCurrent);}
  if(route.sourceId!==FINANCE_FREE_SOURCE_ID)return{assets:[],provider:'Selected data source',asOf:null,warnings:['finance_data_source_unsupported']};
  const result=await searchYahooFinanceAssets(normalized,{signal:route.signal});route.assertCurrent?.();const issuer=searchIsharesCatalog(normalized);
  return enrichSearchIssuers(issuer.length?{...result,assets:[...issuer,...result.assets.filter(asset=>!issuer.some(fund=>fund.symbol===asset.symbol))].slice(0,30),provider:'Free market data · Yahoo chart + verified issuer catalog',warnings:[...result.warnings,'Issuer catalog entries identify supported iShares funds; their metadata is not a live quote or a complete ETF directory.']}:result,route);
}
async function queryFinanceDataRaw(input: FinanceDataRequest, assets: FinanceAsset[], route?: FinanceDataRoute): Promise<FinanceDataResult> {
  const result: FinanceDataResult = { status: 'unconnected', sourceUrls: [], asOf: null, retrievedAt: new Date().toISOString(), columns: [], rows: [], warnings: [] };
  const metric = input.metrics[0];
  if (input.metrics.length !== 1) return { ...result, warnings: ['Choose exactly one metric per source query; results are not silently combined.'] };
  try {
    // Global feeds are explicitly independent of a selected security.
    if (metric === 'social' || metric === 'social_search') return await queryPublicCommunity(input.query, metric === 'social_search', input.period, route?.signal);
    if (metric === 'macro_news') {if(input.query.trim())return route?.sourceId==='finance-yfinance'?await queryYahooFinanceNews(input.query,{signal:route.signal}):{...result,warnings:['finance_global_news_source_unsupported']};return await queryFedNews();}
    if (metric === 'treasury_yields') return await queryTreasury(input.period);
    // Free sources with no key: global like Treasury yields, each a literal read of a public host, each failing alone as a data result.
    if ((FREE_SOURCE_METRICS as readonly string[]).includes(metric)) { const free = await queryFreeSource(metric as FreeSourceMetric, input.query, input.period, route?.signal); readAt.set(free, free.retrievedAt); return free; }
    if (input.assetIds.length !== 1) return { ...result, warnings: ['Select exactly one asset for this source query. Global social, macro_news, treasury_yields, macro_series, fx_rates and news_search do not require an asset.'] };
    const asset = assets.find(item => item.id === input.assetIds[0]);
    if (!asset) throw new Error('finance_asset_not_found');
    const fund=findIsharesFund(asset.id);
    if(fund&&(asset.symbol!==fund.asset.symbol||asset.currency!==fund.asset.currency||asset.kind!==fund.asset.kind))throw new Error('finance_source_identity_mismatch');
    if(metric==='news'&&route?.sourceId==='finance-yfinance')return await queryFinanceNews(asset,route.signal);
    if(metric==='nav'&&fund)return await queryIsharesNav(fund);
    if(metric==='etf_holdings'&&fund)return await queryIsharesHoldings(fund);
    if(metric==='nav')return {...result,warnings:['Keyless issuer NAV coverage is limited to issuer-resolved IVV, IEF, TLT, IWM and IAU catalog entries. No NAV was inferred from market price.']};
    if (metric === 'filings' || metric === 'company_facts') {
      let cik = /^sec:(\d{10}):/.exec(asset.id)?.[1];
      // A legacy `av:SYMBOL` id (saved by the retired provider) is the same symbol on the free engine, so it is looked up like `yahoo:<symbol>`.
      if (!cik && (asset.id === `av:${asset.symbol}` || asset.id === `yahoo:${encodeURIComponent(asset.symbol)}`)) {
        const matches = (await secDirectory(route)).byTicker.get(asset.symbol) ?? [];
        if (matches.length === 1) cik = matches[0].cik;
        else return {...result,warnings:['No sole exact SEC directory ticker match is available. No issuer CIK was inferred from country, currency, name or a similar ticker.']};
      }
      if (!cik) return { ...result, warnings: ['No unambiguous SEC issuer mapping is available.'] };
      if (metric === 'company_facts') { const facts = await secDocument(readSecCompanyFactsText, new URL(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`), route), parsed = parseCompanyFacts(facts.value, cik, input.facts); readAt.set(parsed, facts.at); return parsed; }
      const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
      result.sourceUrls = [url];
      const stored=await secDocument(readSecSubmissionsText, new URL(url), route),submission=object(stored.value);readAt.set(result, stored.at);
      if(String(submission.cik).padStart(10,'0')!==cik)throw new Error('finance_source_identity_mismatch');
      const recent = object(object(submission.filings).recent);
      if (!Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) throw new Error('finance_source_shape');
      result.columns = ['Form', 'Filed', 'Accession', 'Document'];
      result.rows = recent.accessionNumber.slice(0, 40).map((accession, i) => {
        const document = string(Array.isArray(recent.primaryDocument) ? recent.primaryDocument[i] : '');
        const link = financeSecDocumentUrl(cik!, string(accession), document);
        return [string((recent.form as unknown[])[i]), string((recent.filingDate as unknown[])[i]), string(accession), link];
      });
      result.status = 'partial'; result.warnings = [`SEC issuer CIK ${cik}; exact directory ticker mapping where the selected listing was not already SEC-resolved. This is an issuer mapping, not a corporate-action or security-lineage guarantee.`, 'Latest 40 recent SEC filing records only; older filing archive pages are not exhausted. Filing date is day precision, not a market-price or availability timestamp. Current feed is not a historical point-in-time vintage.', 'SEC public API access is subject to fair-access policy. No blanket redistribution right to third-party filing exhibits is implied.'];const nameHistory=secNameHistory(submission);if(nameHistory)result.warnings.push(nameHistory);return result;
    }
    return{...result,warnings:['The free market engine does not supply this metric for this listing. No other source or macro-news substitution was made.']};
  } catch (error) { return { ...result, status: 'error', rows: [], warnings: [...result.warnings, safeError(error)] }; }
}

/** Every result carries an explicit provider/coverage/rights status, including failures. */
export async function queryFinanceData(input: FinanceDataRequest, assets: FinanceAsset[], routeIn?: FinanceDataRoute): Promise<FinanceDataResult> {
  let route: FinanceDataRoute = freeRoute(routeIn);
  route.assertCurrent?.();
  // A user-entered symbol is not a verified instrument identity for any source.
  if(input.assetIds.some(id=>id.startsWith('manual:v1:')))return {status:'unconnected',sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:['finance_manual_asset_identity_unverified']};
  {
    const unavailable=(reason:string):FinanceDataResult=>({status:'unconnected',sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:[reason]});
    const feeds:Record<string,FinanceFeedId>={news:'finance-news',filings:'finance-sec',company_facts:'finance-sec',economic_calendar:'finance-economy',earnings:'finance-earnings'},enabled=route.enabledFeedIds;
    if(enabled&&input.metrics.some(metric=>Object.hasOwn(feeds,metric)&&!enabled.includes(feeds[metric])))return unavailable('finance_data_source_disabled');
    try{route={...route,sourceId:resolveFinanceDataSource(route,input.metrics)};}
    catch(error){if(error instanceof Error&&error.message==='finance_data_route_mixed_sources')return unavailable(error.message);throw error;}
  }
  if(route?.sourceId.startsWith('toolchain:')){const {queryFinanceAdapter}=await import('./source-adapters');return queryFinanceAdapter(route.sourceId,input,assets,route.signal,route.assertCurrent);}
  if(route?.signal?.aborted)throw new Error('finance_yahoo_cancelled');
  if(route?.sourceId==='finance-yfinance'&&['price','price_history'].includes(input.metrics[0])){const result=await queryYahooFinanceData(input,assets,{signal:route.signal});route.assertCurrent?.();return result;}
  if(route.sourceId!==FINANCE_FREE_SOURCE_ID)return{status:'unconnected',sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:['finance_data_source_unsupported']};
  const result = await queryFinanceDataRaw(input, assets, route), metric = input.metrics[0];route?.assertCurrent?.();
  if(route?.signal?.aborted)throw new Error('finance_yahoo_cancelled');
  const issuer=input.assetIds.length===1?findIsharesFund(input.assetIds[0]):undefined;
  let id = '', label = '', coverage = '', rights = '';
  if(metric==='news'&&route?.sourceId==='finance-yfinance'){
    id='yahoo-finance-rss';label='Yahoo Finance RSS';coverage='Selected-symbol headline/link metadata, latest 40 at most; provider-defined relevance, no period completeness or issuer-identity guarantee.';rights='Headline/link metadata only; publisher rights apply. Public read access is not a blanket article or redistribution license.';
  } else if (result.sourceUrls.some(url => url === 'https://www.federalreserve.gov/feeds/press_all.xml') || metric === 'macro_news'&&!input.query.trim()) {
    id = 'federal-reserve-rss'; label = 'Federal Reserve Board RSS'; coverage = 'Latest 40 official macro announcements; one publisher, independent of selected securities.';
    rights = 'RSS headline/link metadata. No license to republish third-party material or linked full articles is established.';
  } else if ((metric === 'social' || metric === 'social_search') && !result.providers?.length) {
    id = 'bluesky-public'; label = 'Bluesky public API'; coverage = result.sourceUrls.some(url=>url.includes('/app.bsky.feed.getAuthorFeed?')) ? 'One explicit @handle author feed, latest 20 posts; not a selected-company keyword search.' : 'Actual keyword search, latest 20 only if the public endpoint permits access; relevance/identity and complete pagination are not verified. No official-account substitution.';
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
  }
  if (id && !result.providers?.length) result.providers = [{ id, label, status: result.status === 'unconnected' ? 'unavailable' : result.status, coverage, rights, sourceUrls: [...result.sourceUrls] }];
  result.retrievedAt = readAt.get(result) ?? new Date().toISOString();
  return result;
}

/** Source-derived proposals share the same renderer CAS path; no AI supplies these numbers. */
export async function refreshFinanceQuotes(workspace: FinanceWorkspace, route?: FinanceDataRoute, options: { limit?: number } = {}): Promise<FinanceQuoteRefreshResult> {
  const coverage=(attempted:number,succeeded:number):FinanceQuoteCoverage=>({version:1,total:workspace.watchlist.length,attempted,succeeded,failed:attempted-succeeded,unattempted:workspace.watchlist.length-attempted});
  route=freeRoute(route);route={...route,sourceId:resolveFinanceDataSource(route,'market')};
  if(route.sourceId===FINANCE_FREE_SOURCE_ID){
    if(route.includeQuoteCoverage)return refreshYahooFinanceQuotes(workspace,{signal:route.signal,limit:options.limit,includeQuoteCoverage:true});
    return refreshYahooFinanceQuotes(workspace,{signal:route.signal,limit:options.limit});
  }
  if(route?.sourceId.startsWith('toolchain:')){
    const operations:FinanceOperation[]=[],warnings:string[]=[];
    const limit=yahooRefreshLimit(options.limit);
    for(const asset of workspace.watchlist.slice(0,limit)){
      route.signal?.throwIfAborted();const result=await queryFinanceData({query:asset.symbol,assetIds:[asset.id],metrics:['price'],period:'current'},workspace.watchlist,route);
      const row=result.rows[0],column=(name:string)=>result.columns.indexOf(name),price=row?.[column('Price')],currency=row?.[column('Currency')],asOf=row?.[column('Observed at')];
      if(!['ok','partial'].includes(result.status)||result.rows.length!==1||row?.[column('Symbol')]!==asset.symbol||typeof price!=='number'||price<0||currency!==asset.currency||typeof asOf!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(asOf)||!Number.isFinite(Date.parse(asOf))||!result.sourceUrls.length){warnings.push(`${asset.symbol}: finance_adapter_quote_schema_unsupported`);continue;}
      const sourceId=`adapter-quote:${encodeURIComponent(asset.id)}`.slice(0,200);operations.push({type:'source.upsert',source:{id:sourceId,name:'선택한 데이터 도구',kind:'provider',status:'connected',asOf,retrievedAt:result.retrievedAt,url:result.sourceUrls[0],note:result.sourceUrls.join('\n')}},{type:'quotes.import',quotes:[{assetId:asset.id,price,currency:asset.currency,asOf,sourceId,priceBasis:'price'}]});
    }
    return{baseRevision:workspace.revision,status:operations.length?'ok':'unavailable',operations,message:`${operations.length/2}개 시세를 조회했습니다. ${warnings.join(' ')}`.trim(),...(route.includeQuoteCoverage?{quoteCoverage:coverage(Math.min(workspace.watchlist.length,limit),operations.length/2)}:{})};
  }
  return{baseRevision:workspace.revision,status:'unavailable',operations:[],message:'finance_data_source_unsupported',...(route?.includeQuoteCoverage?{quoteCoverage:coverage(0,0)}:{})};
}
