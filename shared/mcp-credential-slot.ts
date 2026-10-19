












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
