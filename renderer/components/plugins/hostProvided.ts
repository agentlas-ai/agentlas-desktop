// Which installed MCP rows did the Agentlas host register for itself?
//
// The registry (electron/mcp-tools/registry.ts) stores host-seeded rows and
// user-added rows in the same table with no "builtin" column, so the plugin
// screen cannot ask the row directly. The host's own discriminator is the
// launch: a host-provided server is started by the Agentlas executable itself
// (`command === process.execPath`, electron/mcp-tools/mcp-config.ts:467):
//   · built-in resolvers (time, computer use, workspace preview, agent mail,
//     One team, UI schema, turn tools, browser) — electron/plugins/builtin.ts:112-123
//   · bundled plugin releases (Science data/statistics/skills) launched through
//     plugin-tool-launcher.js — electron/plugins/tool-provider.ts:169-170, 263-276;
//     only materializeBuiltinPlugins() writes that root (electron/plugins/materialize.ts:586-606)
//   · the Agentlas runtime binary under ~/.agentlas/ (Hephaestus Network,
//     electron/mcp-tools/catalog.ts:268-282)
// The renderer never sees process.execPath, so it learns it from the host
// catalog (mcpTools.listCatalog): only host launch contracts use that
// executable. Display names are never consulted.
import type { InstalledMcpServer, McpToolCatalogEntry } from "@/lib/types";

const DEDICATED_LAUNCHER = "plugin-tool-launcher.js";

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

/** tool-provider.ts:263 isDedicatedPluginToolLaunch, mirrored. */
function isDedicatedPluginLaunch(row: { command?: string | null; args?: string[] }): boolean {
  const args = row.args ?? [];
  return Boolean(row.command)
    && args.length >= 8
    && basename(args[0]) === DEDICATED_LAUNCHER
    && args[1] === "--plugin-root"
    && args[3] === "--release-digest"
    && args[5] === "--entry"
    && args.includes("--", 7);
}

/** builtin.ts RESOLVERS inline form: [execPath, "-e", bootstrap, payload]. */
function isInlineHostLaunch(row: { command?: string | null; args?: string[] }): boolean {
  return Boolean(row.command) && row.args?.[0] === "-e";
}

function isAgentlasHomeCommand(command: string | null | undefined): boolean {
  return !!command && /^~[\\/]\.agentlas[\\/]/.test(command);
}

export interface HostProvidedIndex {
  /** The Agentlas executable path(s). */
  executables: Set<string>;
  /** Catalog ids whose catalog launch is a host launch contract. */
  catalogIds: Set<string>;
}

/** Learn the host launch identity from the host catalog and the registry rows. */
export function hostProvidedIndex(catalog: McpToolCatalogEntry[], installed: InstalledMcpServer[]): HostProvidedIndex {
  const executables = new Set<string>();
  for (const entry of catalog) {
    if (entry.transport !== "stdio" || !entry.command) continue;
    if (isInlineHostLaunch(entry) || isDedicatedPluginLaunch(entry)) executables.add(entry.command);
  }
  for (const server of installed) {
    if (server.transport === "stdio" && server.command && isDedicatedPluginLaunch(server)) executables.add(server.command);
  }
  const catalogIds = new Set<string>();
  for (const entry of catalog) {
    if (entry.transport !== "stdio" || !entry.command) continue;
    if (executables.has(entry.command) || isDedicatedPluginLaunch(entry) || isAgentlasHomeCommand(entry.command)) catalogIds.add(entry.id);
  }
  return { executables, catalogIds };
}

export function isHostProvidedServer(server: InstalledMcpServer, index: HostProvidedIndex): boolean {
  if (server.transport !== "stdio" || !server.command) return false;
  if (isDedicatedPluginLaunch(server)) return true;
  if (index.executables.has(server.command)) return true;
  // A row written by an older Desktop build keeps its old executable path until
  // the host refreshes it; its catalog identity still names a host launch.
  if (server.catalogId && index.catalogIds.has(server.catalogId)) return true;
  return isAgentlasHomeCommand(server.command);
}
