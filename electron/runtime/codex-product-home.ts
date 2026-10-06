// The Codex home a product run uses: the user's own home, minus their personal instruction files.
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
// The mirror is skipped (the run keeps the real home) where it cannot hold: no auth.json to link
// (keyring sign-in is keyed by the home's path), or links cannot be made (Windows without the right).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";

/** Read by Codex as global user instructions; never mirrored. */
export const CODEX_PERSONAL_INSTRUCTION_FILES: ReadonlySet<string> = new Set(["AGENTS.md", "AGENTS.override.md"]);
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
export function syncCodexProductHome(realHome: string, mirrorRoot = userDataPath("codex-product-home")): { home: string } | { skip: CodexProductHomeSkip } {
  let entries: string[];
  try {
    entries = fs.readdirSync(realHome);
  } catch {
    return { skip: "no-real-home" };
  }
  if (!entries.includes("auth.json")) return { skip: "no-file-sign-in" };
  if (keyringOnly(realHome)) return { skip: "keyring-sign-in" };
  const home = mirrorPathFor(realHome, mirrorRoot);
  try {
    for (const store of CODEX_SHARED_STORES) {
      if (!entries.includes(store)) { fs.mkdirSync(path.join(realHome, store), { recursive: true }); entries.push(store); }
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const wanted = new Set(entries.filter((name) => !CODEX_PERSONAL_INSTRUCTION_FILES.has(name)));
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

function mirrorPathFor(realHome: string, mirrorRoot = userDataPath("codex-product-home")): string {
  return path.join(mirrorRoot, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12));
}

/**
 * The account home behind a run's CODEX_HOME. Readers that refuse symlinks on purpose (the model cache reader opens
 * with O_NOFOLLOW) must read the real file, not the mirror's link to it; any other home is returned as given.
 */
export function accountCodexHome(home: string | undefined): string | undefined {
  if (!home) return home;
  const realHome = realCodexHome(process.env);
  try {
    return path.resolve(home) === mirrorPathFor(realHome) ? realHome : home;
  } catch {
    return home;
  }
}

/**
 * The environment a product Codex run starts with. A home Main already chose for the run (a Science
 * grant, an observation look) is kept; only the user's own home is swapped for its mirror.
 */
export function withCodexProductHome(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const realHome = realCodexHome(process.env);
  if (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== realHome) return env;
  const mirror = syncCodexProductHome(realHome);
  return "home" in mirror ? { ...env, CODEX_HOME: mirror.home } : env;
}
