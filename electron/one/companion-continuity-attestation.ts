import { verify, type KeyObject } from "node:crypto";

const AUDIENCE="agentlas.companion.continuity-attestation.v1";
const FIELDS=["audience","userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","deviceGeneration","hostId","oneId",
  "approvalId","scope","challenge","deviceKeyFingerprint","nonce","issuedAt","expiresAt"].sort();
const TARGET=["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","hostId","oneId","approvalId","challenge","deviceKeyFingerprint"] as const;
const ID=/^[A-Za-z0-9_.:@-]{1,128}$/;
export type ContinuityTarget = {userId:string;workspaceId:string;authEpoch:number;accountSubject:string;familyId:string;deviceId:string;
  hostId:string;oneId:string;approvalId:string;challenge:string;deviceKeyFingerprint:string;scope:readonly string[]};
type Attestation = {target:ContinuityTarget;deviceGeneration:number;assertCurrent():void};
const capabilities=new WeakMap<object,Attestation>();
function scope(value:unknown):value is string[] {
  return Array.isArray(value) && (JSON.stringify(value)==='["memory"]' || JSON.stringify(value)==='["profile"]' || JSON.stringify(value)==='["memory","profile"]');
}
function sameTarget(claims:Record<string,unknown>,target:ContinuityTarget):boolean {
  return TARGET.every(key=>claims[key]===target[key]) && scope(claims.scope) && scope(target.scope) && JSON.stringify(claims.scope)===JSON.stringify(target.scope);
}

/** A Main-signed attestation proves the current registration, not a person's
 * consent. `target` must come from native account, pairing, key and the exact
 * scope shown to the owner; no phone JSON may choose those observations. */
export function createContinuityAttestationVerifier(options:{publicKey:KeyObject;target():ContinuityTarget|null;assertCurrent():void;now?:()=>number}) {
  if(options.publicKey?.type!=="public" || options.publicKey.asymmetricKeyType!=="ed25519")throw new TypeError("continuity_attestation_key_invalid");
  const now=options.now ?? (()=>Math.floor(Date.now()/1000));
  return function attest(token:unknown):object|null {
    try {
      options.assertCurrent();
      if(typeof token!=="string" || token.length>4096)return null;
      const parts=token.split(".");if(parts.length!==3 || parts[0]!=="cca1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2]))return null;
      const body=Buffer.from(parts[1],"base64url"),sig=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1] || sig.length!==64 || sig.toString("base64url")!==parts[2] ||
        !verify(null,Buffer.from(`cca1.${parts[1]}`,"ascii"),options.publicKey,sig))return null;
      const c=JSON.parse(body.toString("utf8")) as Record<string,unknown>;
      if(!c || typeof c!=="object" || Array.isArray(c) || Object.keys(c).sort().join(",")!==FIELDS.join(",") || c.audience!==AUDIENCE ||
        ![c.userId,c.workspaceId,c.accountSubject,c.familyId,c.deviceId,c.hostId,c.oneId,c.approvalId].every(v=>typeof v==="string"&&ID.test(v)) ||
        !Number.isSafeInteger(c.authEpoch) || Number(c.authEpoch)<0 || !Number.isSafeInteger(c.deviceGeneration) || Number(c.deviceGeneration)<1 ||
        typeof c.challenge!=="string" || !/^cch_[A-Za-z0-9_-]{22}$/.test(c.challenge) || typeof c.deviceKeyFingerprint!=="string" || !/^[a-f0-9]{64}$/.test(c.deviceKeyFingerprint) ||
        typeof c.nonce!=="string" || !/^cca_[A-Za-z0-9_-]{22}$/.test(c.nonce) || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) ||
        Number(c.issuedAt)>now() || Number(c.expiresAt)<=now() || Number(c.expiresAt)-Number(c.issuedAt)<1 || Number(c.expiresAt)-Number(c.issuedAt)>30)return null;
      const target=options.target();if(!target || !sameTarget(c,target))return null;
      const frozen=structuredClone(target),generation=Number(c.deviceGeneration);
      const assertCurrent=()=>{options.assertCurrent();const current=options.target();if(now()>=Number(c.expiresAt) || !current || !sameTarget(c,current))throw new Error("continuity_attestation_changed");};
      assertCurrent();const capability=Object.freeze({});capabilities.set(capability,{target:frozen,deviceGeneration:generation,assertCurrent});return capability;
    } catch {return null;}
  };
}

/** Single use for a UI preview; the caller still needs a separate explicit
 * consent action and a fresh server-side registration recheck before writes. */
export function takeContinuityAttestation(capability:unknown):Attestation|null {
  if(!capability || typeof capability!=="object")return null;
  const held=capabilities.get(capability);capabilities.delete(capability);if(!held)return null;
  try {held.assertCurrent();return held;}catch{return null;}
}
