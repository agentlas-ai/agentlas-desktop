import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { applySeatSnapshotToChats } from "./seats";

type Lifetime = { id: string; installed_at: string; entity_kind: string | null; builtin: number };
type MergeReceipt = { prior_id: string; canonical_id: string; source_lifetime: string; target_lifetime: string; proof_sha256: string; issuer: string };
const issuer = "local-dedupe-forward-v1";
const hasTable = (db: Database.Database, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// Presentation, usage counters and package updates do not change an installation
// lifetime. Reinstallation does: never promote a reused ID into an old actor.
function lifetime(db: Database.Database, id: string): string | null {
  const row = db.prepare("SELECT id, installed_at, entity_kind, builtin FROM installed_agents WHERE id=?").get(id) as Lifetime | undefined;
  if (!row?.installed_at) return null;
  return createHash("sha256").update(JSON.stringify([row.id, row.installed_at, row.entity_kind, row.builtin])).digest("hex");
}

export function recordAgentIdentityMerge(db: Database.Database, priorId: string, canonicalId: string, verifiedIdentityKey: string): void {
  if (!db.inTransaction) throw new Error("agent_identity_transaction_required");
  db.exec(`CREATE TABLE IF NOT EXISTS agent_canonical_merge_receipts (
    prior_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL, source_lifetime TEXT NOT NULL,
    target_lifetime TEXT NOT NULL, proof_sha256 TEXT NOT NULL, issuer TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const source = lifetime(db, priorId), target = lifetime(db, canonicalId);
  if (!source || !target || !verifiedIdentityKey || priorId === canonicalId) throw new Error("agent_identity_merge_unbound");
  const proof = createHash("sha256").update(verifiedIdentityKey).digest("hex");
  const existing = db.prepare("SELECT * FROM agent_canonical_merge_receipts WHERE prior_id=?").get(priorId) as MergeReceipt | undefined;
  if (existing) {
    if (existing.canonical_id !== canonicalId || existing.source_lifetime !== source || existing.target_lifetime !== target || existing.proof_sha256 !== proof || existing.issuer !== issuer) throw new Error("agent_identity_generation_conflict");
    return;
  }
  db.prepare("INSERT INTO agent_canonical_merge_receipts VALUES(?,?,?,?,?,?,?)").run(priorId, canonicalId, source, target, proof, issuer, new Date().toISOString());
}

/** Only exact, forward-issued host receipts resolve missing references. */
function canonicalForMissing(db: Database.Database, id: string): string | null {
  if (!hasTable(db, "agent_canonical_merge_receipts") || db.prepare("SELECT 1 FROM installed_agents WHERE id=?").get(id)) return null;
  let current = id, expectedSource: string | undefined;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const receipt = db.prepare("SELECT * FROM agent_canonical_merge_receipts WHERE prior_id=?").get(current) as MergeReceipt | undefined;
    if (!receipt || receipt.issuer !== issuer || !/^[a-f0-9]{64}$/.test(receipt.proof_sha256) || (expectedSource && receipt.source_lifetime !== expectedSource)) return null;
    const target = lifetime(db, receipt.canonical_id);
    if (target) return target === receipt.target_lifetime ? receipt.canonical_id : null;
    current = receipt.canonical_id;
    expectedSource = receipt.target_lifetime;
  }
  return null;
}

/** Runs within the same merge/CAS transaction; historical utterances are untouched. */
export function rewriteAgentRosterReferences(db: Database.Database, priorId: string, canonicalId: string): void {
  if (!db.inTransaction) throw new Error("agent_identity_transaction_required");
  if (hasTable(db, "one_taskforces")) {
    const rows = db.prepare("SELECT id, member_agent_ids_json, revision FROM one_taskforces").all() as Array<{ id: string; member_agent_ids_json: string; revision: number }>;
    for (const row of rows) {
      if (!row.member_agent_ids_json.includes(JSON.stringify(priorId))) continue;
      let ids: unknown;
      try { ids = JSON.parse(row.member_agent_ids_json); } catch { throw new Error("agent_merge_group_roster_invalid"); }
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("agent_merge_group_roster_invalid");
      if (!ids.includes(priorId)) continue;
      const next = ids.map(id => id === priorId ? canonicalId : id);
      if (new Set(next).size !== next.length) throw new Error("agent_merge_group_member_collision");
      const changed = db.prepare("UPDATE one_taskforces SET member_agent_ids_json=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND member_agent_ids_json=?")
        .run(JSON.stringify(next), new Date().toISOString(), row.id, row.revision, row.member_agent_ids_json);
      if (changed.changes !== 1) throw new Error("agent_merge_group_roster_changed");
    }
  }
  if (!hasTable(db, "one_seat_occupants")) return;
  const occupants = db.prepare("SELECT seat_id, slot, since FROM one_seat_occupants WHERE agent_id=? AND until IS NULL").all(priorId) as Array<{ seat_id: string; slot: number; since: string }>;
  const name = (db.prepare("SELECT name FROM installed_agents WHERE id=?").get(canonicalId) as { name: string } | undefined)?.name ?? canonicalId;
  const now = new Date().toISOString();
  for (const row of occupants) {
    if (db.prepare("SELECT 1 FROM one_seat_occupants WHERE seat_id=? AND agent_id=? AND until IS NULL").get(row.seat_id, canonicalId)) throw new Error("agent_merge_seat_member_collision");
    db.prepare("UPDATE one_seat_occupants SET until=? WHERE seat_id=? AND slot=? AND since=? AND until IS NULL").run(now, row.seat_id, row.slot, row.since);
    const last = (db.prepare("SELECT MAX(since) AS since FROM one_seat_occupants WHERE seat_id=? AND slot=?").get(row.seat_id, row.slot) as { since: string }).since;
    const bumped = Date.parse(last) + 1;
    const since = last && last >= now && Number.isFinite(bumped) ? new Date(bumped).toISOString() : now;
    db.prepare("INSERT INTO one_seat_occupants(seat_id,slot,agent_id,display_name,since,until) VALUES(?,?,?,?,?,NULL)").run(row.seat_id, row.slot, canonicalId, name, since);
  }
  for (const seatId of new Set(occupants.map(row => row.seat_id))) applySeatSnapshotToChats(seatId);
}

/** Normal startup repair. No historical mapping is invented for old missing IDs. */
export function reconcileAgentRosterReceipts(db: Database.Database): void {
  if (!hasTable(db, "one_taskforces") || !hasTable(db, "agent_canonical_merge_receipts")) return;
  const rows = db.prepare("SELECT member_agent_ids_json FROM one_taskforces").all() as Array<{ member_agent_ids_json: string }>;
  const missing = new Set<string>();
  for (const row of rows) {
    try { const ids: unknown = JSON.parse(row.member_agent_ids_json); if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") missing.add(id); } catch { /* Unresolved legacy roster remains visible. */ }
  }
  for (const priorId of missing) {
    const canonicalId = canonicalForMissing(db, priorId);
    if (!canonicalId) continue;
    try { db.transaction(() => rewriteAgentRosterReferences(db, priorId, canonicalId))(); }
    catch (error) { console.warn("[agents] roster receipt repair deferred", error instanceof Error ? error.message : "agent_identity_repair_failed"); }
  }
}
