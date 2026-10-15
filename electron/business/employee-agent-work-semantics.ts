import { createHash } from 'node:crypto';
import { EMPLOYEE_AGENT_WORK_SCHEMA, workArray, workObject, workId, workSnapshot, workFail, type WorkField, type WorkProgram } from '../../shared/business/employee-agent-work';
import { employeeAgentChangeCanonical } from '../../shared/business/employee-agent-change';
export const workDigest = (v: unknown): string => createHash('sha256').update(employeeAgentChangeCanonical(v)).digest('hex');
const PREFIX = '# Agentlas declarative WORK\n\n```agentlas-work-v1\n', SUFFIX = '\n```\n';
export function validateWorkProgram(input: unknown): WorkProgram {
  const p = workSnapshot(input);
  if (!workObject(p, ['schema','inputs','outputs','nodes','capabilities']) || p.schema !== EMPLOYEE_AGENT_WORK_SCHEMA
    || !workArray(p.inputs,32) || !p.inputs.length || !workArray(p.outputs,32) || !p.outputs.length || !workArray(p.nodes,64)
    || !workObject(p.capabilities,['network','filesystem','providers','tools','sources','environment'])
    || p.capabilities.network !== false || p.capabilities.filesystem !== false || p.capabilities.providers !== false
    || ['tools','sources','environment'].some(k => !workArray((p.capabilities as Record<string,unknown>)[k],0))) workFail('semantics_unsupported');
  const refs = new Map<string,WorkField>();
  const field = (v: unknown, output = false): WorkField => {
    if (!workObject(v,output ? ['id','type','values','from'] : ['id','type','values']) || !workId(v.id)
      || !['integer','boolean','enum'].includes(v.type as string) || !workArray(v.values,32)
      || (v.type === 'enum' ? !v.values.length || v.values.some(x => !workId(x)) || new Set(v.values).size !== v.values.length : v.values.length !== 0)) workFail('field_invalid');
    return v as unknown as WorkField;
  };
  for (const v of p.inputs) { const f = field(v); if(refs.has(f.id)) workFail('duplicate_field'); refs.set(f.id,f); }
  const get = (id: unknown): WorkField => { if (!workId(id) || !refs.has(id)) workFail('reference_invalid'); return refs.get(id)!; };
  for (const raw of p.nodes) {
    if (!workObject(raw) || !workId(raw.id) || refs.has(raw.id)) workFail('node_invalid');
    let f: WorkField;
    switch (raw.op) {
      case 'copy': if(!workObject(raw,['id','op','from']))workFail('node_invalid'); f=get(raw.from); break;
      case 'scale': if(!workObject(raw,['id','op','from','numerator','denominator','rounding'])
        || !Number.isSafeInteger(raw.numerator) || !Number.isSafeInteger(raw.denominator) || (raw.denominator as number)<=0
        || !['exact','half-even'].includes(raw.rounding as string))workFail('node_invalid');
        f=get(raw.from); if(f.type!=='integer')workFail('type_invalid'); break;
      case 'add': case 'equal': if(!workObject(raw,['id','op','left','right']))workFail('node_invalid');
        f=get(raw.left); const b=get(raw.right); if(f.type!==b.type || workDigest(f.values)!==workDigest(b.values) || raw.op==='add'&&f.type!=='integer')workFail('type_invalid');
        if(raw.op==='equal')f={id:raw.id,type:'boolean',values:[]}; break;
      case 'choose': if(!workObject(raw,['id','op','condition','yes','no']) || get(raw.condition).type!=='boolean')workFail('node_invalid');
        f=get(raw.yes);const z=get(raw.no);if(f.type!==z.type||workDigest(f.values)!==workDigest(z.values))workFail('type_invalid');break;
      default:return workFail('semantics_unsupported');
    }
    refs.set(raw.id,{...f,id:raw.id});
  }
  const names=new Set<string>(); for(const raw of p.outputs){const f=field(raw,true),s=get((raw as unknown as {from:string}).from);
    if(names.has(f.id)||f.type!==s.type||workDigest(f.values)!==workDigest(s.values))workFail('output_invalid');names.add(f.id);}
  return p as unknown as WorkProgram;
}
export function renderWorkProgram(input: unknown): string { return PREFIX + employeeAgentChangeCanonical(validateWorkProgram(input)) + SUFFIX; }
export function parseWorkProgram(text: string): WorkProgram {
  if(typeof text!=='string'||text.length>200000||!text.startsWith(PREFIX)||!text.endsWith(SUFFIX))workFail('semantics_unsupported');
  let raw:unknown;try{raw=JSON.parse(text.slice(PREFIX.length,-SUFFIX.length))}catch{return workFail('semantics_unsupported')}
  const p=validateWorkProgram(raw);if(renderWorkProgram(p)!==text)workFail('declaration_not_canonical');return p;
}
export function produceWorkSemantics(beforeText:string,afterText:string,pins:{proposalId:string;proposalDigest:string;requestDigest:string;bindingDigest:string}){
  const before=parseWorkProgram(beforeText),after=parseWorkProgram(afterText);
  const result={schema:'agentlas.business.work-semantics.v1' as const,...workSnapshot(pins),beforeDigest:workDigest(before),afterDigest:workDigest(after),
    before,after,capabilityChanges:workDigest(before.capabilities)===workDigest(after.capabilities)?[]:['capabilities'],
    changedSections:(['inputs','outputs','nodes','capabilities'] as const).filter(k=>workDigest(before[k])!==workDigest(after[k]))};
  return Object.freeze({...result,semanticDigest:workDigest(result)});
}
