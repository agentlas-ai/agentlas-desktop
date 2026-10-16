import { createHash, randomBytes } from "node:crypto";

/*
 * Per-connection credential references (native-harness notyet NH29, docs 15 §49–57).
 *
 * The Vault's env namespace is global: a key name is one value. Two accounts of the same service (a personal and a
 * company token for one MCP endpoint) therefore cannot both live under `API_KEY`. A connection that owns its own
 * credential records `credentialRefs[API_KEY] = AGENTLAS_CONN_<token>_API_KEY`; every reader resolves the value through
 * `credentialVaultKey`, and the server still receives it under the name it declared. A reference may also name another
 * global key (a source config's `API_KEY = "${WORK_TOKEN}"` reads WORK_TOKEN, not an unrelated API_KEY). A key without
 * a reference keeps reading the global key of the same name, so every existing row behaves exactly as before.
 *
 * Values never pass through this module; it only names where they live. No electron import (the daemon loads it).
 */

import { MCP_ENV_KEY_RE as ENV_KEY, credentialVaultKey, type McpCredentialRefs } from "../../shared/mcp-credential-slot";

const CONNECTION_KEY = /^AGENTLAS_CONN_[a-f0-9]{12}_[A-Za-z0-9_]{1,100}$/;

export type CredentialRefs = McpCredentialRefs;

/** The Vault key that holds `envKey`'s value for this connection. One rule for Main, the daemon and the renderer. */
export { credentialVaultKey };

/** A fresh connection token; one per connection, shared by all of that connection's keys. */
export function newConnectionCredentialToken(): string {
  return randomBytes(6).toString("hex");
}

/** The connection-owned Vault key for `envKey` (valid env name, at most 128 characters). */
export function connectionVaultKey(token: string, envKey: string): string {
  if (!/^[a-f0-9]{12}$/.test(token) || !ENV_KEY.test(envKey)) throw new Error("connection_credential_key_invalid");
  const suffix = envKey.length <= 100 ? envKey : createHash("sha256").update(envKey).digest("hex").slice(0, 32);
  return `AGENTLAS_CONN_${token}_${suffix}`;
}

/** True for a connection-owned Vault key. Its value belongs to that one connection, so no reader may stand another saved key in for it. */
export function isConnectionVaultKey(key: string): boolean {
  return CONNECTION_KEY.test(key);
}

/** Vault keys this connection alone owns (safe to delete on its sign-out or removal; global keys are never listed). */
export function connectionOwnedVaultKeys(server: { credentialRefs?: CredentialRefs | null }): string[] {
  return Object.values(server.credentialRefs ?? {}).filter((ref) => typeof ref === "string" && CONNECTION_KEY.test(ref));
}

/** Parse the stored column; anything malformed reads as "no references" plus `valid: false`. */
export function parseCredentialRefs(json: string | null | undefined): { refs: Record<string, string>; valid: boolean } {
  if (json === null || json === undefined || json === "") return { refs: {}, valid: true };
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { refs: {}, valid: false };
    const refs: Record<string, string> = {};
    for (const [key, ref] of Object.entries(value)) {
      if (!ENV_KEY.test(key) || typeof ref !== "string" || !ENV_KEY.test(ref)) return { refs: {}, valid: false };
      refs[key] = ref;
    }
    return { refs, valid: true };
  } catch {
    return { refs: {}, valid: false };
  }
}
