













import { hasEnvVar, listEnvKeys, readEnvVar } from "./vault";
import { RUNTIME_AUTH_ENV_KEYS, isPlainMisnaming } from "../runtime/env-key-reach";
import { isConnectionVaultKey } from "../mcp-tools/credential-refs";

function neverAliased(key: string): boolean {
  return RUNTIME_AUTH_ENV_KEYS.has(key) || isConnectionVaultKey(key);
}

/** The saved name that stands for `key`: itself, the one plain misnaming of it, or null. */
export function savedNameFor(key: string, stored: readonly string[]): string | null {
  if (stored.includes(key)) return key;
  if (neverAliased(key)) return null;
  const matches = stored.filter((name) => name !== key && isPlainMisnaming(name, key));
  return matches.length === 1 ? matches[0] : null;
}

export async function hasEnvVarAliased(key: string): Promise<boolean> {
  if (await hasEnvVar(key)) return true;
  if (neverAliased(key)) return false;
  const name = savedNameFor(key, await listEnvKeys());
  return name !== null && name !== key && await hasEnvVar(name);
}

export async function readEnvVarAliased(key: string): Promise<string | null> {
  const exact = await readEnvVar(key);
  if (exact) return exact;
  if (neverAliased(key)) return null;
  const name = savedNameFor(key, await listEnvKeys());
  return name !== null && name !== key ? readEnvVar(name) : null;
}
