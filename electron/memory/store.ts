// Durable memory store (memory_entries table). The Memory Curator owns writes here.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type BetterDatabase from "better-sqlite3";
import { allowsOrdinaryMemoryRecall, type MemoryRecallScope, type MemoryRecallPolicyRow } from "./recall-policy";
import { memoryActorIds, sameMemoryActor } from "../../shared/memory-actor-family";
import { getMemoryDb as getDb, getMemoryStoreInfo, memoryRoot } from "./database";
import { agentRef, findAgentHome, layoutOf, listExistingStores, mergeRows, openStore, projectKeys, projectRef, rootClock, storeAgentId, readAgentOwnRows, readUnionRows, readsUnion, openSetFor, storeSkips, unionFingerprint, type StoreRef, type StoreSkip } from "./stores";
import { readSet, setFingerprint } from "./store-set";
import { NATIVE_TABLE_DDL, noteWriteDegrade, openStoreForWrite, storeForRow, writeDegrades } from "./store-write";
import { forgetOpenCodes, recheckForgetCodes } from "./forget-stores";
import { projectForgetPendingCodes } from "./store-delete";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import {
  autoLocalEmbedding,
  parseLocalEmbedding,
  type LocalMemoryEmbedding,
} from "./local-embedding";
import { MemoryRevokedError, assertMemoryWriteAllowed } from "./revocations";
import { ensureNativeTextTables, isNonEnglishText, nativeTextsFor, rememberSubStoreNatives } from "./native-text";
import { FORGOTTEN_IMPORT_SOURCE } from "./import-source-receipt";
import { firstRunOpenCodes } from "../migration/gate";
import { equivalentMemoryKinds } from "./classification";
import { recallReasonOfError, type RecallReadReason } from "./recall-contract";
import { coerceOriginClass, stampOrigin, type Certainty, type OriginClass } from "./origin-class";

export interface RequestContext {
  userIntent?: string;
  triggerTerms?: string[];
  cwdAtRequest?: string | null;
  targetProject?: string | null;
  targetPath?: string | null;
  crossContext?: boolean;
  outcome?: string | null;
  /** K2b': the kind the model gave a Personal ticket (`identity` or `boundary`) before the computer folded it into `fact`/`preference` (ruleset ticket.fold). Written only when folded; read for display and for condensing within one kind. */
  ticket_kind?: string;
  /** the structure of a `boundary` line - `no_proactive` (never message first) or `quiet_hours` (no first message from `from` to `to`, HH:MM). Every place's first-word gate reads it. */
  boundary?: { type: "no_proactive" | "quiet_hours"; from?: string; to?: string };
  /** the line's words rest on the owner's own words (a quote found in what they typed). The sync sends it as the line's `grounded` mark; a line without it is `grounded` when its origin is the owner's. */
  grounded?: boolean;
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
  /** where the line came from and how far it is verified (two closed columns, K1). Present only on a line that carries them: an older line has neither key and reads as before. */
  originClass?: OriginClass;
  certainty?: Certainty;
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
  origin_class?: string | null;
  certainty?: string | null;
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
      ...(typeof raw.ticket_kind === "string" ? { ticket_kind: raw.ticket_kind } : {}),
      ...(raw.boundary && typeof raw.boundary === "object" ? { boundary: raw.boundary as RequestContext["boundary"] } : {}),
      ...(typeof raw.grounded === "boolean" ? { grounded: raw.grounded } : {}),
    };
  } catch {
    return null;
  }
}

const UNSTORED_EMBEDDING_CAP = 2_000;
const unstoredEmbeddings = new Map<string, { text: string; embedding: ReturnType<typeof autoLocalEmbedding> }>();
function rememberUnstoredEmbedding(id: string, text: string, embedding: ReturnType<typeof autoLocalEmbedding>): void {
  unstoredEmbeddings.delete(id); unstoredEmbeddings.set(id, { text, embedding });
  while (unstoredEmbeddings.size > UNSTORED_EMBEDDING_CAP) unstoredEmbeddings.delete(unstoredEmbeddings.keys().next().value as string);
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
    const remembered = unstoredEmbeddings.get(r.id);
    const known = remembered !== undefined && remembered.text === r.content;
    embedding = known ? remembered.embedding : autoLocalEmbedding(r.content);
    // Backward-compatible lazy backfill: old stores open without an O(n)
    // migration pause, then each governed row is upgraded as it is read.
    if (!known) try {
      const filled = getDb().prepare(
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
      // 0 rows changed = the row is not in the root (it lives in another store, which is opened read-only here): there is nowhere to save the vector, so keep it for the
      // next read instead of computing it again on every read (#14). Bounded; nothing changes while every row is in the root.
      if (filled.changes === 0) rememberUnstoredEmbedding(r.id, r.content, embedding);
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
    ...(coerceOriginClass(r.origin_class) ? { originClass: coerceOriginClass(r.origin_class)! } : {}),
    ...(r.certainty === "self_reported" || r.certainty === "run_verified" || r.certainty === "unverified" ? { certainty: r.certainty } : {}),
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
  /** the owner said these words again (a quote of their own words, a run after the stamp) - lets a Personal line past a forget stamp of the same words. Set by the curator only. */
  restatedByOwner?: boolean;
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
  /** the two host-decided values of the line (origin-class.ts). Written with the row; absent = the columns stay empty, as for every older line. */
  originClass?: OriginClass;
  certainty?: Certainty;
  /**
   * (§12-5): the line ceiling of the store this row is written to. Counted ONCE, inside the write transaction, immediately before the row is
   * written (never per turn). At the ceiling only a line that replaces an older one (`replace`) is written; any other new line is refused with
   * `MemoryStoreFullError` (not tried again). Code never retires a line to make room. Absent = no ceiling (imports, tests, every other writer).
   */
  ceiling?: { rows: number; reason?: string; replace?: boolean; countsFrom?: string | null; klass?: PersonalCeilingClass };
}

export type PersonalCeilingClass = "own" | "shared";
/** Which Personal ceiling a new line is counted against: `own` = a `preference` the place keeps for itself, `shared` = a `fact`, or an `identity` / `boundary` the model gave (the sync shares those: shared-memory-sync.ts `sharedKindOf`). */
export function personalCeilingClassOf(kind: string, ticketKind: string | null | undefined, hasBoundary: boolean): PersonalCeilingClass {
  if (ticketKind === "identity") return "shared";
  if (ticketKind === "boundary" && hasBoundary) return "shared";
  return kind === "fact" ? "shared" : "own";
}
const CEIL_TICKET = "COALESCE(CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.ticket_kind') END,'')";
const CEIL_HAS_BOUNDARY = "COALESCE(CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.boundary') END IS NOT NULL,0)";
const CEIL_SHARED_KIND = `(kind='fact' OR ${CEIL_TICKET}='identity' OR (${CEIL_TICKET}='boundary' AND ${CEIL_HAS_BOUNDARY}))`;
function personalClassSql(klass: PersonalCeilingClass): string {
  const fromServer = "COALESCE(evidence_json,'') LIKE '%hope-server-fact%'";
  return klass === "own" ? `NOT ${CEIL_SHARED_KIND} AND NOT ${fromServer}` : `${CEIL_SHARED_KIND} AND NOT ${fromServer}`;
}

/** A new line was refused because its store holds its ceiling of live lines (`stores.ceiling.reason`, normally `store_full`). Not retried. */
export class MemoryStoreFullError extends Error {
  constructor(readonly reason: string, readonly rows: number) {
    super(reason);
    this.name = "MemoryStoreFullError";
  }
}

/** ` AND <a line somebody can read>`: not a line of the old One overlay channel, not one the owner switched off. The ceiling counts these lines and the shared-memory sync sends only these (`memory_entries` unaliased). */
export function readableLinesClause(db: BetterDatabase.Database): string {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_identity_bindings'").get()
    ? ` AND NOT EXISTS(SELECT 1 FROM memory_identity_bindings b WHERE b.memory_id=memory_entries.id
        AND (json_extract(b.applicability_json,'$.recallChannel')='legacy_one_overlay' OR json_extract(b.applicability_json,'$.enabled')=0))` : "";
}

/**
 * Live lines of the store `e` is written into, counted in the caller's transaction. A line is live until it is superseded, and it counts only if somebody can read it: a line of the
 * old One overlay channel or one the owner switched off is not a line of this store (#1: 2,460 counted lines held the personal agent's store "full" for ever).
 */
function liveLinesFor(db: BetterDatabase.Database, e: NewMemoryEntry): number {
  const countsFrom = e.ceiling?.countsFrom ?? null;
  const readable = readableLinesClause(db)
    + (countsFrom ? ` AND created_at >= '${countsFrom}'` : "")
    // (the engine's memory_runtime does the same): a line the first-run migration moved (origin link `reclassified` / `from`) is not counted towards the store it moved into.
    + (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_origin_links'").get()
      ? ` AND memory_entries.id NOT IN (SELECT memory_id FROM memory_origin_links WHERE source_kind='reclassified' AND relation='from')` : "");
  if (e.scope === "agent_repo") {
    const actors = memoryActorIds(e.agentId ?? null);
    return (db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE scope='agent_repo' AND superseded_at IS NULL AND agent_id IN (${actors.map(() => "?").join(",")})${readable}`)
      .get(...actors) as { n: number }).n;
  }
  if (e.scope === "project") {
    return (db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE scope='project' AND superseded_at IS NULL
      AND ((project_id IS NOT NULL AND project_id = ?) OR (project_path IS NOT NULL AND project_path = ?))${readable}`).get(e.projectId ?? null, e.projectPath ?? null) as { n: number }).n;
  }
  // the Personal ceiling is counted twice, never together - this place's own `preference` lines on one side, the lines that are (or will be) the person's SHARED set on the other.
  // A line the server gave (source tag) is the shared set's and is counted there by the server, never here.
  const klass = e.scope === "user_identity" && e.ceiling?.klass ? ` AND ${personalClassSql(e.ceiling.klass)}` : "";
  return (db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE scope = ? AND superseded_at IS NULL${readable}${klass}`).get(e.scope) as { n: number }).n;
}

function enforceCeiling(db: BetterDatabase.Database, e: NewMemoryEntry): void {
  const ceiling = e.ceiling;
  if (!ceiling || ceiling.replace === true) return;
  const rows = liveLinesFor(db, e);
  if (rows >= ceiling.rows) throw new MemoryStoreFullError(ceiling.reason ?? "store_full", rows);
}

export function insertMemoryEntry(e: NewMemoryEntry): MemoryEntry {
  return insertMemoryEntryInternal(e)!;
}

/** A host-supplied, stable source identity. A duplicate never re-runs post-commit projections. */
export function insertMemoryEntryOnce(e: NewMemoryEntry, source: { key: string; digest: string; ownerNamespace: string }): MemoryEntry | null {
  return insertMemoryEntryInternal(e, source);
}

function insertMemoryEntryInternal(e: NewMemoryEntry, source?: { key: string; digest: string; ownerNamespace: string }): MemoryEntry | null {
  // with the layout switch ON a row goes to the store that owns it (one function decides, store-write.ts storeForRow). With the switch OFF — every
  // device today — this is one meta read and the code below runs exactly as before.
  const routed = routeNewRow(e);
  if (routed && "skip" in routed) return source ? null : unwrittenEntry(e);
  if (routed) {
    const written = insertIntoSubStore(e, source, routed.ref);
    if (written !== ROOT_FALLBACK) return written;
  }
  // Avoid computing an embedding for the common duplicate case. The first
  // lookup is only a hint: validate both the owner and receipt atomically.
  if (source && getDb().prepare("SELECT 1 FROM memory_store_meta WHERE key = ?").get(source.key)) {
    const duplicate = getDb().transaction(() => {
      if (getMemoryStoreInfo().ownerNamespace !== source.ownerNamespace) throw new Error("memory_import_owner_changed");
      const prior = getDb().prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(source.key) as { value: string } | undefined;
      if (!prior) return false;
      if (prior.value !== FORGOTTEN_IMPORT_SOURCE && prior.value !== source.digest) throw new Error("memory_import_source_conflict");
      return true;
    });
    if (duplicate.immediate()) return null;
  }
  const id = randomUUID();
  let now = "";
  const embedding = autoLocalEmbedding(e.content);
  const insert = getDb().transaction(() => {
    if (source) {
      if (getMemoryStoreInfo().ownerNamespace !== source.ownerNamespace) throw new Error("memory_import_owner_changed");
      const prior = getDb().prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(source.key) as { value: string } | undefined;
      if (prior) {
        if (prior.value !== FORGOTTEN_IMPORT_SOURCE && prior.value !== source.digest) throw new Error("memory_import_source_conflict");
        return false;
      }
    }
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
      ...(e.restatedByOwner === true ? { restatedByOwner: true } : {}),
    };
    assertMemoryWriteAllowed(authority);
    const native = e.contentNative?.trim().slice(0, 4_000);
    if (native && native !== e.content.trim()) {
      // Forget tombstones both wordings. A new English rendering must not
      // restore the same revoked original under this owner/run authority.
      assertMemoryWriteAllowed({ ...authority, content: native });
    }
    enforceCeiling(getDb(), e);
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
    stampOrigin(getDb(), id, e);
    bindMemoryIdentity(id, e, now);
    if (native && native !== e.content.trim()) {
      ensureMemoryNativeTable();
      getDb().prepare(
        "INSERT OR REPLACE INTO memory_entry_native (entry_id, content_native, created_at) VALUES (?, ?, ?)",
      ).run(id, native, now);
    }
    if (source) getDb().prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(source.key, source.digest);
    return true;
  });
  if (!insert.immediate()) return null;
  // K3': no translation queue any more. A line without its original wording is left as it is (recall reads both channels); the resting-time gathering gives a line its English next to the person's own words
  // whenever it rewrites or condenses that line (the ticket carries both: gathering.ts).
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

// --- 쓰기 라우팅 (스위치 `memory_layout = split-1` 일 때만) ------------------------------------------------------------------

const ROOT_FALLBACK = Symbol("root-fallback");
type SourceReceipt = { key: string; digest: string; ownerNamespace: string };

/**
 * 새 행이 뿌리 밖으로 가야 하면 그 저장소, 호출 전용 허브 에이전트의 행이면 `{skip}`, 아니면 null(= 뿌리, 옛 길).
 * 스위치가 `split` 이 아니면 뿌리 메타를 한 번 읽고 null. 던지지 않는다.
 */
function routeNewRow(e: NewMemoryEntry): { ref: StoreRef } | { skip: true } | null {
  try {
    const root = getDb();
    const layout = layoutOf(root);
    if (layout !== "split") return null;
    // 엔진 canonical_writer 와 같다: 허브에서 부른 에이전트는 어떤 저장소에도 기억을 남기지 않는다.
    if (typeof e.agentId === "string" && e.agentId.trim().toLowerCase().startsWith("hub:")) return { skip: true };
    const owner = getMemoryStoreInfo().ownerNamespace;
    const routed = storeForRow({ memoryRoot: memoryRoot(), owner, layout }, { scope: e.scope, agentId: e.agentId, projectId: e.projectId, projectPath: e.projectPath, chatId: e.chatId },
      e.projectId ?? null); // 대화 id 는 저장소 키가 아니다: 프로젝트 id 가 없으면 폴더 키만 쓴다(감사 40 #3)
    if (routed.store.kind === "personal") return null;
    // 번역기는 뿌리만 읽는다 — 번역을 기다리는 행은 뿌리에 쓰고 엔진 이사가 번역 뒤에 옮긴다(엔진 `scan` 의 translation_pending 과 같다).
    if (!e.contentNative?.trim() && isNonEnglishText(e.content)) return null;
    return { ref: routed.store };
  } catch { return null; }
}

/** Audit 62 (memory B8): whether a line written now would go to another store (layout switch on and a store of its own for that agent or project). The owner's edit asks this before it writes anything: the replacement cannot be linked into a store the edit does not hold. */
export function newRowLeavesRoot(e: Pick<NewMemoryEntry, "scope" | "kind" | "content" | "agentId" | "projectId" | "projectPath" | "chatId" | "contentNative">): boolean {
  const routed = routeNewRow(e as NewMemoryEntry);
  return Boolean(routed && "ref" in routed);
}

/** 허브 에이전트의 행은 쓰지 않는다. 호출부(큐레이터)가 `entry.id` 를 결정 기록에 적어도 깨지지 않게 저장되지 않았다는 표시가 달린 값을 돌려준다. */
function unwrittenEntry(e: NewMemoryEntry): MemoryEntry {
  return { id: `unwritten:${randomUUID()}`, scope: e.scope, kind: e.kind, content: e.content, projectId: e.projectId ?? null, projectPath: e.projectPath ?? null, agentId: e.agentId ?? null,
    chatId: e.chatId ?? null, confidence: e.confidence ?? "medium", sensitivity: e.sensitivity ?? "internal", evidence: e.evidence ?? [], requestContext: e.requestContext ?? null,
    embedding: autoLocalEmbedding(e.content), supersededAt: null, createdAt: new Date().toISOString() };
}

function authorityOf(e: NewMemoryEntry) {
  return { scope: e.scope, kind: e.kind, content: e.content, projectId: e.projectId, projectPath: e.projectPath, agentId: e.agentId, chatId: e.chatId, intakeRunId: e.intakeRunId, intakeEpoch: e.intakeEpoch };
}

/**
 * 하위 저장소에 한 행을 쓴다. 순서: (1) 뿌리 한 트랜잭션에서 영수증·철회 검사와 단조 시각 (2) 하위 저장소 한 트랜잭션에서 행+신원 묶음+출처 링크(+원문)
 * (3) 뿌리에 영수증. (2) 와 (3) 사이에서 죽으면 행은 있고 영수증이 없다 — 재시도는 하위 저장소의 같은 출처 키로 중복을 알아보고 영수증만 채운다.
 * 하위 저장소를 못 열면 사유를 남기고 `ROOT_FALLBACK`(부르는 쪽이 뿌리에 쓴다).
 */
function insertIntoSubStore(e: NewMemoryEntry, source: SourceReceipt | undefined, ref: StoreRef): MemoryEntry | null | typeof ROOT_FALLBACK {
  const root = getDb();
  const owner = getMemoryStoreInfo().ownerNamespace;
  if (source && root.prepare("SELECT 1 FROM memory_store_meta WHERE key = ?").get(source.key)) {
    const duplicate = root.transaction(() => {
      if (getMemoryStoreInfo().ownerNamespace !== source.ownerNamespace) throw new Error("memory_import_owner_changed");
      const prior = root.prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(source.key) as { value: string } | undefined;
      if (!prior) return false;
      if (prior.value !== FORGOTTEN_IMPORT_SOURCE && prior.value !== source.digest) throw new Error("memory_import_source_conflict");
      return true;
    });
    if (duplicate.immediate()) return null;
  }
  const opened = openStoreForWrite(ref, owner, root, memoryRoot());
  if (!opened.store) { noteWriteDegrade(ref, opened.code ?? "store_unwritable"); return ROOT_FALLBACK; }
  const sub = opened.store.db;
  const id = randomUUID();
  const embedding = autoLocalEmbedding(e.content);
  const authority = authorityOf(e);
  const native = e.contentNative?.trim().slice(0, 4_000);
  const hasNative = Boolean(native && native !== e.content.trim());
  const check = () => { assertMemoryWriteAllowed(authority); if (hasNative) assertMemoryWriteAllowed({ ...authority, content: native! }); };
  try {
    const gate = root.transaction((): { now: string } | null => {
      if (source) {
        if (getMemoryStoreInfo().ownerNamespace !== source.ownerNamespace) throw new Error("memory_import_owner_changed");
        const prior = root.prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(source.key) as { value: string } | undefined;
        if (prior) {
          if (prior.value !== FORGOTTEN_IMPORT_SOURCE && prior.value !== source.digest) throw new Error("memory_import_source_conflict");
          return null;
        }
      }
      check();
      return { now: nextMemoryCreatedAt(root) };
    }).immediate();
    if (!gate) return null;
    const now = gate.now;
    const stored = sub.transaction((): boolean => {
      if (source) {
        const seen = sub.prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(source.key) as { value: string } | undefined;
        if (seen) { if (seen.value !== source.digest) throw new Error("memory_import_source_conflict"); return false; }
      }
      check(); // the root forget clock may have moved since the gate; this is the same refusal, read again under the store's write lock
      enforceCeiling(sub, e);
      sub.prepare(
        `INSERT INTO memory_entries
         (id, scope, kind, content, project_id, project_path, agent_id, chat_id,
          confidence, sensitivity, evidence_json, context_json,
          embedding_model, embedding_adapter, embedding_model_sha256, embedding_content_hash,
          embedding_dimensions, embedding_json,
          superseded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(id, e.scope, e.kind, e.content, e.projectId ?? null, e.projectPath ?? null, e.agentId ?? null, e.chatId ?? null, e.confidence ?? "medium", e.sensitivity ?? "internal",
        JSON.stringify(e.evidence ?? []), JSON.stringify(e.requestContext ?? {}), embedding.model, embedding.adapter, embedding.modelSha256, embedding.contentHash,
        embedding.dimensions, JSON.stringify(embedding.vector), now);
      stampOrigin(sub, id, e);
      bindMemoryIdentity(id, e, now, { db: sub, ownerNamespace: owner });
      if (hasNative) {
        sub.exec(NATIVE_TABLE_DDL);
        sub.prepare("INSERT OR REPLACE INTO memory_entry_native (entry_id, content_native, created_at) VALUES (?, ?, ?)").run(id, native, now);
      }
      if (source) sub.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(source.key, source.digest);
      return true;
    }).immediate();
    // The row is committed. A receipt that cannot be written now is not an error: the store's own copy of the source key makes the retry a duplicate that only fills it in.
    if (source) { try { root.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)").run(source.key, source.digest); } catch { /* retried by the same source key */ } }
    if (!stored) return null;
    return { id, scope: e.scope, kind: e.kind, content: e.content, projectId: e.projectId ?? null, projectPath: e.projectPath ?? null, agentId: e.agentId ?? null, chatId: e.chatId ?? null,
      confidence: e.confidence ?? "medium", sensitivity: e.sensitivity ?? "internal", evidence: e.evidence ?? [], requestContext: e.requestContext ?? null, embedding, supersededAt: null, createdAt: now };
  } catch (error) {
    if (error instanceof MemoryRevokedError || error instanceof MemoryStoreFullError || (error instanceof Error && error.message.startsWith("memory_import_"))) throw error;
    // 하위 저장소가 쓰는 도중 실패(디스크 가득·잠금)했다: 던지지 않고 뿌리에 쓴다. 이미 커밋된 쪽은 없다(하위 트랜잭션이 되돌려졌다).
    noteWriteDegrade(ref, error instanceof Error && /full|SQLITE_FULL/i.test(error.message) ? "disk_full" : /busy|locked/i.test(String(error)) ? "store_locked" : "store_unwritable");
    return ROOT_FALLBACK;
  } finally { try { sub.close(); } catch { /* 닫힘 */ } }
}

/** The scope remains the reader's authority; graph origin never widens it.
 * `target` is another store's connection: the outbox is the root's own queue and has no table there, so it is written for the root only. */
function bindMemoryIdentity(id: string, entry: NewMemoryEntry, now: string, target?: { db: BetterDatabase.Database; ownerNamespace: string }): void {
  const db = target?.db ?? getDb();
  const store = target ? { ownerNamespace: target.ownerNamespace, revision: 0 } : getMemoryStoreInfo();
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
  if (target) return;
  db.prepare(`INSERT OR IGNORE INTO memory_projection_outbox(outbox_id,memory_id,authority_revision,state,payload_json,created_at,updated_at)
    VALUES(?,?,?,'queued','{}',?,?)`).run(`memory:${id}:${store.revision}`, id, store.revision, now, now);
}

/** Append trusted source provenance to an exact governed duplicate without
 * widening its applicability or changing the original memory actor. */
/**
 * K7''' (D7): one transaction links at most this many sources to a line (the work and the JSON a call writes stay bounded). More than that is NOT cut: `appendMemoryOrigins` links the rest in the next transactions, so a line made from
 * more turns than this (a resting-time gathering call reads up to `curator.gathering.values.maxTurnsPerCall`, 32 today, and the ruleset may raise it) keeps a link to every one of them - the links are what a forget follows to empty those turns' wording.
 */
export const ORIGIN_LINKS_PER_CALL = 32;
export function appendMemoryOrigins(id: string, origins: NonNullable<NewMemoryEntry["originRefs"]>, projectId?: string | null): void {
  if (origins.length > ORIGIN_LINKS_PER_CALL) {   // never cut silently: part by part, each part idempotent (INSERT OR IGNORE)
    for (let at = 0; at < origins.length; at += ORIGIN_LINKS_PER_CALL) appendMemoryOrigins(id, origins.slice(at, at + ORIGIN_LINKS_PER_CALL), projectId);
    return;
  }
  const db = getDb();
  // the exact duplicate may live in another store (switch not OFF); the provenance is appended there.
  if (layoutOf(db) !== "central" && !db.prepare("SELECT 1 FROM memory_entries WHERE id=?").get(id)) {
    const ref = locateEntryStore(id);
    if (ref) { appendOriginsInStore(ref, id, origins, projectId); return; }
  }
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

/** `appendMemoryOrigins` inside the store that holds the row: same rules, no outbox (the outbox is the root's queue). */
function appendOriginsInStore(ref: StoreRef, id: string, origins: NonNullable<NewMemoryEntry["originRefs"]>, projectId?: string | null): void {
  const owner = getMemoryStoreInfo().ownerNamespace;
  const writer = openWriterFor({ ref });
  if (!writer) throw new Error("memory_origin_target_unavailable");
  try {
    writer.transaction(() => {
      const current = writer.prepare(`SELECT b.origin_refs_json,b.owner_namespace FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE m.id=? AND m.superseded_at IS NULL
        AND m.content<>'' AND COALESCE(json_extract(b.applicability_json,'$.enabled'),1)<>0`).get(id) as { origin_refs_json: string | null; owner_namespace: string | null } | undefined;
      if (!current || (current.owner_namespace && current.owner_namespace !== owner)) throw new Error("memory_origin_target_unavailable");
      let previous: NonNullable<NewMemoryEntry["originRefs"]> = [];
      try { previous = JSON.parse(current.origin_refs_json ?? "[]") as typeof previous; } catch { /* Existing source links stay available separately. */ }
      if (!Array.isArray(previous)) previous = [];
      const refs = origins.filter(item => ["ticket", "run", "source", "project"].includes(item.kind) && typeof item.id === "string" && item.id.trim() && item.id.length <= 512).slice(0, 32);
      const insert = writer.prepare("INSERT OR IGNORE INTO memory_origin_links(memory_id,source_kind,source_id,source_revision,relation) VALUES(?,?,?,?,'origin')");
      let changed = false;
      for (const item of refs) changed = insert.run(id, item.kind, item.id, item.revision ?? "").changes > 0 || changed;
      if (projectId) changed = writer.prepare("INSERT OR IGNORE INTO memory_project_links(memory_id,project_id,relation,source_ref) VALUES(?,?,'origin',?)")
        .run(id, projectId, refs.find(item => item.kind === "ticket")?.id ?? refs[0]?.id ?? "").changes > 0 || changed;
      if (!changed) return;
      const keyed = new Map([...previous, ...refs].filter(item => item && typeof item.id === "string" && ["ticket", "run", "source", "project"].includes(item.kind))
        .map(item => [JSON.stringify([item.kind, item.id, item.revision ?? ""]), item]));
      writer.prepare("UPDATE memory_identity_bindings SET origin_refs_json=?,revision=revision+1 WHERE memory_id=?").run(JSON.stringify([...keyed.values()].slice(-64)), id);
      writer.prepare("UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    }).immediate();
  } finally { try { writer.close(); } catch { /* 닫힘 */ } }
}

// --- store-aware answers for the files that read `memory_entries` directly (each one is listed in the report's table) ----------------------------------------

/** A raw row by id: the root's, or — layout switch not OFF — the row of the store that holds it. `columns` is a fixed list written by the caller, never user input. */
export function readEntryRowAnywhere(id: string, columns = "*"): Record<string, unknown> | undefined {
  const root = getDb().prepare(`SELECT ${columns} FROM memory_entries WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (root) return root;
  try {
    const ref = locateEntryStore(id);
    if (!ref) return undefined;
    const { store } = openStore(ref, getMemoryStoreInfo().ownerNamespace, getDb(), memoryRoot());
    if (!store || store.withheld.has(id)) return undefined;
    return store.db.prepare(`SELECT ${columns} FROM memory_entries WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  } catch { return undefined; }
}

/**
 * A fixed query whose only `?` is the entry id, run in the store that holds the entry when it is not in the root (layout switch not OFF; #11). `sql` is text from the caller, never user
 * input. Switch OFF, the entry in the root, not found, or a store that cannot be read: []. Never throws.
 */
export function queryEntryRowsInOtherStore(sql: string, id: string): Record<string, unknown>[] {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central" || rootDb.prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(id)) return [];
    const ref = locateEntryStore(id);
    if (!ref) return [];
    const { store } = openStore(ref, getMemoryStoreInfo().ownerNamespace, rootDb, memoryRoot());
    if (!store || store.withheld.has(id)) return [];
    return store.db.prepare(sql).all(id) as Record<string, unknown>[];
  } catch { return []; }
}
/** The same fixed query in the root, else (see {@link queryEntryRowsInOtherStore}) in the store that holds the entry: the first row, or undefined. */
export function queryEntryRowAnywhere(sql: string, id: string): Record<string, unknown> | undefined {
  return (getDb().prepare(sql).get(id) as Record<string, unknown> | undefined) ?? queryEntryRowsInOtherStore(sql, id)[0];
}

function agentStoreDb(agentId: string): { db: BetterDatabase.Database; withheld: ReadonlySet<string> } | null {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central") return null;
    const agent = storeAgentId(agentId);
    const home = agent ? findAgentHome(agent) : null;
    if (!agent || !home) return null;
    const { store } = openStore(agentRef(getMemoryStoreInfo().ownerNamespace, home, agent), getMemoryStoreInfo().ownerNamespace, rootDb, memoryRoot());
    return store ? { db: store.db, withheld: store.withheld } : null;
  } catch { return null; }
}
/** Rows this agent keeps in its own store (0 while the layout switch is OFF or the agent has no store). `liveOnly` = not superseded. Never throws. */
export function agentStoreRowCount(agentId: string, liveOnly = true): number {
  const opened = agentStoreDb(agentId);
  if (!opened) return 0;
  try {
    const row = opened.db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = ?${liveOnly ? " AND superseded_at IS NULL" : ""}`).get(agentId) as { n: number };
    return Number(row.n) || 0;
  } catch { return 0; }
}
/**
 * Taste drafts of this agent whose source line is not in the root but live in the agent's own store (layout switch not OFF), newest first. The drafts table is the root's, the line it
 * points at moved to the agent's store, so the root-only JOIN in the experience readers dropped them (#11). `columns` and `extraWhere` are fixed text from the caller, never user
 * input. Switch OFF, no store, or no such table: []. Never throws.
 */
export function tasteDraftsWithLineInAgentStore<T extends { source_memory_id: string }>(agentId: string, columns: string, extraWhere: string, limit: number): Array<T & { memory_content: string }> {
  try {
    if (layoutOf(getDb()) === "central") return [];
    const drafts = getDb().prepare(`SELECT ${columns} FROM taste_draft_candidates d WHERE d.agent_id = ? ${extraWhere}
      AND NOT EXISTS (SELECT 1 FROM memory_entries m WHERE m.id = d.source_memory_id) ORDER BY d.updated_at DESC, d.id ASC LIMIT ?`).all(agentId, limit) as T[];
    if (!drafts.length) return [];
    const live = agentStoreLiveContents(agentId, drafts.map((row) => row.source_memory_id));
    return drafts.filter((row) => live.has(row.source_memory_id)).map((row) => ({ ...row, memory_content: live.get(row.source_memory_id) as string }));
  } catch { return []; }
}
/** Of these ids, the lines this agent's own store holds live (not superseded, not withheld by an unfinished forget): id → content. Switch OFF or no store: empty. Never throws. */
export function agentStoreLiveContents(agentId: string, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const opened = ids.length ? agentStoreDb(agentId) : null;
  if (!opened) return out;
  try {
    for (let at = 0; at < ids.length; at += 400) {
      const part = ids.slice(at, at + 400);
      for (const row of opened.db.prepare(`SELECT id, content FROM memory_entries WHERE agent_id = ? AND superseded_at IS NULL AND id IN (${part.map(() => "?").join(",")})`).all(agentId, ...part) as Array<{ id: string; content: string }>) {
        if (!opened.withheld.has(row.id)) out.set(row.id, row.content);
      }
    }
  } catch { /* 못 읽은 줄은 없는 것으로 */ }
  return out;
}
/**
 * The agent store's and (for an app that names a project) the project store's lines, in the shape the restricted-surface readers inspect for policy before they select (#11):
 * those readers ask the root only, so lines that live in another store were not candidates. Switch OFF: []. Never throws.
 */
export function listSubStoreSurfaceCandidates(actorId: string, projectId: string | null): Array<{ id: string; scope: string; project_id: string | null; chat_id: string | null; agent_id: string | null;
  actor_id: string | null; owner_namespace: string | null; applicability_json: string | null }> {
  try {
    const db = getDb();
    if (!readsUnion(db)) return [];
    const owner = getMemoryStoreInfo().ownerNamespace;
    const actors = memoryActorIds(actorId);
    const rows = readUnionRows({ memoryRoot: memoryRoot(), owner, rootDb: db }, { agentId: actorId, projectId }, { actors, projectPath: null, ids: null }).rows;
    return rows.filter((row) => row.scope === "agent_repo" || (projectId !== null && row.scope === "project" && row.project_id === projectId))
      .map((row) => ({ id: row.id as string, scope: row.scope as string, project_id: (row.project_id as string | null) ?? null, chat_id: (row.chat_id as string | null) ?? null,
        agent_id: (row.agent_id as string | null) ?? null, actor_id: (row.binding_actor as string | null) ?? null, owner_namespace: (row.binding_owner as string | null) ?? null,
        applicability_json: (row.applicability_json as string | null) ?? null }));
  } catch { return []; }
}
/** Every agent id that has any line (live or not) in some other store: the agent stores and the project stores. Read through the per-store cache: only stores that changed are opened. Switch OFF: empty. Never throws. */
export function agentIdsWithRowsInStores(): Set<string> {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central") return new Set();
    const context = { memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb };
    const read = readSet(context, listExistingStores(context.memoryRoot, context.owner), "row-agent-ids",
      (sub) => (sub.prepare("SELECT DISTINCT agent_id AS id FROM memory_entries WHERE agent_id IS NOT NULL").all() as Array<{ id: string }>).map((row) => row.id), (value) => value.length);
    return new Set(read.results.flatMap((item) => item.value));
  } catch { return new Set(); }
}
/** The newest line this agent's own store holds (any state), or null: switch OFF, no store or nothing in it. Never throws. */
export function agentStoreLatestAt(agentId: string): string | null {
  const opened = agentStoreDb(agentId);
  if (!opened) return null;
  try { return ((opened.db.prepare("SELECT MAX(created_at) AS at FROM memory_entries WHERE agent_id = ?").get(agentId) as { at?: string | null } | undefined)?.at) ?? null; } catch { return null; }
}
/** Evidence tokens this agent's store holds (the import idempotency check, beside the root's). */
export function agentStoreEvidenceTokens(agentId: string, prefix: string): Set<string> {
  const tokens = new Set<string>();
  const opened = agentStoreDb(agentId);
  if (!opened) return tokens;
  try {
    for (const row of opened.db.prepare("SELECT evidence_json FROM memory_entries WHERE scope = 'agent_repo' AND agent_id = ? AND evidence_json LIKE ?").all(agentId, `%${prefix}%`) as Array<{ evidence_json: string }>) {
      try { const evidence = JSON.parse(row.evidence_json) as unknown; if (Array.isArray(evidence)) for (const item of evidence) if (typeof item === "string" && item.startsWith(prefix)) tokens.add(item); } catch { /* a malformed row does not block the import */ }
    }
  } catch { /* nothing to add */ }
  return tokens;
}
/** `evidence_json LIKE ?` over every store (cached per store by its size and mtime, so a repeated check opens only what changed). Layout switch OFF: empty. */
export function evidenceRowsInStores(like: string): string[] {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central") return [];
    const context = { memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb };
    const read = readSet(context, listExistingStores(context.memoryRoot, context.owner), `evidence-like:${like}`,
      (sub) => (sub.prepare("SELECT evidence_json FROM memory_entries WHERE evidence_json LIKE ?").all(like) as Array<{ evidence_json: string }>).map((row) => row.evidence_json), (value) => value.length);
    return read.results.flatMap((item) => item.value);
  } catch { return []; }
}
/** Agents (ids) whose own store holds live agent-wide learnings. Read through the per-store cache: only stores that changed are opened. */
export function learningAgentIdsInStores(): string[] {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central") return [];
    const context = { memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb };
    const stores = listExistingStores(context.memoryRoot, context.owner).filter((item) => item.ref.kind === "agent");
    const read = readSet(context, stores, "learning-agent-ids",
      (sub) => (sub.prepare("SELECT DISTINCT agent_id AS id FROM memory_entries WHERE superseded_at IS NULL AND scope = 'agent_repo' AND project_id IS NULL AND project_path IS NULL AND agent_id IS NOT NULL").all() as Array<{ id: string }>).map((row) => row.id), (value) => value.length);
    return [...new Set(read.results.flatMap((item) => item.value))];
  } catch { return []; }
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
  const query = getDb().prepare(`SELECT memory_entries.*, rb.owner_namespace AS binding_owner, rb.actor_id AS binding_actor, rb.applicability_json
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
  ) ORDER BY created_at DESC LIMIT ?`);
  // The query and synchronous policy pass must use the same owner; avoid
  // re-reading store metadata once for every candidate memory.
  const owner = getMemoryStoreInfo().ownerNamespace;
  const rows = query.all(...(ids ?? []), owner, ...actors, scope.projectPath ?? null,
    scope.projectId ?? null, scope.projectPath ?? null, scope.chatId ?? null, ...actors, -1) as Array<Row & MemoryRecallPolicyRow>;
  let allowed = rows.filter(row => allowsOrdinaryMemoryRecall(row, scope, owner));
  allowed = withSubStoreRows(allowed, scope, owner, actors, ids);
  return (limit < 0 ? allowed : allowed.slice(0, limit)).map(toEntry);
}

/**
 * the live Personal (`user_identity`) lines a turn may read, newest first, for the always-loaded owner-preference piece. The same visibility rules as
 * `listMemoryForContext` (this owner, not the legacy One overlay, not disabled, the ordinary recall policy) restricted to the Personal scope in the root store —
 * Personal lines never move to another store. Read-only; one indexed query; `limit` caps what is read (the always-loaded piece takes the newest few hundred bytes).
 */
export function listPersonalMemoryForContext(scope: MemoryRecallScope, limit = 400): MemoryEntry[] {
  const owner = getMemoryStoreInfo().ownerNamespace;
  const rows = getDb().prepare(`SELECT memory_entries.*, rb.owner_namespace AS binding_owner, rb.actor_id AS binding_actor, rb.applicability_json
    FROM memory_entries LEFT JOIN memory_identity_bindings rb ON rb.memory_id=memory_entries.id
    WHERE superseded_at IS NULL AND scope='user_identity' AND project_path IS NULL
    AND NOT EXISTS(SELECT 1 FROM memory_identity_bindings b WHERE b.memory_id=memory_entries.id
      AND (b.owner_namespace<>? OR json_extract(b.applicability_json,'$.recallChannel')='legacy_one_overlay'
        OR json_extract(b.applicability_json,'$.enabled')=0))
    ORDER BY created_at DESC LIMIT ?`).all(owner, Math.max(1, limit)) as Array<Row & MemoryRecallPolicyRow>;
  return rows.filter(row => allowsOrdinaryMemoryRecall(row, scope, owner)).map(toEntry);
}

/**
 * 이 읽기가 의존하는 하위 저장소들의 변경 지문. 분리 스위치가 꺼져 있으면 빈 문자열(= 이 묶음 전과 같은 캐시 키). 생성 팩이 뿌리의 변경 장부에 안 잡히는
 * 하위 저장소 쓰기를 알아차리는 데 쓴다. 던지지 않는다.
 */
export function subStoreFingerprint(scope: MemoryRecallScope): string {
  try {
    const db = getDb();
    if (!readsUnion(db)) return "";
    return unionFingerprint({ memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: db },
      { agentId: scope.agentId ?? null, projectPath: scope.projectPath ?? null, projectId: scope.projectId ?? null, chatId: scope.chatId ?? null });
  } catch { return ""; }
}

/**
 * 합집합 읽기. 분리 스위치(뿌리 메타 `memory_layout`)가 꺼져 있으면(= 지금 모든 기기) 이 함수는 `rows` 를 그대로 돌려준다 — 같은 객체, 새 질의 없음.
 * 켜져 있으면 프로젝트·에이전트 저장소의 후보 행을 같은 정책으로 거르고, 뿌리 행이 먼저(중복 id 는 뿌리가 이김) `created_at DESC, id DESC` 로 합친다.
 * 어떤 저장소도 읽는 쪽을 던지게 만들지 않는다: 실패하면 뿌리 행만 돌려준다.
 */
function withSubStoreRows(rows: Array<Row & MemoryRecallPolicyRow>, scope: MemoryRecallScope, owner: string,
  actors: readonly (string | null)[], ids: readonly string[] | null): Array<Row & MemoryRecallPolicyRow> {
  try {
    if (subStoreProbe) subStoreProbe.touched = true; // a line read ran under the probe: it says what it could not read (below)
    const db = getDb();
    if (!readsUnion(db)) return rows;
    const context = { memoryRoot: memoryRoot(), owner, rootDb: db };
    const readScope = { agentId: scope.agentId ?? null, projectPath: scope.projectPath ?? null, projectId: scope.projectId ?? null, chatId: scope.chatId ?? null };
    const query = { actors, projectPath: scope.projectPath ?? null, ids };
    let read = readUnionRows(context, readScope, query);
    // A store that was locked is asked once more (make it work before saying why it did not). The first read already waited the store's own busy timeout (stores.ts openStore, 500 ms), so this is one
    // more wait of the same length - no timer, no loop, and only when a lock was seen. What is still unread after it is reported to the recall (subStoreReadProblem).
    if (read.unread.includes("store_busy")) read = readUnionRows(context, readScope, query);
    noteSubStoreProblem(read.unread);
    const extra = read.rows as unknown as Array<Row & MemoryRecallPolicyRow>;
    if (!extra.length) return rows;
    const allowed = extra.filter(row => allowsOrdinaryMemoryRecall(row, scope, owner));
    // The original wording of the lines that came from the agent's / project's own store (native-text.ts): the stores THIS read may open, for the lines it let through.
    try { rememberSubStoreNatives(allowed.map((row) => String(row.id)), openSetFor(context, { agentId: scope.agentId ?? null, projectPath: scope.projectPath ?? null, projectId: scope.projectId ?? null }).stores); } catch { /* the recall ranks on the English text, as before */ }
    return mergeRows(rows, allowed);
  } catch (error) { noteSubStoreProblem([recallReasonOfError(error)]); return rows; }
}

// The recall says when it could not read a store (the engine hook's `memory=partial; reason=...` line). The union read above swallows its failures (a recall never throws for a store), so it also tells a probe the
// caller opened around the read: one synchronous read at a time, nothing is kept after it.
let subStoreProbe: { reason: Exclude<RecallReadReason, "not_here"> | null; touched: boolean } | null = null;
function noteSubStoreProblem(unread: readonly string[]): void {
  if (!subStoreProbe || unread.length === 0) return;
  // A lock alone is `store_busy` (it may be free next turn); anything that is not a lock - or a lock together with a store that cannot be read at all - is `store_unreadable`.
  subStoreProbe.reason = unread.every((code) => code === "store_busy") && subStoreProbe.reason !== "store_unreadable" ? "store_busy" : "store_unreadable";
}
/**
 * `read()` is a synchronous recall read (selectedMemorySection / globalMemorySections). Returns what it returned and, when a store of this scope that the read had to open could not be read (after the one more wait for a lock),
 * the closed word of why. A read that throws leaves the probe closed again and throws on. When the read never reached the stores at all (a generation pack with no line to check serves the turn from its copy), the stores
 * are looked at once here instead (stores.ts storeSkips: open each one, no rows read), so a store that stays unreadable is not told once and then forgotten by the next turn's pack. Switch off: no store, no look.
 */
export function withSubStoreReadProbe<T>(scope: { agentId?: string | null; projectPath?: string | null; projectId?: string | null; chatId?: string | null }, read: () => T): { value: T; unread: Exclude<RecallReadReason, "not_here"> | null } {
  const outer = subStoreProbe;
  const mine: { reason: Exclude<RecallReadReason, "not_here"> | null; touched: boolean } = { reason: null, touched: false };
  subStoreProbe = mine;
  try {
    const value = read();
    if (!mine.touched) {
      try {
        const db = getDb();
        if (readsUnion(db)) {
          const codes = storeSkips({ memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: db }, { agentId: scope.agentId ?? null, projectPath: scope.projectPath ?? null, projectId: scope.projectId ?? null, chatId: scope.chatId ?? null })
            .map((skip) => skip.code).filter((code) => code !== "forget_catchup_withheld"); // a line hidden while a forget catches up is hidden on purpose
          noteSubStoreProblem(codes);
        }
      } catch { noteSubStoreProblem(["store_unreadable"]); }
    }
    return { value, unread: mine.reason };
  } finally { subStoreProbe = outer; }
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
  for (const token of agentStoreEvidenceTokens(agentId, prefix)) tokens.add(token);
  return tokens;
}

function knownMemoryAudience(row: Row, db: BetterDatabase.Database = getDb()): string | null {
  const binding = db.prepare("SELECT owner_namespace,actor_id,applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(row.id) as
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
export function memoryAudienceKey(id: string, db: BetterDatabase.Database = getDb()): string | null {
  const binding = db.prepare("SELECT owner_namespace,applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(id) as
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

/**
 * Candidates that share the same governed owner boundary as one new memory. `db` (K3'-2b): the database the new line lives in - the root (the default, as before) or the store file that holds it when the 2.0 layout is on;
 * the candidates are read from that one database only, so a restatement never reaches across two stores (their lines have different owners of the file).
 */
export function listMemoryRelationCandidates(entry: MemoryEntry, limit = 160, db: BetterDatabase.Database = getDb()): MemoryEntry[] {
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  let rows: Row[] = [];
  if (entry.scope === "user_identity") {
    rows = db.prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'user_identity' AND superseded_at IS NULL AND id <> ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, capped) as Row[];
  } else if (entry.scope === "team_memory" || entry.scope === "agent_team") {
    rows = db.prepare(
      `SELECT * FROM memory_entries
       WHERE scope IN ('team_memory','agent_team') AND superseded_at IS NULL AND id <> ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, capped) as Row[];
  } else if (entry.scope === "agent_repo" && entry.agentId) {
    const actors = memoryActorIds(entry.agentId);
    rows = db.prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'agent_repo' AND agent_id IN (${actors.map(() => "?").join(",")})
         AND superseded_at IS NULL AND id <> ? AND project_id IS ? AND project_path IS ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(...actors, entry.id, entry.projectId, entry.projectPath, capped) as Row[];
  } else if (entry.scope === "project" && (entry.projectId || entry.projectPath)) {
    rows = db.prepare(
      `SELECT * FROM memory_entries
       WHERE scope = 'project' AND superseded_at IS NULL AND id <> ?
         AND ((project_id IS NOT NULL AND project_id = ?) OR (project_path IS NOT NULL AND project_path = ?))
       ORDER BY created_at DESC LIMIT ?`,
    ).all(entry.id, entry.projectId, entry.projectPath, capped) as Row[];
  }
  const current = db.prepare("SELECT * FROM memory_entries WHERE id=?").get(entry.id) as Row | undefined;
  const audience = current ? knownMemoryAudience(current, db) : null;
  return audience ? rows.filter(row => knownMemoryAudience(row, db) === audience).map(toEntry) : [];
}

/** Dedup check: same scope+kind+content already live for this path (or globally). */
type EquivalentBoundary = { projectId?: string | null; chatId?: string | null; recallChannel?: "default" | "legacy_one_overlay";
  compatibilityScope?: { scope: string; scopeRef: string | null } };
type SqlDb = BetterDatabase.Database;
export function findEquivalentMemoryId(
  scope: MemoryScope,
  kind: MemoryKind,
  content: string,
  projectPath: string | null,
  agentId: string | null,
  boundary: EquivalentBoundary = {},
): string | null {
  const root = equivalentIn(getDb(), scope, kind, content, projectPath, agentId, boundary);
  if (root) return root;
  return equivalentInOwnStore(scope, kind, content, projectPath, agentId, boundary);
}

/** the same duplicate check inside the store that would own this row (switch not OFF, store file exists). A duplicate there is as much a duplicate as one in the root. */
function equivalentInOwnStore(scope: MemoryScope, kind: MemoryKind, content: string, projectPath: string | null, agentId: string | null, boundary: EquivalentBoundary): string | null {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central") return null;
    const owner = getMemoryStoreInfo().ownerNamespace;
    const routed = storeForRow({ memoryRoot: memoryRoot(), owner, layout: "split" }, { scope, agentId, projectId: boundary.projectId, projectPath, chatId: boundary.chatId },
      boundary.projectId ?? null);
    if (routed.store.kind === "personal") return null;
    const { store } = openStore(routed.store, owner, rootDb, memoryRoot());
    if (!store) return null;
    const id = equivalentIn(store.db as unknown as SqlDb, scope, kind, content, projectPath, agentId, boundary);
    return id && !store.withheld.has(id) ? id : null;
  } catch { return null; }
}

function equivalentIn(db: SqlDb, scope: MemoryScope, kind: MemoryKind, content: string, projectPath: string | null, agentId: string | null, boundary: EquivalentBoundary): string | null {
  const norm = content.trim().toLowerCase();
  const actors = memoryActorIds(agentId), actorSql = actors.map(() => "?").join(",");
  // the duplicate check follows the CORRECTED kind — a stored decision/procedure/risk line in Personal is the same line as the preference it reads as.
  const kinds = equivalentMemoryKinds(scope, kind), kindSql = kinds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM memory_entries
       WHERE scope = ? AND kind IN (${kindSql}) AND lower(trim(content)) = ?
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
    .all(scope, ...kinds, norm, projectPath, projectPath, ...actors, agentId, boundary.chatId ?? null, ...actors, agentId, boundary.projectId ?? null,
      boundary.recallChannel ?? "default", boundary.compatibilityScope?.scope ?? "", boundary.compatibilityScope?.scopeRef ?? "") as Row[];
  const policyCompatible = (candidate: Row) => {
    if (knownMemoryAudience(candidate, db) === null) return false;
    const binding = db.prepare("SELECT applicability_json FROM memory_identity_bindings WHERE memory_id=?").get(candidate.id) as { applicability_json: string } | undefined;
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
    const nativeRows = db
      .prepare(
        `SELECT m.* FROM memory_entries m
           JOIN memory_entry_native n ON n.entry_id = m.id
         WHERE m.scope = ? AND m.kind IN (${kindSql}) AND lower(trim(n.content_native)) = ?
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
      .all(scope, ...kinds, norm, projectPath, projectPath, ...actors, agentId, boundary.chatId ?? null, ...actors, agentId, boundary.projectId ?? null,
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

/**
 * 이 에이전트의 저장소 행을 뿌리 행 뒤에 합친다(스킬 후보 목록·기억 인스펙터·반영 근거가 쓴다). 분리 스위치가 꺼져 있으면 `rows` 를 그대로 돌려준다 — 같은 객체, 새 질의 없음.
 * 이사 뒤 에이전트 행은 에이전트 폴더 안 저장소에 있으므로 뿌리만 읽으면 목록이 비어 보인다. 던지지 않는다: 실패하면 뿌리 행만.
 */
export function withAgentStoreRows<T extends { id: string; created_at: string }>(rows: T[], agentId: string, limit: number): T[] {
  try {
    const db = getDb();
    if (!readsUnion(db)) return rows;
    const extra = readAgentOwnRows({ memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: db }, agentId, limit) as unknown as T[];
    return extra.length ? mergeRows(rows, extra).slice(0, limit) : rows;
  } catch { return rows; }
}

/** How long a dropped line stays on the status line. The ledger rows are the ticket's own and leave with it; nothing is stored for this. */
const CURATION_DROP_WINDOW_MS = 7 * 24 * 3_600_000;
/** The ledger reason codes the status line reports, and the code it shows for each (codes only; the sheet makes the sentence). */
const CURATION_DROP_CODES: ReadonlyArray<readonly [reason: string, code: string]> = [
  ["store_full", "curation_dropped:store_full"],
  ["policy-personal-too-long", "curation_dropped:too_long"],
  ["policy-classification-session", "curation_dropped:kept_session"],
];
/**
 * Lines of the last week that the curator did not keep for a reason the owner could act on (Agentlas 2.0 #8): their store was full, a Personal line was over its length, or the
 * classification rules left them in the session only. One `{kind, code}` per kind of store and reason, read from `memory_decisions` (an existing table, indexed by ticket; a decision leaves with its ticket).
 * Never throws; a store without the ledger says nothing.
 */
export function recentCurationDropCodes(db: BetterDatabase.Database, scope: { agentId?: string | null; projectId?: string | null }, now = Date.now()): StoreSkip[] {
  try {
    const since = new Date(now - CURATION_DROP_WINDOW_MS).toISOString();
    const reasons = CURATION_DROP_CODES.map(([reason]) => reason);
    const actors = scope.agentId ? memoryActorIds(scope.agentId) : null;
    const rows = db.prepare(`SELECT d.reason_code AS reason, d.proposed_scope AS proposed, d.resolved_scope AS resolved
      FROM memory_decisions d JOIN memory_tickets t ON t.ticket_id = d.ticket_id
      WHERE d.created_at >= ? AND d.reason_code IN (${reasons.map(() => "?").join(",")})
      ${actors ? `AND t.agent_id IN (${actors.map(() => "?").join(",")})` : scope.projectId ? "AND t.project_id = ?" : ""}
      GROUP BY d.reason_code, d.proposed_scope, d.resolved_scope`).all(since, ...reasons, ...(actors ?? (scope.projectId ? [scope.projectId] : []))) as Array<{ reason: string; proposed: string; resolved: string }>;
    const out: StoreSkip[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const code = CURATION_DROP_CODES.find(([reason]) => reason === row.reason)?.[1];
      const where = row.reason === "store_full" ? row.resolved : row.proposed;
      const kind = where === "user_identity" ? "personal" : where === "project" ? "project" : where === "agent_repo" || where === "team_memory" || where === "agent_team" ? "agent" : "session";
      if (!code || seen.has(`${kind}:${code}`)) continue;
      seen.add(`${kind}:${code}`);
      out.push({ kind, code });
    }
    return out;
  } catch { return []; }
}

/**
 * 이 범위에서 합집합 읽기가 건너뛴 저장소와 사유 코드(기억 인스펙터의 "이 저장소를 읽지 못했어요(이유)" 한 줄의 재료). 스위치가 꺼져 있으면 빈 배열.
 * 코드만 돌려준다 — 문장은 화면이 만든다. 던지지 않는다.
 */
export function listSkippedMemoryStores(scope: { agentId?: string | null; projectPath?: string | null; projectId?: string | null }): StoreSkip[] {
  try {
    const db = getDb();
    // Agentlas 2.0 why the first-run migration is waiting (codes only; nothing while it is off, finished or has nothing to say).
    // Audit 46 #8: and the lines the curator could not keep (a full store, a Personal line over its length, a line kept in the session only) — read from the decision ledger that already exists.
    const waiting: StoreSkip[] = [...firstRunOpenCodes().map((code) => ({ kind: "personal" as const, code })), ...recentCurationDropCodes(db, scope)];
    if (!readsUnion(db)) return waiting;
    const skips = storeSkips({ memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: db },
      { agentId: scope.agentId ?? null, projectPath: scope.projectPath ?? null, projectId: scope.projectId ?? null });
    // the reasons nobody read before — a write that fell back to the root store, a forget not yet complete everywhere, a project deletion still pending. Codes only.
    for (const degrade of writeDegrades()) skips.push({ kind: degrade.kind, code: `write_to_root:${degrade.code}` });
    try { recheckForgetCodes(); for (const code of forgetOpenCodes()) skips.push({ kind: "personal", code }); } catch { /* none */ }
    try { for (const code of projectForgetPendingCodes()) skips.push({ kind: "project", code }); } catch { /* none */ }
    skips.push(...waiting);
    return skips;
  } catch { return []; }
}

/** 에이전트 상세 UI용 — 프로젝트에 귀속되지 않은 agent-repo 메모리만 최신순.
 *  프로젝트 메모리는 프로젝트가 소유하므로 전역 에이전트 상세에서 섞거나 노출하지 않는다. */
export function listMemoryEntriesForAgentUi(
  agentId: string,
  limit = 100,
): Array<MemoryEntry & { contentEnglish?: string }> {
  let rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE superseded_at IS NULL AND agent_id = ?
         AND scope = 'agent_repo' AND project_id IS NULL AND project_path IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Row[];
  rows = withAgentStoreRows(rows, agentId, limit);
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
  supersedeInOtherStores(ids, now);
}

/** an id that is not in the root may be a row in another store (switch not OFF). The same retirement, in the store that holds it. Never throws. */
function supersedeInOtherStores(ids: string[], now: string): void {
  try {
    if (layoutOf(getDb()) === "central") return;
    const missing = ids.filter(id => !getDb().prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(id));
    if (!missing.length) return;
    for (const [file, group] of groupByStore(missing)) {
      const writer = openWriterFor(file);
      if (!writer) { noteWriteDegrade(file.ref, "store_unwritable"); continue; }
      try {
        const update = writer.prepare("UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL");
        writer.transaction(() => { for (const id of group) update.run(now, id); }).immediate();
      } catch { noteWriteDegrade(file.ref, "store_locked"); } finally { try { writer.close(); } catch { /* 닫힘 */ } }
    }
  } catch { /* 뿌리의 행은 이미 처리됐다 */ }
}

// --- id 로 행이 있는 저장소 찾기 (id 만 아는 옛 호출부를 위한 느린 길) ----------------------------------------------------------

const locatedAt = new Map<string, string>();
const LOCATED_CAP = 512;
/** 이 id 의 행이 뿌리에 없고 다른 저장소에 있으면 그 저장소. 뿌리에 있거나 어디에도 없거나 스위치가 꺼져 있으면 null. 일반 회수 경로는 부르지 않는다(드문 변경 경로뿐). */
export function locateEntryStore(id: string): StoreRef | null {
  try {
    const rootDb = getDb();
    if (layoutOf(rootDb) === "central") return null;
    if (rootDb.prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(id)) return null;
    const owner = getMemoryStoreInfo().ownerNamespace;
    const hinted = locatedAt.get(id);
    const candidates = listExistingStores(memoryRoot(), owner);
    const ordered = hinted ? [...candidates.filter(c => c.ref.path === hinted), ...candidates.filter(c => c.ref.path !== hinted)] : candidates;
    for (const candidate of ordered) {
      const { store } = openStore(candidate.ref, owner, rootDb, memoryRoot());
      if (!store) continue;
      if (store.db.prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(id)) {
        locatedAt.delete(id); locatedAt.set(id, candidate.ref.path);
        while (locatedAt.size > LOCATED_CAP) locatedAt.delete(locatedAt.keys().next().value as string);
        return candidate.ref;
      }
    }
  } catch { /* 못 찾으면 뿌리 쪽 호출부가 자기 오류를 낸다 */ }
  return null;
}
function groupByStore(ids: string[]): Map<{ ref: StoreRef }, string[]> {
  const groups = new Map<string, { key: { ref: StoreRef }; ids: string[] }>();
  for (const id of ids) {
    const ref = locateEntryStore(id);
    if (!ref) continue;
    const group = groups.get(ref.path) ?? { key: { ref }, ids: [] };
    group.ids.push(id); groups.set(ref.path, group);
  }
  return new Map([...groups.values()].map(group => [group.key, group.ids]));
}
/** 이미 있는 저장소 파일의 쓰기 연결(만들지 않는다, 잊기를 다 반영하지 못한 저장소·다른 소유자·새 스키마는 거절). 호출자가 닫는다. */
function openWriterFor(file: { ref: StoreRef }): BetterDatabase.Database | null {
  try {
    if (!fs.existsSync(file.ref.path)) return null;
    const opened = openStoreForWrite(file.ref, getMemoryStoreInfo().ownerNamespace, getDb(), memoryRoot());
    return opened.store ? opened.store.db : null;
  } catch { return null; }
}

// --- K3'-2a: the databases that may hold a live line of one scope, and a way to write into the one that does ----------------------------------------------------------
/**
 * One database that may hold a line: the root (`ref` null) or an agent's / a project's own store (layout switch not OFF). `db` is a read handle (a store's is the cached read-only one); a write goes through
 * `withHolderWriter`. `withheld` = the ids that store still has to forget (never offered as a target).
 */
export interface LineHolder { db: BetterDatabase.Database; ref: StoreRef | null; withheld: ReadonlySet<string> }

/** The root first, then the stores a read of this scope opens: the agent's own store and the project's (one per key). Switch OFF: the root alone. A store that cannot be opened is left out (the read side reports it: storeSkips). Never throws. */
export function lineHolders(scope: { agentId?: string | null; projectId?: string | null; projectPath?: string | null }): LineHolder[] {
  const root = getDb();
  const out: LineHolder[] = [{ db: root, ref: null, withheld: new Set() }];
  try {
    if (layoutOf(root) === "central") return out;
    const owner = getMemoryStoreInfo().ownerNamespace;
    const refs: StoreRef[] = [];
    const agent = storeAgentId(scope.agentId ?? null);
    const home = agent ? findAgentHome(agent) : null;
    if (home && agent) refs.push(agentRef(owner, home, agent));
    for (const key of projectKeys(scope.projectPath ?? null, scope.projectId ?? null)) refs.push(projectRef(memoryRoot(), owner, key));
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      try { const { store } = openStore(ref, owner, root, memoryRoot()); if (store) out.push({ db: store.db, ref, withheld: store.withheld }); } catch { /* left out */ }
    }
  } catch { /* the root alone */ }
  return out;
}

/** The holder of one line by id: the root when the row is there, else the store that holds it (`locateEntryStore`). Null when no database holds it. Never throws. */
export function holderOfEntry(id: string): LineHolder | null {
  const root = getDb();
  try {
    if (root.prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(id)) return { db: root, ref: null, withheld: new Set() };
    const ref = locateEntryStore(id);
    if (!ref) return null;
    const { store } = openStore(ref, getMemoryStoreInfo().ownerNamespace, root, memoryRoot());
    return store && !store.withheld.has(id) ? { db: store.db, ref, withheld: store.withheld } : null;
  } catch { return null; }
}

/**
 * Runs `write` against a database that can be written: the root's handle, or a connection opened for this one write and closed after it (the same way every sub-store write is made). A store that cannot be
 * opened or written is noted by code (`writeDegrades`) and answers `{ ok: false }` - the caller leaves the line as it is and the same ticket is tried again at the next signal. Never throws.
 */
export function withHolderWriter<T>(holder: LineHolder, write: (db: BetterDatabase.Database) => T): { ok: true; value: T } | { ok: false } {
  if (!holder.ref) { try { return { ok: true, value: write(getDb()) }; } catch { return { ok: false }; } }
  const writer = openWriterFor({ ref: holder.ref });
  if (!writer) { noteWriteDegrade(holder.ref, "store_unwritable"); return { ok: false }; }
  try { return { ok: true, value: write(writer) }; }
  catch { noteWriteDegrade(holder.ref, "store_locked"); return { ok: false }; }
  finally { try { writer.close(); } catch { /* closed */ } }
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
const DEDUP_EXACT_SQL = `SELECT id FROM (
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
       ) WHERE newest_first > 1`;
export function dedupExactDuplicateMemories(): number {
  const rows = getDb().prepare(DEDUP_EXACT_SQL).all() as Array<{ id: string }>;
  // The same pass inside every other store (layout switch not OFF): an agent's or a project's lines live there, and a duplicate pair is within one store. Only the stores that changed
  // since the last look are opened (store-set.ts); a store whose forget catch-up is unfinished is skipped and says so by code instead of being read.
  const inStores = dedupIdsInStores();
  const ids = [...rows.map((r) => r.id), ...inStores];
  supersedeMemoryEntries(ids);
  return ids.length;
}
function dedupIdsInStores(): string[] {
  try {
    const rootDb = getDb();
    if (!readsUnion(rootDb)) return [];
    const context = { memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb };
    const read = readSet(context, listExistingStores(context.memoryRoot, context.owner), "dedup-exact",
      (sub) => (sub.prepare(DEDUP_EXACT_SQL).all() as Array<{ id: string }>).map((row) => row.id), (value) => value.length);
    return read.results.flatMap((item) => item.value);
  } catch { return []; }
}

/**
 * 이 계정의 하위 저장소 파일들의 변경 지문(stat 만, 파일을 열지 않는다). 분리 스위치가 꺼져 있으면 "" — 뿌리의 변경 장부(revision·epoch)가 전부다.
 * 켜진 뒤에는 에이전트·프로젝트 줄이 하위 저장소에만 쓰여 뿌리 revision 이 안 움직이므로, 신호로 깨는 백그라운드 일(드리밍)이 "저장소가 바뀌었나" 를 이것으로 본다. 던지지 않는다.
 */
export function subStoresFingerprint(): string {
  try {
    const rootDb = getDb();
    if (!readsUnion(rootDb)) return "";
    return setFingerprint(listExistingStores(memoryRoot(), getMemoryStoreInfo().ownerNamespace), rootClock(rootDb));
  } catch { return ""; }
}

/** 드리밍 2단계 대상 — live agent_repo 메모리가 minCount 이상 쌓인 에이전트 목록. 분리 스위치가 켜져 있으면 에이전트 저장소 안의 줄도 센다(뿌리 + 저장소의 합). */
export function listAgentIdsWithLiveMemory(minCount = 8): Array<{ agentId: string; count: number }> {
  const db = getDb();
  const grouped = "SELECT agent_id AS agentId, COUNT(*) AS count FROM memory_entries WHERE superseded_at IS NULL AND agent_id IS NOT NULL AND scope = 'agent_repo' GROUP BY agent_id";
  if (!readsUnion(db)) return db.prepare(`${grouped} HAVING COUNT(*) >= ? ORDER BY count DESC`).all(minCount) as Array<{ agentId: string; count: number }>;
  const totals = new Map<string, number>();
  for (const row of db.prepare(grouped).all() as Array<{ agentId: string; count: number }>) totals.set(row.agentId, row.count);
  try {
    const context = { memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: db };
    const stores = listExistingStores(context.memoryRoot, context.owner).filter((item) => item.ref.kind === "agent");
    const read = readSet(context, stores, "dream-agent-counts", (sub) => sub.prepare(grouped).all() as Array<{ agentId: string; count: number }>, (value) => value.length);
    for (const item of read.results) for (const row of item.value) totals.set(row.agentId, (totals.get(row.agentId) ?? 0) + row.count);
  } catch { /* 뿌리의 개수만으로 답한다 */ }
  return [...totals].filter(([, count]) => count >= minCount).map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

export function countMemory(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
  return r.n;
}
