import { createHash } from 'node:crypto';
import type { FinanceAsset, FinanceDataResult } from '../../shared/finance';
import { FINANCE_FEED_IDS, type FinanceFeedId, type FinanceDashboardFeedItem, type FinanceDashboardFeedSection, type FinanceDashboardFeedsResult } from '../../shared/finance-feeds';
import type { FinanceScope } from './store';
import { queryFinanceAdapter } from './source-adapters';

const TTL = 5 * 60 * 1000, MAX_OWNERS = 8, MAX_ASSETS = 5;
const SEC_DIRECTORY = 'https://www.sec.gov/files/company_tickers_exchange.json';
const FED_NEWS = 'https://www.federalreserve.gov/feeds/press_all.xml';
const BLS_CALENDAR = 'https://www.bls.gov/schedule/news_release/bls.ics';
const BEA_CALENDAR = 'https://apps.bea.gov/API/signup/release_dates.json';
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const cache = new Map<string,{key:string;result:FinanceDashboardFeedsResult}>();
const pending = new Map<string,AbortController>();
const cooldown = new Map<string,number>();
let active = 0, nextSecRequestAt = 0;
const waiters:Array<()=>void> = [];
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const owner = (scope:Pick<FinanceScope,'workspaceId'|'userId'>) => hash(JSON.stringify([scope.workspaceId,scope.userId]));
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;
const errorCode = (e:unknown) => e instanceof Error && /^finance_[a-z0-9_]+$/.test(e.message) ? e.message : 'finance_feed_source_unavailable';
function check(signal:AbortSignal):void { if(signal.aborted)throw new Error('finance_feed_cancelled'); }
function safeLink(value:string):string|null { try { const u = new URL(value);return value.length<=2000&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u.href:null; } catch { return null; } }
function text(value:string,limit=1000):string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,v:string)=>{
    const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(named[v.toLowerCase()])return named[v.toLowerCase()];
    const n=v.toLowerCase().startsWith('#x')?parseInt(v.slice(2),16):parseInt(v.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';
  }).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
}
function day(value:unknown):string|null { if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value))return null;const n=Date.parse(value+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value?value:null; }
function instant(value:unknown):string|null { return typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null; }
function object(value:unknown):Record<string,unknown> { if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('finance_feed_source_shape');return value as Record<string,unknown>; }
/** An output link is never fetched. All outbound requests pass this fixed origin/path/query allowlist. */
export function isFinanceFeedUrlAllowed(u:URL):boolean {
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return false;
  if(u.hostname==='feeds.finance.yahoo.com')return u.pathname==='/rss/2.0/headline'&&[...u.searchParams].length===3&&u.searchParams.get('region')==='US'&&u.searchParams.get('lang')==='en-US'&&/^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,79}$/.test(u.searchParams.get('s')||'');
  if(u.hostname==='finance.yahoo.com')return u.pathname==='/calendar/earnings'&&[...u.searchParams].length===3&&u.searchParams.get('offset')==='0'&&u.searchParams.get('size')==='25'&&/^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,79}$/.test(u.searchParams.get('symbol')||'');
  if(u.search)return false;
  return u.href===FED_NEWS||u.href===SEC_DIRECTORY||u.href===BLS_CALENDAR||u.href===BEA_CALENDAR||u.hostname==='data.sec.gov'&&/^\/submissions\/CIK\d{10}\.json$/.test(u.pathname)||u.hostname==='www.federalreserve.gov'&&/^\/newsevents\/20\d{2}-(january|february|march|april|may|june|july|august|september|october|november|december)\.htm$/.test(u.pathname);
}
async function acquire(signal:AbortSignal):Promise<()=>void> {
  while(active>=3){check(signal);await new Promise<void>(resolve=>{const wake=()=>{signal.removeEventListener('abort',wake);const i=waiters.indexOf(wake);if(i>=0)waiters.splice(i,1);resolve();};waiters.push(wake);signal.addEventListener('abort',wake,{once:true});});}
  check(signal);active++;return()=>{active--;waiters.shift()?.();};
}
async function fetchText(url:string,signal:AbortSignal):Promise<string> {
  const u=new URL(url);if(!isFinanceFeedUrlAllowed(u))throw new Error('finance_feed_url_rejected');
  check(signal);if((cooldown.get(u.hostname)||0)>Date.now())throw new Error('finance_feed_rate_limited');
  const release=await acquire(signal),controller=new AbortController(),cancel=()=>controller.abort();
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)controller.abort();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try {
    if(u.hostname==='www.sec.gov'||u.hostname==='data.sec.gov'){const wait=Math.max(0,nextSecRequestAt-Date.now());nextSecRequestAt=Math.max(Date.now(),nextSecRequestAt)+150;if(wait)await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,wait);controller.signal.addEventListener('abort',done,{once:true});if(controller.signal.aborted)done();});check(controller.signal);}
    const response=await fetch(u,{redirect:'error',signal:controller.signal,headers:{Accept:u.hostname==='finance.yahoo.com'?'text/html':'application/json, application/rss+xml, text/calendar, text/html;q=0.8','User-Agent':'Agentlas Finance (https://agentlas.cloud)'}});
    if(response.status===429){const seconds=Number(response.headers.get('retry-after'));cooldown.set(u.hostname,Date.now()+Math.max(1000,Math.min(300000,Number.isFinite(seconds)?seconds*1000:60000)));throw new Error('finance_feed_rate_limited');}
    if(!response.ok)throw new Error('finance_feed_http_'+response.status);
    const cap=u.href===SEC_DIRECTORY||u.hostname==='data.sec.gov'?6*1024*1024:u.hostname==='finance.yahoo.com'?2*1024*1024:1024*1024;
    if(Number(response.headers.get('content-length'))>cap)throw new Error('finance_feed_too_large');
    if(!response.body)throw new Error('finance_feed_empty');const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    try { for(;;){check(signal);const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>cap)throw new Error('finance_feed_too_large');chunks.push(value);} } finally {await reader.cancel().catch(()=>{});}
    return Buffer.concat(chunks).toString('utf8');
  } catch(e) { if(signal.aborted)throw new Error('finance_feed_cancelled');if(controller.signal.aborted)throw new Error('finance_feed_timeout');throw e; }
  finally {clearTimeout(timeout);signal.removeEventListener('abort',cancel);release();}
}
function section(id:FinanceFeedId):FinanceDashboardFeedSection {return{id,status:'unavailable',items:[],sourceUrls:[],warnings:[]};}
function item(sourceId:FinanceFeedId,kind:FinanceDashboardFeedItem['kind'],title:string,url:string,extra:Partial<FinanceDashboardFeedItem>={}):FinanceDashboardFeedItem {return{id:hash(JSON.stringify([sourceId,title,url,extra.startsAt,extra.assetSymbol])),kind,title,url,publishedAt:null,startsAt:null,assetSymbol:null,sourceId,...extra};}
async function news(assets:FinanceAsset[],signal:AbortSignal):Promise<FinanceDashboardFeedSection> {
  const out=section('finance-news');out.warnings=['Watchlist ticker-matched RSS headlines only; relevance is provider-defined. Article text is not reproduced; publisher rights apply.'];
  const selected=assets.filter(a=>/^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,79}$/.test(a.symbol)).slice(0,MAX_ASSETS);
  if(!selected.length&&assets.length){out.errorCode='finance_feed_watchlist_required';return out;}
  const sources=selected.length?selected.map(asset=>{const u=new URL('https://feeds.finance.yahoo.com/rss/2.0/headline');u.searchParams.set('s',asset.symbol);u.searchParams.set('region','US');u.searchParams.set('lang','en-US');return{symbol:asset.symbol,url:u.href};}):[{symbol:null,url:FED_NEWS}];
  if(!assets.length)out.warnings=['No watchlist selected: official Federal Reserve macro announcements only, not company-specific news. Headline/link metadata only; no full articles.'];
  let failures=0;
  await Promise.all(sources.map(async source=>{
    const u=new URL(source.url);out.sourceUrls.push(u.href);
    try {const xml=await fetchText(u.href,signal);if(/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<rss\b/i.test(xml))throw new Error('finance_feed_source_shape');
      for(const block of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
        const field=(name:string)=>block[1].match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1]||'';
        const title=text(field('title')),url=safeLink(text(field('link'),2001));if(!title||!url)continue;
        const rawDate=text(field('pubDate')),parsed=Date.parse(rawDate),publishedAt=Number.isFinite(parsed)?new Date(parsed).toISOString():null;
        out.items.push(item(out.id,'article',title,url,{assetSymbol:source.symbol,publishedAt,...(publishedAt?{datePrecision:'instant' as const}:{}),publisher:source.symbol===null?'Federal Reserve (macro announcements)':text(field('source'))||new URL(url).hostname}));
      }
    }catch(e){check(signal);failures++;out.warnings.push((source.symbol||'Federal Reserve')+': '+errorCode(e));}
  }));
  out.items=Array.from(new Map(out.items.map(i=>[i.url+'\0'+i.assetSymbol,i])).values()).sort((a,b)=>(b.publishedAt||'').localeCompare(a.publishedAt||'')).slice(0,40);
  out.status=out.items.length?'partial':failures?'error':'unavailable';if(!out.items.length)out.errorCode=failures?'finance_feed_source_unavailable':'finance_feed_no_headlines';
  if(assets.length>MAX_ASSETS)out.warnings.push('Coverage limited to the first five supported watchlist symbols.');return out;
}
/** Selected-symbol headline metadata using exactly the dashboard's bounded RSS path; never macro substitution. */
export async function queryFinanceNews(asset:FinanceAsset,signal?:AbortSignal):Promise<FinanceDataResult> {
 const result:FinanceDataResult={status:'unconnected',columns:[],rows:[],sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),warnings:[]};
 if(!asset||!/^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,79}$/.test(asset.symbol))throw new Error('finance_feed_symbol_invalid');
 const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
 try{check(controller.signal);const feed=await news([asset],controller.signal);check(controller.signal);
  result.status=feed.status==='error'?'error':feed.items.length?'partial':'unconnected';result.columns=['Title','Publisher','Published','URL','Symbol','Evidence type'];
  result.rows=feed.items.map(row=>[row.title,row.publisher??null,row.publishedAt,row.url,row.assetSymbol,'Publisher headline metadata; relevance is provider-defined']);result.sourceUrls=feed.sourceUrls;
  result.retrievedAt=new Date().toISOString();result.asOf=feed.items.flatMap(row=>row.publishedAt?[row.publishedAt]:[]).sort().at(-1)??null;result.warnings=[...feed.warnings,'One selected symbol, latest 40 headline records at most; requested period is not guaranteed historical coverage. No article body is copied.',...(feed.errorCode?[feed.errorCode]:[])];return result;
 }finally{signal?.removeEventListener('abort',cancel);}
}
async function filings(assets:FinanceAsset[],signal:AbortSignal):Promise<FinanceDashboardFeedSection> {
  const out=section('finance-sec');out.warnings=['SEC recent-submissions metadata only; first five watchlist assets, up to eight recent filings each. Historical submission files are not traversed. Exact ticker-to-CIK mapping identifies an issuer, not guaranteed security lineage. Fair-access rules apply; no blanket redistribution right to filing exhibits is implied.'];
  if(!assets.length){out.errorCode='finance_feed_watchlist_required';return out;}out.sourceUrls.push(SEC_DIRECTORY);
  let directory:Record<string,unknown>;try {directory=object(JSON.parse(await fetchText(SEC_DIRECTORY,signal)));}catch(e){check(signal);out.status='error';out.errorCode=errorCode(e);return out;}
  if(!Array.isArray(directory.fields)||!Array.isArray(directory.data))throw new Error('finance_feed_source_shape');
  const fields=directory.fields,ci=fields.indexOf('cik'),ti=fields.indexOf('ticker');if(ci<0||ti<0)throw new Error('finance_feed_source_shape');
  let failures=0;
  // Sequential SEC requests stay comfortably below the published ten requests/second limit.
  for(const asset of assets.slice(0,MAX_ASSETS)){
    check(signal);const direct=asset.id.match(/^sec:(\d{10}):(.+)$/),canonical=asset.id===`yahoo:${encodeURIComponent(asset.symbol)}`||asset.id===`av:${asset.symbol}`&&asset.exchange==='United States'||asset.id===`ishares:${asset.symbol}`||direct?.[2]===asset.symbol;
    const matches=canonical?directory.data.filter(row=>Array.isArray(row)&&row[ti]===asset.symbol&&/^\d{1,10}$/.test(String(row[ci]))):[];
    if(matches.length!==1){failures++;out.warnings.push(asset.symbol+': finance_feed_issuer_unresolved');continue;}
    const cik=String(matches[0][ci]).padStart(10,'0');if(direct&&direct[1]!==cik){failures++;out.warnings.push(asset.symbol+': finance_feed_identity_mismatch');continue;}
    const url=`https://data.sec.gov/submissions/CIK${cik}.json`;out.sourceUrls.push(url);
    try {const data=object(JSON.parse(await fetchText(url,signal)));if(String(data.cik).padStart(10,'0')!==cik)throw new Error('finance_feed_identity_mismatch');
      const recent=object(object(data.filings).recent),forms=recent.form,accessions=recent.accessionNumber,documents=recent.primaryDocument,dates=recent.filingDate,accepted=recent.acceptanceDateTime;
      if(!Array.isArray(forms)||!Array.isArray(accessions)||!Array.isArray(documents)||!Array.isArray(dates))throw new Error('finance_feed_source_shape');
      for(let i=0;i<Math.min(forms.length,8);i++){
        const accession=accessions[i],doc=documents[i];if(typeof accession!=='string'||!/^\d{10}-\d{2}-\d{6}$/.test(accession)||typeof doc!=='string'||doc.length>1000||doc.split('/').some(s=>!s||s==='.'||s==='..'||!/^[A-Za-z0-9_.-]+$/.test(s)))continue;
        const publishedAt=Array.isArray(accepted)?instant(accepted[i])||day(dates[i]):day(dates[i]);if(!publishedAt||typeof forms[i]!=='string'||!forms[i])continue;
        out.items.push(item(out.id,'filing',asset.symbol+' · '+text(forms[i]),`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g,'')}/${doc}`,{assetSymbol:asset.symbol,publishedAt,datePrecision:publishedAt.length===10?'day':'instant',publisher:'SEC EDGAR · CIK '+cik}));
      }
    }catch(e){check(signal);failures++;out.warnings.push(asset.symbol+': '+errorCode(e));}
  }
  out.items.sort((a,b)=>(b.publishedAt||'').localeCompare(a.publishedAt||''));out.status=out.items.length?'partial':failures?'error':'unavailable';if(!out.items.length)out.errorCode='finance_feed_filings_unavailable';return out;
}
/** Resolve only the timezone explicitly declared in the official ICS, including DST. */
function eastern(value:string):string|null {
  if(!/^\d{8}T\d{6}$/.test(value))return null;const iso=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`,base=Date.parse(iso);if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,19)!==iso.slice(0,19))return null;
  let utc=base;const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<3;i++){const parts=Object.fromEntries(formatter.formatToParts(new Date(utc)).map(p=>[p.type,p.value]));const represented=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);utc+=base-represented;}
  return new Date(utc).toISOString();
}
function calendarDate(line:string):string|null {
  const value=line.slice(line.indexOf(':')+1);
  if(/^DTSTART(?:;VALUE=DATE)?:\d{8}$/.test(line))return day(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`);
  if(/^DTSTART(?:;VALUE=DATE-TIME)?:\d{8}T\d{6}Z$/.test(line))return instant(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`);
  if(/^DTSTART;TZID=(?:US-Eastern|America\/New_York):/.test(line))return eastern(value);return null;
}
function future(date:string,now:number):boolean {const stamp=Date.parse(date.length===10?date+'T23:59:59Z':date);return stamp>=now&&stamp<=now+90*86400000;}
async function economy(signal:AbortSignal):Promise<FinanceDashboardFeedSection> {
  const out=section('finance-economy'),now=Date.now(),date=new Date(now);let failures=0;
  const fedUrls=[0,1].map(offset=>{const d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+offset,1));return`https://www.federalreserve.gov/newsevents/${d.getUTCFullYear()}-${MONTHS[d.getUTCMonth()]}.htm`;});
  out.sourceUrls=[BLS_CALENDAR,BEA_CALENDAR,...fedUrls];out.warnings=['Official US BLS/BEA schedules for the next 90 days and Federal Reserve current/next month, up to 80 events; schedules may change. Fed release dates retain day precision and are not inferred meeting start times. Publication dates are unavailable and remain null.'];
  await Promise.all(out.sourceUrls.map(async url=>{try{const body=await fetchText(url,signal);
    if(url===BLS_CALENDAR){if(!body.startsWith('BEGIN:VCALENDAR'))throw new Error('finance_feed_source_shape');const unfolded=body.replace(/\r?\n[ \t]/g,'');
      for(const match of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)){const lines=match[1].split(/\r?\n/),summary=lines.find(l=>l.startsWith('SUMMARY:')),start=lines.find(l=>l.startsWith('DTSTART'));if(!summary||!start)continue;const startsAt=calendarDate(start),title=text(summary.slice(8).replace(/\\[nN]/g,' ').replace(/\\([,;\\])/g,'$1'));if(startsAt&&title&&future(startsAt,now))out.items.push(item(out.id,'event',title,url,{startsAt,datePrecision:startsAt.length===10?'day':'instant',publisher:'BLS'}));}
    }else if(url===BEA_CALENDAR){const data=object(JSON.parse(body));for(const [name,value]of Object.entries(data).slice(0,100)){if(name==='file_last_updated')continue;const release=object(value).release_dates;if(!Array.isArray(release))throw new Error('finance_feed_source_shape');for(const raw of release.slice(0,1000)){const startsAt=instant(raw);if(startsAt&&future(startsAt,now))out.items.push(item(out.id,'event',text(name),url,{startsAt,datePrecision:'instant',publisher:'BEA'}));}}
    }else{if(!body.includes('calendar'))throw new Error('finance_feed_source_shape');const match=url.match(/(20\d\d)-([a-z]+)\.htm$/)!,month=MONTHS.indexOf(match[2])+1;
      for(const block of body.split(/<div\b[^>]*class=["'][^"']*\bpanel\b[^"']*["'][^>]*>/i).slice(1)){
        const content=block.match(/<div\b[^>]*class=["']col-xs-7["'][^>]*>([\s\S]*?)<div\b[^>]*class=["']col-xs-3["']/i)?.[1],days=block.match(/<div\b[^>]*class=["']col-xs-3["'][^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i)?.[1];if(!content||!days||/approximate/i.test(content))continue;
        const title=text(content.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]||'');if(!title)continue;
        for(const rawDay of text(days).split(/,\s*/)){if(!/^\d{1,2}$/.test(rawDay))continue;const startsAt=day(`${match[1]}-${String(month).padStart(2,'0')}-${rawDay.padStart(2,'0')}`);if(startsAt&&future(startsAt,now))out.items.push(item(out.id,'event',title,url,{startsAt,datePrecision:'day',publisher:'Federal Reserve'}));}
      }
    }
  }catch(e){check(signal);failures++;out.warnings.push(new URL(url).hostname+': '+errorCode(e));}}));
  const events=Array.from(new Map(out.items.map(i=>[i.id,i])).values()).sort((a,b)=>(a.startsAt||'').localeCompare(b.startsAt||''));out.items=events.slice(0,80);out.status=out.items.length?failures||events.length>80?'partial':'ok':failures?'error':'unavailable';if(!out.items.length)out.errorCode='finance_feed_schedule_unavailable';return out;
}
/** Yahoo's public earnings table is also the upstream used by yfinance.get_earnings_dates.
 * Its dates are provider estimates: retain the written calendar day, never infer a market session. */
function earningsDay(value:string):string|null {
  const match=/^([A-Za-z]+) (\d{1,2}), (\d{4})(?: at \d{1,2}(?::\d\d)? (?:AM|PM) [A-Z]{2,5})?$/.exec(value);
  if(!match)return null;const month=MONTHS.indexOf(match[1].toLowerCase())+1;
  return month?day(`${match[3]}-${String(month).padStart(2,'0')}-${match[2].padStart(2,'0')}`):null;
}
function earningsRows(html:string,symbol:string,now:number):string[] {
  const table=html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];if(!table)throw new Error('finance_earnings_source_shape');
  const rows=Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi));
  if(!rows.length||rows.length>101)throw new Error('finance_earnings_source_shape');
  const cells=(row:string,tag:string)=>Array.from(row.matchAll(new RegExp('<'+tag+'\\b[^>]*>([\\s\\S]*?)<\\/'+tag+'>','gi')),m=>text(m[1]));
  const headers=cells(rows[0][1],'th');
  if(JSON.stringify(headers)!==JSON.stringify(['Symbol','Company','Earnings Date','EPS Estimate','Reported EPS','Surprise (%)']))throw new Error('finance_earnings_source_shape');
  const dates:string[]=[];
  for(const row of rows.slice(1)){const values=cells(row[1],'td');if(values.length!==headers.length)throw new Error('finance_earnings_source_shape');if(values[0]!==symbol)throw new Error('finance_earnings_identity_mismatch');const date=earningsDay(values[2]);if(date&&future(date,now))dates.push(date);}
  return [...new Set(dates)].sort().slice(0,4);
}
async function earnings(assets:FinanceAsset[],sourceId:string,scope:FinanceScope,signal:AbortSignal):Promise<FinanceDashboardFeedSection> {
  const out=section('finance-earnings'),now=Date.now();
  out.warnings=['Provider-estimated earnings dates, not issuer-confirmed events. Day precision only; market session is unknown. Next 90 days, first five supported watchlist symbols, at most four dates each. No EPS estimates or article text are copied; provider rights apply.'];
  const selected=assets.slice(0,MAX_ASSETS).filter(asset=>['stock','other'].includes(asset.kind)&&/^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,79}$/.test(asset.symbol));
  for(const asset of assets.slice(0,MAX_ASSETS))if(!selected.includes(asset))out.warnings.push(asset.symbol+': finance_earnings_symbol_unsupported');
  if(!selected.length){out.errorCode=assets.length?'finance_earnings_symbol_unsupported':'finance_feed_watchlist_required';return out;}
  const add=(asset:FinanceAsset,date:string,url:string,publisher:string)=>out.items.push(item(out.id,'event',asset.symbol+' · '+asset.name,url,{assetSymbol:asset.symbol,startsAt:date,datePrecision:'day',session:'unknown',scheduleStatus:'estimated',publisher}));
  if(sourceId!=='finance-yfinance'){
    // Opt-in toolchains declare this metric in their input schema. There is no built-in fallback.
    // Normalized output contract: exact columns Symbol / Earnings date / URL; YYYY-MM-DD dates.
    try{scope.assertCurrent();check(signal);const result=await queryFinanceAdapter(sourceId,{query:selected.map(asset=>asset.symbol).join(', '),assetIds:selected.map(asset=>asset.id),metrics:['earnings'],period:'3M'},selected,signal,()=>scope.assertCurrent());scope.assertCurrent();check(signal);
      out.sourceUrls=result.sourceUrls;out.warnings.push(...result.warnings.slice(0,20));
      if(!['ok','partial'].includes(result.status)){out.status=result.status==='error'?'error':'unavailable';out.errorCode='finance_earnings_adapter_unavailable';return out;}
      if(JSON.stringify(result.columns)!==JSON.stringify(['Symbol','Earnings date','URL']))throw new Error('finance_earnings_adapter_contract_unsupported');
      const seen=new Set<string>(),counts=new Map<string,number>();
      for(const row of result.rows){const asset=selected.find(asset=>asset.symbol===row[0]),date=day(row[1]),url=typeof row[2]==='string'?safeLink(row[2]):null;
        if(!asset||!date||!url)throw new Error('finance_earnings_adapter_shape');const key=asset.symbol+'\0'+date;if(!future(date,now)||seen.has(key)||(counts.get(asset.symbol)||0)>=4)continue;seen.add(key);counts.set(asset.symbol,(counts.get(asset.symbol)||0)+1);add(asset,date,url,'Selected data tool');}
    }catch(e){check(signal);scope.assertCurrent();out.items=[];out.status='error';out.errorCode=errorCode(e);return out;}
  }else{
    let failures=0;
    await Promise.all(selected.map(async asset=>{const url=new URL('https://finance.yahoo.com/calendar/earnings');url.searchParams.set('symbol',asset.symbol);url.searchParams.set('offset','0');url.searchParams.set('size','25');out.sourceUrls.push(url.href);
      try{const html=await fetchText(url.href,signal);scope.assertCurrent();for(const date of earningsRows(html,asset.symbol,now))add(asset,date,url.href,'Yahoo Finance · estimated');}
      catch(e){check(signal);scope.assertCurrent();failures++;out.warnings.push(asset.symbol+': '+errorCode(e));}
    }));
    if(failures&&!out.items.length){out.status='error';out.errorCode='finance_earnings_source_unavailable';return out;}
  }
  out.items=Array.from(new Map(out.items.map(row=>[row.id,row])).values()).sort((a,b)=>(a.startsAt||'').localeCompare(b.startsAt||'')).slice(0,20);
  out.status=out.items.length?'partial':'unavailable';if(!out.items.length)out.errorCode='finance_earnings_no_upcoming_dates';return out;
}
/** Clear is unconditional: a previous account authority may clear its cache after logout. */
export function clearFinanceDashboardFeedCache(scope?:Pick<FinanceScope,'workspaceId'|'userId'>):void {if(scope){const id=owner(scope);cache.delete(id);pending.get(id)?.abort();pending.delete(id);}else{cache.clear();for(const controller of pending.values())controller.abort();pending.clear();}}
/** Host consent and feed enable settings are enforced by the caller before entering this network-only adapter. */
export async function getFinanceDashboardFeeds(input:{scope:FinanceScope;watchlist:readonly FinanceAsset[];enabledFeedIds?:readonly FinanceFeedId[];sourceId?:string;signal?:AbortSignal}):Promise<FinanceDashboardFeedsResult> {
  const {scope}=input;scope.assertCurrent();if(!scope.workspaceId||!scope.userId)throw new Error('finance_sign_in_required');if(input.signal?.aborted)throw new Error('finance_feed_cancelled');
  if(!Array.isArray(input.watchlist)||input.watchlist.length>10000||input.watchlist.some(a=>!a||typeof a.id!=='string'||a.id.length>200||typeof a.symbol!=='string'||a.symbol.length>80))throw new Error('finance_feed_watchlist_invalid');
  const enabled=input.enabledFeedIds===undefined?[...FINANCE_FEED_IDS]:[...input.enabledFeedIds];if(enabled.length>4||new Set(enabled).size!==enabled.length||enabled.some(id=>!FINANCE_FEED_IDS.includes(id)))throw new Error('finance_feed_selection_invalid');
  const sourceId=input.sourceId??'finance-yfinance';if(sourceId!=='finance-yfinance'&&!/^toolchain:[A-Za-z0-9_-]{1,100}:[1-9]\d*:[a-f0-9]{64}$/.test(sourceId))throw new Error('finance_feed_source_invalid');
  const assets=input.watchlist.map(asset=>({...asset}));
  const id=owner(scope),key=JSON.stringify([sourceId,assets.map(a=>[a.id,a.symbol,a.name,a.exchange,a.currency,a.kind]),[...enabled].sort()]),saved=cache.get(id);
  if(saved&&saved.key===key&&Date.parse(saved.result.expiresAt)>Date.now()){scope.assertCurrent();return clone(saved.result);}
  if(pending.has(id)||pending.size>=MAX_OWNERS)throw new Error('finance_feed_busy');
  const controller=new AbortController(),cancel=()=>controller.abort();pending.set(id,controller);input.signal?.addEventListener('abort',cancel,{once:true});if(input.signal?.aborted)controller.abort();
  const fetchedAt=new Date().toISOString();let expired=false;const deadline=setTimeout(()=>{expired=true;controller.abort();},45000);
  try {const sections=await Promise.all(FINANCE_FEED_IDS.map(async feedId=>{
    if(!enabled.includes(feedId))return{...section(feedId),status:'disabled' as const};
    try{return await(feedId==='finance-news'?news(assets,controller.signal):feedId==='finance-sec'?filings(assets,controller.signal):feedId==='finance-earnings'?earnings(assets,sourceId,scope,controller.signal):economy(controller.signal));}
    catch(e){check(controller.signal);return{...section(feedId),status:'error' as const,errorCode:errorCode(e)};}
  }));if(expired)throw new Error('finance_feed_timeout');check(controller.signal);scope.assertCurrent();const result={fetchedAt,expiresAt:new Date(Date.now()+TTL).toISOString(),sections};cache.delete(id);cache.set(id,{key,result:clone(result)});while(cache.size>MAX_OWNERS)cache.delete(cache.keys().next().value!);return result;
  }catch(e){if(expired)throw new Error('finance_feed_timeout');throw e;}finally{clearTimeout(deadline);input.signal?.removeEventListener('abort',cancel);if(pending.get(id)===controller)pending.delete(id);}
}
