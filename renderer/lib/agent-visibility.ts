import type { InstalledAgent } from "./types";

const SYSTEM_AGENT_RE =
  /(orchestrator|pm[\s-]?soul|memory[\s-]?curator|policy[\s-]?gate|eval[\s-]?qa|task[\s-]?bias|meta[\s-]?agent|app[\s-]?builder|marketplace[\s-]?packager|packager|governance)/i;

export function isUserFacingAgentText(name?: string | null, role?: string | null): boolean {
  return !SYSTEM_AGENT_RE.test(`${name ?? ""} ${role ?? ""}`);
}

export function isVisibleAgent(agent: InstalledAgent): boolean {
  if (agent.visibility === "background" || agent.visibility === "private") return false;
  if ((agent.kind ?? "agent") === "team") return false;
  if (!isUserFacingAgentText(agent.slug)) return false;
  if (!isUserFacingAgentText(agent.name, agent.nameEn)) return false;
  if (!isUserFacingAgentText(agent.tagline, agent.taglineEn)) return false;
  return true;
}

export function visibleAgents(agents: InstalledAgent[]): InstalledAgent[] {
  return agents.filter(isVisibleAgent);
}
