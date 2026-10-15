import { createHash } from 'node:crypto';
import { workArray,workObject,workId,workSnapshot,workFail,type WorkOracle,type WorkValue,type WorkProgram,type WorkField } from '../../shared/business/employee-agent-work';
import { validateWorkProgram,workDigest } from './employee-agent-work-semantics';
/** Semantic version is an implementation identity, not an oracle. Cases are always
 * separately reviewed customer input; this module includes no passing fixture. */
export const WORK_EVALUATOR_VERSION='agentlas.business.finite-record-executor.v1';
const valid=(f:WorkField,v:unknown):v is WorkValue=>f.type==='integer'?Number.isSafeInteger(v):f.type==='boolean'?typeof v==='boolean':typeof v==='string'&&f.values.includes(v);
const safe=(v:bigint)=>{if(v>BigInt(Number.MAX_SAFE_INTEGER)||v<BigInt(Number.MIN_SAFE_INTEGER))workFail('integer_overflow');return Number(v)};
export function executeWorkProgram(input:unknown,values:unknown):Record<string,WorkValue>{
 const p=validateWorkProgram(input),v=workSnapshot(values);if(!workObject(v,p.inputs.map(f=>f.id)))workFail('input_invalid');
 const r=new Map<string,WorkValue>();for(const f of p.inputs){if(!valid(f,v[f.id]))workFail('input_invalid');r.set(f.id,v[f.id] as WorkValue)}
 for(const n of p.nodes){let z:WorkValue;switch(n.op){
  case 'copy':z=r.get(n.from)!;break;
  case 'add':z=safe(BigInt(r.get(n.left) as number)+BigInt(r.get(n.right) as number));break;
  case 'equal':z=r.get(n.left)===r.get(n.right);break;
  case 'choose':z=r.get(r.get(n.condition)===true?n.yes:n.no)!;break;
  case 'scale':{const a=BigInt(r.get(n.from) as number)*BigInt(n.numerator),b=BigInt(n.denominator);let q=a/b;const rem=a%b;
   if(rem!==0n){if(n.rounding==='exact')workFail('inexact_conversion');const twice=(rem<0n?-rem:rem)*2n;if(twice>b||twice===b&&(q<0n?-q:q)%2n===1n)q+=a<0n?-1n:1n}z=safe(q);break;}
 }r.set(n.id,z)}
 return Object.fromEntries(p.outputs.map(f=>[f.id,r.get(f.from)!]));
}
export function validateWorkOracle(input:unknown):WorkOracle{
 const o=workSnapshot(input);if(!workObject(o,['schema','oracleId','revision','cases'])||o.schema!=='agentlas.business.work-oracle.v1'||!workId(o.oracleId)||!workId(o.revision)||!workArray(o.cases,128)||o.cases.length<3)workFail('oracle_invalid');
 const ids=new Set<string>(),inputs=new Set<string>(),parts=new Set<string>();for(const c of o.cases){
  if(!workObject(c,['id','partition','input','expected'])||!workId(c.id)||ids.has(c.id)||!['normal','heldout','negative'].includes(c.partition as string)||!workObject(c.input)||Object.keys(c.input).length>32||Object.entries(c.input).some(([k,v])=>!workId(k)||!(typeof v==='boolean'||typeof v==='string'&&v.length<=80||Number.isSafeInteger(v)))||!workObject(c.expected))workFail('oracle_invalid');
  if(c.expected.kind==='output'){if(!workObject(c.expected,['kind','value'])||!workObject(c.expected.value)||Object.keys(c.expected.value).length>32||Object.entries(c.expected.value).some(([k,v])=>!workId(k)||!(typeof v==='boolean'||typeof v==='string'&&v.length<=80||Number.isSafeInteger(v)))||c.partition==='negative')workFail('oracle_invalid')}
  else if(c.expected.kind!=='reject'||!workObject(c.expected,['kind','code'])||!['employee_agent_work_input_invalid','employee_agent_work_integer_overflow','employee_agent_work_inexact_conversion'].includes(c.expected.code as string)||c.partition!=='negative')workFail('oracle_invalid');
  const d=workDigest(c.input);if(inputs.has(d))workFail('oracle_duplicate_case');inputs.add(d);ids.add(c.id);parts.add(c.partition as string);
 }if(parts.size!==3)workFail('oracle_partitions_required');return o as unknown as WorkOracle;
}
/** Current implementation identity; never supplied by a caller. */
export function getWorkEvaluationIdentity(){return Object.freeze({version:WORK_EVALUATOR_VERSION,digest:createHash('sha256').update([WORK_EVALUATOR_VERSION,executeWorkProgram.toString(),validateWorkProgram.toString(),validateWorkOracle.toString(),valid.toString(),safe.toString()].join('\n')).digest('hex')})}
export function evaluateWorkPrograms(before:WorkProgram,after:WorkProgram,oracle:unknown,pins:{oracleAcceptanceId:string;proposalDigest:string;envelopeDigest:string}){
 const o=validateWorkOracle(oracle),run=(program:WorkProgram)=>o.cases.map(c=>{let actual:unknown;try{actual={kind:'output',value:executeWorkProgram(program,c.input)}}catch(e){actual={kind:'reject',code:e instanceof Error&&'code'in e?String(e.code):'executor_unknown'}}return{id:c.id,partition:c.partition,passed:workDigest(actual)===workDigest(c.expected),actualDigest:workDigest(actual)}});
 const a=run(before),b=run(after),counts=(rows:typeof a)=>({passed:rows.filter(x=>x.passed).length,total:rows.length,costMinor:0});
 const value={schema:'agentlas.business.work-evaluation.v1' as const,...workSnapshot(pins),evaluatorVersion:WORK_EVALUATOR_VERSION,evaluatorDigest:getWorkEvaluationIdentity().digest,
  fixtureDigest:workDigest(o),beforeProgramDigest:workDigest(validateWorkProgram(before)),afterProgramDigest:workDigest(validateWorkProgram(after)),
  before:counts(a),after:counts(b),heldoutPassed:b.filter(x=>x.partition==='heldout').every(x=>x.passed),negativePassed:b.filter(x=>x.partition==='negative').every(x=>x.passed),
  passed:b.every(x=>x.passed),isolated:true as const,networkAccess:false as const,providerCalls:0 as const,caseResults:{before:a,after:b}};
 return Object.freeze({...value,resultDigest:workDigest(value)});
}
