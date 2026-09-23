// Durable memory store (memory_entries table). The Memory Curator owns writes here.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
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
}

export function insertMemoryEntry(e: NewMemoryEntry): MemoryEntry {
  const id = randomUUID();
  let now = "";
  const embedding = autoLocalEmbedding(e.content);
  const insert = getDb().transaction(() => {
    assertMemoryWriteAllowed({
      scope: e.scope,
      kind: e.kind,
      content: e.content,
      projectId: e.projectId,
      projectPath: e.projectPath,
      agentId: e.agentId,
      chatId: e.chatId,
      intakeRunId: e.intakeRunId,
      intakeEpoch: e.intakeEpoch,
    });
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
    const native = e.contentNative?.trim();
    if (native && native !== e.content.trim()) {
      ensureMemoryNativeTable();
      getDb().prepare(
        "INSERT OR REPLACE INTO memory_entry_native (entry_id, content_native, created_at) VALUES (?, ?, ?)",
      ).run(id, native.slice(0, 4_000), now);
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

/** Live (non-superseded) memory for a project folder, newest first. */
export function listMemoryForContext(
  scope: { projectId?: string | null; projectPath?: string | null; agentId?: string | null; chatId?: string | null },
  limit = 40,
): MemoryEntry[] {
  // Project ids may identify a Science study without a Desktop folder. A null
  // path is not global authority. Agent-specific portable learning remains
  // portable, but only for its own actor; unknown actors receive shared memory.
  const rows = getDb().prepare(`SELECT * FROM memory_entries WHERE superseded_at IS NULL AND (
    (scope IN ('user_identity','team_memory','agent_team') AND project_path IS NULL)
    OR (scope='agent_repo' AND agent_id=? AND (project_path IS NULL OR project_path=?))
    OR (scope='project'
      AND (project_id IS NOT NULL OR project_path IS NOT NULL)
      AND (project_id IS NULL OR project_id=?)
      AND (project_path IS NULL OR project_path=?))
    OR (scope='session' AND chat_id=? AND (agent_id IS NULL OR agent_id=?))
  ) ORDER BY created_at DESC LIMIT ?`).all(scope.agentId ?? null, scope.projectPath ?? null,
    scope.projectId ?? null, scope.projectPath ?? null, scope.chatId ?? null, scope.agentId ?? null, limit) as Row[];
  return rows.map(toEntry);
}

/** Live (non-superseded) memory for a project folder, newest first. */
export function listMemoryByPath(projectPath: string, limit = 40): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE superseded_at IS NULL
         AND (
           project_path = ?
           OR (project_path IS NULL AND scope IN ('user_identity', 'team_memory', 'agent_team'))
         )
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectPath, limit) as Row[];
  return rows.map(toEntry);
}

/** Global (folder-less) durable memory — used when a chat has no working folder. */
export function listGlobalMemory(limit = 30): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE project_path IS NULL AND scope != 'session' AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(toEntry);
}

/** Per-agent project memory: project/agent_team memory PLUS only THIS agent's agent_repo.
 *  (Other agents' agent_repo is excluded so each session sees only its own + shared memory.) */
export function listMemoryByPathForAgent(
  projectPath: string,
  agentId: string | null,
  limit = 40,
): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE superseded_at IS NULL
         AND (
           project_path = ?
           OR (project_path IS NULL AND scope IN ('user_identity', 'team_memory', 'agent_team'))
           OR (project_path IS NULL AND scope = 'agent_repo' AND agent_id IS ?)
         )
         AND (scope != 'agent_repo' OR agent_id IS ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectPath, agentId, agentId, limit) as Row[];
  return rows.map(toEntry);
}

/** Per-agent global memory: shared (agent_team) + this agent's own (agent_repo), folder-less. */
export function listGlobalMemoryForAgent(agentId: string | null, limit = 30): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE project_path IS NULL AND scope != 'session' AND superseded_at IS NULL
         AND (scope != 'agent_repo' OR agent_id IS ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Row[];
  return rows.map(toEntry);
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
    rows = getDb().prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'agent_repo' AND agent_id = ? AND superseded_at IS NULL AND id <> ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.agentId, entry.id, capped) as Row[];
  } else if (entry.scope === "project" && (entry.projectId || entry.projectPath)) {
    rows = getDb().prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'project' AND superseded_at IS NULL AND id <> ?
         AND ((project_id IS NOT NULL AND project_id = ?) OR (project_path IS NOT NULL AND project_path = ?))
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, entry.projectId, entry.projectPath, capped) as Row[];
  }
  return rows.map(toEntry);
}

/** Dedup check: same scope+kind+content already live for this path (or globally). */
export function findEquivalentMemoryId(
  scope: MemoryScope,
  kind: MemoryKind,
  content: string,
  projectPath: string | null,
  agentId: string | null,
): string | null {
  const norm = content.trim().toLowerCase();
  const row = getDb()
    .prepare(
      `SELECT id FROM memory_entries
       WHERE scope = ? AND kind = ? AND lower(trim(content)) = ?
         AND superseded_at IS NULL
         AND (project_path IS ? OR project_path = ?)
         AND (scope != 'agent_repo' OR agent_id IS ?)
       LIMIT 1`,
    )
    .get(scope, kind, norm, projectPath, projectPath, agentId) as { id: string } | undefined;
  if (row?.id) return row.id;
  // A memory translated to English keeps its original wording in the side
  // table; the same original arriving again (an older engine, an import) is
  // still the same memory.
  try {
    const nativeRow = getDb()
      .prepare(
        `SELECT m.id FROM memory_entries m
           JOIN memory_entry_native n ON n.entry_id = m.id
         WHERE m.scope = ? AND m.kind = ? AND lower(trim(n.content_native)) = ?
           AND m.superseded_at IS NULL
           AND (m.project_path IS ? OR m.project_path = ?)
           AND (m.scope != 'agent_repo' OR m.agent_id IS ?)
         LIMIT 1`,
      )
      .get(scope, kind, norm, projectPath, projectPath, agentId) as { id: string } | undefined;
    return nativeRow?.id ?? null;
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

/** 결정론 dedup — scope+kind+content(정규화)가 완전히 같은 live 엔트리 중 최신만 남기고 supersede.
 *  드리밍 1단계(무LLM). 반환: 정리된 개수. */
export function dedupExactDuplicateMemories(): number {
  const rows = getDb()
    .prepare(
      `SELECT id FROM memory_entries m
       WHERE superseded_at IS NULL
         AND EXISTS (
           SELECT 1 FROM memory_entries n
           WHERE n.superseded_at IS NULL
             AND n.scope = m.scope AND n.kind = m.kind
             AND lower(trim(n.content)) = lower(trim(m.content))
             AND (n.project_path IS m.project_path)
             AND (n.agent_id IS m.agent_id)
             AND (n.created_at > m.created_at OR (n.created_at = m.created_at AND n.id > m.id))
         )`,
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
