import type {CanonicalGoalWaitOwnerRef} from "./canonical-owner-port";
import {parseGoalWaitIntent,type GoalWaitIntent} from "./wait-emitter";
import type {GoalWaitObservation} from "./wait-subscriptions";
export interface CanonicalGoalWaitRecord {
  schemaVersion:"agentlas.canonical-goal-wait.v1";
  ref:Readonly<CanonicalGoalWaitOwnerRef>;waitId:string;revision:number;
  intent:GoalWaitIntent;sourceStamp:string;currentStamp:string;
  state:"pending"|"claimed"|"dispatched"|"blocked"|"expired"|"cancelled";
  cursor:string|null;lastObservedDigest:string;intervalMs:number;
  /** Only the wait intent deadline; resource budget remains domain authority. */
  deadline:string|null;
  nextCheckAt:string|null;wakeReason:string|null;successorInvocationId:string|null;
  registrationOwner:{kind:"desktop"|"daemon";epoch:string};
  /** Independent advisory phase; the wait remains expired, never satisfied. */
  terminalContinuation?:"pending"|"claimed"|"dispatched";
  readyObservation:GoalWaitObservation|null;
  dispatchOwner?:{kind:"desktop"|"daemon";epoch:string};
}
const canonical=(value:unknown)=>JSON.stringify(value);
const refFields=["domain","projectId","conversationId","loopSessionId","chatId","sourceTurnId","sourceInvocationId"];
export const sameCanonicalGoalWaitRef=(a:CanonicalGoalWaitOwnerRef,b:CanonicalGoalWaitOwnerRef)=>refFields.every(k=>a[k as keyof typeof a]===b[k as keyof typeof b]);
export function validCanonicalGoalWaitRef(value:unknown):value is CanonicalGoalWaitOwnerRef {
  if(!value || typeof value!=="object" || Array.isArray(value)) return false;
  const ref=value as Record<string,unknown>;
  return ref.domain==="science" && Object.keys(ref).length===refFields.length
    && refFields.slice(1).every(k=>typeof ref[k]==="string" && (ref[k] as string).length>0
      && (ref[k] as string).length<=512 && (ref[k] as string).trim()===ref[k]);
}
/** Closed journal parser. Ordinary nested diagnostic payload limits stay intact. */
export function parseCanonicalGoalWaitRecord(value:unknown):CanonicalGoalWaitRecord|null {
  if(!value || typeof value!=="object" || Array.isArray(value)) return null;
  const v=value as CanonicalGoalWaitRecord;
  const fields=["schemaVersion","ref","waitId","revision","intent","sourceStamp","currentStamp","state","cursor","lastObservedDigest","intervalMs","deadline","nextCheckAt","wakeReason","successorInvocationId","dispatchOwner","readyObservation","registrationOwner","terminalContinuation"];
  if(Object.keys(v).some(k=>!fields.includes(k)) || v.schemaVersion!=="agentlas.canonical-goal-wait.v1"
    || !validCanonicalGoalWaitRef(v.ref) || typeof v.waitId!=="string" || !v.waitId || v.waitId.length>128
    || !Number.isSafeInteger(v.revision) || v.revision<1
    || !["pending","claimed","dispatched","blocked","expired","cancelled"].includes(v.state)
    || ![v.sourceStamp,v.currentStamp,v.lastObservedDigest].every(s=>typeof s==="string" && /^[a-f0-9]{64}$/.test(s))
    || !Number.isSafeInteger(v.intervalMs) || v.intervalMs<1 || v.intervalMs>300_000
    || ![v.deadline,v.nextCheckAt].every(s=>s===null || typeof s==="string" && Number.isFinite(Date.parse(s)))
    || ![v.cursor,v.wakeReason,v.successorInvocationId].every(s=>s===null || typeof s==="string" && s.length<=2048)
    || !v.registrationOwner || !["desktop","daemon"].includes(v.registrationOwner.kind)
    || Object.keys(v.registrationOwner).length!==2 || typeof v.registrationOwner.epoch!=="string"
    || !v.registrationOwner.epoch || v.registrationOwner.epoch.length>128
    || (v.readyObservation!==null && (!v.readyObservation || typeof v.readyObservation!=="object"
      || Object.keys(v.readyObservation).some(k=>!["digest","cursor","terminal","reason","summary"].includes(k))
      || typeof v.readyObservation.digest!=="string" || !/^[a-f0-9]{64}$/.test(v.readyObservation.digest)
      || typeof v.readyObservation.terminal!=="boolean"
      || ![v.readyObservation.cursor,v.readyObservation.reason].every(s=>s===null || typeof s==="string" && s.length<=2048)
      || (v.readyObservation.summary!==undefined && (typeof v.readyObservation.summary!=="string" || v.readyObservation.summary.length>1200))))
    || (v.dispatchOwner!==undefined && (!v.dispatchOwner || !["desktop","daemon"].includes(v.dispatchOwner.kind)
      || Object.keys(v.dispatchOwner).length!==2 || typeof v.dispatchOwner.epoch!=="string" || !v.dispatchOwner.epoch || v.dispatchOwner.epoch.length>128))) return null;
  if(v.terminalContinuation!==undefined && (v.state!=="expired" || !["pending","claimed","dispatched"].includes(v.terminalContinuation)
    || (["claimed","dispatched"].includes(v.terminalContinuation) && (!v.successorInvocationId || !v.dispatchOwner))))return null;
  const parsed=parseGoalWaitIntent("```agentlas-goal-wait\n"+JSON.stringify(v.intent)+"\n```").request;
  if(parsed?.status!=="requested" || canonical(parsed.intent)!==canonical(v.intent)) return null;
  if(["claimed","dispatched"].includes(v.state) && (!v.successorInvocationId || !v.dispatchOwner)) return null;
  return JSON.parse(JSON.stringify(v));
}
