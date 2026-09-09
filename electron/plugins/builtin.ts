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
import type { McpToolCatalogEntry } from "../../shared/types";
import { BROWSER_CDP_LAUNCHER_BASENAME } from "../mcp-tools/browser-cdp-launcher";
import { computerUseMcpLaunchArgs } from "../computer-use/mcp-server";
import { systemTimeMcpLaunchArgs } from "../mcp-tools/system-time-server";
import { workspacePreviewMcpLaunchArgs } from "../workspace-preview/mcp-server";

interface PluginManifest {
  slug: string;
  provides?: { tools?: unknown[] };
}

/**
 * ★ Every built-in plugin manifest, declared as data.
 *
 * `scripts/verify-packaging-completeness.mjs` reads this list to prove the packaged
 * app.asar actually contains each file. Keep the paths as plain string literals — a
 * computed path would leave that gate detecting nothing.
 */
export const BUILTIN_PLUGIN_MANIFEST_PATHS = [
  "../../plugins/agentlas-browser/plugin.json",
  "../../plugins/agentlas-computer-use/plugin.json",
  "../../plugins/agentlas-time/plugin.json",
  "../../plugins/agentlas-workspace-preview/plugin.json",
  "../../plugins/flint-chart/plugin.json",
] as const;

const loadFailures: string[] = [];

/**
 * ★ Why these are loaded tolerantly instead of value-imported.
 *
 * They used to be value-imported from their package paths at module scope. That
 * made a packaging mistake fatal: 1.0.31 and 1.0.32 shipped an app.asar with no
 * dist/plugins at all, so the main process threw before any window existed. The app could
 * not start, which also meant it could not auto-update itself out of the broken build —
 * every affected user had to find the app, delete it, and reinstall by hand.
 *
 * A missing manifest must cost the tools it declares and nothing else. The app still
 * starts, still reaches the updater, and repairs itself on the next release.
 * `builtinPluginLoadFailures()` is what makes the loss visible rather than silent.
 *
 * The packaging gate (verify-packaging-completeness.mjs, run by package-mac.sh against the
 * built .app) remains the thing that stops such a build from shipping at all. This is the
 * second layer, for the mistake that gets past it.
 *
 * The relative paths resolve the same way in the repo and in the packaged app: this module
 * compiles to dist/electron/plugins/, and copy-builtin-plugins.cjs puts the packages in
 * dist/plugins/. tsc's json emit is not what places them there, so dropping the value
 * imports does not change what ships.
 */
function loadManifests(): PluginManifest[] {
  const loaded: PluginManifest[] = [];
  for (const manifestPath of BUILTIN_PLUGIN_MANIFEST_PATHS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const manifest = require(manifestPath) as PluginManifest;
      if (!manifest || typeof manifest.slug !== "string") {
        throw new Error("manifest has no slug");
      }
      loaded.push(manifest);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      loadFailures.push(`${manifestPath}: ${reason}`);
      console.error(
        `[builtin-plugins] ${manifestPath} could not be loaded — the tools it declares are unavailable in this install. ` +
          `This build is incomplete; updating to the next release restores them. (${reason})`,
      );
    }
  }
  return loaded;
}

/** Every built-in plugin package bundled with the app that this install could actually load. */
const BUILTIN_PLUGINS: readonly PluginManifest[] = loadManifests();

/**
 * Manifests this install could not load, as `path: reason`. Empty on a complete build.
 * Surfaced so an incomplete install can say so instead of looking merely feature-poor.
 */
export function builtinPluginLoadFailures(): string[] {
  return [...loadFailures];
}

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
  "workspace-preview": () => ({ command: process.execPath, args: workspacePreviewMcpLaunchArgs() }),
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

/**
 * Catalog rows for the given built-in tool ids, skipping any this install could not load.
 *
 * This is the accessor the catalog array uses. `builtinPluginCatalogEntry` still throws for
 * a caller that demands one specific tool — but assembling the whole catalog must not be an
 * all-or-nothing operation, because that is what turned one missing manifest into an app
 * that could not start.
 */
export function builtinPluginCatalogEntriesIfPresent(ids: readonly string[]): McpToolCatalogEntry[] {
  const rows: McpToolCatalogEntry[] = [];
  for (const id of ids) {
    const entry = index().get(id);
    if (entry) rows.push(entry);
    else console.error(`[builtin-plugins] built-in tool "${id}" is missing from this install and was left out of the catalog`);
  }
  return rows;
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
