// The Codex home a product run uses: the user's own home, minus their personal instruction files,
// personal memories and personal skills.
//
// Codex always reads `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md` as global user
// instructions — there is no config key, flag or app-server parameter that turns it off (codex-rs
// codex-home/src/instructions, agents_md.rs: unconditional). Those files are the person's rules for
// their own coding sessions. In product runs they leaked: on 2026-10-05..06 room agents answered
// 511 of 1,208 replies with a "**[Hope]**" prefix and 247 with a "## Memory Events" envelope, and ran
// `git status` every turn in the non-git agent folder, all from the owner's ~/.codex/AGENTS.md.
// Owner decision 2026-10-06: personal coding rules must not drive product agents, for every user.
//
// So a product run gets a mirror of the real home in which every entry is a symlink to the original
// — sign-in (Codex writes auth.json in place, following the link), config, plugins, hooks, skills,
// sessions and the state database stay one and the same, so threads resume across both — except the
// two instruction files, which are simply absent. Measured on codex-cli 0.160.1: sign-in, plugins and
// hooks load, a session written through the mirror lands in the real sessions folder and resumes, the
// mirror gains no files of its own, and the model reports no git rule and no Hope identity.
//
// Personal memories, skills and hooks are not mirrored either (owner decision 2026-10-11, all users); One alone
// gets back the ones the person switched on (capabilities/one-capabilities.ts). Measured on
// codex-cli 0.162.1 through the old mirror, every model request carried the person's Codex memory block
// (~4,100 tokens of project notes and preferences) and a skills index of the person's own skills; both are the
// same class of leak as AGENTS.md. A product agent gets Agentlas's own memory context and only the skills that
// belong to it (its folder's skills, the plugins the host routed). Codex rebuilds `skills/.system` (its bundled
// skills) in the mirror itself. Codex would also run a memory-consolidation model call over the shared state
// database when the memory folder is absent, so product runs also pass `features.memories=false`
// (codex-personal-context.ts).
//
// The mirror is skipped (the run keeps the real home) where it cannot hold: no auth.json to link
// (keyring sign-in is keyed by the home's path), or links cannot be made (Windows without the right).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";

/** Read by Codex as global user instructions; never mirrored. */
export const CODEX_PERSONAL_INSTRUCTION_FILES: ReadonlySet<string> = new Set(["AGENTS.md", "AGENTS.override.md"]);
/** The person's Codex memory stores, skills and hooks; mirrored only for One, and only what it switched on. */
export function isCodexPersonalContextEntry(name: string): boolean {
  return name === "skills" || name === "skills_archive" || name === "hooks" || name === "hooks.json" || name === "memories_extensions"
    || /^memories(?:_v\d+)?(?:_\d+\.sqlite(?:-shm|-wal)?)?$/.test(name);
}
function isMemoryEntry(name: string): boolean {
  return name !== "skills" && name !== "skills_archive" && name !== "hooks" && name !== "hooks.json";
}

export interface CodexProductHomeOptions {
  /**
   * One only: which parts of the person's Codex home it switched on (capabilities/one-capabilities.ts). A second
   * mirror ("-one") links them; AGENTS.md stays out. `hooksJson` is the person's hooks.json cut down to the
   * switched-on entries, written into the mirror as its own file.
   */
  personal?: { memories: boolean; skills: boolean; hooksJson: string | null };
}

/** Entries a product run's mirror must not link: personal instruction files, and personal context unless One chose it. */
function mirrorExcludes(name: string, personal: CodexProductHomeOptions["personal"]): boolean {
  if (CODEX_PERSONAL_INSTRUCTION_FILES.has(name) || name === "skills_archive") return true;
  if (!isCodexPersonalContextEntry(name)) return false;
  if (name === "skills") return !personal?.skills;
  if (name === "hooks.json") return true; // never linked: One gets its own cut-down copy
  if (name === "hooks") return !personal?.hooksJson;
  return isMemoryEntry(name) && !personal?.memories;
}

/**
 * Codex stores that Agentlas reads back by their real path (generated images: image.ts lookup and the
 * browser upload roots). Made to exist in the real home first, so Codex never creates them in the mirror.
 */
const CODEX_SHARED_STORES = ["generated_images"] as const;

export type CodexProductHomeSkip = "no-real-home" | "no-file-sign-in" | "keyring-sign-in" | "links-unavailable";

export function realCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"));
}

function keyringOnly(realHome: string): boolean {
  try {
    const config = fs.readFileSync(path.join(realHome, "config.toml"), "utf8");
    return /^\s*cli_auth_credentials_store\s*=\s*["']keyring["']/m.test(config);
  } catch {
    return false;
  }
}

/** Brings the mirror in line with the real home. Returns the mirror, or why the real home must be used. */
export function syncCodexProductHome(realHome: string, mirrorRoot = userDataPath("codex-product-home"), options: CodexProductHomeOptions = {}): { home: string } | { skip: CodexProductHomeSkip } {
  const personal = options.personal;
  let entries: string[];
  try {
    entries = fs.readdirSync(realHome);
  } catch {
    return { skip: "no-real-home" };
  }
  if (!entries.includes("auth.json")) return { skip: "no-file-sign-in" };
  if (keyringOnly(realHome)) return { skip: "keyring-sign-in" };
  const home = mirrorPathFor(realHome, mirrorRoot, personal !== undefined);
  try {
    for (const store of CODEX_SHARED_STORES) {
      if (!entries.includes(store)) { fs.mkdirSync(path.join(realHome, store), { recursive: true }); entries.push(store); }
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const wanted = new Set(entries.filter((name) => !mirrorExcludes(name, personal)));
    for (const name of fs.readdirSync(home)) {
      const at = path.join(home, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(at); } catch { continue; }
      if (CODEX_PERSONAL_INSTRUCTION_FILES.has(name)) { quietly(() => stat.isSymbolicLink() ? fs.unlinkSync(at) : fs.rmSync(at, { recursive: true })); continue; }
      if (stat.isSymbolicLink()) {
        // unlink, not rm: rm stats through a dangling link and reports ENOENT for the link itself.
        if (!wanted.has(name) || fs.readlinkSync(at) !== path.join(realHome, name)) quietly(() => fs.unlinkSync(at));
        continue;
      }
      // Codex made this here because the real home had none at the time (a store a newer Codex adds).
      // It stays the mirror's own and is never moved or deleted: it may be open. Configuration is the
      // exception — a config Codex rewrote here yields to the person's, which is the authority.
      if (name === "config.toml" && stat.isFile() && wanted.has(name)) quietly(() => fs.rmSync(at));
      else wanted.delete(name);
    }
    for (const name of wanted) {
      const at = path.join(home, name);
      if (isLink(at) || fs.existsSync(at)) continue;
      quietly(() => fs.symlinkSync(path.join(realHome, name), at));
    }
    // hooks.json is never a link: One gets a cut-down copy, everyone else none.
    const hooksAt = path.join(home, "hooks.json");
    quietly(() => fs.rmSync(hooksAt, { force: true }));
    if (personal?.hooksJson) fs.writeFileSync(hooksAt, personal.hooksJson, { mode: 0o600 });
    if (!isLink(path.join(home, "auth.json"))) return { skip: "links-unavailable" };
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** Two runs may sync at once: the other one having made or removed the same link is not a failure. */
function quietly(action: () => void): void {
  try {
    action();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}

function isLink(at: string): boolean {
  try {
    return fs.lstatSync(at).isSymbolicLink();
  } catch {
    return false;
  }
}

function mirrorPathFor(realHome: string, mirrorRoot = userDataPath("codex-product-home"), personal = false): string {
  return path.join(mirrorRoot, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (personal ? "-one" : ""));
}

/**
 * The account home behind a run's CODEX_HOME. Readers that refuse symlinks on purpose (the model cache reader opens
 * with O_NOFOLLOW) must read the real file, not the mirror's link to it; any other home is returned as given.
 */
export function accountCodexHome(home: string | undefined): string | undefined {
  if (!home) return home;
  const realHome = realCodexHome(process.env);
  try {
    const at = path.resolve(home);
    return at === mirrorPathFor(realHome) || at === mirrorPathFor(realHome, undefined, true) ? realHome : home;
  } catch {
    return home;
  }
}

/**
 * The environment a product Codex run starts with. A home Main already chose for the run (a Science
 * grant, an observation look) is kept; only the user's own home is swapped for its mirror.
 */
export function withCodexProductHome(env: NodeJS.ProcessEnv = process.env, options: CodexProductHomeOptions = {}): NodeJS.ProcessEnv {
  const realHome = realCodexHome(process.env);
  if (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== realHome) return env;
  const mirror = syncCodexProductHome(realHome, undefined, options);
  return "home" in mirror ? { ...env, CODEX_HOME: mirror.home } : env;
}
