import type { FinanceAsset, FinanceDataRequest, FinanceDataResult, FinanceOperation, FinanceSearchResult, FinanceWorkspace } from '../../../shared/finance';
import type { FinanceQuoteCoverage, FinanceQuoteRefreshResult } from '../quote-coverage';
import { findIsharesFund } from './ishares-catalog';
import { ReadCache, Slots, mapLimit } from './read-cache';
import { blockHost, hostBlockedSeconds } from './http';
import { latestFinanceQuote } from '../../../shared/finance';

export interface YahooMarketOptions {
  signal?: AbortSignal;
  /** How many selected assets one quote refresh reads. Thirty unless a caller that needs every position priced (portfolio valuation) asks for more; capped. */
  limit?: number;
  includeQuoteCoverage?: boolean;
  /** An explicit owner refresh: read the provider again instead of answering from the last read of the same URL. */
  fresh?: boolean;
}
const DOC='https://ranaroussi.github.io/yfinance/';
const RIGHTS='Yahoo public market data is intended for personal use. Public access and the open-source adapter do not grant exchange real-time entitlements or redistribution rights.';
const COVERAGE='Selected Yahoo listing only. Provider-reported regular-market snapshot or bounded daily chart observations; no completeness, point-in-time vintage, corporate-action lineage or total-return guarantee.';
const SYMBOL=/^[A-Za-z0-9^=._-]{1,80}$/;
const RANGES:Record<string,string>={'1M':'1mo','3M':'3mo','1Y':'1y','5Y':'5y',all:'max'};
export const YAHOO_DISCOVERY_PRESETS=['undervalued_large_caps','undervalued_growth_stocks','growth_technology_stocks'] as const;
export type YahooDiscoveryPreset=typeof YAHOO_DISCOVERY_PRESETS[number];
const LIMIT=2*1024*1024,ROW_LIMIT=5000;
const REFRESH_DEFAULT=30,REFRESH_MAX=100,YAHOO_HOST='query1.finance.yahoo.com';
/** A refresh reads at most this many assets: the caller's whole-number request within 1..100 (the most positions a reviewed holdings draft carries), otherwise `fallback`. The first rate-limit answer blocks the host for every reader, so a long list stops by itself. */
export function yahooRefreshLimit(value?:number,fallback:number=REFRESH_DEFAULT):number{return typeof value==='number'&&Number.isInteger(value)&&value>=1?Math.min(value,REFRESH_MAX):fallback;}
/** Four requests at once at most; the rest wait their turn. A short-lived copy of each answer serves the next ask for the same URL (search hit check, then price, then history), and an owner refresh always reads again. */
const slots=new Slots(4);
const CHART_SNAPSHOT_TTL=60_000,CHART_HISTORY_TTL=5*60_000,SEARCH_TTL=5*60_000,NEWS_TTL=2*60_000,CHECK_CONCURRENCY=3,REFRESH_CONCURRENCY=3;
const replies=new ReadCache<{body:string;at:string}>({ttlMs:60_000,max:96});
type Obj=Record<string,unknown>;
function object(value:unknown):Obj{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('finance_yahoo_source_shape');return value as Obj;}
function text(value:unknown,max=300):string{return typeof value==='string'?value.slice(0,max):'';}
function numeric(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e15?value:null;}
function money(value:unknown):number|null{const result=numeric(value);return result!==null&&result>=0?result:null;}
function currency(value:unknown):string|null{return typeof value==='string'&&/^[A-Z]{3}$/.test(value)&&value!=='XXX'?value:null;}
function failure(error:unknown):string{return error instanceof Error&&/^finance_yahoo_[a-z_]+$/.test(error.message)?error.message:'finance_yahoo_source_unavailable';}
function abort(signal?:AbortSignal):void{if(signal?.aborted)throw new Error('finance_yahoo_cancelled');}
function chartUrl(symbol:string,range:string):URL{if(!SYMBOL.test(symbol))throw new Error('finance_yahoo_symbol_invalid');const url=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);url.searchParams.set('range',range);url.searchParams.set('interval','1d');return url;}
/** Exact engine endpoints and bounded argument grammar; no caller-chosen host or extra key. */
export function isYahooMarketUrlAllowed(url:URL):boolean{
  if(url.origin!=='https://query1.finance.yahoo.com'||url.username||url.password||url.port||url.hash)return false;
  const keys=[...url.searchParams.keys()];if(new Set(keys).size!==keys.length)return false;
  if(url.pathname==='/v1/finance/search')return keys.length===4&&keys.every(key=>['q','quotesCount','newsCount','enableFuzzyQuery'].includes(key))&&!!url.searchParams.get('q')?.trim()&&(url.searchParams.get('q')?.length??0)<=200&&!/[\u0000-\u001f\u007f]/.test(url.searchParams.get('q')??'')&&((url.searchParams.get('quotesCount')==='5'&&url.searchParams.get('newsCount')==='0')||(url.searchParams.get('quotesCount')==='0'&&url.searchParams.get('newsCount')==='20'))&&url.searchParams.get('enableFuzzyQuery')==='false';
  if(url.pathname==='/v1/finance/screener/predefined/saved')return keys.length===6&&keys.every(key=>['scrIds','count','formatted','region','lang','corsDomain'].includes(key))&&YAHOO_DISCOVERY_PRESETS.includes(url.searchParams.get('scrIds') as YahooDiscoveryPreset)&&url.searchParams.get('count')==='25'&&url.searchParams.get('formatted')==='false'&&url.searchParams.get('region')==='US'&&url.searchParams.get('lang')==='en-US'&&url.searchParams.get('corsDomain')==='finance.yahoo.com';
  const prefix='/v8/finance/chart/';if(!url.pathname.startsWith(prefix))return false;
  try{const encoded=url.pathname.slice(prefix.length),symbol=decodeURIComponent(encoded);return SYMBOL.test(symbol)&&encodeURIComponent(symbol)===encoded&&keys.length===2&&keys.every(key=>['range','interval'].includes(key))&&['5d',...Object.values(RANGES)].includes(url.searchParams.get('range')??'')&&url.searchParams.get('interval')==='1d';}catch{return false;}
}
async function fetchText(url:URL,signal?:AbortSignal):Promise<string>{
  abort(signal);if(!isYahooMarketUrlAllowed(url))throw new Error('finance_yahoo_url_rejected');if(hostBlockedSeconds(YAHOO_HOST)>0)throw new Error('finance_yahoo_rate_limited');
  let release:()=>void;try{release=await slots.acquire(signal);}catch{throw new Error('finance_yahoo_cancelled');}
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(()=>controller.abort(),12_000);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  try{if(hostBlockedSeconds(YAHOO_HOST)>0)throw new Error('finance_yahoo_rate_limited');
    const response=await fetch(url,{redirect:'error',signal:controller.signal,headers:{Accept:'application/json','User-Agent':'Agentlas Finance/1.0 (local public market reader)'}});
    if(response.status===429){const retry=response.headers.get('retry-after'),seconds=retry&&/^\d+$/.test(retry)?Number(retry):60;blockHost(YAHOO_HOST,seconds*1000);throw new Error('finance_yahoo_rate_limited');}
    if(!response.ok)throw new Error(response.status>=500?'finance_yahoo_source_unavailable':'finance_yahoo_source_http_error');if(!response.body||Number(response.headers.get('content-length'))>LIMIT)throw new Error('finance_yahoo_output_too_large');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>LIMIT)throw new Error('finance_yahoo_output_too_large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);}
    abort(signal);return Buffer.concat(chunks).toString('utf8');
  }catch(error){abort(signal);if(controller.signal.aborted)throw new Error('finance_yahoo_timeout');throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);release();}
}
/** A server error or a dropped connection is read once more a moment later (the slot is free in between and the block is checked again); a refusal, a timeout and a 4xx are not. */
async function fetchTextAgain(url:URL,signal?:AbortSignal):Promise<string>{
  try{return await fetchText(url,signal);}
  catch(error){
    if(!(error instanceof TypeError)&&!(error instanceof Error&&error.message==='finance_yahoo_source_unavailable'))throw error;
    abort(signal);await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1500);signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    return fetchText(url,signal);
  }
}
/** One read of `url`: the last answer for the same URL while it is younger than `ttlMs`, one shared read when several callers ask at once, otherwise a request. */
async function readJson(url:URL,options:YahooMarketOptions,ttlMs:number):Promise<{json:unknown;at:string}>{
  abort(options.signal);if(!isYahooMarketUrlAllowed(url))throw new Error('finance_yahoo_url_rejected');
  let reply:{body:string;at:string};try{reply=await replies.get(url.href,async signal=>({body:await fetchTextAgain(url,signal),at:new Date().toISOString()}),{signal:options.signal,fresh:options.fresh,ttlMs});}catch(error){abort(options.signal);throw error;}
  abort(options.signal);try{return{json:JSON.parse(reply.body),at:reply.at};}catch{throw new Error('finance_yahoo_source_shape');}
}
async function fetchJson(url:URL,options:YahooMarketOptions,ttlMs:number):Promise<unknown>{return (await readJson(url,options,ttlMs)).json;}
function kind(value:unknown):FinanceAsset['kind']{switch(value){case'EQUITY':return'stock';case'ETF':return'etf';case'MUTUALFUND':return'fund';case'CRYPTOCURRENCY':return'crypto';case'FUTURE':return'commodity';case'BOND':return'bond';default:return'other';}}
function parseChart(value:unknown,symbol:string):{meta:Obj;quotes:Obj;timestamps:unknown[]}{
  const root=object(object(value).chart);if(root.error)throw new Error('finance_yahoo_source_unavailable');if(!Array.isArray(root.result)||root.result.length!==1)throw new Error('finance_yahoo_source_shape');
  const item=object(root.result[0]),meta=object(item.meta);if(meta.symbol!==symbol)throw new Error('finance_yahoo_identity_mismatch');if(meta.dataGranularity!==undefined&&meta.dataGranularity!=='1d')throw new Error('finance_yahoo_granularity_mismatch');
  const list=object(item.indicators).quote;if(!Array.isArray(list)||list.length!==1||!Array.isArray(item.timestamp))throw new Error('finance_yahoo_source_shape');if(item.timestamp.length>50000)throw new Error('finance_yahoo_output_too_large');return{meta,quotes:object(list[0]),timestamps:item.timestamp};
}
/** A holding's exchange is whatever the owner, a statement or a model wrote ("KRX", "KOSPI", "NASDAQ"); the provider names the same market "KSC"/"KSE", "NMS"/"NGM". Each row lists labels of one market and the groups they name; an umbrella label ("KRX") names every market under it. A label outside the table still has to equal or begin one of the provider's own names. */
const VENUE_LABELS:ReadonlyArray<readonly [string[],string[]]>=[
  [['NASDAQ','NAS','NMS','NGM','NCM','XNAS','XNMS','XNGS','XNCM','NASDAQGS','NASDAQGM','NASDAQCM','NASDAQGLOBALSELECT','NASDAQGLOBALSELECTMARKET','NASDAQGLOBALMARKET','NASDAQCAPITALMARKET'],['NASDAQ']],
  [['NYSE','NYQ','XNYS','NEWYORKSTOCKEXCHANGE'],['NYSE']],
  [['ARCA','NYSEARCA','PCX','ARCX'],['ARCA']],
  [['AMEX','ASE','NYSEAMERICAN','NYSEMKT','XASE','AMERICANSTOCKEXCHANGE'],['AMEX']],
  [['BATS','BTS','BZX','CBOE','CBOEUS','CBOEBZX'],['CBOE']],
  [['KOSPI','KSC','KSE'],['KOSPI']],[['KOSDAQ','KOE'],['KOSDAQ']],[['KRX','XKRX'],['KOSPI','KOSDAQ']],
  [['TYO','JPX','TOKYO','XTKS','TOKYOSTOCKEXCHANGE'],['TOKYO']],[['TOR','TSX','XTSE','TORONTO'],['TORONTO']],[['TSE'],['TOKYO','TORONTO']],
  [['HKG','HKEX','HKSE','SEHK','XHKG'],['HKEX']],
  [['LSE','LON','XLON','LONDON','LONDONSTOCKEXCHANGE'],['LSE']],
  [['GER','XETRA','XETR','ETR'],['XETRA']],
  [['PAR','EPA','XPAR','PARIS','EURONEXTPARIS'],['PARIS']],[['AMS','XAMS','AMSTERDAM','EURONEXTAMSTERDAM'],['AMSTERDAM']],
  [['SHH','SSE','XSHG','SHANGHAI'],['SHANGHAI']],[['SHZ','SZSE','XSHE','SHENZHEN'],['SHENZHEN']],
  [['TAI','TWSE','XTAI','TAIWAN'],['TAIWAN']],[['NSI','NSE','XNSE'],['NSE']],[['SES','SGX','XSES'],['SGX']],[['ASX','XASX'],['ASX']],
];
const VENUES=new Map<string,string[]>(VENUE_LABELS.flatMap(([labels,groups])=>labels.map(label=>[label,groups] as const)));
const venueKey=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'');
function sameVenue(label:string,provider:string):boolean{const wanted=venueKey(label),venue=venueKey(provider);if(!venue)return false;if(venue===wanted||venue.startsWith(wanted))return true;const groups=VENUES.get(venue);return !!groups&&(VENUES.get(wanted)??[]).some(group=>groups.includes(group));}
function validateAsset(asset:FinanceAsset,meta:Obj):void{
  if(asset.symbol!==meta.symbol)throw new Error('finance_yahoo_identity_mismatch');
  const code=currency(meta.currency);if(asset.currency!=='XXX'&&code!==asset.currency)throw new Error('finance_yahoo_currency_mismatch');
  if(asset.id.startsWith('yahoo:')){if(asset.id!==`yahoo:${encodeURIComponent(asset.symbol)}`||asset.exchange!==text(meta.exchangeName,80)||asset.kind!==kind(meta.instrumentType))throw new Error('finance_yahoo_identity_mismatch');return;}
  const issuer=findIsharesFund(asset.id);if(issuer){if(asset.symbol!==issuer.asset.symbol||asset.currency!==issuer.asset.currency||asset.kind!==issuer.asset.kind)throw new Error('finance_yahoo_identity_mismatch');return;}
  // Legacy region metadata is not a venue identifier. Do not relabel it as one.
  if(asset.id===`av:${asset.symbol}`)return;
  if(asset.exchange&&!sameVenue(asset.exchange,text(meta.exchangeName))&&!sameVenue(asset.exchange,text(meta.fullExchangeName)))throw new Error('finance_yahoo_listing_mismatch');
}
function date(stamp:unknown,timezone:unknown):string{
  if(typeof stamp!=='number'||!Number.isFinite(stamp)||!Number.isInteger(stamp)||stamp<=0||stamp>4102444800||typeof timezone!=='string'||timezone.length>100)throw new Error('finance_yahoo_observation_invalid');
  try{const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(stamp*1000)),part=(type:string)=>parts.find(p=>p.type===type)?.value;return`${part('year')}-${part('month')}-${part('day')}`;}catch{throw new Error('finance_yahoo_observation_invalid');}
}
function instant(value:unknown):string|null{return typeof value==='number'&&Number.isInteger(value)&&value>0&&value<4102444800?new Date(value*1000).toISOString():null;}
function base():FinanceDataResult{return{status:'unconnected',sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:[]};}
/** `retrievedAt` is when the provider was actually read: an answer reused within its short lifetime keeps the time of the read that made it. */
function provenance(result:FinanceDataResult,retrievedAt:string=new Date().toISOString()):FinanceDataResult{return{...result,retrievedAt,providers:[{id:'finance-yfinance',label:'Free market data · Yahoo chart',status:result.status==='unconnected'?'unavailable':result.status,coverage:COVERAGE,rights:RIGHTS,sourceUrls:[...result.sourceUrls]}]};}
export async function searchYahooFinanceAssets(query:string,options:YahooMarketOptions={}):Promise<FinanceSearchResult>{
  const normalized=query.trim();if(!normalized||normalized.length>200||/[\u0000-\u001f\u007f]/.test(normalized))throw new Error('finance_yahoo_query_invalid');abort(options.signal);
  const warnings:string[]=[RIGHTS,'At most five provider-selected search hits. Currency and exchange metadata are verified against each exact chart symbol where available; unknown currency remains XXX. Search is not an issuer or corporate-action identity guarantee.'];
  try{const url=new URL('https://query1.finance.yahoo.com/v1/finance/search');url.searchParams.set('q',normalized);url.searchParams.set('quotesCount','5');url.searchParams.set('newsCount','0');url.searchParams.set('enableFuzzyQuery','false');const data=object(await fetchJson(url,options,SEARCH_TTL));if(!Array.isArray(data.quotes))throw new Error('finance_yahoo_source_shape');
    const listed:FinanceAsset[]=[];for(const raw of data.quotes.slice(0,5)){abort(options.signal);const hit=object(raw),symbol=text(hit.symbol,80);if(!SYMBOL.test(symbol)||hit.isYahooFinance===false||listed.some(asset=>asset.symbol===symbol))continue;
      listed.push({id:`yahoo:${encodeURIComponent(symbol)}`,symbol,name:text(hit.longname)||text(hit.shortname)||symbol,exchange:text(hit.exchange,80),currency:'XXX',kind:kind(hit.quoteType)});
    }
    // Each hit's currency and exchange are checked against its own chart. The checks run side by side (their warnings keep the hits' order), and the chart each one read is what the next price ask for that symbol reuses.
    const checked=await mapLimit(listed,CHECK_CONCURRENCY,async(listing)=>{
      try{const {meta}=parseChart(await fetchJson(chartUrl(listing.symbol,'5d'),options,CHART_SNAPSHOT_TTL),listing.symbol);const exchange=text(meta.exchangeName,80);if(exchange!==listing.exchange||kind(meta.instrumentType)!==listing.kind)throw new Error('finance_yahoo_identity_mismatch');return{asset:{...listing,currency:currency(meta.currency)??'XXX'},warning:null};}
      catch(error){abort(options.signal);return{asset:listing,warning:`${listing.symbol}: ${failure(error)}`};}
    },options.signal);
    const assets=checked.map(item=>item.asset);for(const item of checked)if(item.warning)warnings.push(item.warning);
    if(!assets.length&&/[^\u0000-\u024f]/.test(normalized))warnings.push('finance_yahoo_search_latin_script_only: the provider matches Latin-script company names and tickers; search again with the English name or the ticker.');
    return{assets,provider:'Free market data · Yahoo chart',asOf:null,warnings};
  }catch(error){abort(options.signal);return{assets:[],provider:'Free market data · Yahoo chart',asOf:null,warnings:[...warnings,failure(error)]};}
}
export async function queryYahooFinanceData(input:FinanceDataRequest,assets:FinanceAsset[],options:YahooMarketOptions={}):Promise<FinanceDataResult>{
  const result=base();let readAt:string|undefined;abort(options.signal);
  try{if(input.metrics.length!==1||!['price','price_history'].includes(input.metrics[0]))return provenance({...result,warnings:['finance_yahoo_metric_unsupported']});if(input.assetIds.length!==1)throw new Error('finance_yahoo_asset_selection_invalid');const asset=assets.find(row=>row.id===input.assetIds[0]);if(!asset)throw new Error('finance_yahoo_asset_not_found');if(asset.id.startsWith('manual:v1:'))throw new Error('finance_yahoo_identity_unverified');
    const history=input.metrics[0]==='price_history',range=history?(Object.prototype.hasOwnProperty.call(RANGES,input.period)?RANGES[input.period]:undefined):'5d';if(!range)throw new Error('finance_yahoo_period_unsupported');const url=chartUrl(asset.symbol,range);result.sourceUrls=[url.href,`https://finance.yahoo.com/quote/${encodeURIComponent(asset.symbol)}`,DOC];
    const read=await readJson(url,options,history?CHART_HISTORY_TTL:CHART_SNAPSHOT_TTL);readAt=read.at;const {meta,quotes,timestamps}=parseChart(read.json,asset.symbol);validateAsset(asset,meta);const code=currency(meta.currency);
    if(!history){const price=numeric(meta.regularMarketPrice),asOf=instant(meta.regularMarketTime);result.columns=['Symbol','Price','Currency','Observed at','Price basis'];result.rows=[[asset.symbol,price,code,asOf,'Provider regular-market snapshot']];result.asOf=asOf;result.warnings=['Provider-reported regular-market snapshot and timestamp, not guaranteed real-time or executable. No total return or historical point-in-time availability is implied.'];if(price===null||asOf===null)result.warnings.push('Missing price or market timestamp remains null; no last daily close or zero was substituted.');}
    else{result.columns=['Observation date','Symbol','Currency','Open','High','Low','Close (raw)','Volume'];const seen=new Set<string>();let duplicateDays=0;const parsed=timestamps.map((stamp,index)=>{const day=date(stamp,meta.exchangeTimezoneName);if(seen.has(day))duplicateDays++;seen.add(day);const field=(name:string)=>{const values=quotes[name];return Array.isArray(values)?name==='volume'?money(values[index]):numeric(values[index]):null;};return[day,asset.symbol,code,field('open'),field('high'),field('low'),field('close'),field('volume')] as (string|number|null)[];}).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    // The provider lists the day in progress twice at times (a partial bar and the settled one); the later row of a day is kept.
    const rows=[...new Map(parsed.map(row=>[row[0] as string,row] as const)).values()];result.rows=rows.slice(-ROW_LIMIT);result.asOf=typeof result.rows.at(-1)?.[0]==='string'?result.rows.at(-1)![0] as string:null;result.warnings=[`Requested ${input.period}; copied provider daily OHLC quote fields, latest ${ROW_LIMIT} rows at most. Corporate-action adjustments may be revised by the provider; these fields are not a dividend-adjusted total-return series or immutable vintage.`];if(duplicateDays)result.warnings.push(`finance_yahoo_duplicate_dates_merged: the provider listed ${duplicateDays} trading day(s) more than once; the last row of each day is shown.`);if(rows.length>ROW_LIMIT)result.warnings.push(`Coverage truncated to latest ${ROW_LIMIT} rows; earlier requested observations remain outside this result.`);if(result.rows.some(row=>row[6]===null))result.warnings.push('Missing daily close values are preserved as null, not zero or interpolation.');if(!result.rows.length)throw new Error('finance_yahoo_observations_missing');}
    if(!code)result.warnings.push('Currency/unit metadata is unknown or unsupported; no country-based currency guess or cent-unit conversion.');result.warnings.push(RIGHTS);result.status='partial';return provenance(result,readAt);
  }catch(error){abort(options.signal);return provenance({...result,status:'error',rows:[],asOf:null,warnings:[...result.warnings,failure(error)]});}
}
/** Up to `limit` assets: all of them in watchlist order, or, when the list is longer, the ones whose saved price is oldest (none saved first), still in watchlist order. Reads the workspace only. */
function refreshSelection(workspace:FinanceWorkspace,limit:number):FinanceAsset[]{
  if(workspace.watchlist.length<=limit)return workspace.watchlist;
  const age=(asset:FinanceAsset)=>{const quote=latestFinanceQuote(workspace,asset.id);const at=quote?Date.parse(quote.asOf):NaN;return Number.isFinite(at)?at:-Infinity;};
  const chosen=new Set(workspace.watchlist.map((asset,index)=>({asset,index,at:age(asset)})).sort((a,b)=>a.at-b.at||a.index-b.index).slice(0,limit).map(item=>item.index));
  return workspace.watchlist.filter((_,index)=>chosen.has(index));
}
export async function refreshYahooFinanceQuotes(workspace:FinanceWorkspace,options:YahooMarketOptions={}):Promise<FinanceQuoteRefreshResult>{
  const limit=yahooRefreshLimit(options.limit),operations:FinanceOperation[]=[],warnings:string[]=[];
  // An owner's refresh reads every asset again (never the copy of an earlier ask), several at once; the quotes below are still built in watchlist order.
  const selected=refreshSelection(workspace,limit),reads=await mapLimit(selected,REFRESH_CONCURRENCY,asset=>queryYahooFinanceData({query:asset.symbol,assetIds:[asset.id],metrics:['price'],period:'1M'},workspace.watchlist,{...options,fresh:true}),options.signal);
  for(const [index,asset] of selected.entries()){abort(options.signal);const result=reads[index],row=result.rows[0];if(!row||typeof row[1]!=='number'||typeof row[2]!=='string'||row[2]!==asset.currency||typeof row[3]!=='string'){const why=result.warnings.find(warning=>/^finance_yahoo_[a-z_]+$/.test(warning));warnings.push(`${asset.symbol}: verified price, currency or observation timestamp unavailable${why?` (${why})`:''}.`);continue;}
    if(row[1]<0){warnings.push(`${asset.symbol}: negative provider price is preserved in query results; the nonnegative quote ledger cannot import this instrument observation.`);continue;}
    const sourceId=`yahoo-chart:${encodeURIComponent(asset.symbol)}`;operations.push({type:'source.upsert',source:{id:sourceId,name:`Yahoo chart · ${asset.symbol}`,kind:'provider',status:'connected',asOf:row[3],retrievedAt:result.retrievedAt,url:result.sourceUrls[0]??null,note:[...result.warnings,COVERAGE].join('\n')}},{type:'quotes.import',quotes:[{assetId:asset.id,price:row[1],currency:row[2],asOf:row[3],sourceId,priceBasis:'price'}]});
  }abort(options.signal);if(workspace.watchlist.length>limit)warnings.push(`Refresh is bounded to ${limit} selected assets, the ones with the oldest saved prices first.`);
  const attempted=Math.min(workspace.watchlist.length,limit),succeeded=operations.length/2;
  const quoteCoverage:FinanceQuoteCoverage={version:1,total:workspace.watchlist.length,attempted,succeeded,failed:attempted-succeeded,unattempted:workspace.watchlist.length-attempted};
  return{baseRevision:workspace.revision,status:operations.length?'ok':'unavailable',operations,message:`${operations.length/2} provider market snapshots retrieved. ${warnings.join(' ')}`.trim(),...(options.includeQuoteCoverage?{quoteCoverage}:{})};
}

function yahooArticleUrl(value:unknown):string|null{if(typeof value!=='string'||value.length>2000)return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.hostname.includes('.')&&!url.hostname.endsWith('.local')&&!/^[\d.]+$/.test(url.hostname)?url.href:null;}catch{return null;}}
function researchProvenance(result:FinanceDataResult,label:string,coverage:string):FinanceDataResult{return{...result,providers:[{id:'finance-yfinance',label,status:result.status==='unconnected'?'unavailable':result.status,coverage,rights:RIGHTS+' Headline and link metadata only; publisher rights apply. No linked article text was fetched.',sourceUrls:[...result.sourceUrls]}]};}
/** Bounded keyword search metadata, never article-body retrieval or exhaustive global coverage. */
export async function queryYahooFinanceNews(query:string,options:YahooMarketOptions={}):Promise<FinanceDataResult>{
 const normalized=query.trim();if(!normalized||normalized.length>200||/[\u0000-\u001f\u007f]/.test(normalized))throw new Error('finance_yahoo_query_invalid');abort(options.signal);
 const url=new URL('https://query1.finance.yahoo.com/v1/finance/search');url.searchParams.set('q',normalized);url.searchParams.set('quotesCount','0');url.searchParams.set('newsCount','20');url.searchParams.set('enableFuzzyQuery','false');
 const result:FinanceDataResult={...base(),sourceUrls:[url.href,DOC],columns:['Headline','Publisher','URL','Published at']};
 const coverage='At most 20 provider-selected keyword news headlines. Query relevance, international publisher/language coverage and period completeness are not guaranteed. Linked article bodies were not fetched.';
 try{const value=object(await fetchJson(url,options,NEWS_TTL));if(!Array.isArray(value.news)||value.news.length>1000)throw new Error('finance_yahoo_source_shape');const seen=new Set<string>();
 for(const raw of value.news.slice(0,20)){abort(options.signal);const item=object(raw),headline=text(item.title,500),link=yahooArticleUrl(item.link);if(!headline||!link||seen.has(link))continue;seen.add(link);result.rows.push([headline,text(item.publisher,200)||null,link,instant(item.providerPublishTime)]);}
 result.asOf=result.rows.map(row=>row[3]).filter((value):value is string=>typeof value==='string').sort().at(-1)??null;result.status='partial';result.warnings=[coverage,RIGHTS];if(!result.rows.length)result.warnings.push('finance_yahoo_news_missing');return researchProvenance(result,'Yahoo Finance keyword news',coverage);
 }catch(error){abort(options.signal);return researchProvenance({...result,status:'error',rows:[],asOf:null,warnings:[failure(error)]},'Yahoo Finance keyword news',coverage);}
}
/** Literal provider-selected screener rows. Criteria are provider-defined, not a suitability recommendation. */
export async function screenYahooFinanceAssets(preset:YahooDiscoveryPreset,options:YahooMarketOptions={}):Promise<{assets:FinanceAsset[];data:FinanceDataResult;coverage:{returned:number;total:number|null}}>{
 if(!YAHOO_DISCOVERY_PRESETS.includes(preset))throw new Error('finance_yahoo_discovery_preset_invalid');abort(options.signal);
 const url=new URL('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved');url.searchParams.set('scrIds',preset);url.searchParams.set('count','25');url.searchParams.set('formatted','false');url.searchParams.set('region','US');url.searchParams.set('lang','en-US');url.searchParams.set('corsDomain','finance.yahoo.com');
 const result:FinanceDataResult={...base(),sourceUrls:[url.href,'https://ranaroussi.github.io/yfinance/reference/api/yfinance.screen.html'],columns:['Symbol','Name','Exchange','Currency','Price','Market cap','Trailing P/E','PEG ratio','Observed at']};
 const coverage='First 25 provider-predefined U.S.-listing equity candidates at most, with provider-selected ordering and criteria. Not a complete market universe, verified issuer identity, independent valuation or investment-suitability assessment.';
 try{const envelope=object(object(await fetchJson(url,options,SEARCH_TTL)).finance);if(envelope.error||!Array.isArray(envelope.result)||envelope.result.length!==1)throw new Error('finance_yahoo_source_shape');const screen=object(envelope.result[0]);if(!Array.isArray(screen.quotes)||screen.quotes.length>1000)throw new Error('finance_yahoo_source_shape');
 const assets:FinanceAsset[]=[];for(const raw of screen.quotes.slice(0,25)){abort(options.signal);const hit=object(raw),symbol=text(hit.symbol,80);if(!SYMBOL.test(symbol)||assets.some(asset=>asset.symbol===symbol))continue;const ccy=currency(hit.currency),name=text(hit.longName)||text(hit.shortName)||symbol,exchange=text(hit.exchange,80);assets.push({id:`yahoo:${encodeURIComponent(symbol)}`,symbol,name,exchange,currency:ccy??'XXX',kind:kind(hit.quoteType)});result.rows.push([symbol,name,exchange||null,ccy,numeric(hit.regularMarketPrice),money(hit.marketCap),numeric(hit.trailingPE),numeric(hit.pegRatio),instant(hit.regularMarketTime)]);}
 const total=typeof screen.total==='number'&&Number.isSafeInteger(screen.total)&&screen.total>=assets.length?screen.total:null;result.status='partial';result.warnings=[coverage,RIGHTS,'Missing currency and observation time remain null; no country-based currency or quote timestamp is inferred. Search/add a returned listing explicitly before subsequent analysis.'];result.asOf=null;if(!assets.length)result.warnings.push('finance_yahoo_discovery_empty');return{assets,data:researchProvenance(result,'Yahoo predefined equity screener',coverage),coverage:{returned:assets.length,total}};
 }catch(error){abort(options.signal);return{assets:[],data:researchProvenance({...result,status:'error',rows:[],warnings:[failure(error)]},'Yahoo predefined equity screener',coverage),coverage:{returned:0,total:null}};}
}
