// Generated Hub definitions are shared by Main and the existing MCP menu.
// They advertise capabilities without enabling servers or installing dependencies.
import snapshot from "./bundled-hub-catalog.json";
import type { MarketplaceListing, PluginAuthKind, PluginKind } from "./types";

interface BundledPlugin {
  slug: string;
  name: string;
  tagline: string;
  taglineKo?: string;
  developer: string;
  category: string;
  auth: PluginAuthKind;
  pluginKind: PluginKind;
  featured: boolean;
  homepage?: string;
  icon?: string;
  brandGlyph?: string;
  brandColor?: string;
  skills: string[];
  mcp?: unknown[];
  connectSetup?: unknown;
  manifestHref: string;
  install: { cli: string };
  manifest: Record<string, unknown>;
}

const plugins = snapshot.plugins as unknown as BundledPlugin[];
export const BUNDLED_HUB_CATALOG_REVISION = snapshot.catalogRevision;

function absoluteAsset(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return new URL(path, "https://agentlas.cloud").toString();
}

export interface BundledHubListing extends MarketplaceListing {
  catalogRevision: string;
}

export function listBundledHubPlugins(): BundledHubListing[] {
  return plugins.map((plugin) => ({
    slug: plugin.slug,
    name: plugin.name,
    nameEn: plugin.name,
    tagline: plugin.taglineKo || plugin.tagline,
    taglineEn: plugin.tagline,
    trustGrade: "unknown",
    installCount: 0,
    manifestUrl: `https://agentlas.cloud${plugin.manifestHref}`,
    ownerName: plugin.developer,
    kind: "hub-plugin",
    callable: false,
    routingReady: true,
    routingStatus: "bundled-plugin",
    source: "hub-plugin",
    entityKind: "plugin",
    perCallCredits: 0,
    category: plugin.category,
    developer: plugin.developer,
    detailUrl: `https://agentlas.cloud/plugins/${plugin.slug}`,
    installCli: plugin.install.cli,
    homepage: plugin.homepage,
    iconUrl: absoluteAsset(plugin.icon),
    brandGlyphUrl: absoluteAsset(plugin.brandGlyph),
    brandColor: plugin.brandColor,
    featured: plugin.featured,
    pluginKind: plugin.pluginKind,
    authKind: plugin.auth,
    skillCount: plugin.skills.length,
    mcpServerCount: plugin.mcp?.length ?? 0,
    connectSetupRequired: Boolean(plugin.connectSetup),
    catalogRevision: BUNDLED_HUB_CATALOG_REVISION,
  }));
}

export function getBundledHubManifest(slug: string): Record<string, unknown> | null {
  const canonicalSlug = slug.replace(/^plugin\//, "");
  const plugin = plugins.find((entry) => entry.slug === canonicalSlug);
  // Callers may normalize payloads; never mutate the shared canonical snapshot.
  return plugin ? JSON.parse(JSON.stringify(plugin.manifest)) as Record<string, unknown> : null;
}
