import type { InstalledAgent, InstalledFirm } from "./types";
import { isUserFacingAgentText } from "./agent-visibility";
import { classifyInstalledAgent } from "./agent-entity-kind";

export type RosterEntityKind = "single" | "multi";

export interface AgentRosterModel {
  agents: InstalledAgent[];
  agentById: Map<string, InstalledAgent>;
  firmAgentIds: Set<string>;
  firmKindById: Map<string, RosterEntityKind>;
  singleFirmByAgentId: Map<string, InstalledFirm>;
  standaloneAgents: InstalledAgent[];
  standaloneSingleAgents: InstalledAgent[];
  standaloneMultiAgents: InstalledAgent[];
  singleModeAgents: InstalledAgent[];
  multiFirms: InstalledFirm[];
  singleFirms: InstalledFirm[];
}

export function dedupeAgentsById(list: InstalledAgent[]): InstalledAgent[] {
  return Array.from(new Map(list.map((agent) => [agent.id, agent])).values());
}

export function isRosterVisibleAgent(agent: InstalledAgent): boolean {
  if (agent.visibility === "background" || agent.visibility === "private") return false;
  if (!isUserFacingAgentText(agent.slug)) return false;
  if (!isUserFacingAgentText(agent.name, agent.nameEn)) return false;
  if (!isUserFacingAgentText(agent.tagline, agent.taglineEn)) return false;
  return true;
}

export function visibleRosterAgents(agents: InstalledAgent[]): InstalledAgent[] {
  return dedupeAgentsById(agents).filter(isRosterVisibleAgent);
}

export function buildAgentRoster(agents: InstalledAgent[], firms: InstalledFirm[]): AgentRosterModel {
  const deduped = dedupeAgentsById(agents);
  const agentById = new Map(deduped.map((agent) => [agent.id, agent]));
  const firmAgentIds = new Set<string>();
  const firmKindById = new Map<string, RosterEntityKind>();
  const singleFirmByAgentId = new Map<string, InstalledFirm>();

  for (const firm of firms) {
    const userNodes = firm.orgChart.filter((node) => {
      firmAgentIds.add(node.agentId);
      const agent = agentById.get(node.agentId);
      return isUserFacingAgentText(agent?.name ?? node.role, node.role);
    });
    const kind: RosterEntityKind = userNodes.length > 1 ? "multi" : "single";
    firmKindById.set(firm.id, kind);
    if (kind === "single") {
      for (const node of firm.orgChart) singleFirmByAgentId.set(node.agentId, firm);
    }
  }

  const standaloneAgents = deduped.filter((agent) => !firmAgentIds.has(agent.id));
  const standaloneSingleAgents = standaloneAgents.filter((agent) => classifyInstalledAgent(agent) === "single");
  const standaloneMultiAgents = standaloneAgents.filter((agent) => classifyInstalledAgent(agent) === "multi");
  const singleModeAgents = deduped.filter(
    (agent) =>
      classifyInstalledAgent(agent) === "single" &&
      (!firmAgentIds.has(agent.id) || singleFirmByAgentId.has(agent.id)),
  );
  const multiFirms = firms.filter((firm) => firmKindById.get(firm.id) === "multi");
  const singleFirms = firms.filter((firm) => firmKindById.get(firm.id) === "single");

  return {
    agents: deduped,
    agentById,
    firmAgentIds,
    firmKindById,
    singleFirmByAgentId,
    standaloneAgents,
    standaloneSingleAgents,
    standaloneMultiAgents,
    singleModeAgents,
    multiFirms,
    singleFirms,
  };
}
