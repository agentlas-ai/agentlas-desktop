/*
 * Where one MCP connection's key lives (native-harness NH29, review 2026-10-16 HD1).
 *
 * A connection that owns its credential records `credentialRefs[envKey] = AGENTLAS_CONN_<token>_<envKey>`; a key with
 * no reference reads the global Vault key of the same name. Every reader and every writer of a connection key must go
 * through this one rule. 30ef9c84 started minting references for Hub-sourced rows, and the readers that still used the
 * bare name (auto-select's presence checks) and the writer that still saved under it (the plugin key step) then
 * disagreed with the runtime about where the key is.
 *
 * Pure and dependency-free: Main (credential-refs.ts), the daemon and the renderer all import it. Values never pass
 * through this module; it only names where they live.
 */

/** A valid environment-variable name (also the Vault key name space). */
export const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type McpCredentialRefs = Readonly<Record<string, string>>;

/** The Vault key that holds `envKey`'s value for this connection. */
export function credentialVaultKey(server: { credentialRefs?: McpCredentialRefs | null }, envKey: string): string {
  const ref = server.credentialRefs?.[envKey];
  return typeof ref === "string" && MCP_ENV_KEY_RE.test(ref) ? ref : envKey;
}

/**
 * The Vault keys a value typed for `envKey` must be saved under, for the connections it was asked for.
 * One value per listed connection that declares the key (a Hub plugin with two rows has two connection slots for the
 * same account). With no listed connection that declares it, the key keeps its global name.
 */
export function connectionKeySaveTargets(
  servers: ReadonlyArray<{ id: string; envKeys?: readonly string[] | null; credentialRefs?: McpCredentialRefs | null }>,
  serverIds: readonly string[] | null | undefined,
  envKey: string,
): string[] {
  const wanted = new Set(serverIds ?? []);
  const targets = servers
    .filter((server) => wanted.has(server.id) && (server.envKeys ?? []).includes(envKey))
    .map((server) => credentialVaultKey(server, envKey));
  return targets.length ? [...new Set(targets)] : [envKey];
}
