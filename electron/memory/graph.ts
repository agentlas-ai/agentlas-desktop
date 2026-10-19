// Local projection of durable memory relationships. Edges never create or move
// content; they only connect memories already admitted under one owner boundary.
import { createHash, randomUUID } from "node:crypto";
import { getMemoryStoreInfo, getMemoryDb as getDb } from "./database";
import { rankHybridLocal } from "./local-embedding";
import { listMemoryRelationCandidates, memoryAudienceKey, type MemoryEntry } from "./store";
import { nativeTextsFor } from "./native-text";
import { assertMemoryWriteAllowed, MemoryRevokedError, memoryOwnerKey, memoryAuthorityOwnerKeys } from "./revocations";

import { memoryActorIds, sameMemoryActor, isOneMemoryActor } from "../../shared/memory-actor-family";

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

function canonicalApplicabilityKey(raw: string | null): string | null {
  const stable=(value: unknown,key=""): unknown => {
    if ((key==="actorId"||key==="agentId") && typeof value==="string" && isOneMemoryActor(value)) return "product:One";
    if (Array.isArray(value)) return key==="projectIds"?[...value].sort():value.map(item=>stable(item));
    return value && typeof value==="object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([field,item])=>[field,stable(item,field)])):value;
  };
  try {return JSON.stringify(stable(JSON.parse(raw ?? "{}")));} catch {return null;}
}
/** Idempotent derived edges from the canonical owner's exact predecessor links.
 * This projects an already committed replacement; it never decides retirement. */
export function projectCanonicalMemorySupersedes(successorId: string): number {
  const db=getDb();
  return db.transaction(()=>{
    const select=`SELECT m.*,b.owner_namespace,b.actor_id,b.applicability_json FROM memory_entries m
      LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE m.id=?`;
    type BoundRow={id:string;scope:MemoryEntry["scope"];project_id:string|null;project_path:string|null;agent_id:string|null;chat_id:string|null;content:string;superseded_at:string|null;owner_namespace:string|null;actor_id:string|null;applicability_json:string|null;embedding_model:string|null;embedding_adapter:string|null;embedding_model_sha256:string|null};
    const current=db.prepare(select).get(successorId) as BoundRow|undefined;
    const owner=getMemoryStoreInfo().ownerNamespace;
    const owned=(row:BoundRow)=>row.owner_namespace ? row.owner_namespace===owner : owner.startsWith("device-local:");
    if(!current || !owned(current) || !current.content || current.superseded_at) return 0;
    const source=(row:BoundRow)=>({scope:row.scope,projectId:row.project_id,projectPath:row.project_path,agentId:row.agent_id ?? row.actor_id,chatId:row.chat_id});
    const scopeKey=memoryOwnerScopeKey(source(current)),audience=memoryAudienceKey(current.id),application=canonicalApplicabilityKey(current.applicability_json);
    if(!scopeKey || !audience || application===null) return 0;
    const ownerKeys=memoryAuthorityOwnerKeys(source(current));
    const links=db.prepare("SELECT DISTINCT source_id FROM memory_origin_links WHERE memory_id=? AND source_kind='memory' AND relation='supersedes'").all(successorId) as Array<{source_id:string}>;
    const insert=db.prepare(`INSERT OR IGNORE INTO memory_relation_edges(relation_id,from_memory_id,to_memory_id,relation_type,score,owner_scope_key,embedding_model,embedding_adapter,embedding_model_sha256,created_at)
      VALUES(?,?,?,'supersedes',NULL,?,?,?,?,?)`);
    let written=0;
    for(const link of links){
      const old=db.prepare(select).get(link.source_id) as BoundRow|undefined;
      if(!old || !owned(old) || !old.content || !old.superseded_at || old.scope!==current.scope
        || !sameMemoryActor(old.actor_id ?? old.agent_id,current.actor_id ?? current.agent_id)
        || memoryAudienceKey(old.id)!==audience || canonicalApplicabilityKey(old.applicability_json)!==application
        || !memoryAuthorityOwnerKeys(source(old)).some(key=>ownerKeys.includes(key)))continue;
      written+=insert.run(`mre_${randomUUID()}`,current.id,old.id,scopeKey,current.embedding_model,current.embedding_adapter,current.embedding_model_sha256,new Date().toISOString()).changes;
    }
    return written;
  }).immediate();
}

/** Resolve an explicit recalled block under the final owner; never guess by similarity. */
export function supersedeExplicitMemory(entry: Pick<MemoryEntry, "id">, blockKey: string): string | null {
  if (!/^h:[0-9a-f]{16}$/.test(blockKey)) return null;
  const ownerKeys = (value: Parameters<typeof memoryOwnerKey>[0]) => memoryAuthorityOwnerKeys({
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
    const authority = ownerKeys(successor);
    const binding=(id:string)=>getDb().prepare("SELECT owner_namespace,applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(id) as {owner_namespace:string;applicability_json:string}|undefined;
    const currentOwner=getMemoryStoreInfo().ownerNamespace;
    const isOwned=(row:ReturnType<typeof binding>)=>row?.owner_namespace?row.owner_namespace===currentOwner:currentOwner.startsWith("device-local:");
    const declaredAudience=(row:ReturnType<typeof binding>)=>{try {return canonicalApplicabilityKey(JSON.stringify(JSON.parse(row?.applicability_json ?? "{}").audience ?? null));}catch{return null;}};
    const currentBinding=binding(entry.id);if(!isOwned(currentBinding))return null;
    const declared=declaredAudience(currentBinding);if(declared===null)return null;
    const audience = memoryAudienceKey(entry.id);
    if (!audience) return null;
    const actorIds=memoryActorIds(current.agent_id);
    const rows = getDb().prepare(`SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, evidence_json
      FROM memory_entries WHERE superseded_at IS NULL AND id <> ?
        AND (scope = ? OR (? IN ('team_memory','agent_team') AND scope IN ('team_memory','agent_team')))
        AND (scope != 'agent_repo' OR agent_id IN (${actorIds.map(()=>"?").join(",")}) OR (agent_id IS NULL AND ? IS NULL))`)
      .all(entry.id, current.scope, current.scope, ...actorIds,current.agent_id) as Array<{
        id: string; scope: MemoryEntry["scope"]; kind: MemoryEntry["kind"]; content: string;
        project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null;
        evidence_json: string;
      }>;
    const owned = rows.filter((row) => isOwned(binding(row.id)) && declaredAudience(binding(row.id))===declared && memoryAudienceKey(row.id) === audience && ownerKeys({
      scope: row.scope, projectId: row.project_id, projectPath: row.project_path,
      agentId: row.agent_id, chatId: row.chat_id,
    }).some(key=>authority.includes(key)));
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
  }).immediate();
}

/** Read-only projection filter. Unmarked legacy/manual lines are never guessed. */
export function filterSupersededProjectSoul(soul: string, projectId?: string | null, projectPath?: string | null,
  selection?: { eligibleIds: ReadonlySet<string>; selectedIds: ReadonlySet<string> }): string {
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
      FROM memory_entries WHERE ${selection ? "" : "scope = 'project' AND "}id IN (${chunk.map(() => "?").join(",")})`)
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
    if (selection) {
      // Only host-marked, unchanged generated text is a canonical projection.
      // Unknown IDs cannot borrow another owner's source from the project file.
      if (!row) return [];
      if (row.kind === item.kind && sameContent && (row.superseded_at
        || !selection.eligibleIds.has(item.id) || selection.selectedIds.has(item.id))) return [];
    }
    if (sameOwner && row!.superseded_at && row!.kind === item.kind && sameContent) return [];
    // The host marker is projection metadata, not an identifier for the model.
    return [`- (${item.kind}) ${item.content}`];
  }).join("\n");
}

/**











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
