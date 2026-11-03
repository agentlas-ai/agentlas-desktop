/** A proof-backed lease for the exact paired owner, not merely a shared workspace. No pairing record is changed here. */
export interface MobileAccountActor {workspaceId:string;userId:string;sessionId:string;expiresAt:number|null}
export interface MobilePairedAccount {workspaceId:string|null;accountSubject:string;accountAuthorityOrigin:string}
export interface MobileAccountAdmissionPorts {
  actor():MobileAccountActor|null;
  device(deviceId:string):MobilePairedAccount|null;
  proof():Promise<{accountSubject:string;accountAuthorityOrigin:string;expiresIn:number}>;
  now?():number;
}
export function createMobileAccountAdmission(ports:MobileAccountAdmissionPorts){
  const now=ports.now??Date.now;
  const cache=new Map<string,{epoch:string;subject:string;origin:string;until:number}>();
  const pending=new Map<string,Promise<{assertCurrent():void}>>();
  const epoch=(actor:MobileAccountActor)=>JSON.stringify([actor.workspaceId,actor.userId,actor.sessionId,actor.expiresAt]);
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
    const cached=cache.get(deviceId);
    if(cached?.epoch!==identity)cache.delete(deviceId);
    if(cached&&cached.epoch===identity&&cached.subject===device.accountSubject&&cached.origin===device.accountAuthorityOrigin&&cached.until>now())return {assertCurrent};
    const key=JSON.stringify([deviceId,identity,device.accountSubject,device.accountAuthorityOrigin]);
    const inflight=pending.get(key);if(inflight){const lease=await inflight;lease.assertCurrent();return lease;}
    const checking=(async()=>{
      let proof:Awaited<ReturnType<MobileAccountAdmissionPorts['proof']>>;
      try{proof=await ports.proof();}catch{assertCurrent();throw new Error('finance_account_unproven');}
      assertCurrent();
      if(proof.accountSubject!==device.accountSubject||proof.accountAuthorityOrigin!==device.accountAuthorityOrigin)throw new Error('account_mismatch');
      if(!Number.isFinite(proof.expiresIn)||proof.expiresIn<=0)throw new Error('finance_account_unproven');
      cache.set(deviceId,{epoch:identity,subject:device.accountSubject,origin:device.accountAuthorityOrigin,until:now()+Math.min(proof.expiresIn*1000,30_000)});
      return {assertCurrent};
    })();
    pending.set(key,checking);
    try{return await checking;}finally{pending.delete(key);}
  };
}
