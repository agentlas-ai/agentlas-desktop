/**
 * Is this path one of Agentlas' own product homes? Product CLI runs get a mirror of the person's config folder
 * (codex/claude/kimi/cursor/copilot/grok/agy product homes), and their environment points at it (CODEX_HOME,
 * CLAUDE_CONFIG_DIR, HOME for grok/agy, ...).
 *
 * A process that inherits such an environment (Agentlas started again from inside a product run) used to take the mirror
 * for the person's real folder and mirror it once more. Owner Mac, 2026-10-14: codex-product-home/10161a503527{,-isolated}
 * is the mirror of the mirror c183d58fa429-isolated (sha256 of that path), with its own 609 MB state_5.sqlite and 75 MB
 * thread history, 1.48 GB in all (performance review C6, 2026-10-17).
 *
 * The check is structural: the folder itself, or its parent, is a product-home root. No userData comparison, so dev and
 * QA instances' homes count too. A person's own override elsewhere (CODEX_HOME=/opt/codex) is still honoured.
 */
import os from "node:os";
import path from "node:path";

export const PRODUCT_HOME_ROOTS: readonly string[] = Object.freeze([
  "codex-product-home", "claude-product-home", "copilot-product-home", "kimi-product-home", "cursor-product-home",
  "grok-product-home", "grok-product-user-home", "agy-product-home",
]);
const ROOTS = new Set(PRODUCT_HOME_ROOTS);

export function isAgentlasProductHome(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const resolved = path.resolve(candidate);
  return ROOTS.has(path.basename(resolved)) || ROOTS.has(path.basename(path.dirname(resolved)));
}

const reported = new Set<string>();
function reportIgnored(variable: string): void {
  if (reported.has(variable)) return;
  reported.add(variable);
  console.warn("[product-home]", JSON.stringify({ code: "product_home_env_ignored", variable }));
}

/** The person's own override of a CLI's config folder, or undefined when unset or inherited from a product run. */
export function personalHomeOverride(env: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = env[variable];
  if (!value) return undefined;
  if (!isAgentlasProductHome(value)) return value;
  reportIgnored(variable);
  return undefined;
}

/**
 * The person's own home folder. A grok or agy product run sets HOME to a product home, and a process started from it
 * inherits that HOME (os.homedir() reads HOME too). Then the run's recorded real home, else the account's home.
 */
export function personalHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of [env.HOME, env.USERPROFILE, env.AGENTLAS_GROK_REAL_HOME, env.AGENTLAS_AGY_REAL_HOME]) {
    if (!candidate) continue;
    if (!isAgentlasProductHome(candidate)) return candidate;
    reportIgnored("HOME");
  }
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

/** A value of this variable that the run did not choose: inherited unchanged from this process and a product home. */
export function inheritedProductHome(env: NodeJS.ProcessEnv, variable: string): boolean {
  const value = env[variable];
  return !!value && value === process.env[variable] && isAgentlasProductHome(value);
}
