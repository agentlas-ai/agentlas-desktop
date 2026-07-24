import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FirmOrgNode } from "../../shared/types";

export type MaterializableFirmNode = FirmOrgNode & { agentId: string };

export interface TeamMemberMaterializationInput {
  firmId: string;
  firmSlug: string;
  ceoAgentId: string;
  installedAt: string;
  orgChart: MaterializableFirmNode[];
  /** v75 compatibility only: preserves legacy slug-keyed member memory. */
  preserveLegacySlugIds?: boolean;
}

function stableMemberId(firmId: string, agentSlug: string): string {
  const digest = createHash("sha256")
    .update("agentlas:team-member-cell:v1\0")
    .update(firmId)
    .update("\0")
    .update(agentSlug)
    .digest("hex");
  return `team-member:${digest}`;
}

function shortMemberDigest(firmId: string, agentSlug: string): string {
  return createHash("sha256")
    .update("agentlas:team-member-slug:v1\0")
    .update(firmId)
    .update("\0")
    .update(agentSlug)
    .digest("hex")
    .slice(0, 10);
}

function normalizedSlug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || "member";
}

function englishMemberName(role: string, agentSlug: string): string {
  if (role && !/[\uac00-\ud7af]/.test(role)) return role;
  const slug = normalizedSlug(agentSlug);
  return slug.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * Materialize every non-CEO organization node as a durable installed agent.
 *
 * The caller owns the surrounding transaction. This function is deterministic
 * and idempotent: the same firm/node key always resolves to the same member ID,
 * while a slug collision with another asset gets a firm-scoped slug instead of
 * silently linking to the foreign agent.
 */
export function materializeTeamMemberCells(
  db: Database.Database,
  input: TeamMemberMaterializationInput,
): MaterializableFirmNode[] {
  const chart = input.orgChart.map((node) => ({ ...node }));
  const findById = db.prepare(
    "SELECT id, slug, parent_team_id FROM installed_agents WHERE id = ? LIMIT 1",
  );
  const findBySlug = db.prepare(
    "SELECT id, slug, parent_team_id FROM installed_agents WHERE slug = ? LIMIT 1",
  );
  const insertMember = db.prepare(`
    INSERT INTO installed_agents
      (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
       env_requirements_json, preferred_backend, trust_grade, installed_at, tone,
       builtin, role, visibility, entity_kind, parent_team_id)
    VALUES
      (@id, @slug, @name, @nameEn, '', '', '', '[]',
       '[]', NULL, 'unknown', @installedAt, 'blue',
       0, @role, 'visible', 'agent', @parentTeamId)
  `);
  const attachMember = db.prepare(`
    UPDATE installed_agents
       SET parent_team_id = COALESCE(parent_team_id, ?)
     WHERE id = ?
  `);

  const renamedSlugs = new Map<string, string>();
  for (const node of chart) {
    const sourceSlug = String(node.agentSlug ?? "").trim();
    if (!sourceSlug) continue;
    if (node.agentId === input.ceoAgentId) continue;

    const currentId = String(node.agentId ?? "").trim();
    if (currentId) {
      const current = findById.get(currentId) as
        | { id: string; slug: string; parent_team_id: string | null }
        | undefined;
      if (current?.parent_team_id === input.firmId) {
        continue;
      }
    }

    const legacy = input.preserveLegacySlugIds
      ? findById.get(sourceSlug) as
          | { id: string; slug: string; parent_team_id: string | null }
          | undefined
      : undefined;
    const deterministicId = (
      input.preserveLegacySlugIds
      && (!legacy || legacy.parent_team_id === input.firmId)
    )
      ? sourceSlug
      : stableMemberId(input.firmId, sourceSlug);
    const deterministic = findById.get(deterministicId) as
      | { id: string; slug: string; parent_team_id: string | null }
      | undefined;
    if (deterministic?.parent_team_id === input.firmId) {
      node.agentId = deterministic.id;
      if (deterministic.slug !== sourceSlug) {
        renamedSlugs.set(sourceSlug, deterministic.slug);
        node.agentSlug = deterministic.slug;
      }
      continue;
    }

    const slugOwner = findBySlug.get(sourceSlug) as
      | { id: string; slug: string; parent_team_id: string | null }
      | undefined;
    if (
      slugOwner
      && (
        slugOwner.parent_team_id === input.firmId
        || (input.preserveLegacySlugIds && slugOwner.id === deterministicId)
      )
    ) {
      attachMember.run(input.firmId, slugOwner.id);
      node.agentId = slugOwner.id;
      continue;
    }

    const memberSlug = slugOwner
      ? `${normalizedSlug(input.firmSlug)}-${normalizedSlug(sourceSlug)}-${shortMemberDigest(input.firmId, sourceSlug)}`
      : sourceSlug;
    const role = String(node.role ?? "").trim() || sourceSlug;
    insertMember.run({
      id: deterministicId,
      slug: memberSlug,
      name: role,
      nameEn: englishMemberName(role, memberSlug),
      role,
      installedAt: input.installedAt,
      parentTeamId: input.firmId,
    });
    node.agentId = deterministicId;
    if (memberSlug !== sourceSlug) {
      renamedSlugs.set(sourceSlug, memberSlug);
      node.agentSlug = memberSlug;
    }
  }

  if (renamedSlugs.size > 0) {
    for (const node of chart) {
      const reportsTo = typeof node.reportsTo === "string" ? node.reportsTo : null;
      if (reportsTo && renamedSlugs.has(reportsTo)) node.reportsTo = renamedSlugs.get(reportsTo)!;
    }
  }
  return chart;
}
