import type { MarketplaceListing, ProjectAgentPoolMember } from "../../shared/types";
import type { BorrowedAgentSpec } from "./borrowed-task-force";

export class ProjectCloudRosterError extends Error {
  constructor(readonly code: string, targetId: string) {
    super(`${code}: ${targetId}`);
    this.name = "ProjectCloudRosterError";
  }
}

export interface PinnedProjectCloudTarget {
  slug: string;
  entityKind: "agent" | "team";
  packageHash: string;
  agentDefinitionId?: string;
  agentReleaseId?: string;
}

interface ProjectCloudDefinition {
  id: string;
  slug: string;
  entityKind: "agent" | "team";
  currentReleaseId: string;
  state: string;
}

interface ProjectCloudRosterDependencies {
  listOwnerCloud: () => Promise<readonly MarketplaceListing[]>;
  listDefinitions?: () => Promise<readonly ProjectCloudDefinition[]>;
  resolveBase?: (input: { slug: string; packageHash: string }) => Promise<{
    slug: string;
    packageHash: string;
    agentDefinitionId: string;
    agentReleaseId: string;
  }>;
}

/** Older owner shelves expose slug/revision/hash but omit the canonical pair
 * saved by another catalog version. Resolve the pair via read-only canonical
 * APIs and cross-check its exact hash; a display name is never a lookup key. */
export async function resolveProjectCloudRoster(
  pool: readonly ProjectAgentPoolMember[],
  dependencies: ProjectCloudRosterDependencies,
): Promise<PinnedProjectCloudTarget[]> {
  if (!pool.some((row) => row.source === "cloud")) return [];
  let ownerCloud = [...await dependencies.listOwnerCloud()];
  const unresolved = pool.filter((member) => member.source === "cloud"
    && !ownerCloud.some((row) => row.source === "cloud"
      && (row.agentDefinitionId === member.targetId || row.slug === member.targetId)));
  if (unresolved.length > 0 && dependencies.listDefinitions && dependencies.resolveBase) {
    const definitions = await dependencies.listDefinitions();
    for (const member of unresolved) {
      const matches = definitions.filter((row) => row.id === member.targetId && row.entityKind === member.entityKind);
      if (matches.length !== 1) throw new ProjectCloudRosterError("project-cloud-target-unavailable", member.targetId);
      const definition = matches[0];
      if (definition.state !== "active" || definition.currentReleaseId !== member.releaseId) {
        throw new ProjectCloudRosterError("project-cloud-release-pin-mismatch", member.targetId);
      }
      const listings = ownerCloud.filter((row) => row.source === "cloud"
        && row.slug === definition.slug && row.entityKind === member.entityKind);
      if (listings.length !== 1 || !/^[a-f0-9]{64}$/i.test(listings[0].packageHash ?? "")) {
        throw new ProjectCloudRosterError("project-cloud-package-pin-unavailable", member.targetId);
      }
      const listing = listings[0];
      const base = await dependencies.resolveBase({ slug: listing.slug, packageHash: listing.packageHash! });
      if (base.slug !== listing.slug || base.packageHash !== listing.packageHash
        || base.agentDefinitionId !== member.targetId || base.agentReleaseId !== member.releaseId) {
        throw new ProjectCloudRosterError("project-cloud-canonical-release-mismatch", member.targetId);
      }
      ownerCloud = ownerCloud.map((row) => row === listing ? {
        ...row, agentDefinitionId: base.agentDefinitionId, agentReleaseId: base.agentReleaseId,
      } : row);
    }
  }
  return resolveProjectCloudTargets(pool, ownerCloud);
}

/** Only the authenticated owner shelf can resolve Cloud identities. Display
 * names and local copies never authorize a different release or source. */
export function resolveProjectCloudTargets(
  pool: readonly ProjectAgentPoolMember[],
  ownerCloud: readonly MarketplaceListing[],
): PinnedProjectCloudTarget[] {
  const targets: PinnedProjectCloudTarget[] = [];
  const seen = new Set<string>();
  for (const member of pool.filter((row) => row.source === "cloud")) {
    const fail = (code: string): never => { throw new ProjectCloudRosterError(code, member.targetId); };
    if (!member.releaseId?.trim()) fail("project-cloud-release-pin-missing");
    const matches = ownerCloud.filter((row) =>
      row.source === "cloud"
      && (row.agentDefinitionId === member.targetId || row.slug === member.targetId)
      && row.entityKind === member.entityKind,
    );
    if (matches.length !== 1) fail(matches.length ? "project-cloud-target-ambiguous" : "project-cloud-target-unavailable");
    const row = matches[0];
    // This is the same release-token precedence used when the roster is saved.
    // A revision token is opaque; hepCall's version argument is a package hash.
    const releasePin = row.agentReleaseId?.trim()
      || (row.revision == null ? "" : String(row.revision).trim())
      || row.packageHash?.trim();
    if (releasePin !== member.releaseId) fail("project-cloud-release-pin-mismatch");
    if (!row.slug?.trim() || !/^[a-f0-9]{64}$/i.test(row.packageHash ?? "")) {
      fail("project-cloud-package-pin-unavailable");
    }
    if (row.callable === false || row.kind === "install-only") fail("project-cloud-target-not-callable");
    const key = `${member.entityKind}:${row.slug}:${row.packageHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      slug: row.slug,
      entityKind: member.entityKind,
      packageHash: row.packageHash!,
      ...(row.agentDefinitionId ? { agentDefinitionId: row.agentDefinitionId } : {}),
      ...(row.agentReleaseId ? { agentReleaseId: row.agentReleaseId } : {}),
    });
  }
  return targets;
}

/** Prepare exact releases through Core, then check the returned authoritative
 * bundle. Resolve every row first so a stale later pin cannot cause partial
 * preparation. API errors propagate unchanged; there is no latest fallback. */
export async function prepareProjectCloudRoster(
  pool: readonly ProjectAgentPoolMember[],
  dependencies: ProjectCloudRosterDependencies & {
    prepare: (target: PinnedProjectCloudTarget) => Promise<BorrowedAgentSpec>;
  },
): Promise<BorrowedAgentSpec[]> {
  if (!pool.some((row) => row.source === "cloud")) return [];
  const targets = await resolveProjectCloudRoster(pool, dependencies);
  const specs: BorrowedAgentSpec[] = [];
  for (const target of targets) {
    const spec = await dependencies.prepare(target);
    if (spec.packageHash !== target.packageHash
      || (target.agentDefinitionId && spec.agentDefinitionId !== target.agentDefinitionId)
      || (target.agentReleaseId && spec.agentReleaseId !== target.agentReleaseId)) {
      throw new ProjectCloudRosterError("project-cloud-prepared-release-mismatch", target.slug);
    }
    if (spec.entityKind !== target.entityKind) {
      throw new ProjectCloudRosterError("project-cloud-prepared-entity-mismatch", target.slug);
    }
    if (target.entityKind === "team" && !spec.executionGraph) {
      throw new ProjectCloudRosterError("team_execution_graph_unavailable", target.slug);
    }
    specs.push({ ...spec, source: "cloud", routeLabel: "Agent Cloud" });
  }
  return specs;
}
