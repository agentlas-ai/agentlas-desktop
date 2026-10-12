// Readers of a saved key that accept a plain misnaming of its name (ELEVENLABS_1 for ELEVENLABS_API_KEY).
//
// Production 2026-10-12: a key saved as ELEVENLABS_1 reached a run's shell under the read name (runtime/env-resolver.ts),
// but every other reader looked only for the exact name: the multimodal readiness check, the MCP server env builder, the
// tool catalog's missing-key probe, the video providers. A tool that needed the key was therefore reported "missing key"
// and skipped, and the owner was asked to enter a key they had already saved. One rule, applied by every reader:
// the exact name wins; otherwise a single saved name that is a plain misnaming of it stands in; runtime login keys
// (which pick or bill a model runtime's own login) are never aliased. The value never leaves this module under the
// wrong name: callers receive it for the name they asked for.
import { hasEnvVar, listEnvKeys, readEnvVar } from "./vault";
import { RUNTIME_AUTH_ENV_KEYS, isPlainMisnaming } from "../runtime/env-key-reach";

/** The saved name that stands for `key`: itself, the one plain misnaming of it, or null. */
export function savedNameFor(key: string, stored: readonly string[]): string | null {
  if (stored.includes(key)) return key;
  if (RUNTIME_AUTH_ENV_KEYS.has(key)) return null;
  const matches = stored.filter((name) => name !== key && isPlainMisnaming(name, key));
  return matches.length === 1 ? matches[0] : null;
}

export async function hasEnvVarAliased(key: string): Promise<boolean> {
  if (await hasEnvVar(key)) return true;
  if (RUNTIME_AUTH_ENV_KEYS.has(key)) return false;
  const name = savedNameFor(key, await listEnvKeys());
  return name !== null && name !== key && await hasEnvVar(name);
}

export async function readEnvVarAliased(key: string): Promise<string | null> {
  const exact = await readEnvVar(key);
  if (exact) return exact;
  if (RUNTIME_AUTH_ENV_KEYS.has(key)) return null;
  const name = savedNameFor(key, await listEnvKeys());
  return name !== null && name !== key ? readEnvVar(name) : null;
}
