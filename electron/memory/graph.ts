// Local projection of durable memory relationships. Edges never create or move
// content; they only connect memories already admitted under one owner boundary.
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { rankHybridLocal } from "./local-embedding";
import { listMemoryRelationCandidates, type MemoryEntry } from "./store";
import { nativeTextsFor } from "./native-text";
import { assertMemoryWriteAllowed, MemoryRevokedError, memoryOwnerKey } from "./revocations";

const MAX_SIMILAR_EDGES = 5;
const MIN_VECTOR_SCORE = 0.55;

function pathHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

export function memoryOwnerScopeKey(entry: Pick<MemoryEntry, "scope" | "agentId" | "projectId" | "projectPath">): string | null {
  if (entry.scope === "user_identity") return "user:local";
  if (entry.scope === "team_memory" || entry.scope === "agent_team") return "team:local";
  if (entry.scope === "agent_repo" && entry.agentId) return `agent:${entry.agentId}`;
  if (entry.scope === "project") {
    if (entry.projectId) return `project:${entry.projectId}`;
    if (entry.projectPath) return `project-path:${pathHash(entry.projectPath)}`;
  }
  return null;
}

/** Create top-k embedding similarity edges inside the exact same owner scope. */
export function linkMemoryEntryBySimilarity(entry: MemoryEntry): number {
  const ownerScopeKey = memoryOwnerScopeKey(entry);
  if (!ownerScopeKey) return 0;
  const candidates = listMemoryRelationCandidates(entry);
  if (candidates.length === 0) return 0;
  const ranked = rankHybridLocal(entry.content, candidates.map((candidate) => ({
    id: candidate.id,
    text: candidate.content,
    embedding: candidate.embedding.vector,
    candidate,
  })))
    .filter((result) => result.semanticEligible && result.vectorScore >= MIN_VECTOR_SCORE)
    .slice(0, MAX_SIMILAR_EDGES);
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO memory_relation_edges (
       relation_id, from_memory_id, to_memory_id, relation_type, score,
       owner_scope_key, embedding_model, embedding_adapter,
       embedding_model_sha256, created_at
     ) VALUES (?, ?, ?, 'similar_to', ?, ?, ?, ?, ?, ?)`,
  );
  let written = 0;
  const now = new Date().toISOString();
  const transaction = getDb().transaction(() => {
    for (const result of ranked) {
      const pair = [entry.id, result.item.candidate.id].sort();
      const outcome = insert.run(
        `mre_${randomUUID()}`,
        pair[0],
        pair[1],
        result.vectorScore,
        ownerScopeKey,
        entry.embedding.model,
        entry.embedding.adapter,
        entry.embedding.modelSha256,
        now,
      );
      written += outcome.changes;
    }
  });
  transaction();
  return written;
}

export function countMemoryRelationEdges(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM memory_relation_edges").get() as { n: number }).n);
}

/** Engine One block identity: lowercase + collapsed whitespace, without NFKC. */
export function memoryBlockKey(content: string): string {
  return `h:${createHash("sha256").update(content.toLowerCase().replace(/\s+/g, " ").trim(), "utf8").digest("hex").slice(0, 16)}`;
}

/** Resolve an explicit recalled block under the final owner; never guess by similarity. */
export function supersedeExplicitMemory(entry: Pick<MemoryEntry, "id">, blockKey: string): string | null {
  if (!/^h:[0-9a-f]{16}$/.test(blockKey)) return null;
  const ownerKey = (value: Parameters<typeof memoryOwnerKey>[0]) => memoryOwnerKey({
    ...value, scope: value.scope === "agent_team" ? "team_memory" : value.scope,
  });
  return getDb().transaction(() => {
    const current = getDb().prepare(`SELECT scope, kind, content, project_id, project_path, agent_id, chat_id,
      embedding_model, embedding_adapter, embedding_model_sha256
      FROM memory_entries WHERE id = ? AND superseded_at IS NULL`).get(entry.id) as {
        scope: MemoryEntry["scope"]; kind: MemoryEntry["kind"]; content: string; project_id: string | null; project_path: string | null;
        agent_id: string | null; chat_id: string | null; embedding_model: string | null;
        embedding_adapter: string | null; embedding_model_sha256: string | null;
      } | undefined;
    if (!current) return null;
    const successor = { scope: current.scope, projectId: current.project_id, projectPath: current.project_path,
      agentId: current.agent_id, chatId: current.chat_id };
    const ownerScopeKey = memoryOwnerScopeKey(successor);
    if (!ownerScopeKey) return null;
    try {
      assertMemoryWriteAllowed({ ...successor, kind: current.kind, content: current.content });
      const native = nativeTextsFor("memory_entry", [entry.id]).get(entry.id);
      if (native) assertMemoryWriteAllowed({ ...successor, kind: current.kind, content: native });
    } catch (error) {
      if (error instanceof MemoryRevokedError) return null;
      throw error;
    }
    const authority = ownerKey(successor);
    const rows = getDb().prepare(`SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, evidence_json
      FROM memory_entries WHERE superseded_at IS NULL AND id <> ?
        AND (scope = ? OR (? IN ('team_memory','agent_team') AND scope IN ('team_memory','agent_team')))
        AND (scope != 'agent_repo' OR agent_id IS ?)`)
      .all(entry.id, current.scope, current.scope, current.agent_id) as Array<{
        id: string; scope: MemoryEntry["scope"]; kind: MemoryEntry["kind"]; content: string;
        project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null;
        evidence_json: string;
      }>;
    const owned = rows.filter((row) => ownerKey({
      scope: row.scope, projectId: row.project_id, projectPath: row.project_path,
      agentId: row.agent_id, chatId: row.chat_id,
    }) === authority);
    const natives = nativeTextsFor("memory_entry", owned.map((row) => row.id));
    const matches = owned.filter((row) => {
      if (memoryBlockKey(row.content) === blockKey) return true;
      const native = natives.get(row.id);
      if (native && memoryBlockKey(native) === blockKey) return true;
      // Imported One blocks keep their exact source key across translation.
      try {
        const refs: unknown = JSON.parse(row.evidence_json);
        return Array.isArray(refs) && refs.includes(`one-soul:${blockKey.slice(2)}`);
      } catch { return false; }
    });
    // Truncated hash collisions and duplicate identities are ambiguous, never authority.
    if (matches.length !== 1) return null;
    const old = matches[0];
    const now = new Date().toISOString();
    getDb().prepare(`INSERT OR IGNORE INTO memory_relation_edges (
      relation_id, from_memory_id, to_memory_id, relation_type, score,
      owner_scope_key, embedding_model, embedding_adapter, embedding_model_sha256, created_at
    ) VALUES (?, ?, ?, 'supersedes', NULL, ?, ?, ?, ?, ?)`).run(
      `mre_${randomUUID()}`, entry.id, old.id, ownerScopeKey,
      current.embedding_model, current.embedding_adapter, current.embedding_model_sha256, now,
    );
    getDb().prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL").run(now, old.id);
    return old.id;
  })();
}

/** Read-only projection filter. Unmarked legacy/manual lines are never guessed. */
export function filterSupersededProjectSoul(soul: string, projectId?: string | null, projectPath?: string | null): string {
  const lines = soul.split(/\r?\n/);
  const marked = new Map<number, { kind: string; content: string; id: string }>();
  const metadataLines = new Set<number>();
  let inAutoSection = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "## Auto-curated memory") inAutoSection = true;
    else if (/^##\s+/.test(line)) inAutoSection = false;
    const match = inAutoSection ? /^- \(([^)]+)\) (.*)$/.exec(line) : null;
    const metadata = match ? /^<!-- agentlas-memory:([0-9a-f-]{36}) -->$/.exec(lines[index + 1] ?? "") : null;
    if (match && metadata) {
      marked.set(index, { kind: match[1], content: match[2], id: metadata[1] });
      metadataLines.add(index + 1);
    }
  }
  if (marked.size === 0) return soul;
  const authority = memoryOwnerKey({ scope: "project", projectId, projectPath });
  const rows = new Map<string, { kind: string; content: string; project_id: string | null; project_path: string | null; superseded_at: string | null }>();
  const ids = [...new Set([...marked.values()].map((item) => item.id))];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    for (const row of getDb().prepare(`SELECT id, kind, content, project_id, project_path, superseded_at
      FROM memory_entries WHERE scope = 'project' AND id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as Array<{ id: string; kind: string; content: string; project_id: string | null; project_path: string | null; superseded_at: string | null }>) {
      rows.set(row.id, row);
    }
  }
  const natives = nativeTextsFor("memory_entry", ids);
  return lines.flatMap((line, index) => {
    if (metadataLines.has(index)) return [];
    const item = marked.get(index);
    if (!item) return [line];
    const row = rows.get(item.id);
    const native = natives.get(item.id);
    const sameOwner = row && memoryOwnerKey({ scope: "project", projectId: row.project_id, projectPath: row.project_path }) === authority;
    const sameContent = row && (memoryBlockKey(row.content) === memoryBlockKey(item.content)
      || (native && memoryBlockKey(native) === memoryBlockKey(item.content)));
    if (sameOwner && row!.superseded_at && row!.kind === item.kind && sameContent) return [];
    // The host marker is projection metadata, not an identifier for the model.
    return [`- (${item.kind}) ${item.content}`];
  }).join("\n");
}

/**
 * Latest-wins for restated rules (2026-09-24).
 *
 * The owner's store held the same agent rule several times over (vector score
 * 1.0, all live) plus older and newer versions of one rule side by side, and
 * recall injected all of them - an older "hold" rule kept outvoting the newer
 * wording. When a new decision/procedure/fact is admitted, a live memory of the
 * same kind under the exact same owner boundary that it restates (vector score
 * at or above RESTATEMENT_MIN_SCORE, older than the new one) is superseded -
 * never deleted - and a `supersedes` edge records which memory replaced it and
 * with what score. The threshold is deliberately high: complementary rules in
 * one topic measured 0.74-0.82 and must both stay live.
 */
const RESTATEMENT_MIN_SCORE = 0.9;
const RESTATEMENT_KINDS = new Set(["decision", "procedure", "fact"]);

export function supersedeRestatedMemories(entry: MemoryEntry): string[] {
  if (!RESTATEMENT_KINDS.has(entry.kind)) return [];
  const ownerScopeKey = memoryOwnerScopeKey(entry);
  if (!ownerScopeKey) return [];
  const candidates = listMemoryRelationCandidates(entry)
    .filter((candidate) => candidate.kind === entry.kind && candidate.createdAt <= entry.createdAt);
  if (candidates.length === 0) return [];
  const restated = rankHybridLocal(entry.content, candidates.map((candidate) => ({
    id: candidate.id,
    text: candidate.content,
    embedding: candidate.embedding.vector,
    candidate,
  })))
    .filter((result) => result.semanticEligible && result.vectorScore >= RESTATEMENT_MIN_SCORE)
    .slice(0, 8);
  if (restated.length === 0) return [];
  const now = new Date().toISOString();
  const edge = getDb().prepare(
    `INSERT OR IGNORE INTO memory_relation_edges (
       relation_id, from_memory_id, to_memory_id, relation_type, score,
       owner_scope_key, embedding_model, embedding_adapter,
       embedding_model_sha256, created_at
     ) VALUES (?, ?, ?, 'supersedes', ?, ?, ?, ?, ?, ?)`,
  );
  const retire = getDb().prepare(
    "UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL",
  );
  const superseded: string[] = [];
  getDb().transaction(() => {
    for (const result of restated) {
      const old = result.item.candidate;
      edge.run(
        `mre_${randomUUID()}`,
        entry.id,
        old.id,
        Math.max(-1, Math.min(1, result.vectorScore)),
        ownerScopeKey,
        entry.embedding.model,
        entry.embedding.adapter,
        entry.embedding.modelSha256,
        now,
      );
      if (retire.run(now, old.id).changes === 1) superseded.push(old.id);
    }
  })();
  return superseded;
}
