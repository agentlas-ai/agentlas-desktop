// A mirror of a CLI's own config folder in which every entry is a symlink to the original, except the entries a
// product run must not see (the person's instruction files, memories, skills, hooks, MCP servers).
//
// This is the Codex pattern (codex-product-home.ts) in one reusable piece, used for Grok's GROK_HOME and for
// Antigravity's HOME/.gemini. Sign-in files, sessions and state stay one and the same file through the links, so a
// session written through the mirror lands in the real folder and resumes from either side. The person's real
// folder is only ever READ here: nothing in it is created, changed or removed.
//
// A mirror directory holds only symlinks plus files this module writes (`own`). Anything else found there was
// created by the CLI itself (a store a newer version adds); it is left alone, never moved or deleted.
import fs from "node:fs";
import path from "node:path";

export interface ConfigHomeMirrorInput {
  /** The person's real folder (read only). */
  realDir: string;
  /** Where the mirror lives (created when missing). */
  mirrorDir: string;
  /** True for an entry of realDir that must NOT appear in the mirror. */
  hide: (name: string) => boolean;
  /**
   * Entries of realDir that the mirror holds as a folder of its own (for example a config folder that is itself
   * mirrored with a different rule). They are never linked; the caller fills them.
   */
  folders?: readonly string[];
  /** Files the mirror owns, written whole (name -> text). A name listed here is never linked. */
  own?: Readonly<Record<string, string>>;
}

function lstat(at: string): fs.Stats | null {
  try { return fs.lstatSync(at); } catch { return null; }
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

/** Brings the mirror in line with the real folder. Throws when links cannot be made. */
export function syncConfigHomeMirror(input: ConfigHomeMirrorInput): void {
  const own = input.own ?? {};
  const folders = new Set(input.folders ?? []);
  const entries = fs.readdirSync(input.realDir);
  fs.mkdirSync(input.mirrorDir, { recursive: true, mode: 0o700 });
  const wanted = new Set(entries.filter((name) => !input.hide(name) && !folders.has(name) && !(name in own)));
  for (const name of fs.readdirSync(input.mirrorDir)) {
    const at = path.join(input.mirrorDir, name);
    const stat = lstat(at);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      // unlink, not rm: rm stats through a dangling link and reports ENOENT for the link itself.
      if (!wanted.has(name) || fs.readlinkSync(at) !== path.join(input.realDir, name)) quietly(() => fs.unlinkSync(at));
      continue;
    }
    if (name in own || folders.has(name)) continue;
    // The CLI made this here because the real folder had none at the time; it stays the mirror's own.
    wanted.delete(name);
  }
  for (const name of wanted) {
    const at = path.join(input.mirrorDir, name);
    if (lstat(at)) continue;
    quietly(() => fs.symlinkSync(path.join(input.realDir, name), at));
  }
  for (const [name, text] of Object.entries(own)) {
    const at = path.join(input.mirrorDir, name);
    const stat = lstat(at);
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) quietly(() => fs.rmSync(at, { recursive: true, force: true }));
    let current: string | null = null;
    try { current = fs.readFileSync(at, "utf8"); } catch { /* none yet */ }
    if (current !== text) {
      const temp = `${at}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, at);
    }
  }
}

/** True when `name` of the mirror is a symlink (used by callers to confirm sign-in files are linked). */
export function isMirrorLink(mirrorDir: string, name: string): boolean {
  return lstat(path.join(mirrorDir, name))?.isSymbolicLink() === true;
}
