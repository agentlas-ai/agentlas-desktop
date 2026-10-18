import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { FinanceDataSourceOption, FinanceWorldMarket, FinanceWorldMarketsResult } from '../../shared/finance-experience';
import type { FinanceScope } from './store';
import { resolveHephaestusPython } from '../hephaestus/engine';
import { optionalElectronAppPath, runtimeResourcesPath } from '../runtime-paths';
import { withPythonRuntimeBoundary } from '../runtime/python-cache';
import { withCliPath, killCliTree } from '../runtime/exec';
import { parseTreasury } from './providers/public-data';

export const FINANCE_WORLD_SOURCE_ID = 'finance-yfinance';
const TTL = 5 * 60_000, LIMIT = 2 * 1024 * 1024;
type Engine = 'yfinance' | 'yahoo-chart';
type WorldResult = FinanceWorldMarketsResult & { engine?: Engine };
/** Financial-center coordinates, one major local equity index per supported ISO2 region. */
export const FINANCE_WORLD_REGISTRY = [
  ['US','United States',40.71,-74.01,'^GSPC','S&P 500'],['CA','Canada',43.65,-79.38,'^GSPTSE','S&P/TSX Composite'],
  ['MX','Mexico',19.43,-99.13,'^MXX','S&P/BMV IPC'],['BR','Brazil',-23.55,-46.63,'^BVSP','Ibovespa'],
  ['GB','United Kingdom',51.51,-0.13,'^FTSE','FTSE 100'],['DE','Germany',50.11,8.68,'^GDAXI','DAX'],
  ['FR','France',48.86,2.35,'^FCHI','CAC 40'],['ES','Spain',40.42,-3.70,'^IBEX','IBEX 35'],
  ['IT','Italy',45.46,9.19,'FTSEMIB.MI','FTSE MIB'],['NL','Netherlands',52.37,4.90,'^AEX','AEX'],
  ['CH','Switzerland',47.38,8.54,'^SSMI','Swiss Market Index'],['SE','Sweden',59.33,18.07,'^OMX','OMX Stockholm 30'],
  ['TR','Turkey',41.01,28.98,'XU100.IS','BIST 100'],['ZA','South Africa',-26.20,28.05,'^JN0U.JO','Top 40 USD Net TRI Index'],
  ['IN','India',19.08,72.88,'^NSEI','NIFTY 50'],['CN','China',31.23,121.47,'000001.SS','Shanghai Composite'],
  ['HK','Hong Kong',22.32,114.17,'^HSI','Hang Seng'],['JP','Japan',35.68,139.69,'^N225','Nikkei 225'],
  ['KR','South Korea',37.57,126.98,'^KS11','KOSPI'],['TW','Taiwan',25.03,121.57,'^TWII','Taiwan Weighted'],
  ['SG','Singapore',1.29,103.85,'^STI','Straits Times'],['AU','Australia',-33.87,151.21,'^AXJO','S&P/ASX 200'],
  ['NZ','New Zealand',-36.85,174.76,'^NZ50','S&P/NZX 50 Gross Index'],['ID','Indonesia',-6.21,106.85,'^JKSE','Jakarta Composite'],
  ['TH','Thailand',13.76,100.50,'^SET.BK','SET Index'],
] as const;
const observation = z.object({ symbol:z.string().max(40),value:z.number().finite().nonnegative().max(1e15),changePercent:z.number().finite().nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),asOf:z.string().date() }).strict();
type Observation = z.infer<typeof observation>;
const payload = z.object({engine:z.literal('yfinance'),libraryVersion:z.string().max(80).optional(),observations:z.array(observation).max(30),errorCode:z.string().max(100).optional()}).strict();
const cache = new Map<string,WorldResult>();
const pending = new Map<string,AbortController>();
function partition(scope:FinanceScope):string{return createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId])).digest('hex');}
/** Clearing is unconditional even after the old account authority has expired. */
export function clearFinanceWorldMarketsCache(scope?:FinanceScope):void {if(scope){const key=partition(scope);cache.delete(key);pending.get(key)?.abort(new Error('finance_world_cancelled'));}else{cache.clear();for(const controller of pending.values())controller.abort(new Error('finance_world_cancelled'));}}
/** Availability means an owned engine can run (HTTPS needs no Python), not successful market access. */
export function financeWorldDataSources():FinanceDataSourceOption[]{return[{id:FINANCE_WORLD_SOURCE_ID,name:'Free market data',kind:'builtin',available:true,version:'1.0.0'}];}
function scriptPath():string|null {
  const resources=runtimeResourcesPath(),app=optionalElectronAppPath();
  const candidates=[resources&&path.join(resources,'finance','finance-yfinance.py'),app&&path.join(app,'scripts','finance-yfinance.py'),path.resolve(__dirname,'../../../scripts/finance-yfinance.py'),path.resolve(__dirname,'../../scripts/finance-yfinance.py')];
  for(const candidate of candidates)if(candidate&&!candidate.split(path.sep).some(part=>part.endsWith('.asar'))){try{const stat=fs.lstatSync(candidate);if(stat.isFile()&&!stat.isSymbolicLink())return candidate;}catch{/* Try the next fixed application path. */}}
  return null;
}
function abortError(signal:AbortSignal):Error{return signal.reason instanceof Error?signal.reason:new Error('finance_world_cancelled');}
function pythonCall(python:string,script:string,signal:AbortSignal):Promise<z.infer<typeof payload>> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(abortError(signal));return;}
    const env=withPythonRuntimeBoundary(python,withCliPath({...process.env}));
    // The bundled runtime is isolated. Host Python retains its owner's installed user packages.
    const args=[...(path.basename(python).toLowerCase().replace(/\.exe$/,'')==='py'?['-3']:[]),'-B',env.PYTHONNOUSERSITE==='1'?'-I':'-E',script];
    // Only runtime essentials reach the fixed adapter; user/API credentials never do.
    for(const key of Object.keys(env))if(!/^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LOCALAPPDATA|APPDATA|LANG|LC_[A-Z_]+|PYTHONDONTWRITEBYTECODE|PYTHONPYCACHEPREFIX|PYTHONNOUSERSITE|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key))delete env[key];
    let child:ReturnType<typeof spawn>;try{child=spawn(python,args,{shell:false,windowsHide:true,detached:process.platform!=='win32',env,stdio:['pipe','pipe','pipe']});}catch{reject(new Error('finance_world_python_unavailable'));return;}
    let settled=false,size=0;const chunks:Buffer[]=[];
    const finish=(error?:Error,value?:z.infer<typeof payload>)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);if(error)reject(error);else resolve(value!);};
    const cancel=()=>{killCliTree(child,500);finish(abortError(signal));};
    const timer=setTimeout(()=>{killCliTree(child,500);finish(new Error('finance_world_python_timeout'));},40_000);timer.unref?.();
    signal.addEventListener('abort',cancel,{once:true});
    child.stdout!.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>LIMIT){killCliTree(child,500);finish(new Error('finance_world_output_too_large'));}else chunks.push(chunk);});
    child.stderr!.resume();
    child.once('error',()=>finish(new Error('finance_world_python_unavailable')));
    child.once('close',code=>{if(settled)return;if(code!==0){finish(new Error('finance_world_python_failed'));return;}try{const result=payload.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));const allowed=new Set<string>(FINANCE_WORLD_REGISTRY.map(row=>row[4]));if(result.observations.some(row=>!allowed.has(row.symbol))||new Set(result.observations.map(row=>row.symbol)).size!==result.observations.length)throw new Error();finish(undefined,result);}catch{finish(new Error('finance_world_output_invalid'));}});
    child.stdin!.on('error',()=>undefined);child.stdin!.end(JSON.stringify({symbols:FINANCE_WORLD_REGISTRY.map(row=>row[4])}));if(signal.aborted)cancel();
  });
}
async function pythonObservations(signal:AbortSignal):Promise<Observation[]|null>{
  const script=scriptPath();if(!script)return null;
  let preferred:Awaited<ReturnType<typeof resolveHephaestusPython>>=null;
  try{preferred=await resolveHephaestusPython({signal,cacheResult:false});}catch{if(signal.aborted)throw abortError(signal);}
  const candidates=[preferred?.python,...(process.platform==='win32'?['py','python']:['python3','python'])].filter((value):value is string=>!!value);
  for(const python of new Set(candidates)){signal.throwIfAborted();try{const result=await pythonCall(python,script,signal);if(result.errorCode)continue;return result.observations;}catch(error){if(signal.aborted)throw abortError(signal);if(error instanceof Error&&error.message==='finance_world_python_timeout')return null;}}
  return null;
}
/** This adapter builds every URL itself. No caller URL, redirect, credential or arbitrary query is accepted. */
async function readPublic(url:URL,signal:AbortSignal):Promise<string>{
  const chart=url.origin==='https://query1.finance.yahoo.com'&&FINANCE_WORLD_REGISTRY.some(row=>url.pathname===`/v8/finance/chart/${encodeURIComponent(row[4])}`)&&url.search==='?range=5d&interval=1d';
  const treasury=url.origin==='https://home.treasury.gov'&&url.pathname==='/resource-center/data-chart-center/interest-rates/pages/xml'&&url.searchParams.get('data')==='daily_treasury_yield_curve'&&/^20\d{2}(?:0[1-9]|1[0-2])$/.test(url.searchParams.get('field_tdr_date_value_month')??'')&&[...url.searchParams].length===2;
  if((!chart&&!treasury)||url.username||url.password||url.port||url.hash)throw new Error('finance_world_url_rejected');
  const local=new AbortController(),cancel=()=>local.abort(abortError(signal));const timer=setTimeout(()=>local.abort(new Error('finance_world_request_timeout')),8_000);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  try{const response=await fetch(url,{redirect:'error',signal:local.signal,headers:{Accept:chart?'application/json':'application/xml','User-Agent':'Agentlas Finance/1.0 (local public market reader)'}});if(response.status===429)throw new Error('finance_world_rate_limited');if(!response.ok)throw new Error('finance_world_source_http_error');if(Number(response.headers.get('content-length'))>LIMIT||!response.body)throw new Error('finance_world_source_shape');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>LIMIT)throw new Error('finance_world_output_too_large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);}return Buffer.concat(chunks).toString('utf8');}finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
}
async function yahooObservations(signal:AbortSignal):Promise<Observation[]>{
  const rows:Observation[]=[];let cursor=0,limited=false;
  await Promise.all(Array.from({length:3},async()=>{while(cursor<FINANCE_WORLD_REGISTRY.length&&!limited){signal.throwIfAborted();const entry=FINANCE_WORLD_REGISTRY[cursor++],symbol=entry[4];try{
    const url=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);url.searchParams.set('range','5d');url.searchParams.set('interval','1d');
    const data=JSON.parse(await readPublic(url,signal)),result=data?.chart?.result;
    if(!Array.isArray(result)||result.length!==1||result[0]?.meta?.symbol!==symbol)continue;const item=result[0],values=item?.indicators?.quote?.[0]?.close,times=item.timestamp;if(!Array.isArray(values)||!Array.isArray(times))continue;
    const observations:{stamp:number;close:number}[]=[];
    for(let index=0;index<times.length;index++){const stamp:unknown=times[index],close:unknown=values[index];if(typeof stamp==='number'&&Number.isFinite(stamp)&&typeof close==='number'&&Number.isFinite(close)&&close>=0)observations.push({stamp,close});}
    observations.sort((a,b)=>a.stamp-b.stamp);
    if(new Set(observations.map(row=>row.stamp)).size!==observations.length)continue;
    const last=observations.at(-1),previous=observations.at(-2);if(!last)continue;const timezone=item.meta.exchangeTimezoneName;if(typeof timezone!=='string')continue;
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(last.stamp*1000));const part=(type:string)=>parts.find(value=>value.type===type)?.value;const asOf=`${part('year')}-${part('month')}-${part('day')}`;
    rows.push(observation.parse({symbol,value:last.close,changePercent:previous&&previous.close>0?(last.close/previous.close-1)*100:null,currency:/^[A-Z]{3}$/.test(item.meta.currency??'')&&item.meta.currency!=='XXX'?item.meta.currency:null,asOf}));
  }catch(error){if(signal.aborted)throw abortError(signal);if(error instanceof Error&&error.message==='finance_world_rate_limited')limited=true;}}}));if(!rows.length&&limited)throw new Error('finance_world_rate_limited');return rows;
}
async function usRates(signal:AbortSignal):Promise<FinanceWorldMarket['rates']>{try{const month=new Date().toISOString().slice(0,7).replace('-',''),url=new URL('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml');url.searchParams.set('data','daily_treasury_yield_curve');url.searchParams.set('field_tdr_date_value_month',month);const result=parseTreasury(await readPublic(url,signal),url.href);const row=result.rows.filter(row=>row[1]==='10YEAR'&&typeof row[2]==='number'&&row[3]==='% per annum').sort((a,b)=>String(b[0]).localeCompare(String(a[0])))[0];return row?[{symbol:'US-TREASURY:BC_10YEAR',name:'US Treasury 10-year par yield',value:row[2] as number,unit:'% per annum',asOf:String(row[0])}]:[];}catch(error){if(signal.aborted)throw abortError(signal);return[];}}
export async function getFinanceWorldMarkets({scope,sourceId,signal}:{scope:FinanceScope;sourceId:string;signal?:AbortSignal}):Promise<WorldResult>{
  scope.assertCurrent();if(!scope.workspaceId||!scope.userId)throw new Error('finance_sign_in_required');if(sourceId!==FINANCE_WORLD_SOURCE_ID)throw new Error('finance_world_source_invalid');if(signal?.aborted)throw new Error('finance_world_cancelled');
  const key=partition(scope),prior=cache.get(key);if(prior&&Date.parse(prior.expiresAt)>Date.now())return structuredClone(prior);if(pending.has(key))throw new Error('finance_world_busy');
  const controller=new AbortController(),cancel=()=>controller.abort(new Error('finance_world_cancelled'));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();pending.set(key,controller);const timer=setTimeout(()=>controller.abort(new Error('finance_world_timeout')),90_000);timer.unref?.();
  try{let engine:Engine='yfinance',sourceError:string|undefined,observations=await pythonObservations(controller.signal);scope.assertCurrent();controller.signal.throwIfAborted();if(!observations?.length){engine='yahoo-chart';try{observations=await yahooObservations(controller.signal);}catch(error){if(controller.signal.aborted)throw abortError(controller.signal);sourceError=error instanceof Error&&error.message==='finance_world_rate_limited'?error.message:'finance_world_source_unavailable';observations=[];}}const rates=await usRates(controller.signal);scope.assertCurrent();controller.signal.throwIfAborted();
    const markets:FinanceWorldMarket[]=FINANCE_WORLD_REGISTRY.map(([countryCode,name,latitude,longitude,symbol,indexName])=>{const row=observations!.find(row=>row.symbol===symbol);return{id:`market-${countryCode}`,name,countryCode,latitude,longitude,index:{symbol,name:indexName,value:row?.value??null,changePercent:row?.changePercent??null,currency:row?.currency??null,asOf:row?.asOf??null},rates:countryCode==='US'?rates:[],status:row?'ok':'unavailable'};});
    const count=markets.filter(market=>market.status==='ok').length,fetchedAt=new Date().toISOString();const result:WorldResult={status:count===0?'unavailable':count===markets.length&&rates.length?'ok':'partial',sourceId,engine,fetchedAt,expiresAt:new Date(Date.now()+TTL).toISOString(),markets,...(!count?{errorCode:sourceError??'finance_world_source_unavailable'}:{})};
    if(count){cache.delete(key);cache.set(key,structuredClone(result));while(cache.size>8)cache.delete(cache.keys().next().value!);}return result;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(pending.get(key)===controller)pending.delete(key);}
}
