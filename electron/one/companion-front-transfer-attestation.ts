import { verify, type KeyObject } from "node:crypto";

const AUDIENCE="agentlas.companion.front-transfer-attestation.v1";
const FIELDS=["audience","userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","deviceGeneration","hostId","oneId",
  "approvalId","scope","challenge","deviceKeyFingerprint","nonce","issuedAt","expiresAt"].sort();
const TARGET=["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","hostId","oneId","approvalId","challenge","deviceKeyFingerprint"] as const;
const ID=/^[A-Za-z0-9_.:@-]{1,128}$/;
export type FrontTransferTarget = {userId:string;workspaceId:string;authEpoch:number;accountSubject:string;familyId:string;deviceId:string;
  hostId:string;oneId:string;approvalId:string;challenge:string;deviceKeyFingerprint:string;scope:readonly string[]};
type Attestation = {target:FrontTransferTarget;deviceGeneration:number;assertCurrent():void};
const capabilities=new WeakMap<object,Attestation>();
function scope(value:unknown):value is string[] {
  return Array.isArray(value) && (JSON.stringify(value)==='["conversation"]' || JSON.stringify(value)==='["conversation","memory"]' || JSON.stringify(value)==='["conversation","profile"]' || JSON.stringify(value)==='["conversation","memory","profile"]');
}
function sameTarget(claims:Record<string,unknown>,target:FrontTransferTarget):boolean {
  return TARGET.every(key=>claims[key]===target[key]) && scope(claims.scope) && scope(target.scope) && JSON.stringify(claims.scope)===JSON.stringify(target.scope);
}

/** A Main-signed attestation proves the current registration, not a person's
 * consent. `target` must come from native account, pairing, key and the exact
 * scope shown to the owner; no phone JSON may choose those observations. */
export function createFrontTransferAttestationVerifier(options:{publicKey:KeyObject;target():FrontTransferTarget|null;assertCurrent():void;now?:()=>number}) {
  if(options.publicKey?.type!=="public" || options.publicKey.asymmetricKeyType!=="ed25519")throw new TypeError("front_transfer_attestation_key_invalid");
  const now=options.now ?? (()=>Math.floor(Date.now()/1000));
  const current=()=>{const result=options.assertCurrent() as unknown;if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});throw new Error("front_transfer_owner_not_synchronous");}};
  return function attest(token:unknown):object|null {
    try {
      current();
      if(typeof token!=="string" || token.length>4096)return null;
      const parts=token.split(".");if(parts.length!==3 || parts[0]!=="fta1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2]))return null;
      const body=Buffer.from(parts[1],"base64url"),sig=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1] || sig.length!==64 || sig.toString("base64url")!==parts[2] ||
        !verify(null,Buffer.from(`fta1.${parts[1]}`,"ascii"),options.publicKey,sig))return null;
      const c=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body)) as Record<string,unknown>;
      if(!c || typeof c!=="object" || Array.isArray(c) || Object.keys(c).sort().join(",")!==FIELDS.join(",") || c.audience!==AUDIENCE ||
        ![c.userId,c.workspaceId,c.accountSubject,c.familyId,c.deviceId,c.hostId,c.oneId,c.approvalId].every(v=>typeof v==="string"&&ID.test(v)) ||
        !Number.isSafeInteger(c.authEpoch) || Number(c.authEpoch)<0 || !Number.isSafeInteger(c.deviceGeneration) || Number(c.deviceGeneration)<1 ||
        typeof c.challenge!=="string" || !/^fch_[A-Za-z0-9_-]{22}$/.test(c.challenge) || typeof c.deviceKeyFingerprint!=="string" || !/^[a-f0-9]{64}$/.test(c.deviceKeyFingerprint) ||
        typeof c.nonce!=="string" || !/^fta_[A-Za-z0-9_-]{22}$/.test(c.nonce) || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) ||
        Number(c.issuedAt)>now() || Number(c.expiresAt)<=now() || Number(c.expiresAt)-Number(c.issuedAt)<1 || Number(c.expiresAt)-Number(c.issuedAt)>30)return null;
      const target=options.target();if(!target || !sameTarget(c,target))return null;
      const frozen=structuredClone(target),generation=Number(c.deviceGeneration);
      const assertCurrent=()=>{current();const live=options.target();if(now()>=Number(c.expiresAt) || !live || !sameTarget(c,live))throw new Error("front_transfer_attestation_changed");};
      assertCurrent();const capability=Object.freeze({});capabilities.set(capability,{target:frozen,deviceGeneration:generation,assertCurrent});return capability;
    } catch {return null;}
  };
}

/** Single use for a UI preview; the caller still needs a separate explicit
 * consent action and a fresh server-side registration recheck before writes. */
export function takeFrontTransferAttestation(capability:unknown):Attestation|null {
  if(!capability || typeof capability!=="object")return null;
  const held=capabilities.get(capability);capabilities.delete(capability);if(!held)return null;
  try {held.assertCurrent();return held;}catch{return null;}
}
