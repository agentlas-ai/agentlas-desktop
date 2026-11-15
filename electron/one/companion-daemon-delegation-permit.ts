import {companionDaemonDelegationBytes,type CompanionDaemonDelegation} from "../../shared/companion-daemon-delegation";

// Process-neutral half of the daemon-delegation consent; the window is in companion-daemon-delegation-consent.ts
// ("electron"). See companion-continuity-permit.ts for why the two halves are separate files.
export type CompanionDaemonPermit={binding:CompanionDaemonDelegation;guiKeyFingerprint:string;assertCurrent():void};
const permits=new WeakMap<object,CompanionDaemonPermit>();
const requests=new WeakMap<object,CompanionDaemonPermit>();
/** This device-key proof asks Main for an attestation; it is not consent.
 * The caller must bind the live account, pairing and attached daemon before
 * creating it. Revalidation is synchronous and the permit is single use. */
export function createCompanionDaemonAttestationRequestPermit(binding:unknown,guiKeyFingerprint:string,assertCurrent:(binding:CompanionDaemonDelegation)=>void):object|null{
  try{companionDaemonDelegationBytes("attestation-request",binding);if(!/^[a-f0-9]{64}$/.test(guiKeyFingerprint)||typeof assertCurrent!=="function")return null;
    const fixed=structuredClone(binding) as CompanionDaemonDelegation;Object.freeze(fixed.scope);Object.freeze(fixed);
    const guard=()=>{const result=assertCurrent(fixed) as unknown;if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});throw Error("daemon_attestation_owner_invalid");}};
    guard();const permit=Object.freeze({});requests.set(permit,{binding:fixed,guiKeyFingerprint,assertCurrent:guard});return permit;
  }catch{return null;}
}
export function takeCompanionDaemonAttestationRequestPermit(value:unknown):CompanionDaemonPermit|null{
  if(!value||typeof value!=="object")return null;const permit=requests.get(value);requests.delete(value);if(!permit)return null;
  try{permit.assertCurrent();return permit}catch{return null;}
}
export function issueCompanionDaemonDelegationConsentPermit(held:CompanionDaemonPermit):object{
  const permit=Object.freeze({});permits.set(permit,held);return permit;
}
export function takeCompanionDaemonDelegationConsentPermit(value:unknown):CompanionDaemonPermit|null{
  if(!value||typeof value!=="object")return null;const permit=permits.get(value);permits.delete(value);if(!permit)return null;
  try{permit.assertCurrent();return permit}catch{return null;}
}
