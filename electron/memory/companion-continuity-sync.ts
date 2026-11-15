/**
 * Private, disabled-until-verified mirror for the Companion memory lineage.
 * A caller must provide a verified, current account/consent proof and a complete
 * snapshot including durable tombstones. This module does not enable recall or
 * modify Desktop-owned memories; no product route invokes it yet.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { looksSecret } from "../../shared/secret-patterns";

type Kind = "identity" | "preference" | "fact" | "boundary";
type Item = { id: string; revision: number; state: "active"; kind: Kind; text: string }
  | { id: string; revision: number; state: "deleted" };
export type ContinuityMemorySnapshot = {
  version: 2; complete: true; userId: string; workspaceId: string; generation: string;
  revision: number; forgetEpoch: number; items: Item[];
};
export type ContinuityMemoryProof = {
  userId: string; workspaceId: string; generation: string; ownerNamespace: string;
  /** Must synchronously recheck the session, registration, approval, and snapshot expiry. */
  assertCurrent(): void;
};
export type ContinuityMemoryVerifier = (snapshot: ContinuityMemorySnapshot) => Promise<ContinuityMemoryProof | null>;
type Row = { source_id: string; source_revision: number; state: "active" | "deleted" | "local_forget"; kind: Kind | null; text: string | null; digest: string };
const idOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:@-]{1,200}$/.test(v);
const nat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string) => Object.keys(v).sort().join(",") === names;
function validSnapshot(v: unknown): v is ContinuityMemorySnapshot {
  if (!record(v) || !keys(v, "complete,forgetEpoch,generation,items,revision,userId,version,workspaceId") || v.version !== 2 || v.complete !== true ||
      !idOk(v.userId) || !idOk(v.workspaceId) || !idOk(v.generation) || !nat(v.revision) || !nat(v.forgetEpoch) ||
      !Array.isArray(v.items) || v.items.length > 4096) return false;
  const seen = new Set<string>();
  for (const item of v.items) {
    if (!record(item) || !idOk(item.id) || seen.has(item.id) || !nat(item.revision) || item.revision > v.revision) return false;
    seen.add(item.id);
    if (item.state === "deleted") { if (!keys(item, "id,revision,state")) return false; continue; }
    if (item.state !== "active" || !keys(item, "id,kind,revision,state,text") || !["identity", "preference", "fact", "boundary"].includes(String(item.kind)) ||
        typeof item.text !== "string" || !item.text.trim() || Array.from(item.text).length > 200 || /[\u0000-\u001f\u007f]/u.test(item.text) || looksSecret(item.text)) return false;
  }
  return true;
}
function current(proof: ContinuityMemoryProof): void {
  const result = proof.assertCurrent() as unknown;
  if (result !== undefined) {
    if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    throw new Error("continuity_proof_not_synchronous");
  }
}
function digestItem(item: Item): string {
  return item.state === "active" ? hash([item.id, item.revision, item.state, item.kind, item.text]) : hash([item.id, item.revision, item.state]);
}

/** Atomic mirror, with tombstones and local-forget markers retained indefinitely. */
export function createCompanionContinuitySync(input: { db: Database.Database; ownerNamespace: string; verify: ContinuityMemoryVerifier }) {
  const { db, ownerNamespace, verify } = input;
  if (!idOk(ownerNamespace) || typeof verify !== "function") throw new TypeError("continuity_sync_config");
  const fail = (reason: string) => ({ status: "unavailable" as const, reason });
  return async (raw: unknown) => {
    if (!validSnapshot(raw)) return fail("invalid_snapshot");
    // Freeze the input before awaiting authentication, so callers cannot change what was verified.
    const snapshot = JSON.parse(JSON.stringify(raw)) as ContinuityMemorySnapshot;
    const verifiedBytes = JSON.stringify(snapshot);
    let proof: ContinuityMemoryProof | null;
    try { proof = await verify(snapshot); } catch { return fail("authority_unavailable"); }
    if (!validSnapshot(snapshot) || JSON.stringify(snapshot) !== verifiedBytes) return fail("snapshot_changed");
    if (!proof || proof.userId !== snapshot.userId || proof.workspaceId !== snapshot.workspaceId ||
        proof.generation !== snapshot.generation || proof.ownerNamespace !== ownerNamespace || typeof proof.assertCurrent !== "function") return fail("owner_mismatch");
    const scope = hash([ownerNamespace, snapshot.userId, snapshot.workspaceId]);
    const ordered = [...snapshot.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const digest = hash([snapshot.generation, snapshot.revision, snapshot.forgetEpoch, ordered.map(digestItem)]);
    try {
      return db.transaction(() => {
        current(proof!);
        db.exec(`CREATE TABLE IF NOT EXISTS memory_companion_v2_sources (
          scope_key TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL, forget_epoch INTEGER NOT NULL, digest TEXT NOT NULL
        ); CREATE TABLE IF NOT EXISTS memory_companion_v2_items (
          scope_key TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','deleted','local_forget')), kind TEXT, text TEXT, digest TEXT NOT NULL,
          PRIMARY KEY(scope_key, source_id)
        )`);
        const source = db.prepare("SELECT generation,revision,forget_epoch,digest FROM memory_companion_v2_sources WHERE scope_key=?").get(scope) as {generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
        if (source && (source.generation !== snapshot.generation || snapshot.revision < source.revision || snapshot.forgetEpoch < source.forget_epoch ||
            (source.revision === snapshot.revision && source.digest !== digest))) throw new Error("source_revision_conflict");
        const rows = db.prepare("SELECT source_id,source_revision,state,kind,text,digest FROM memory_companion_v2_items WHERE scope_key=?").all(scope) as Row[];
        const prior = new Map(rows.map(row => [row.source_id, row]));
        const incoming = new Set(ordered.map(item => item.id));
        if (rows.some(row => !incoming.has(row.source_id))) throw new Error("missing_lineage");
        const upsert = db.prepare(`INSERT INTO memory_companion_v2_items(scope_key,source_id,source_revision,state,kind,text,digest)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_key,source_id) DO UPDATE SET source_revision=excluded.source_revision,state=excluded.state,
          kind=excluded.kind,text=excluded.text,digest=excluded.digest`);
        for (const item of ordered) {
          const old = prior.get(item.id), itemDigest = digestItem(item);
          if (old && (item.revision < old.source_revision || (item.revision === old.source_revision && itemDigest !== old.digest) ||
              (old.state === "deleted" && item.state !== "deleted"))) throw new Error("item_revision_conflict");
          // A local forget may never be undone by a stale or newly revised source.
          const state = old?.state === "local_forget" ? "local_forget" : item.state;
          upsert.run(scope, item.id, item.revision, state, state === "active" && item.state === "active" ? item.kind : null,
            state === "active" && item.state === "active" ? item.text : null, itemDigest);
        }
        current(proof!);
        db.prepare(`INSERT INTO memory_companion_v2_sources(scope_key,generation,revision,forget_epoch,digest) VALUES(?,?,?,?,?)
          ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,forget_epoch=excluded.forget_epoch,digest=excluded.digest`)
          .run(scope, snapshot.generation, snapshot.revision, snapshot.forgetEpoch, digest);
        return { status: "stored" as const, revision: snapshot.revision, recallEnabled: false as const };
      }).immediate();
    } catch { return fail("snapshot_not_applied"); }
  };
}

/**
 * Marks one mirrored source item locally forgotten without modifying an
 * independently owned Desktop memory. Propagation to the source is a separate
 * operation and must complete before any consumer can enable recall.
 */
export function createCompanionContinuityLocalForget(input: { db: Database.Database; ownerNamespace: string; verify: ContinuityMemoryVerifier }) {
  const { db, ownerNamespace, verify } = input;
  if (!idOk(ownerNamespace) || typeof verify !== "function") throw new TypeError("continuity_sync_config");
  return async (raw: unknown, sourceId: string) => {
    if (!validSnapshot(raw) || !idOk(sourceId)) return false;
    const snapshot = JSON.parse(JSON.stringify(raw)) as ContinuityMemorySnapshot;
    const bytes = JSON.stringify(snapshot);
    let proof: ContinuityMemoryProof | null;
    try { proof = await verify(snapshot); } catch { return false; }
    if (!validSnapshot(snapshot) || JSON.stringify(snapshot) !== bytes || !proof || proof.userId !== snapshot.userId ||
        proof.workspaceId !== snapshot.workspaceId || proof.generation !== snapshot.generation ||
        proof.ownerNamespace !== ownerNamespace || typeof proof.assertCurrent !== "function") return false;
    const scope = hash([ownerNamespace, snapshot.userId, snapshot.workspaceId]);
    const ordered = [...snapshot.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const digest = hash([snapshot.generation, snapshot.revision, snapshot.forgetEpoch, ordered.map(digestItem)]);
    try {
      return db.transaction(() => {
        current(proof!);
        const source = db.prepare("SELECT generation,revision,forget_epoch,digest FROM memory_companion_v2_sources WHERE scope_key=?").get(scope) as {generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
        if (!source || source.generation !== snapshot.generation || source.revision !== snapshot.revision ||
            source.forget_epoch !== snapshot.forgetEpoch || source.digest !== digest) return false;
        const row = db.prepare("SELECT state FROM memory_companion_v2_items WHERE scope_key=? AND source_id=?").get(scope, sourceId) as {state:string}|undefined;
        if (!row || row.state === "deleted") return false;
        if (row.state === "local_forget") return true;
        const result = db.prepare("UPDATE memory_companion_v2_items SET state='local_forget',kind=NULL,text=NULL WHERE scope_key=? AND source_id=? AND state='active'").run(scope, sourceId);
        current(proof!);
        return result.changes === 1;
      }).immediate();
    } catch { return false; }
  };
}

/** Product storage adapter. No production verifier or route is registered yet. */
export async function syncVerifiedCompanionContinuitySnapshot(raw: unknown, verify?: ContinuityMemoryVerifier) {
  const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
  if (!verify || !validSnapshot(raw)) return unavailable("authority_unavailable");
  const snapshot = JSON.parse(JSON.stringify(raw)) as ContinuityMemorySnapshot;
  const bytes = JSON.stringify(snapshot);
  const auth = await import("../auth");
  const session = auth.getAuthenticatedSessionBinding();
  const sessionCurrent = () => {
    const now = auth.getAuthenticatedSessionBinding();
    return !!session && !!now && now.userId === session.userId && now.workspaceId === session.workspaceId &&
      now.sessionId === session.sessionId && (now.expiresAt === null || now.expiresAt > Date.now());
  };
  if (!session || session.userId !== snapshot.userId || session.workspaceId !== snapshot.workspaceId || !sessionCurrent()) return unavailable("owner_mismatch");
  let proof: ContinuityMemoryProof | null;
  try { proof = await verify(snapshot); } catch { return unavailable("authority_unavailable"); }
  if (!proof || !sessionCurrent() || !validSnapshot(snapshot) || JSON.stringify(snapshot) !== bytes ||
      proof.userId !== snapshot.userId || proof.workspaceId !== snapshot.workspaceId || proof.generation !== snapshot.generation ||
      typeof proof.assertCurrent !== "function") return unavailable("owner_mismatch");
  const memory = await import("./database");
  if (!sessionCurrent()) return unavailable("owner_mismatch");
  try {
    const db = memory.getMemoryDb(), info = memory.getMemoryStoreInfo();
    if (proof.ownerNamespace !== info.ownerNamespace || !sessionCurrent()) return unavailable("owner_mismatch");
    return await createCompanionContinuitySync({ db, ownerNamespace: info.ownerNamespace, verify: async () => ({
      ...proof!, assertCurrent() {
        if (!sessionCurrent() || memory.getMemoryDb() !== db) throw new Error("continuity_owner_changed");
        const now = memory.getMemoryStoreInfo();
        if (now.ownerNamespace !== info.ownerNamespace || now.revocationEpoch !== info.revocationEpoch) throw new Error("continuity_owner_changed");
        current(proof!);
      },
    }) })(snapshot);
  } catch { return unavailable("storage_unavailable"); }
}

// The newer lineage protocol is a separate, opt-in mirror; the v2 snapshot
// parser above remains exact and rejects it rather than guessing a migration.
export {createCompanionMemoryLineageV2} from "./companion-memory-lineage-v2";
