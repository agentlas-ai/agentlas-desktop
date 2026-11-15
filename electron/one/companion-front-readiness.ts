import { randomBytes, verify, type KeyObject } from "node:crypto";
import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { assertFrontReadinessClaims, FRONT_READINESS_AUDIENCE, FRONT_READINESS_EVIDENCE_FIELDS, type FrontReadinessEvidence } from "../../shared/companion-front-readiness";

type Observation={evidence:FrontReadinessEvidence;assertCurrent():void};
type Options={publicKey:KeyObject; assertOwner():void; observe(binding:Record<string,unknown>,runId:string):Observation|null;
  /** Sends a purpose-limited, nonce-bound Desktop assertion to the authority; no cached answer. */
  attest(input:{binding:Record<string,unknown>;runId:string;evidence:FrontReadinessEvidence;requestNonce:string}):Promise<string|null>;
  now?:()=>number};
function guard(observation:Observation):void {const r=observation.assertCurrent() as unknown;if(r!==undefined){if(r&&typeof(r as {then?:unknown}).then==="function")void Promise.resolve(r).catch(()=>{});throw new Error("front_readiness_local_not_synchronous");}}
/** Each executor check requires a fresh server response and re-reads local custody. */
export function createCompanionFrontReadiness(options:Options) {
  if(options.publicKey?.type!=="public"||options.publicKey.asymmetricKeyType!=="ed25519"||typeof options.assertOwner!=="function"||
     typeof options.observe!=="function"||typeof options.attest!=="function")throw new TypeError("front_readiness_config");
  const now=options.now??Date.now;
  const assertOwner=()=>{const result=options.assertOwner() as unknown;if(result!==undefined){
    if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});
    throw new Error("front_readiness_owner_not_synchronous");
  }};
  return async(binding:Record<string,unknown>,runId:string):Promise<boolean>=>{
    try {
      assertOwner();if(!binding||typeof binding!=="object"||Array.isArray(binding)||typeof runId!=="string")return false;
      const frozen=JSON.parse(JSON.stringify(binding)) as Record<string,unknown>,bindingBytes=JSON.stringify(frozen);
      if(frozen.method!=="one.front-turn.send.v1")return false;
      companionHandoffProofBytes({...frozen,method:"one.work-handoff.send.v1"});
      const initial=options.observe(frozen,runId);if(!initial||typeof initial.assertCurrent!=="function"||JSON.stringify(frozen)!==bindingBytes)return false;guard(initial);
      if(!initial.evidence||Object.keys(initial.evidence).sort().join(",")!==[...FRONT_READINESS_EVIDENCE_FIELDS].sort().join(","))return false;
      const evidence=Object.fromEntries(FRONT_READINESS_EVIDENCE_FIELDS.map(field=>[field,initial.evidence[field]])) as FrontReadinessEvidence;
      const expected=JSON.stringify(evidence),requestNonce=`frq_${randomBytes(16).toString("base64url")}`;
      const request={binding:JSON.parse(JSON.stringify(frozen)) as Record<string,unknown>,runId,evidence:JSON.parse(expected) as FrontReadinessEvidence,requestNonce};
      const requestBytes=JSON.stringify(request),token=await options.attest(request);
      if(JSON.stringify(request)!==requestBytes||typeof token!=="string"||token.length>8192)return false;
      assertOwner();guard(initial);
      const parts=token.split(".");if(parts.length!==3||parts[0]!=="fra1"||!parts.slice(1).every(v=>/^[A-Za-z0-9_-]+$/.test(v)))return false;
      const body=Buffer.from(parts[1],"base64url"),signature=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1]||signature.length!==64||signature.toString("base64url")!==parts[2]||
         !verify(null,Buffer.from(`fra1.${parts[1]}`,"ascii"),options.publicKey,signature))return false;
      const claims:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));assertFrontReadinessClaims(claims);
      if(claims.audience!==FRONT_READINESS_AUDIENCE||claims.runId!==runId||claims.requestNonce!==requestNonce||
         COMPANION_HANDOFF_PROOF_FIELDS.some(field=>claims[field]!==frozen[field])||
         FRONT_READINESS_EVIDENCE_FIELDS.some(field=>claims[field]!==evidence[field])||
         Number(claims.issuedAt)>Math.floor(now()/1000)||Number(claims.expiresAt)*1000<=now())return false;
      const latest=options.observe(frozen,runId);if(!latest||JSON.stringify(frozen)!==bindingBytes||!latest.evidence||
        Object.keys(latest.evidence).sort().join(",")!==[...FRONT_READINESS_EVIDENCE_FIELDS].sort().join(",")||
        JSON.stringify(Object.fromEntries(FRONT_READINESS_EVIDENCE_FIELDS.map(field=>[field,latest.evidence[field]])))!==expected)return false;
      guard(latest);assertOwner();return Number(claims.expiresAt)*1000>now();
    } catch {return false;}
  };
}
