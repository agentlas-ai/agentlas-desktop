import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "./companion-handoff-proof";

/** Main-signed, short-lived authority for one Work run in one authenticated
 * daemon boot. This is not a generic daemon signing grant. */
export const COMPANION_DIRECT_LEASE_PURPOSE = "agentlas.companion.desktop-gui-lease.v1";
export const COMPANION_DIRECT_LEASE_MAX_MS = 15_000;
export type CompanionDirectLease = {binding:Record<string,unknown>;runId:string;deviceGeneration:number;daemonBootId:string;scopeKey:string;
  authorityDigest:string;issuedAt:number;expiresAt:number;nonce:string};
export function companionDirectLeaseBytes(value:unknown):Buffer {
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new TypeError("companion_lease_invalid");
  const v=value as Record<string,unknown>,keys=["binding","runId","deviceGeneration","daemonBootId","scopeKey","authorityDigest","issuedAt","expiresAt","nonce"].sort();
  if(Object.keys(v).sort().join(",")!==keys.join(",") || !v.binding || typeof v.binding!=="object" || Array.isArray(v.binding)) throw new TypeError("companion_lease_invalid");
  const binding=v.binding as Record<string,unknown>;companionHandoffProofBytes(binding);
  if(binding.method!=="one.work-handoff.send.v1" || typeof v.runId!=="string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(v.runId) ||
    !Number.isSafeInteger(v.deviceGeneration) || Number(v.deviceGeneration)<1 || typeof v.daemonBootId!=="string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(v.daemonBootId) ||
    typeof v.scopeKey!=="string" || !/^[a-f0-9]{64}$/.test(v.scopeKey) ||
    typeof v.authorityDigest!=="string" || !/^[a-f0-9]{64}$/.test(v.authorityDigest) || typeof v.nonce!=="string" || !/^[a-f0-9]{32}$/.test(v.nonce) ||
    !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) || Number(v.issuedAt)<0 || Number(v.expiresAt)<=Number(v.issuedAt) ||
    Number(v.expiresAt)-Number(v.issuedAt)>COMPANION_DIRECT_LEASE_MAX_MS) throw new TypeError("companion_lease_invalid");
  return Buffer.from(JSON.stringify([COMPANION_DIRECT_LEASE_PURPOSE,...COMPANION_HANDOFF_PROOF_FIELDS.map(field=>binding[field]),v.runId,
    v.deviceGeneration,v.daemonBootId,v.scopeKey,v.authorityDigest,v.issuedAt,v.expiresAt,v.nonce]),"utf8");
}
