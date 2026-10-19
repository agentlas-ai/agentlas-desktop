











import type { CredentialPresence } from "../secrets/vault";
import { envVarPresence } from "../secrets/vault";
import { credentialVaultKey } from "../mcp-tools/credential-refs";
import { mcpOAuthCredentialPresence } from "../mcp-tools/oauth";

export interface ConnectorPresenceRow {
  serverId: string;
  transport: string;
  envKeys: readonly string[];
  credentialRefs?: Record<string, string> | null;
}

export interface ConnectorCredentialPresence {
  /** Declared keys whose Vault key is known to be absent. */
  missingEnv: string[];
  oauth: "usable" | "absent" | "unknown" | "not_applicable";
  /** "unverified": a key or the OAuth session was not observed yet; nothing was read to find out. */
  credentialState: "credential_missing" | "login_may_be_required" | "unverified" | "ready";
}

export function connectorCredentialPresence(row: ConnectorPresenceRow): ConnectorCredentialPresence {
  const missingEnv: string[] = [];
  let unknown = false;
  for (const key of row.envKeys) {
    const presence: CredentialPresence = envVarPresence(credentialVaultKey(row, key));
    if (presence === "missing") missingEnv.push(key);
    else if (presence === "unknown") unknown = true;
  }
  let oauth: ConnectorCredentialPresence["oauth"] = "not_applicable";
  if (row.transport !== "stdio") {
    const presence = mcpOAuthCredentialPresence(row.serverId);
    oauth = presence === "present" ? "usable" : presence === "missing" ? "absent" : "unknown";
  }
  const remoteWithoutKeys = row.transport !== "stdio" && row.envKeys.length === 0;
  const credentialState = missingEnv.length > 0 ? "credential_missing"
    : remoteWithoutKeys && oauth === "absent" ? "login_may_be_required"
      : unknown || (remoteWithoutKeys && oauth === "unknown") ? "unverified" : "ready";
  return { missingEnv, oauth, credentialState };
}
