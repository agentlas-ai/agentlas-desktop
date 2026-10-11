// Personal context that a foreign CLI pulls in from OTHER tools' folders (owner decision 2026-10-11, all users).
//
// Grok scans `~/.claude/` and `~/.cursor/` by default ("Claude compatibility ... enabled by default",
// `grok inspect` 1.0.51: "Project Instructions (2): ~/.grok/Agents.md, ~/.claude/Claude.md [claude]",
// 125 permission rules from ~/.claude/settings.local.json, skills from ~/.claude/skills). Each scan has an env
// switch (GROK_<CLAUDE|CURSOR>_<SKILLS|RULES|AGENTS|MCPS|HOOKS>_ENABLED). Verified: with the env set to false
// `grok inspect` marks ~/.claude/Claude.md "[disabled]". NOT covered by these switches (reported, not hidden):
// Grok's own ~/.grok/Agents.md and skills, ~/.agents/skills, and the generic top-level `Claude.md` name.
//
// A cell stays on only for One, and only while the person switched on a matching item of that tool
// (capabilities/one-capabilities.ts); every other agent gets all cells off.
import type { CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";

const GROK_CELLS: ReadonlyArray<{ cell: string; kind: CapabilityKind }> = [
  { cell: "SKILLS", kind: "skill" },
  { cell: "RULES", kind: "memory" },
  { cell: "AGENTS", kind: "memory" },
  { cell: "MCPS", kind: "connector" },
  { cell: "HOOKS", kind: "hook" },
];

export function grokCompatEnv(selection: CapabilitySelection | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of ["claude", "cursor"] as const) {
    for (const { cell, kind } of GROK_CELLS) {
      const on = selection?.isOne === true && selection.items.some((item) => item.source === source && item.kind === kind && item.enabled);
      if (!on) env[`GROK_${source.toUpperCase()}_${cell}_ENABLED`] = "false";
    }
  }
  return env;
}

/** The run environment for an ACP agent: foreign-tool context switched off unless One chose it. */
export function withForeignCliContext(agentKind: string, env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined): NodeJS.ProcessEnv {
  return agentKind === "grok" ? { ...env, ...grokCompatEnv(selection) } : env;
}
