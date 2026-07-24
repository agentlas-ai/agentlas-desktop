import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  BorrowedAgentProfile,
  BorrowedAgentRuntimeSnapshot,
  ExperienceOntologyGraphEdge,
  ExperienceOntologyGraphNode,
  ExperienceOntologyGraphSnapshot,
  MarketplaceListing,
} from "../../shared/types";
import type { WorkloadResolution } from "../runtime/workload-routing";
import { getDb } from "../store/db";
import { listHubAgentBookmarks } from "../store/hub-bookmarks";
import {
  activeBorrowedOwnerScopeKey,
  borrowedMemoryKey,
  borrowedProfileId,
  DEVICE_LOCAL_BORROWED_OWNER_SCOPE,
} from "./borrowed-owner-scope";
import {
  normalizeHubMemorySlug,
  readableActiveHubMemoryNestRoots,
} from "./hub-memory-nest";
import { autoLocalEmbedding, rankHybridLocal } from "../memory/local-embedding";

type CareerRow = {
  owner_scope_key: string;
  entity_kind: "agent" | "team";
  agent_definition_id: string;
  agent_release_id: string;
  component_id: string;
  slug: string;
  memory_key: string;
  first_used_at: string;
  last_used_at: string;
  use_count: number;
  latest_runtime_json: string | null;
  name_en: string | null;
  name_ko: string | null;
  tagline_en: string | null;
  tagline_ko: string | null;
};

const GRAPH_NODE_LIMIT = 400 as const;
const GRAPH_EDGE_LIMIT = 800 as const;

function openReadonlyNestDatabase(memoryRoot: string): Database.Database | null {
  const dbPath = path.join(memoryRoot, "experience.sqlite");
  try {
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function safeEntityKind(value: unknown): "agent" | "team" {
  return value === "team" || value === "group" ? "team" : "agent";
}

function titleFromSlug(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function safeEnglishName(listing: MarketplaceListing | undefined, slug: string): string {
  const candidate = listing?.nameEn?.trim() ?? "";
  return candidate && !/[\uac00-\ud7af]/.test(candidate) ? candidate : titleFromSlug(slug);
}

function parseRuntime(value: string | null): BorrowedAgentRuntimeSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as BorrowedAgentRuntimeSnapshot;
    if (
      !parsed
      || typeof parsed.provider !== "string"
      || typeof parsed.modelId !== "string"
      || typeof parsed.effort !== "string"
      || typeof parsed.recordedAt !== "string"
      || !["ai-assigned", "manual-override", "safe-fallback"].includes(parsed.source)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function runtimeSnapshot(
  resolution: Pick<WorkloadResolution, "runtime" | "source">,
  recordedAt: string,
): BorrowedAgentRuntimeSnapshot {
  return {
    provider: resolution.runtime.backend ?? resolution.runtime.kind,
    modelId: resolution.runtime.model ?? resolution.runtime.kind,
    effort: resolution.runtime.effort ?? "none",
    source: resolution.source,
    recordedAt,
  };
}

/**
 * Record only a Hub/cloud borrowed execution. The owner was frozen when the
 * invocation began; an account switch during the run makes this a no-op.
 */
export function recordBorrowedAgentCareer(input: {
  ownerScopeKey: string;
  slug: string;
  agentDefinitionId: string;
  agentReleaseId: string;
  componentId?: string;
  entityKind?: "agent" | "team" | "group";
  source?: string;
  runId: string;
  resolution: Pick<WorkloadResolution, "runtime" | "source">;
  localized: {
    titleEn: string;
    titleKo: string;
    descriptionEn: string;
    descriptionKo: string;
  };
}): boolean {
  if (input.source && input.source !== "hub" && input.source !== "cloud") return false;
  if (activeBorrowedOwnerScopeKey() !== input.ownerScopeKey) return false;
  const slug = normalizeHubMemorySlug(input.slug);
  const agentDefinitionId = input.agentDefinitionId.trim();
  const agentReleaseId = input.agentReleaseId.trim();
  const componentId = String(input.componentId ?? "").trim();
  if (!slug || !agentDefinitionId || !agentReleaseId || !input.runId.trim()) return false;
  if (
    !input.localized.titleEn.trim()
    || !input.localized.titleKo.trim()
    || !input.localized.descriptionEn.trim()
    || !input.localized.descriptionKo.trim()
    || /[\uac00-\ud7af]/.test(input.localized.titleEn)
    || /[\uac00-\ud7af]/.test(input.localized.descriptionEn)
  ) return false;
  const entityKind = safeEntityKind(input.entityKind);
  const memoryKey = borrowedMemoryKey(agentDefinitionId, agentReleaseId, componentId);
  const now = new Date().toISOString();
  const runIdHash = createHash("sha256")
    .update("agentlas:borrowed-agent-career-run:v1\0")
    .update(input.ownerScopeKey)
    .update("\0")
    .update(input.runId)
    .digest("hex");
  const runtimeJson = JSON.stringify(runtimeSnapshot(input.resolution, now));
  const db = getDb();
  const write = db.transaction(() => {
    db.prepare(`
      INSERT INTO borrowed_agent_careers (
        owner_scope_key, entity_kind, agent_definition_id, agent_release_id,
        component_id, slug, memory_key, first_used_at, last_used_at,
        use_count, latest_runtime_json, name_en, name_ko, tagline_en, tagline_ko
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(
        owner_scope_key, entity_kind, agent_definition_id, agent_release_id, component_id
      ) DO UPDATE SET
        slug = excluded.slug,
        memory_key = excluded.memory_key,
        last_used_at = MAX(borrowed_agent_careers.last_used_at, excluded.last_used_at),
        latest_runtime_json = excluded.latest_runtime_json,
        name_en = excluded.name_en,
        name_ko = excluded.name_ko,
        tagline_en = excluded.tagline_en,
        tagline_ko = excluded.tagline_ko
    `).run(
      input.ownerScopeKey,
      entityKind,
      agentDefinitionId,
      agentReleaseId,
      componentId,
      slug,
      memoryKey,
      now,
      now,
      runtimeJson,
      input.localized.titleEn.trim(),
      input.localized.titleKo.trim(),
      input.localized.descriptionEn.trim(),
      input.localized.descriptionKo.trim(),
    );
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO borrowed_agent_career_runs (
        owner_scope_key, entity_kind, agent_definition_id, agent_release_id,
        component_id, run_id_hash, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ownerScopeKey,
      entityKind,
      agentDefinitionId,
      agentReleaseId,
      componentId,
      runIdHash,
      now,
    );
    if (inserted.changes > 0) {
      db.prepare(`
        UPDATE borrowed_agent_careers
           SET use_count = use_count + 1,
               first_used_at = MIN(first_used_at, ?),
               last_used_at = MAX(last_used_at, ?)
         WHERE owner_scope_key = ? AND entity_kind = ?
           AND agent_definition_id = ? AND agent_release_id = ? AND component_id = ?
      `).run(
        now,
        now,
        input.ownerScopeKey,
        entityKind,
        agentDefinitionId,
        agentReleaseId,
        componentId,
      );
    }
  });
  write();
  return true;
}

function readNestCounts(memoryKey: string): { memoryCount: number; relationCount: number } {
  let memoryCount = 0;
  let relationCount = 0;
  for (const root of readableActiveHubMemoryNestRoots(memoryKey)) {
    let db: Database.Database | null = null;
    try {
      db = openReadonlyNestDatabase(root);
      if (!db) continue;
      memoryCount += Number((db.prepare(
        "SELECT COUNT(*) AS n FROM memory_candidates WHERE agent_id = ? AND status = 'active'",
      ).get(`hub:${memoryKey}`) as { n?: number } | undefined)?.n ?? 0);
      relationCount += Number((db.prepare(
        `SELECT COUNT(*) AS n
           FROM memory_links link
           JOIN memory_candidates source ON source.ticket_id = link.from_ticket
           JOIN memory_candidates target ON target.ticket_id = link.to_ticket
          WHERE source.agent_id = ? AND target.agent_id = ?
            AND source.status = 'active' AND target.status = 'active'`,
      ).get(`hub:${memoryKey}`, `hub:${memoryKey}`) as { n?: number } | undefined)?.n ?? 0);
    } catch {
      // A rebuildable or legacy cache may be absent/corrupt.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return { memoryCount, relationCount };
}

export function listBorrowedAgentProfiles(): BorrowedAgentProfile[] {
  const ownerScopeKey = activeBorrowedOwnerScopeKey();
  const careers = getDb().prepare(`
    SELECT owner_scope_key, entity_kind, agent_definition_id, agent_release_id,
           component_id, slug, memory_key, first_used_at, last_used_at,
           use_count, latest_runtime_json, name_en, name_ko, tagline_en, tagline_ko
      FROM borrowed_agent_careers
     WHERE owner_scope_key = ?
     ORDER BY last_used_at DESC, entity_kind ASC, slug ASC
  `).all(ownerScopeKey) as CareerRow[];
  const identityKey = (
    entityKind: "agent" | "team",
    definitionId: string,
    releaseId: string,
    componentId = "",
  ) => `${entityKind}\0${definitionId}\0${releaseId}\0${componentId}`;
  const careerByKey = new Map(careers.map((row) => [
    identityKey(row.entity_kind, row.agent_definition_id, row.agent_release_id, row.component_id),
    row,
  ]));
  const listingByKey = new Map<string, { listing: MarketplaceListing; bookmarkedAt: string }>();
  for (const bookmark of listHubAgentBookmarks()) {
    if (bookmark.listing.entityKind === "plugin") continue;
    const definitionId = bookmark.listing.agentDefinitionId?.trim() ?? "";
    const releaseId = bookmark.listing.agentReleaseId?.trim() ?? "";
    if (!definitionId || !releaseId) continue;
    const entityKind = safeEntityKind(bookmark.listing.entityKind);
    listingByKey.set(identityKey(entityKind, definitionId, releaseId), {
      listing: bookmark.listing,
      bookmarkedAt: bookmark.bookmarked === false ? "" : bookmark.bookmarkedAt,
    });
  }
  const keys = new Set([...careerByKey.keys(), ...listingByKey.keys()]);
  const profiles = [...keys].flatMap((key): BorrowedAgentProfile[] => {
    const [kindValue, definitionId, releaseId, componentId = ""] = key.split("\0");
    const entityKind = safeEntityKind(kindValue);
    const career = careerByKey.get(key);
    const bookmark = listingByKey.get(key);
    const listing = bookmark?.listing;
    const slug = career?.slug ?? normalizeHubMemorySlug(listing?.slug) ?? "";
    const memoryKey = career?.memory_key ?? borrowedMemoryKey(definitionId, releaseId, componentId);
    const counts = readNestCounts(memoryKey);
    let deviceHistory: unknown = null;
    if (ownerScopeKey !== DEVICE_LOCAL_BORROWED_OWNER_SCOPE) {
      deviceHistory = getDb().prepare(`
          SELECT 1 FROM borrowed_agent_careers
           WHERE owner_scope_key = ? AND entity_kind = ?
             AND agent_definition_id = ? AND agent_release_id = ?
             AND component_id = ? AND use_count > 0
           LIMIT 1
        `).get(
          DEVICE_LOCAL_BORROWED_OWNER_SCOPE,
          entityKind,
          definitionId,
          releaseId,
          componentId,
        );
      if (!deviceHistory) {
        const hasLegacyTable = Boolean(getDb().prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'borrowed_agent_careers_v76_legacy'",
        ).get());
        if (hasLegacyTable) {
          deviceHistory = getDb().prepare(`
            SELECT 1 FROM borrowed_agent_careers_v76_legacy
             WHERE owner_scope_key = ? AND entity_kind = ? AND slug = ? AND use_count > 0
             LIMIT 1
          `).get(DEVICE_LOCAL_BORROWED_OWNER_SCOPE, entityKind, slug);
        }
      }
    }
    const componentLabel = componentId ? titleFromSlug(componentId) : "";
    const nameEn = componentLabel || safeEnglishName(listing, career?.name_en ?? "");
    if (!nameEn || /[\uac00-\ud7af]/.test(nameEn)) return [];
    return [{
      profileId: borrowedProfileId(ownerScopeKey, entityKind, definitionId, releaseId, componentId),
      agentDefinitionId: definitionId,
      agentReleaseId: releaseId,
      componentId,
      slug,
      entityKind,
      name: componentLabel || listing?.name?.trim() || career?.name_ko?.trim() || nameEn,
      nameEn,
      tagline: listing?.tagline?.trim() || career?.tagline_ko?.trim() || career?.tagline_en?.trim() || "",
      taglineEn: listing?.taglineEn?.trim() && !/[\uac00-\ud7af]/.test(listing.taglineEn)
        ? listing.taglineEn.trim()
        : career?.tagline_en?.trim() || "",
      bookmarkedAt: bookmark?.bookmarkedAt || null,
      firstUsedAt: career?.first_used_at ?? null,
      lastUsedAt: career?.last_used_at ?? null,
      useCount: career?.use_count ?? 0,
      latestRuntime: parseRuntime(career?.latest_runtime_json ?? null),
      memoryCount: counts.memoryCount,
      relationCount: counts.memoryCount + counts.relationCount,
      hasQuarantinedDeviceHistory: Boolean(deviceHistory),
    }];
  });
  return profiles.sort((left, right) =>
    Number(Boolean(right.bookmarkedAt)) - Number(Boolean(left.bookmarkedAt))
    || right.useCount - left.useCount
    || (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "")
    || left.nameEn.localeCompare(right.nameEn));
}

function stableGraphId(...parts: string[]): string {
  return `borrowed-graph:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;
}

export function getBorrowedAgentOntologyGraph(profileIdValue: string): ExperienceOntologyGraphSnapshot {
  const profileId = String(profileIdValue ?? "").trim();
  const profile = listBorrowedAgentProfiles().find((item) => item.profileId === profileId);
  if (!profile) throw new Error("Borrowed agent profile not found for the active owner.");
  const rootId = stableGraphId(profile.profileId, "root");
  const nodes: ExperienceOntologyGraphNode[] = [{
    id: rootId,
    kind: "agent",
    ref: profile.profileId,
    safeLabel: "Agent",
    status: "active",
    source: "synthetic",
  }];
  const edges: ExperienceOntologyGraphEdge[] = [];
  const ticketNodeId = new Map<string, string>();
  const memoryKey = borrowedMemoryKey(
    profile.agentDefinitionId,
    profile.agentReleaseId,
    profile.componentId,
  );
  for (const root of readableActiveHubMemoryNestRoots(memoryKey)) {
    let db: Database.Database | null = null;
    try {
      db = openReadonlyNestDatabase(root);
      if (!db) continue;
      const memories = db.prepare(`
        SELECT ticket_id, candidate_text
          FROM memory_candidates
         WHERE agent_id = ? AND status = 'active'
         ORDER BY updated_at DESC, ticket_id ASC
         LIMIT ?
      `).all(`hub:${memoryKey}`, GRAPH_NODE_LIMIT - nodes.length) as Array<{
        ticket_id: string;
        candidate_text: string;
      }>;
      for (const memory of memories) {
        if (nodes.length >= GRAPH_NODE_LIMIT) break;
        const nodeId = stableGraphId(profile.profileId, "memory", memory.ticket_id);
        if (ticketNodeId.has(memory.ticket_id)) continue;
        ticketNodeId.set(memory.ticket_id, nodeId);
        nodes.push({
          id: nodeId,
          kind: "experience-item",
          ref: stableGraphId("memory-ref", memory.ticket_id),
          safeLabel: "Experience",
          localLabel: memory.candidate_text.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120),
          status: "active",
          source: "relation-index",
        });
        if (edges.length < GRAPH_EDGE_LIMIT) {
          edges.push({
            id: stableGraphId(profile.profileId, rootId, nodeId, "contains"),
            from: rootId,
            to: nodeId,
            kind: "contains",
            status: "active",
          });
        }
      }
      const links = db.prepare(`
        SELECT link_id, from_ticket, to_ticket, link_type
          FROM memory_links
         WHERE from_ticket IN (SELECT ticket_id FROM memory_candidates WHERE agent_id = ? AND status = 'active')
           AND to_ticket IN (SELECT ticket_id FROM memory_candidates WHERE agent_id = ? AND status = 'active')
         ORDER BY created_at DESC, link_id ASC
         LIMIT ?
      `).all(`hub:${memoryKey}`, `hub:${memoryKey}`, GRAPH_EDGE_LIMIT) as Array<{
        link_id: string;
        from_ticket: string;
        to_ticket: string;
        link_type: "similar_to" | "supersedes" | "contradicts";
      }>;
      for (const link of links) {
        const from = ticketNodeId.get(link.from_ticket);
        const to = ticketNodeId.get(link.to_ticket);
        if (!from || !to || edges.length >= GRAPH_EDGE_LIMIT) continue;
        edges.push({
          id: stableGraphId(profile.profileId, "link", link.link_id),
          from,
          to,
          kind: link.link_type,
          status: link.link_type === "supersedes" ? "historical" : "active",
        });
      }
    } catch {
      // A missing/corrupt private projection yields the honest root-only state.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return {
    schema: "agentlas.ontology-relation-graph.v1",
    agentId: profile.profileId,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    totalNodeCount: nodes.length,
    totalEdgeCount: edges.length,
    omittedNodeCount: 0,
    omittedEdgeCount: 0,
    truncated: nodes.length >= GRAPH_NODE_LIMIT || edges.length >= GRAPH_EDGE_LIMIT,
    limits: { nodes: GRAPH_NODE_LIMIT, edges: GRAPH_EDGE_LIMIT },
  };
}

/** Task-selected private recall for the active owner's exact borrowed agent. */
export function buildBorrowedAgentMemoryContext(memoryKeyValue: string, task: string): string {
  const memoryKey = normalizeHubMemorySlug(memoryKeyValue);
  if (!memoryKey || !task.trim()) return "";
  const rows = new Map<string, { id: string; text: string; embedding: number[]; prior: number }>();
  for (const root of readableActiveHubMemoryNestRoots(memoryKey)) {
    let db: Database.Database | null = null;
    try {
      db = openReadonlyNestDatabase(root);
      if (!db) continue;
      const candidates = db.prepare(`
        SELECT ticket_id, candidate_text, confidence
          FROM memory_candidates
         WHERE agent_id = ? AND status = 'active'
         ORDER BY updated_at DESC, ticket_id ASC
         LIMIT 200
      `).all(`hub:${memoryKey}`) as Array<{ ticket_id: string; candidate_text: string; confidence: number }>;
      for (const candidate of candidates) {
        if (rows.has(candidate.ticket_id)) continue;
        const text = candidate.candidate_text.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 800);
        if (!text) continue;
        rows.set(candidate.ticket_id, {
          id: candidate.ticket_id,
          text,
          embedding: autoLocalEmbedding(text).vector,
          prior: Number(candidate.confidence ?? 0),
        });
      }
    } catch {
      // Missing/corrupt cache means no recall, never cross-owner fallback.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  const selected = rankHybridLocal(task, [...rows.values()])
    .filter((entry) => entry.lexicalScore > 0 || entry.semanticEligible)
    .slice(0, 8)
    .map((entry) => `- ${entry.item.text}`);
  if (selected.length === 0) return "";
  return [
    "## Private experience from this Agentlas user's prior runs",
    "Use only when relevant to the current task. Current instructions and the Hub base definition win.",
    ...selected,
  ].join("\n");
}
