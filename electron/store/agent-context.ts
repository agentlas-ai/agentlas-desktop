import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { observeProductSource, readOriginalMemorySource, type MemorySourceRef } from "../memory/source-catalogue";

/** Host-authored actor identity. Invocation, workspace and effect authority are
 * deliberately absent: a context journal never authorizes a tool operation. */
export interface AgentContextIdentity {
  ownerScope: string;
  serviceIdentity: string;
  agentId: string;
  visibilityDomain: string;
}
export interface AgentContextProvider {
  kind: string;
  backend?: string;
  model?: string;
  configurationDigest: string;
}
export type AgentContextEventKind = "system" | "turn-context" | "message" | "attachment" | "tool" | "checkpoint-reference";
export interface AgentContextEvent {
  eventId: string;
  kind: AgentContextEventKind;
  payload: Record<string, unknown>;
  /** Observations produced by this adapter are already in its native session. */
  producerBinding?: string;
}
export interface AgentContextEntry extends AgentContextEvent { seq: number; digest: string }
export interface AgentContextSnapshot { contextKey: string; revision: number; throughSeq: number; entries: AgentContextEntry[]; sourceRef?: MemorySourceRef }
export interface AgentContextDelivery {
  contextKey: string;
  deliveryId: string;
  turnId: string;
  bindingKey: string;
  generation: number;
  fromSeq: number;
  throughSeq: number;
  mode: "bootstrap" | "delta";
  nativeHandle: string | null;
  entries: AgentContextEntry[];
}
export interface AgentContextPendingDelivery extends AgentContextDelivery { status: "pending" | "uncertain" }
/**





 */
export type AgentContextAdoption =
  | { outcome: "none" }
  | { outcome: "current"; retainedKeys: string[] }
  | { outcome: "adopted"; fromKey: string; fromRevision: number; fromThroughSeq: number; retainedKeys: string[] };
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail("agent_context_identity_invalid");
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function agentContextKey(identity: AgentContextIdentity): string {
  for (const value of [identity.ownerScope, identity.serviceIdentity, identity.agentId, identity.visibilityDomain]) nonempty(value);
  return hash(["agentlas.agent-context.v1", identity.ownerScope, identity.serviceIdentity, identity.agentId, identity.visibilityDomain]);
}
export function agentContextProviderKey(provider: AgentContextProvider): string {
  nonempty(provider.kind); nonempty(provider.configurationDigest);
  return hash(["agentlas.agent-context-provider.v1", provider.kind, provider.backend ?? "", provider.model ?? "", provider.configurationDigest]);
}
/** Additive schema, called only by the existing migration owner. A follower
 * never creates these tables opportunistically during model execution. */
export function createAgentContextSchema(db: Pick<Database.Database, "exec">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_context_heads (
      context_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, through_seq INTEGER NOT NULL DEFAULT 0,
      open_delivery_id TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_context_entries (
      context_key TEXT NOT NULL REFERENCES agent_context_heads(context_key) ON DELETE CASCADE,
      seq INTEGER NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, digest TEXT NOT NULL, producer_binding TEXT,
      PRIMARY KEY(context_key, seq), UNIQUE(context_key, event_id)
    );
    CREATE TABLE IF NOT EXISTS agent_context_bindings (
      context_key TEXT NOT NULL REFERENCES agent_context_heads(context_key) ON DELETE CASCADE,
      binding_key TEXT NOT NULL, provider_json TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, acknowledged_seq INTEGER NOT NULL DEFAULT 0,
      native_handle TEXT, PRIMARY KEY(context_key, binding_key)
    );
    CREATE TABLE IF NOT EXISTS agent_context_deliveries (
      delivery_id TEXT PRIMARY KEY, context_key TEXT NOT NULL REFERENCES agent_context_heads(context_key) ON DELETE CASCADE,
      turn_id TEXT NOT NULL, binding_key TEXT NOT NULL, generation INTEGER NOT NULL,
      from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL,
      mode TEXT NOT NULL, status TEXT NOT NULL, receipt_id TEXT,
      UNIQUE(context_key, turn_id)
    );
    CREATE TABLE IF NOT EXISTS agent_context_stable_blocks (
      context_key TEXT NOT NULL REFERENCES agent_context_heads(context_key) ON DELETE CASCADE,
      binding_key TEXT NOT NULL, generation INTEGER NOT NULL,
      block_hash TEXT NOT NULL, acknowledged_seq INTEGER NOT NULL,
      PRIMARY KEY(context_key, binding_key, generation, block_hash)
    );
  `);
}
type Head = { context_key: string; identity_json: string; revision: number; through_seq: number; open_delivery_id: string | null };
type Binding = { generation: number; acknowledged_seq: number; native_handle: string | null };
type DeliveryRow = { delivery_id: string; turn_id: string; binding_key: string; generation: number; from_seq: number; through_seq: number; mode: "bootstrap" | "delta"; status: string; receipt_id: string | null };
const kinds = new Set<AgentContextEventKind>(["system", "turn-context", "message", "attachment", "tool", "checkpoint-reference"]);
function encodePayload(value: unknown): string {
  function valid(v: unknown): boolean {
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(valid);
    if (!v || typeof v !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    return Object.values(v).every(valid);
  }
  try { if (!valid(value)) fail("agent_context_payload_invalid"); return JSON.stringify(value); }
  catch { return fail("agent_context_payload_invalid"); }
}
/** SQLite is authoritative, including unresolved delivery state. There is no
 * memory fallback that could acknowledge context which was never persisted. */
export function createAgentContextStore(getDb: () => Database.Database) {
  function head(identity: AgentContextIdentity, create: boolean): Head | undefined {
    const key = agentContextKey(identity), db = getDb();
    if (create) db.prepare("INSERT OR IGNORE INTO agent_context_heads(context_key,identity_json,updated_at) VALUES (?,?,?)")
      .run(key, JSON.stringify(identity), new Date().toISOString());
    const row = db.prepare("SELECT * FROM agent_context_heads WHERE context_key=?").get(key) as Head | undefined;
    // Compare identity values independent of caller object property order.
    if (row && agentContextKey(JSON.parse(row.identity_json) as AgentContextIdentity) !== key) fail("agent_context_identity_collision");
    return row;
  }
  function observe(identity: AgentContextIdentity, row: Head | undefined, adoptAddress = false): MemorySourceRef | null {
    if (!row) return null;
    return observeProductSource(getDb(), { actorId: identity.agentId, visibilityDomain: identity.visibilityDomain,
      logicalKey: JSON.stringify([identity.ownerScope, identity.agentId, identity.visibilityDomain]), sourceKind: "agent-journal",
      readerContract: "desktop.agent-context.v1", writerContract: "desktop.agent-context-store",
      schemaVersion: "agentlas.agent-context.v1", sourceRevision: String(row.revision),
      address: { path: getDb().name, contextKey: row.context_key }, rangeUnit: "seq", rangeEnd: row.through_seq, adoptAddress });
  }
  function entries(key: string, after = 0, through = Number.MAX_SAFE_INTEGER): AgentContextEntry[] {
    return (getDb().prepare("SELECT * FROM agent_context_entries WHERE context_key=? AND seq>? AND seq<=? ORDER BY seq")
      .all(key, after, through) as Array<{ seq: number; event_id: string; kind: AgentContextEventKind; payload_json: string; digest: string; producer_binding: string | null }>).map(row => ({
        seq: row.seq, eventId: row.event_id, kind: row.kind, payload: JSON.parse(row.payload_json) as Record<string, unknown>, digest: row.digest,
        ...(row.producer_binding ? { producerBinding: row.producer_binding } : {}),
      }));
  }
  /**








 */
  function priorHeadKeys(identity: AgentContextIdentity, key: string): string[] {
    return (getDb().prepare(`SELECT context_key FROM agent_context_heads
      WHERE json_extract(identity_json,'$.ownerScope')=? AND json_extract(identity_json,'$.agentId')=?
        AND json_extract(identity_json,'$.visibilityDomain')=? AND context_key<>?
      ORDER BY updated_at DESC`).all(identity.ownerScope, identity.agentId, identity.visibilityDomain, key) as Array<{ context_key: string }>)
      .map(row => row.context_key);
  }
  function adoptPriorHeadReport(identity: AgentContextIdentity): AgentContextAdoption {
    const key = agentContextKey(identity), db = getDb();
    const present = () => !!db.prepare("SELECT 1 FROM agent_context_heads WHERE context_key=?").get(key);
    if (present()) return { outcome: "current", retainedKeys: priorHeadKeys(identity, key) };
    if (!priorHeadKeys(identity, key).length) return { outcome: "none" };
    const result = db.transaction((): AgentContextAdoption => {
      if (present()) return { outcome: "current", retainedKeys: priorHeadKeys(identity, key) };
      const priors = priorHeadKeys(identity, key);
      const prior = priors.length ? db.prepare("SELECT * FROM agent_context_heads WHERE context_key=?").get(priors[0]) as (Head & { updated_at: string }) | undefined : undefined;
      if (!prior) return { outcome: "none" };
      db.prepare("INSERT INTO agent_context_heads(context_key,identity_json,revision,through_seq,open_delivery_id,updated_at) VALUES (?,?,?,?,?,?)")
        .run(key, JSON.stringify(identity), prior.revision, prior.through_seq, prior.open_delivery_id, prior.updated_at);
      for (const table of ["agent_context_entries", "agent_context_bindings", "agent_context_deliveries", "agent_context_stable_blocks"]) {
        db.prepare(`UPDATE ${table} SET context_key=? WHERE context_key=?`).run(key, prior.context_key);
      }
      db.prepare("DELETE FROM agent_context_heads WHERE context_key=?").run(prior.context_key);
      return { outcome: "adopted", fromKey: prior.context_key, fromRevision: prior.revision, fromThroughSeq: prior.through_seq,
        retainedKeys: priors.slice(1) };
    }).immediate();
    if (result.outcome === "adopted") observe(identity, head(identity, false), true);
    return result;
  }
  function adoptPriorHead(identity: AgentContextIdentity): boolean { return adoptPriorHeadReport(identity).outcome === "adopted"; }
  function readRange(identity: AgentContextIdentity, range: {after?:number;through?:number} = {}): AgentContextSnapshot {
    const after=range.after??0,through=range.through??Number.MAX_SAFE_INTEGER;
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(through)||through<after)fail("agent_context_read_range_invalid");
    const result = getDb().transaction(()=>{
      const row = head(identity, false), contextKey = agentContextKey(identity);
      return { contextKey, revision: row?.revision ?? 0, throughSeq: row?.through_seq ?? 0,
        entries: row ? entries(contextKey,after,Math.min(through,row.through_seq)) : [] };
    }).deferred();
    const sourceRef = observe(identity, head(identity, false));
    return { ...result, ...(sourceRef ? { sourceRef } : {}) };
  }
  function readSource(identity: AgentContextIdentity, ref: MemorySourceRef, after: number, through: number, assertCurrent: () => void): AgentContextEntry[] {
    const bytes = readOriginalMemorySource(ref, { actorId: identity.agentId, visibilityDomain: identity.visibilityDomain,
      readerContract: "desktop.agent-context.v1" }, { start: after, end: through }, (source, from, to) => {
      const address = JSON.parse(source.address_json) as { path?: string; contextKey?: string };
      if (address.path !== getDb().name || address.contextKey !== agentContextKey(identity)) fail("memory_source_changed");
      const snapshot = readRange(identity, { after: from, through: to });
      if (String(snapshot.revision) !== source.source_revision) fail("memory_source_changed");
      return Buffer.from(JSON.stringify(snapshot.entries), "utf8");
    }, assertCurrent);
    return JSON.parse(bytes.toString("utf8")) as AgentContextEntry[];
  }
  function read(identity: AgentContextIdentity): AgentContextSnapshot { return readRange(identity); }
  function readHead(identity: AgentContextIdentity): Omit<AgentContextSnapshot,"entries"> {
    const row=head(identity,false);
    return {contextKey:agentContextKey(identity),revision:row?.revision??0,throughSeq:row?.through_seq??0};
  }
  function acknowledgedStableBlockHashes(identity: AgentContextIdentity, bindingKey:string, generation:number): string[] {
    nonempty(bindingKey);if(!Number.isSafeInteger(generation)||generation<1)fail("agent_context_generation_invalid");
    return (getDb().prepare("SELECT block_hash FROM agent_context_stable_blocks WHERE context_key=? AND binding_key=? AND generation=?")
      .all(agentContextKey(identity),bindingKey,generation) as Array<{block_hash:string}>).map(row=>row.block_hash);
  }
  function append(identity: AgentContextIdentity, event: AgentContextEvent, expectedRevision?: number): AgentContextEntry {
    nonempty(event.eventId); if (!kinds.has(event.kind)) fail("agent_context_event_invalid");
    const payload = encodePayload(event.payload), digest = hash([event.kind, payload, event.producerBinding ?? ""]), db = getDb();
    const result = db.transaction(() => {
      const row = head(identity, true)!;
      const previous = db.prepare("SELECT seq,digest FROM agent_context_entries WHERE context_key=? AND event_id=?").get(row.context_key, event.eventId) as { seq: number; digest: string } | undefined;
      if (previous) {
        if (previous.digest !== digest) fail("agent_context_event_collision");
        return entries(row.context_key, previous.seq - 1, previous.seq)[0];
      }
      if (expectedRevision !== undefined && row.revision !== expectedRevision) fail("agent_context_revision_changed");
      const seq = row.through_seq + 1;
      db.prepare("INSERT INTO agent_context_entries(context_key,seq,event_id,kind,payload_json,digest,producer_binding) VALUES (?,?,?,?,?,?,?)")
        .run(row.context_key, seq, event.eventId, event.kind, payload, digest, event.producerBinding ?? null);
      db.prepare("UPDATE agent_context_heads SET through_seq=?,revision=revision+1,updated_at=? WHERE context_key=? AND revision=?")
        .run(seq, new Date().toISOString(), row.context_key, row.revision);
      return { ...event, payload: JSON.parse(payload) as Record<string, unknown>, seq, digest };
    }).immediate();
    observe(identity, head(identity, false));
    return result;
  }
  function beginDelivery(identity: AgentContextIdentity, provider: AgentContextProvider, options: { turnId: string; expectedRevision?: number }): AgentContextDelivery {
    nonempty(options.turnId); const bindingKey = agentContextProviderKey(provider), db = getDb();
    return db.transaction(() => {
      const row = head(identity, true)!;
      if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision) fail("agent_context_revision_changed");
      if (row.open_delivery_id) {
        const pending = db.prepare("SELECT status FROM agent_context_deliveries WHERE delivery_id=?").get(row.open_delivery_id) as {status:string} | undefined;
        fail(pending?.status === "uncertain" ? "agent_context_delivery_unresolved" : "agent_context_delivery_busy");
      }
      // A turn identity is single-use even when the provider never acknowledges.
      if (db.prepare("SELECT 1 FROM agent_context_deliveries WHERE context_key=? AND turn_id=?").get(row.context_key, options.turnId)) fail("agent_context_turn_replayed");
      db.prepare("INSERT OR IGNORE INTO agent_context_bindings(context_key,binding_key,provider_json) VALUES (?,?,?)")
        .run(row.context_key, bindingKey, JSON.stringify(provider));
      const binding = db.prepare("SELECT * FROM agent_context_bindings WHERE context_key=? AND binding_key=?").get(row.context_key,bindingKey) as Binding;
      const mode: AgentContextDelivery["mode"] = binding.acknowledged_seq === 0 ? "bootstrap" : "delta", deliveryId = randomUUID();
      db.prepare("INSERT INTO agent_context_deliveries(delivery_id,context_key,turn_id,binding_key,generation,from_seq,through_seq,mode,status) VALUES (?,?,?,?,?,?,?,?, 'pending')")
        .run(deliveryId,row.context_key,options.turnId,bindingKey,binding.generation,binding.acknowledged_seq,row.through_seq,mode);
      db.prepare("UPDATE agent_context_heads SET open_delivery_id=? WHERE context_key=? AND open_delivery_id IS NULL").run(deliveryId,row.context_key);
      return { contextKey:row.context_key, deliveryId,turnId:options.turnId,bindingKey,generation:binding.generation,
        fromSeq:binding.acknowledged_seq,throughSeq:row.through_seq,mode,nativeHandle:binding.native_handle,
        entries:entries(row.context_key,binding.acknowledged_seq,row.through_seq) };
    }).immediate();
  }
  function pendingDelivery(key:string,row:DeliveryRow|undefined):AgentContextPendingDelivery|null {
    if(!row)return null;const db=getDb();
    const binding=db.prepare("SELECT native_handle FROM agent_context_bindings WHERE context_key=? AND binding_key=?").get(key,row.binding_key) as {native_handle:string|null}|undefined;
    return {contextKey:key,deliveryId:row.delivery_id,turnId:row.turn_id,bindingKey:row.binding_key,generation:row.generation,
      fromSeq:row.from_seq,throughSeq:row.through_seq,mode:row.mode,nativeHandle:binding?.native_handle??null,
      entries:entries(key,row.from_seq,row.through_seq),status:row.status as "pending"|"uncertain"};
  }
  function readPendingDelivery(identity: AgentContextIdentity): AgentContextPendingDelivery | null {
    const key=agentContextKey(identity);
    const row=getDb().prepare("SELECT * FROM agent_context_deliveries WHERE context_key=? AND status IN ('pending','uncertain') ORDER BY rowid DESC LIMIT 1").get(key) as DeliveryRow|undefined;
    return pendingDelivery(key,row);
  }
  function readOpenPendingDelivery(identity:AgentContextIdentity):AgentContextPendingDelivery|null {
    const key=agentContextKey(identity);
    const row=getDb().prepare(`SELECT d.* FROM agent_context_heads h JOIN agent_context_deliveries d
      ON d.delivery_id=h.open_delivery_id AND d.context_key=h.context_key
      WHERE h.context_key=? AND d.status='pending'`).get(key) as DeliveryRow|undefined;
    return pendingDelivery(key,row);
  }
  function exactDelivery(identity: AgentContextIdentity, delivery: AgentContextDelivery): DeliveryRow {
    if (agentContextKey(identity) !== delivery.contextKey) fail("agent_context_delivery_binding_changed");
    const row = getDb().prepare("SELECT * FROM agent_context_deliveries WHERE delivery_id=? AND context_key=?").get(delivery.deliveryId,delivery.contextKey) as DeliveryRow | undefined;
    if (!row || row.turn_id !== delivery.turnId || row.binding_key !== delivery.bindingKey || row.generation !== delivery.generation
      || row.from_seq !== delivery.fromSeq || row.through_seq !== delivery.throughSeq || row.mode !== delivery.mode) fail("agent_context_delivery_binding_changed");
    return row;
  }
  function acknowledgeDelivery(identity: AgentContextIdentity, delivery: AgentContextDelivery, receipt: {receiptId:string; nativeHandle?:string | null; observedThroughSeq?:number}): boolean {
    nonempty(receipt.receiptId); const db = getDb();
    return db.transaction(() => {
      const row = exactDelivery(identity,delivery);
      if (row.status === "acknowledged") {
        if(row.receipt_id!==receipt.receiptId)fail("agent_context_receipt_changed");
        return false;
      }
      if (!["pending","uncertain"].includes(row.status)) fail("agent_context_delivery_unresolved");
      if (row.status === "pending" && head(identity,false)?.open_delivery_id !== row.delivery_id) fail("agent_context_delivery_unresolved");
      const through=receipt.observedThroughSeq??delivery.throughSeq;
      if(!Number.isSafeInteger(through) || through<delivery.throughSeq || through>(head(identity,false)?.through_seq??0))fail("agent_context_observed_range_invalid");
      // Only actual adapter-produced observations after the captured input
      // frontier can be covered by its terminal receipt. Foreign host updates
      // remain pending even when appended while a provider was running.
      if(entries(delivery.contextKey,delivery.throughSeq,through).some(entry=>entry.producerBinding!==delivery.bindingKey))fail("agent_context_observed_range_invalid");
      const result = db.prepare("UPDATE agent_context_bindings SET acknowledged_seq=?,native_handle=COALESCE(?,native_handle) WHERE context_key=? AND binding_key=? AND generation=? AND acknowledged_seq=?")
        .run(through,receipt.nativeHandle ?? null,delivery.contextKey,delivery.bindingKey,delivery.generation,delivery.fromSeq);
      if (result.changes !== 1) fail("agent_context_cursor_changed");
      // Only the actually dispatched stable blocks enter this compact ACK
      // index. Never scan or reparse the historical transcript on warm turns.
      const blocks=db.prepare(`SELECT payload_json FROM agent_context_entries
        WHERE context_key=? AND seq>? AND seq<=? AND kind='turn-context' AND producer_binding=?`)
        .all(delivery.contextKey,delivery.fromSeq,delivery.throughSeq,delivery.bindingKey) as Array<{payload_json:string}>;
      const saveBlock=db.prepare(`INSERT INTO agent_context_stable_blocks(context_key,binding_key,generation,block_hash,acknowledged_seq)
        VALUES (?,?,?,?,?) ON CONFLICT(context_key,binding_key,generation,block_hash) DO UPDATE SET acknowledged_seq=excluded.acknowledged_seq`);
      for(const row of blocks){
        const payload:Record<string,unknown>=JSON.parse(row.payload_json);
        if(Array.isArray(payload.stableBlocks))for(const block of payload.stableBlocks)if(typeof block==="string"&&block)
          saveBlock.run(delivery.contextKey,delivery.bindingKey,delivery.generation,hash(block),through);
      }
      db.prepare("UPDATE agent_context_deliveries SET status='acknowledged',receipt_id=? WHERE delivery_id=?").run(receipt.receiptId,delivery.deliveryId);
      db.prepare("UPDATE agent_context_heads SET open_delivery_id=NULL WHERE context_key=? AND open_delivery_id=?").run(delivery.contextKey,delivery.deliveryId);
      return true;
    }).immediate();
  }
  function markDeliveryUncertain(identity: AgentContextIdentity, delivery: AgentContextDelivery): void {
    const db = getDb(); db.transaction(() => {
      const row = exactDelivery(identity,delivery);
      if (row.status === "acknowledged") fail("agent_context_delivery_already_acknowledged");
      db.prepare("UPDATE agent_context_deliveries SET status='uncertain' WHERE delivery_id=?").run(delivery.deliveryId);
      // Preserve the exact uncertain receipt and unadvanced cursor, while a
      // NEW invocation's existing host authority can admit its own turn.
      db.prepare("UPDATE agent_context_heads SET open_delivery_id=NULL WHERE context_key=? AND open_delivery_id=?").run(delivery.contextKey,delivery.deliveryId);
    }).immediate();
  }
  /** A host-validated reconciliation changes adapter generation, never replays
   * a tool. Pending/uncertain data remains retained for inspection. */
  function invalidateProvider(identity: AgentContextIdentity, provider: AgentContextProvider, expectedGeneration: number): void {
    const db=getDb(),key=agentContextKey(identity),binding=agentContextProviderKey(provider);
    db.transaction(()=>{
      if (head(identity,false)?.open_delivery_id) fail("agent_context_delivery_unresolved");
      if(db.prepare("UPDATE agent_context_bindings SET generation=generation+1,acknowledged_seq=0,native_handle=NULL WHERE context_key=? AND binding_key=? AND generation=?")
        .run(key,binding,expectedGeneration).changes!==1)fail("agent_context_generation_changed");
    }).immediate();
  }
  /**
   * The highest ordinal `n` this agent's conversation journal already holds for a turn id `${turnPrefix}${n}]` (its
   * deliveries, and the events a turn appends before its delivery opens), under every key the conversation has had
   * (adoptPriorHead); 0 when none. Range reads on the (context_key, turn_id) and (context_key, event_id) indexes: the
   * prefix ends with "," so every id of the family sorts below the same prefix ending with "-".
   */
  function maxTurnOrdinal(identity: AgentContextIdentity, turnPrefix: string): number {
    nonempty(turnPrefix); if (!turnPrefix.endsWith(",")) fail("agent_context_turn_prefix_invalid");
    const db = getDb(), upper = `${turnPrefix.slice(0, -1)}-`, eventPrefix = `turn:${turnPrefix}`;
    const keys = (db.prepare(`SELECT context_key FROM agent_context_heads
      WHERE json_extract(identity_json,'$.ownerScope')=? AND json_extract(identity_json,'$.agentId')=?
        AND json_extract(identity_json,'$.visibilityDomain')=?`)
      .all(identity.ownerScope, identity.agentId, identity.visibilityDomain) as Array<{ context_key: string }>).map(row => row.context_key);
    let max = 0;
    const take = (rest: string) => { const n = /^(\d{1,15})\]/.exec(rest)?.[1]; if (n && Number(n) > max) max = Number(n); };
    for (const key of new Set([agentContextKey(identity), ...keys])) {
      for (const row of db.prepare("SELECT turn_id FROM agent_context_deliveries WHERE context_key=? AND turn_id>=? AND turn_id<?")
        .all(key, turnPrefix, upper) as Array<{ turn_id: string }>) take(row.turn_id.slice(turnPrefix.length));
      for (const row of db.prepare("SELECT event_id FROM agent_context_entries WHERE context_key=? AND event_id>=? AND event_id<?")
        .all(key, eventPrefix, `turn:${upper}`) as Array<{ event_id: string }>) take(row.event_id.slice(eventPrefix.length));
    }
    return max;
  }
  return {adoptPriorHead,adoptPriorHeadReport,read,readRange,readSource,readHead,acknowledgedStableBlockHashes,append,beginDelivery,readPendingDelivery,readOpenPendingDelivery,acknowledgeDelivery,markDeliveryUncertain,invalidateProvider,maxTurnOrdinal};
}
