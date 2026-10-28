import type { InstalledMcpServer } from "../../shared/types";

/*
 * Host tool servers: a tool server a product domain mints for one turn and the shared config builder carries beside the
 * installed servers (PLAN S2 docs/2026-10-28-science-harness-unify). Science is the first: its tools used to replace the
 * turn's whole MCP config, with their own approval, Codex home, search and first list. Now the domain hands Main a launch,
 * declarations and the tools to list first, and everything else is the shared path every Work turn takes:
 *   - mcp-config.ts serializes it like any keyed stdio server (secret aliases, the Main proxy gate, Codex flags, the
 *     prepared-transport seal), so the approval arbiter and the codex-desktop-surface home are the same as Work's;
 *   - the first list is a tool surface (hephaestus-tool-surface.ts) whose other tools stay reachable: deferred behind the
 *     host loop's lazy menu, and found by the common search (harness_search, agentlas_tools_list query) and called through
 *     tool.call on the runtimes that list only the first tools;
 *   - the declarations (description, group, fields, artifact kinds, effect) are what that search ranks.
 * A host tool server is not an installed row: it is never seeded, shown in settings, or launched outside its turn.
 * No Electron import: the daemon loads this.
 */

export interface HostToolDeclaration {
  /** Raw MCP tool name, as the server lists it. */
  readonly name: string;
  readonly description: string;
  /** The tool's group inside the server (a Science Lab), shown and ranked with the tool. */
  readonly group: { readonly id: string; readonly label: string };
  readonly fields: readonly string[];
  readonly artifactKinds: readonly string[];
  readonly effect: "read" | "effect";
}

export interface HostToolServer {
  /** MCP config key and catalog id; never collides with an installed row's key (mcp-config.ts refuses). */
  readonly configKey: string;
  /** Shown name of the server. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Values allowed in the config file and argv. */
  readonly publicEnv: Readonly<Record<string, string>>;
  /** Credentials: carried as runtime secret aliases, never written to the config file or argv. */
  readonly secretEnv: Readonly<Record<string, string>>;
  readonly declarations: readonly HostToolDeclaration[];
  /** Raw names listed directly on every runtime. Every other declared tool is reachable through discovery. */
  readonly firstList: readonly string[];
  /** Built-in plugins whose runtimes this server executes itself: their standalone servers are not added to the same turn
   *  (the same capability listed twice let a model loop on the lower-level copy; tool-control-server.ts history). */
  readonly supersedesPlugins?: readonly string[];
  /** The minting domain's own currentness (the turn still holds the grant). Read by the prepared-config seal. */
  isCurrent(): boolean;
}

/** The registry row the shared serializer and the prepared-transport seal read. Not persisted. */
export function hostToolServerRow(server: HostToolServer): InstalledMcpServer {
  return {
    id: server.configKey, catalogId: server.configKey, name: server.name, nameEn: server.name,
    transport: "stdio", command: server.command, args: [...server.args], url: null,
    // Every declared value is delivered as a runtime alias (mcp-config.ts); the wrapper sets Node mode for this executable itself.
    envKeys: [...new Set([...Object.keys(server.publicEnv), ...Object.keys(server.secretEnv)])].filter((key) => key !== "ELECTRON_RUN_AS_NODE").sort(), configurationValid: true, enabled: true, installedAt: new Date(0).toISOString(),
  };
}

/** Validates a minted server before any of it reaches a config file. */
export function assertHostToolServer(server: HostToolServer): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(server.configKey)) throw new Error("host_tool_server_key_invalid");
  if (!server.command || !Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) throw new Error("host_tool_server_launch_invalid");
  for (const env of [server.publicEnv, server.secretEnv]) {
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string") throw new Error("host_tool_server_env_invalid");
    }
  }
  if (Object.keys(server.publicEnv).some((key) => Object.prototype.hasOwnProperty.call(server.secretEnv, key))) throw new Error("host_tool_server_env_invalid");
  const names = new Set(server.declarations.map((tool) => tool.name));
  if (names.size !== server.declarations.length) throw new Error("host_tool_server_declaration_duplicate");
  if (server.firstList.some((name) => !names.has(name))) throw new Error("host_tool_server_first_list_undeclared");
  if (typeof server.isCurrent !== "function") throw new Error("host_tool_server_currentness_missing");
}

/*
 * The declarations of a prepared config's host servers, by the config file's path (the same key prepared-transport.ts and
 * the tool-surface registry use). The common search reads them for the calling run only: a run sees the servers its own
 * config carries, never another run's. An entry lives exactly as long as the config (its cleanup removes it).
 */
const catalogs = new Map<string, readonly HostToolServer[]>();

export function registerHostToolCatalog(configPath: string, servers: readonly HostToolServer[]): () => void {
  if (!servers.length) return () => {};
  const frozen = Object.freeze([...servers]);
  catalogs.set(configPath, frozen);
  return () => { if (catalogs.get(configPath) === frozen) catalogs.delete(configPath); };
}

export function hostToolCatalog(configPath: string | undefined): readonly HostToolServer[] {
  return configPath ? catalogs.get(configPath) ?? [] : [];
}

/** The searchable text of one declaration: its name words, group, fields and artifact kinds rank as id-like terms. */
export function hostToolRankTerms(server: HostToolServer, tool: HostToolDeclaration): string[] {
  return [server.configKey, tool.group.id, tool.group.label, ...tool.fields, ...tool.artifactKinds, tool.name.replace(/_/g, " ")];
}
