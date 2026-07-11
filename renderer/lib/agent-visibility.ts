import type { InstalledAgent } from "./types";

const SYSTEM_AGENT_RE =
  /(orchestrator|pm[\s-]?soul|memory[\s-]?curator|policy[\s-]?gate|eval[\s-]?qa|task[\s-]?bias|meta[\s-]?agent|app[\s-]?builder|marketplace[\s-]?packager|packager|governance)/i;

export function isUserFacingAgentText(name?: string | null, role?: string | null): boolean {
  return !SYSTEM_AGENT_RE.test(`${name ?? ""} ${role ?? ""}`);
}

export interface VisibleAgentOptions {
  /** 팀(멀티에이전트) 엔티티도 포함한다 — 에이전트 선택기처럼 팀을 골라야 하는 곳에서 true. */
  includeTeams?: boolean;
}

export function isVisibleAgent(agent: InstalledAgent, opts?: VisibleAgentOptions): boolean {
  if (agent.visibility === "background" || agent.visibility === "private") return false;
  if (!opts?.includeTeams && (agent.kind ?? "agent") === "team") return false;
  // Installed assets have an authoritative visibility column. Never hide a
  // user-owned agent merely because its chosen name contains "orchestrator",
  // "app builder", "governance", or another internal-looking word.
  return true;
}

export function visibleAgents(agents: InstalledAgent[], opts?: VisibleAgentOptions): InstalledAgent[] {
  return agents.filter((agent) => isVisibleAgent(agent, opts));
}
