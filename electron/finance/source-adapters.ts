import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FinanceAsset, FinanceDataRequest, FinanceDataResult, FinanceSearchResult } from '../../shared/finance';
import type { FinanceDataSourceOption } from '../../shared/finance-experience';
import { requiredExecutionPermission } from '../../shared/graph-node-protocol';

import { isFinanceSourceCapability } from '../../shared/finance-source-contract';
export { FINANCE_SOURCE_CAPABILITY, isFinanceSourceCapability } from '../../shared/finance-source-contract';
const sourceId=(id:string,version:number,hash:string)=>`toolchain:${id}:${version}:${hash.replace(/^sha256:/,'')}`;
/** Opt-in adapters use the existing published, validated, immutable toolchain registry. */
export async function financeToolchainSources():Promise<FinanceDataSourceOption[]>{
 const {listToolchainAssets}=await import('../toolchains/assets');
 return listToolchainAssets().filter(asset=>isFinanceSourceCapability(asset.capabilityKey)).flatMap(asset=>{
  return asset.versions.filter(version=>version.validation.state==='passed'&&requiredExecutionPermission(version.implementation.snapshot.graph)==='read').map(version=>({id:sourceId(asset.id,version.version,version.contentHash),name:asset.name,kind:'toolchain' as const,version:String(version.version),available:asset.status==='callable'}));
 });
}
const https=z.string().max(2000).url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;});
const cell=z.union([z.string().max(20000),z.number().finite().min(-1e15).max(1e15),z.null()]);
const assetSchema=z.object({id:z.string().min(1).max(200),symbol:z.string().min(1).max(80),name:z.string().min(1).max(300),exchange:z.string().max(80),currency:z.string().regex(/^[A-Z]{3}$/),kind:z.enum(['stock','etf','fund','bond','crypto','commodity','other'])}).strict();
const date=z.string().max(80).refine(value=>Number.isFinite(Date.parse(value)));
const dataSchema=z.object({status:z.enum(['ok','partial','unconnected','error']),sourceUrls:z.array(https).max(100),asOf:date.nullable(),retrievedAt:date,columns:z.array(z.string().max(300)).max(100),rows:z.array(z.array(cell).max(100)).max(10000),warnings:z.array(z.string().max(20000)).max(100),providers:z.array(z.object({id:z.string().max(200),label:z.string().max(300),status:z.enum(['ok','partial','unavailable','error']),coverage:z.string().max(20000),rights:z.string().max(20000),sourceUrls:z.array(https).max(100)}).strict()).max(50).optional()}).strict();
const searchSchema=z.object({assets:z.array(assetSchema).max(100),provider:z.string().max(300),asOf:date.nullable(),warnings:z.array(z.string().max(20000)).max(100)}).strict();
async function invoke(source:string,args:Record<string,unknown>,signal?:AbortSignal,assertCurrent?:()=>void):Promise<unknown>{
 const match=/^toolchain:([A-Za-z0-9_-]{1,100}):([1-9]\d*):([a-f0-9]{64})$/.exec(source);if(!match)throw new Error('finance_source_adapter_invalid');
 signal?.throwIfAborted();assertCurrent?.();const [{getToolchainAsset},{callToolchain}]=await Promise.all([import('../toolchains/assets'),import('../toolchains/calls')]);assertCurrent?.();
 const asset=getToolchainAsset(match[1]),version=asset?.versions.find(version=>version.version===Number(match[2]));
 if(!asset||!isFinanceSourceCapability(asset.capabilityKey)||asset.status!=='callable'||!version||sourceId(asset.id,version.version,version.contentHash)!==source||version.validation.state!=='passed'||requiredExecutionPermission(version.implementation.snapshot.graph)!=='read')throw new Error('finance_source_adapter_unavailable');
 const receipt=await callToolchain({toolchainId:asset.id,version:version.version,args},{requestId:`finance-source:${randomUUID()}`,permission:'read',signal,assertCurrent});
 signal?.throwIfAborted();assertCurrent?.();if(!receipt.ok||receipt.status!=='succeeded'||receipt.contentHash!==version.contentHash)throw new Error('finance_source_adapter_failed');
 if(Buffer.byteLength(JSON.stringify(receipt.result??null))>4*1024*1024)throw new Error('finance_source_adapter_output_too_large');return receipt.result;
}
export async function searchFinanceAdapter(source:string,query:string,signal?:AbortSignal,assertCurrent?:()=>void):Promise<FinanceSearchResult>{return searchSchema.parse(await invoke(source,{action:'search',query},signal,assertCurrent));}
export async function queryFinanceAdapter(source:string,request:FinanceDataRequest,assets:FinanceAsset[],signal?:AbortSignal,assertCurrent?:()=>void):Promise<FinanceDataResult>{
 const selected=request.assetIds.map(id=>assets.find(asset=>asset.id===id)??(()=>{throw new Error('finance_asset_not_found');})());
 const result=dataSchema.parse(await invoke(source,{action:'query',request,assets:selected},signal,assertCurrent));
 if(result.rows.some(row=>row.length!==result.columns.length))throw new Error('finance_source_adapter_shape');
 if(result.rows.length&&['ok','partial'].includes(result.status)&&!result.sourceUrls.length)throw new Error('finance_source_adapter_provenance_required');return result;
}
