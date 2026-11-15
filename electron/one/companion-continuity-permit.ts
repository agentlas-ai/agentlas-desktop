import type { CompanionContinuityBinding } from "../../shared/companion-continuity-proof";

// Process-neutral half of the continuity consent. The desktop window lives in companion-continuity-consent.ts, which
// imports "electron"; the background service (ELECTRON_RUN_AS_NODE) reaches this file through daemon/native-auth-credentials
// and must never load that one. A permit only exists in the Main process that showed the window, so a service-side take
// finds nothing and the signer refuses with its closed word.
export type ConsentPermit={binding:CompanionContinuityBinding;deviceKeyFingerprint:string;assertCurrent():void};
const permits=new WeakMap<object,ConsentPermit>();
export function issueContinuityConsentPermit(held:ConsentPermit):object {
  const permit=Object.freeze({});permits.set(permit,held);return permit;
}
export function takeContinuityConsentPermit(permit:unknown):ConsentPermit|null {
  if(!permit || typeof permit!=="object")return null;const held=permits.get(permit);permits.delete(permit);
  if(!held)return null;try{held.assertCurrent();return held}catch{return null;}
}
