import { getDb } from "../store/db";

export type InstalledAgentHubBindingSource = "hub-install" | "agent-cloud-restore";

export interface InstalledAgentHubBinding {
  installedAgentId: string;
  agentDefinitionId: string;
  agentReleaseId: string;
  source: InstalledAgentHubBindingSource;
  boundAt: string;
}

interface BindingRow {
  installed_agent_id: string;
  agent_definition_id: string;
  agent_release_id: string;
  source: InstalledAgentHubBindingSource;
  bound_at: string;
}

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;
const SECRET_RE = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{12,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_\-]{20,}|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})/i;
const EMAIL_RE = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;

function portableRef(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !SAFE_REF_RE.test(normalized) ||
    normalized.includes("..") ||
    SECRET_RE.test(normalized) ||
    EMAIL_RE.test(normalized) ||
    /^\+?\d[\d .()\-]{8,}\d$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function fromRow(row: BindingRow): InstalledAgentHubBinding | null {
  const installedAgentId = portableRef(row.installed_agent_id);
  const agentDefinitionId = portableRef(row.agent_definition_id);
  const agentReleaseId = portableRef(row.agent_release_id);
  if (
    !installedAgentId ||
    !agentDefinitionId ||
    !agentReleaseId ||
    (row.source !== "hub-install" && row.source !== "agent-cloud-restore") ||
    !row.bound_at.endsWith("Z") ||
    !Number.isFinite(Date.parse(row.bound_at))
  ) {
    return null;
  }
  return {
    installedAgentId,
    agentDefinitionId,
    agentReleaseId,
    source: row.source,
    boundAt: row.bound_at,
  };
}

/**
 * Replaces one installed agent's exact Hub identity.
 *
 * Missing, partial, or unsafe authority data removes any old binding. This is
 * intentionally fail-closed while leaving the local agent itself installed and
 * usable. No slug/package/latest inference or legacy backfill is performed.
 */
export function replaceInstalledAgentHubBinding(input: {
  installedAgentId: string;
  agentDefinitionId?: unknown;
  agentReleaseId?: unknown;
  source: InstalledAgentHubBindingSource;
  boundAt?: string;
}): InstalledAgentHubBinding | null {
  const installedAgentId = portableRef(input.installedAgentId);
  if (!installedAgentId) throw new Error("Installed agent id is not a portable identifier.");
  const agentDefinitionId = portableRef(input.agentDefinitionId);
  const agentReleaseId = portableRef(input.agentReleaseId);
  const db = getDb();
  if (input.source !== "hub-install" && input.source !== "agent-cloud-restore") {
    throw new Error("Hub binding source is invalid.");
  }
  if (!agentDefinitionId || !agentReleaseId) {
    db.prepare("DELETE FROM installed_agent_hub_bindings WHERE installed_agent_id = ?")
      .run(installedAgentId);
    return null;
  }
  const boundAt = input.boundAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(boundAt)) || !boundAt.endsWith("Z")) {
    throw new Error("Hub binding time must be an ISO-8601 UTC timestamp.");
  }
  db.prepare(
    `INSERT INTO installed_agent_hub_bindings
       (installed_agent_id, agent_definition_id, agent_release_id, source, bound_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(installed_agent_id) DO UPDATE SET
       agent_definition_id = excluded.agent_definition_id,
       agent_release_id = excluded.agent_release_id,
       source = excluded.source,
       bound_at = excluded.bound_at`,
  ).run(installedAgentId, agentDefinitionId, agentReleaseId, input.source, boundAt);
  return {
    installedAgentId,
    agentDefinitionId,
    agentReleaseId,
    source: input.source,
    boundAt,
  };
}

export function getInstalledAgentHubBinding(installedAgentId: string): InstalledAgentHubBinding | null {
  const safeId = portableRef(installedAgentId);
  if (!safeId) return null;
  const row = getDb().prepare(
    `SELECT installed_agent_id, agent_definition_id, agent_release_id, source, bound_at
     FROM installed_agent_hub_bindings WHERE installed_agent_id = ?`,
  ).get(safeId) as BindingRow | undefined;
  return row ? fromRow(row) : null;
}

export function listInstalledAgentHubBindings(limit = 64): InstalledAgentHubBinding[] {
  const boundedLimit = Math.max(0, Math.min(64, Math.floor(limit)));
  if (boundedLimit === 0) return [];
  const rows = getDb().prepare(
    `SELECT b.installed_agent_id, b.agent_definition_id, b.agent_release_id, b.source, b.bound_at
     FROM installed_agent_hub_bindings b
     INNER JOIN installed_agents a ON a.id = b.installed_agent_id
     ORDER BY a.installed_at DESC, b.installed_agent_id ASC
     LIMIT ?`,
  ).all(boundedLimit) as BindingRow[];
  return rows.flatMap((row) => {
    const binding = fromRow(row);
    return binding ? [binding] : [];
  });
}
