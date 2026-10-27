/** Shared wait transition kernel. No scheduler, domain projection or provider.
 * The legacy and canonical owner adapters supply actual storage/authority and
 * continuation preparation. Only this kernel owns CAS/claim/start ordering. */
export interface WaitEngineRecord {
  waitId:string; revision:number;
  state:"pending"|"claimed"|"dispatched"|"blocked"|"expired"|"cancelled";
  nextCheckAt:string|null; wakeReason:string|null;
  successorInvocationId:string|null;
  dispatchOwner?:{kind:"desktop"|"daemon";epoch:string};
}
export interface WaitEngineStorage<W extends WaitEngineRecord> {
  /** Production adapter invokes the same Desktop SQLite immediate transaction. */
  transaction<T>(body:()=>T):T;
  read():W|null;
  persist(value:W):void;
  /** Actual owner/domain state, evaluated inside the transaction. */
  current(value:W):boolean;
  /** Exact accepted successor receipts may be recorded after Stop/control moved.
   * This never authorizes a start; adapters still enforce immutable owner/scope. */
  receiptCurrent?(value:W):boolean;
}
export function sameWaitSnapshot(a:WaitEngineRecord|null,b:WaitEngineRecord):boolean {
  return Boolean(a && a.waitId===b.waitId && a.revision===b.revision && a.state===b.state);
}
/** All continuation claims use this exact CAS and persist before any start.
 * Preparation runs only for the winning source snapshot, in the transaction. */
export function claimWaitContinuation<W extends WaitEngineRecord,D>(
  storage:WaitEngineStorage<W>, expected:W,
  prepare:(current:W)=>{next:W;dispatch:D},
  options?:{reserve(current:W):W},
):D|null {
  const checked=(current:W,result:{next:W;dispatch:D})=>{
    if(result.next.waitId!==current.waitId || result.next.revision!==current.revision+1
      || result.next.state!=="claimed" || !result.next.successorInvocationId || !result.next.dispatchOwner)
      throw new Error("goal_wait_claim_invalid");
  };
  if(options) {
    // Cross-store adapter: commit this reservation BEFORE domain preparation.
    // A failed later write may recover only this exact reservation/queued run.
    const reserved=storage.transaction(()=>{
      const current=storage.read();
      if(!sameWaitSnapshot(current,expected) || current!.state!=="pending" || !storage.current(current!))return null;
      if(current!.successorInvocationId)return current!;
      const next=options.reserve(current!);
      if(next.waitId!==current!.waitId || next.revision!==current!.revision+1 || next.state!=="pending" || !next.successorInvocationId)
        throw new Error("goal_wait_reservation_invalid");
      storage.persist(next);return next;
    });
    if(!reserved)return null;
    const result=prepare(reserved);checked(reserved,result);
    return storage.transaction(()=>{
      const current=storage.read();
      if(!sameWaitSnapshot(current,reserved) || !storage.current(result.next))return null;
      storage.persist(result.next);return result.dispatch;
    });
  }
  // Legacy owner: checkpoint preparation and claim share this same SQLite
  // transaction, so its original event layout/revision/order stays unchanged.
  return storage.transaction(()=>{
    const current=storage.read();
    if(!sameWaitSnapshot(current,expected) || current!.state!=="pending" || !storage.current(current!)) return null;
    const result=prepare(current!);checked(current!,result);
    storage.persist(result.next);return result.dispatch;
  });
}
export type WaitStartResult={start:true;runId:string}|{start:false;reason:string;retryAt:string};
/** A claimed request is never reconstructed here. The caller provides only its
 * freshly prepared opaque packet; a restarted host may reconcile, never replay. */
export function dispatchWaitClaim<W extends WaitEngineRecord>(input:{
  storage:WaitEngineStorage<W>; expected:W; owner:{kind:"desktop"|"daemon";epoch:string};
  assertStart(current:W):void;
  start(current:W):WaitStartResult;
  onStarted(current:W):void;
  onFinal?(current:W):void;
  /** Legacy episode policy is preserved; canonical unknown also stays claimed. */
  failureState:"claimed"|"cancelled";
  failureReason:string;
  /** Opt in only when this adapter can retire a provably undispatched claim.
   * A thrown start remains uncertain under failureState, since it may have acted. */
  preStartFailureReason?:string;
}):W|null {
  const claim=input.storage.read();
  if(!sameWaitSnapshot(claim,input.expected) || claim!.state!=="claimed"
    || claim!.dispatchOwner?.kind!==input.owner.kind || claim!.dispatchOwner.epoch!==input.owner.epoch
    || !claim!.successorInvocationId) return null;
  // The claim is this host's own but the Goal's authority moved while it prepared (the owner paused it): nothing may start from
  // it, and leaving it claimed holds the Goal's next step for ever - no later wait registers, and a Resume never touches a
  // claimed wait. An adapter that can retire an undispatched claim retires it, without calling start.
  const live=input.storage.current(claim!);
  if(!live && !(input.preStartFailureReason && input.storage.receiptCurrent?.(claim!))) return null;
  let result:WaitStartResult|null=null;
  let state:W["state"]="dispatched",reason="goal_wait_dispatched";
  let admitted=live;
  if(!live) {state="cancelled";reason=input.preStartFailureReason!;}
  else try {input.assertStart(claim!);} catch {
    if(!input.preStartFailureReason)return null;
    admitted=false;state="cancelled";reason=input.preStartFailureReason;
  }
  if(admitted) {
    try {
      result=input.start(claim!);
      if(result.start && result.runId!==claim!.successorInvocationId) throw new Error("goal_wait_dispatch_identity_mismatch");
      if(!result.start) {state="pending";reason=result.reason;}
    } catch {state=input.failureState;reason=input.failureReason;}
  }
  // Finalize an accepted start even if its accounting/notice callback fails,
  // then preserve that callback's original error for the caller.
  let startedCallbackFailed=false,startedCallbackError:unknown;
  if(state==="dispatched") try {input.onStarted(claim!);} catch(error) {
    startedCallbackFailed=true;startedCallbackError=error;
  }
  const finalized=input.storage.transaction(()=>{
    const latest=input.storage.read();
    if(!sameWaitSnapshot(latest,claim!) || !(input.storage.current(latest!) || input.storage.receiptCurrent?.(latest!))) return null;
    const next={...latest!,revision:latest!.revision+1,state,wakeReason:reason,
      ...(result && !result.start ? {nextCheckAt:result.retryAt}:{} )} as W;
    input.storage.persist(next);return next;
  });
  // A follow-up scheduling failure must not roll back an already final claim.
  if(finalized)input.onFinal?.(finalized);
  if(startedCallbackFailed)throw startedCallbackError;
  return finalized;
}
/** Recovery deliberately has no start/prepare callback. Domain receipt readers
 * decide whether an exact successor was verified, is closed, or stays unknown.
 * No absence/elapsed time can transfer a persisted claim to another run. */
export function reconcileWaitClaim<W extends WaitEngineRecord>(input:{
  storage:WaitEngineStorage<W>;expected:W;
  resolve(current:W):{next:W;afterPersist?():void}|null;
}):W|null {
  return input.storage.transaction(()=>{
    const current=input.storage.read();
    if(!sameWaitSnapshot(current,input.expected) || current!.state!=="claimed"
      || !(input.storage.current(current!) || input.storage.receiptCurrent?.(current!))) return null;
    const result=input.resolve(current!);if(!result) return null;
    if(result.next.waitId!==current!.waitId || result.next.successorInvocationId!==current!.successorInvocationId
      || result.next.revision!==current!.revision+1 || result.next.state==="pending") throw new Error("goal_wait_reconciliation_invalid");
    input.storage.persist(result.next);result.afterPersist?.();return result.next;
  });
}
export function waitObservationReady(wait:{intent:{condition:string};lastObservedDigest:string},observation:{digest:string;terminal:boolean}):boolean {
  return wait.intent.condition==="changed" ? observation.digest!==wait.lastObservedDigest : observation.terminal;
}
export function nextWaitObservationAt(intervalMs:number,now:number):{intervalMs:number;nextCheckAt:string} {
  const interval=Math.min(intervalMs*2,300_000);
  return {intervalMs:interval,nextCheckAt:new Date(now+interval).toISOString()};
}
