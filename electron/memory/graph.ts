// Local projection of durable memory relationships. Edges never create or move
// content; they only connect memories already admitted under one owner boundary.
import { createHash, randomUUID } from "node:crypto";
import { getMemoryStoreInfo, getMemoryDb as getDb } from "./database";
import { rankHybridLocal } from "./local-embedding";
import { holderOfEntry, lineHolders, listMemoryRelationCandidates, memoryAudienceKey, withHolderWriter, type LineHolder, type MemoryEntry } from "./store";
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

/** The closed set of `relation_type` (the table's CHECK; engine twin: memory_relations.RELATION_TYPES). `similar_to` is stored once per pair (smaller id first); `supersedes` goes from the newer line to
 * the older, `contradicts` from the line that was written to the one it disagrees with. 2.0 K1 makes `contradicts` writable and readable; nothing calls the writer yet (K2c and the merge do). */
export const MEMORY_RELATION_TYPES = ["similar_to", "supersedes", "contradicts"] as const;
export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

/**
 * The one validated, idempotent door to a relation edge (engine twin: memory_relations.write_edge). True when a row was added, false when that edge already existed. Does not commit (the caller's
 * transaction). Throws a machine code: relation_type_invalid · relation_same_line · relation_score_invalid · relation_owner_scope_missing · relation_line_missing.
 */
export function writeMemoryRelationEdge(from: string, to: string, type: MemoryRelationType, input: { ownerScopeKey: string | null; score?: number | null;
  embedding?: { model: string | null; adapter: string | null; modelSha256: string | null }; now?: string; db?: ReturnType<typeof getDb> }): boolean {
  if (!(MEMORY_RELATION_TYPES as readonly string[]).includes(type)) throw new Error("relation_type_invalid");
  if (!from || !to || from === to) throw new Error("relation_same_line");
  const score = input.score ?? null;
  if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < -1 || score > 1)) throw new Error("relation_score_invalid");
  if (!input.ownerScopeKey) throw new Error("relation_owner_scope_missing");
  const db = input.db ?? getDb();
  const pair = type === "similar_to" ? [from, to].sort() : [from, to];
  for (const id of pair) if (!db.prepare("SELECT 1 FROM memory_entries WHERE id=?").get(id)) throw new Error("relation_line_missing");
  return db.prepare(`INSERT OR IGNORE INTO memory_relation_edges(relation_id,from_memory_id,to_memory_id,relation_type,score,owner_scope_key,embedding_model,embedding_adapter,embedding_model_sha256,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`mre_${randomUUID()}`, pair[0], pair[1], type, score, input.ownerScopeKey, input.embedding?.model ?? null, input.embedding?.adapter ?? null,
    input.embedding?.modelSha256 ?? null, input.now ?? new Date().toISOString()).changes > 0;
}

/** `{line id: [the lines it contradicts or is contradicted by]}` for the live lines among `ids` (a superseded or forgotten line is not a counterpart). Reads only (engine twin: contradictions_of). */
export function memoryContradictionsOf(ids: Iterable<string>, db: ReturnType<typeof getDb> = getDb()): Map<string, string[]> {
  const list = [...new Set(ids)], found = new Map<string, string[]>(), wanted = new Set(list);
  for (let start = 0; start < list.length; start += 300) {
    const chunk = list.slice(start, start + 300), marks = chunk.map(() => "?").join(",");
    const rows = db.prepare(`SELECT e.from_memory_id AS a,e.to_memory_id AS b FROM memory_relation_edges e
      JOIN memory_entries x ON x.id=e.from_memory_id AND x.superseded_at IS NULL AND x.content<>''
      JOIN memory_entries y ON y.id=e.to_memory_id AND y.superseded_at IS NULL AND y.content<>''
      WHERE e.relation_type='contradicts' AND (e.from_memory_id IN (${marks}) OR e.to_memory_id IN (${marks}))`).all(...chunk, ...chunk) as Array<{ a: string; b: string }>;
    for (const { a, b } of rows) for (const [mine, other] of [[a, b], [b, a]] as const) {
      if (!wanted.has(mine)) continue;
      const current = found.get(mine) ?? [];
      if (!current.includes(other)) { current.push(other); found.set(mine, current); }
    }
  }
  return found;
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

/** The original wording of lines in ONE database (the root's twin table or the store's own: native-text.ts keeps the same table in both). Absent table = none. */
function nativesIn(db: ReturnType<typeof getDb>, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400);
    try { for (const row of db.prepare(`SELECT entry_id AS id, content_native AS text FROM memory_entry_native WHERE entry_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{ id: string; text: string }>) if (row.text) out.set(row.id, row.text); } catch { /* no twin table here */ }
  }
  return out;
}

type LiveRow = { id: string; scope: MemoryEntry["scope"]; kind: MemoryEntry["kind"]; content: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null; evidence_json: string };

/**
 * The live lines of ONE scope in ONE database, minus the ids that database still has to forget. Layout switch OFF (the root alone) this is the query this file always ran.
 * `scope` and the agent filter are the same for every database: a line of a store is found by the same words as a line of the root.
 */
function liveRowsOfScope(holder: LineHolder, scope: MemoryEntry["scope"], actors: readonly (string | null)[], agentId: string | null, exceptId: string | null): LiveRow[] {
  const rows = holder.db.prepare(`SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, evidence_json
    FROM memory_entries WHERE superseded_at IS NULL ${exceptId ? "AND id <> ?" : ""}
      AND (scope = ? OR (? IN ('team_memory','agent_team') AND scope IN ('team_memory','agent_team')))
      AND (scope != 'agent_repo' OR agent_id IN (${actors.map(() => "?").join(",")}) OR (agent_id IS NULL AND ? IS NULL))`)
    .all(...(exceptId ? [exceptId] : []), scope, scope, ...actors, agentId) as LiveRow[];
  return holder.withheld.size ? rows.filter(row => !holder.withheld.has(row.id)) : rows;
}

/**
 * Resolve an explicit recalled block under the final owner; never guess by similarity.
 * K3'-2a: with the layout switch on the successor (the line just written) may sit in an agent's or a project's own store and the line it replaces in another one (a lesson confirmed in two projects folds
 * the project lines into the agent line; a rewrite names a line of the same store). The line is looked for in the root and in the stores this scope reads, the audience is read from the database that holds
 * each line, and the older line is retired in the database that holds it. A `supersedes` edge needs both lines in one database (its foreign keys): across two databases the provenance is the origin link
 * of the successor (always in the successor's own database) and the retirement.
 */
export function supersedeExplicitMemory(entry: Pick<MemoryEntry, "id">, blockKey: string): string | null {
  if (!/^h:[0-9a-f]{16}$/.test(blockKey)) return null;
  const ownerKeys = (value: Parameters<typeof memoryOwnerKey>[0]) => memoryAuthorityOwnerKeys({
    ...value, scope: value.scope === "agent_team" ? "team_memory" : value.scope,
  });
  const home = holderOfEntry(entry.id);
  if (!home) return null;
  const rootHome = home.ref === null;
  const decide = (): { old: LiveRow; oldHolder: LineHolder; ownerScopeKey: string; embedding: { model: string | null; adapter: string | null; sha: string | null } } | null => {
    const current = home.db.prepare(`SELECT scope, kind, content, project_id, project_path, agent_id, chat_id,
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
      const native = (rootHome ? nativeTextsFor("memory_entry", [entry.id]) : nativesIn(home.db, [entry.id])).get(entry.id);
      if (native) assertMemoryWriteAllowed({ ...successor, kind: current.kind, content: native });
    } catch (error) {
      if (error instanceof MemoryRevokedError) return null;
      throw error;
    }
    const authority = ownerKeys(successor);
    const binding=(db: ReturnType<typeof getDb>, id:string)=>db.prepare("SELECT owner_namespace,applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(id) as {owner_namespace:string;applicability_json:string}|undefined;
    const currentOwner=getMemoryStoreInfo().ownerNamespace;
    const isOwned=(row:ReturnType<typeof binding>)=>row?.owner_namespace?row.owner_namespace===currentOwner:currentOwner.startsWith("device-local:");
    const declaredAudience=(row:ReturnType<typeof binding>)=>{try {return canonicalApplicabilityKey(JSON.stringify(JSON.parse(row?.applicability_json ?? "{}").audience ?? null));}catch{return null;}};
    const currentBinding=binding(home.db, entry.id);if(!isOwned(currentBinding))return null;
    const declared=declaredAudience(currentBinding);if(declared===null)return null;
    const audience = memoryAudienceKey(entry.id, home.db);
    if (!audience) return null;
    const actorIds=memoryActorIds(current.agent_id);
    const matches: Array<{ row: LiveRow; holder: LineHolder }> = [];
    for (const holder of lineHolders({ agentId: current.agent_id, projectId: current.project_id, projectPath: current.project_path })) {
      const rows = liveRowsOfScope(holder, current.scope, actorIds, current.agent_id, entry.id);
      const owned = rows.filter((row) => isOwned(binding(holder.db, row.id)) && declaredAudience(binding(holder.db, row.id))===declared && memoryAudienceKey(row.id, holder.db) === audience && ownerKeys({
        scope: row.scope, projectId: row.project_id, projectPath: row.project_path,
        agentId: row.agent_id, chatId: row.chat_id,
      }).some(key=>authority.includes(key)));
      const natives = holder.ref === null ? nativeTextsFor("memory_entry", owned.map((row) => row.id)) : nativesIn(holder.db, owned.map((row) => row.id));
      for (const row of owned) {
        let hit = memoryBlockKey(row.content) === blockKey;
        const native = natives.get(row.id);
        if (!hit && native && memoryBlockKey(native) === blockKey) hit = true;
        // Imported One blocks keep their exact source key across translation.
        if (!hit) { try { const refs: unknown = JSON.parse(row.evidence_json); hit = Array.isArray(refs) && refs.includes(`one-soul:${blockKey.slice(2)}`); } catch { hit = false; } }
        if (hit && !matches.some(match => match.row.id === row.id)) matches.push({ row, holder });
      }
    }
    // Truncated hash collisions and duplicate identities are ambiguous, never authority.
    if (matches.length !== 1) return null;
    return { old: matches[0].row, oldHolder: matches[0].holder, ownerScopeKey, embedding: { model: current.embedding_model, adapter: current.embedding_adapter, sha: current.embedding_model_sha256 } };
  };
  const now = new Date().toISOString();
  const insertEdge = (db: ReturnType<typeof getDb>, d: NonNullable<ReturnType<typeof decide>>) => db.prepare(`INSERT OR IGNORE INTO memory_relation_edges (
      relation_id, from_memory_id, to_memory_id, relation_type, score,
      owner_scope_key, embedding_model, embedding_adapter, embedding_model_sha256, created_at
    ) VALUES (?, ?, ?, 'supersedes', NULL, ?, ?, ?, ?, ?)`).run(
    `mre_${randomUUID()}`, entry.id, d.old.id, d.ownerScopeKey, d.embedding.model, d.embedding.adapter, d.embedding.sha, now);
  if (rootHome) {
    // The successor is in the root. The older line is in the root too (the transaction this function always made) or in a store (retired there after the root's own part is stored).
    let crossStore: { old: LiveRow; oldHolder: LineHolder } | null = null;
    const done = getDb().transaction((): string | null => {
      const d = decide();
      if (!d) return null;
      if (d.oldHolder.ref !== null) { crossStore = { old: d.old, oldHolder: d.oldHolder }; recordSupersededProvenance(entry.id, [d.old.id]); return d.old.id; }
      insertEdge(getDb(), d);
      getDb().prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL").run(now, d.old.id);
      recordSupersededProvenance(entry.id, [d.old.id]);
      return d.old.id;
    }).immediate();
    if (crossStore) {
      const target = crossStore as { old: LiveRow; oldHolder: LineHolder };
      const retired = withHolderWriter(target.oldHolder, (db) => db.prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL").run(now, target.old.id).changes);
      if (!retired.ok) return null; // the store could not be written (noted by code): the same ticket repeated retries the replacement
    }
    return done;
  }
  // The successor is in a store: the store's own part (edge when the older line is in the same store, origin link) in one write connection, then the older line is retired where it is.
  const d = decide();
  if (!d) return null;
  const sameStore = d.oldHolder.ref !== null && d.oldHolder.ref.path === home.ref!.path;
  const stored = withHolderWriter(home, (db) => db.transaction(() => {
    if (sameStore) {
      insertEdge(db, d);
      db.prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL").run(now, d.old.id);
    }
    recordSupersededProvenance(entry.id, [d.old.id], db);
  }).immediate());
  if (!stored.ok) return null;
  if (!sameStore) {
    const retired = withHolderWriter(d.oldHolder, (db) => db.transaction(() => db.prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL").run(now, d.old.id).changes).immediate());
    if (!retired.ok) return null;
  }
  return d.old.id;
}

/**
 * the live line an explicit replacement (`supersedes`, the recalled block key) would retire, found BEFORE the new line is written so the write can
 * judge the replacement (similar enough? same scope and corrected kind?) and so a store at its ceiling can tell a replacement from a new line. Read-only
 * and only a hint: `supersedeExplicitMemory` still decides under the full audience/owner checks after the write. `null` = no single owned line carries
 * that key (nothing to judge: the write follows the old path). K3'-2a: the root and the stores this scope reads (a line of an agent's or a project's own store is found the same way).
 */
export function peekExplicitSupersedeTarget(
  candidate: { scope: MemoryEntry["scope"]; projectId?: string | null; projectPath?: string | null; agentId?: string | null; chatId?: string | null },
  blockKey: string,
): { id: string; scope: MemoryEntry["scope"]; kind: MemoryEntry["kind"]; content: string } | null {
  if (!/^h:[0-9a-f]{16}$/.test(blockKey)) return null;
  try {
    const scope = candidate.scope === "agent_team" ? "team_memory" : candidate.scope;
    const authority = memoryAuthorityOwnerKeys({ scope, projectId: candidate.projectId, projectPath: candidate.projectPath, agentId: candidate.agentId, chatId: candidate.chatId });
    const actors = memoryActorIds(candidate.agentId ?? null);
    const found: LiveRow[] = [];
    for (const holder of lineHolders({ agentId: candidate.agentId ?? null, projectId: candidate.projectId ?? null, projectPath: candidate.projectPath ?? null })) {
      const rows = liveRowsOfScope(holder, scope, actors, candidate.agentId ?? null, null);
      const owned = rows.filter(row => memoryAuthorityOwnerKeys({ scope: row.scope, projectId: row.project_id, projectPath: row.project_path, agentId: row.agent_id, chatId: row.chat_id })
        .some(key => authority.includes(key)));
      const natives = holder.ref === null ? nativeTextsFor("memory_entry", owned.map(row => row.id)) : nativesIn(holder.db, owned.map(row => row.id));
      for (const row of owned) {
        let hit = memoryBlockKey(row.content) === blockKey;
        const native = natives.get(row.id);
        if (!hit && native && memoryBlockKey(native) === blockKey) hit = true;
        if (!hit) { try { const refs: unknown = JSON.parse(row.evidence_json); hit = Array.isArray(refs) && refs.includes(`one-soul:${blockKey.slice(2)}`); } catch { hit = false; } }
        if (hit && !found.some(item => item.id === row.id)) found.push(row);
      }
    }
    return found.length === 1 ? { id: found[0].id, scope: found[0].scope, kind: found[0].kind, content: found[0].content } : null;
  } catch { return null; }
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
  // K3'-2b: the older lines are looked for - and retired - in the database that holds the NEW line: the root (always, with the layout switch off), or the agent's / project's own store file when the 2.0 layout is on.
  // Two stores never replace each other's lines (a line of another store belongs to another owner of the file), and the `supersedes` edge needs both lines in one database (its foreign keys). A line the lookup cannot place
  // is looked for in the root as before.
  const home = holderOfEntry(entry.id) ?? { db: getDb(), ref: null, withheld: new Set<string>() } as LineHolder;
  const candidates = listMemoryRelationCandidates(entry, undefined, home.db)
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
  const apply = (db: ReturnType<typeof getDb>): string[] => {
    const edge = db.prepare(
      `INSERT OR IGNORE INTO memory_relation_edges (
         relation_id, from_memory_id, to_memory_id, relation_type, score,
         owner_scope_key, embedding_model, embedding_adapter,
         embedding_model_sha256, created_at
       ) VALUES (?, ?, ?, 'supersedes', ?, ?, ?, ?, ?, ?)`,
    );
    const retire = db.prepare(
      "UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL",
    );
    const superseded: string[] = [];
    db.transaction(() => {
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
      recordSupersededProvenance(entry.id, restated.map((result) => result.item.candidate.id), db);
    })();
    return superseded;
  };
  if (home.ref === null) return apply(getDb());
  // A store that cannot be written is left as it is (withHolderWriter notes the code): the older lines stay live, and the next write of a restatement tries again.
  const written = withHolderWriter(home, apply);
  return written.ok ? written.value : [];
}

/**
 * The older row keeps its own run/ticket origins; the replacement points at it so the runs the lesson came back from
 * stay countable (agents/learning-evidence.ts follows `memory`/`supersedes` links). Same link shape as an owner edit.
 */
function recordSupersededProvenance(successorId: string, oldIds: readonly string[], db: ReturnType<typeof getDb> = getDb()): void {
  const link = db.prepare(
    "INSERT OR IGNORE INTO memory_origin_links(memory_id, source_kind, source_id, source_revision, relation) VALUES (?, 'memory', ?, '', 'supersedes')",
  );
  for (const oldId of oldIds) link.run(successorId, oldId);
}
