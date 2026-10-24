/*
 * A connection's credential state for discovery, from value-free presence metadata only (R-024).
 *
 * Discovery and readiness (harness connector.search / describe / status, auth.status, the canonical registry's
 * readiness reader) used to call hasEnvVar / hasUsableMcpOAuthCredential, which read the secret value to measure its
 * length: production 2026-10-16..17, `harness_describe connector:*` read keychain values four times inside unattended
 * runs (daily graph run-cdf732ca, Yotube room). A keychain prompt in such a run has nobody to answer it. This module
 * answers from vault.ts presence (this process's own observations and the durable presence ledger) and never reads,
 * lists or prompts. A key nobody has observed yet is "unknown": the state is "unverified", never "credential_missing".
 * Using a connection (auth.ensure, auth.login, connector.connect, a run's own configuration) still reads the value.
 * No electron import: the background service loads this.
 */
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
