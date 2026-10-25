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
 * A product home mirrors a person's own config only inside a configured install: Main and the daemon of an official,
 * local-candidate, QA or dev install configure their identity at startup (install-identity.ts). A host with none (a gate,
 * a script) never mirrors the ACCOUNT's own home or a config folder directly in it (~/.codex, ~/.grok, ~/.claude, ...).
 * Owner Mac, 2026-10-18: ~/Library/Application Support/Electron, the unnamed userData of test hosts, held mirrors of the
 * owner's ~/.codex (8.8 MB, written 10-18 11:29), ~/.grok (10-13), ~/.copilot (10-17) and links to their Claude skills
 * and commands, and a test host ran the agy cleanup on the owner's ~/.gemini file (04:09Z). A temporary HOME is still
 * mirrored, so a gate that names its own HOME keeps working.
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
 * The home folder a CLI started with `env` reads its config from. Windows: USERPROFILE. The CLIs are Node (os.homedir()),
 * Go (os.UserHomeDir), Rust and Python, and on Windows all of them read USERPROFILE (or the profile API), never HOME;
 * HOME is often set there anyway (Git Bash, MSYS, Cygwin, a roaming H:\ drive), and reading it made the app look in
 * another folder than the CLI (Windows audit 2026-10-24, spawn.md #8, runtimes.md W-09: agy MCP config staged under
 * HOME, kimi sign-in and codex e-mail read from HOME). Elsewhere: HOME. Then os.homedir().
 */
export function cliUserHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
}

/**
 * `env` with the CLI's home moved to `home`: HOME, and on Windows USERPROFILE too (the variable a Windows CLI reads; a
 * HOME-only override left it in the person's profile, spawn.md #8). The grok and agy product HOMEs use it.
 */
export function withCliUserHome(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return platform === "win32" ? { ...env, HOME: home, USERPROFILE: home } : { ...env, HOME: home };
}

/**
 * The person's own home folder. A grok or agy product run sets HOME to a product home, and a process started from it
 * inherits that HOME (os.homedir() reads HOME too). Then the run's recorded real home, else the account's home.
 * On Windows USERPROFILE comes first (cliUserHome: the folder the CLIs read).
 */
export function personalHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const first = process.platform === "win32" ? [env.USERPROFILE, env.HOME] : [env.HOME, env.USERPROFILE];
  for (const candidate of [...first, env.AGENTLAS_GROK_REAL_HOME, env.AGENTLAS_AGY_REAL_HOME]) {
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
