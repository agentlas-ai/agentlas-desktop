// Built-in plugin packages are the source of truth for their catalog rows.
//
// Before this module the four built-in tool rows were hand-written twice: once as
// `McpToolCatalogEntry` literals in mcp-tools/catalog.ts, and (conceptually) once more
// wherever their presentation was described. Two hand-maintained copies of the same fact
// drift — that is the failure this repo has hit repeatedly. Now `plugins/<slug>/plugin.json`
// carries the declaration and this module derives the catalog row from it.
//
// ★ What this module deliberately does NOT do: change any launch value. The strings it
// emits are byte-identical to what catalog.ts held before, because `installFromCatalog`
// persists `args` verbatim into `mcp_servers.args_json` and only expands `~` at spawn time
// (mcp-config.ts:46, client.ts:349). Changing the stored string here would silently rewrite
// every existing installation's row on the next `refreshInstalledCatalogServer`.
//
// The manifests are imported (not read from disk) so they are bundled by tsc into dist/ —
// a runtime path lookup would work in the repo and fail in a packaged app.
import type { McpToolCatalogEntry } from "../../shared/types";
import { BROWSER_CDP_LAUNCHER_BASENAME } from "../mcp-tools/browser-cdp-launcher";
import { computerUseMcpLaunchArgs } from "../computer-use/mcp-server";
import { systemTimeMcpLaunchArgs } from "../mcp-tools/system-time-server";
import browserPlugin from "../../plugins/agentlas-browser/plugin.json";
import computerUsePlugin from "../../plugins/agentlas-computer-use/plugin.json";
import timePlugin from "../../plugins/agentlas-time/plugin.json";

/** Every built-in plugin package bundled with the app. */
const BUILTIN_PLUGINS = [browserPlugin, computerUsePlugin, timePlugin] as const;

/**
 * The host-owned closed list of resolvers (PLUGIN-SPEC.md §2.3).
 *
 * A `kind:"builtin"` tool declares a resolver NAME, never a command line. For the two
 * `form:"inline"` tools that is the whole point: the audited source rides in argv, so there
 * is no disk path to swap between validation and spawn (INV-1). Baking their argv into a
 * manifest string would destroy that guarantee.
 */
const RESOLVERS: Record<string, () => { command: string; args: string[] }> = {
  // Materialized form: the launcher file is written by materializeBrowserCdpLauncher().
  // The stored arg keeps its `~` prefix, exactly as the catalog held it.
  "browser-cdp": () => ({
    command: process.execPath,
    args: [`~/.agentlas/${BROWSER_CDP_LAUNCHER_BASENAME}`],
  }),
  // Inline form — argv carries the audited, hash-checked source (INV-1..INV-4).
  "computer-use": () => ({ command: process.execPath, args: computerUseMcpLaunchArgs() }),
  "system-time": () => ({ command: process.execPath, args: systemTimeMcpLaunchArgs() }),
};

interface PluginToolSurface {
  name: string;
  nameEn?: string;
  description: string;
  descriptionEn?: string;
  category: string;
  brandColor: string;
  mark: string;
  docsUrl?: string;
}

interface PluginHostChannel {
  id: string;
  env: string;
  mode: string;
}

interface PluginTool {
  id: string;
  capability?: string;
  resolver?: string;
  kind: string;
  envKeys?: string[];
  hostChannels?: PluginHostChannel[];
  surface?: PluginToolSurface;
}

function toCatalogEntry(tool: PluginTool, slug: string): McpToolCatalogEntry {
  const surface = tool.surface;
  if (!surface) {
    throw new Error(`Built-in plugin ${slug}: tool ${tool.id} has no surface (PLUGIN-SPEC G14)`);
  }
  const resolve = tool.resolver ? RESOLVERS[tool.resolver] : undefined;
  if (!resolve) {
    throw new Error(
      `Built-in plugin ${slug}: tool ${tool.id} declares resolver "${tool.resolver}", which is not in the host's closed list (PLUGIN-SPEC G9)`,
    );
  }
  const launch = resolve();
  return {
    id: tool.id,
    name: surface.name,
    nameEn: surface.nameEn ?? surface.name,
    description: surface.description,
    descriptionEn: surface.descriptionEn ?? surface.description,
    category: surface.category as McpToolCatalogEntry["category"],
    transport: "stdio",
    command: launch.command,
    args: launch.args,
    trust: "official",
    ...(surface.docsUrl ? { docsUrl: surface.docsUrl } : {}),
    brandColor: surface.brandColor,
    mark: surface.mark,
    // Built-in tools take no keys. A built-in that needs one is a design error, not a
    // manifest field to fill in.
    envRequirements: [],
  };
}

function buildIndex(): Map<string, McpToolCatalogEntry> {
  const index = new Map<string, McpToolCatalogEntry>();
  for (const plugin of BUILTIN_PLUGINS) {
    for (const tool of (plugin.provides?.tools ?? []) as PluginTool[]) {
      if (index.has(tool.id)) {
        throw new Error(`Built-in plugin tool id collision: ${tool.id}`);
      }
      index.set(tool.id, toCatalogEntry(tool, plugin.slug));
    }
  }
  return index;
}

let cached: Map<string, McpToolCatalogEntry> | null = null;

function index(): Map<string, McpToolCatalogEntry> {
  if (!cached) cached = buildIndex();
  return cached;
}

/**
 * The catalog row for one built-in plugin tool.
 *
 * Throws when the id is unknown. A built-in that quietly goes missing is worse than a
 * loud boot failure — the app would start with a tool the whole UI still advertises.
 */
export function builtinPluginCatalogEntry(id: string): McpToolCatalogEntry {
  const entry = index().get(id);
  if (!entry) {
    throw new Error(
      `No built-in plugin provides the tool "${id}". Known: ${[...index().keys()].join(", ")}`,
    );
  }
  return entry;
}

/** Every built-in plugin tool id, for diagnostics and parity checks. */
export function builtinPluginToolIds(): string[] {
  return [...index().keys()];
}

/** Slug of the plugin providing a tool id — the assignment key in `agent_plugins`. */
export function pluginSlugForToolId(id: string): string | null {
  for (const plugin of BUILTIN_PLUGINS) {
    for (const tool of (plugin.provides?.tools ?? []) as PluginTool[]) {
      if (tool.id === id) return plugin.slug;
    }
  }
  return null;
}

/**
 * Tools whose capability is a strict subset of a same-capability peer, because the peer
 * receives a host-injected channel (PLUGIN-SPEC §2.9) and this one does not.
 *
 * Returns Map<supersededToolId, peerToolId>.
 *
 * The concrete case this exists for: `agentlas-browser` and `playwright` run the identical
 * launcher against the identical Chrome profile, so they see the same logins — but only
 * `agentlas-browser` is handed AGENTLAS_BROWSER_APPROVAL_FILE. With no approval channel the
 * launcher's requestApproval resolves to "denied" (AGENTLAS_BROWSER_AUTONOMY defaults to
 * "gated"), so `playwright` can never carry out an irreversible action — it can only be
 * refused. Picking it over its peer costs capability and gains nothing.
 *
 * This is derived from the manifests, not from an id comparison, so a future browser tool
 * that declares its channels is classified correctly without touching this code.
 */
export function channelSupersededTools(): Map<string, string> {
  const byCapability = new Map<string, { withChannel: string[]; without: string[] }>();
  for (const plugin of BUILTIN_PLUGINS) {
    for (const tool of (plugin.provides?.tools ?? []) as PluginTool[]) {
      const capability = tool.capability;
      if (!capability) continue;
      let bucket = byCapability.get(capability);
      if (!bucket) { bucket = { withChannel: [], without: [] }; byCapability.set(capability, bucket); }
      if ((tool.hostChannels ?? []).length > 0) bucket.withChannel.push(tool.id);
      else bucket.without.push(tool.id);
    }
  }
  const superseded = new Map<string, string>();
  for (const { withChannel, without } of byCapability.values()) {
    // Only meaningful when both kinds exist for one capability.
    if (!withChannel.length || !without.length) continue;
    for (const id of without) superseded.set(id, withChannel[0]);
  }
  return superseded;
}

/**
 * Should this tool be dropped from auto-mode candidacy because a live same-capability peer
 * supersedes it? Returns the peer id when it should, `null` otherwise.
 *
 * Kept as an exported pure function rather than a closure so the dangerous half can be
 * tested: dropping the subset when its superset is absent or disabled would not upgrade the
 * capability, it would delete it.
 */
export function supersededByLivePeer(input: {
  toolId: string;
  /** An explicit pin is a settings-level decision and outranks this rule. */
  pinned: boolean;
  /** catalogIds of installed servers that are ENABLED right now. */
  liveServerIds: ReadonlySet<string>;
  /** Injectable for tests; defaults to the manifest-derived map. */
  superseded?: ReadonlyMap<string, string>;
}): string | null {
  if (input.pinned) return null;
  const map = input.superseded ?? channelSupersededTools();
  const peer = map.get(input.toolId);
  if (!peer) return null;
  return input.liveServerIds.has(peer) ? peer : null;
}
