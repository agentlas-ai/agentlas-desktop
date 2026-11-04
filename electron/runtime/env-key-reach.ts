// Which saved env keys a run's tool processes receive, and which saved names look like a key a tool wants.
//
// Production 2026-10-11: the owner's ElevenLabs key was saved as ELEVENLABS_1 while the product reads ELEVENLABS_API_KEY,
// and even a correctly named key reached an agent only when the multimodal "auto" ladder happened to stop on ElevenLabs.
// Pure and value-free: names in, names out. Nothing here reads the vault.
import { MULTIMODAL_PROVIDERS } from "../../shared/multimodal";
import { suggestEnvKeyRenames, type EnvKeyRenameSuggestion } from "../../shared/env-key-rename";

/**
 * Credentials that pick or bill a model runtime's own login (Codex, Claude, Antigravity, Grok). A CLI that finds one in
 * its environment can switch from the owner's subscription to metered API billing, so these reach a run only when the
 * agent declares them or the user selected the matching media provider (the pre-existing, narrower rule).
 */
export const RUNTIME_AUTH_ENV_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY", "GROK_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY", "MOONSHOT_API_KEY", "DEEPSEEK_API_KEY",
]);

/**
 * Codex starts every command its shell tool runs from a cut-down environment: only a core set of variables, and anything
 * named like *KEY*, *SECRET* or *TOKEN* is dropped even when it is present. A saved ELEVENLABS_API_KEY that Main put in the
 * run's environment therefore never reached the model's own `bash` calls (production 2026-10-12: the Yotube room's agents
 * reported the key "unset" while Main logged it as aliased, and the voice step never ran). Main already decides which keys a
 * run's environment holds (runtime login keys only when declared), so Codex's own filter is lifted for everything else and
 * kept for exactly the runtime login keys.
 */
export function codexShellEnvironmentArgs(): string[] {
  return [
    "-c", "shell_environment_policy.inherit=all",
    "-c", "shell_environment_policy.ignore_default_excludes=true",
    "-c", `shell_environment_policy.exclude=${JSON.stringify([...RUNTIME_AUTH_ENV_KEYS].sort())}`,
  ];
}

/**
 * Keys of the media and speech tools an agent may call from its shell (ElevenLabs, Runway, Replicate, ...). The user
 * saved the key to make exactly those tools work, so a saved one is visible to every run's tool process.
 */
export function mediaToolEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const provider of MULTIMODAL_PROVIDERS) {
    if (provider.mode !== "api-key") continue;
    for (const key of provider.envKeys) if (!RUNTIME_AUTH_ENV_KEYS.has(key)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Saved names that no tool reads but that look like a name a tool wants (ELEVENLABS_1 -> ELEVENLABS_API_KEY).
 * `wanted` are the names this run's tools read and that are not saved; `knownRead` are every name some tool reads, so
 * a saved key that another tool already uses is never proposed for renaming.
 */
export function planEnvKeyRenames(
  stored: readonly string[],
  wanted: readonly string[],
  knownRead: readonly string[],
): EnvKeyRenameSuggestion[] {
  const read = new Set(knownRead);
  const storedSet = new Set(stored);
  const targets = [...new Set(wanted)].filter((name) => !storedSet.has(name));
  if (!targets.length) return [];
  return suggestEnvKeyRenames(stored, targets).filter((suggestion) => !read.has(suggestion.from));
}

/**
 * True when `from` is plainly the same credential as `to` under a sloppy name: the service word of `to` alone, or with
 * only a number or a credential word after it (ELEVENLABS_1, ELEVENLABS, ELEVENLABS_KEY_2 for ELEVENLABS_API_KEY).
 * The rename suggestion matches on the first word only, which is fine for a question to the owner but would hand
 * GOOGLE_MAPS_KEY to a tool that reads GOOGLE_SEARCH_KEY if used without asking.
 */
export function isPlainMisnaming(from: string, to: string): boolean {
  const service = to.split("_")[0].toUpperCase();
  if (!service) return false;
  const rest = from.toUpperCase().split("_");
  if (rest.shift() !== service) return false;
  return rest.every((word) => /^\d+$/.test(word) || ["API", "APIKEY", "KEY", "TOKEN", "SECRET"].includes(word));
}
