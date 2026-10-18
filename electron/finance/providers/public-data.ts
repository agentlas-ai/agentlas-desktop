import type { FinanceAsset, FinanceDataResult } from '../../../shared/finance';
import { fetchFinanceJson, fetchFinanceText } from './http';
import { findIsharesFund, type IsharesFundDefinition } from './ishares-catalog';

export const FED_RSS = 'https://www.federalreserve.gov/feeds/press_all.xml';
export const IVV_PAGE = 'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf';
export const IVV_CSV = 'https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv';
export const PUBLIC_FUND: FinanceAsset = { id: 'ishares:IVV', symbol: 'IVV', name: 'iShares Core S&P 500 ETF', exchange: 'NYSE Arca', currency: 'USD', kind: 'etf' };
type Row = (string | number | null)[];
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finance_source_shape'); return value as Obj; }
function str(value: unknown): string { return typeof value === 'string' ? value.slice(0, 20000) : ''; }
function num(value: unknown): number | null { if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !value.trim()) return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function date(value: unknown): string | null { const s = str(value), parsed = Date.parse(`${s}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === s ? s : null; }
function instant(value: unknown): string | null { const s = str(value); return /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s)) ? s : null; }
function https(value: unknown): string | null { try { const u = new URL(str(value)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } }
function base(urls: string[]): FinanceDataResult { return { status: 'partial', sourceUrls: urls, asOf: null, retrievedAt: new Date().toISOString(), columns: [], rows: [], warnings: [] }; }
function newest(values: (string | null)[]): string | null { return values.filter((v): v is string => !!v).sort().at(-1) || null; }

/** XML is data, never executed. External entities and DTDs are refused before parsing. */
function safeXml(xml: string): void { if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('finance_source_xml_unsafe'); }
function xmlText(value: string): string {
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, c: string) => { const n = c[0].toLowerCase() === 'x' ? parseInt(c.slice(1), 16) : Number(c); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''; }).replace(/&(?:amp|lt|gt|quot|apos);/g, s => ({ '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'" })[s]!).trim().slice(0, 20000);
}
function tag(xml: string, name: string): string { return xmlText(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml)?.[1] || ''); }
export function parseFedRss(xml: string): FinanceDataResult {
  safeXml(xml); const result = base([FED_RSS, 'https://www.federalreserve.gov/feeds/feeds.htm']);
  if (!/<rss[\s>]/i.test(xml)) throw new Error('finance_source_shape');
  result.columns = ['Title', 'Publisher', 'Published', 'URL', 'Evidence type'];
  result.rows = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 40).map(match => {
    const item = match[1], raw = tag(item, 'pubDate'), time = Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
    const link = https(tag(item, 'link')); if (link && new URL(link).hostname !== 'www.federalreserve.gov') throw new Error('finance_source_shape');
    return [tag(item, 'title'), 'Federal Reserve Board', time, link, 'Official publisher announcement; not independent corroboration'];
  });
  result.asOf = newest(result.rows.map(row => typeof row[2] === 'string' ? row[2] : null));
  result.warnings = ['Macro announcements from one official publisher, not company-specific news or comprehensive news coverage. Latest 40 items; publication time is not a price observation.', 'RSS headline/link metadata only. External article text and third-party material are not licensed for redistribution by this connection.'];
  return result;
}
export async function queryFedNews(): Promise<FinanceDataResult> { return parseFedRss(await fetchFinanceText(new URL(FED_RSS))); }

export function parseBluesky(value: unknown, sourceUrl: string, actor: string | null): FinanceDataResult {
  const data = obj(value), result = base([sourceUrl, 'https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed']);
  const feed = actor ? data.feed : data.posts; if (!Array.isArray(feed)) throw new Error('finance_source_shape');
  result.columns = ['Author handle', 'Author DID', 'Post text (claim)', 'Author created at', 'Indexed at', 'Original post', 'Evidence status'];
  result.rows = feed.slice(0, 20).map(raw => {
    const post = obj(actor ? obj(raw).post : raw), author = obj(post.author), record = obj(post.record), uri = str(post.uri);
    const match = /^at:\/\/(did:[a-z]+:[A-Za-z0-9:._%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~-]+)$/.exec(uri);
    if (!match || !str(author.did) || author.did !== match[1]) throw new Error('finance_source_shape');
    return [str(author.handle), str(author.did), str(record.text), instant(record.createdAt), instant(post.indexedAt), `https://bsky.app/profile/${encodeURIComponent(match[1])}/post/${match[2]}`, 'Unverified social claim; author/time attribution only'];
  });
  result.asOf = newest(result.rows.map(row => typeof row[3] === 'string' ? row[3] : null));
  result.warnings = [actor ? `One author feed: @${actor}. Not a ticker-related search, market consensus, or sentiment sample. Reposts may appear; each original author is shown.` : 'Keyword relevance is supplied by Bluesky; ticker/company identity is not verified. Search pagination is not exhausted.', 'Posts are claims, not established facts. Author-created time, indexed time, and this retrieval time differ. Deleted/edited posts may change; no point-in-time completeness is promised.', 'Public read access is not a blanket copyright or redistribution license. Preserve attribution and original links; no media or linked article text is copied.'];
  if (actor === 'federalreserve.gov') { result.sourceUrls.push('https://www.federalreserve.gov/feeds/feeds.htm'); result.warnings.push('Default scope is the Federal Reserve official account linked by federalreserve.gov, independent of selected assets.'); }
  return result;
}
export async function queryBluesky(query: string, search: boolean): Promise<FinanceDataResult> {
  const url = new URL(`https://public.api.bsky.app/xrpc/app.bsky.feed.${search ? 'searchPosts' : 'getAuthorFeed'}`);
  let actor: string | null = null;
  if (search) { const q = query.trim(); if (!q || q.length > 300) throw new Error('finance_social_query_invalid'); url.searchParams.set('q', q); url.searchParams.set('limit', '20'); url.searchParams.set('sort', 'latest'); }
  else { const match = /(?:^|\s)@((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63})(?=\s|$)/.exec(query); actor = match?.[1].toLowerCase() || 'federalreserve.gov'; if (query.includes('@') && !match) throw new Error('finance_social_actor_invalid'); url.searchParams.set('actor', actor); url.searchParams.set('limit', '20'); url.searchParams.set('filter', 'posts_no_replies'); url.searchParams.set('includePins', 'false'); }
  return parseBluesky(await fetchFinanceJson(url), url.href, actor);
}

export function parseCompanyFacts(value: unknown, cik: string): FinanceDataResult {
  const data = obj(value); if (String(data.cik).padStart(10, '0') !== cik) throw new Error('finance_source_identity_mismatch');
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, result = base([url, 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces']);
  const facts = obj(obj(data.facts)['us-gaap']);
  const tags = ['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','NetIncomeLoss','OperatingIncomeLoss','Assets','Liabilities','CashAndCashEquivalentsAtCarryingValue','NetCashProvidedByUsedInOperatingActivities','PaymentsToAcquirePropertyPlantAndEquipment','EarningsPerShareDiluted'];
  result.columns = ['Entity', 'Taxonomy concept', 'Value', 'Unit', 'Period start', 'Period end', 'Filed date', 'Form', 'Accession', 'Fiscal period', 'Original filing'];
  const rows: Row[] = [];
  for (const name of tags) {
    if (!facts[name]) continue; const units = obj(obj(facts[name]).units);
    for (const [unit, raw] of Object.entries(units)) { if (!Array.isArray(raw)) continue;
      const sorted = raw.map(obj).filter(row => date(row.end) && date(row.filed) && num(row.val) !== null).sort((a,b) => str(b.filed).localeCompare(str(a.filed)) || str(b.end).localeCompare(str(a.end)));
      for (const row of sorted.slice(0, 16)) { const accession = str(row.accn), doc = /^\d{10}-\d{2}-\d{6}$/.test(accession) ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g,'')}/${accession}-index.html` : null;
        rows.push([str(data.entityName), name, num(row.val), unit, date(row.start), date(row.end), date(row.filed), str(row.form), accession, str(row.fp), doc]); }
    }
  }
  result.rows = rows; result.asOf = null;
  result.warnings = ['Selected standardized US-GAAP entity-wide concepts, at most 16 latest-filed observations per concept/unit. Missing concepts are omitted, never zero. Custom taxonomy and segment facts are not covered.', 'Raw reporting periods, units, forms and accessions are retained. Quarter/YTD/year and amended observations may coexist; no TTM, fiscal-period alignment, ratio, or comparable-quarter inference is made.', 'This is the current SEC companyfacts feed, not a historical point-in-time vintage. Filed dates are day precision, not availability timestamps. SEC access policy applies; filing exhibits can contain third-party copyrighted material.'];
  return result;
}

/** RFC 4180-style CSV; fixed provider input is still untrusted and bounded by the transport. */
export function parseProviderCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (quoted) { if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; closed = false; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(cell); rows.push(row); cell = ''; row = []; closed = false; }
    else { if (closed && !/\s/.test(c) || c === '"') throw new Error('finance_source_csv_invalid'); if (!closed) cell += c; }
    if (cell.length > 100000 || rows.length > 20000 || row.length > 100) throw new Error('finance_source_shape');
  }
  if (quoted) throw new Error('finance_source_csv_invalid'); if (cell || row.length) { row.push(cell); rows.push(row); } return rows;
}
const HOLDINGS_ROW_LIMIT = 5000;
function requireIsharesFund(value:IsharesFundDefinition):IsharesFundDefinition {
  const verified=findIsharesFund(value.asset.id);
  if(!verified||verified.asset.symbol!==value.asset.symbol||verified.pageUrl!==value.pageUrl||verified.holdingsUrl!==value.holdingsUrl||verified.holdingsSchema!==value.holdingsSchema)throw new Error('finance_source_identity_mismatch');
  return verified;
}
function sourceDay(raw:unknown):string|null {
  const match=/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/.exec(str(raw));if(!match)return null;
  const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]),day=Number(match[2]),year=Number(match[3]),value=new Date(Date.UTC(year,month,day));
  return value.getUTCFullYear()===year&&value.getUTCMonth()===month&&value.getUTCDate()===day?value.toISOString().slice(0,10):null;
}
export function parseIsharesHoldings(text:string,definition:IsharesFundDefinition):FinanceDataResult {
  const fund=requireIsharesFund(definition);if(!fund.holdingsUrl||!fund.holdingsSchema)throw new Error('finance_issuer_holdings_unavailable');
  const csv=parseProviderCsv(text.replace(/^\uFEFF/,'')),header=csv.findIndex(row=>row.includes('Name')&&row.includes('Weight (%)')&&row.includes('Asset Class'));
  if(header<0)throw new Error('finance_source_shape');
  if(csv[0]?.[0]!==fund.asset.name)throw new Error('finance_source_identity_mismatch');
  const result=base([fund.holdingsUrl,fund.pageUrl]),headings=csv[header];
  if(new Set(headings).size!==headings.length)throw new Error('finance_source_shape');
  const col=(name:string)=>{const index=headings.indexOf(name);if(index<0)throw new Error('finance_source_shape');return index;};
  const fields=fund.holdingsSchema==='equity'?['Ticker','Name','Sector','Asset Class','Weight (%)','Market Value','Notional Value','Quantity','Currency','Market Currency']:['CUSIP','ISIN','Name','Sector','Asset Class','Weight (%)','Market Value','Notional Value','Par Value','Price','YTM (%)','Duration','Maturity','Coupon (%)','Currency','Market Currency'];
  const indices=fields.map(col),nameIndex=col('Name'),assetClassIndex=col('Asset Class');
  const candidates=csv.slice(header+1).filter(row=>row.length===headings.length&&!!row[nameIndex]?.trim()&&!!row[assetClassIndex]?.trim());
  const malformed=csv.slice(header+1).filter(row=>row.length!==headings.length&&!!row[nameIndex]?.trim()&&!!row[assetClassIndex]?.trim()).length;
  result.asOf=sourceDay(csv.find(row=>row[0]==='Fund Holdings as of')?.[1]);
  result.columns=fund.holdingsSchema==='equity'?['Symbol','Name','Sector','Asset class','Fund weight (%)','Market value (reported currency)','Notional value (reported currency)','Quantity / units / contracts','Reporting currency','Market currency']:['CUSIP','ISIN','Name','Sector','Asset class','Fund weight (%)','Market value (reported currency)','Notional value (reported currency)','Par value (reported currency)','Holding price (issuer basis)','Holding YTM (%)','Duration (reported)','Maturity (issuer text)','Coupon (%)','Reporting currency','Market currency'];
  const numericFields=new Set(fund.holdingsSchema==='equity'?['Weight (%)','Market Value','Notional Value','Quantity']:['Weight (%)','Market Value','Notional Value','Par Value','Price','YTM (%)','Duration','Coupon (%)']);
  result.rows=candidates.slice(0,HOLDINGS_ROW_LIMIT).map(row=>indices.map((index,i)=>numericFields.has(fields[i])?num(row[index].replace(/,/g,'')):!row[index]||row[index]==='-'?null:row[index]));
  if(!result.rows.length)throw new Error('finance_source_shape');
  result.warnings=[`Issuer-published ${fund.asset.symbol} holdings snapshot only. ${result.rows.length} of ${candidates.length} structurally recognized rows are shown (maximum ${HOLDINGS_ROW_LIMIT}); selected fields, not all source columns. Fund weights are percentage points and are not renormalized. Cash/derivative rows and zero values are retained; missing values stay null.`,
    'Holdings date is day precision. Vendor holding prices may differ from NAV valuation dates/prices. Notional value and market value are different measures; this is not an executable quote feed or complete economic look-through.',
    'Public issuer download does not establish redistribution rights. Retain issuer attribution and consult the current prospectus and issuer terms before external redistribution.'];
  if(fund.holdingsSchema==='bond')result.warnings.push('Bond identifiers are reported CUSIP/ISIN, not invented stock tickers. Par value is not share quantity. Holding price, YTM (%), coupon, duration and maturity are separate issuer fields; price basis is not independently verified. YTM is not an ETF total-return forecast, NAV return, or executable yield.');
  else result.warnings.push('Quantity units vary by asset class and may represent shares, units or contracts. Holding vendor prices are not imported as security quotes.');
  if(malformed)result.warnings.push(`${malformed} holdings-shaped rows have an unexpected field count and were not parsed; coverage is incomplete.`);
  if(!result.asOf)result.warnings.push('The holdings effective day is unavailable; retrieval time is not substituted for the observation date.');
  if(candidates.length>HOLDINGS_ROW_LIMIT)result.warnings.push('Coverage is truncated at the row limit; no missing weight is estimated or redistributed.');
  return result;
}
export async function queryIsharesHoldings(definition:IsharesFundDefinition):Promise<FinanceDataResult> {
  const fund=requireIsharesFund(definition);
  if(!fund.holdingsUrl)return {...base([fund.pageUrl]),status:'unconnected',warnings:[`${fund.asset.symbol}: no supported issuer CSV holdings download was observed. NAV is supported; gold bar inventory, quantities, weights, and gold spot prices are not inferred.`, 'Public issuer access does not establish redistribution rights. See the issuer page and prospectus for this gold trust.']};
  return parseIsharesHoldings(await fetchFinanceText(new URL(fund.holdingsUrl)),fund);
}
export function parseIsharesNav(html:string,definition:IsharesFundDefinition):FinanceDataResult {
  const fund=requireIsharesFund(definition),result=base([fund.pageUrl]);const properties:Obj[]=[];let verifiedFundId:string|null=null;
  const graph:Obj[]=[];
  for(const match of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)){
    let data:Obj;try{data=obj(JSON.parse(match[1]));}catch{continue;}if(Array.isArray(data['@graph']))graph.push(...data['@graph'].map(obj));
  }
  if(!graph.length)throw new Error('finance_source_shape');
  for(const item of graph)if(item.alternateName===fund.asset.symbol&&item.name===fund.asset.name&&str(item['@id']).startsWith(`https://www.ishares.com/us/products/${new URL(fund.pageUrl).pathname.split('/')[3]}/`))verifiedFundId=str(item['@id']);
  for(const item of graph)if(str(item['@id']).endsWith('#key-datapoints')&&obj(item.about)['@id']===verifiedFundId&&Array.isArray(item.additionalProperty))properties.push(...item.additionalProperty.map(obj));
  const nav=properties.find(item=>item.name==='NAV as of');
  if(!verifiedFundId||nav&&nav.unitText!==fund.asset.currency)throw new Error('finance_source_identity_mismatch');
  if(!nav||num(nav.value)===null||num(nav.value)!<0)throw new Error('finance_source_shape');
  result.asOf=sourceDay(obj(nav.valueReference).value);if(!result.asOf)throw new Error('finance_source_shape');
  result.columns=['Fund','NAV per share','Currency','NAV date','Price basis'];result.rows=[[fund.asset.symbol,num(nav.value),fund.asset.currency,result.asOf,'Issuer NAV, not exchange market price']];
  result.warnings=[`One issuer-published ${fund.asset.symbol} NAV observation with day precision. NAV is not an executable stock/ETF quote or a closing market price; it is never automatically imported into market-price history.`, 'Public structured metadata can change and is not a promised API or complete historical series. Issuer terms and current prospectus apply; external redistribution rights are not established.'];
  if(fund.structure==='gold_trust')result.warnings.push('IAU is a gold grantor trust, not an investment company registered under the Investment Company Act of 1940. This is trust NAV per share, not gold spot price or gold bar inventory.');
  return result;
}
export async function queryIsharesNav(definition:IsharesFundDefinition):Promise<FinanceDataResult>{const fund=requireIsharesFund(definition);return parseIsharesNav(await fetchFinanceText(new URL(fund.pageUrl)),fund);}
/** Backward-compatible IVV entry points; all verified funds use the same finite catalog and parsers. */
export function parseIvvHoldings(text:string):FinanceDataResult{return parseIsharesHoldings(text,findIsharesFund('ishares:IVV')!);}
export async function queryIvvHoldings():Promise<FinanceDataResult>{return queryIsharesHoldings(findIsharesFund('ishares:IVV')!);}
export function parseIvvNav(html:string):FinanceDataResult{return parseIsharesNav(html,findIsharesFund('ishares:IVV')!);}
export async function queryIvvNav():Promise<FinanceDataResult>{return queryIsharesNav(findIsharesFund('ishares:IVV')!);}

export function parseTreasury(xml: string, url: string): FinanceDataResult {
  safeXml(xml); if (!/<feed[\s>]/i.test(xml)) throw new Error('finance_source_shape');
  const result = base([url, 'https://home.treasury.gov/treasury-daily-interest-rate-xml-feed']);
  const tenors = ['1MONTH','1_5MONTH','2MONTH','3MONTH','4MONTH','6MONTH','1YEAR','2YEAR','3YEAR','5YEAR','7YEAR','10YEAR','20YEAR','30YEAR'];
  const rows: Row[] = [];
  for (const entry of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) { const day = date(tag(entry[0], 'd:NEW_DATE').slice(0,10)); if (!day) continue;
    for (const tenor of tenors) rows.push([day, tenor.replace(/_/g,'.'), num(tag(entry[0], `d:BC_${tenor}`)), '% per annum']); }
  result.columns = ['Observation date','Maturity','Par curve yield','Unit']; result.rows = rows.sort((a,b) => String(b[0]).localeCompare(String(a[0]))).slice(0, 14*22); result.asOf = newest(result.rows.map(row => String(row[0])));
  result.warnings = ['Official Treasury daily nominal par yield curve, latest 22 observation days from the requested month. This is a curve estimate, not a specific bond price, executable quote, YTM, total return, or forecast.', 'Missing maturities remain null; yields are percentage points. No fabricated intraday timestamp or historical vintage is supplied. Treasury public-access policy applies; source attribution retained.'];
  if (!rows.length) result.warnings.push('The requested month has no observations; no previous-month values were substituted.');
  return result;
}
export async function queryTreasury(period: string): Promise<FinanceDataResult> {
  const month = /^20\d{2}(?:0[1-9]|1[0-2])$/.test(period) ? period : new Date().toISOString().slice(0,7).replace('-','');
  const url = new URL('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml'); url.searchParams.set('data','daily_treasury_yield_curve'); url.searchParams.set('field_tdr_date_value_month',month);
  return parseTreasury(await fetchFinanceText(url), url.href);
}
