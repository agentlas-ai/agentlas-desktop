import { randomUUID } from "node:crypto";
import { getSource as getMarketSource } from "../marketplace";
import { listInstalledAgents } from "../mcp/registry";
import { getResolvedOrg } from "./org-spec";
import { getDb } from "./db";
import { listFirms } from "./firms";
import type {
  AgentGroup,
  AgentGroupCreateInput,
  AgentGroupMember,
  AgentGroupMemberSource,
  AgentGroupMemberSnapshot,
  AgentGroupResolved,
  AgentGroupResolvedMember,
  AgentGroupUpdateInput,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  ResolvedNode,
} from "../../shared/types";

interface AgentGroupRow {
  id: string;
  name: string;
  description: string;
  orchestrator_name: string;
  members_json: string;
  created_at: string;
  updated_at: string;
}

export interface AgentGroupRuntimeMember {
  id: string;
  slug: string;
  name: string;
  directive: string;
  source: AgentGroupMemberSource;
  routeLabel: string;
  warnings: AgentGroupResolvedMember["warnings"];
}

export interface AgentGroupRuntimeResolution {
  group: AgentGroup;
  members: AgentGroupRuntimeMember[];
  skipped: Array<{
    id: string;
    name: string;
    source: AgentGroupMemberSource;
    warnings: AgentGroupResolvedMember["warnings"];
  }>;
}

function parseMembers(raw: string): AgentGroupMember[] {
  try {
    const parsed = JSON.parse(raw) as AgentGroupMember[];
    return Array.isArray(parsed) ? parsed.map(normalizeMember).filter(Boolean) as AgentGroupMember[] : [];
  } catch {
    return [];
  }
}

function fallbackSnapshot(member: AgentGroupMember): AgentGroupMemberSnapshot {
  return {
    name: member.agentSlug || member.hubSlug || member.agentId || "Agent",
    nameEn: member.agentSlug || member.hubSlug || member.agentId || "Agent",
    tagline: "",
    taglineEn: "",
    routeLabel: "",
  };
}

function normalizeMember(member: AgentGroupMember): AgentGroupMember | null {
  if (!member || typeof member !== "object") return null;
  const source = member.source;
  if (source !== "installed" && source !== "firm-node" && source !== "hub") return null;
  const id = typeof member.id === "string" && member.id.trim() ? member.id : randomUUID();
  const addedAt = typeof member.addedAt === "string" && member.addedAt ? member.addedAt : new Date().toISOString();
  const snapshot = member.snapshot && typeof member.snapshot === "object" ? member.snapshot : fallbackSnapshot(member);
  return {
    id,
    source,
    agentId: clean(member.agentId),
    agentSlug: clean(member.agentSlug),
    hubSlug: clean(member.hubSlug),
    firmId: clean(member.firmId),
    firmSlug: clean(member.firmSlug),
    nodeId: clean(member.nodeId),
    role: clean(member.role),
    addedAt,
    snapshot,
  };
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toGroup(row: AgentGroupRow): AgentGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    orchestratorName: row.orchestrator_name,
    members: parseMembers(row.members_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function groupById(id: string): AgentGroup | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_groups WHERE id = ?")
    .get(id) as AgentGroupRow | undefined;
  return row ? toGroup(row) : null;
}

export function getAgentGroup(id: string): AgentGroup | null {
  return groupById(id);
}

function uniqueMembers(members: AgentGroupMember[]): AgentGroupMember[] {
  const seen = new Set<string>();
  const out: AgentGroupMember[] = [];
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (!normalized) continue;
    const key = [
      normalized.source,
      normalized.firmId || normalized.firmSlug || "",
      normalized.nodeId || "",
      normalized.agentId || "",
      normalized.agentSlug || normalized.hubSlug || "",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function listAgentGroups(): AgentGroup[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_groups ORDER BY updated_at DESC")
    .all() as AgentGroupRow[];
  return rows.map(toGroup);
}

export function createAgentGroup(input: AgentGroupCreateInput): AgentGroup {
  const name = input.name.trim();
  if (!name) throw new Error("Agent group name is required.");
  const members = uniqueMembers(input.members ?? []);
  if (members.length === 0) throw new Error("Agent group needs at least one agent.");
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO agent_groups
       (id, name, description, orchestrator_name, members_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      input.description?.trim() ?? "",
      input.orchestratorName?.trim() || `${name} Orchestrator`,
      JSON.stringify(members),
      now,
      now,
    );
  return groupById(id) as AgentGroup;
}

export function updateAgentGroup(id: string, patch: AgentGroupUpdateInput): AgentGroup {
  const current = groupById(id);
  if (!current) throw new Error(`Agent group not found: ${id}`);
  const next: AgentGroup = {
    ...current,
    name: patch.name !== undefined ? patch.name.trim() : current.name,
    description: patch.description !== undefined ? patch.description.trim() : current.description,
    orchestratorName:
      patch.orchestratorName !== undefined
        ? patch.orchestratorName.trim() || `${current.name} Orchestrator`
        : current.orchestratorName,
    members: patch.members !== undefined ? uniqueMembers(patch.members) : current.members,
    updatedAt: new Date().toISOString(),
  };
  if (!next.name) throw new Error("Agent group name is required.");
  getDb()
    .prepare(
      `UPDATE agent_groups
       SET name = ?, description = ?, orchestrator_name = ?, members_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.name,
      next.description,
      next.orchestratorName,
      JSON.stringify(next.members),
      next.updatedAt,
      id,
    );
  return groupById(id) as AgentGroup;
}

export function removeAgentGroup(id: string): void {
  getDb().prepare("DELETE FROM agent_groups WHERE id = ?").run(id);
}

export function removeAgentGroupMember(groupId: string, memberId: string): AgentGroup {
  const group = groupById(groupId);
  if (!group) throw new Error(`Agent group not found: ${groupId}`);
  return updateAgentGroup(groupId, {
    members: group.members.filter((member) => member.id !== memberId),
  });
}

function nodeCandidates(firms: InstalledFirm[], agents: InstalledAgent[]) {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const rows: Array<{ firm: InstalledFirm; node: ResolvedNode; rawNodeId?: string }> = [];
  for (const firm of firms) {
    const resolved = getResolvedOrg(firm);
    if (resolved) {
      rows.push({ firm, node: resolved.ceo });
      for (const division of resolved.divisions) {
        rows.push({ firm, node: division });
        for (const specialist of division.specialists) rows.push({ firm, node: specialist });
      }
    } else {
      for (const raw of firm.orgChart) {
        const agent = agentMap.get(raw.agentId);
        rows.push({
          firm,
          rawNodeId: raw.agentSlug,
          node: {
            id: raw.agentSlug,
            name: agent?.name ?? raw.role,
            role: raw.role,
            agentId: raw.agentId,
          },
        });
      }
    }
  }
  return rows;
}

function displaySnapshotFromAgent(agent: InstalledAgent, routeLabel = ""): AgentGroupMemberSnapshot {
  return {
    name: agent.name,
    nameEn: agent.nameEn,
    tagline: agent.tagline,
    taglineEn: agent.taglineEn,
    routeLabel,
    trustGrade: agent.trustGrade,
    runtimeLabel: agent.runtimeLabel,
    entityKind: agent.kind,
  };
}

function displaySnapshotFromHub(agent: MarketplaceListing): AgentGroupMemberSnapshot {
  return {
    name: agent.name,
    nameEn: agent.nameEn,
    tagline: agent.tagline,
    taglineEn: agent.taglineEn,
    routeLabel: "Hub",
    trustGrade: agent.trustGrade,
    entityKind: agent.entityKind ?? agent.kind,
    routingStatus: agent.routingStatus ?? null,
  };
}

function resolveMember(
  member: AgentGroupMember,
  agents: InstalledAgent[],
  firms: InstalledFirm[],
  hubAgents: MarketplaceListing[],
): AgentGroupResolvedMember {
  const warnings: AgentGroupResolvedMember["warnings"] = [];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentBySlug = new Map(agents.map((agent) => [agent.slug, agent]));
  const hubBySlug = new Map(hubAgents.map((agent) => [agent.slug, agent]));
  let status: AgentGroupResolvedMember["status"] = "ok";
  let current: AgentGroupResolvedMember["current"] | undefined;

  if (member.source === "hub") {
    const hub = hubBySlug.get(member.hubSlug || member.agentSlug || "");
    if (!hub) {
      status = "missing";
      warnings.push("hub_missing");
    } else {
      current = displaySnapshotFromHub(hub);
    }
  } else if (member.source === "firm-node") {
    const candidates = nodeCandidates(firms, agents);
    const exact = candidates.find(
      ({ firm, node, rawNodeId }) =>
        (member.firmId ? firm.id === member.firmId : firm.slug === member.firmSlug) &&
        (node.id === member.nodeId || rawNodeId === member.nodeId),
    );
    if (exact) {
      const agent = exact.node.agentId ? agentById.get(exact.node.agentId) : null;
      if (agent) {
        current = displaySnapshotFromAgent(agent, `${exact.firm.name} / ${exact.node.role}`);
        if (member.agentId && member.agentId !== exact.node.agentId) {
          status = "moved";
          warnings.push("route_changed");
        }
      } else {
        status = "missing";
        warnings.push("agent_missing");
      }
    } else {
      const moved = candidates.find(
        ({ firm, node }) =>
          (member.firmId ? firm.id === member.firmId : firm.slug === member.firmSlug) &&
          Boolean(member.agentId && node.agentId === member.agentId),
      );
      if (moved) {
        const agent = moved.node.agentId ? agentById.get(moved.node.agentId) : null;
        current = agent ? displaySnapshotFromAgent(agent, `${moved.firm.name} / ${moved.node.role}`) : undefined;
        status = "moved";
        warnings.push("route_changed");
      } else {
        status = "missing";
        warnings.push("route_missing");
      }
    }
  } else {
    const agent = (member.agentId ? agentById.get(member.agentId) : undefined) || agentBySlug.get(member.agentSlug || "");
    if (!agent) {
      status = "missing";
      warnings.push("agent_missing");
    } else {
      current = displaySnapshotFromAgent(agent, "Installed");
    }
  }

  return {
    ...member,
    current,
    status,
    warnings,
  };
}

export async function listResolvedAgentGroups(): Promise<AgentGroupResolved[]> {
  const groups = listAgentGroups();
  const agents = listInstalledAgents();
  const firms = listFirms();
  let hubAgents: MarketplaceListing[] = [];
  try {
    hubAgents = await getMarketSource().searchAgents("");
  } catch {
    hubAgents = [];
  }
  return groups.map((group) => {
    const members = group.members.map((member) => resolveMember(member, agents, firms, hubAgents));
    return {
      ...group,
      members,
      warningCount: members.filter((member) => member.status !== "ok").length,
    };
  });
}

export async function getResolvedAgentGroup(id: string): Promise<AgentGroupResolved | null> {
  return (await listResolvedAgentGroups()).find((group) => group.id === id) ?? null;
}

function resolveRuntimeAgent(
  member: AgentGroupMember,
  agents: InstalledAgent[],
  firms: InstalledFirm[],
): { agent: InstalledAgent | null; routeLabel: string; warnings: AgentGroupResolvedMember["warnings"] } {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentBySlug = new Map(agents.map((agent) => [agent.slug, agent]));
  if (member.source === "installed") {
    const agent = (member.agentId ? agentById.get(member.agentId) : undefined) || agentBySlug.get(member.agentSlug || "");
    return {
      agent: agent ?? null,
      routeLabel: "Installed",
      warnings: agent ? [] : ["agent_missing"],
    };
  }
  if (member.source !== "firm-node") {
    return { agent: null, routeLabel: "", warnings: ["route_missing"] };
  }

  const candidates = nodeCandidates(firms, agents);
  const exact = candidates.find(
    ({ firm, node, rawNodeId }) =>
      (member.firmId ? firm.id === member.firmId : firm.slug === member.firmSlug) &&
      (node.id === member.nodeId || rawNodeId === member.nodeId),
  );
  if (exact) {
    const agent = exact.node.agentId ? agentById.get(exact.node.agentId) ?? null : null;
    return {
      agent,
      routeLabel: `${exact.firm.name} / ${exact.node.role}`,
      warnings: agent
        ? member.agentId && member.agentId !== exact.node.agentId
          ? ["route_changed"]
          : []
        : ["agent_missing"],
    };
  }

  const moved = candidates.find(
    ({ firm, node }) =>
      (member.firmId ? firm.id === member.firmId : firm.slug === member.firmSlug) &&
      Boolean(member.agentId && node.agentId === member.agentId),
  );
  if (moved) {
    const agent = moved.node.agentId ? agentById.get(moved.node.agentId) ?? null : null;
    return {
      agent,
      routeLabel: `${moved.firm.name} / ${moved.node.role}`,
      warnings: agent ? ["route_changed"] : ["agent_missing"],
    };
  }
  return { agent: null, routeLabel: "", warnings: ["route_missing"] };
}

export async function resolveAgentGroupForRuntime(id: string): Promise<AgentGroupRuntimeResolution | null> {
  const group = getAgentGroup(id);
  if (!group) return null;
  const agents = listInstalledAgents();
  const firms = listFirms();
  let hubAgents: MarketplaceListing[] = [];
  try {
    hubAgents = await getMarketSource().searchAgents("");
  } catch {
    hubAgents = [];
  }
  const hubBySlug = new Map(hubAgents.map((agent) => [agent.slug, agent]));
  const members: AgentGroupRuntimeMember[] = [];
  const skipped: AgentGroupRuntimeResolution["skipped"] = [];

  for (const member of group.members) {
    if (member.source === "hub") {
      const slug = member.hubSlug || member.agentSlug || "";
      const hub = hubBySlug.get(slug);
      if (!slug || !hub) {
        skipped.push({
          id: member.id,
          name: pickSnapshotName(member.snapshot),
          source: member.source,
          warnings: ["hub_missing"],
        });
        continue;
      }
      members.push({
        id: member.id,
        slug,
        name: hub.nameEn || hub.name || slug,
        directive: `You are the Agentlas Hub specialist "${hub.nameEn || hub.name || slug}". ${hub.taglineEn || hub.tagline || ""}`.trim(),
        source: member.source,
        routeLabel: "Hub",
        warnings: [],
      });
      continue;
    }

    const resolved = resolveRuntimeAgent(member, agents, firms);
    if (!resolved.agent) {
      skipped.push({
        id: member.id,
        name: pickSnapshotName(member.snapshot),
        source: member.source,
        warnings: resolved.warnings,
      });
      continue;
    }
    const label = resolved.routeLabel || member.snapshot.routeLabel || "Installed";
    members.push({
      id: member.id,
      slug: `${member.source}:${resolved.agent.slug}`,
      name: resolved.agent.nameEn || resolved.agent.name,
      directive: [
        resolved.agent.systemPrompt,
        "",
        "## Agentlas route",
        `Current route: ${label}`,
        resolved.warnings.length ? `Routing warning: ${resolved.warnings.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      source: member.source,
      routeLabel: label,
      warnings: resolved.warnings,
    });
  }

  return { group, members, skipped };
}

function pickSnapshotName(snapshot: AgentGroupMemberSnapshot): string {
  return snapshot.nameEn || snapshot.name || "Agent";
}
