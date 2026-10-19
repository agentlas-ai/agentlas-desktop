import type { WorkflowGraph } from './types';
import type { ToolchainAssetContract } from './toolchain-asset';
import { requiredExecutionPermission } from './graph-node-protocol';

export const FINANCE_SOURCE_CAPABILITY = 'finance.data-source.v1';
/** Legacy identity remains valid; new providers retain distinct registry identities. */
export function isFinanceSourceCapability(value:unknown):value is string {
 if(value===FINANCE_SOURCE_CAPABILITY)return true;
 if(typeof value!=='string'||value.length>160||!value.startsWith(FINANCE_SOURCE_CAPABILITY+':'))return false;
 const suffix=value.slice(FINANCE_SOURCE_CAPABILITY.length+1);
 return suffix.length<=80&&/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(suffix);
}
const str=(maxLength:number)=>({type:'string',maxLength});
const list=(items:unknown,maxItems:number)=>({type:'array',items,maxItems});
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const date={type:'string',maxLength:80,pattern:'^\\d{4}-\\d{2}-\\d{2}(?:T.*)?$'};
const nullable=(schema:unknown)=>({anyOf:[schema,{type:'null'}]});
const https={type:'string',maxLength:2000,pattern:'^https://[^/@?#\\s]+(?:[/?#].*)?$'};
const asset=object({id:{...str(200),minLength:1},symbol:{...str(80),minLength:1},name:{...str(300),minLength:1},exchange:str(80),currency:{type:'string',pattern:'^[A-Z]{3}$'},kind:{enum:['stock','etf','fund','bond','crypto','commodity','other']}});
const request=object({query:str(2000),assetIds:list({...str(200),minLength:1},10),metrics:list({...str(80),minLength:1},10),period:str(80)});
const cell={anyOf:[str(20000),{type:'number',minimum:-1e15,maximum:1e15},{type:'null'}]};
const provider=object({id:str(200),label:str(300),status:{enum:['ok','partial','unavailable','error']},coverage:str(20000),rights:str(20000),sourceUrls:list(https,100)});
const search=object({assets:list(asset,100),provider:str(300),asOf:nullable(date),warnings:list(str(20000),100)});
const data=object({status:{enum:['ok','partial','unconnected','error']},sourceUrls:list(https,100),asOf:nullable(date),retrievedAt:date,columns:list(str(300),100),rows:list(list(cell,100),10000),warnings:list(str(20000),100),providers:list(provider,50)},['status','sourceUrls','asOf','retrievedAt','columns','rows','warnings']);
const description=object({kind:{const:'capabilities'},actions:{type:'array',items:{enum:['search','query']},minItems:2,maxItems:2,uniqueItems:true},readOnly:{const:true}});
const version=object({kind:{const:'version'},schemaVersion:{const:'finance.data-source.v1'}});

/** A finite integration contract, not a model-authored authority or a live-data receipt. */
export const FINANCE_SOURCE_INPUT_SCHEMA = {
 ...object({action:{enum:['search','query','describe','version']},query:str(200),request,assets:list(asset,10)},['action']),
 anyOf:[
  {type:'object',properties:{action:{const:'search'},query:{...str(200),minLength:1}},required:['query']},
  {type:'object',properties:{action:{const:'query'},request,assets:list(asset,10)},required:['request','assets']},
  {type:'object',properties:{action:{enum:['describe','version']}}},
 ],
};
export const FINANCE_SOURCE_OUTPUT_SCHEMA = {anyOf:[search,data,description,version]};
export const FINANCE_SOURCE_SOFTWARE_EXAMPLES = [
 {input:{action:'describe'},expectedOutput:{kind:'capabilities',actions:['search','query'],readOnly:true}},
 {input:{action:'version'},expectedOutput:{kind:'version',schemaVersion:'finance.data-source.v1'}},
];
/** Compact implementation data; canonical JSON schemas and examples belong to the host. */
export const FINANCE_SOURCE_INTEGRATION_CONTRACT = {
 schemaVersion:'agentlas.finance-source-integration.v4',
 capability:{legacy:FINANCE_SOURCE_CAPABILITY,prefix:FINANCE_SOURCE_CAPABILITY+':',suffixPattern:'^[a-z0-9]+(?:[._-][a-z0-9]+)*$',maxSuffixLength:80},
 hostOwns:['contract.inputSchema','contract.outputSchema','contract.examples'],
 executionPermission:'read',outputBindingFormat:'json',credentialRequirement:'none',
 invocation:{inputFields:['action','query','request','assets'],actions:['search','query','describe','version'],
  search:{query:'nonempty string <=200',result:{assets:'asset[] <=100',provider:'string',asOf:'actual date or null',warnings:'string[]'}},
  query:{request:{query:'string',assetIds:'selected asset IDs[] <=10',metrics:'metric names[] <=10',period:'requested period'},assets:'selected asset[] <=10',
   result:{status:['ok','partial','unconnected','error'],sourceUrls:'actual HTTPS source URLs[]',asOf:'actual observation date/time or null',retrievedAt:'actual retrieval timestamp',columns:'unique column names[]',rows:'(string|finite number|null)[][] matching columns',warnings:'string[]',providers:{optional:true,items:{id:'string',label:'string',status:['ok','partial','unavailable','error'],coverage:'actual coverage',rights:'provider use/redistribution terms',sourceUrls:'actual HTTPS URLs[]'}}}},
  asset:{id:'stable provider ID',symbol:'exact listing symbol',name:'provider name',exchange:'provider exchange',currency:'ISO4217 or XXX when unknown',kind:['stock','etf','fund','bond','crypto','commodity','other']},
  softwareActions:FINANCE_SOURCE_SOFTWARE_EXAMPLES,
 },
 consumerContracts:{
  price:{columns:['Symbol','Price','Currency','Observed at'],cardinality:'one row per selected listing',symbol:'exact selected symbol',currency:'exact selected currency',price:'finite number; negative observations may be queried but cannot enter nonnegative quote ledger',observedAt:'actual source timestamp with timezone; missing remains null, never synthesize midnight from a date',sourceUrls:'actual HTTPS endpoints; required for observations'},
  price_history:{columns:['Observation date','Symbol','Currency','Open','High','Low','Close (raw)','Volume'],date:'actual exchange-local YYYY-MM-DD',symbol:'one exact selected listing',currency:'provider currency or XXX; no guessed FX',ohlc:'finite signed raw observations or null; no interpolation or total-return claim',volume:'nonnegative finite source value or null',dates:'unique ascending actual observation dates'},
 },
 unsupported:{status:'unconnected',rows:[],asOf:null,warnings:'explicit unsupported metric/period/coverage; no hidden provider fallback or invented observations'},
 verification:{
  subject:'declared step result JSON only; requested inputs, original provider bytes and transport/file logs are absent unless separately bound as evidence',
  evidenceBinding:{field:'blueprint.checks[].evidence',optional:true,value:'ASCII name of an existing produced variable containing independently obtained evidence; never explanatory prose or the result JSON as its own proof',pattern:'^[A-Za-z_][A-Za-z0-9_-]*$',absent:'omit evidence when no independent evidence variable exists; independent claims then remain unknown/unavailable',validation:'host retains maxLength80 and produced-variable/data-flow validation; never invent, drop or silently replace a binding'},
  scope:'retain checklist evaluation; grade only conditional action/output shape facts visible in its actual subject',
  branches:[
   {when:'kind=capabilities',observable:'actions includes search/query and readOnly is boolean true; this is a software capability declaration, not proof of transport or execution safety'},
   {when:'kind=version',observable:'schemaVersion equals finance.data-source.v1'},
   {when:'assets array and provider string',observable:'bounded normalized asset field types, nullable asOf and warnings array; empty results or unsupported search have explicit warnings'},
   {when:'data columns contain Symbol/Price/Currency/Observed at',observable:'row width, nonempty symbol, three-letter currency code, finite price or null, timezone timestamp or null; no history requirement applies to this branch'},
   {when:'data columns contain Observation date/Symbol/Close (raw)',observable:'row width, valid YYYY-MM-DD dates ascending and unique per symbol, signed finite OHLC or null, nonnegative finite volume or null when those columns are present'},
   {when:'data status is unconnected/error',observable:'empty observation rows, nullable asOf and explicit nonempty warnings; unsupported or failed requests are not empty ok results'},
  ],
  sourceUrls:'HTTPS URL string presence/format is visible; it is not an independent request receipt',
  independentEvidence:{claims:['exact match to requested asset','identity against original provider response','actual observation timestamp origin','transport/authentication behavior','no fallback/interpolation/file or ledger mutation'],required:'actual independently bound inputs/source/transport/effect evidence appropriate to each claim',absent:'unknown/unavailable; never infer pass from result JSON or self-attestation'},
  enforcement:{code:'source identity, currency, timestamps, transport and unsupported handling',host:'existing schema, immutable binding, permission and execution boundaries',checklist:'visible result shape and only those independent claims whose actual evidence is included'},
 },
};
export type FinanceSourceSemanticContract = Omit<ToolchainAssetContract,'inputSchema'|'outputSchema'|'examples'>;
/** New proposals only. Immutable reuse and cached releases are never rewritten. */
export function materializeFinanceSourceContract(contract:FinanceSourceSemanticContract):ToolchainAssetContract {
 return {...structuredClone(contract),inputSchema:structuredClone(FINANCE_SOURCE_INPUT_SCHEMA),outputSchema:structuredClone(FINANCE_SOURCE_OUTPUT_SCHEMA),examples:structuredClone(FINANCE_SOURCE_SOFTWARE_EXAMPLES)};
}
/** Derive only from the trusted host schema; graph/identity bounds remain unchanged. */
export function financeSourceProposalSchema(base:Record<string,unknown>):Record<string,unknown> {
 type ContractShape={properties:Record<string,unknown>;required:string[]};
 type BlueprintShape={properties:{checks:{items:{properties:{evidence:{pattern?:string;description?:string}}}}}};
 const schema=structuredClone(base) as {properties:{contract:{anyOf:ContractShape[]};blueprint:{anyOf:BlueprintShape[]}};oneOf:Array<{properties:{contract:ContractShape;blueprint:BlueprintShape}} >};
 const contracts=[schema.properties.contract.anyOf[0],schema.oneOf[1].properties.contract,schema.oneOf[2].properties.contract];
 for(const contract of contracts){for(const field of ['inputSchema','outputSchema','examples'])delete contract.properties[field];contract.required=contract.required.filter((field:string)=>!['inputSchema','outputSchema','examples'].includes(field));}
 const blueprints=[schema.properties.blueprint.anyOf[0],schema.oneOf[1].properties.blueprint,schema.oneOf[2].properties.blueprint];
 for(const blueprint of blueprints)Object.assign(blueprint.properties.checks.items.properties.evidence,{pattern:'^[A-Za-z_][A-Za-z0-9_-]*$',description:'Optional existing produced variable name holding independent evidence. Omit when absent; never prose or a fabricated binding.'});
 return schema;
}
/** Annotation/key order is not schema meaning; tuple order and validation constraints are retained. */
function canonical(value:unknown,key=''):unknown {
 if(Array.isArray(value)){const items=value.map(item=>canonical(item));return ['required','enum','anyOf','oneOf'].includes(key)?items.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):items;}
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([name])=>!['title','description','$comment'].includes(name)).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,canonical(item,name)]));
 return value;
}
/** Purpose admission checks both newly generated graphs and immutable reuse before committing. */
export function assertFinanceSourceContract(input:{capabilityKey:unknown;contract:ToolchainAssetContract;graph:WorkflowGraph;outputFormat:unknown}):void {
 if(!isFinanceSourceCapability(input.capabilityKey))throw new Error('finance_source_capability_invalid');
 if(!input.graph?.nodes.length||requiredExecutionPermission(input.graph)!=='read')throw new Error('finance_source_read_only_required');
 if(input.outputFormat!=='json')throw new Error('finance_source_json_output_required');
 if(JSON.stringify(canonical(input.contract.inputSchema))!==JSON.stringify(canonical(FINANCE_SOURCE_INPUT_SCHEMA)))throw new Error('finance_source_input_contract_invalid');
 if(JSON.stringify(canonical(input.contract.outputSchema))!==JSON.stringify(canonical(FINANCE_SOURCE_OUTPUT_SCHEMA)))throw new Error('finance_source_output_contract_invalid');
}
