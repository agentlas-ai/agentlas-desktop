import { companionContinuityBytes, type CompanionContinuityBinding } from "../../shared/companion-continuity-proof";

type Answer={publicKey:string;signature:string};
type State="pending"|"approved"|"unavailable";
type Entry={wire:string;owner:string;expiresAt:number;state:State;cancelled:boolean;answer?:Answer};
/** A mobile retry observes the same in-flight desktop confirmation. A dropped
 * connection or changed account can never receive a late approval. */
export function createMobileBridgeContinuity() {
  const entries=new Map<string,Entry>();
  function clean(){const now=Date.now();for(const [key,value] of entries)if(value.expiresAt<=now || value.cancelled)entries.delete(key);}   // B8: an expired or cancelled request is gone even while its desktop window is still open
  /** A request that can still be approved: not expired, not cancelled. Only such a request holds the next one back. */
  function live(entry:Entry){return entry.state==="pending" && !entry.cancelled && entry.expiresAt>Date.now();}
  function input(binding:unknown,owner:string) {
    const bytes=companionContinuityBytes("desktop-consent",binding);
    if(!/^[A-Za-z0-9_.:@-]{1,300}$/.test(owner))throw new Error("continuity_owner_invalid");
    const value=structuredClone(binding) as CompanionContinuityBinding;Object.freeze(value.scope);Object.freeze(value);
    return {value,wire:bytes.toString("utf8")};
  }
  function status(binding:unknown,owner:string,assertCurrent:()=>void):{status:State;publicKey?:string;signature?:string} {
    assertCurrent();const {value,wire}=input(binding,owner),entry=entries.get(value.challenge);
    if(!entry || entry.owner!==owner || entry.wire!==wire || entry.cancelled || entry.expiresAt<=Date.now())return {status:"unavailable"};
    assertCurrent();return entry.state==="approved" && entry.answer ? {status:"approved",...entry.answer}:{status:entry.state};
  }
  function start(binding:unknown,owner:string,assertCurrent:()=>void,approve:(binding:CompanionContinuityBinding,guard:()=>void)=>Promise<Answer|null>) {
    assertCurrent();clean();const {value,wire}=input(binding,owner),prior=entries.get(value.challenge);
    if(prior)return status(value,owner,assertCurrent);
    if(entries.size>=32 || [...entries.values()].some(live))return {status:"unavailable" as const};
    const entry:Entry={wire,owner,expiresAt:Date.now()+55_000,state:"pending",cancelled:false};entries.set(value.challenge,entry);
    const guard=()=>{assertCurrent();if(entries.get(value.challenge)!==entry || entry.cancelled || Date.now()>=entry.expiresAt)throw new Error("continuity_request_expired");};
    void Promise.resolve().then(()=>approve(value,guard)).then(answer=>{guard();
      if(!answer || typeof answer.publicKey!=="string" || typeof answer.signature!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(answer.publicKey) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(answer.signature)){entry.state="unavailable";return;}
      entry.answer=answer;entry.state="approved";
    }).catch(()=>{entry.state="unavailable";});
    return {status:"pending" as const};
  }
  function cancel(binding:unknown,owner:string,assertCurrent:()=>void):{status:"cancelled"|"unavailable"} {
    assertCurrent();const {value,wire}=input(binding,owner),entry=entries.get(value.challenge);
    if(!entry || entry.owner!==owner || entry.wire!==wire)return {status:"unavailable"};
    entry.cancelled=true;assertCurrent();return {status:"cancelled"};
  }
  function close(){entries.clear();}
  function hasPending(){return [...entries.values()].some(live);}
  return Object.freeze({start,status,cancel,close,hasPending});
}
