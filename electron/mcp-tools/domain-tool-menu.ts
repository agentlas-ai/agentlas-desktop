/**
 * Which plugins a conversation's tool menu carries, by the product domain the conversation belongs to (
 * "각 도메인은 지원하는 툴 종류를 따로 해 놓고, One·Work에서는 Science 도구(biomed 등)가 보이지 않게").
 *
 * Data, not a prompt line: the judge menu, the plugin lookup the model can call, and the explicit-mention path all read this.
 * A domain that owns Work projects declares its own menu on its project-domain binding (invocation/project-domain-binding.ts
 * `toolMenu`); Science's menu is keyed by the chat's surface pack. A restricted menu shows only the plugins it names (plus the
 * host's pinned tools and the owner's explicit assignments); every other conversation shows all plugins except the ones a domain owns.
 */
export type ToolMenu = { readonly restricted: false } | { readonly restricted: true; readonly plugins: readonly string[] };

/** Plugins owned by Science. An ordinary One/Work conversation does not list them (an explicit @mention still opens one). */
export const SCIENCE_OWNED_PLUGINS: readonly string[] = [
  "agentlas-astronomy",
  "agentlas-comparative-genomics",
  "agentlas-earth-science",
  "agentlas-materials-science",
  "agentlas-medchem",
  "agentlas-paleontology",
  "agentlas-physics",
  "agentlas-science-research-director",
  "agentlas-science-skills",
  "agentlas-science-statistics",
  "agentlas-structural-biology",
];

/** Plugins every restricted menu may use: documents, charts, time, the interactive surface, the turn harness, literature and data. */
export const SHARED_MENU_PLUGINS: readonly string[] = [
  "agentlas-academic-search",
  "agentlas-economic-data",
  "agentlas-time",
  "agentlas-turn",
  "agentlas-ui",
  "agentlas-workspace-preview",
  "flint-chart",
  "office",
];

const SCIENCE_MENU: ToolMenu = { restricted: true, plugins: [...SCIENCE_OWNED_PLUGINS, ...SHARED_MENU_PLUGINS] };
export const ORDINARY_MENU: ToolMenu = { restricted: false };

/** The menu of a conversation, from Main-derived facts only: the chat's surface pack and the stored project binding's declared menu. */
export function toolMenuFor(input: { surfacePack?: string | null; projectToolMenu?: readonly string[] | null }): ToolMenu {
  if (input.surfacePack === "science") return SCIENCE_MENU;
  if (input.projectToolMenu?.length) return { restricted: true, plugins: input.projectToolMenu };
  return ORDINARY_MENU;
}

/** Whether a plugin appears in a menu (the judge's candidates and the model's plugin lookup). */
export function pluginInToolMenu(menu: ToolMenu, slug: string): boolean {
  return menu.restricted ? menu.plugins.includes(slug) : !SCIENCE_OWNED_PLUGINS.includes(slug);
}

/** The host's own pinned tools, offered in every restricted menu (the plugin resolver and the browser). */
const PINNED_MENU_TOOLS: readonly string[] = ["agentlas-browser", "hephaestus-network"];

/**
 * Whether a catalog tool id (or an installed connector's catalog id) appears in a menu. One rule for the judge's candidates, the plugin /
 * tool / connector lookups the model can call, and the prompt's name lists: a restricted menu offers the tools of its plugins and the pinned
 * host tools; an ordinary one offers everything except the tools only a domain-owned plugin provides.
 */
export function toolIdInMenu(menu: ToolMenu, toolId: string, plugins: readonly { slug: string; toolIds: readonly string[]; /** An explicit @mention lists a plugin the menu does not. */ listed?: boolean }[]): boolean {
  const isListed = (plugin: { slug: string; listed?: boolean }): boolean => plugin.listed ?? pluginInToolMenu(menu, plugin.slug);
  const visible = new Set(plugins.filter(isListed).flatMap((plugin) => plugin.toolIds));
  if (menu.restricted) return visible.has(toolId) || PINNED_MENU_TOOLS.includes(toolId);
  const hidden = plugins.filter((plugin) => !isListed(plugin)).flatMap((plugin) => plugin.toolIds);
  return visible.has(toolId) || !hidden.includes(toolId);
}

