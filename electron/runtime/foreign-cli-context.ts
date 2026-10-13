// Personal context that a foreign CLI pulls in (owner decision 2026-10-11, all users): a product run carries none of
// the person's own instructions, memory, skills, plugins, hooks or MCP servers; only One gets the items the person
// switched on (capabilities/one-capabilities.ts).
//
// Grok has two separate leaks, closed in two ways (measured on grok 1.0.51 with `grok inspect --json`):
//
//  1. It scans OTHER tools' folders by default ("Claude compatibility ... enabled by default"):
//     `~/.claude/Claude.md`, ~/.claude/settings(.local).json permissions, skills, `~/.claude.json` MCP servers,
//     hooks, and the same for ~/.cursor and ~/.codex. Each scan has an env switch
//     GROK_<CLAUDE|CURSOR|CODEX>_<SKILLS|RULES|AGENTS|MCPS|HOOKS|SESSIONS>_ENABLED. `AGENTS` is the one that
//     governs Claude.md (RULES governs rules/*.md). With every cell false `grok inspect` marks all of them
//     `[disabled]` and the Harness Compatibility table shows OFF (env).
//
//  2. Its OWN folder (GROK_HOME, default ~/.grok): Agents.md (global instructions), memory-v2, skills/, hooks/,
//     installed-plugins and the `[mcp_servers.*]` / `[[hooks.*]]` of config.toml. No switch exists for the
//     instructions file, so a product run points GROK_HOME at a mirror (config-home-mirror.ts) in which every other
//     entry is a symlink (auth.json and trust files stay one and the same file, so the sign-in works; the session store
//     is the mirror's own since 2026-10-12) and config.toml is the person's own with those tables cut out.
//     Skills Grok also reads from the generic `~/.agents/skills` root are hidden with `[skills] ignore`.
//     Memory is turned off with GROK_MEMORY=0.
//
// Not closable (reported in the receipt, not hidden): plugins that Grok discovers from `~/.claude/plugins` bring
// their MCP servers, hooks and agents; no env switch or `[plugins] disabled` entry removed them in the measurement.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import { withCliProductHome } from "./cli-product-homes";
import type { CapabilityItem, CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";

const GROK_CELLS: ReadonlyArray<{ cell: string; kind: CapabilityKind }> = [
  { cell: "SKILLS", kind: "skill" },
  { cell: "RULES", kind: "memory" },
  { cell: "AGENTS", kind: "memory" },
  { cell: "MCPS", kind: "connector" },
  { cell: "HOOKS", kind: "hook" },
];

function oneHas(selection: CapabilitySelection | undefined, source: CapabilityItem["source"], kind?: CapabilityKind): CapabilityItem[] {
  if (selection?.isOne !== true) return [];
  return selection.items.filter((item) => item.source === source && item.enabled && (kind === undefined || item.kind === kind));
}

export function grokCompatEnv(selection: CapabilitySelection | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of ["claude", "cursor", "codex"] as const) {
    for (const { cell, kind } of GROK_CELLS) {
      // Codex has no rules/agents/mcps/hooks cells of its own in Grok 1.0.51 except skills, hooks and sessions; the
      // extra variables are harmless where the CLI does not know them.
      if (oneHas(selection, source, kind).length === 0) env[`GROK_${source.toUpperCase()}_${cell}_ENABLED`] = "false";
    }
    // Importing another tool's past sessions is never a product need.
    env[`GROK_${source.toUpperCase()}_SESSIONS_ENABLED`] = "false";
  }
  if (oneHas(selection, "grok", "memory").length === 0) env.GROK_MEMORY = "0";
  return env;
}

export function realGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.GROK_HOME || path.join(env.HOME || os.homedir(), ".grok"));
}

/** config.toml tables that are the person's own context: their MCP servers, hooks, skills and memory settings. */
const GROK_CONTEXT_TABLE = /^(mcp_servers|hooks|skills|memory|memory_v2)(\.|$)/;

/** The person's config.toml with the context tables cut out, except the MCP servers One switched on. */
export function grokConfigWithoutPersonalContext(text: string, keepServers: ReadonlySet<string>, skillsIgnore: readonly string[]): string {
  const out: string[] = [];
  let keep = true;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[\[?\s*([^\[\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (table) {
      const name = table[1].replace(/"/g, "");
      const server = /^mcp_servers\.([^.]+)/.exec(name);
      keep = server ? keepServers.has(server[1]) : !GROK_CONTEXT_TABLE.test(name);
    }
    if (keep) out.push(line);
  }
  if (skillsIgnore.length > 0) out.push("", "[skills]", `ignore = [${skillsIgnore.map((p) => JSON.stringify(p)).join(", ")}]`);
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

const HIDDEN_BY_DEFAULT = new Set(["Agents.md", "AGENTS.md", "agents.md", "memory-v2", "installed-plugins", "hooks", "skills", "config.toml"]);
/**
 * Grok's session store and per-session state (grok.db holds sessions, messages, tool calls and compactions). A product
 * mirror never links them, so Agentlas sessions stay out of the person's Grok history and theirs out of the product
 * (owner 2026-10-12: Agentlas sessions are kept apart from personal sessions in every app). Grok creates its own copies
 * in the mirror. Sign-in, binaries, model cache and trust files are still linked.
 */
const GROK_PERSONAL_SESSION_ENTRIES = new Set(["grok.db", "grok.db-shm", "grok.db-wal", "sessions", "active_sessions.json",
  "active_sessions.lock", "delegations", "logs", "memtrace", "sandbox-events.jsonl", "slash-mru.json", "tip_cursor.json",
  "upload_queue", "worktrees.db", "worktrees.db-shm", "worktrees.db-wal"]);

export type GrokProductHomeSkip = "no-real-home" | "no-file-sign-in" | "links-unavailable";

export function syncGrokProductHome(realHome: string, selection: CapabilitySelection | undefined, mirrorRoot = userDataPath("grok-product-home")): { home: string } | { skip: GrokProductHomeSkip } {
  let entries: string[];
  try { entries = fs.readdirSync(realHome); } catch { return { skip: "no-real-home" }; }
  if (!entries.includes("auth.json")) return { skip: "no-file-sign-in" };
  const isOne = selection?.isOne === true;
  const memoryFiles = oneHas(selection, "grok", "memory");
  const instructions = memoryFiles.find((item) => item.path === path.join(realHome, item.name) && item.name !== "memory-v2");
  const wantMemoryV2 = memoryFiles.some((item) => item.name === "memory-v2");
  const keepServers = new Set(oneHas(selection, "grok", "connector").map((item) => item.name));
  const codexSkillsOn = oneHas(selection, "codex", "skill").some((item) => item.path.startsWith(path.join(os.homedir(), ".agents", "skills") + path.sep));
  const home = path.join(mirrorRoot, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (isOne ? "-one" : ""));
  let config = "";
  try { config = fs.readFileSync(path.join(realHome, "config.toml"), "utf8"); } catch { /* none */ }
  try {
    syncConfigHomeMirror({
      realDir: realHome,
      mirrorDir: home,
      hide: (name) => GROK_PERSONAL_SESSION_ENTRIES.has(name)
        || (HIDDEN_BY_DEFAULT.has(name) && !(name === instructions?.name) && !(name === "memory-v2" && wantMemoryV2)),
      folders: ["hooks", "skills"],
      own: { "config.toml": grokConfigWithoutPersonalContext(config, keepServers, codexSkillsOn ? [] : [path.join(os.homedir(), ".agents", "skills")]) },
    });
    // hooks/ and skills/ are folders of links to exactly the files One switched on.
    for (const [folder, items] of [["hooks", oneHas(selection, "grok", "hook")], ["skills", oneHas(selection, "grok", "skill")]] as const) {
      const dir = path.join(home, folder);
      const wanted = new Map(items.map((item) => {
        const target = folder === "skills" ? path.dirname(item.path) : item.path;
        return [path.basename(target), target] as const;
      }));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(dir)) {
        const at = path.join(dir, name);
        let link: string | null = null;
        try { link = fs.readlinkSync(at); } catch { /* a file the CLI made: left alone */ }
        if (link !== null && wanted.get(name) !== link) { try { fs.unlinkSync(at); } catch { /* raced */ } }
      }
      for (const [name, target] of wanted) {
        const at = path.join(dir, name);
        try { fs.lstatSync(at); } catch { try { fs.symlinkSync(target, at); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      }
    }
    if (!isMirrorLink(home, "auth.json")) return { skip: "links-unavailable" };
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** The run environment for an ACP agent: foreign-tool context switched off unless One chose it. */
export function withForeignCliContext(agentKind: string, env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined): NodeJS.ProcessEnv {
  // Kimi, Cursor and Copilot: their config folder (sessions, instruction files, MCP lists) is a product mirror
  // (cli-product-homes.ts). Never throws: a host without a writable app folder keeps the person's folder.
  if (agentKind === "kimi" || agentKind === "cursor" || agentKind === "github-copilot-cli") {
    try { return withCliProductHome(agentKind, env, selection); } catch { return env; }
  }
  if (agentKind !== "grok") return env;
  const out: NodeJS.ProcessEnv = { ...env, ...grokCompatEnv(selection) };
  const real = realGrokHome(process.env);
  // A GROK_HOME Main chose for this run is kept; only the person's own folder is swapped for its mirror.
  if (env.GROK_HOME && path.resolve(env.GROK_HOME) !== real) return out;
  try {
    const mirror = syncGrokProductHome(real, selection);
    if ("home" in mirror) out.GROK_HOME = mirror.home;
  } catch {
    // No writable app folder (a host outside the app): the run keeps the real folder, with the cells above still off.
  }
  return out;
}
