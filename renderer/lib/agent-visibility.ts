import type { InstalledAgent } from "./types";

export function isVisibleAgent(agent: InstalledAgent): boolean {
  return agent.visibility !== "background";
}

export function visibleAgents(agents: InstalledAgent[]): InstalledAgent[] {
  return agents.filter(isVisibleAgent);
}
