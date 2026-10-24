import type { InstalledAgent, InstalledFirm, OrchestrationTarget } from "@shared/types";

/**
 * What `@`-picking one library row actually staffs.
 *
 * An installed **team** package is listed twice: once as its representative row in
 * the agents group and once in the teams group. Both rows used to emit
 * `{ entityKind: "agent", agentId }`, but Main refuses that shape for a team
 * package (`Installed team package must resolve to a Team/Firm target`,
 * electron/mcp/client.ts) and the whole Work run fails before a single worker
 * turn. Measured 2026-09-05: picking "Travel Concierge Hq" from the agents group
 * killed the run 16s after send, with no answer and no tool call.
 *
 * So the row resolves to the team it represents. A team package with no installed
 * firm has no runnable target at all — return null rather than a target that is
 * guaranteed to be rejected, so the mention still types its name but never
 * promises staffing the host cannot honour.
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
