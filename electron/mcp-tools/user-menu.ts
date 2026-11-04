/**
 * What the owner is shown versus what the agents can reach ("사이언스·Finance 각각 고유한 도구는 @ 같은 명령어에서
 * One/Work 에는 안 보이게 하되, 내부적으로 에이전트들은 쓸 수 있게 전부 연결").
 *
 * Two readers of the same conversation menu (mcp-tools/domain-tool-menu.ts), two rules:
 *  - the agents' readers (the judge, the model's lookups, the prompt's name lists) keep `pluginInToolMenu`;
 *  - the owner's readers (the composer's "@" menu) use `pluginInUserMenu` below, which also hides what any domain owns from an
 *    ordinary One/Work conversation. A domain conversation (Science, a domain's Work project) lists its own restricted menu as before,
 *    and an explicit "@name" typed by hand still opens a plugin (auto-select.ts hasExplicitMention).
 *
 * Domain ownership is data: Science's list lives in domain-tool-menu.ts, every domain that owns Work projects declares its own on its
 * project-domain binding (invocation/project-domain-binding.ts domainOwnedPlugins), so this file names no domain.
 */
import { domainOwnedPlugins } from "../invocation/project-domain-binding";
import { SCIENCE_OWNED_PLUGINS, type ToolMenu } from "./domain-tool-menu";

/** Every plugin a product domain owns. */
export function domainOwnedPluginSlugs(): readonly string[] {
  return [...new Set([...SCIENCE_OWNED_PLUGINS, ...domainOwnedPlugins()])];
}

/** Whether a plugin is offered to the owner in a conversation's "@" menu. */
export function pluginInUserMenu(menu: ToolMenu, slug: string): boolean {
  return menu.restricted ? menu.plugins.includes(slug) : !domainOwnedPluginSlugs().includes(slug);
}
