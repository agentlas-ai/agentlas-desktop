import { FinanceComputeRequestSchema, type FinanceComputeRequest, type FinanceComputeHistory, type FinanceComputeArtifact } from '../../shared/finance-compute';
import type { FinanceAsset, FinanceDataResult } from '../../shared/finance';
import { calculateFinance } from './compute';
import { z } from 'zod';

/** Only this boundary supplies observed numerical input. A model selects assets and a method. */
export async function calculateFromFinanceSources(raw:unknown,assets:FinanceAsset[],query:(asset:FinanceAsset)=>Promise<FinanceDataResult>,signal:AbortSignal,compute:typeof calculateFinance=calculateFinance):Promise<FinanceComputeArtifact & {inputEvidence?:FinanceDataResult[];requestSnapshot?:FinanceComputeRequest}>{
 const request=FinanceComputeRequestSchema.parse(raw);signal.throwIfAborted();
 if(request.kind==='option')return {...compute(request,{histories:[],provenance:{kind:'scenario',origin:'model_assumption',label:'대화에서 설정한 옵션 가격 가정',declaredAt:new Date().toISOString()}}),requestSnapshot:request};
 const selected=request.assetIds.map(id=>assets.find(asset=>asset.id===id)??(()=>{throw new Error('finance_compute_asset_not_found');})());
 const histories:FinanceComputeHistory[]=[],sourceUrls:string[]=[],warnings:string[]=[],inputEvidence:FinanceDataResult[]=[];
 let retrievedAt='';
 for(const asset of selected){
  signal.throwIfAborted();const result=await query(asset);signal.throwIfAborted();
  if(!['ok','partial'].includes(result.status)||!result.rows.length)throw new Error('finance_compute_history_unavailable');
  if(!result.sourceUrls.length||result.sourceUrls.some(value=>{try{const url=new URL(value);return !['https:','http:'].includes(url.protocol)||!!url.username||!!url.password;}catch{return true;}}))throw new Error('finance_compute_source_required');
  if(!z.string().datetime({offset:true}).safeParse(result.retrievedAt).success)throw new Error('finance_compute_retrieval_time_required');
  const column=(names:string[])=>names.map(name=>result.columns.indexOf(name)).find(index=>index>=0)??-1;
  const date=column(['Observation date','Date']),close=column(['Close (raw)','Close']),symbol=column(['Symbol']),currency=column(['Currency']);
  if([date,close,symbol,currency].some(index=>index<0))throw new Error('finance_compute_history_schema_unsupported');
  const seen=new Set<string>();
  const prices=result.rows.map(row=>{
   if(row[symbol]!==asset.symbol||row[currency]!==asset.currency)throw new Error('finance_compute_history_identity_mismatch');
   const day=row[date],value=row[close];
   if(typeof day!=='string'||!/^\d{4}-\d\d-\d\d$/.test(day)||typeof value!=='number'||!Number.isFinite(value)||value<=0)return null;
   if(seen.has(day))throw new Error('finance_compute_duplicate_observation');seen.add(day);return{date:day,close:value};
  }).filter((point):point is {date:string;close:number}=>!!point).sort((a,b)=>a.date.localeCompare(b.date)).slice(-2600);
  if(prices.length!==result.rows.length)warnings.push(`${asset.symbol}: 양수 종가가 있는 최근 관측만 계산에 포함했습니다 (${prices.length}/${result.rows.length}).`);
  histories.push({assetId:asset.id,symbol:asset.symbol,currency:asset.currency,priceBasis:'price',adjustment:'unknown',prices});
  inputEvidence.push({...result,rows:result.rows.slice(-2600)});
  sourceUrls.push(...result.sourceUrls);warnings.push(...result.warnings);if(result.retrievedAt>retrievedAt)retrievedAt=result.retrievedAt;
 }
 // Intersect actual dates; do not forward-fill or fabricate closed-market observations.
 const common=histories[0].prices.filter(point=>histories.every(history=>history.prices.some(other=>other.date===point.date))).map(point=>point.date),days=new Set(common);
 for(const history of histories){if(history.prices.length!==days.size)warnings.push(`${history.symbol}: 모든 자산에 관측된 공통 ${days.size}개 날짜만 사용했습니다.`);history.prices=history.prices.filter(point=>days.has(point.date));}
 const artifact=compute(request,{histories,provenance:{kind:'observed',sourceUrls:[...new Set(sourceUrls)].slice(0,100),retrievedAt}});
 artifact.warnings=[...new Set([...artifact.warnings,...warnings])].slice(0,100);
 return {...artifact,requestSnapshot:request,inputEvidence:histories.map((history,index)=>({...inputEvidence[index],columns:['Observation date','Symbol','Currency','Close'],rows:history.prices.map(point=>[point.date,history.symbol,history.currency,point.close]),asOf:history.prices.at(-1)?.date??null}))};
}
