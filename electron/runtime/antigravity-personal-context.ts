// Antigravity (agy) product runs: the person's own GEMINI.md, skills, plugins, hooks and MCP servers stay out; only
// One gets back the items the person switched on (owner decision 2026-10-11, all users).
//
// agy has no config-dir flag or env var; it reads ~/.gemini under HOME. So a product run gets a HOME of its own: a
// directory whose entries are symlinks to EVERY entry of the real HOME (Library included, so the login keychain and
// its search list in ~/Library/Preferences resolve exactly as for the person; a bare HOME made macOS show "keychain
// not found" for the 'antigravity' sign-in item on 2026-10-12), except `.gemini`, which is a filtered mirror
// (config-home-mirror.ts). Sign-in (antigravity-cli/antigravity-oauth-token, oauth_creds.json, the keychain item),
// conversations, brain and project registrations stay one and the same file through the links, so a session written
// through the mirror resumes from either side. The real folders are only ever READ here.
//
// Left out of `.gemini` (the context agy would otherwise load): GEMINI.md (+ backups), commands/, extensions/,
// config/{skills,plugins,sidecars,hooks.json,mcp_config.json}, the per-server MCP tool descriptors (mcp/), the
// knowledge store, plugin data and global workflows. config/config.json is rewritten without its plugin and sidecar
// lists. MCP servers are the ones this run's own authorized MCP config asked for plus the ones One switched on.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import type { CapabilityItem, CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";

/** Antigravity's conversation stores (per-conversation brain, annotations, recordings). Never linked into a product mirror. */
const AGY_PERSONAL_SESSION_ENTRIES = new Set(["conversations", "brain", "annotations", "implicit", "html_artifacts",
  "browser_recordings", "code_tracker", "context_state"]);

export type AgyProductHomeSkip = "unsupported-platform" | "no-real-gemini" | "no-sign-in-files" | "links-unavailable";

function oneGemini(selection: CapabilitySelection | undefined, kind: CapabilityKind): CapabilityItem[] {
  if (selection?.isOne !== true) return [];
  return selection.items.filter((item) => item.source === "gemini" && item.kind === kind && item.enabled);
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Fills a mirror folder with links to exactly `wanted` (name -> target); links it no longer wants are removed. */
function syncLinkFolder(dir: string, wanted: ReadonlyMap<string, string>): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) {
    const at = path.join(dir, name);
    let link: string | null = null;
    try { link = fs.readlinkSync(at); } catch { /* a file the CLI made: left alone */ }
    if (link !== null && wanted.get(name) !== link) { try { fs.unlinkSync(at); } catch { /* raced */ } }
  }
  for (const [name, target] of wanted) {
    const at = path.join(dir, name);
    try { fs.lstatSync(at); } catch {
      try { fs.symlinkSync(target, at); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }
}

export interface AgyProductHomeInput {
  /** The person's real HOME. */
  realHome: string;
  selection: CapabilitySelection | undefined;
  /** MCP server keys this run's authorized MCP config asked for (their entries are read from the real mcp_config.json). */
  runMcpKeys?: readonly string[];
  mirrorRoot?: string;
}

/** Where the product HOME of `realHome` lives (the One variant carries "-one"); syncAgyProductHome builds it there. */
export function agyProductHomePath(realHome: string, isOne: boolean, mirrorRoot?: string): string {
  const root = mirrorRoot ?? userDataPath("agy-product-home");
  return path.join(root, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (isOne ? "-one" : ""));
}

/** Builds or refreshes the product HOME. Never throws; a skip means the run keeps the real HOME. */
export function syncAgyProductHome(input: AgyProductHomeInput): { home: string } | { skip: AgyProductHomeSkip } {
  if (process.platform !== "darwin" && process.platform !== "linux") return { skip: "unsupported-platform" };
  const { realHome, selection } = input;
  const realGemini = path.join(realHome, ".gemini");
  if (!fs.existsSync(realGemini)) return { skip: "no-real-gemini" };
  // Without a sign-in file there is nothing proving the CLI's sign-in survives a mirror: keep the real HOME.
  const signInFiles = [path.join(realGemini, "antigravity-cli", "antigravity-oauth-token"), path.join(realGemini, "oauth_creds.json")];
  if (!signInFiles.some((file) => fs.existsSync(file))) return { skip: "no-sign-in-files" };
  const isOne = selection?.isOne === true;
  const home = agyProductHomePath(realHome, isOne, input.mirrorRoot);
  const gemini = path.join(home, ".gemini");
  const realConfig = path.join(realGemini, "config");
  try {
    syncConfigHomeMirror({ realDir: realHome, mirrorDir: home, hide: () => false, folders: [".gemini"] });

    const memory = oneGemini(selection, "memory").find((item) => item.name === "GEMINI.md");
    syncConfigHomeMirror({
      realDir: realGemini,
      mirrorDir: gemini,
      hide: (name) => (/^GEMINI\.md/.test(name) && !(name === "GEMINI.md" && memory))
        || name === "commands" || name === "extensions" || /^extension_integrity\.json/.test(name)
        || /hephaestus-extension-source/.test(name) || /agentlas-router\.lock$/.test(name),
      folders: ["config", "antigravity", "antigravity-cli"],
    });
    // The CLI's own data folders: sign-in, binaries and projects stay linked; the stores that carry the person's memory
    // and MCP tool descriptors are hidden, and so are the conversation stores (owner 2026-10-12: Agentlas sessions are
    // kept apart from personal sessions in every app). Antigravity creates its own conversation store in the mirror.
    for (const name of ["antigravity", "antigravity-cli"]) {
      const realDir = path.join(realGemini, name);
      if (!fs.existsSync(realDir)) continue;
      syncConfigHomeMirror({
        realDir,
        mirrorDir: path.join(gemini, name),
        hide: (entry) => entry === "knowledge" || entry === "mcp" || entry === "plugin_data" || entry === "global_workflows" || /^mcp_config\.json/.test(entry)
          || AGY_PERSONAL_SESSION_ENTRIES.has(entry) || /^conversation_summaries\.db(?:-wal|-shm)?$/.test(entry) || /_summaries_proto\.pb$/.test(entry),
      });
    }

    // config/: projects (the app's browser project registrations) and settings stay; skills/plugins/hooks/MCP are rebuilt.
    const skills = oneGemini(selection, "skill");
    const plugins = oneGemini(selection, "plugin");
    const hooks = oneGemini(selection, "hook");
    const servers = oneGemini(selection, "connector");
    const keepPlugins = new Set(plugins.map((item) => path.basename(item.path)));
    const config = readJsonObject(path.join(realConfig, "config.json"));
    const own: Record<string, string> = {};
    if (config) {
      const next: Record<string, unknown> = { ...config };
      const pluginTable = config.plugins && typeof config.plugins === "object" ? (config.plugins as Record<string, unknown>) : {};
      next.plugins = Object.fromEntries(Object.entries(pluginTable).filter(([name]) => keepPlugins.has(name)));
      delete next.sidecars;
      own["config.json"] = `${JSON.stringify(next, null, 2)}\n`;
    }
    const realMcp = readJsonObject(path.join(realConfig, "mcp_config.json"));
    const realServers = (realMcp?.mcpServers && typeof realMcp.mcpServers === "object" ? (realMcp.mcpServers as Record<string, unknown>) : {});
    const wantedServers = new Set([...(input.runMcpKeys ?? []), ...servers.map((item) => item.name)]);
    own["mcp_config.json"] = `${JSON.stringify({ ...(realMcp ?? {}), mcpServers: Object.fromEntries(Object.entries(realServers).filter(([name]) => wantedServers.has(name))) }, null, 2)}\n`;
    const realHooks = readJsonObject(path.join(realConfig, "hooks.json"));
    const keepHooks = new Set(hooks.map((item) => item.name));
    if (realHooks && keepHooks.size > 0) own["hooks.json"] = `${JSON.stringify(Object.fromEntries(Object.entries(realHooks).filter(([name]) => keepHooks.has(name))), null, 2)}\n`;
    else own["hooks.json"] = "{}\n";
    if (fs.existsSync(realConfig)) {
      syncConfigHomeMirror({
        realDir: realConfig,
        mirrorDir: path.join(gemini, "config"),
        hide: (name) => /^(hooks|mcp_config)\.json/.test(name) || name === "config.json" || name === "sidecars",
        folders: ["skills", "plugins"],
        own,
      });
    }
    syncLinkFolder(path.join(gemini, "config", "skills"), new Map(skills.map((item) => {
      const target = path.dirname(item.path);
      return [path.basename(target), target] as const;
    })));
    syncLinkFolder(path.join(gemini, "config", "plugins"), new Map(plugins.map((item) => [path.basename(item.path), item.path] as const)));
    if (!isMirrorLink(home, "Library") && fs.existsSync(path.join(realHome, "Library"))) return { skip: "links-unavailable" };
    if (!signInFiles.every((file) => !fs.existsSync(file) || fs.existsSync(path.join(gemini, path.relative(realGemini, file))))) return { skip: "links-unavailable" };
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** MCP server keys of a run's authorized MCP config file (never throws). */
export function runMcpKeysOf(mcpConfigPath: string | undefined): string[] {
  if (!mcpConfigPath) return [];
  const parsed = readJsonObject(mcpConfigPath);
  const servers = parsed?.mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

/**
 * The run environment for agy: HOME points at the product mirror. `env.AGENTLAS_AGY_KEEP_HOME=1` or a missing safe
 * mirror keeps the real HOME. Callers must run this AFTER the run's MCP servers were written to the real config.
 */
export function withAgyProductHome(env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined, mcpConfigPath: string | undefined): NodeJS.ProcessEnv {
  if (env.AGENTLAS_AGY_KEEP_HOME === "1") return env;
  const realHome = env.AGENTLAS_AGY_REAL_HOME || os.homedir();
  // A HOME that is already a product mirror (resident re-entry) is kept.
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(realHome)) return env;
  const mirror = syncAgyProductHome({ realHome, selection, runMcpKeys: runMcpKeysOf(mcpConfigPath) });
  if (!("home" in mirror)) return env;
  return { ...env, HOME: mirror.home, AGENTLAS_AGY_REAL_HOME: realHome };
}
