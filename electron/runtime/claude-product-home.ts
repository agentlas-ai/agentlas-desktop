// The Claude Code config dir a product run uses: the person's ~/.claude minus their sessions and history.
//
// Owner 2026-10-13: every runtime keeps the product's sessions on the Agentlas side; nothing an agent runs may show up in
// the person's own Claude app or `claude --resume` picker, and the person must stay signed in. Claude Code writes every
// conversation under $CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl, so product runs used to fill ~/.claude/projects.
//
// Sign-in: Claude keys its OS keychain item by the config dir (Claude Code 2.1.296, secure-storage service name:
// `n = CLAUDE_SECURESTORAGE_CONFIG_DIR; plain = n !== undefined ? !n : !CLAUDE_CONFIG_DIR;` the name is
// "Claude Code-credentials" when plain, else suffixed with sha256(dir)). A product run therefore sets CLAUDE_CONFIG_DIR to
// the mirror AND CLAUDE_SECURESTORAGE_CONFIG_DIR="" so the keychain item (macOS) or ~/.claude/.credentials.json
// (Linux/Windows) is the person's own, unchanged. Claude forwards that variable to its own teammate processes, so the
// pair is a supported combination, not a trick.
//
// The mirror links every entry of ~/.claude (settings, CLAUDE.md, rules, skills, commands, agents, plugins — the
// settings overlay in claude-personal-context.ts still decides which of those a run may use) except the session and
// state stores below, which are the mirror's own. `.claude.json` (global config) is the mirror's own copy of the person's
// without their per-project history and user-scope MCP servers (One keeps the servers it switched on).
// If links cannot be made (Windows without the right), the run keeps the real config dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";

/**
 * Entries of ~/.claude a product run reads as configuration; only these are linked into the mirror. Everything else —
 * projects (sessions), history, todos, shell snapshots, file history, plans, jobs, telemetry, caches, backups, locks —
 * is the person's own and stays out; Claude creates the mirror's own stores. An allowlist, so a store a future Claude
 * version adds never leaks product sessions into the person's dir or the person's into product runs.
 */
export const CLAUDE_CONFIG_ENTRIES: readonly string[] = [
  "settings.json", "settings.local.json", "CLAUDE.md", "rules", "skills", "commands", "agents", "plugins", "output-styles",
  "keybindings.json", "policy-limits.json", "remote-settings.json", "managed-settings.json",
];
export function isClaudePersonalSessionEntry(name: string): boolean {
  return !CLAUDE_CONFIG_ENTRIES.includes(name);
}

export interface ClaudeProductHomeOptions {
  /** User-scope MCP servers (~/.claude.json mcpServers) the run may keep: One's switched-on connectors. */
  keepMcpServers?: readonly string[];
}

export function claudeProductHomeDir(): string {
  return userDataPath("claude-product-home");
}

/** The settings overlay's claudeMdExcludes, also under the mirror's paths (Claude reads CLAUDE.md through the mirror). */
export function withClaudeMirrorExcludes(settings: string, realDir: string, mirror: string): string {
  const base = JSON.parse(settings) as Record<string, unknown>;
  if (!Array.isArray(base.claudeMdExcludes)) return settings;
  const list = base.claudeMdExcludes.filter((item): item is string => typeof item === "string");
  const mapped = list.filter((item) => item === realDir || item.startsWith(realDir + path.sep)).map((item) => mirror + item.slice(realDir.length));
  return JSON.stringify({ ...base, claudeMdExcludes: [...new Set([...list, ...mapped])] });
}

export type ClaudeProductHomeSkip = "no-real-dir" | "links-unavailable";

export function realClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"));
}

function quietly(action: () => void): void {
  try { action(); } catch { /* best effort */ }
}

/** The person's global config without per-project history and user-scope MCP servers (kept: the ones One chose). */
export function productClaudeGlobalConfig(text: string, keep: readonly string[] = [], previousOwn?: string): string {
  const source = JSON.parse(text) as Record<string, unknown>;
  const own = previousOwn ? (() => { try { return JSON.parse(previousOwn) as Record<string, unknown>; } catch { return {}; } })() : {};
  const servers = source.mcpServers && typeof source.mcpServers === "object" ? source.mcpServers as Record<string, unknown> : {};
  const keptServers = Object.fromEntries(Object.entries(servers).filter(([name]) => keep.includes(name)));
  const { projects: _projects, mcpServers: _servers, ...rest } = source;
  return JSON.stringify({ ...rest, ...(own.projects ? { projects: own.projects } : {}), mcpServers: keptServers }, null, 2);
}

function writeIfChanged(at: string, content: string): void {
  try { if (fs.readFileSync(at, "utf8") === content) return; } catch { /* absent */ }
  const tmp = `${at}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, at);
}

/** Claude's global config: inside a custom CLAUDE_CONFIG_DIR, else ~/.claude.json next to the default dir. */
export function personalClaudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(realClaudeConfigDir(env), ".claude.json") : path.join(env.HOME || os.homedir(), ".claude.json");
}

export function syncClaudeProductHome(realDir: string, mirror = claudeProductHomeDir(), options: ClaudeProductHomeOptions = {},
  personalGlobal = path.join(os.homedir(), ".claude.json")): { dir: string } | { skip: ClaudeProductHomeSkip } {
  if (!fs.existsSync(realDir)) return { skip: "no-real-dir" };
  fs.mkdirSync(mirror, { recursive: true, mode: 0o700 });
  const wanted = new Set(fs.readdirSync(realDir).filter((name) => !isClaudePersonalSessionEntry(name)));
  try {
    for (const name of wanted) {
      const at = path.join(mirror, name), target = path.join(realDir, name);
      let current: string | null = null;
      try { current = fs.readlinkSync(at); } catch { /* absent or not a link */ }
      if (current === target) continue;
      if (current !== null || fs.existsSync(at)) quietly(() => fs.rmSync(at, { recursive: false, force: true }));
      const isDir = fs.statSync(target).isDirectory();
      fs.symlinkSync(target, at, process.platform === "win32" && isDir ? "junction" : undefined);
    }
  } catch {
    return { skip: "links-unavailable" };
  }
  // Links to entries the person removed go away; the mirror's own stores stay.
  for (const name of fs.readdirSync(mirror)) {
    if (wanted.has(name) || isClaudePersonalSessionEntry(name) || name === ".claude.json") continue;
    const at = path.join(mirror, name);
    quietly(() => { if (fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at); });
  }
  const ownGlobal = path.join(mirror, ".claude.json");
  try {
    const previous = (() => { try { return fs.readFileSync(ownGlobal, "utf8"); } catch { return undefined; } })();
    writeIfChanged(ownGlobal, productClaudeGlobalConfig(fs.readFileSync(personalGlobal, "utf8"), options.keepMcpServers ?? [], previous));
  } catch { /* the person has no global config yet: Claude creates the mirror's own */ }
  return { dir: mirror };
}

/** The product run's env: the mirror as config dir, the person's own sign-in. Unchanged env when the mirror cannot hold. */
export function withClaudeProductHome(env: NodeJS.ProcessEnv = process.env, options: ClaudeProductHomeOptions = {}, mirror?: string): NodeJS.ProcessEnv {
  if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return env; // already a product env (or the caller chose)
  const real = realClaudeConfigDir(env);
  const result = syncClaudeProductHome(real, mirror, options, personalClaudeGlobalConfigPath(env));
  if (!("dir" in result)) return env;
  // A person who runs Claude with their own CLAUDE_CONFIG_DIR keeps its keychain item: name that dir for secure storage.
  const secure = env.CLAUDE_CONFIG_DIR ? real : "";
  return { ...env, CLAUDE_CONFIG_DIR: result.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure };
}

/** Claude names a project's session folder after its working directory: every non-alphanumeric becomes "-". */
function projectKey(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * A product session an older install wrote into the person's ~/.claude/projects moves into the mirror when it is next
 * resumed, so the conversation continues and leaves the person's Claude app. Returns true when the mirror now holds it.
 */
export function adoptClaudeSessionIntoProductHome(env: NodeJS.ProcessEnv, sessionId: string, cwd: string): boolean {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId) || env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined) return false;
  const mirrorFile = path.join(env.CLAUDE_CONFIG_DIR, "projects", projectKey(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(mirrorFile)) return true;
  const personalDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  const personalFile = path.join(personalDir, "projects", projectKey(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(personalFile)) return false;
  fs.mkdirSync(path.dirname(mirrorFile), { recursive: true, mode: 0o700 });
  try { fs.renameSync(personalFile, mirrorFile); }
  catch { fs.copyFileSync(personalFile, mirrorFile); quietly(() => fs.unlinkSync(personalFile)); }
  return true;
}
