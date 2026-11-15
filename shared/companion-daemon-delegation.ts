/** Closed transcript for a server-authorized, purpose-limited daemon key.
 * Constructing bytes does not authorize a delegation or establish that its
 * account, device, logout generation or nonce are still current. */
export const COMPANION_DAEMON_DELEGATION_FIELDS = [
  "userId", "workspaceId", "authEpoch", "accountSubject", "familyId", "deviceId", "deviceGeneration",
  "sessionGeneration", "hostId", "oneId", "daemonPublicKey", "scope", "issuedAt", "expiresAt", "nonce",
] as const;
export type CompanionDaemonDelegation = Readonly<{
  userId:string; workspaceId:string; authEpoch:number; accountSubject:string; familyId:string; deviceId:string;
  deviceGeneration:number; sessionGeneration:number; hostId:string; oneId:string; daemonPublicKey:string;
  scope:readonly ("front"|"work")[]; issuedAt:number; expiresAt:number; nonce:string;
}>;
export type CompanionDaemonDelegationPurpose = "gui"|"possession"|"revoke"|"attestation-request";
const id = (value:unknown) => typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value);
const integer = (value:unknown, minimum:number) => Number.isSafeInteger(value) && (value as number) >= minimum;

/** Validate exact field set and return the canonical bytes, never a signed permit. */
export function companionDaemonDelegationBytes(purpose:CompanionDaemonDelegationPurpose, value:unknown):Buffer {
  if (!["gui", "possession", "revoke", "attestation-request"].includes(purpose) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("companion_daemon_delegation_invalid");
  const data=value as Record<string,unknown>, fields=[...COMPANION_DAEMON_DELEGATION_FIELDS].sort();
  if (Object.keys(data).sort().join(",") !== fields.join(",") ||
      ![data.userId,data.workspaceId,data.accountSubject,data.familyId,data.hostId,data.oneId].every(id) ||
      typeof data.deviceId !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(data.deviceId) ||
      !integer(data.authEpoch,0) || !integer(data.deviceGeneration,1) || !integer(data.sessionGeneration,0) || data.sessionGeneration === Number.MAX_SAFE_INTEGER ||
      !integer(data.issuedAt,0) || !integer(data.expiresAt,1) || (data.expiresAt as number) <= (data.issuedAt as number) ||
      (data.expiresAt as number) - (data.issuedAt as number) > 604800 ||
      typeof data.nonce !== "string" || !/^ddn_[A-Za-z0-9_-]{22}$/.test(data.nonce) ||
      !Array.isArray(data.scope) || !["[\"front\"]","[\"work\"]","[\"front\",\"work\"]"].includes(JSON.stringify(data.scope)) ||
      typeof data.daemonPublicKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(data.daemonPublicKey)) throw new Error("companion_daemon_delegation_invalid");
  const der=Buffer.from(data.daemonPublicKey,"base64url");
  if (der.length!==44 || der.toString("base64url")!==data.daemonPublicKey || !der.subarray(0,12).equals(Buffer.from("302a300506032b6570032100","hex"))) throw new Error("companion_daemon_delegation_invalid");
  return Buffer.from(JSON.stringify([`agentlas.companion.daemon-delegation.${purpose}.v1`, ...COMPANION_DAEMON_DELEGATION_FIELDS.map(field=>data[field])]),"utf8");
}
