import type { InstalledAgent, InstalledFirm, OrchestrationTarget } from "@shared/types";

/**














 */
export function installedAgentMentionTarget(
  agent: Pick<InstalledAgent, "id" | "kind">,
  firms: ReadonlyArray<Pick<InstalledFirm, "id" | "ceoAgentId">>,
): OrchestrationTarget | null {
  if (agent.kind === "team") {
    const firm = firms.find((candidate) => candidate.ceoAgentId === agent.id);
    if (!firm) return null;
    return { source: "local", entityKind: "team", firmId: firm.id };
  }
  return { source: "local", entityKind: "agent", agentId: agent.id };
}
