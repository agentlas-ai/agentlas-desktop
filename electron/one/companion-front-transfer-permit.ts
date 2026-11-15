import type { CompanionFrontTransferBinding } from "../../shared/companion-front-transfer-proof";

// Process-neutral half of the front-transfer consent; the window is in companion-front-transfer-consent.ts ("electron").
// See companion-continuity-permit.ts for why the two halves are separate files.
export type FrontTransferConsentPermit={binding:CompanionFrontTransferBinding;deviceKeyFingerprint:string;assertCurrent():void};
const permits=new WeakMap<object,FrontTransferConsentPermit>();
export function issueFrontTransferConsentPermit(held:FrontTransferConsentPermit):object {
  const permit=Object.freeze({});permits.set(permit,held);return permit;
}
export function takeFrontTransferConsentPermit(permit:unknown):FrontTransferConsentPermit|null {
  if(!permit || typeof permit!=="object")return null;const held=permits.get(permit);permits.delete(permit);
  if(!held)return null;try{held.assertCurrent();return held}catch{return null;}
}
