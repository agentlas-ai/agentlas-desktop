export const COMPANION_FRONT_TRANSFER_FIELDS = ["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","deviceGeneration","hostId","oneId","approvalId","scope","challenge"] as const;
export type CompanionFrontTransferBinding={userId:string;workspaceId:string;authEpoch:number;accountSubject:string;familyId:string;deviceId:string;
  deviceGeneration:number;hostId:string;oneId:string;approvalId:string;scope:string[];challenge:string};
/** Closed, purpose-separated consent transcript, shared with the phone service. */
export function companionFrontTransferBytes(purpose:"attestation-request"|"desktop-consent",value:unknown):Buffer {
  if((purpose!=="attestation-request" && purpose!=="desktop-consent") || !value || typeof value!=="object" || Array.isArray(value))throw new TypeError("front_transfer_binding_invalid");
  const v=value as Record<string,unknown>,expected=[...COMPANION_FRONT_TRANSFER_FIELDS].sort();
  if(Object.keys(v).sort().join(",")!==expected.join(",") ||
    ![v.userId,v.workspaceId,v.accountSubject,v.familyId,v.hostId,v.oneId,v.approvalId].every(x=>typeof x==="string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(x)) ||
    typeof v.deviceId!=="string" || !/^[A-Za-z0-9_-]{8,96}$/.test(v.deviceId) || !Number.isSafeInteger(v.authEpoch) || Number(v.authEpoch)<0 ||
    !Number.isSafeInteger(v.deviceGeneration) || Number(v.deviceGeneration)<1 || typeof v.challenge!=="string" || !/^fch_[A-Za-z0-9_-]{22}$/.test(v.challenge) ||
    !Array.isArray(v.scope) || !['["conversation"]','["conversation","memory"]','["conversation","profile"]','["conversation","memory","profile"]'].includes(JSON.stringify(v.scope)))throw new TypeError("front_transfer_binding_invalid");
  return Buffer.from(JSON.stringify([`agentlas.companion.front-transfer.${purpose}.v1`,...COMPANION_FRONT_TRANSFER_FIELDS.map(field=>v[field])]),"utf8");
}
