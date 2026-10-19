/**











 */
import os from "node:os";
import path from "node:path";
import { configuredIdentity } from "../install-identity";

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

/**







 */
export function productHomeRefusedOnThisHost(realDir: string): boolean {
  if (configuredIdentity() !== null) return false;
  let account: string;
  try { account = os.userInfo().homedir; } catch { account = os.homedir(); }
  const resolved = path.resolve(realDir);
  const home = path.resolve(account);
  return resolved === home || path.dirname(resolved) === home;
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
