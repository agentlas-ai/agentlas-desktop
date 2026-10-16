// What a product Codex run inherits from the person's own Codex setup (owner decision 2026-10-11, all users):
// nothing, except for One, and for One only the items the person switched on (capabilities/one-capabilities.ts).
//
// codex-product-home.ts decides what the run's home mirror links (memories, skills, hooks). This file decides the
// per-run `-c` overrides for what the mirror cannot express. Measured on codex-cli 0.162.1 with a stand-in
// Responses server capturing the real request body (2026-10-11):
//   - `## Memory` block: ~4,100 tokens of the person's project notes on every request, and, once the memory folder
//     is absent from the mirror, Codex runs its own memory-consolidation model calls over the shared state
//     database. `features.memories=false` removes both.
//   - Skills: Codex also reads `$HOME/.agents/skills` (a user-scope root, independent of CODEX_HOME;
//     `skip_host_skill_discovery` does not stop it). HOME cannot be moved (git, ssh and every tool the agent runs
//     read it), so each switched-off skill is disabled with `skills.config` (path + enabled=false).
//     Skills of the agent's own folder (project scope) are not touched.
//   - Plugins: `-c plugins.<id>.enabled=false` (unquoted id) removes a config-declared plugin's skills and MCP servers;
//     `-c features.plugins=false` (== `--disable plugins`) removes every plugin, including account-synced remote ones.
//   - MCP servers declared in the person's config.toml start late and add their tool schemas to every request
//     from the second one on (measured +20,794 tokens). Closed with `-c mcp_servers.<name>.enabled=false`, except
//     what the run itself bound (host), the Agentlas browser, user browser-automation servers (kept as the
//     fallback by codex-desktop-surface.ts) and, on a Computer Use grant, the desktop-control servers. A product mirror's
//     config declares no server of the person's (codex-product-home.ts allowlist), so this closes something only where
//     a run keeps the person's own home (keyring sign-in, no links).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexUserConfigTexts,
  declaredAgentlasBrowserServers,
  declaredBrowserAutomationServers,
  declaredDesktopControlServers,
  declaredUserMcpServers,
} from "./codex-desktop-surface";
import { realCodexHome, type CodexProductHomeOptions } from "./codex-product-home";
import { skillFilesUnder, type CapabilityItem, type CapabilitySelection } from "../capabilities/one-capabilities";

export interface CodexPersonalContextInput {
  /** What this run may use (selectionFor(agentId)); absent means nothing personal. */
  selection?: CapabilitySelection;
  /** The spawn passes `--ignore-user-config`: user-declared servers do not exist. */
  userConfigIgnored?: boolean;
  desktopControlGrant?: boolean;
  /** Server names Main itself binds for this run (`-c mcp_servers.<name>.*`). */
  hostServerNames?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CodexPersonalContextDecision {
  args: string[];
  /** Machine-readable receipt. */
  receipt: string;
}

function codexItems(selection: CapabilitySelection | undefined, kind: CapabilityItem["kind"]): CapabilityItem[] {
  return (selection?.items ?? []).filter((item) => item.source === "codex" && item.kind === kind);
}

/** The home-mirror options for this run: what of the person's Codex home One switched on. Undefined: nothing. */
export function codexPersonalHomeOptions(selection: CapabilitySelection | undefined, realHome = realCodexHome(process.env)): CodexProductHomeOptions["personal"] | undefined {
  if (!selection?.isOne) return undefined;
  const memories = codexItems(selection, "memory").some((item) => item.enabled);
  const skills = codexItems(selection, "skill").some((item) => item.enabled && item.path.startsWith(path.join(realHome, "skills") + path.sep));
  const hooksOn = codexItems(selection, "hook").filter((item) => item.enabled);
  const hooksJson = hooksOn.length > 0 ? filteredHooksJson(path.join(realHome, "hooks.json"), hooksOn) : null;
  if (!memories && !skills && !hooksJson) return undefined;
  return { memories, skills, hooksJson };
}

/** The person's hooks.json with only the switched-on entries; null when none remain. */
export function filteredHooksJson(file: string, enabled: readonly CapabilityItem[]): string | null {
  let json: { hooks?: Record<string, unknown> } & Record<string, unknown>;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!json.hooks || typeof json.hooks !== "object") return null;
  const keep = new Set(enabled.map((item) => /#([^#]+)$/.exec(item.path)?.[1] ?? ""));
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(json.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    groups.forEach((group, index) => {
      const list = group && typeof group === "object" ? (group as { hooks?: unknown }).hooks : null;
      if (!Array.isArray(list)) return;
      const subs = list.filter((_, sub) => keep.has(`${event}/${index}/${sub}`));
      if (subs.length > 0) kept.push({ ...(group as object), hooks: subs });
    });
    if (kept.length > 0) hooks[event] = kept;
  }
  return Object.keys(hooks).length > 0 ? JSON.stringify({ ...json, hooks }, null, 2) : null;
}

export function codexPersonalContextArgs(input: CodexPersonalContextInput = {}): CodexPersonalContextDecision {
  const env = input.env ?? process.env;
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const selection = input.selection;
  const args: string[] = [];
  const home = path.resolve(cwd, env.HOME || os.homedir());
  const codexHome = path.resolve(cwd, env.CODEX_HOME || path.join(home, ".codex"));
  const personal = codexPersonalHomeOptions(selection, realCodexHome(env));

  // Memories: on only when One switched a Codex memory source on.
  const memoriesOn = personal?.memories === true;
  if (!memoriesOn) args.push("-c", "features.memories=false");

  // Codex's own thread goals stay off in every product run. A goal makes Codex start the next turn by itself the moment a
  // turn ends with the goal open, so a run waiting on outside work re-reads its whole context in a loop. Dev replay r02
  // (2026-10-17, TCIagent graph step1, owner's config.toml [features] goals = true): the step called create_goal, then
  // four "Continue working toward the active thread goal" turns in two minutes (~1.45M input tokens) only re-checked
  // teammates that were still working. Agentlas owns continuation (Goals, a graph team step waiting on its teammates).
  args.push("-c", "features.goals=false");

  // Skills: every Codex skill that is switched off, in each root this run's Codex will actually scan.
  const scanned = [path.join(home, ".agents", "skills") + path.sep];
  if (codexHome === realCodexHome(env) || personal?.skills) scanned.push(path.join(realCodexHome(env), "skills") + path.sep);
  // Every SKILL.md actually present in those roots is off unless the selection switched that exact file on. The
  // capability inventory alone left gaps (scratch-named or deep folders, same-named skills in two roots stored
  // once, no selection at all), and each gap put the person's skills into product runs' <skills_instructions>.
  // Compare by real path: the run's home mirror links the person's skills folder, so Codex sees the mirror path
  // while the switch was recorded on the real one. The emitted path is the one Codex itself discovers.
  const real = (file: string): string => { try { return fs.realpathSync(file); } catch { return file; } };
  const enabledSkillPaths = new Set(codexItems(selection, "skill").filter((item) => item.enabled).map((item) => real(item.path)));
  const present = new Set<string>();
  for (const root of scanned) for (const file of skillFilesUnder(root.slice(0, -path.sep.length))) present.add(file);
  for (const item of codexItems(selection, "skill")) if (!item.enabled && scanned.some((root) => item.path.startsWith(root))) present.add(item.path);
  const disabledSkills = [...present].filter((file) => !enabledSkillPaths.has(real(file))).sort();
  if (disabledSkills.length > 0) {
    args.push("-c", `skills.config=[${disabledSkills.map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(",")}]`);
  }

  // Plugins: with none switched on (every non-One run, and One before the person picks any), the whole plugin
  // feature goes off. Per-plugin `plugins.<id>.enabled=false` only reaches plugins declared in config.toml; the
  // account-synced openai-curated-remote ones (figma, data-analytics, notion, ... ) are not declared there and kept
  // listing 15-30K chars of skills in every request, down to 2.4K-char judgment runs (measured 2026-10-13).
  // Agentlas reaches its own tools through the MCP servers Main binds, not through Codex plugins.
  const codexPlugins = codexItems(selection, "plugin");
  const pluginsOn = codexPlugins.some((item) => item.enabled);
  const plugins = codexPlugins.filter((item) => !item.enabled && /^[A-Za-z0-9_@.-]+$/.test(item.name)).map((item) => item.name);
  if (!pluginsOn) args.push("-c", "features.plugins=false");
  else for (const id of plugins) args.push("-c", `plugins.${id}.enabled=false`);

  // Connectors: switched-off servers, except what the run binds itself or keeps as a documented fallback. Only a server
  // the config this run reads actually declares can be closed: `-c mcp_servers.<name>.enabled=false` for any other name
  // is a transport-less server and Codex refuses to start ("invalid transport", codex-cli 0.163.0). The inventory lists
  // the person's own servers, and a product mirror's config declares none of them (codex-product-home.ts allowlist).
  const closed: string[] = [];
  if (!input.userConfigIgnored) {
    const keep = new Set(input.hostServerNames ?? []);
    const declared = new Set<string>();
    for (const text of codexUserConfigTexts({ env, cwd })) {
      for (const name of [...declaredAgentlasBrowserServers(text), ...declaredBrowserAutomationServers(text), ...(input.desktopControlGrant ? declaredDesktopControlServers(text) : [])]) keep.add(name);
      for (const name of declaredUserMcpServers(text)) declared.add(name);
    }
    for (const item of codexItems(selection, "connector")) {
      if (!item.enabled && /^[A-Za-z0-9_-]+$/.test(item.name) && !keep.has(item.name) && declared.has(item.name)) closed.push(item.name);
    }
  }
  const servers = [...new Set(closed)].sort();
  for (const server of servers) args.push("-c", `mcp_servers.${server}.enabled=false`);
  return {
    args,
    receipt: `[codex-personal] one=${selection?.isOne === true ? "yes" : "no"} memories=${memoriesOn ? "on" : "off"} skills_disabled=${disabledSkills.length} plugins=${pluginsOn ? "on" : "off"} plugins_disabled=${pluginsOn ? plugins.length : "all"} hooks=${personal?.hooksJson ? "on" : "off"} mcp_closed=${servers.join("|") || "-"}`,
  };
}
