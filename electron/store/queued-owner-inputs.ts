import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { McpInvocationRequest } from "../../shared/types";
import { queuedInputDigest, queuedInputRequestDigest, type QueuedInputOwner, type QueuedInputAttempt } from "../one/queued-input-escrow";

export interface QueuedOwnerInputRow {
  owner_id: string; origin_run_id: string; chat_id: string; submission_id: string; request_digest: string;
  request_json: string; account_digest: string; scope_digest: string; queue_id: string | null;
  state: "active" | "placed" | "cancelled"; created_at: number; capture_complete: number; cleanup_done: number; hold_code: string | null;
}
export interface QueuedOwnerAttemptRow {
  run_id: string; owner_id: string; epoch: string; request_digest: string;
  state: "reserved" | "open" | "closed-before-source"; closed_at: number | null;
}
/** Shared SQLite authority. Filesystem manifests and renderer-supplied receipts
 * are never sufficient to recreate an owner or a resource grant. */
export function createQueuedOwnerInputStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS queued_owner_inputs (
    owner_id TEXT PRIMARY KEY, origin_run_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
    submission_id TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT NOT NULL,
    account_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, queue_id TEXT UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('active','placed','cancelled')), created_at INTEGER NOT NULL, cleanup_done INTEGER NOT NULL DEFAULT 0, capture_complete INTEGER NOT NULL DEFAULT 0, hold_code TEXT);
    CREATE TABLE IF NOT EXISTS queued_owner_input_resources (
      owner_id TEXT NOT NULL REFERENCES queued_owner_inputs(owner_id), kind TEXT NOT NULL,
      digest TEXT NOT NULL, PRIMARY KEY(owner_id,kind));
    CREATE TABLE IF NOT EXISTS queued_owner_input_attempts (
      run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES queued_owner_inputs(owner_id),
      epoch TEXT NOT NULL, request_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','open','closed-before-source')), closed_at INTEGER);
    CREATE INDEX IF NOT EXISTS queued_owner_input_attempt_owner ON queued_owner_input_attempts(owner_id);
    CREATE TABLE IF NOT EXISTS queued_owner_input_cleanup_refs (run_id TEXT PRIMARY KEY REFERENCES queued_owner_input_attempts(run_id), refs_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS queued_owner_input_attempt_heads (owner_id TEXT PRIMARY KEY REFERENCES queued_owner_inputs(owner_id), attempt_json TEXT NOT NULL);`);
  const columns = db.prepare("PRAGMA table_info(queued_owner_inputs)").all() as { name: string }[];
  if (!columns.some(column => column.name === "hold_code")) db.exec("ALTER TABLE queued_owner_inputs ADD COLUMN hold_code TEXT");
  const byOwner = (id: string) => db.prepare("SELECT * FROM queued_owner_inputs WHERE owner_id=?").get(id) as QueuedOwnerInputRow | undefined;
  const ownerOf = (r: QueuedOwnerInputRow): QueuedInputOwner => ({ ownerId: r.owner_id, originRunId: r.origin_run_id,
    chatId: r.chat_id, submissionId: r.submission_id, requestDigest: r.request_digest });
  const exact = (owner: QueuedInputOwner): QueuedOwnerInputRow => {
    const row = byOwner(owner.ownerId);
    if (!row || queuedInputDigest(ownerOf(row)) !== queuedInputDigest(owner)
      || row.cleanup_done !== 1 && queuedInputRequestDigest(JSON.parse(row.request_json) as McpInvocationRequest) !== owner.requestDigest) throw new Error("queued_input_owner_changed");
    return row;
  };
  const byRun = (runId:string): QueuedOwnerInputRow|undefined => {
    const rows=db.prepare(`SELECT DISTINCT o.* FROM queued_owner_inputs o LEFT JOIN queued_owner_input_attempts a ON a.owner_id=o.owner_id
      WHERE o.origin_run_id=? OR a.run_id=? LIMIT 2`).all(runId,runId) as QueuedOwnerInputRow[];
    if (rows.length>1) throw new Error("queued_input_run_identity_ambiguous");
    return rows[0];
  };
  const assertRunOrigin = (owner:QueuedInputOwner,runId:string) => {
    if (db.prepare("SELECT 1 FROM queued_owner_inputs WHERE origin_run_id=? AND owner_id<>?").get(runId,owner.ownerId)) {
      throw new Error("queued_input_run_identity_exists");
    }
  };
  return {
    ownerOf, exact, byOwner, byRun,
    byOrigin: (runId: string) => db.prepare("SELECT * FROM queued_owner_inputs WHERE origin_run_id=?").get(runId) as QueuedOwnerInputRow | undefined,
    byQueue: (id: string) => db.prepare("SELECT * FROM queued_owner_inputs WHERE queue_id=?").get(id) as QueuedOwnerInputRow | undefined,
    attempt: (runId: string) => db.prepare("SELECT * FROM queued_owner_input_attempts WHERE run_id=?").get(runId) as QueuedOwnerAttemptRow | undefined,
    active: () => db.prepare("SELECT * FROM queued_owner_inputs WHERE cleanup_done=0").all() as QueuedOwnerInputRow[],
    stop(owner: QueuedInputOwner): void { exact(owner); db.prepare("UPDATE queued_owner_inputs SET state='cancelled' WHERE owner_id=?").run(owner.ownerId); },
    create(request: McpInvocationRequest, accountDigest: string, scopeDigest: string): QueuedInputOwner {
      if (!request.runId) throw new Error("queued_input_run_required");
      if (byRun(request.runId)) throw new Error("queued_input_run_identity_exists");
      const owner: QueuedInputOwner = { ownerId: randomUUID(), originRunId: request.runId, chatId: request.chatId,
        submissionId: request.preflightSubmissionId ?? randomUUID(), requestDigest: queuedInputRequestDigest(request) };
      db.prepare(`INSERT INTO queued_owner_inputs (owner_id,origin_run_id,chat_id,submission_id,request_digest,request_json,account_digest,scope_digest,queue_id,state,created_at) VALUES (?,?,?,?,?,?,?,?,NULL,'active',?)`).run(owner.ownerId, owner.originRunId,
        owner.chatId, owner.submissionId, owner.requestDigest, JSON.stringify(request), accountDigest, scopeDigest, Date.now());
      return owner;
    },
    hold(owner: QueuedInputOwner, code: string | null): void { exact(owner); db.prepare("UPDATE queued_owner_inputs SET hold_code=? WHERE owner_id=? AND state='active'").run(code, owner.ownerId); },
    captureComplete(owner: QueuedInputOwner): void { exact(owner); db.prepare("UPDATE queued_owner_inputs SET capture_complete=1 WHERE owner_id=? AND state='active'").run(owner.ownerId); },
    adopt(owner: QueuedInputOwner, queueId: string): void {
      const row = exact(owner);
      const queue = db.prepare("SELECT chat_id,request_json,state FROM pending_chat_sends WHERE id=?").get(queueId) as {chat_id:string;request_json:string;state:string}|undefined;
      if (!queue || queue.chat_id !== owner.chatId || queue.state !== "queued"
        || queuedInputRequestDigest(JSON.parse(queue.request_json) as McpInvocationRequest) !== owner.requestDigest
        || row.state !== "active" || row.queue_id && row.queue_id !== queueId) throw new Error("queued_input_adoption_changed");
      db.prepare("UPDATE queued_owner_inputs SET queue_id=? WHERE owner_id=?").run(queueId,owner.ownerId);
    },
    reserve(owner: QueuedInputOwner, request: McpInvocationRequest, epoch: string): void {
      exact(owner);
      if (!request.runId) throw new Error("queued_input_run_required");
      assertRunOrigin(owner,request.runId);
      db.prepare("INSERT INTO queued_owner_input_attempts VALUES (?,?,?,?,'reserved',NULL)").run(request.runId,owner.ownerId,epoch,queuedInputRequestDigest(request));
    },
    begin(owner: QueuedInputOwner, request: McpInvocationRequest, epoch: string): void {
      exact(owner);
      if (!request.runId) throw new Error("queued_input_run_required");
      assertRunOrigin(owner,request.runId);
      const prior=db.prepare("SELECT state FROM queued_owner_input_attempts WHERE run_id=?").get(request.runId) as {state:string}|undefined;
      if (prior) {
        const changed=db.prepare("UPDATE queued_owner_input_attempts SET state='open' WHERE run_id=? AND owner_id=? AND epoch=? AND request_digest=? AND state='reserved'")
          .run(request.runId,owner.ownerId,epoch,queuedInputRequestDigest(request));
        if (changed.changes !== 1) throw new Error("queued_input_attempt_changed");
      } else db.prepare("INSERT INTO queued_owner_input_attempts VALUES (?,?,?,?,'open',NULL)").run(request.runId,owner.ownerId,epoch,queuedInputRequestDigest(request));
    },
    closeReserved(runId:string): boolean {
      return db.prepare("UPDATE queued_owner_input_attempts SET state='closed-before-source',closed_at=? WHERE run_id=? AND state='reserved'").run(Date.now(),runId).changes===1;
    },
    bindAttempt(owner: QueuedInputOwner, request: McpInvocationRequest, epoch: string): void {
      const changed = db.prepare("UPDATE queued_owner_input_attempts SET request_digest=? WHERE run_id=? AND owner_id=? AND epoch=? AND state='open'")
        .run(queuedInputRequestDigest(request),request.runId,owner.ownerId,epoch);
      if (changed.changes !== 1) throw new Error("queued_input_attempt_changed");
      // Main-issued refs are retained for revocation/cleanup only. No execution
      // path reads these as a grant or reconstructs a capability from SQL.
      db.prepare("INSERT INTO queued_owner_input_cleanup_refs VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET refs_json=excluded.refs_json")
        .run(request.runId,JSON.stringify({oneAttachmentRef:request.oneAttachmentRef,oneTeamPreflightRef:request.oneTeamPreflightRef}));
    },
    cleanupRefs(owner: QueuedInputOwner): Pick<McpInvocationRequest,"oneAttachmentRef"|"oneTeamPreflightRef">[] {
      exact(owner);
      return (db.prepare("SELECT r.refs_json FROM queued_owner_input_cleanup_refs r JOIN queued_owner_input_attempts a ON a.run_id=r.run_id WHERE a.owner_id=?")
        .all(owner.ownerId) as {refs_json:string}[]).map(row=>JSON.parse(row.refs_json));
    },
    closeBeforeSource(runId: string, epoch: string): void {
      const changed = db.prepare("UPDATE queued_owner_input_attempts SET state='closed-before-source',closed_at=? WHERE run_id=? AND epoch=? AND state='open'")
        .run(Date.now(),runId,epoch);
      if (changed.changes !== 1) throw new Error("queued_input_attempt_changed");
    },
    attemptHead(owner: QueuedInputOwner): QueuedInputAttempt | null {
      exact(owner);
      const row=db.prepare("SELECT attempt_json FROM queued_owner_input_attempt_heads WHERE owner_id=?").get(owner.ownerId) as {attempt_json:string}|undefined;
      return row ? JSON.parse(row.attempt_json) as QueuedInputAttempt : null;
    },
    sealAttempt(owner: QueuedInputOwner, previous: QueuedInputAttempt | null, next: QueuedInputAttempt): void {
      exact(owner);
      const row=db.prepare("SELECT attempt_json FROM queued_owner_input_attempt_heads WHERE owner_id=?").get(owner.ownerId) as {attempt_json:string}|undefined;
      if (queuedInputDigest(row ? JSON.parse(row.attempt_json) : null) !== queuedInputDigest(previous)) throw new Error("queued_input_attempt_changed");
      db.prepare("INSERT INTO queued_owner_input_attempt_heads VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET attempt_json=excluded.attempt_json").run(owner.ownerId,JSON.stringify(next));
    },
    seal(owner: QueuedInputOwner, kind: string, digest: string): void {
      exact(owner);
      db.prepare("INSERT OR IGNORE INTO queued_owner_input_resources VALUES (?,?,?)").run(owner.ownerId,kind,digest);
      const row = db.prepare("SELECT digest FROM queued_owner_input_resources WHERE owner_id=? AND kind=?").get(owner.ownerId,kind) as {digest:string}|undefined;
      if (row?.digest !== digest) throw new Error("queued_input_resource_changed");
    },
    assertResource(owner: QueuedInputOwner, kind: string, digest: string): void {
      const row = db.prepare("SELECT digest FROM queued_owner_input_resources WHERE owner_id=? AND kind=?").get(owner.ownerId,kind) as {digest:string}|undefined;
      if (row?.digest !== digest) throw new Error("queued_input_resource_changed");
    },
    retire(owner: QueuedInputOwner, state: "placed"|"cancelled"): void {
      exact(owner);
      db.prepare("UPDATE queued_owner_inputs SET state=?,cleanup_done=1,request_json='null' WHERE owner_id=?").run(state,owner.ownerId);
      // Retain value-free identity/attempt tombstones to refuse response-loss
      // replay. Only its digest remains; the redundant raw owner input is removed.
      db.prepare("DELETE FROM queued_owner_input_resources WHERE owner_id=?").run(owner.ownerId);
      db.prepare("DELETE FROM queued_owner_input_cleanup_refs WHERE run_id IN (SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=?)").run(owner.ownerId);
    },
  };
}
