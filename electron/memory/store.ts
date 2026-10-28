// Durable memory store (memory_entries table). The Memory Curator owns writes here.
import { createHash, randomUUID } from "node:crypto";
import { allowsOrdinaryMemoryRecall, type MemoryRecallScope, type MemoryRecallPolicyRow } from "./recall-policy";
import { memoryActorIds, sameMemoryActor } from "../../shared/memory-actor-family";
import { getMemoryDb as getDb, getMemoryStoreInfo } from "./database";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import {
  autoLocalEmbedding,
  parseLocalEmbedding,
  type LocalMemoryEmbedding,
} from "./local-embedding";
import { assertMemoryWriteAllowed } from "./revocations";
import { enqueueEnglishTranslation, ensureNativeTextTables, nativeTextsFor } from "./native-text";

export interface RequestContext {
  userIntent?: string;
  triggerTerms?: string[];
  cwdAtRequest?: string | null;
  targetProject?: string | null;
  targetPath?: string | null;
  crossContext?: boolean;
  outcome?: string | null;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  projectId: string | null;
  projectPath: string | null;
  agentId: string | null;
  chatId: string | null;
  confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  evidence: string[];
  requestContext: RequestContext | null;
  embedding: LocalMemoryEmbedding;
  supersededAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  scope: string;
  kind: string;
  content: string;
  project_id: string | null;
  project_path: string | null;
  agent_id: string | null;
  chat_id: string | null;
  confidence: string;
  sensitivity: string;
  evidence_json: string;
  context_json?: string;
  embedding_model?: string | null;
  embedding_adapter?: string | null;
  embedding_model_sha256?: string | null;
  embedding_content_hash?: string | null;
  embedding_dimensions?: number | null;
  embedding_json?: string | null;
  superseded_at: string | null;
  created_at: string;
}

const MEMORY_CREATED_AT_CLOCK_KEY = "memory-created-at-clock-v1";
const ordinaryRecall = (alias: "memory_entries" | "m" | "n") => `NOT EXISTS(
  SELECT 1 FROM memory_identity_bindings visibility WHERE visibility.memory_id=${alias}.id
    AND (json_extract(visibility.applicability_json,'$.recallChannel')='legacy_one_overlay'
      OR json_extract(visibility.applicability_json,'$.enabled')=0))`;

function nextMemoryCreatedAt(db: ReturnType<typeof getDb>): string {
  const clock = db.prepare("SELECT value FROM meta WHERE key = ?").get(MEMORY_CREATED_AT_CLOCK_KEY) as {
    value?: string;
  } | undefined;
  const latest = clock?.value ?? (db.prepare("SELECT MAX(created_at) AS createdAt FROM memory_entries").get() as {
    createdAt?: string | null;
  }).createdAt ?? "";
  const parsed = Date.parse(latest);
  const createdAt = new Date(Math.max(Date.now(), Number.isFinite(parsed) ? parsed + 1 : 0)).toISOString();
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(MEMORY_CREATED_AT_CLOCK_KEY, createdAt);
  return createdAt;
}

function parseRequestContext(json?: string | null): RequestContext | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as RequestContext & Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;
    return {
      userIntent: raw.userIntent ?? (raw.user_intent as string | undefined),
      triggerTerms:
        raw.triggerTerms ?? (Array.isArray(raw.trigger_terms) ? (raw.trigger_terms as string[]) : undefined),
      cwdAtRequest: raw.cwdAtRequest ?? (raw.cwd_at_request as string | null | undefined),
      targetProject: raw.targetProject ?? (raw.target_project as string | null | undefined),
      targetPath: raw.targetPath ?? (raw.target_path as string | null | undefined),
      crossContext: raw.crossContext ?? (raw.cross_context as boolean | undefined),
      outcome: raw.outcome as string | null | undefined,
    };
  } catch {
    return null;
  }
}

function toEntry(r: Row): MemoryEntry {
  let evidence: string[] = [];
  try {
    evidence = JSON.parse(r.evidence_json) as string[];
  } catch {
    evidence = [];
  }
  let embedding = parseLocalEmbedding(r.embedding_model, r.embedding_dimensions, r.embedding_json, {
    adapter: r.embedding_adapter,
    modelSha256: r.embedding_model_sha256,
    contentHash: r.embedding_content_hash,
    text: r.content,
  });
  if (!embedding) {
    embedding = autoLocalEmbedding(r.content);
    // Backward-compatible lazy backfill: old stores open without an O(n)
    // migration pause, then each governed row is upgraded as it is read.
    try {
      getDb().prepare(
        `UPDATE memory_entries
            SET embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
                embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE id = ?`,
      ).run(
        embedding.model,
        embedding.adapter,
        embedding.modelSha256,
        embedding.contentHash,
        embedding.dimensions,
        JSON.stringify(embedding.vector),
        r.id,
      );
    } catch {
      // A read must remain available under a concurrent/legacy SQLite peer.
    }
  }
  return {
    id: r.id,
    scope: r.scope as MemoryScope,
    kind: r.kind as MemoryKind,
    content: r.content,
    projectId: r.project_id,
    projectPath: r.project_path,
    agentId: r.agent_id,
    chatId: r.chat_id,
    confidence: r.confidence as MemoryEntry["confidence"],
    sensitivity: r.sensitivity as MemoryEntry["sensitivity"],
    evidence,
    requestContext: parseRequestContext(r.context_json),
    embedding,
    supersededAt: r.superseded_at,
    createdAt: r.created_at,
  };
}

/**
 * Original-language wording of an English memory (plan 2026-09-22 §9-8).
 * `content` is the English search surface; this side table keeps the authority
 * text. A side table, not a column: the schema ladder is versioned and shared
 * with concurrent work, and an additive table needs no version step. Forgetting
 * a memory must forget this too — see revocations.ts redactMemory.
 */
export function ensureMemoryNativeTable(db = getDb()): void {
  // Same DDL plus the forget triggers and the other side tables (native-text.ts).
  ensureNativeTextTables(db);
}

export function getMemoryNative(entryId: string): string | null {
  try {
    const row = getDb().prepare("SELECT content_native FROM memory_entry_native WHERE entry_id = ?")
      .get(entryId) as { content_native: string } | undefined;
    return row?.content_native ?? null;
  } catch {
    return null; // table absent on stores that never received an English memory
  }
}

/** Called wherever a memory's content is redacted or forgotten. */
export function forgetMemoryNative(entryId: string, db = getDb()): void {
  try {
    db.prepare("DELETE FROM memory_entry_native WHERE entry_id = ?").run(entryId);
  } catch {
    // no table → nothing to forget
  }
}

export interface NewMemoryEntry {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  projectId?: string | null;
  projectPath?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  confidence?: MemoryEntry["confidence"];
  sensitivity?: MemoryEntry["sensitivity"];
  evidence?: string[];
  requestContext?: RequestContext | null;
  /** Canonical Main run identity captured before provider execution. */
  intakeRunId?: string | null;
  /** Trusted in-process epoch captured before a background model call. */
  intakeEpoch?: number | null;
  /** Original-language wording when `content` is the English rendering. */
  contentNative?: string;
  /** Trusted local origin binding, separate from model-proposed evidence. */
  originRefs?: Array<{ kind: "ticket" | "run" | "source" | "project"; id: string; revision?: string }>;
  curationActor?: "model_curated" | "host_admitted" | "legacy";
  policyVersion?: string;
  /** A compatibility channel preserves an existing One-only audience. */
  recallChannel?: "default" | "legacy_one_overlay";
  compatibilityScope?: { scope: "personal" | "project" | "agent" | "team"; scopeRef: string | null };
  enabled?: boolean;
}

export function insertMemoryEntry(e: NewMemoryEntry): MemoryEntry {
  const id = randomUUID();
  let now = "";
  const embedding = autoLocalEmbedding(e.content);
  const insert = getDb().transaction(() => {
    const authority = {
      scope: e.scope,
      kind: e.kind,
      content: e.content,
      projectId: e.projectId,
      projectPath: e.projectPath,
      agentId: e.agentId,
      chatId: e.chatId,
      intakeRunId: e.intakeRunId,
      intakeEpoch: e.intakeEpoch,
    };
    assertMemoryWriteAllowed(authority);
    const native = e.contentNative?.trim().slice(0, 4_000);
    if (native && native !== e.content.trim()) {
      // Forget tombstones both wordings. A new English rendering must not
      // restore the same revoked original under this owner/run authority.
      assertMemoryWriteAllowed({ ...authority, content: native });
    }
    // Startup reconciliation uses this timestamp plus id as its durable logical
    // cursor. Advance it inside the write transaction so other Desktop/headless
    // writers cannot insert behind that cursor in the same millisecond.
    now = nextMemoryCreatedAt(getDb());
    getDb().prepare(
      `INSERT INTO memory_entries
       (id, scope, kind, content, project_id, project_path, agent_id, chat_id,
        confidence, sensitivity, evidence_json, context_json,
        embedding_model, embedding_adapter, embedding_model_sha256, embedding_content_hash,
        embedding_dimensions, embedding_json,
        superseded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      e.scope,
      e.kind,
      e.content,
      e.projectId ?? null,
      e.projectPath ?? null,
      e.agentId ?? null,
      e.chatId ?? null,
      e.confidence ?? "medium",
      e.sensitivity ?? "internal",
      JSON.stringify(e.evidence ?? []),
      JSON.stringify(e.requestContext ?? {}),
      embedding.model,
      embedding.adapter,
      embedding.modelSha256,
      embedding.contentHash,
      embedding.dimensions,
      JSON.stringify(embedding.vector),
      now,
    );
    bindMemoryIdentity(id, e, now);
    if (native && native !== e.content.trim()) {
      ensureMemoryNativeTable();
      getDb().prepare(
        "INSERT OR REPLACE INTO memory_entry_native (entry_id, content_native, created_at) VALUES (?, ?, ?)",
      ).run(id, native, now);
    }
  });
  insert.immediate();
  // English migration, write path (plan 2026-09-23 D-7): a non-English memory
  // without its original-wording twin (the model ignored the English envelope,
  // or a host writer stored user text) is queued for idle translation. SQL only
  // — the turn is never blocked on a model.
  if (!e.contentNative?.trim()) enqueueEnglishTranslation("memory_entry", id, e.content);
  const entry: MemoryEntry = {
    id,
    scope: e.scope,
    kind: e.kind,
    content: e.content,
    projectId: e.projectId ?? null,
    projectPath: e.projectPath ?? null,
    agentId: e.agentId ?? null,
    chatId: e.chatId ?? null,
    confidence: e.confidence ?? "medium",
    sensitivity: e.sensitivity ?? "internal",
    evidence: e.evidence ?? [],
    requestContext: e.requestContext ?? null,
    embedding,
    supersededAt: null,
    createdAt: now,
  };
  // Densify the memory relation graph on EVERY insert path (curated turns,
  // imports, terminal, mobile) — not only the curator write path — so
  // `similar_to` edges accrue as memory grows. The graph is a rebuildable
  // projection: an edge failure must never undo the admitted memory. Lazy
  // require avoids a store↔graph module cycle at load time.
  try {
    const { linkMemoryEntryBySimilarity } = require("./graph") as typeof import("./graph");
    linkMemoryEntryBySimilarity(entry);
  } catch (error) {
    console.warn(`[memory] relation projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return entry;
}

/** The scope remains the reader's authority; graph origin never widens it. */
function bindMemoryIdentity(id: string, entry: NewMemoryEntry, now: string): void {
  const db = getDb();
  const store = getMemoryStoreInfo();
  const refs = (entry.originRefs ?? []).filter(ref => ref.id.trim() && ref.id.length <= 512).slice(0, 32);
  const applicability = { scope: entry.scope, projectIds: entry.projectId ? [entry.projectId] : [],
    projectPathHash: entry.projectPath ? createHash("sha256").update(entry.projectPath).digest("hex") : null,
    actorId: entry.agentId ?? null, chatId: entry.chatId ?? null,
    recallChannel: entry.recallChannel ?? "default", enabled: entry.enabled !== false,
    ...(entry.compatibilityScope ? { compatibilityScope: entry.compatibilityScope } : {}) };
  db.prepare(`INSERT INTO memory_identity_bindings(memory_id,owner_namespace,actor_id,origin_refs_json,applicability_json,curation_actor,policy_version)
    VALUES(?,?,?,?,?,?,?)`).run(id, store.ownerNamespace, entry.agentId ?? null, JSON.stringify(refs), JSON.stringify(applicability),
      entry.curationActor ?? "host_admitted", entry.policyVersion ?? "agentlas.memory-admission.v1");
  for (const ref of refs) db.prepare(`INSERT OR IGNORE INTO memory_origin_links(memory_id,source_kind,source_id,source_revision,relation)
    VALUES(?,?,?,?,'origin')`).run(id, ref.kind, ref.id, ref.revision ?? "");
  if (entry.projectId) {
    const origin = refs.find(ref => ref.kind === "ticket")?.id ?? refs[0]?.id ?? "";
    db.prepare("INSERT OR IGNORE INTO memory_project_links(memory_id,project_id,relation,source_ref) VALUES(?,?,'origin',?)").run(id, entry.projectId, origin);
    if (entry.scope === "project" || (entry.scope === "agent_repo" && entry.projectPath)) {
      db.prepare("INSERT OR IGNORE INTO memory_project_links(memory_id,project_id,relation,source_ref) VALUES(?,?,'applies_to','')").run(id, entry.projectId);
    }
  }
  db.prepare(`INSERT OR IGNORE INTO memory_projection_outbox(outbox_id,memory_id,authority_revision,state,payload_json,created_at,updated_at)
    VALUES(?,?,?,'queued','{}',?,?)`).run(`memory:${id}:${store.revision}`, id, store.revision, now, now);
}

/** Append trusted source provenance to an exact governed duplicate without
 * widening its applicability or changing the original memory actor. */
export function appendMemoryOrigins(id: string, origins: NonNullable<NewMemoryEntry["originRefs"]>, projectId?: string | null): void {
  const db = getDb();
  db.transaction(() => {
    const store = getMemoryStoreInfo();
    const current = db.prepare(`SELECT b.origin_refs_json,b.owner_namespace,m.agent_id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.chat_id FROM memory_entries m
      LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE m.id=? AND m.superseded_at IS NULL
      AND m.content<>'' AND COALESCE(json_extract(b.applicability_json,'$.enabled'),1)<>0`).get(id) as (Pick<Row, "agent_id" | "scope" | "kind" | "content" | "project_id" | "project_path" | "chat_id"> & { origin_refs_json: string | null; owner_namespace: string | null }) | undefined;
    if (!current || (current.owner_namespace && current.owner_namespace !== store.ownerNamespace)) throw new Error("memory_origin_target_unavailable");
    let previous: NonNullable<NewMemoryEntry["originRefs"]> = [];
    try { previous = JSON.parse(current.origin_refs_json ?? "[]") as typeof previous; } catch { /* Existing source links stay available separately. */ }
    if (!Array.isArray(previous)) previous = [];
    const refs = origins.filter(ref => ["ticket", "run", "source", "project"].includes(ref.kind)
      && typeof ref.id === "string" && ref.id.trim() && ref.id.length <= 512).slice(0, 32);
    const insert = db.prepare("INSERT OR IGNORE INTO memory_origin_links(memory_id,source_kind,source_id,source_revision,relation) VALUES(?,?,?,?,'origin')");
    let changed = false;
    for (const ref of refs) changed = insert.run(id, ref.kind, ref.id, ref.revision ?? "").changes > 0 || changed;
    if (projectId) changed = db.prepare("INSERT OR IGNORE INTO memory_project_links(memory_id,project_id,relation,source_ref) VALUES(?,?,'origin',?)")
      .run(id, projectId, refs.find(ref => ref.kind === "ticket")?.id ?? refs[0]?.id ?? "").changes > 0 || changed;
    if (!changed) return;
    const keyed = new Map([...previous, ...refs].filter(ref => ref && typeof ref.id === "string"
      && ["ticket", "run", "source", "project"].includes(ref.kind)).map(ref => [JSON.stringify([ref.kind, ref.id, ref.revision ?? ""]), ref]));
    if (current.owner_namespace === null) bindMemoryIdentity(id, { scope: current.scope as MemoryScope, kind: current.kind as MemoryKind,
      content: current.content, agentId: current.agent_id, projectId: current.project_id, projectPath: current.project_path,
      chatId: current.chat_id, curationActor: "legacy" }, new Date().toISOString());
    db.prepare(`UPDATE memory_identity_bindings SET origin_refs_json=?,revision=revision+1 WHERE memory_id=?`)
      .run(JSON.stringify([...keyed.values()].slice(-64)), id);
    db.prepare("UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    const revision = getMemoryStoreInfo().revision, now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO memory_projection_outbox VALUES(?,?,?,'queued','{}',?,?)")
      .run(`memory-origin:${id}:${revision}`, id, revision, now, now);
  }).immediate();
}

/** Internal projection repair, not a user-facing unscoped recall capability. */
export function readMemoryEntryForProjection(id: string): MemoryEntry | null {
  const row = getDb().prepare(`SELECT m.* FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
    WHERE m.id=? AND m.superseded_at IS NULL AND m.content<>''
    AND (b.owner_namespace IS NULL OR b.owner_namespace=?)
    AND COALESCE(json_extract(b.applicability_json,'$.enabled'),1)<>0`).get(id, getMemoryStoreInfo().ownerNamespace) as Row | undefined;
  return row ? toEntry(row) : null;
}

/** Live (non-superseded) memory for a project folder, newest first. */
export function listMemoryForContext(
  scope: MemoryRecallScope,
  limit = 40,
  sourceIds?: readonly string[],
): MemoryEntry[] {
  if (sourceIds && sourceIds.length === 0) return [];
  const ids = sourceIds ? [...new Set(sourceIds)] : null;
  const actors = memoryActorIds(scope.agentId ?? null), actorSql = actors.map(() => "?").join(",");
  if (ids && ids.length > 400) return ids.flatMap((_, index) => index % 400 ? []
    : listMemoryForContext(scope, -1, ids.slice(index, index + 400)));
  // Project ids may identify a Science study without a Desktop folder. A null
  // path is not global authority. Agent-specific portable learning remains
  // portable, but only for its own actor; unknown actors receive shared memory.
  const rows = getDb().prepare(`SELECT memory_entries.*, rb.owner_namespace AS binding_owner, rb.actor_id AS binding_actor, rb.applicability_json
    FROM memory_entries LEFT JOIN memory_identity_bindings rb ON rb.memory_id=memory_entries.id WHERE superseded_at IS NULL
    ${ids ? `AND id IN (${ids.map(() => "?").join(",")})` : ""}
    AND NOT EXISTS(SELECT 1 FROM memory_identity_bindings b WHERE b.memory_id=memory_entries.id
      AND (b.owner_namespace<>? OR json_extract(b.applicability_json,'$.recallChannel')='legacy_one_overlay'
        OR json_extract(b.applicability_json,'$.enabled')=0)) AND (
    (scope IN ('user_identity','team_memory','agent_team') AND project_path IS NULL)
    OR (scope='agent_repo' AND agent_id IN (${actorSql}) AND (project_path IS NULL OR project_path=?))
    OR (scope='project'
      AND (project_id IS NOT NULL OR project_path IS NOT NULL)
      AND (project_id IS NULL OR project_id=?)
      AND (project_path IS NULL OR project_path=?))
    OR (scope='session' AND chat_id=? AND (agent_id IS NULL OR agent_id IN (${actorSql})))
  ) ORDER BY created_at DESC LIMIT ?`).all(...(ids ?? []), getMemoryStoreInfo().ownerNamespace, ...actors, scope.projectPath ?? null,
    scope.projectId ?? null, scope.projectPath ?? null, scope.chatId ?? null, ...actors, -1) as Array<Row & MemoryRecallPolicyRow>;
  const allowed = rows.filter(row => allowsOrdinaryMemoryRecall(row, scope, getMemoryStoreInfo().ownerNamespace));
  return (limit < 0 ? allowed : allowed.slice(0, limit)).map(toEntry);
}

/** Compatibility readers reuse ordinary policy; unknown actor/domain cannot
 * acquire a restricted memory merely by selecting a folder or global list. */
export function listMemoryByPath(projectPath: string, limit = 40): MemoryEntry[] {
  return listMemoryForContext({ projectPath }, limit);
}
export function listGlobalMemory(limit = 30): MemoryEntry[] {
  return listMemoryForContext({}, limit);
}
export function listMemoryByPathForAgent(projectPath: string, agentId: string | null, limit = 40): MemoryEntry[] {
  return listMemoryForContext({ projectPath, agentId }, limit);
}
export function listGlobalMemoryForAgent(agentId: string | null, limit = 30): MemoryEntry[] {
  return listMemoryForContext({ agentId }, limit);
}

/**
 * Import idempotency tokens are durable provenance, not a recent-memory view.
 * Callers must be able to find an old token after thousands of newer rows, so
 * this query intentionally has no recency LIMIT and returns only matching
 * evidence strings rather than loading/embedding every memory entry.
 */
export function listMemoryEvidenceTokensForAgent(agentId: string, prefix: string): Set<string> {
  if (!agentId || !prefix) return new Set();
  const rows = getDb()
    .prepare(
      `SELECT evidence_json FROM memory_entries
       WHERE scope = 'agent_repo' AND agent_id = ? AND evidence_json LIKE ?`,
    )
    .all(agentId, `%${prefix}%`) as Array<{ evidence_json: string }>;
  const tokens = new Set<string>();
  for (const row of rows) {
    try {
      const evidence = JSON.parse(row.evidence_json) as unknown;
      if (!Array.isArray(evidence)) continue;
      for (const item of evidence) {
        if (typeof item === "string" && item.startsWith(prefix)) tokens.add(item);
      }
    } catch {
      // A malformed unrelated legacy row must not block importing valid memory.
    }
  }
  return tokens;
}

function knownMemoryAudience(row: Row): string | null {
  const binding = getDb().prepare("SELECT owner_namespace,actor_id,applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(row.id) as
    { owner_namespace: string; actor_id: string | null; applicability_json: string } | undefined;
  if (!binding) return JSON.stringify(["default", null, null]);
  if (binding.owner_namespace !== getMemoryStoreInfo().ownerNamespace) return null;
  try {
    const value = JSON.parse(binding.applicability_json) as Record<string, unknown>;
    if (!value || Array.isArray(value) || (value.enabled !== undefined && value.enabled !== true)) return null;
    if (value.recallChannel !== undefined && value.recallChannel !== "default" && value.recallChannel !== "legacy_one_overlay") return null;
    const known = new Set(["scope", "projectIds", "projectPathHash", "actorId", "chatId", "recallChannel", "enabled", "compatibilityScope"]);
    if (Object.keys(value).some(key => !known.has(key))) return null;
    if (value.scope !== undefined && value.scope !== row.scope) return null;
    if (value.actorId !== undefined && !sameMemoryActor(value.actorId as string | null, row.agent_id)) return null;
    if (!sameMemoryActor(binding.actor_id, row.agent_id)) return null;
    if (value.chatId !== undefined && value.chatId !== row.chat_id) return null;
    if (value.projectIds !== undefined && JSON.stringify(value.projectIds) !== JSON.stringify(row.project_id ? [row.project_id] : [])) return null;
    const pathHash = row.project_path ? createHash("sha256").update(row.project_path).digest("hex") : null;
    if (value.projectPathHash !== undefined && value.projectPathHash !== pathHash) return null;
    const compatibility = value.compatibilityScope as { scope?: string; scopeRef?: string | null } | undefined;
    if (compatibility && Object.keys(compatibility).some(key => key !== "scope" && key !== "scopeRef")) return null;
    return JSON.stringify([value.recallChannel ?? "default", compatibility?.scope ?? null, compatibility?.scopeRef ?? null]);
  } catch { return null; }
}
/** Public audience identity is separate from the raw legacy actor column.
 * Core user/project rows can carry their actor only in the canonical binding. */
export function memoryAudienceKey(id: string): string | null {
  const binding = getDb().prepare("SELECT owner_namespace,applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(id) as
    { owner_namespace: string; applicability_json: string } | undefined;
  if (!binding) return JSON.stringify(["default", null, null]);
  if (binding.owner_namespace !== getMemoryStoreInfo().ownerNamespace) return null;
  try {
    const value = JSON.parse(binding.applicability_json) as { enabled?: boolean; recallChannel?: string;
      compatibilityScope?: { scope?: string; scopeRef?: string | null } };
    if (value.enabled === false) return null;
    return JSON.stringify([value.recallChannel ?? "default", value.compatibilityScope?.scope ?? null, value.compatibilityScope?.scopeRef ?? null]);
  } catch { return null; }
}

/** Candidates that share the same governed owner boundary as one new memory. */
export function listMemoryRelationCandidates(entry: MemoryEntry, limit = 160): MemoryEntry[] {
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  let rows: Row[] = [];
  if (entry.scope === "user_identity") {
    rows = getDb().prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'user_identity' AND superseded_at IS NULL AND id <> ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, capped) as Row[];
  } else if (entry.scope === "team_memory" || entry.scope === "agent_team") {
    rows = getDb().prepare(
      `SELECT * FROM memory_entries
       WHERE scope IN ('team_memory','agent_team') AND superseded_at IS NULL AND id <> ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, capped) as Row[];
  } else if (entry.scope === "agent_repo" && entry.agentId) {
    const actors = memoryActorIds(entry.agentId);
    rows = getDb().prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'agent_repo' AND agent_id IN (${actors.map(() => "?").join(",")})
         AND superseded_at IS NULL AND id <> ? AND project_id IS ? AND project_path IS ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(...actors, entry.id, entry.projectId, entry.projectPath, capped) as Row[];
  } else if (entry.scope === "project" && (entry.projectId || entry.projectPath)) {
    rows = getDb().prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'project' AND superseded_at IS NULL AND id <> ?
         AND ((project_id IS NOT NULL AND project_id = ?) OR (project_path IS NOT NULL AND project_path = ?))
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, entry.projectId, entry.projectPath, capped) as Row[];
  }
  const current = getDb().prepare("SELECT * FROM memory_entries WHERE id=?").get(entry.id) as Row | undefined;
  const audience = current ? knownMemoryAudience(current) : null;
  return audience ? rows.filter(row => knownMemoryAudience(row) === audience).map(toEntry) : [];
}

/** Dedup check: same scope+kind+content already live for this path (or globally). */
export function findEquivalentMemoryId(
  scope: MemoryScope,
  kind: MemoryKind,
  content: string,
  projectPath: string | null,
  agentId: string | null,
  boundary: { projectId?: string | null; chatId?: string | null; recallChannel?: "default" | "legacy_one_overlay";
    compatibilityScope?: { scope: string; scopeRef: string | null } } = {},
): string | null {
  const norm = content.trim().toLowerCase();
  const actors = memoryActorIds(agentId), actorSql = actors.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE scope = ? AND kind = ? AND lower(trim(content)) = ?
         AND superseded_at IS NULL
         AND (project_path IS ? OR project_path = ?)
         AND (scope != 'agent_repo' OR agent_id IN (${actorSql}) OR (agent_id IS NULL AND ? IS NULL))
         AND (scope != 'session' OR (chat_id IS ? AND (agent_id IN (${actorSql}) OR (agent_id IS NULL AND ? IS NULL))))
         AND (scope != 'project' OR project_id IS ? OR (project_id IS NULL AND project_path IS NOT NULL))
         AND COALESCE((SELECT json_extract(applicability_json,'$.recallChannel') FROM memory_identity_bindings WHERE memory_id=memory_entries.id),'default')=?
         AND COALESCE((SELECT json_extract(applicability_json,'$.compatibilityScope.scope') FROM memory_identity_bindings WHERE memory_id=memory_entries.id),'')=?
         AND COALESCE((SELECT json_extract(applicability_json,'$.compatibilityScope.scopeRef') FROM memory_identity_bindings WHERE memory_id=memory_entries.id),'')=?
         AND COALESCE((SELECT json_extract(applicability_json,'$.enabled') FROM memory_identity_bindings WHERE memory_id=memory_entries.id),1)<>0
       LIMIT 64`,
    )
    .all(scope, kind, norm, projectPath, projectPath, ...actors, agentId, boundary.chatId ?? null, ...actors, agentId, boundary.projectId ?? null,
      boundary.recallChannel ?? "default", boundary.compatibilityScope?.scope ?? "", boundary.compatibilityScope?.scopeRef ?? "") as Row[];
  const policyCompatible = (candidate: Row) => {
    if (knownMemoryAudience(candidate) === null) return false;
    const binding = getDb().prepare("SELECT applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(candidate.id) as { applicability_json: string } | undefined;
    if (!binding) return true;
    const policy = JSON.parse(binding.applicability_json) as { actorId?: string | null };
    // An explicit actor restriction in a shared scope is not implied by its
    // identical prose. The incoming host must supply that same actor boundary.
    return policy.actorId == null || sameMemoryActor(policy.actorId, agentId);
  };
  const row = rows.find(policyCompatible);
  if (row) return row.id;
  // A memory translated to English keeps its original wording in the side
  // table; the same original arriving again (an older engine, an import) is
  // still the same memory.
  try {
    const nativeRows = getDb()
      .prepare(
        `SELECT m.* FROM memory_entries m
           JOIN memory_entry_native n ON n.entry_id = m.id
         WHERE m.scope = ? AND m.kind = ? AND lower(trim(n.content_native)) = ?
           AND m.superseded_at IS NULL
           AND (m.project_path IS ? OR m.project_path = ?)
           AND (m.scope != 'agent_repo' OR m.agent_id IN (${actorSql}) OR (m.agent_id IS NULL AND ? IS NULL))
           AND (m.scope != 'session' OR (m.chat_id IS ? AND (m.agent_id IN (${actorSql}) OR (m.agent_id IS NULL AND ? IS NULL))))
           AND (m.scope != 'project' OR m.project_id IS ? OR (m.project_id IS NULL AND m.project_path IS NOT NULL))
           AND COALESCE((SELECT json_extract(applicability_json,'$.recallChannel') FROM memory_identity_bindings WHERE memory_id=m.id),'default')=?
           AND COALESCE((SELECT json_extract(applicability_json,'$.compatibilityScope.scope') FROM memory_identity_bindings WHERE memory_id=m.id),'')=?
           AND COALESCE((SELECT json_extract(applicability_json,'$.compatibilityScope.scopeRef') FROM memory_identity_bindings WHERE memory_id=m.id),'')=?
           AND COALESCE((SELECT json_extract(applicability_json,'$.enabled') FROM memory_identity_bindings WHERE memory_id=m.id),1)<>0
         LIMIT 64`,
      )
      .all(scope, kind, norm, projectPath, projectPath, ...actors, agentId, boundary.chatId ?? null, ...actors, agentId, boundary.projectId ?? null,
        boundary.recallChannel ?? "default", boundary.compatibilityScope?.scope ?? "", boundary.compatibilityScope?.scopeRef ?? "") as Row[];
    return nativeRows.find(policyCompatible)?.id ?? null;
  } catch {
    return null; // side table absent: nothing was translated on this store
  }
}

export function hasEquivalentMemory(
  scope: MemoryScope,
  kind: MemoryKind,
  content: string,
  projectPath: string | null,
  agentId: string | null,
): boolean {
  return findEquivalentMemoryId(scope, kind, content, projectPath, agentId) !== null;
}

/** 에이전트 상세 UI용 — 프로젝트에 귀속되지 않은 agent-repo 메모리만 최신순.
 *  프로젝트 메모리는 프로젝트가 소유하므로 전역 에이전트 상세에서 섞거나 노출하지 않는다. */
export function listMemoryEntriesForAgentUi(
  agentId: string,
  limit = 100,
): Array<MemoryEntry & { contentEnglish?: string }> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE superseded_at IS NULL AND agent_id = ?
         AND scope = 'agent_repo' AND project_id IS NULL AND project_path IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Row[];
  // People see the original wording; the English text stays the model-facing
  // and search surface (plan 2026-09-23 D-5).
  const entries = rows.map(toEntry);
  const natives = nativeTextsFor("memory_entry", entries.map((entry) => entry.id));
  return entries.map((entry) => {
    const native = natives.get(entry.id);
    return native ? { ...entry, content: native, contentEnglish: entry.content } : entry;
  });
}

/** 드리밍 통합이 흡수한 원본 엔트리들을 superseded 처리(파괴 아님 — 복구 가능 이력 유지). */
export function supersedeMemoryEntries(ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = getDb().prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL");
  const tx = getDb().transaction((list: string[]) => {
    for (const id of list) stmt.run(now, id);
  });
  tx(ids);
}

/** Exact prefix the pre-1.2.82 curator wrote for a turn without memory events (replaced in 1ef20f44). */
export const LEGACY_REQUEST_ECHO_PREFIX = "이 에이전트는 다음과 같은 요청을 수행한다: ";

/**
 * Those rows only repeat the owner's request (some repeat host prompts) yet were stored as live procedures, so recall
 * kept serving them. Supersede them (history stays, nothing is deleted). Idempotent; returns how many it retired.
 */
export function supersedeLegacyRequestEchoMemories(): number {
  const now = new Date().toISOString();
  return getDb().prepare(
    "UPDATE memory_entries SET superseded_at = ? WHERE superseded_at IS NULL AND kind = 'procedure' AND substr(content, 1, ?) = ?",
  ).run(now, LEGACY_REQUEST_ECHO_PREFIX.length, LEGACY_REQUEST_ECHO_PREFIX).changes;
}

/** 결정론 dedup — scope+kind+content(정규화)가 완전히 같은 live 엔트리 중 최신만 남기고 supersede.
 *  드리밍 1단계(무LLM). 반환: 정리된 개수.
 *
 *  One pass that groups live entries by the duplicate key and keeps the newest (created_at, id) of each group: every
 *  other member has a newer duplicate, which is exactly what the earlier pairwise EXISTS selected. That pairwise form
 *  compared every live entry with every other one in its scope and lower()-ed both texts per pair, synchronously in Main
 *  on every 5-minute dreaming tick (2.3 s at 10,000 entries, quadratic; the owner's Main sampled 100% busy in lowerFunc
 *  for 3 s windows at 5-minute spacing, 2026-10-28). PARTITION BY groups NULLs together as the IS comparisons did; the
 *  project/session key parts only count in those scopes, and the eligibility conditions depend only on the group key. */
export function dedupExactDuplicateMemories(): number {
  const rows = getDb()
    .prepare(
      `SELECT id FROM (
         SELECT m.id, ROW_NUMBER() OVER (
             PARTITION BY m.scope, m.kind, lower(trim(m.content)), m.project_path, m.agent_id,
               CASE WHEN m.scope = 'project' THEN m.project_id END,
               CASE WHEN m.scope = 'session' THEN m.chat_id END,
               mb.owner_namespace, mb.actor_id, mb.applicability_json
             ORDER BY m.created_at DESC, m.id DESC) AS newest_first
         FROM memory_entries m LEFT JOIN memory_identity_bindings mb ON mb.memory_id=m.id
         WHERE m.superseded_at IS NULL AND ${ordinaryRecall("m")}
           AND (m.scope != 'project' OR length(trim(COALESCE(m.project_id,m.project_path,'')))>0)
           AND (m.scope != 'session' OR length(trim(COALESCE(m.chat_id,'')))>0)
       ) WHERE newest_first > 1`,
    )
    .all() as Array<{ id: string }>;
  supersedeMemoryEntries(rows.map((r) => r.id));
  return rows.length;
}

/** 드리밍 2단계 대상 — live agent_repo 메모리가 minCount 이상 쌓인 에이전트 목록. */
export function listAgentIdsWithLiveMemory(minCount = 8): Array<{ agentId: string; count: number }> {
  const rows = getDb()
    .prepare(
      `SELECT agent_id AS agentId, COUNT(*) AS count FROM memory_entries
       WHERE superseded_at IS NULL AND agent_id IS NOT NULL AND scope = 'agent_repo'
       GROUP BY agent_id HAVING COUNT(*) >= ?
       ORDER BY count DESC`,
    )
    .all(minCount) as Array<{ agentId: string; count: number }>;
  return rows;
}

export function countMemory(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
  return r.n;
}
