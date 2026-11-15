// Special agents whose folder and memory the app creates like any agent's, while their tools, skills and data stay with their plugin
//. Plain data and no imports, so the manifest, the seeder and the folder writer read one definition and
// common desktop code never names the plugin (the Finance line ratchet in test-finance-harness-unified F6 counts electron/ only).
//
// What a special agent has: a built-in row (hidden: visibility "background"), a folder under the agent root with AGENT.md, system-prompt.md,
// manifest.md and `agentlas.json {kind:"special", plugin}`, and its own agent memory store (memory-scopes.json specialAgentIds, shared/memory-special-agents.ts).
// What it does not have: a character, a photo, copies of the plugin's bundled skills (the plugin is referenced, `skills/` holds only the owner's own),
// a location marker for the plugin's data (the data is found where the plugin already finds it), or a turn of its own: the plugin keeps running
// its turns, so the prompt below never reaches a model. If it does, the text says to stop.
// The research director (Science) is also special but is not defined here: its row, prompt and package already exist and its folder is not
// written by this file (the Science package writes it byte-exact and signs it).

export interface SpecialFolderAgentDef {
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  role: "orchestrator";
  visibility: "background";
  tone: "green";
  systemPrompt: string;
  /** The body of the folder's `agentlas.json`. Carries no `entry`, so the prompt file stays the canonical prompt (prompt-authority.ts). */
  folderManifest: { kind: "special"; plugin: string };
}

const SPECIAL_AGENT_SEED_PROMPT = `# Agentlas Finance

This special agent keeps a folder and a memory store like any agent. Finance turns belong to the Finance plugin (\`@finance\`), which owns its
instructions, tools and data. If this placeholder reaches model execution, stop: Finance is not run as a plain agent.`;

export const SPECIAL_FOLDER_AGENTS: readonly SpecialFolderAgentDef[] = [
  {
    slug: "agentlas-finance",
    name: "Agentlas Finance",
    nameEn: "Agentlas Finance",
    tagline: "Finance 플러그인의 폴더와 기억 — 도구·스킬·데이터는 플러그인에 둔다",
    taglineEn: "The Finance plugin's folder and memory — tools, skills and data stay with the plugin",
    role: "orchestrator",
    visibility: "background",
    tone: "green",
    systemPrompt: SPECIAL_AGENT_SEED_PROMPT,
    folderManifest: { kind: "special", plugin: "finance" },
  },
];

/** The special-folder definition for a built-in slug, or null. */
export function specialFolderAgentForSlug(slug: string | null | undefined): SpecialFolderAgentDef | null {
  return typeof slug === "string" ? SPECIAL_FOLDER_AGENTS.find((def) => def.slug === slug) ?? null : null;
}
