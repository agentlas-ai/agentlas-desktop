import type { ProjectAgentPoolMember } from "./types";

/**
 * Single source of truth for the project agent pool contract.
 *
 * The renderer (project new/detail, Work cockpit) and the Mobile Bridge
 * authority both staff projects. When those two surfaces disagree about which
 * installed agents a user may attach, the phone offers rows the Desktop then
 * refuses — so the predicate lives here and both import it.
 */

/** Mirrors `normalizeAgentPool` in electron/store/projects.ts. */
export const PROJECT_AGENT_POOL_MAX = 32;

export function projectPoolMemberKey(member: ProjectAgentPoolMember): string {
  return `${member.source}:${member.agentId}:${member.releaseId ?? ""}`;
}

/** The exact installed-agent fields staffing depends on. */
export interface ProjectAgentPoolCandidate {
  visibility?: "visible" | "background" | "private";
  systemPrompt: string;
}

/**
 * Project staffing is a user-facing preference surface. Materialized HQ cells
 * (policy gates, memory curators, domain slots, and other background roles)
 * belong to the team's private implementation and must never look like agents
 * the user is expected to select or call.
 */
export function isUserFacingProjectAgent(agent: ProjectAgentPoolCandidate): boolean {
  return agent.visibility !== "background"
    && agent.visibility !== "private"
    && agent.systemPrompt.trim().length > 0;
}
