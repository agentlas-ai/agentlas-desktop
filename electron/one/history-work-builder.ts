import {createHash} from 'node:crypto';
import {parseWorkProgram,renderWorkProgram,validateWorkProgram} from '../business/employee-agent-work-semantics';
import {personalDataError,personalDataHash} from './personal-data-store';
import type {HistoryEvolutionCandidate,HistoryEvolutionDraft} from '../../shared/one-history-evolution';
/** Pure compilation of explicit tool data. Never interprets an observation as code. */
export function compileHistoryWorkDraft(input:unknown,original:{candidate:HistoryEvolutionCandidate;assetId:string;baseContent:string;proposalId:string;proposalDigest:string;toolRef:string;resourceRef:string}){
 if(!input||typeof input!=='object'||Reflect.ownKeys(input).length!==1||!Object.getOwnPropertyDescriptor(input,'program')||!('value'in Object.getOwnPropertyDescriptor(input,'program')!))throw personalDataError('history_work_program_required');
 const program=validateWorkProgram((input as {program:unknown}).program),content=renderWorkProgram(program),before=parseWorkProgram(original.baseContent),c=original.candidate;
 if(!c.observations.length||personalDataHash(before)===personalDataHash(program))throw personalDataError('history_work_no_change');
 const digest=createHash('sha256').update(content).digest('hex');
 const draft:HistoryEvolutionDraft={kind:'agent',assetId:original.assetId,versionId:original.proposalId,digest,producer:'agent-workspace',proposalRef:original.proposalId,changeRefs:['agent.md'],toolRefs:[original.toolRef],resourceRefs:[original.resourceRef],process:{schema:'agentlas.process-binding.v1',environmentRevision:c.observations[0].environmentRevision,interface:c.observations[0].interface,preconditions:['Current registered canonical file and separately reviewed oracle'],inputs:program.inputs.map(x=>x.id),outputs:program.outputs.map(x=>x.id),manualJudgments:['Employee review of exact file change'],checks:['Independent normal, heldout and negative oracle cases'],toolRefs:[original.toolRef],resourceRefs:[original.resourceRef],sourceRevisions:c.observations.map(o=>({sourceRef:o.sourceRef,revision:o.revision}))}};
 return {content,draft,before,after:program,proposalDigest:original.proposalDigest};
}
