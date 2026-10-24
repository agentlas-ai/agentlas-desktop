import type { AskUserRequestEvent } from "../../shared/types";
import { listPendingAskUserRequests, submitAskUserAnswer, mergePendingAskUserRequests, relayAskUserObservation } from "./ask-user";
import { callOneSupervisorRuntime, oneSupervisorNativeRuntime, supervisorRuntimeMode } from "../one/supervisor-native-runtime";

/** Both trusted Desktop and paired Mobile use the existing authenticated
 * native questions operations. A missing remote source never changes custody
 * of a question already selected from the local broker. */
export async function listRuntimeAskUserRequests(): Promise<AskUserRequestEvent[]> {
  const local=listPendingAskUserRequests(), mode=supervisorRuntimeMode();
  if(mode==="handoff")throw new Error("supervisor_runtime_handoff");
  if(mode!=="daemon"&&!oneSupervisorNativeRuntime()?.getChannel())return local;
  const remote:unknown=await callOneSupervisorRuntime("questions.list");
  if(!Array.isArray(remote))throw new Error("supervisor_runtime_question_projection_invalid");
  return mergePendingAskUserRequests(local,remote as AskUserRequestEvent[]);
}
export async function submitRuntimeAskUserAnswer(requestId:string,answer:string|null):Promise<boolean> {
  if(listPendingAskUserRequests().some(question=>question.requestId===requestId))return submitAskUserAnswer(requestId,answer);
  const mode=supervisorRuntimeMode();
  if(mode==="handoff")throw new Error("supervisor_runtime_handoff");
  if(mode!=="daemon"&&!oneSupervisorNativeRuntime()?.getChannel())return false;
  return await callOneSupervisorRuntime("questions.answer",{requestId,answer})===true;
}

const observed=new Map<string,AskUserRequestEvent>();let observationRevision=0;
/** Existing authenticated native activity snapshots invalidate the remote
 * question projection too. Replies still go to the original runtime broker. */
export async function refreshRuntimeAskUserObservations():Promise<void> {
  const revision=++observationRevision;
  const local=new Set(listPendingAskUserRequests().map(row=>row.requestId));
  const remote=(await listRuntimeAskUserRequests()).filter(row=>!local.has(row.requestId)&&row.expiresAt>Date.now());
  if(revision!==observationRevision)return;
  const ids=new Set(remote.map(row=>row.requestId));
  for(const [id,row]of observed)if(!ids.has(id)){observed.delete(id);relayAskUserObservation({...row,expiresAt:0});}
  for(const row of remote){const prior=observed.get(row.requestId);if(prior){mergePendingAskUserRequests([prior],[row]);continue;}
    observed.set(row.requestId,row);relayAskUserObservation(row);}
}
