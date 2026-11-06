/** The signed-in Desktop account. A paired phone is admitted only for the exact owner it was paired under, never merely the same workspace. */
export interface MobileAccountActor {workspaceId:string;userId:string;sessionId:string;expiresAt:number|null}
export interface MobilePairedAccount {workspaceId:string|null;accountSubject:string;accountAuthorityOrigin:string;/** Recorded at pairing. Absent on a record that predates it until the backfill fills it. */ownerUserId?:string|null}
export interface MobileAccountAdmissionPorts {
  actor():MobileAccountActor|null;
  device(deviceId:string):MobilePairedAccount|null;
  /** Account-service proof. Called only to backfill a record without an owner, never per request. */
  proof():Promise<{accountSubject:string;accountAuthorityOrigin:string;expiresIn:number}>;
  /** Persist the owner on a record that has none. Must not overwrite an existing owner. */
  recordOwner?(deviceId:string,userId:string,accountSubject:string):boolean;
  now?():number;
  /** How long one request waits for a backfill attempt before it is admitted without it. */
  backfillWaitMs?:number;
}
/** A proof for a record without an owner may take this long to answer; after that, requests are admitted without waiting for it. */
const BACKFILL_WAIT_MS=2_500;
/** After a failed attempt the next request does not start another one until this has passed. */
const BACKFILL_RETRY_MS=30_000;
type Flight={promise:Promise<'filled'|'mismatch'|'pending'>;startedAt:number};
/**
 * No network on the request path: the decision is the local session, the paired subject and origin, the workspace and the
 * owner recorded at pairing. The account service is asked only to fill an owner into an older record, in the background.
 */
export function createMobileAccountAdmission(ports:MobileAccountAdmissionPorts){
  const now=ports.now??Date.now;
  const waitMs=ports.backfillWaitMs??BACKFILL_WAIT_MS;
  const flights=new Map<string,Flight>();
  const retryAt=new Map<string,number>();
  /** One refused key per device: a newer session replaces the older one, so this never grows past the device count. */
  const refused=new Map<string,string>();
  const epoch=(actor:MobileAccountActor)=>JSON.stringify([actor.workspaceId,actor.userId,actor.sessionId,actor.expiresAt]);
  /** One proof attempt per record and session; a different subject is a definitive answer, anything else leaves the record without an owner. */
  const backfill=(key:string,deviceId:string,actor:MobileAccountActor,device:MobilePairedAccount,identity:string):Flight=>{
    const flight:Flight={startedAt:Date.now(),promise:(async()=>{
      try{
        const proof=await ports.proof();
        const active=ports.actor();
        if(!active||epoch(active)!==identity)return 'pending';
        if(proof.accountSubject!==device.accountSubject||proof.accountAuthorityOrigin!==device.accountAuthorityOrigin){refused.set(deviceId,key);return 'mismatch';}
        if(ports.recordOwner?.(deviceId,actor.userId,device.accountSubject)===false){retryAt.set(deviceId,now()+BACKFILL_RETRY_MS);return 'pending';}
        retryAt.delete(deviceId);
        return 'filled';
      }catch{
        retryAt.set(deviceId,now()+BACKFILL_RETRY_MS);
        return 'pending';
      }finally{flights.delete(key);}
    })()};
    flights.set(key,flight);
    return flight;
  };
  return async(deviceId:string):Promise<{assertCurrent():void}>=>{
    const actor=ports.actor(),device=ports.device(deviceId);
    if(!actor||actor.expiresAt!==null&&actor.expiresAt<=now())throw new Error('sign_in_required');
    if(!device?.accountSubject||!device.accountAuthorityOrigin||device.workspaceId!==actor.workspaceId)throw new Error('finance_account_unproven');
    const identity=epoch(actor);
    const assertCurrent=()=>{
      const active=ports.actor(),live=ports.device(deviceId);
      if(!active||epoch(active)!==identity||active.expiresAt!==null&&active.expiresAt<=now())throw new Error('finance_account_changed');
      if(!live||live.workspaceId!==actor.workspaceId||live.accountSubject!==device.accountSubject||live.accountAuthorityOrigin!==device.accountAuthorityOrigin)throw new Error('finance_pairing_changed');
    };
    assertCurrent();
    if(device.ownerUserId){
      if(device.ownerUserId!==actor.userId)throw new Error('account_mismatch');
      return {assertCurrent};
    }
    // No owner recorded yet: reads and writes are both admitted while the owner is being proven (a narrow, accepted window).
    const key=JSON.stringify([deviceId,identity,device.accountSubject,device.accountAuthorityOrigin]);
    if(refused.get(deviceId)===key)throw new Error('account_mismatch');
    let flight=flights.get(key);
    if(!flight&&(retryAt.get(deviceId)??0)<=now())flight=backfill(key,deviceId,actor,device,identity);
    if(flight){
      // The deadline belongs to the attempt, not to the request: one stalled proof delays only the requests that arrive before it.
      const remaining=flight.startedAt+waitMs-Date.now();
      if(remaining>0){
        let timer:ReturnType<typeof setTimeout>|undefined;
        const outcome=await Promise.race([flight.promise,new Promise<'pending'>(resolve=>{timer=setTimeout(()=>resolve('pending'),remaining);timer.unref?.();})]);
        if(timer)clearTimeout(timer);
        assertCurrent();
        if(outcome==='mismatch')throw new Error('account_mismatch');
      }
    }
    return {assertCurrent};
  };
}
