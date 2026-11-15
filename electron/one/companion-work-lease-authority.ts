import { verify, type KeyObject } from "node:crypto";
import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";

const AUDIENCE="agentlas.companion.work-lease-authority.v1";
const FIELDS=[...COMPANION_HANDOFF_PROOF_FIELDS,"audience","runId","deviceGeneration","deviceKeyFingerprint","executeChallenge","status","nonce","issuedAt","expiresAt"].sort();
export type WorkLeaseTarget={binding:Record<string,unknown>;runId:string;deviceKeyFingerprint:string;executeChallenge?:string};
type Verified={binding:Record<string,unknown>;runId:string;deviceGeneration:number;deviceKeyFingerprint:string;token:string;expiresAt:number;assertCurrent():void};
const permits=new WeakMap<object,Verified>();
function matches(c:Record<string,unknown>,target:WorkLeaseTarget):boolean {
  return c.runId===target.runId && c.deviceKeyFingerprint===target.deviceKeyFingerprint &&
    (target.executeChallenge===undefined || c.executeChallenge===target.executeChallenge) &&
    COMPANION_HANDOFF_PROOF_FIELDS.every(field=>c[field]===target.binding[field]);
}
/** Server evidence is short lived and purpose-separated; it is not itself a
 * daemon lease. GUI and daemon each verify it against their own native scope. */
export function createWorkLeaseAuthorityVerifier(options:{publicKey:KeyObject;target():WorkLeaseTarget|null;assertCurrent():void;now?:()=>number}) {
  if(options.publicKey?.type!=="public" || options.publicKey.asymmetricKeyType!=="ed25519")throw new TypeError("work_lease_authority_key_invalid");
  const now=options.now ?? Date.now;
  return function verifyAuthority(token:unknown):object|null {
    try {
      options.assertCurrent();if(typeof token!=="string" || token.length>8192)return null;
      const parts=token.split(".");if(parts.length!==3 || parts[0]!=="wla1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2]))return null;
      const body=Buffer.from(parts[1],"base64url"),signature=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1] || signature.length!==64 || signature.toString("base64url")!==parts[2] ||
        !verify(null,Buffer.from(`wla1.${parts[1]}`,"ascii"),options.publicKey,signature))return null;
      const c=JSON.parse(body.toString("utf8")) as Record<string,unknown>;
      if(!c || typeof c!=="object" || Array.isArray(c) || Object.keys(c).sort().join(",")!==FIELDS.join(",") || c.audience!==AUDIENCE || c.status!=="active" ||
        typeof c.runId!=="string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(c.runId) || !Number.isSafeInteger(c.deviceGeneration) || Number(c.deviceGeneration)<1 ||
        typeof c.deviceKeyFingerprint!=="string" || !/^[a-f0-9]{64}$/.test(c.deviceKeyFingerprint) || typeof c.executeChallenge!=="string" ||
        c.executeChallenge.length>4096 || !/^dc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(c.executeChallenge) ||
        typeof c.nonce!=="string" || !/^wla_[A-Za-z0-9_-]{22}$/.test(c.nonce) || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) ||
        Number(c.issuedAt)>Math.floor(now()/1000) || Number(c.expiresAt)*1000<=now() || Number(c.expiresAt)-Number(c.issuedAt)<1 || Number(c.expiresAt)-Number(c.issuedAt)>15)return null;
      const binding=Object.fromEntries(COMPANION_HANDOFF_PROOF_FIELDS.map(field=>[field,c[field]]));companionHandoffProofBytes(binding);
      if(binding.method!=="one.work-handoff.send.v1")return null;
      const target=options.target();if(!target || !matches(c,target))return null;
      const assertCurrent=()=>{options.assertCurrent();const current=options.target();if(!current || Number(c.expiresAt)*1000<=now() || !matches(c,current))throw new Error("work_lease_authority_changed");};
      assertCurrent();const capability=Object.freeze({});permits.set(capability,{binding,runId:c.runId,deviceGeneration:Number(c.deviceGeneration),
        deviceKeyFingerprint:c.deviceKeyFingerprint,token,expiresAt:Number(c.expiresAt)*1000,assertCurrent});return capability;
    } catch {return null;}
  };
}
export function takeWorkLeaseAuthority(capability:unknown):Verified|null {
  if(!capability || typeof capability!=="object")return null;const value=permits.get(capability);permits.delete(capability);
  if(!value)return null;try{value.assertCurrent();return value}catch{return null;}
}
