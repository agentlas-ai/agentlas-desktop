// Local projection of durable memory relationships. Edges never create or move
// content; they only connect memories already admitted under one owner boundary.
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { rankHybridLocal } from "./local-embedding";
import { listMemoryRelationCandidates, type MemoryEntry } from "./store";

const MAX_SIMILAR_EDGES = 5;
const MIN_VECTOR_SCORE = 0.55;

function pathHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

export function memoryOwnerScopeKey(entry: MemoryEntry): string | null {
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
