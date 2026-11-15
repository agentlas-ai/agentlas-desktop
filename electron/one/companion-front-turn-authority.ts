import {createHash,randomBytes,verify,type KeyObject} from "node:crypto";
import {companionHandoffProofBytes,COMPANION_HANDOFF_PROOF_FIELDS} from "../../shared/companion-handoff-proof";
import {parseCompanionFrontContext,type CompanionFrontContext} from "./companion-front-context";

type Observation={context:CompanionFrontContext;deviceKeyFingerprint:string;assertCurrent():void};
type Options={publicKey:KeyObject;assertOwner():void;observe(binding:Record<string,unknown>,runId:string):Observation|null;
  attest(input:{binding:Record<string,unknown>;runId:string;requestNonce:string;permit:object}):Promise<string|null>;now?:()=>number};
const extras=["audience","runId","approvalId","deviceGeneration","deviceKeyFingerprint","scope","profileRevision","profileDigest",
  "memoryGeneration","memoryRevision","forgetEpoch","memoryLeaseId","mediaComplete","requestNonce","nonce","issuedAt","expiresAt"];
const fields=[...COMPANION_HANDOFF_PROOF_FIELDS,...extras].sort();
type Permit={binding:Record<string,unknown>;runId:string;requestNonce:string;deviceKeyFingerprint:string;assertCurrent():void};
const permits=new WeakMap<object,Permit>();
export function takeCompanionFrontTurnAuthorityPermit(value:unknown):Permit|null {
  if(!value||typeof value!=="object")return null;const permit=permits.get(value);permits.delete(value);
  if(!permit)return null;try{sync(permit.assertCurrent);return permit;}catch{return null;}
}
const hash=(s:string)=>createHash("sha256").update(s,"utf8").digest("hex");
const sync=(fn:()=>void)=>{const value=fn() as unknown;if(value!==undefined){if(value&&typeof(value as {then?:unknown}).then==="function")void Promise.resolve(value).catch(()=>{});throw new Error("front_turn_authority_not_synchronous");}};
/** A fresh authority for the exact admitted text-only front turn. This initial
 * lane accepts conversation-only consent; profile/memory require independent
 * source proofs before they can be added. Unknown authority always refuses. */
export function createCompanionFrontTurnAuthority(options:Options) {
  if(options.publicKey?.type!=="public"||options.publicKey.asymmetricKeyType!=="ed25519"||typeof options.assertOwner!=="function"||
    typeof options.observe!=="function"||typeof options.attest!=="function")throw new TypeError("front_turn_authority_config");
  const now=options.now??Date.now;
  function observation(binding:Record<string,unknown>,runId:string):{value:Observation;serialized:string}|null {
    const value=options.observe(binding,runId);if(!value||typeof value.assertCurrent!=="function"||
      !/^[a-f0-9]{64}$/.test(value.deviceKeyFingerprint))return null;
    sync(value.assertCurrent);
    const raw=JSON.stringify(value.context),context=parseCompanionFrontContext(value.context,binding as {turnId:string;authEpoch:number;contextRevision:number});
    if(!context||JSON.stringify(context)!==raw||JSON.stringify(context.transfer.scope)!=='["conversation"]'||context.profile!==null||context.personalMemory!==null||
      hash(raw)!==binding.contextDigest||hash(JSON.stringify([binding.method,context]))!==binding.payloadDigest)return null;
    return {value,serialized:JSON.stringify({context,deviceKeyFingerprint:value.deviceKeyFingerprint})};
  }
  return async(binding:Record<string,unknown>,runId:string):Promise<boolean>=>{
    try {
      sync(options.assertOwner);if(!binding||typeof binding!=="object"||Array.isArray(binding)||typeof runId!=="string"||!/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId))return false;
      const frozen=JSON.parse(JSON.stringify(binding)) as Record<string,unknown>,encoded=JSON.stringify(frozen);
      if(frozen.method!=="one.front-turn.send.v1")return false;companionHandoffProofBytes({...frozen,method:"one.work-handoff.send.v1"});
      const first=observation(frozen,runId);if(!first||JSON.stringify(frozen)!==encoded)return false;
      const requestNonce=`ftr_${randomBytes(16).toString("base64url")}`;
      const permit=Object.freeze({});permits.set(permit,{binding:JSON.parse(encoded),runId,requestNonce,deviceKeyFingerprint:first.value.deviceKeyFingerprint,assertCurrent(){sync(options.assertOwner);sync(first.value.assertCurrent);const current=observation(frozen,runId);if(!current||current.serialized!==first.serialized||JSON.stringify(frozen)!==encoded)throw new Error("front_turn_authority_changed");}});
      const request={binding:JSON.parse(encoded) as Record<string,unknown>,runId,requestNonce,permit},requestBytes=JSON.stringify(request);
      let token:string|null;try{token=await options.attest(request);}finally{permits.delete(permit);}
      if(JSON.stringify(request)!==requestBytes||typeof token!=="string"||token.length>8192)return false;
      sync(options.assertOwner);sync(first.value.assertCurrent);
      const parts=token.split(".");if(parts.length!==3||parts[0]!=="frt1"||!parts.slice(1).every(x=>/^[A-Za-z0-9_-]+$/.test(x)))return false;
      const body=Buffer.from(parts[1],"base64url"),signature=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1]||signature.length!==64||signature.toString("base64url")!==parts[2]||
        !verify(null,Buffer.from(`frt1.${parts[1]}`,"ascii"),options.publicKey,signature))return false;
      const c:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));
      if(!c||typeof c!=="object"||Array.isArray(c))return false;const claims=c as Record<string,unknown>,context=first.value.context;
      if(Object.keys(claims).sort().join(",")!==fields.join(",")||claims.audience!=="agentlas.companion.front-turn-context-authority.v1"||
        COMPANION_HANDOFF_PROOF_FIELDS.some(k=>claims[k]!==frozen[k])||claims.runId!==runId||claims.requestNonce!==requestNonce||
        claims.approvalId!==context.transfer.approvalId||claims.deviceGeneration!==context.transfer.deviceGeneration||
        claims.deviceKeyFingerprint!==first.value.deviceKeyFingerprint||JSON.stringify(claims.scope)!=='["conversation"]'||
        [claims.profileRevision,claims.profileDigest,claims.memoryGeneration,claims.memoryRevision,claims.forgetEpoch,claims.memoryLeaseId].some(x=>x!==null)||
        claims.mediaComplete!==true||typeof claims.nonce!=="string"||!/^frt_[A-Za-z0-9_-]{22}$/.test(claims.nonce)||
        !Number.isSafeInteger(claims.issuedAt)||!Number.isSafeInteger(claims.expiresAt)||Number(claims.issuedAt)>Math.floor(now()/1000)||
        Number(claims.expiresAt)*1000<=now()||Number(claims.expiresAt)-Number(claims.issuedAt)<1||Number(claims.expiresAt)-Number(claims.issuedAt)>15)return false;
      const latest=observation(frozen,runId);if(!latest||latest.serialized!==first.serialized||JSON.stringify(frozen)!==encoded)return false;
      sync(latest.value.assertCurrent);sync(options.assertOwner);return Number(claims.expiresAt)*1000>now();
    } catch{return false;}
  };
}
