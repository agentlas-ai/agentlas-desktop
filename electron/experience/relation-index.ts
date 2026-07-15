import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExperienceMcpRequirement,
  ExperienceOntologyGraphEdge,
  ExperienceOntologyGraphNode,
  ExperienceOntologyGraphNodeKind,
  ExperienceOntologyGraphSnapshot,
} from "../../shared/types";
import { EXPERIENCE_RELATION_LEDGER_FILE } from "../architecture/manifest";
import { getDb } from "../store/db";
import { isCanonicalTaskId } from "./taxonomy";
import {
  autoLocalEmbedding,
  cosineSimilarity,
  parseLocalEmbedding,
} from "../memory/local-embedding";

const LINEAGE_SCHEMA_VERSION = "agentlas.experience-relation-lineage.v1";
const LINEAGE_KIND = "agentlas-experience-relation-lineage";
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,255}$/;
const UNSAFE_ID_RE = /(?:^[/\\]|:\/\/|\\|\/Users\/|\/home\/|file:|api[_-]?key|token|secret|password|authorization|cookie)/i;
const MAX_RELATION_ITEMS_PER_PACK = 256;
const ONTOLOGY_GRAPH_NODE_LIMIT = 400 as const;
const ONTOLOGY_GRAPH_EDGE_LIMIT = 800 as const;
const EMAIL_VALUE_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/i;
const SECRET_VALUE_RE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer[ _-][A-Za-z0-9._~-]{12,}|BEGIN[ _-](?:RSA[ _-]|OPENSSH[ _-]|EC[ _-]|DSA[ _-])?PRIVATE[ _-]KEY)/i;
const PROMPT_MATERIAL_ID_RE = /(?:raw|system|developer|user)[_.:@-]?prompt|prompt[_.:@-]?(?:dump|material)|raw[_.:@-]?transcript/i;
const TASTE_AXIS_IDS = new Set([
  "composition",
  "color",
  "typography",
  "motion",
  "pacing",
  "density",
  "imagery",
  "editing",
  "spatial-rhythm",
]);

type PackRow = {
  id: string;
  agent_id: string;
  project_path: string | null;
  project_scope_key: string;
  environment_key: string;
  name: string;
  description: string;
  base_package_hash: string | null;
  mcp_requirements_json: string;
  status: "active" | "archived";
  updated_at: string;
};

type ItemSourceRow = {
  id: string;
  summary: string;
  task_terms_json: string;
  public_safe: number;
  confidence: string;
  outcome_status: string;
  updated_at: string;
  receipt_id: string | null;
  evidence_hash: string | null;
  verification_status: string | null;
};

type TaskBinding = { itemId: string; tags: string[] };
type EvidenceBinding = { itemId: string; receiptIds: string[] };

type ReleaseProjection = {
  packId: string;
  releaseId: string;
  basePackageHash: string;
  projectScopeKey: string;
  environmentKey: string;
  itemIds: string[];
  localTaskBindings: TaskBinding[];
  lineageTaskBindings: TaskBinding[];
  mcpRequirements: ExperienceMcpRequirement[];
  evidenceBindings: EvidenceBinding[];
  supersedesReleaseId: string | null;
  sourceFingerprint: string;
  current: boolean;
};

type LineageRow = {
  id: string;
  pack_id: string;
  release_id: string;
  event_type: "promotion" | "export-intent";
  base_package_hash: string;
  project_scope_key: string;
  environment_key: string;
  item_ids_json: string;
  task_bindings_json: string;
  mcp_requirements_json: string;
  evidence_bindings_json: string;
  supersedes_release_id: string | null;
  source_fingerprint: string;
  created_at: string;
};

export interface ExperienceRelationIndexStatus {
  stale: boolean;
  sourceFingerprint: string;
  indexedFingerprint: string | null;
  rebuiltAt: string | null;
  nodeCount: number;
  edgeCount: number;
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function hashRef(...parts: string[]): string {
  return `sha256:${digest(...parts)}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${digest(...parts)}`;
}

function safeId(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID_RE.test(text) || UNSAFE_ID_RE.test(text)) {
    throw new Error(`${label} must be a value-free identifier.`);
  }
  return text;
}

function valueFreeGraphId(value: unknown): string | null {
  try {
    const text = safeId(value, "Ontology graph reference");
    if (EMAIL_VALUE_RE.test(text) || SECRET_VALUE_RE.test(text) || PROMPT_MATERIAL_ID_RE.test(text)) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

function requiredValueFreeGraphId(value: unknown, label: string): string {
  const text = valueFreeGraphId(value);
  if (!text) throw new Error(`${label} must be a value-free identifier.`);
  return text;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJsonArray<T>(value: string, fallback: T[] = []): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeExperienceMcpRequirements(
  value: unknown,
  fallbackCatalogIds: string[] = [],
): ExperienceMcpRequirement[] {
  const explicit = value !== undefined;
  const source = explicit
    ? value
    : fallbackCatalogIds.map((catalogId) => ({ catalogId, required: false, alternatives: [] }));
  if (!Array.isArray(source) || source.length > 32) {
    throw new Error("Experience MCP requirements must be an array of at most 32 catalog references.");
  }
  const byCatalog = new Map<string, ExperienceMcpRequirement>();
  for (const raw of source) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      if (explicit) throw new Error("Experience MCP requirement must be an object.");
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["catalogId", "required", "alternatives"].includes(key))) {
      throw new Error("Experience MCP requirement contains unsupported fields.");
    }
    let catalogId: string;
    try {
      catalogId = safeId(item.catalogId, "MCP catalogId");
    } catch (error) {
      if (explicit) throw error;
      continue;
    }
    if (typeof item.required !== "boolean") {
      throw new Error("Experience MCP requirement requires an explicit required boolean.");
    }
    if (!Array.isArray(item.alternatives) || item.alternatives.length > 8) {
      throw new Error("Experience MCP alternatives must be an array of at most 8 catalog IDs.");
    }
    const alternatives = [...new Set(item.alternatives.map((entry) => safeId(entry, "MCP alternative")))]
      .filter((entry) => entry !== catalogId)
      .sort();
    if (alternatives.length !== item.alternatives.length) {
      throw new Error("Experience MCP alternatives must be unique and cannot reference the primary catalog ID.");
    }
    if (byCatalog.has(catalogId)) {
      if (explicit) throw new Error("Experience MCP catalog IDs must be unique.");
      continue;
    }
    byCatalog.set(catalogId, { catalogId, required: item.required, alternatives });
  }
  return [...byCatalog.values()].sort((left, right) => left.catalogId.localeCompare(right.catalogId));
}

function parsedMcpRequirements(value: string): ExperienceMcpRequirement[] {
  try {
    return normalizeExperienceMcpRequirements(JSON.parse(value));
  } catch {
    return [];
  }
}

function safeTaskTags(value: string): string[] {
  const tags = parseJsonArray<unknown>(value)
    .map((entry) => typeof entry === "string" ? entry.normalize("NFKC").trim().toLowerCase() : "")
    .filter(isCanonicalTaskId);
  return [...new Set(tags)].sort().slice(0, 32);
}

function packRow(packId: string): PackRow {
  const row = getDb().prepare(
    `SELECT id, agent_id, project_path, project_scope_key, environment_key,
            name, description, base_package_hash, mcp_requirements_json, status, updated_at
       FROM experience_packs WHERE id = ?`,
  ).get(packId) as PackRow | undefined;
  if (!row) throw new Error("Experience Pack not found for relation indexing.");
  if (!row.base_package_hash || !/^[0-9a-f]{64}$/.test(row.base_package_hash)) {
    throw new Error("Experience relation indexing requires an exact base package hash.");
  }
  return row;
}

function itemRows(packId: string): ItemSourceRow[] {
  return getDb().prepare(
    `SELECT c.id, c.summary, c.task_terms_json, c.public_safe, c.confidence,
            c.outcome_status, c.updated_at, r.id AS receipt_id,
            r.evidence_hash, r.verification_status
       FROM experience_candidates c
       LEFT JOIN experience_promotion_receipts r
         ON r.candidate_id = c.id AND r.action = 'promote'
      WHERE c.pack_id = ? AND c.status = 'promoted'
        AND c.outcome_status IN ('attested','verified')
      ORDER BY c.id ASC`,
  ).all(packId) as ItemSourceRow[];
}

function currentReleaseProjection(pack: PackRow): ReleaseProjection {
  if (!pack.base_package_hash || !/^[0-9a-f]{64}$/.test(pack.base_package_hash)) {
    throw new Error("Experience relation release requires an exact base package hash.");
  }
  const basePackageHash = pack.base_package_hash;
  const items = itemRows(pack.id);
  if (items.length > MAX_RELATION_ITEMS_PER_PACK) {
    throw new Error(`Experience relation lineage supports at most ${MAX_RELATION_ITEMS_PER_PACK} promoted items per Pack.`);
  }
  const mcpRequirements = parsedMcpRequirements(pack.mcp_requirements_json);
  const localTaskBindings = items.map((item) => ({ itemId: item.id, tags: safeTaskTags(item.task_terms_json) }));
  // Only authoritative public-safe items can export semantic tags. P0
  // user-attested private/internal items still benefit from local relations,
  // but their derived tags never enter the project-local value-free ledger.
  const lineageTaskBindings = items
    .filter((item) => item.public_safe === 1 && item.verification_status === "verified")
    .map((item) => ({ itemId: item.id, tags: safeTaskTags(item.task_terms_json) }));
  const lineageTagsByItem = new Map(
    lineageTaskBindings.map((binding) => [binding.itemId, binding.tags]),
  );
  const evidenceBindings = items.map((item) => ({
    itemId: item.id,
    receiptIds: item.receipt_id ? [safeId(item.receipt_id, "evidence receipt id")] : [],
  }));
  const canonical = {
    packId: pack.id,
    basePackageHash,
    projectScopeKey: pack.project_scope_key,
    environmentKey: pack.environment_key,
    status: pack.status,
    mcpRequirements,
    items: items.map((item) => ({
      id: item.id,
      // Only already-authoritative public-safe tags may influence the
      // portable lineage fingerprint. Private/local tags stay solely in the
      // host-local derived-index fingerprint below.
      publicTags: lineageTagsByItem.get(item.id) ?? [],
      publicSafe: item.public_safe === 1,
      confidence: item.confidence,
      outcomeStatus: item.outcome_status,
      evidenceHash: item.evidence_hash,
      verificationStatus: item.verification_status,
    })),
  };
  const sourceFingerprint = hashRef("experience-release-source-v1", JSON.stringify(canonical));
  return {
    packId: pack.id,
    releaseId: stableId("experience-release", pack.id, sourceFingerprint),
    basePackageHash,
    projectScopeKey: pack.project_scope_key,
    environmentKey: pack.environment_key,
    itemIds: items.map((item) => item.id),
    localTaskBindings,
    lineageTaskBindings,
    mcpRequirements,
    evidenceBindings,
    supersedesReleaseId: null,
    sourceFingerprint,
    current: true,
  };
}

function scopeHash(value: string, label: string): string {
  return /^[0-9a-f]{64}$/.test(value) ? `sha256:${value}` : hashRef(label, value);
}

export function recordExperienceLineageEvent(
  packId: string,
  eventType: "promotion" | "export-intent",
): string {
  const pack = packRow(packId);
  const release = currentReleaseProjection(pack);
  const previous = getDb().prepare(
    `SELECT release_id FROM experience_lineage_events
      WHERE pack_id = ? AND release_id != ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(pack.id, release.releaseId) as { release_id: string } | undefined;
  const eventId = stableId("experience-lineage", pack.id, release.releaseId, eventType);
  const createdAt = new Date().toISOString();
  getDb().prepare(
    `INSERT OR IGNORE INTO experience_lineage_events (
       id, pack_id, release_id, event_type, base_package_hash,
       project_scope_key, environment_key, item_ids_json, task_bindings_json,
       mcp_requirements_json, evidence_bindings_json, supersedes_release_id,
       source_fingerprint, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    pack.id,
    release.releaseId,
    eventType,
    release.basePackageHash,
    release.projectScopeKey,
    release.environmentKey,
    JSON.stringify(release.itemIds),
    JSON.stringify(release.lineageTaskBindings),
    JSON.stringify(release.mcpRequirements),
    JSON.stringify(release.evidenceBindings),
    previous?.release_id ?? null,
    release.sourceFingerprint,
    createdAt,
  );
  return eventId;
}

function lineageEventFromRow(row: LineageRow): Record<string, unknown> {
  return {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    kind: LINEAGE_KIND,
    eventId: row.id,
    eventType: row.event_type,
    packId: row.pack_id,
    releaseId: row.release_id,
    baseReleaseHash: `sha256:${row.base_package_hash}`,
    projectScopeKey: scopeHash(row.project_scope_key, "experience-project-scope"),
    environmentKey: scopeHash(row.environment_key, "experience-environment"),
    itemIds: parseJsonArray<string>(row.item_ids_json),
    taskBindings: parseJsonArray<TaskBinding>(row.task_bindings_json),
    mcpRequirements: parsedMcpRequirements(row.mcp_requirements_json),
    evidenceBindings: parseJsonArray<EvidenceBinding>(row.evidence_bindings_json),
    supersedesReleaseId: row.supersedes_release_id,
    sourceFingerprint: row.source_fingerprint,
    createdAt: row.created_at,
  };
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalExistingProjectRoot(rawPath: string): string {
  if (!path.isAbsolute(rawPath)) throw new Error("Experience lineage project root must be absolute.");
  const resolved = path.resolve(rawPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error("Experience lineage project root no longer exists.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Experience lineage project root must be a real directory, not a symlink.");
  }
  const real = fs.realpathSync.native(resolved);
  if (comparablePath(real) !== comparablePath(resolved)) {
    throw new Error("Experience lineage project root is no longer the canonical approved directory.");
  }
  return real;
}

function secureLedgerDirectory(projectRoot: string): string {
  const directory = path.join(projectRoot, ".agentlas");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Experience lineage .agentlas directory cannot be a symlink or non-directory.");
  }
  const real = fs.realpathSync.native(directory);
  const expected = path.join(projectRoot, ".agentlas");
  if (comparablePath(real) !== comparablePath(expected)) {
    throw new Error("Experience lineage .agentlas directory escapes the approved project root.");
  }
  if (process.platform !== "win32") fs.chmodSync(real, 0o700);
  return real;
}

function assertSafeLedgerTarget(filePath: string, directory: string): void {
  if (comparablePath(path.dirname(filePath)) !== comparablePath(directory)) {
    throw new Error("Experience lineage target escapes its approved directory.");
  }
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Experience lineage target cannot be a symlink or non-file.");
  }
  const real = fs.realpathSync.native(filePath);
  if (comparablePath(path.dirname(real)) !== comparablePath(directory)) {
    throw new Error("Experience lineage target resolves outside the approved project root.");
  }
}

function atomicReplace(projectRoot: string, filePath: string, content: string): void {
  const directory = secureLedgerDirectory(projectRoot);
  const directoryStillApproved = (): boolean => {
    try {
      return comparablePath(secureLedgerDirectory(projectRoot)) === comparablePath(directory);
    } catch {
      return false;
    }
  };
  assertSafeLedgerTarget(filePath, directory);
  const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const backup = path.join(directory, `.${path.basename(filePath)}.previous`);
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
    if (fs.existsSync(filePath)) fs.renameSync(filePath, backup);
    // Re-check the parent immediately before committing the rename. This also
    // catches a same-user process swapping .agentlas after the first check.
    if (comparablePath(secureLedgerDirectory(projectRoot)) !== comparablePath(directory)) {
      throw new Error("Experience lineage directory changed during atomic replace.");
    }
    fs.renameSync(temp, filePath);
    assertSafeLedgerTarget(filePath, directory);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  } catch (error) {
    // Never follow a parent that was swapped to a symlink while recovering.
    if (directoryStillApproved() && !fs.existsSync(filePath) && fs.existsSync(backup)) {
      fs.renameSync(backup, filePath);
    }
    throw error;
  } finally {
    if (directoryStillApproved() && fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

export function writeExperienceLineageLedger(packId: string): string | null {
  const pack = packRow(packId);
  if (!pack.project_path) return null;
  const projectRoot = canonicalExistingProjectRoot(pack.project_path);
  const rows = getDb().prepare(
    `SELECT e.*
       FROM experience_lineage_events e
       JOIN experience_packs p ON p.id = e.pack_id
      WHERE p.project_path = ?
      ORDER BY e.created_at ASC, e.id ASC`,
  ).all(pack.project_path) as LineageRow[];
  const content = rows.map((row) => JSON.stringify(lineageEventFromRow(row))).join("\n");
  const target = path.join(projectRoot, ".agentlas", EXPERIENCE_RELATION_LEDGER_FILE);
  atomicReplace(projectRoot, target, content ? `${content}\n` : "");
  return target;
}

function lineageProjections(pack: PackRow): ReleaseProjection[] {
  const rows = getDb().prepare(
    `SELECT * FROM experience_lineage_events
      WHERE pack_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(pack.id) as LineageRow[];
  const projections = new Map<string, ReleaseProjection>();
  for (const row of rows) {
    const taskBindings = parseJsonArray<TaskBinding>(row.task_bindings_json);
    projections.set(row.release_id, {
      packId: row.pack_id,
      releaseId: row.release_id,
      basePackageHash: row.base_package_hash,
      projectScopeKey: row.project_scope_key,
      environmentKey: row.environment_key,
      itemIds: parseJsonArray<string>(row.item_ids_json),
      localTaskBindings: taskBindings,
      lineageTaskBindings: taskBindings,
      mcpRequirements: parsedMcpRequirements(row.mcp_requirements_json),
      evidenceBindings: parseJsonArray<EvidenceBinding>(row.evidence_bindings_json),
      supersedesReleaseId: row.supersedes_release_id,
      sourceFingerprint: row.source_fingerprint,
      current: false,
    });
  }
  const current = currentReleaseProjection(pack);
  const prior = [...projections.values()].reverse().find((item) => item.releaseId !== current.releaseId);
  current.supersedesReleaseId = prior?.releaseId ?? null;
  projections.set(current.releaseId, current);
  return [...projections.values()];
}

export function experienceRelationSourceFingerprint(): string {
  const packs = getDb().prepare(
    `SELECT id, agent_id, project_path, project_scope_key, environment_key,
            name, description, base_package_hash, mcp_requirements_json, status, updated_at
       FROM experience_packs ORDER BY id ASC`,
  ).all() as PackRow[];
  const source = packs.map((pack) => {
    if (pack.status !== "active" || !pack.base_package_hash) {
      return { id: pack.id, status: pack.status, updatedAt: pack.updated_at };
    }
    const current = currentReleaseProjection(pack);
    const lineage = getDb().prepare(
      `SELECT id, release_id, event_type, supersedes_release_id, source_fingerprint
         FROM experience_lineage_events WHERE pack_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(pack.id);
    const semanticItems = getDb().prepare(
      `SELECT id, summary, embedding_model, embedding_adapter, embedding_model_sha256,
              embedding_content_hash, embedding_dimensions, embedding_json
         FROM experience_candidates WHERE pack_id = ? ORDER BY id ASC`,
    ).all(pack.id) as Array<{
      id: string;
      summary: string;
      embedding_model: string | null;
      embedding_adapter: string | null;
      embedding_model_sha256: string | null;
      embedding_content_hash: string | null;
      embedding_dimensions: number | null;
      embedding_json: string | null;
    }>;
    const governanceRelations = getDb().prepare(
      `SELECT relation_id, from_candidate_id, to_candidate_id, relation_type, reason
         FROM experience_governance_relations WHERE pack_id = ?
         ORDER BY created_at ASC, relation_id ASC`,
    ).all(pack.id) as Array<{
      relation_id: string;
      from_candidate_id: string;
      to_candidate_id: string;
      relation_type: "supersedes" | "contradicts";
      reason: string;
    }>;
    return {
      id: pack.id,
      status: pack.status,
      releaseId: current.releaseId,
      sourceFingerprint: current.sourceFingerprint,
      localTaskBindings: current.localTaskBindings,
      semanticItems: semanticItems.map((item) => {
        const embedding = parseLocalEmbedding(
          item.embedding_model,
          item.embedding_dimensions,
          item.embedding_json,
          {
            adapter: item.embedding_adapter,
            modelSha256: item.embedding_model_sha256,
            contentHash: item.embedding_content_hash,
            text: item.summary,
          },
        ) ?? autoLocalEmbedding(item.summary);
        return {
          id: item.id,
          summaryHash: hashRef("experience-summary-v1", item.summary),
          embeddingHash: hashRef("experience-embedding-v1", JSON.stringify(embedding.vector)),
        };
      }),
      governanceRelations: governanceRelations.map((relation) => ({
        id: relation.relation_id,
        from: relation.from_candidate_id,
        to: relation.to_candidate_id,
        type: relation.relation_type,
        reasonHash: hashRef("experience-governance-reason-v1", relation.reason),
      })),
      lineage,
    };
  });
  return hashRef("experience-relation-index-source-v1", JSON.stringify(source));
}

type NodeInsert = {
  nodeId: string;
  packId: string;
  nodeType: "Pack" | "Release" | "Item" | "TaskTag" | "Environment" | "MCPRequirement" | "EvidenceReceipt";
  entityRef: string;
  projectScopeKey: string;
  environmentKey: string;
  basePackageHash: string;
  normalizedValue: string | null;
  payload: Record<string, unknown>;
};

type EdgeInsert = {
  edgeId: string;
  packId: string;
  fromNode: string;
  toNode: string;
  edgeType: "has_release" | "exact_base_binding" | "contains" | "applies_to_task" |
    "applies_in_environment" | "requires_mcp" | "supports_mcp" | "alternative_mcp" |
    "supported_by" | "supersedes" | "contradicts" | "similar_to" | "similar_by_tag";
  projectScopeKey: string;
  environmentKey: string;
  basePackageHash: string;
  payload: Record<string, unknown>;
};

export function rebuildExperienceRelationIndex(): ExperienceRelationIndexStatus {
  const fingerprint = experienceRelationSourceFingerprint();
  const rebuiltAt = new Date().toISOString();
  const packs = getDb().prepare(
    `SELECT id, agent_id, project_path, project_scope_key, environment_key,
            name, description, base_package_hash, mcp_requirements_json, status, updated_at
       FROM experience_packs WHERE status = 'active' ORDER BY id ASC`,
  ).all() as PackRow[];
  const nodes = new Map<string, NodeInsert>();
  const edges = new Map<string, EdgeInsert>();
  const candidateVectors = new Map<string, number[]>();
  const candidateRows = getDb().prepare(
    `SELECT id, summary, embedding_model, embedding_adapter, embedding_model_sha256,
            embedding_content_hash, embedding_dimensions, embedding_json
       FROM experience_candidates ORDER BY id ASC`,
  ).all() as Array<{
    id: string;
    summary: string;
    embedding_model: string | null;
    embedding_adapter: string | null;
    embedding_model_sha256: string | null;
    embedding_content_hash: string | null;
    embedding_dimensions: number | null;
    embedding_json: string | null;
  }>;
  const backfill = getDb().prepare(
    `UPDATE experience_candidates
        SET embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
            embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
      WHERE id = ?`,
  );
  const candidateAdapters = new Map<string, string>();
  for (const row of candidateRows) {
    let embedding = parseLocalEmbedding(row.embedding_model, row.embedding_dimensions, row.embedding_json, {
      adapter: row.embedding_adapter,
      modelSha256: row.embedding_model_sha256,
      contentHash: row.embedding_content_hash,
      text: row.summary,
    });
    if (!embedding) {
      embedding = autoLocalEmbedding(row.summary);
      backfill.run(
        embedding.model,
        embedding.adapter,
        embedding.modelSha256,
        embedding.contentHash,
        embedding.dimensions,
        JSON.stringify(embedding.vector),
        row.id,
      );
    }
    candidateVectors.set(row.id, embedding.vector);
    candidateAdapters.set(row.id, embedding.adapter);
  }

  const addNode = (node: NodeInsert): string => {
    nodes.set(node.nodeId, node);
    return node.nodeId;
  };
  const addEdge = (
    release: ReleaseProjection,
    fromNode: string,
    toNode: string,
    edgeType: EdgeInsert["edgeType"],
    payload: Record<string, unknown> = {},
  ): void => {
    const edgeId = stableId("experience-edge", release.packId, fromNode, toNode, edgeType);
    edges.set(edgeId, {
      edgeId,
      packId: release.packId,
      fromNode,
      toNode,
      edgeType,
      projectScopeKey: release.projectScopeKey,
      environmentKey: release.environmentKey,
      basePackageHash: release.basePackageHash,
      payload,
    });
  };

  for (const pack of packs) {
    if (!pack.base_package_hash || !/^[0-9a-f]{64}$/.test(pack.base_package_hash)) continue;
    const packNode = addNode({
      nodeId: stableId("experience-pack-node", pack.id),
      packId: pack.id,
      nodeType: "Pack",
      entityRef: pack.id,
      projectScopeKey: pack.project_scope_key,
      environmentKey: pack.environment_key,
      basePackageHash: pack.base_package_hash,
      normalizedValue: null,
      payload: { source: "experience_packs", containsBasePackageMaterial: false },
    });
    for (const release of lineageProjections(pack)) {
      const releaseNode = addNode({
        nodeId: stableId("experience-release-node", pack.id, release.releaseId),
        packId: pack.id,
        nodeType: "Release",
        entityRef: release.releaseId,
        projectScopeKey: release.projectScopeKey,
        environmentKey: release.environmentKey,
        basePackageHash: release.basePackageHash,
        normalizedValue: null,
        payload: { releaseKind: "experience", current: release.current },
      });
      const baseNode = addNode({
        nodeId: stableId("experience-base-release-node", pack.id, release.basePackageHash),
        packId: pack.id,
        nodeType: "Release",
        entityRef: `sha256:${release.basePackageHash}`,
        projectScopeKey: release.projectScopeKey,
        environmentKey: release.environmentKey,
        basePackageHash: release.basePackageHash,
        normalizedValue: null,
        payload: { releaseKind: "base", containsBasePackageMaterial: false },
      });
      const environmentNode = addNode({
        nodeId: stableId("experience-environment-node", pack.id, release.environmentKey),
        packId: pack.id,
        nodeType: "Environment",
        entityRef: release.environmentKey,
        projectScopeKey: release.projectScopeKey,
        environmentKey: release.environmentKey,
        basePackageHash: release.basePackageHash,
        normalizedValue: release.environmentKey,
        payload: {},
      });
      addEdge(release, packNode, releaseNode, "has_release");
      addEdge(release, releaseNode, baseNode, "exact_base_binding");
      addEdge(release, releaseNode, environmentNode, "applies_in_environment");

      if (release.supersedesReleaseId) {
        const previousNode = addNode({
          nodeId: stableId("experience-release-node", pack.id, release.supersedesReleaseId),
          packId: pack.id,
          nodeType: "Release",
          entityRef: release.supersedesReleaseId,
          projectScopeKey: release.projectScopeKey,
          environmentKey: release.environmentKey,
          basePackageHash: release.basePackageHash,
          normalizedValue: null,
          payload: { releaseKind: "experience", current: false },
        });
        addEdge(release, releaseNode, previousNode, "supersedes");
      }

      const tagsByItem = new Map(release.localTaskBindings.map((binding) => [binding.itemId, binding.tags]));
      const evidenceByItem = new Map(release.evidenceBindings.map((binding) => [binding.itemId, binding.receiptIds]));
      const itemNodes = new Map<string, string>();
      for (const itemId of release.itemIds) {
        const itemNode = addNode({
          nodeId: stableId("experience-item-node", pack.id, itemId),
          packId: pack.id,
          nodeType: "Item",
          entityRef: itemId,
          projectScopeKey: release.projectScopeKey,
          environmentKey: release.environmentKey,
          basePackageHash: release.basePackageHash,
          normalizedValue: null,
          payload: { rawContentStored: false },
        });
        itemNodes.set(itemId, itemNode);
        addEdge(release, releaseNode, itemNode, "contains");
        addEdge(release, itemNode, environmentNode, "applies_in_environment");
        for (const tag of tagsByItem.get(itemId) ?? []) {
          const tagNode = addNode({
            nodeId: stableId("experience-task-tag-node", pack.id, tag),
            packId: pack.id,
            nodeType: "TaskTag",
            entityRef: tag,
            projectScopeKey: release.projectScopeKey,
            environmentKey: release.environmentKey,
            basePackageHash: release.basePackageHash,
            normalizedValue: tag,
            payload: {},
          });
          addEdge(release, itemNode, tagNode, "applies_to_task");
        }
        for (const receiptId of evidenceByItem.get(itemId) ?? []) {
          const receiptNode = addNode({
            nodeId: stableId("experience-evidence-node", pack.id, receiptId),
            packId: pack.id,
            nodeType: "EvidenceReceipt",
            entityRef: receiptId,
            projectScopeKey: release.projectScopeKey,
            environmentKey: release.environmentKey,
            basePackageHash: release.basePackageHash,
            normalizedValue: null,
            payload: {},
          });
          addEdge(release, itemNode, receiptNode, "supported_by");
        }
      }

      for (const requirement of release.mcpRequirements) {
        const requirementNode = addNode({
          nodeId: stableId("experience-mcp-node", pack.id, requirement.catalogId),
          packId: pack.id,
          nodeType: "MCPRequirement",
          entityRef: requirement.catalogId,
          projectScopeKey: release.projectScopeKey,
          environmentKey: release.environmentKey,
          basePackageHash: release.basePackageHash,
          normalizedValue: requirement.catalogId,
          payload: { required: requirement.required },
        });
        addEdge(release, releaseNode, requirementNode, requirement.required ? "requires_mcp" : "supports_mcp");
        for (const alternative of requirement.alternatives) {
          const alternativeNode = addNode({
            nodeId: stableId("experience-mcp-node", pack.id, alternative),
            packId: pack.id,
            nodeType: "MCPRequirement",
            entityRef: alternative,
            projectScopeKey: release.projectScopeKey,
            environmentKey: release.environmentKey,
            basePackageHash: release.basePackageHash,
            normalizedValue: alternative,
            payload: { alternative: true },
          });
          addEdge(release, requirementNode, alternativeNode, "alternative_mcp");
        }
      }

      const itemIds = [...itemNodes.keys()].sort();
      // Semantic similarity is a derived, non-authoritative edge. Explicit
      // supersedes/contradicts are never inferred from vector proximity.
      // Keep corrupted/imported oversized local sources linear.
      if (!release.current || itemIds.length > MAX_RELATION_ITEMS_PER_PACK) continue;
      for (let index = 0; index < itemIds.length; index += 1) {
        const leftId = itemIds[index];
        const leftVector = candidateVectors.get(leftId);
        if (!leftVector) continue;
        for (const rightId of itemIds.slice(index + 1)) {
          const rightVector = candidateVectors.get(rightId);
          if (!rightVector) continue;
          const similarity = cosineSimilarity(leftVector, rightVector);
          if (similarity < 0.5) continue;
          addEdge(
            release,
            itemNodes.get(leftId)!,
            itemNodes.get(rightId)!,
            "similar_to",
            {
              similarity: Number(similarity.toFixed(6)),
              adapter: candidateAdapters.get(leftId) ?? "local_hashing:degraded",
            },
          );
        }
      }
    }
  }

  // Curator-authored governance is a durable source table. Rebuild projects
  // it after vector derivation without ever guessing these authority edges.
  const governanceRows = getDb().prepare(
    `SELECT relation.relation_id, relation.pack_id, relation.from_candidate_id,
            relation.to_candidate_id, relation.relation_type, relation.reason,
            pack.project_scope_key, pack.environment_key, pack.base_package_hash
       FROM experience_governance_relations relation
       JOIN experience_packs pack ON pack.id = relation.pack_id
      WHERE pack.status = 'active' AND pack.base_package_hash IS NOT NULL
      ORDER BY relation.created_at ASC, relation.relation_id ASC`,
  ).all() as Array<{
    relation_id: string;
    pack_id: string;
    from_candidate_id: string;
    to_candidate_id: string;
    relation_type: "supersedes" | "contradicts";
    reason: string;
    project_scope_key: string;
    environment_key: string;
    base_package_hash: string;
  }>;
  for (const relation of governanceRows) {
    const fromNode = stableId("experience-item-node", relation.pack_id, relation.from_candidate_id);
    const toNode = stableId("experience-item-node", relation.pack_id, relation.to_candidate_id);
    if (!nodes.has(fromNode) || !nodes.has(toNode)) continue;
    const edgeId = stableId(
      "experience-governance-edge",
      relation.pack_id,
      relation.from_candidate_id,
      relation.to_candidate_id,
      relation.relation_type,
    );
    edges.set(edgeId, {
      edgeId,
      packId: relation.pack_id,
      fromNode,
      toNode,
      edgeType: relation.relation_type,
      projectScopeKey: relation.project_scope_key,
      environmentKey: relation.environment_key,
      basePackageHash: relation.base_package_hash,
      payload: {
        assertionId: relation.relation_id,
        reasonHash: hashRef("experience-governance-reason-v1", relation.reason),
        inferred: false,
      },
    });
  }

  const transaction = getDb().transaction(() => {
    getDb().prepare("DELETE FROM experience_relation_edges").run();
    getDb().prepare("DELETE FROM experience_relation_nodes").run();
    const insertNode = getDb().prepare(
      `INSERT INTO experience_relation_nodes (
         node_id, pack_id, node_type, entity_ref, project_scope_key, environment_key,
         base_package_hash, normalized_value, payload_json, source_fingerprint, rebuilt_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const node of nodes.values()) {
      insertNode.run(
        node.nodeId, node.packId, node.nodeType, node.entityRef, node.projectScopeKey,
        node.environmentKey, node.basePackageHash, node.normalizedValue,
        JSON.stringify(node.payload), fingerprint, rebuiltAt,
      );
    }
    const insertEdge = getDb().prepare(
      `INSERT INTO experience_relation_edges (
         edge_id, pack_id, from_node, to_node, edge_type, project_scope_key,
         environment_key, base_package_hash, payload_json, source_fingerprint, rebuilt_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const edge of edges.values()) {
      insertEdge.run(
        edge.edgeId, edge.packId, edge.fromNode, edge.toNode, edge.edgeType,
        edge.projectScopeKey, edge.environmentKey, edge.basePackageHash,
        JSON.stringify(edge.payload), fingerprint, rebuiltAt,
      );
    }
    getDb().prepare(
      `INSERT INTO experience_relation_index_state (
         scope_key, source_fingerprint, rebuilt_at, node_count, edge_count
       ) VALUES ('shared', ?, ?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         source_fingerprint = excluded.source_fingerprint,
         rebuilt_at = excluded.rebuilt_at,
         node_count = excluded.node_count,
         edge_count = excluded.edge_count`,
    ).run(fingerprint, rebuiltAt, nodes.size, edges.size);
  });
  transaction();
  return {
    stale: false,
    sourceFingerprint: fingerprint,
    indexedFingerprint: fingerprint,
    rebuiltAt,
    nodeCount: nodes.size,
    edgeCount: edges.size,
  };
}

export function getExperienceRelationIndexStatus(): ExperienceRelationIndexStatus {
  const sourceFingerprint = experienceRelationSourceFingerprint();
  const state = getDb().prepare(
    `SELECT source_fingerprint, rebuilt_at, node_count, edge_count
       FROM experience_relation_index_state WHERE scope_key = 'shared'`,
  ).get() as {
    source_fingerprint: string;
    rebuilt_at: string;
    node_count: number;
    edge_count: number;
  } | undefined;
  return {
    stale: !state || state.source_fingerprint !== sourceFingerprint,
    sourceFingerprint,
    indexedFingerprint: state?.source_fingerprint ?? null,
    rebuiltAt: state?.rebuilt_at ?? null,
    nodeCount: state?.node_count ?? 0,
    edgeCount: state?.edge_count ?? 0,
  };
}

export function ensureExperienceRelationIndex(): ExperienceRelationIndexStatus {
  const status = getExperienceRelationIndexStatus();
  return status.stale ? rebuildExperienceRelationIndex() : status;
}

type RelationGraphNodeRow = {
  node_id: string;
  pack_id: string;
  node_type: NodeInsert["nodeType"];
  entity_ref: string;
  payload_json: string;
};

type RelationGraphEdgeRow = {
  edge_id: string;
  from_node: string;
  to_node: string;
  edge_type: EdgeInsert["edgeType"];
};

type PrivateCandidateGraphRow = {
  id: string;
  pack_id: string;
  task_terms_json: string;
};

type TasteDraftGraphRow = {
  id: string;
  axis_candidates_json: string;
  task_signatures_json: string;
};

const GRAPH_NODE_KIND_ORDER: Record<ExperienceOntologyGraphNodeKind, number> = {
  agent: 0,
  pack: 1,
  release: 2,
  "experience-item": 3,
  "taste-draft": 4,
  task: 5,
  "taste-axis": 6,
  environment: 7,
  mcp: 8,
  evidence: 9,
};

const GRAPH_NODE_SOURCE_ORDER: Record<ExperienceOntologyGraphNode["source"], number> = {
  synthetic: 0,
  "relation-index": 1,
  "private-candidate": 2,
  "taste-draft": 3,
};

const GRAPH_EDGE_STATUS_ORDER: Record<ExperienceOntologyGraphEdge["status"], number> = {
  active: 0,
  historical: 1,
  pending: 2,
};

function graphNodeKind(nodeType: NodeInsert["nodeType"]): ExperienceOntologyGraphNodeKind {
  switch (nodeType) {
    case "Pack": return "pack";
    case "Release": return "release";
    case "Item": return "experience-item";
    case "TaskTag": return "task";
    case "Environment": return "environment";
    case "MCPRequirement": return "mcp";
    case "EvidenceReceipt": return "evidence";
  }
}

function releaseProjectionFlags(payloadJson: string): { current: boolean | null; kind: "base" | "experience" | null } {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { current: null, kind: null };
    const value = parsed as Record<string, unknown>;
    return {
      current: typeof value.current === "boolean" ? value.current : null,
      kind: value.releaseKind === "base" || value.releaseKind === "experience" ? value.releaseKind : null,
    };
  } catch {
    return { current: null, kind: null };
  }
}

function relationGraphNode(row: RelationGraphNodeRow): ExperienceOntologyGraphNode | null {
  const id = valueFreeGraphId(row.node_id);
  const packId = valueFreeGraphId(row.pack_id);
  if (!id || !packId) return null;
  const kind = graphNodeKind(row.node_type);
  const release = row.node_type === "Release"
    ? releaseProjectionFlags(row.payload_json)
    : { current: null, kind: null };
  const ref = row.node_type === "TaskTag"
    ? (isCanonicalTaskId(row.entity_ref) ? row.entity_ref : null)
    : valueFreeGraphId(row.entity_ref);
  const safeLabel = row.node_type === "Pack"
    ? "Experience pack"
    : row.node_type === "Release"
      ? (release.kind === "base" ? "Base release" : "Experience release")
      : row.node_type === "Item"
        ? "Promoted experience"
        : row.node_type === "TaskTag"
          ? "Task"
          : row.node_type === "Environment"
            ? "Environment"
            : row.node_type === "MCPRequirement"
              ? "MCP requirement"
              : "Evidence receipt";
  const status: ExperienceOntologyGraphNode["status"] = row.node_type === "Item"
    ? "promoted"
    : row.node_type === "Release" && release.current === false
      ? "historical"
      : "active";
  return {
    id,
    kind,
    packId,
    ...(ref ? { ref } : {}),
    safeLabel,
    status,
    source: "relation-index",
  };
}

function graphRefIsSafe(node: ExperienceOntologyGraphNode): boolean {
  if (!node.ref) return true;
  if (node.kind === "task") return isCanonicalTaskId(node.ref);
  if (node.kind === "taste-axis") return TASTE_AXIS_IDS.has(node.ref);
  return valueFreeGraphId(node.ref) === node.ref;
}

/**
 * Builds a bounded renderer snapshot from the disposable relation index plus
 * local review queues. Source-authored summaries/statements and host metadata
 * are intentionally not selected by any query in this function.
 */
export function getExperienceOntologyGraphSnapshot(agentIdValue: string): ExperienceOntologyGraphSnapshot {
  const agentId = requiredValueFreeGraphId(agentIdValue, "Ontology graph agentId");
  ensureExperienceRelationIndex();

  const nodeById = new Map<string, ExperienceOntologyGraphNode>();
  const edgeById = new Map<string, ExperienceOntologyGraphEdge>();
  const addNode = (node: ExperienceOntologyGraphNode): boolean => {
    const id = valueFreeGraphId(node.id);
    const packId = node.packId ? valueFreeGraphId(node.packId) : null;
    if (!id || (node.packId && !packId) || !graphRefIsSafe(node)) return false;
    if (nodeById.has(id)) return true;
    nodeById.set(id, {
      ...node,
      id,
      ...(packId ? { packId } : {}),
    });
    return true;
  };
  const addEdge = (edge: ExperienceOntologyGraphEdge): boolean => {
    const id = valueFreeGraphId(edge.id);
    const from = valueFreeGraphId(edge.from);
    const to = valueFreeGraphId(edge.to);
    if (!id || !from || !to) return false;
    edgeById.set(id, { ...edge, id, from, to });
    return true;
  };

  const agentNodeId = stableId("experience-agent-node", agentId);
  addNode({
    id: agentNodeId,
    kind: "agent",
    ref: agentId,
    safeLabel: "Agent",
    status: "active",
    source: "synthetic",
  });

  const relationNodes = getDb().prepare(
    `SELECT node.node_id, node.pack_id, node.node_type, node.entity_ref, node.payload_json
       FROM experience_relation_nodes node
       JOIN experience_packs pack ON pack.id = node.pack_id
      WHERE pack.agent_id = ? AND pack.status = 'active'
      ORDER BY node.node_type ASC, node.pack_id ASC, node.node_id ASC`,
  ).all(agentId) as RelationGraphNodeRow[];
  const packNodeByPackId = new Map<string, string>();
  for (const row of relationNodes) {
    const node = relationGraphNode(row);
    if (!node || !addNode(node)) continue;
    if (node.kind === "pack" && node.packId) packNodeByPackId.set(node.packId, node.id);
  }

  const relationEdges = getDb().prepare(
    `SELECT edge.edge_id, edge.from_node, edge.to_node, edge.edge_type
       FROM experience_relation_edges edge
       JOIN experience_packs pack ON pack.id = edge.pack_id
      WHERE pack.agent_id = ? AND pack.status = 'active'
      ORDER BY edge.edge_type ASC, edge.edge_id ASC`,
  ).all(agentId) as RelationGraphEdgeRow[];
  for (const row of relationEdges) {
    addEdge({
      id: row.edge_id,
      from: row.from_node,
      to: row.to_node,
      kind: row.edge_type,
      status: row.edge_type === "supersedes" ? "historical" : "active",
    });
  }

  const privateCandidates = getDb().prepare(
    `SELECT candidate.id, candidate.pack_id, candidate.task_terms_json
       FROM experience_candidates candidate
       JOIN experience_packs pack ON pack.id = candidate.pack_id AND pack.agent_id = candidate.agent_id
      WHERE candidate.agent_id = ? AND candidate.status = 'candidate'
        AND candidate.public_safe = 0 AND pack.status = 'active'
      ORDER BY candidate.pack_id ASC, candidate.id ASC`,
  ).all(agentId) as PrivateCandidateGraphRow[];
  for (const row of privateCandidates) {
    const packId = valueFreeGraphId(row.pack_id);
    const candidateRef = valueFreeGraphId(row.id);
    if (!packId || !candidateRef) continue;
    let packNodeId = packNodeByPackId.get(packId);
    if (!packNodeId) {
      packNodeId = stableId("experience-pack-node", packId);
      if (!addNode({
        id: packNodeId,
        kind: "pack",
        packId,
        ref: packId,
        safeLabel: "Experience pack",
        status: "active",
        source: "private-candidate",
      })) continue;
      packNodeByPackId.set(packId, packNodeId);
    }
    const candidateNodeId = stableId("experience-item-node", packId, candidateRef);
    if (!addNode({
      id: candidateNodeId,
      kind: "experience-item",
      packId,
      ref: candidateRef,
      safeLabel: "Private candidate",
      status: "candidate",
      source: "private-candidate",
    })) continue;
    addEdge({
      id: stableId("experience-edge", packId, packNodeId, candidateNodeId, "contains_candidate"),
      from: packNodeId,
      to: candidateNodeId,
      kind: "contains_candidate",
      status: "pending",
    });
    for (const taskId of safeTaskTags(row.task_terms_json)) {
      const taskNodeId = stableId("experience-task-tag-node", packId, taskId);
      addNode({
        id: taskNodeId,
        kind: "task",
        packId,
        ref: taskId,
        safeLabel: "Task",
        status: "active",
        source: "private-candidate",
      });
      addEdge({
        id: stableId("experience-edge", packId, candidateNodeId, taskNodeId, "applies_to_task"),
        from: candidateNodeId,
        to: taskNodeId,
        kind: "applies_to_task",
        status: "pending",
      });
    }
  }

  for (const [packId, packNodeId] of [...packNodeByPackId.entries()].sort(([left], [right]) => compareAscii(left, right))) {
    addEdge({
      id: stableId("experience-edge", agentId, agentNodeId, packNodeId, "agent_has_pack"),
      from: agentNodeId,
      to: packNodeId,
      kind: "agent_has_pack",
      status: "active",
    });
  }

  const tasteDrafts = getDb().prepare(
    `SELECT draft.id, draft.axis_candidates_json, draft.task_signatures_json
       FROM taste_draft_candidates draft
       JOIN memory_entries memory
         ON memory.id = draft.source_memory_id AND memory.agent_id = draft.agent_id
      WHERE draft.agent_id = ? AND draft.status = 'observation'
        AND memory.superseded_at IS NULL
      ORDER BY draft.id ASC`,
  ).all(agentId) as TasteDraftGraphRow[];
  for (const row of tasteDrafts) {
    const draftRef = valueFreeGraphId(row.id);
    if (!draftRef) continue;
    const draftNodeId = stableId("experience-taste-draft-node", agentId, draftRef);
    if (!addNode({
      id: draftNodeId,
      kind: "taste-draft",
      ref: draftRef,
      safeLabel: "Taste draft",
      status: "pending-evidence",
      source: "taste-draft",
    })) continue;
    addEdge({
      id: stableId("experience-edge", agentId, agentNodeId, draftNodeId, "agent_has_taste_draft"),
      from: agentNodeId,
      to: draftNodeId,
      kind: "agent_has_taste_draft",
      status: "pending",
    });
    const axes = parseJsonArray<unknown>(row.axis_candidates_json)
      .filter((axis): axis is string => typeof axis === "string" && TASTE_AXIS_IDS.has(axis));
    for (const axis of [...new Set(axes)].sort(compareAscii)) {
      const axisNodeId = stableId("experience-taste-axis-node", agentId, axis);
      addNode({
        id: axisNodeId,
        kind: "taste-axis",
        ref: axis,
        safeLabel: "Taste axis",
        status: "active",
        source: "taste-draft",
      });
      addEdge({
        id: stableId("experience-edge", agentId, draftNodeId, axisNodeId, "classified_as_taste_axis"),
        from: draftNodeId,
        to: axisNodeId,
        kind: "classified_as_taste_axis",
        status: "pending",
      });
    }
    for (const taskId of safeTaskTags(row.task_signatures_json)) {
      const taskNodeId = stableId("experience-agent-task-node", agentId, taskId);
      addNode({
        id: taskNodeId,
        kind: "task",
        ref: taskId,
        safeLabel: "Task",
        status: "active",
        source: "taste-draft",
      });
      addEdge({
        id: stableId("experience-edge", agentId, draftNodeId, taskNodeId, "applies_to_task"),
        from: draftNodeId,
        to: taskNodeId,
        kind: "applies_to_task",
        status: "pending",
      });
    }
  }

  const allNodes = [...nodeById.values()].sort((left, right) =>
    GRAPH_NODE_SOURCE_ORDER[left.source] - GRAPH_NODE_SOURCE_ORDER[right.source]
      || GRAPH_NODE_KIND_ORDER[left.kind] - GRAPH_NODE_KIND_ORDER[right.kind]
      || compareAscii(left.packId ?? "", right.packId ?? "")
      || compareAscii(left.id, right.id));
  const completeEdges = [...edgeById.values()]
    .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to))
    .sort((left, right) => GRAPH_EDGE_STATUS_ORDER[left.status] - GRAPH_EDGE_STATUS_ORDER[right.status]
      || compareAscii(left.kind, right.kind)
      || compareAscii(left.id, right.id));
  const nodes = allNodes.slice(0, ONTOLOGY_GRAPH_NODE_LIMIT);
  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  const edges = completeEdges
    .filter((edge) => selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to))
    .slice(0, ONTOLOGY_GRAPH_EDGE_LIMIT);
  const omittedNodeCount = allNodes.length - nodes.length;
  const omittedEdgeCount = completeEdges.length - edges.length;

  return {
    schema: "agentlas.ontology-relation-graph.v1",
    agentId,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    totalNodeCount: allNodes.length,
    totalEdgeCount: completeEdges.length,
    omittedNodeCount,
    omittedEdgeCount,
    truncated: omittedNodeCount > 0 || omittedEdgeCount > 0,
    limits: {
      nodes: ONTOLOGY_GRAPH_NODE_LIMIT,
      edges: ONTOLOGY_GRAPH_EDGE_LIMIT,
    },
  };
}

export function refreshExperienceRelationArtifacts(packId: string): ExperienceRelationIndexStatus {
  writeExperienceLineageLedger(packId);
  return rebuildExperienceRelationIndex();
}

export function recordExperienceGovernanceRelation(input: {
  fromCandidateId: string;
  toCandidateId: string;
  relationType: "supersedes" | "contradicts";
  reason: string;
}): string {
  const fromCandidateId = requiredValueFreeGraphId(input.fromCandidateId, "fromCandidateId");
  const toCandidateId = requiredValueFreeGraphId(input.toCandidateId, "toCandidateId");
  if (fromCandidateId === toCandidateId) throw new Error("Experience governance cannot self-link.");
  if (input.relationType !== "supersedes" && input.relationType !== "contradicts") {
    throw new Error("Experience governance requires an explicit supersedes or contradicts relation.");
  }
  const reason = String(input.reason ?? "").normalize("NFKC").trim();
  if (!reason || reason.length > 240) throw new Error("Experience governance requires a concise reason.");
  const rows = getDb().prepare(
    `SELECT id, pack_id, agent_id, status FROM experience_candidates WHERE id IN (?, ?)`,
  ).all(fromCandidateId, toCandidateId) as Array<{
    id: string;
    pack_id: string;
    agent_id: string;
    status: string;
  }>;
  if (rows.length !== 2 || rows.some((row) => row.status !== "promoted")) {
    throw new Error("Experience governance requires two promoted reviewed candidates.");
  }
  if (rows[0].pack_id !== rows[1].pack_id || rows[0].agent_id !== rows[1].agent_id) {
    throw new Error("Experience governance cannot cross pack or agent boundaries.");
  }
  const relationId = stableId(
    "experience-governance-relation",
    rows[0].pack_id,
    fromCandidateId,
    toCandidateId,
    input.relationType,
  );
  getDb().prepare(
    `INSERT INTO experience_governance_relations (
       relation_id, agent_id, pack_id, from_candidate_id, to_candidate_id,
       relation_type, reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_candidate_id, to_candidate_id, relation_type)
     DO UPDATE SET reason = excluded.reason`,
  ).run(
    relationId,
    rows[0].agent_id,
    rows[0].pack_id,
    fromCandidateId,
    toCandidateId,
    input.relationType,
    reason,
    new Date().toISOString(),
  );
  refreshExperienceRelationArtifacts(rows[0].pack_id);
  return relationId;
}

export function rankExperienceCandidatesByRelations(input: {
  projectScopeKey: string;
  environmentKey: string;
  basePackageHash: string;
  taskTerms: string[];
}): Map<string, number> {
  ensureExperienceRelationIndex();
  const queryTags = new Set(
    input.taskTerms
      .map((term) => term.normalize("NFKC").trim().toLowerCase())
      .filter(isCanonicalTaskId),
  );
  if (queryTags.size === 0) return new Map();
  const rows = getDb().prepare(
    `SELECT item.node_id AS item_node, item.entity_ref AS candidate_id,
            tag.normalized_value AS tag
       FROM experience_relation_edges edge
       JOIN experience_relation_nodes item ON item.node_id = edge.from_node AND item.node_type = 'Item'
       JOIN experience_relation_nodes tag ON tag.node_id = edge.to_node AND tag.node_type = 'TaskTag'
       JOIN experience_packs pack ON pack.id = edge.pack_id AND pack.status = 'active'
       JOIN experience_candidates candidate
         ON candidate.id = item.entity_ref AND candidate.pack_id = edge.pack_id
        AND candidate.status = 'promoted' AND candidate.outcome_status IN ('attested','verified')
      WHERE edge.edge_type = 'applies_to_task'
        AND edge.project_scope_key = ? AND edge.environment_key = ?
        AND edge.base_package_hash = ?`,
  ).all(input.projectScopeKey, input.environmentKey, input.basePackageHash) as Array<{
    item_node: string;
    candidate_id: string;
    tag: string;
  }>;
  const directByNode = new Map<string, number>();
  const candidateByNode = new Map<string, string>();
  for (const row of rows) {
    candidateByNode.set(row.item_node, row.candidate_id);
    if (queryTags.has(row.tag)) directByNode.set(row.item_node, (directByNode.get(row.item_node) ?? 0) + 10);
  }
  const scoreByCandidate = new Map<string, number>();
  for (const [node, score] of directByNode) {
    if (score > 0) scoreByCandidate.set(candidateByNode.get(node)!, score);
  }
  const similar = getDb().prepare(
    `SELECT from_node, to_node FROM experience_relation_edges
      WHERE edge_type IN ('similar_to', 'similar_by_tag') AND project_scope_key = ?
        AND environment_key = ? AND base_package_hash = ?`,
  ).all(input.projectScopeKey, input.environmentKey, input.basePackageHash) as Array<{
    from_node: string;
    to_node: string;
  }>;
  for (const edge of similar) {
    const leftScore = directByNode.get(edge.from_node) ?? 0;
    const rightScore = directByNode.get(edge.to_node) ?? 0;
    if (leftScore > 0 && rightScore === 0 && candidateByNode.has(edge.to_node)) {
      const candidate = candidateByNode.get(edge.to_node)!;
      scoreByCandidate.set(candidate, Math.max(scoreByCandidate.get(candidate) ?? 0, 8));
    }
    if (rightScore > 0 && leftScore === 0 && candidateByNode.has(edge.from_node)) {
      const candidate = candidateByNode.get(edge.from_node)!;
      scoreByCandidate.set(candidate, Math.max(scoreByCandidate.get(candidate) ?? 0, 8));
    }
  }
  return scoreByCandidate;
}
