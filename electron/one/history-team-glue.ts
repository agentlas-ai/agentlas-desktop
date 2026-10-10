import type { PersonalDataTarget } from '../../shared/one-personal-data';
import { ONE_HISTORY_TOOLS } from '../../shared/one-history-tools';
import type { createHistoryNativeExecution } from './history-native-execution-glue';
import type { PersonalIntegrationMethod } from './personal-integrations-glue';
import { personalDataTarget, personalDataId, personalDataError } from './personal-data-store';
export interface NativeHistoryTeamCaller {chatId:string;runId:string}
export interface NativeHistoryTeamPorts {
  /** Existing native capability Map / original Supervisor native-origin WeakMap only.
   * A copied caller object must not resolve here. This rechecks current actor/owner/channel. */
  resolveCaller(capability:object):NativeHistoryTeamCaller;
  resolveTarget(capability:object,pageId:string):PersonalDataTarget;
  assertOwnerAction(capability:object,method:PersonalIntegrationMethod,target:PersonalDataTarget):void;
  execution:ReturnType<typeof createHistoryNativeExecution>;
  /** Same authenticated personal.command handler, with the original opaque capability.
   * Do not serialize a principal, actor, approval or grant into its JSON payload. */
  invokePersonalCommand(capability:object,method:PersonalIntegrationMethod,input:Record<string,unknown>):Promise<unknown>;
  /** Current native GUI owner review bridge into that SAME personal.command handler. */
  invokeNativeReview?:(capability:object,method:'historyAccept'|'historyAcceptFeedback',input:Record<string,unknown>)=>Promise<unknown>;
}
function fail(code:string):never{throw personalDataError(code);}
const methods:Record<string,PersonalIntegrationMethod>={one_history_candidates:'historySnapshot',one_history_observe:'historyObserve',one_history_draft:'historyDraft',one_history_collect_draft:'historyCollectDraft',one_history_evaluate:'historyEvaluate',one_history_native_review:'historyAccept',one_history_run:'historyRun',one_history_feedback:'historyProposeFeedback',one_history_feedback_review:'historyAcceptFeedback',one_history_control:'historyControl',one_history_restore:'historyRestore'};
const fields:Record<string,string>={candidate_id:'candidateId',expected_revision:'expectedRevision',predecessor_id:'predecessorId',command_id:'commandId',proposal_id:'proposalId',expected_page_revision:'expectedPageRevision',expected_control_version:'expectedControlVersion',version_id:'versionId',action:'action'};
/** Used by the existing One team dispatcher after its native capability lookup. */
export function createHistoryTeamDispatch(ports:NativeHistoryTeamPorts){return async(capability:object,name:string,value:unknown):Promise<unknown>=>{
  const caller=ports.resolveCaller(capability),tool=ONE_HISTORY_TOOLS.find(t=>t.name===name);if(!tool)fail('history_native_tool_unknown');
  if(!value||typeof value!=='object'||Array.isArray(value))fail('history_native_tool_input_invalid');const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!(key in tool.inputSchema.properties))||tool.inputSchema.required.some(key=>!(key in input)))fail('history_native_tool_input_invalid');
  for(const [key,v] of Object.entries(input)){if(key.includes('revision')){if(!Number.isSafeInteger(v)||(v as number)<1)fail('history_native_tool_input_invalid');}else personalDataId(v);}
  if(name==='one_history_source_read'){const token=ports.execution.assertRun(caller);if(!token)fail('history_native_original_command_required');return ports.execution.readBoundSource(token);}
  const method=methods[name],target=personalDataTarget(ports.resolveTarget(capability,input.page_id as string));
  if(target.pageId!==input.page_id)fail('history_native_target_mismatch');
  const payload:Record<string,unknown>={target};for(const [key,v] of Object.entries(input))if(key!=='page_id')payload[fields[key]]=v;
  if(method!=='historySnapshot')ports.assertOwnerAction(capability,method,target);
  if(method==='historyControl'&&!['pause','resume','revoke','delete'].includes(String(input.action)))fail('history_native_tool_input_invalid');
  let result:unknown;if(method==='historyAccept'||method==='historyAcceptFeedback'){if(!ports.invokeNativeReview)fail('history_native_native_review_bridge_required');result=await ports.invokeNativeReview(capability,method,payload);}
  else result=await ports.invokePersonalCommand(capability,method,payload);
  ports.resolveCaller(capability);return result;
};}
