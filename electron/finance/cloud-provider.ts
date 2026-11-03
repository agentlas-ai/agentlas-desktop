import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAuthenticatedSessionBinding } from '../auth';
import { managedOneAuthentication, managedOneAuthenticationEpoch, managedOneHeaders, wasManagedOneConfigured } from '../managed-one/auth';
import type { FinanceDataRequest, FinanceDataResult, FinanceSearchResult, FinanceWorkspace } from '../../shared/finance';
import type { FinanceDataSourceOption } from '../../shared/finance-experience';

const symbol = z.string().regex(/^[A-Za-z0-9.^_-]{1,80}$/);
const text = (max:number,min=0) => z.string().min(min).max(max).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
const amount = z.number().finite().min(0).max(1e15);
const resultSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('status'),available:z.boolean()}).strict(),
  z.object({action:z.literal('search'),assets:z.array(z.object({symbol,name:text(300,1),region:text(80),currency:z.string().regex(/^[A-Z]{3}$/),type:text(80)}).strict()).max(30)}).strict(),
  z.object({action:z.literal('quote'),symbol,price:amount,asOf:day,volume:amount.nullable()}).strict(),
]);
const envelope = z.object({schemaVersion:z.literal('agentlas.finance-market-response.v1'),requestId:z.string().uuid(),status:z.literal('ok'),replayed:z.boolean(),result:resultSchema}).strict();
export type CloudMarketResult = z.infer<typeof resultSchema>;
export interface CloudFinanceContext { signal?:AbortSignal; assertCurrent?():void }
interface CloudPorts {
  managed:typeof managedOneAuthentication;
  binding:typeof getAuthenticatedSessionBinding;
  epoch:typeof managedOneAuthenticationEpoch;
  headers:typeof managedOneHeaders;
  fetcher:typeof fetch;
  requestId():string;
  now():number;
  policyReady():boolean;
}
// One process-wide, host-only latch. An ordinary tools import can never become a paid/replayable Managed lane.
let hostPolicy:'managed'|'ordinary'|undefined;
export function installManagedFinanceHostPolicy(ports:readonly {operationId:string;effectFreeRead?:boolean;callTimeoutMs?:number}[]):void {
  if(hostPolicy!==undefined)return;
  const safe=wasManagedOneConfigured()&&['finance.search','finance.query','finance.asset.add','finance.query.save'].every(id=>{const port=ports.find(port=>port.operationId===id);return !!port&&port.callTimeoutMs===60000&&(!['finance.search','finance.query'].includes(id)||port.effectFreeRead!==true);});
  hostPolicy=safe?'managed':'ordinary';
}
const defaults:CloudPorts={managed:managedOneAuthentication,binding:getAuthenticatedSessionBinding,epoch:managedOneAuthenticationEpoch,headers:managedOneHeaders,fetcher:(...args)=>fetch(...args),requestId:randomUUID,now:Date.now,policyReady:()=>hostPolicy==='managed'};
const DOC='https://www.alphavantage.co/documentation/';
export const CLOUD_FINANCE_LIMITS='Alpha Vantage GLOBAL_QUOTE via Agentlas Cloud; observation precision is one provider trading day. Quote currency and listing venue are not supplied or verified. This is not asserted real-time, executable, dividend-adjusted or total return.';
const failure=(message:string)=>new Error(message);

/** One dispatch only. A timeout, lost response or expired server receipt never authorizes replay. */
export function createManagedFinanceMarketClient(overrides:Partial<CloudPorts>={}) {
  const ports={...defaults,...overrides};
  return async function request(input:{action:'status'}|{action:'search';query:string}|{action:'quote';symbol:string},context:CloudFinanceContext={}):Promise<CloudMarketResult>{
    context.signal?.throwIfAborted();context.assertCurrent?.();
    const managed=ports.managed(),binding=ports.binding(),epoch=ports.epoch('control'),headers=ports.headers('control');
    if(!ports.policyReady()||!managed||!binding||!epoch||!headers||managed.expiresAt<=ports.now()||managed.userId!==binding.userId||managed.workspaceId!==binding.workspaceId)throw failure('finance_cloud_provider_unavailable');
    const base=new URL(managed.webBaseUrl);
    if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw failure('finance_cloud_provider_unavailable');
    const assertCurrent=()=>{
      context.signal?.throwIfAborted();context.assertCurrent?.();
      const next=ports.managed(),actor=ports.binding();
      if(!next||!actor||next.expiresAt<=ports.now()||next.hostId!==managed.hostId||next.generation!==managed.generation||next.webBaseUrl!==managed.webBaseUrl||next.userId!==managed.userId||next.workspaceId!==managed.workspaceId||actor.userId!==binding.userId||actor.workspaceId!==binding.workspaceId||actor.sessionId!==binding.sessionId||ports.epoch('control')!==epoch)throw failure('finance_account_changed');
    };
    if(input.action==='search'&&(!input.query.trim()||input.query.trim().length>200)||input.action==='quote'&&!symbol.safeParse(input.symbol).success)throw failure('finance_query_invalid');
    const requestId=z.string().uuid().parse(ports.requestId());
    const body={schemaVersion:'agentlas.finance-market-request.v1',requestId,...input,...(input.action==='search'?{query:input.query.trim()}:{})};
    // Provider HTTP may use 20 seconds plus server authorization/receipt work.
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),input.action==='status'?6000:45000);
    const signal=context.signal?AbortSignal.any([context.signal,controller.signal]):controller.signal;
    try{
      assertCurrent();
      const response=await ports.fetcher(new URL('/api/managed-one/host/finance-data',base),{method:'POST',redirect:'error',cache:'no-store',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body),signal});
      assertCurrent();signal.throwIfAborted();
      if(Number(response.headers.get('content-length'))>256*1024||!response.body)throw failure('finance_cloud_provider_response_invalid');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
      try{for(;;){const part=await reader.read();assertCurrent();signal.throwIfAborted();if(part.done)break;length+=part.value.byteLength;if(length>256*1024)throw failure('finance_cloud_provider_response_invalid');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>undefined);}
      let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('finance_cloud_provider_response_invalid');}
      if(!response.ok){
        const code=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as {error?:unknown}).error:null;
        if(code==='finance_market_provider_unavailable')throw failure('finance_cloud_provider_unavailable');
        if(code==='finance_market_provider_invalid')throw failure('finance_cloud_provider_response_invalid');
        throw failure(response.status===429?'finance_cloud_provider_budget_unavailable':response.status===401||response.status===403?'finance_cloud_provider_access_denied':'finance_cloud_provider_outcome_unknown');
      }
      const parsed=envelope.safeParse(raw);
      if(!parsed.success||parsed.data.requestId!==requestId||parsed.data.result.action!==input.action||input.action==='quote'&&(parsed.data.result.action!=='quote'||parsed.data.result.symbol!==input.symbol))throw failure('finance_cloud_provider_response_invalid');
      assertCurrent();return parsed.data.result;
    }catch(error){
      assertCurrent();
      if(error instanceof Error&&/^finance_(?:cloud_provider_[a-z_]+|query_invalid)$/.test(error.message))throw error;
      throw failure('finance_cloud_provider_outcome_unknown');
    }finally{clearTimeout(timer);}
  };
}
export const requestManagedFinanceMarket=createManagedFinanceMarketClient();
function boundary(error:unknown,context:CloudFinanceContext):string {
  context.signal?.throwIfAborted();context.assertCurrent?.();
  if(error instanceof Error&&error.message==='finance_account_changed')throw error;
  return error instanceof Error&&/^finance_cloud_provider_[a-z_]+$/.test(error.message)?error.message:'finance_cloud_provider_unavailable';
}
/** Selectability reports server configuration/authority only; no upstream entitlement probe or polling. */
export async function managedFinanceProviderSources():Promise<FinanceDataSourceOption[]>{
  if(!wasManagedOneConfigured())return[];
  let available=false;try{const result=await requestManagedFinanceMarket({action:'status'});available=result.action==='status'&&result.available;}catch{/* Unknown never becomes available. */}
  return[{id:'alpha-vantage',name:'Cloud market data · daily quote',kind:'builtin',available,version:'1'}];
}
export async function searchManagedFinanceAssets(query:string,context:CloudFinanceContext):Promise<FinanceSearchResult>{
  try{
    const result=await requestManagedFinanceMarket({action:'search',query},context);if(result.action!=='search')throw failure('finance_cloud_provider_response_invalid');
    const counts=new Map<string,number>();for(const asset of result.assets)counts.set(asset.symbol,(counts.get(asset.symbol)??0)+1);
    return{assets:result.assets.filter(asset=>counts.get(asset.symbol)===1).map(asset=>({id:`av:${asset.symbol}`,symbol:asset.symbol,name:asset.name,exchange:'',currency:asset.currency,kind:/ETF/i.test(asset.type)?'etf':/Equity/i.test(asset.type)?'stock':'other'})),provider:'Alpha Vantage via Agentlas Cloud',asOf:null,warnings:['Provider search metadata only; region is not a verified listing venue. Quote currency and venue are not established by this search response.',...(result.assets.some(asset=>(counts.get(asset.symbol)??0)>1)?['finance_cloud_provider_search_ambiguous']:[])]};
  }catch(error){return{assets:[],provider:'Alpha Vantage via Agentlas Cloud',asOf:null,warnings:[boundary(error,context)]};}
}
export async function queryManagedFinanceData(input:FinanceDataRequest,assets:FinanceWorkspace['watchlist'],context:CloudFinanceContext):Promise<FinanceDataResult>{
  const empty=(warning:string):FinanceDataResult=>({status:'unconnected',sourceUrls:[DOC],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:[warning,CLOUD_FINANCE_LIMITS]});
  if(input.metrics.length!==1||input.metrics[0]!=='price'||input.assetIds.length!==1)return empty('finance_cloud_provider_metric_unsupported');
  const selected=assets.filter(asset=>asset.id===input.assetIds[0]);if(selected.length!==1||selected[0].id!==`av:${selected[0].symbol}`)return empty('finance_cloud_provider_identity_unverified');
  try{
    const result=await requestManagedFinanceMarket({action:'quote',symbol:selected[0].symbol},context);if(result.action!=='quote')throw failure('finance_cloud_provider_response_invalid');
    return{status:'partial',sourceUrls:[DOC],asOf:result.asOf,retrievedAt:new Date().toISOString(),columns:['Provider symbol','Price','Quote limitations','Volume'],rows:[[result.symbol,result.price,'Provider trading-day quote; currency and venue unverified; not verified real-time.',result.volume]],warnings:[CLOUD_FINANCE_LIMITS,'finance_cloud_provider_identity_unverified'],providers:[{id:'alpha-vantage',label:'Alpha Vantage via Agentlas Cloud',status:'partial',coverage:CLOUD_FINANCE_LIMITS,rights:'Provider account entitlement and redistribution rights are not established by public API access.',sourceUrls:[DOC]}]};
  }catch(error){return empty(boundary(error,context));}
}
// Watchlist quote refresh no longer lives here. A server-relayed quote is one symbol with no verified currency or listing
// venue, so it cannot be imported as a quote. A Cloud computer refreshes through the direct Yahoo path in data.ts
// (refreshFinanceQuotes -> managedDirectMarket); this module stays for asset search, status, and the single-price fallback.
