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
  return `${member.source}:${member.entityKind}:${member.targetId}:${member.releaseId ?? ""}`;
}

export function projectPoolMemberInstalledAgentId(member: ProjectAgentPoolMember): string | null {
  return member.entityKind === "agent" ? member.agentId : member.controllerAgentId;
}

export function projectPoolMemberLocalFirmId(member: ProjectAgentPoolMember): string | null {
  return member.entityKind === "team" && member.source === "local" ? member.firmId : null;
}

/**
 * The identities a removed asset can still be staged under.
 *
 * Local rows are keyed by installed id or firm id; a Cloud or Hub row has a
 * null agentId and is keyed by its own source-namespace target — a slug, or the
 * exact Hub definition id once a bookmark sync has repaired it. Deletion used
 * to be filtered on the local ids alone, in two hand-written copies inside the
 * agents page, so every remote row outlived its asset. One predicate, imported
 * by the store that performs the removal and by the screen that warns about it.
 */
export interface ProjectPoolReferenceSet {
  agentIds?: ReadonlySet<string>;
  firmIds?: ReadonlySet<string>;
  /** Lowercased slugs and Hub definition ids. */
  remoteTargetIds?: ReadonlySet<string>;
}

export function projectPoolMemberReferences(
  member: ProjectAgentPoolMember,
  refs: ProjectPoolReferenceSet,
): boolean {
  const agentIds = refs.agentIds;
  const firmIds = refs.firmIds;
  if (member.entityKind === "team") {
    if (member.firmId && firmIds?.has(member.firmId)) return true;
    if (member.controllerAgentId && agentIds?.has(member.controllerAgentId)) return true;
  } else if (member.agentId && agentIds?.has(member.agentId)) {
    return true;
  }
  if (member.source === "local") {
    return Boolean(agentIds?.has(member.targetId) || firmIds?.has(member.targetId));
  }
  return Boolean(refs.remoteTargetIds?.has(member.targetId.trim().toLowerCase()));
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
