import {createGoalWaitObservationData,goalWaitSubjectRef} from "./goal-wait-observation";
import {parseCanonicalGoalWaitRecord,validCanonicalGoalWaitRef,sameCanonicalGoalWaitRef,type CanonicalGoalWaitRecord} from "./canonical-wait-record";
import {normalizeGoalWaitTimer} from "./normalize-timer";
/** Adapter for canonical owners. The shared wait engine, not a domain scheduler,
 * owns transitions/claims/start ordering. The common run-event journal stores
 * scheduling facts; canonical research projections remain read-only. */
import {randomUUID,createHash} from "node:crypto";
import {getDb} from "../store/db";
import {recordRunEvent,canonicalGoalWaitSnapshot} from "../store/run-events";
import {desktopStoreTransaction} from "../store/change-bus";
import {readGoalWaitProposal} from "./goal-wait-proposal";
import {parseGoalWaitIntent,type GoalWaitIntent} from "./wait-emitter";
import {observeGoalWaitSubject,type GoalWaitObservation,type GoalWaitHostOwner} from "./wait-subscriptions";
import {claimWaitContinuation,dispatchWaitClaim,reconcileWaitClaim,sameWaitSnapshot,
  waitObservationReady,nextWaitObservationAt,type WaitEngineStorage} from "./wait-engine";
import type {CanonicalGoalWaitOwnerRef,CanonicalGoalWaitOwnerProvider,CanonicalGoalWaitIntake,
  CanonicalGoalWaitOwnerSnapshot,CanonicalGoalWaitPrepared} from "./canonical-owner-port";
export type CanonicalGoalWaitScope=Pick<CanonicalGoalWaitOwnerRef,"domain"|"projectId"|"conversationId"|"chatId">;
export const CANONICAL_GOAL_WAIT_KIND="goal_wait_subscription";
const canonical=(value:unknown)=>JSON.stringify(value);
/** One broken source must not starve unrelated owners on every timer tick.
 * Keep exact wait state intact and log only a bounded machine cause. */
function deferredCandidate(stage:"poll"|"reconcile"|"proposal",waitId:string,error:unknown):void {
  const typed=error && typeof error==="object" && "code" in error ? error.code : null;
  const raw=typeof typed==="string" ? typed : error instanceof Error ? error.message : null;
  const reasonCode=typeof raw==="string" && /^[a-z][a-z0-9_.:-]{0,119}$/.test(raw) ? raw : "goal_wait_candidate_unavailable";
  try {console.warn("[goal-wait] candidate deferred",JSON.stringify({stage,waitId:waitId.slice(0,128),reasonCode}));}catch{}
}

function latest(ref:Readonly<CanonicalGoalWaitOwnerRef>):CanonicalGoalWaitRecord|null {
  const row=getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind=? ORDER BY seq DESC LIMIT 1`)
    .get(ref.sourceInvocationId,ref.chatId,CANONICAL_GOAL_WAIT_KIND) as {payload_json:string}|undefined;
  if(!row) return null;
  let value:unknown;try {value=JSON.parse(row.payload_json).canonicalGoalWait;}catch {throw new Error("goal_wait_registration_invalid");}
  const wait=parseCanonicalGoalWaitRecord(value);
  if(!wait || !sameCanonicalGoalWaitRef(wait.ref,ref)) throw new Error("goal_wait_registration_invalid");
  return wait;
}
function persist(value:CanonicalGoalWaitRecord):void {
  const checked=canonicalGoalWaitSnapshot(value);if(!checked) throw new Error("goal_wait_registration_invalid");
  recordRunEvent({runId:value.ref.sourceInvocationId,chatId:value.ref.chatId,kind:CANONICAL_GOAL_WAIT_KIND,
    sourceEventId:`goal-wait:${value.waitId}:${value.revision}`,payload:{canonicalGoalWait:checked}});
  // Writer idempotence must return the actual exact persisted snapshot.
  const saved=latest(value.ref);
  if(canonical(saved)!==canonical(checked)) throw new Error("goal_wait_registration_conflict");
}
function snapshot(provider:CanonicalGoalWaitOwnerProvider,ref:Readonly<CanonicalGoalWaitOwnerRef>):CanonicalGoalWaitOwnerSnapshot {
  const source=provider.readOwner(ref);
  if(!source || !source.sourceSettled || !sameCanonicalGoalWaitRef(source.ref,ref)
    || !["source-settled","held"].includes(source.state) || ![source.ownerStamp,source.sourceStamp].every(v=>/^[a-f0-9]{64}$/.test(v)))
    throw new Error("goal_wait_canonical_owner_unavailable");
  return source;
}
/** Authority-free durable scheduling observation. This never grants preparation or start. */
export function readCanonicalGoalWaitObservation(ref:Readonly<CanonicalGoalWaitOwnerRef>, expected?:Readonly<{sourceStamp:string;currentStamp:string}>):ReturnType<CanonicalGoalWaitIntake["read"]> {
      if(!validCanonicalGoalWaitRef(ref)) return null;
      const wait=latest(ref);
      if(wait && expected && (wait.sourceStamp!==expected.sourceStamp || wait.currentStamp!==expected.currentStamp))return null;
      // Durable expiry remains historical; expose only the validated same-kernel advisory phase to existing domain guards.
      if(wait) return {waitId:wait.waitId,state:wait.state==="expired"&&wait.terminalContinuation?wait.terminalContinuation:wait.state,reservedRunId:wait.successorInvocationId};
      return readGoalWaitProposal(ref)?.status==="requested" ? {waitId:null,state:"proposed",reservedRunId:null}:null;
    }

/** No timer is installed. Existing Main/daemon poll/startup ingress calls these
 * adapters alongside its unchanged legacy owner adapter. */
export function createCanonicalGoalWaitOwner(provider:CanonicalGoalWaitOwnerProvider):CanonicalGoalWaitIntake & {
  poll(options:{now?:number;clock?:()=>number;owner:GoalWaitHostOwner}):Promise<void>;
  reconcile(owner:GoalWaitHostOwner):void;
  cancel(ref:Readonly<CanonicalGoalWaitOwnerRef>,reason?:string):void;
  cancelScope(scope:Readonly<CanonicalGoalWaitScope>,reason?:string):void;
} {
  const packets=new Map<string,CanonicalGoalWaitPrepared>();
  const storage=(ref:Readonly<CanonicalGoalWaitOwnerRef>,expectedOwner?:GoalWaitHostOwner):WaitEngineStorage<CanonicalGoalWaitRecord>=>({
    transaction:body=>desktopStoreTransaction(getDb(),body).immediate(),read:()=>latest(ref),persist,
    current:wait=>{try {
      if(expectedOwner)provider.assertCurrentOwner(expectedOwner);
      const source=snapshot(provider,ref);
      return (!expectedOwner || source.owner.kind===expectedOwner.kind&&source.owner.epoch===expectedOwner.epoch)
        && source.sourceStamp===wait.sourceStamp && (source.ownerStamp===wait.currentStamp
        || Boolean(wait.successorInvocationId && source.preparedRunId===wait.successorInvocationId));
    }catch{return false;}},
    receiptCurrent:wait=>Boolean(wait.successorInvocationId && provider.continuationReceipt({ref,waitId:wait.waitId,
      reservedRunId:wait.successorInvocationId})?.runId===wait.successorInvocationId),
  });
  // A terminal wait and an advisory continuation are separate facts in ONE journal.
  // Project only the advisory phase into the shared CAS kernel; condition is never ready.
  const expiredStorage=(ref:Readonly<CanonicalGoalWaitOwnerRef>,owner:GoalWaitHostOwner):WaitEngineStorage<CanonicalGoalWaitRecord>=>{
    const base=storage(ref,owner);
    return {...base,read:()=>{const actual=base.read();return actual?.state==="expired"
      ? {...actual,state:actual.terminalContinuation??"pending"}:null;},
      persist:value=>{if(!["pending","claimed","dispatched"].includes(value.state))throw new Error("goal_wait_terminal_phase_invalid");
        base.persist({...value,state:"expired",terminalContinuation:value.state as "pending"|"claimed"|"dispatched"});}};
  };
  const candidates=():CanonicalGoalWaitRecord[]=>{
    const rows=getDb().prepare(`SELECT e.payload_json FROM run_events e WHERE e.kind=? AND e.seq=(
      SELECT MAX(s.seq) FROM run_events s WHERE s.kind=e.kind AND s.run_id=e.run_id AND s.chat_id=e.chat_id) ORDER BY e.seq`)
      .all(CANONICAL_GOAL_WAIT_KIND) as Array<{payload_json:string}>;
    return rows.map(row=>{let value:unknown;try {value=JSON.parse(row.payload_json).canonicalGoalWait;}catch{return null;}
      return parseCanonicalGoalWaitRecord(value);}).filter((v):v is CanonicalGoalWaitRecord=>v!==null);
  };
  const api:ReturnType<typeof createCanonicalGoalWaitOwner>={
    read(ref) { return readCanonicalGoalWaitObservation(ref); },
    hold({ref,proposal}) {
      try {
        if(!validCanonicalGoalWaitRef(ref)) throw new Error("goal_wait_scope_invalid");
        const durable=readGoalWaitProposal(ref);
        if(!durable || durable.status!=="requested" || (proposal && canonical(proposal)!==canonical(durable))) throw new Error("goal_wait_proposal_missing");
        const result=desktopStoreTransaction(getDb(),()=>{
          const prior=latest(ref);if(prior) {if(prior.state==="blocked"&&["goal_wait_timer_invalid","goal_wait_deadline_elapsed"].includes(prior.wakeReason??""))return prior;if(!["pending","claimed"].includes(prior.state))throw new Error("goal_wait_already_closed");return prior;}
          const source=snapshot(provider,ref),now=Date.now();
          provider.assertCurrentOwner(source.owner);
          let intent=durable.intent;
          try {
            if(intent.deadline && Date.parse(intent.deadline)<=now) throw new Error("goal_wait_deadline_elapsed");
            intent=normalizeGoalWaitTimer(intent,source.timerAuthority,now);
          } catch(error) {
            const reason=error instanceof Error?error.message:null;
            // Only deterministic proposal validation failures retire this exact
            // source. Unknown currentness/authority failures remain retryable.
            if(reason!=="goal_wait_timer_invalid"&&reason!=="goal_wait_deadline_elapsed")throw error;
            const refused:CanonicalGoalWaitRecord={schemaVersion:"agentlas.canonical-goal-wait.v1",ref:{...ref},waitId:randomUUID(),revision:1,
              intent,sourceStamp:source.sourceStamp,currentStamp:source.ownerStamp,state:"blocked",cursor:null,
              lastObservedDigest:createHash("sha256").update(canonical({reason,intent})).digest("hex"),intervalMs:30_000,
              deadline:intent.deadline,nextCheckAt:null,wakeReason:reason,successorInvocationId:null,readyObservation:null,
              registrationOwner:{...source.owner}};
            persist(refused);
            recordRunEvent({runId:ref.sourceInvocationId,chatId:ref.chatId,kind:"goal_wait_refused",
              sourceEventId:`canonical-goal-wait-refused:${ref.sourceInvocationId}`,
              payload:{reasonCode:reason,disposition:"canonical_wait_blocked",waitId:refused.waitId}});
            return refused;
          }
          const observation=observeGoalWaitSubject({chatId:ref.chatId,sourceInvocationId:ref.sourceInvocationId,intent},now,{authorizeInvocation:subject=>provider.authorizeInvocationSubject(source.sourceToken,subject)});
          const wait:CanonicalGoalWaitRecord={schemaVersion:"agentlas.canonical-goal-wait.v1",ref:{...ref},waitId:randomUUID(),revision:1,
            intent,sourceStamp:source.sourceStamp,currentStamp:source.ownerStamp,state:"pending",cursor:observation.cursor,
            lastObservedDigest:observation.digest,intervalMs:30_000,deadline:intent.deadline,
            nextCheckAt:intent.subject.kind==="timer"?intent.subject.notBefore:new Date(now+30_000).toISOString(),
            wakeReason:null,successorInvocationId:null,readyObservation:null,registrationOwner:{...source.owner}};
          persist(wait);
          provider.holdCurrentSource({sourceToken:source.sourceToken,waitId:wait.waitId,intent});
          return wait;
        }).immediate();
        if(result.state==="blocked")return {status:"refused",code:result.wakeReason!};
        return {status:"registered",waitId:result.waitId,nextCheckAt:result.nextCheckAt};
      } catch(error) {return {status:"refused",code:error instanceof Error?error.message:"goal_wait_unavailable"};}
    },
    async poll(options) {
      try{provider.assertCurrentOwner(options.owner);}catch{return;}
      api.reconcile(options.owner);
      const clock=options.clock??(()=>options.now??Date.now());
      for(const expected of candidates()) {
        try {
        if(expected.registrationOwner.kind!==options.owner.kind || expected.registrationOwner.epoch!==options.owner.epoch)continue;
        if(expected.state==="expired") {
          const adapter=expiredStorage(expected.ref,options.owner),current=adapter.read();
          if(!current || current.state!=="pending" || (current.nextCheckAt && Date.parse(current.nextCheckAt)>clock()))continue;
          let source:CanonicalGoalWaitOwnerSnapshot;
          try{source=snapshot(provider,expected.ref);if(!adapter.current(current))continue;}catch{continue;}
          const observation:GoalWaitObservation={cursor:expected.cursor,digest:expected.lastObservedDigest,
            terminal:false,reason:"goal_wait_deadline"};
          let packet:CanonicalGoalWaitPrepared|null=null;
          const reserved=claimWaitContinuation(adapter,current,live=>{
            packet=packets.get(live.successorInvocationId!)??provider.prepareContinuation({sourceToken:source.sourceToken,
              waitId:live.waitId,reservedRunId:live.successorInvocationId!,expectedOwnerStamp:live.currentStamp,intent:live.intent,
              observation,observationData:createGoalWaitObservationData({waitId:live.waitId,subjectRef:goalWaitSubjectRef(live.intent),
                cursor:live.cursor,lastObservedDigest:live.lastObservedDigest,observation,reason:"goal_wait_deadline",nextAction:live.intent.nextAction})});
            packets.set(live.successorInvocationId!,packet);
            const prepared=snapshot(provider,live.ref);
            return {next:{...live,revision:live.revision+1,state:"claimed",currentStamp:prepared.ownerStamp,
              dispatchOwner:prepared.owner,nextCheckAt:null},dispatch:live.successorInvocationId!};
          },{reserve:live=>({...live,revision:live.revision+1,successorInvocationId:randomUUID()})});
          if(!reserved||!packet)continue;const claim=adapter.read();if(!claim)continue;
          dispatchWaitClaim({storage:adapter,expected:claim,owner:source.owner,
            assertStart:live=>{if(!adapter.current(live))throw new Error("goal_wait_owner_changed");},
            start:()=>provider.admitAndStart(packet!),onStarted:()=>{},failureState:"claimed",failureReason:"goal_wait_dispatch_unknown"});
          continue;
        }
        if(expected.state!=="pending" || (expected.nextCheckAt && Date.parse(expected.nextCheckAt)>clock()
          && !(expected.deadline && Date.parse(expected.deadline)<=clock()))) continue;
        const adapter=storage(expected.ref,options.owner);
        let source:CanonicalGoalWaitOwnerSnapshot;
        try {source=snapshot(provider,expected.ref);
          if(source.owner.kind!==options.owner.kind || source.owner.epoch!==options.owner.epoch)continue;
        }catch {continue;}
        if(expected.deadline && Date.parse(expected.deadline)<=clock()) {
          adapter.transaction(()=>{const live=adapter.read();if(!sameWaitSnapshot(live,expected))return;
            adapter.persist({...live!,revision:live!.revision+1,state:"expired",wakeReason:"goal_wait_deadline",nextCheckAt:null});});
          provider.releaseHold({ref:expected.ref,waitId:expected.waitId,reason:"goal_wait_deadline"});continue;
        }
        let observation:GoalWaitObservation;
        try {observation=observeGoalWaitSubject({chatId:expected.ref.chatId,sourceInvocationId:expected.ref.sourceInvocationId,intent:expected.intent},clock(),{authorizeInvocation:subject=>provider.authorizeInvocationSubject(source.sourceToken,subject)});}
        catch {continue;}
        let packet:CanonicalGoalWaitPrepared|null=null;
        const ready=Boolean(expected.successorInvocationId && expected.readyObservation)||waitObservationReady(expected,observation);
        if(!ready) {
          adapter.transaction(()=>{const live=adapter.read();if(!sameWaitSnapshot(live,expected)||!adapter.current(live!))return;
            adapter.persist({...live!,revision:live!.revision+1,cursor:observation.cursor,lastObservedDigest:observation.digest,
              ...nextWaitObservationAt(live!.intervalMs,clock())});});continue;
        }
        const reserved=claimWaitContinuation(adapter,expected,current=>{
          if(current.deadline && Date.parse(current.deadline)<=clock()) throw new Error("goal_wait_deadline_elapsed");
          const reservedRunId=current.successorInvocationId!;
          const readyObservation=current.readyObservation!;
          packet=packets.get(reservedRunId)??provider.prepareContinuation({sourceToken:source.sourceToken,waitId:current.waitId,
            reservedRunId,expectedOwnerStamp:current.currentStamp,intent:current.intent,observation:readyObservation,
            observationData:createGoalWaitObservationData({waitId:current.waitId,subjectRef:goalWaitSubjectRef(current.intent),
              cursor:current.cursor,lastObservedDigest:current.lastObservedDigest,observation:readyObservation,
              reason:readyObservation.reason??"goal_wait_satisfied",nextAction:current.intent.nextAction})});
          packets.set(reservedRunId,packet);
          const preparedSource=snapshot(provider,current.ref);
          return {next:{...current,revision:current.revision+1,state:"claimed",nextCheckAt:null,
            currentStamp:preparedSource.ownerStamp,
            successorInvocationId:reservedRunId,dispatchOwner:preparedSource.owner,wakeReason:readyObservation.reason??"goal_wait_satisfied"},dispatch:reservedRunId};
        },{reserve:current=>({...current,revision:current.revision+1,successorInvocationId:randomUUID(),readyObservation:observation})});
        if(!reserved || !packet) continue;
        const claim=adapter.read();if(!claim) continue;
        dispatchWaitClaim({storage:adapter,expected:claim,owner:source.owner,
          assertStart:current=>{if(!adapter.current(current))throw new Error("goal_wait_owner_changed");},
          start:()=>provider.admitAndStart(packet!),onStarted:()=>{},failureState:"claimed",failureReason:"goal_wait_dispatch_unknown"});
        }catch(error){deferredCandidate("poll",expected.waitId,error);}
      }
    },
    reconcile(owner) {
      provider.assertCurrentOwner(owner);
      // A durable proposal can precede SDK source settlement/registration. Reuse
      // the exact same hold path after the adapter proves the canonical source.
      const proposals=getDb().prepare(`SELECT e.run_id,e.chat_id FROM run_events e WHERE e.kind='goal_wait_proposed'
        AND e.seq=(SELECT MAX(s.seq) FROM run_events s WHERE s.kind=e.kind AND s.run_id=e.run_id AND s.chat_id=e.chat_id) ORDER BY e.seq`)
        .all() as Array<{run_id:string;chat_id:string|null}>;
      for(const proposal of proposals) {
        try {
        if(!proposal.chat_id)continue;
        const ref=provider.resolveSource({chatId:proposal.chat_id,sourceInvocationId:proposal.run_id});
        if(!ref || ref.chatId!==proposal.chat_id || ref.sourceInvocationId!==proposal.run_id)continue;
        const source=provider.readOwner(ref);
        if(!source || source.owner.kind!==owner.kind || source.owner.epoch!==owner.epoch)continue;
        if(!latest(ref))api.hold({ref});
        }catch(error){deferredCandidate("proposal",proposal.run_id,error);}
      }
      for(const expected of candidates()) {
        try {
        const adapter=expected.state==="expired"?expiredStorage(expected.ref,owner):storage(expected.ref,owner);
        if(expected.state==="expired") {
          if(expected.registrationOwner.kind!==owner.kind)continue;
          const live=adapter.read();if(!live)continue;
          if(live.state==="pending") {
            try{const source=snapshot(provider,expected.ref);if(adapter.current(live) && expected.registrationOwner.epoch!==owner.epoch)
              adapter.transaction(()=>{const current=adapter.read();if(sameWaitSnapshot(current,live)&&adapter.current(current!))
                adapter.persist({...current!,revision:current!.revision+1,registrationOwner:{...owner}});});}catch{}
          } else if(live.state==="claimed") {
            reconcileWaitClaim({storage:adapter,expected:live,resolve:current=>{
              const receipt=current.successorInvocationId?provider.continuationReceipt({ref:current.ref,waitId:current.waitId,reservedRunId:current.successorInvocationId}):null;
              if(!receipt)return current.wakeReason==="goal_wait_dispatch_unknown"?null:{next:{...current,revision:current.revision+1,wakeReason:"goal_wait_dispatch_unknown"}};
              if(receipt.runId!==current.successorInvocationId)throw new Error("goal_wait_receipt_identity_mismatch");
              return {next:{...current,revision:current.revision+1,state:"dispatched",wakeReason:"goal_wait_exact_successor_receipt",nextCheckAt:null}};
            }});
          }
          continue;
        }
        if(expected.state==="pending") {
          if(expected.registrationOwner.kind!==owner.kind)continue;
          try {const source=snapshot(provider,expected.ref);
            if(expected.registrationOwner.epoch!==owner.epoch && adapter.current(expected)) {
              adapter.transaction(()=>{
                const live=adapter.read();if(!sameWaitSnapshot(live,expected)||!adapter.current(live!))return;
                adapter.persist({...live!,revision:live!.revision+1,registrationOwner:{...owner}});
              });
            }
            if(adapter.current(expected)) provider.holdCurrentSource({sourceToken:source.sourceToken,waitId:expected.waitId,intent:expected.intent});
          }catch { /* No current authority, no restore. */ }continue;
        }
        if(expected.state!=="claimed") continue;
        reconcileWaitClaim({storage:adapter,expected,resolve:current=>{
          const receipt=current.successorInvocationId?provider.continuationReceipt({ref:current.ref,waitId:current.waitId,reservedRunId:current.successorInvocationId}):null;
          if(!receipt) return current.wakeReason==="goal_wait_dispatch_unknown"?null:{next:{...current,revision:current.revision+1,wakeReason:"goal_wait_dispatch_unknown",nextCheckAt:null}};
          if(receipt.runId!==current.successorInvocationId) throw new Error("goal_wait_receipt_identity_mismatch");
          return {next:{...current,revision:current.revision+1,state:"dispatched",wakeReason:"goal_wait_exact_successor_receipt",nextCheckAt:null}};
        }});
        }catch(error){deferredCandidate("reconcile",expected.waitId,error);}
      }
    },
    cancelScope(scope,reason="goal_wait_owner_control") {
      for(const wait of candidates())if(["domain","projectId","conversationId","chatId"].every(key=>
        wait.ref[key as keyof CanonicalGoalWaitScope]===scope[key as keyof CanonicalGoalWaitScope]))api.cancel(wait.ref,reason);
    },
    cancel(ref,reason="goal_wait_cancelled") {
      // Stop remains unconditional in the domain. Scheduling cancellation is a
      // best-effort consequence and can never gate the physical Stop action.
      const adapter=storage(ref);
      let cancelled:CanonicalGoalWaitRecord|null=null;
      try {cancelled=adapter.transaction(()=>{
        const wait=adapter.read();if(!wait || !(["pending","claimed"].includes(wait.state)||wait.state==="expired"&&wait.terminalContinuation!=="dispatched"))return null;
        const {terminalContinuation:_expiredPhase,...prior}=wait;
        const next:CanonicalGoalWaitRecord={...prior,revision:wait.revision+1,state:"cancelled",wakeReason:reason,nextCheckAt:null};
        adapter.persist(next);return next;
      });}catch{return;}
      // At most one successful transition notifies the domain, and notification
      // errors never replace the caller's unconditional Stop/cancel result.
      if(cancelled)try{provider.releaseHold({ref,waitId:cancelled.waitId,reason});}catch{}

    },
  };
  return api;
}

let installed:ReturnType<typeof createCanonicalGoalWaitOwner>|null=null;
/** Composition-only installation. Main and daemon each install their exact
 * canonical provider under their existing exclusive owner lifecycle. */
export function setCanonicalGoalWaitOwnerProvider(provider:CanonicalGoalWaitOwnerProvider|null):ReturnType<typeof createCanonicalGoalWaitOwner>|null {
  installed=provider?createCanonicalGoalWaitOwner(provider):null;return installed;
}
export function readCanonicalGoalWait(ref:Readonly<CanonicalGoalWaitOwnerRef>):ReturnType<CanonicalGoalWaitIntake["read"]> {
  return installed?.read(ref)??null;
}
export function holdCanonicalGoalWait(input:Parameters<CanonicalGoalWaitIntake["hold"]>[0]):ReturnType<CanonicalGoalWaitIntake["hold"]> {
  return installed?.hold(input)??{status:"refused",code:"goal_wait_owner_unavailable"};
}
export function cancelCanonicalGoalWaitScope(scope:Readonly<CanonicalGoalWaitScope>,reason?:string):void {installed?.cancelScope(scope,reason);}
export function cancelCanonicalGoalWait(ref:Readonly<CanonicalGoalWaitOwnerRef>,reason?:string):void {installed?.cancel(ref,reason);}
export function reconcileCanonicalGoalWaits(owner:GoalWaitHostOwner):{ok:true}|{ok:false;code:"goal_wait_reconcile_unavailable"} {
  try{installed?.reconcile(owner);return {ok:true};}catch{return {ok:false,code:"goal_wait_reconcile_unavailable"};}
}
export async function pollCanonicalGoalWaits(options:{now?:number;clock?:()=>number;owner:GoalWaitHostOwner}):Promise<{ok:true}|{ok:false;code:"goal_wait_poll_unavailable"}> {
  try{await installed?.poll(options);return {ok:true};}catch{return {ok:false,code:"goal_wait_poll_unavailable"};}
}
