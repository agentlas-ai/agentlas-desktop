/**
 * The plugins the composer's "@" menu offers for one conversation. Same rule as the model's tool menu (mcp-tools/domain-tool-menu.ts,
 * read for the chat by mcp-tools/chat-tool-menu.ts): a Finance conversation lists Finance's plugins plus the shared ones, a Science
 * conversation lists Science's, an ordinary One/Work conversation hides what any domain owns (mcp-tools/user-menu.ts: the owner's menu; the agents'
 * own lookups still reach those plugins). Discovery only: nothing is enabled or installed here.
 */
import fs from "node:fs";
import path from "node:path";

export interface ComposerPluginMention { id: string; slug: string; mention: string; name: string; description: string }

const MENTION = /^@[a-z0-9][a-z0-9_-]{0,127}$/i;

export async function composerPluginMentions(chatId: string | null | undefined): Promise<ComposerPluginMention[]> {
  const { listInstalledPluginCandidates, pluginCandidatesRoot } = await import("../plugins/plugin-candidates");
  const { pluginInUserMenu } = await import("../mcp-tools/user-menu");
  const { toolMenuOfChat } = await import("../mcp-tools/chat-tool-menu");
  const { listCapabilities } = await import("../capabilities/one-capabilities");
  const menu = toolMenuOfChat(chatId || undefined);
  const root = pluginCandidatesRoot();
  const switches = listCapabilities().filter((item) => item.source === "agentlas" && item.kind === "plugin");
  const rows: ComposerPluginMention[] = [];
  for (const plugin of listInstalledPluginCandidates(root)) {
    if (!plugin.hasSkills || !pluginInUserMenu(menu, plugin.slug) || !MENTION.test(plugin.mention) || !plugin.name.trim()) continue;
    const capability = switches.find((item) => item.name === plugin.slug || item.name.split("@")[0] === plugin.slug);
    if (capability && !capability.enabled) continue;
    // The entry skill must be readable, as the model's skill.read will need it.
    const skills = path.join(root, plugin.slug, "skills");
    try {
      const readable = fs.readdirSync(skills, { withFileTypes: true }).some((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, "SKILL.md")));
      if (!readable) continue;
    } catch { continue; }
    rows.push({ id: `plugin:${plugin.slug}`, slug: plugin.slug, mention: plugin.mention, name: plugin.name.slice(0, 160), description: plugin.description.slice(0, 280) });
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.mention.toLowerCase(), (counts.get(row.mention.toLowerCase()) ?? 0) + 1);
  return rows.filter((row) => counts.get(row.mention.toLowerCase()) === 1).sort((a, b) => a.slug.localeCompare(b.slug));
}
