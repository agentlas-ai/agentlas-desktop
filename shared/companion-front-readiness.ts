import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "./companion-handoff-proof";

/** Candidate wire format only. A server must not issue this until profile,
 * conversation, media and memory parity are established with live revocation. */
export const FRONT_READINESS_AUDIENCE="agentlas.companion.front-readiness.v1";
export const FRONT_READINESS_FIELDS=[...COMPANION_HANDOFF_PROOF_FIELDS,"audience","runId","consentId","registrationGeneration",
  "deviceKeyFingerprint","mobileProfileRevision","desktopProfileRevision","profileDigest","desktopProfileDigest","memoryGeneration","mobileMemoryRevision","mobileForgetEpoch",
  "memoryLineageDigest","desktopMemoryRevision","desktopMemoryForgetEpoch","desktopMemoryDigest","conversationId","conversationRevision","conversationDigest",
  "desktopConversationDigest","mediaDigest","desktopMediaDigest","mediaComplete","requestNonce","nonce","issuedAt","expiresAt"] as const;
export const FRONT_READINESS_EVIDENCE_FIELDS=["consentId","registrationGeneration","deviceKeyFingerprint","mobileProfileRevision",
  "desktopProfileRevision","profileDigest","desktopProfileDigest","memoryGeneration","mobileMemoryRevision","mobileForgetEpoch","memoryLineageDigest","desktopMemoryRevision",
  "desktopMemoryForgetEpoch","desktopMemoryDigest","conversationId","conversationRevision","conversationDigest","desktopConversationDigest","mediaDigest","desktopMediaDigest","mediaComplete"] as const;
export type FrontReadinessEvidence=Record<typeof FRONT_READINESS_EVIDENCE_FIELDS[number],unknown>;
const ID=/^[A-Za-z0-9_.:@-]{1,128}$/, DIGEST=/^[a-f0-9]{64}$/;
const nat=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export function assertFrontReadinessClaims(value:unknown):asserts value is Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new TypeError("front_readiness_invalid");
  const c=value as Record<string,unknown>,keys=Object.keys(c).sort(),expected=[...FRONT_READINESS_FIELDS].sort();
  if(keys.length!==expected.length||!keys.every((v,i)=>v===expected[i])||c.audience!==FRONT_READINESS_AUDIENCE||c.method!=="one.front-turn.send.v1")throw new TypeError("front_readiness_invalid");
  const binding=Object.fromEntries(COMPANION_HANDOFF_PROOF_FIELDS.map(field=>[field,c[field]]));
  companionHandoffProofBytes({...binding,method:"one.work-handoff.send.v1"});
  if(![c.runId,c.consentId,c.mobileProfileRevision,c.memoryGeneration,c.conversationId].every(v=>typeof v==="string"&&ID.test(v))||
    ![c.deviceKeyFingerprint,c.profileDigest,c.desktopProfileDigest,c.memoryLineageDigest,c.desktopMemoryDigest,c.conversationDigest,c.desktopConversationDigest,c.mediaDigest,c.desktopMediaDigest].every(v=>typeof v==="string"&&DIGEST.test(v))||
    !positive(c.registrationGeneration)||!positive(c.desktopProfileRevision)||
    ![c.mobileMemoryRevision,c.mobileForgetEpoch,c.desktopMemoryRevision,c.desktopMemoryForgetEpoch,c.conversationRevision,c.issuedAt,c.expiresAt].every(nat)||
    c.profileDigest!==c.desktopProfileDigest||c.memoryLineageDigest!==c.desktopMemoryDigest||c.conversationDigest!==c.desktopConversationDigest||
    c.mediaDigest!==c.desktopMediaDigest||c.mediaComplete!==true||typeof c.requestNonce!=="string"||!/^frq_[A-Za-z0-9_-]{22}$/.test(c.requestNonce)||
    typeof c.nonce!=="string"||!/^fra_[A-Za-z0-9_-]{22}$/.test(c.nonce)||Number(c.expiresAt)-Number(c.issuedAt)<1||Number(c.expiresAt)-Number(c.issuedAt)>15)
    throw new TypeError("front_readiness_invalid");
}
