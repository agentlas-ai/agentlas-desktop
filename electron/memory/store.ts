// Durable memory store (memory_entries table). The Memory Curator owns writes here.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";

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
  superseded_at: string | null;
  created_at: string;
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
    supersededAt: r.superseded_at,
    createdAt: r.created_at,
  };
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
}

export function insertMemoryEntry(e: NewMemoryEntry): MemoryEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO memory_entries
       (id, scope, kind, content, project_id, project_path, agent_id, chat_id,
        confidence, sensitivity, evidence_json, context_json, superseded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
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
      now,
    );
  return {
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
    supersededAt: null,
    createdAt: now,
  };
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

/** Dedup check: same scope+kind+content already live for this path (or globally). */
export function hasEquivalentMemory(
  scope: MemoryScope,
  kind: MemoryKind,
  content: string,
  projectPath: string | null,
  agentId: string | null,
): boolean {
  const norm = content.trim().toLowerCase();
  const row = getDb()
    .prepare(
      `SELECT 1 FROM memory_entries
       WHERE scope = ? AND kind = ? AND lower(trim(content)) = ?
         AND superseded_at IS NULL
         AND (project_path IS ? OR project_path = ?)
         AND (scope != 'agent_repo' OR agent_id IS ?)
       LIMIT 1`,
    )
    .get(scope, kind, norm, projectPath, projectPath, agentId);
  return Boolean(row);
}

/** 에이전트 상세 UI용 — 이 에이전트가 남긴 모든 활성 메모리(프로젝트 무관), 최신순.
 *  런타임 큐레이터가 쌓는 durable 메모리를 자가진화/타임라인 화면에 보이게 하는 읽기 경로. */
export function listMemoryEntriesForAgentUi(agentId: string, limit = 100): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE superseded_at IS NULL AND agent_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Row[];
  return rows.map(toEntry);
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
