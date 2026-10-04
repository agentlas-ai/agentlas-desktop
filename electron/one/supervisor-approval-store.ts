import type Database from "better-sqlite3";
import type { ToolApprovalDecision, ToolApprovalDurableConsentReceipt, ToolApprovalRequestEvent, ToolApprovalResolutionReceipt } from "../../shared/types";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import { supervisorHash } from "./supervisor-store";
import { redactSecrets } from "../../shared/secret-patterns";

interface ApprovalRow {
  id: string; owner_epoch: string; owner_identity: string; chat_id: string; request_json: string; request_hash: string;
  status: "pending" | "resolved" | "expired";
  expires_at: number; lease_until: number; decision: ToolApprovalDecision | null;
  action_id: string | null; decided_at: string | null; reason: string | null;
  consent_json: string | null;
}
export interface DurableToolApprovalOwner {
  epoch: string;
  identity: string;
  /** The native caller seals this; neither model text nor a UI chooses it. */
  leaseUntil: number;
}
/** Exact decision receipts survive a renderer/host restart. An old receipt is
 * display evidence, never permission for a replacement provider to replay a tool.
 * Runtime waiters and policy checks must use consume() under their own live epoch.
 */
export class OneSupervisorApprovalStore {
  constructor(readonly db: Database.Database, schemaOwner = true, private readonly now = Date.now) {
    if (schemaOwner) db.exec(`
      CREATE TABLE IF NOT EXISTS one_supervisor_tool_approvals (
        id TEXT PRIMARY KEY, owner_epoch TEXT NOT NULL, owner_identity TEXT NOT NULL, chat_id TEXT NOT NULL,
        request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','resolved','expired')),
        expires_at INTEGER NOT NULL, lease_until INTEGER NOT NULL,
        decision TEXT, action_id TEXT, decided_at TEXT, reason TEXT, consent_json TEXT
      );
      CREATE INDEX IF NOT EXISTS one_supervisor_tool_approval_pending ON one_supervisor_tool_approvals(status,expires_at);
      CREATE INDEX IF NOT EXISTS one_supervisor_tool_approval_identity ON one_supervisor_tool_approvals(owner_identity,status,chat_id);
    `);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_tool_approvals'").get()) {
      throw new Error("supervisor_approval_schema_not_ready");
    }
  }
  private row(id: string): ApprovalRow | null {
    return this.db.prepare("SELECT * FROM one_supervisor_tool_approvals WHERE id=?").get(id) as ApprovalRow | undefined ?? null;
  }
  private receipt(row: ApprovalRow, requestedDecision: ToolApprovalDecision | null, replay = false): ToolApprovalResolutionReceipt {
    const status = row.status === "pending" ? "pending" : row.status === "expired" ? "expired"
      : requestedDecision && requestedDecision !== row.decision ? "conflict" : replay ? "replayed" : "resolved";
    return {ok: status === "resolved" || status === "replayed", receiptVersion: 1, requestId: row.id,
      requestedDecision, resolvedDecision: row.decision, actionId: row.action_id, status,
      pending: row.status === "pending", decidedAt: row.decided_at,
      ...(row.decision === "allow_always" ? {durableConsent: row.consent_json
        ? JSON.parse(row.consent_json) as ToolApprovalDurableConsentReceipt
        : {status: "failed" as const, code: "storage-receipt-missing" as const}} : {})};
  }
  private missing(id: string, decision: ToolApprovalDecision | null, status: "not_found" | "invalid_action"): ToolApprovalResolutionReceipt {
    return {ok: false, receiptVersion: 1, requestId: id, requestedDecision: decision,
      resolvedDecision: null, actionId: null, status, pending: false, decidedAt: null};
  }
  persist(request: ToolApprovalRequestEvent, owner: DurableToolApprovalOwner): void {
    const expiresAt = Date.parse(request.expiresAt ?? "");
    if (request.mode !== "live" || !request.id || !request.chatId || !owner.epoch || owner.epoch.length > 200
      || !owner.identity || owner.identity.length > 256
      || (request.consentBinding && request.consentBinding.userIdentity !== owner.identity)
      || !Number.isSafeInteger(owner.leaseUntil) || owner.leaseUntil <= this.now()
      || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw new Error("supervisor_approval_binding_invalid");
    const {id, runtime, tool, detail, cwd, mode, deniedBy, requestedAt, expiresAt: expiry, chatId, capability, agentId, consentBinding} = request;
    const projection: ToolApprovalRequestEvent = {id, runtime, tool, mode, requestedAt, chatId, expiresAt: expiry,
      ...(detail ? {detail: redactSecrets(detail)} : {}), ...(cwd ? {cwd: redactSecrets(cwd)} : {}),
      ...(deniedBy ? {deniedBy} : {}), ...(capability ? {capability} : {}), ...(agentId ? {agentId} : {}),
      ...(consentBinding ? {consentBinding} : {})};
    const json = JSON.stringify(projection), hash = supervisorHash([owner.epoch, owner.identity, request]);
    if (Buffer.byteLength(json, "utf8") > 64 * 1024) throw new Error("supervisor_approval_request_too_large");
    this.db.transaction(() => {
      const prior = this.row(request.id);
      if (prior) {
        if (prior.request_hash !== hash) throw new Error("supervisor_approval_identity_conflict");
        return;
      }
      if ((this.db.prepare("SELECT count(*) AS n FROM one_supervisor_tool_approvals WHERE owner_identity=? AND status='pending'")
        .get(owner.identity) as {n: number}).n >= 200) throw new Error("supervisor_approval_capacity");
      this.db.prepare(`INSERT INTO one_supervisor_tool_approvals(id,owner_epoch,owner_identity,chat_id,request_json,request_hash,status,expires_at,lease_until)
        VALUES(?,?,?,?,?,?,'pending',?,?)`).run(request.id, owner.epoch, owner.identity, request.chatId, json, hash, expiresAt, owner.leaseUntil);
    }).immediate();
  }
  heartbeat(ownerEpoch: string, leaseUntil: number): void {
    if (!Number.isSafeInteger(leaseUntil) || leaseUntil <= this.now()) throw new Error("supervisor_approval_lease_invalid");
    this.db.prepare(`UPDATE one_supervisor_tool_approvals SET lease_until=?
      WHERE owner_epoch=? AND status='pending' AND expires_at>? AND lease_until>?`).run(leaseUntil, ownerEpoch, this.now(), this.now());
  }
  expire(): number {
    return Number(this.db.prepare(`UPDATE one_supervisor_tool_approvals SET status='expired',decision='deny',decided_at=?,reason=?
      WHERE status='pending' AND (expires_at<=? OR lease_until<=?)`)
      .run(new Date(this.now()).toISOString(), "request_or_owner_expired", this.now(), this.now()).changes);
  }
  listPending(identity: string, chatIds?: readonly string[]): ToolApprovalRequestEvent[] {
    this.expire();
    // Scope is decided by the native caller, rather than exposing every stored
    // account/chat to a renderer. Read errors are not converted into an empty queue.
    if (!identity || (chatIds && (chatIds.length > 128 || chatIds.some(id => !id || id.length > 256)))) throw new Error("supervisor_approval_scope_invalid");
    if (chatIds?.length === 0) return [];
    return (this.db.prepare(`SELECT request_json FROM one_supervisor_tool_approvals WHERE status='pending' AND owner_identity=?
      ${chatIds ? `AND chat_id IN (${chatIds.map(() => "?").join(",")})` : ""} ORDER BY rowid LIMIT 200`)
      .all(identity, ...(chatIds ?? [])) as Array<{request_json: string}>).map(row => JSON.parse(row.request_json) as ToolApprovalRequestEvent);
  }
  get(id: string): ToolApprovalResolutionReceipt {
    this.expire();
    const row = this.row(id);
    return row ? this.receipt(row, null) : this.missing(id, null, "not_found");
  }
  decide(id: string, decision: ToolApprovalDecision, actionId: string,
    assertCurrent: (request: ToolApprovalRequestEvent) => void): ToolApprovalResolutionReceipt {
    if (!["allow_once", "allow_session", "allow_always", "deny"].includes(decision)
      || actionId !== toolApprovalActionId(id, decision)) return this.missing(id, decision, "invalid_action");
    return this.db.transaction(() => {
      this.expire();
      const prior = this.row(id);
      if (!prior) return this.missing(id, decision, "not_found");
      // A replay may report an old decision; it cannot grant an old provider's
      // authority to a new owner. consume() checks epoch/lifetime independently.
      if (prior.status !== "pending") return this.receipt(prior, decision, true);
      assertCurrent(JSON.parse(prior.request_json) as ToolApprovalRequestEvent);
      const changed = this.db.prepare(`UPDATE one_supervisor_tool_approvals SET status='resolved',decision=?,action_id=?,decided_at=?
        WHERE id=? AND status='pending' AND lease_until>? AND expires_at>?`)
        .run(decision, actionId, new Date(this.now()).toISOString(), id, this.now(), this.now());
      if (changed.changes !== 1) throw new Error("supervisor_approval_state_conflict");
      return this.receipt(this.row(id)!, decision);
    }).immediate();
  }
  consume(id: string, ownerEpoch: string, assertCurrent: (request: ToolApprovalRequestEvent) => void):
    {decision: ToolApprovalDecision; decidedAt: string} | null {
    const row = this.row(id);
    if (!row || row.status !== "resolved" || row.owner_epoch !== ownerEpoch || !row.decision || !row.decided_at
      || row.lease_until <= this.now() || row.expires_at <= this.now()) return null;
    // Revocation, run cancellation, private identity, native resource and policy
    // revision checks belong here, immediately before the runtime receives allow.
    assertCurrent(JSON.parse(row.request_json) as ToolApprovalRequestEvent);
    return {decision: row.decision, decidedAt: row.decided_at};
  }
  /** A new Main run owns no earlier run's waiter: what an earlier run left pending can no longer be answered. */
  retireEarlierOwners(ownerEpoch: string): number {
    return Number(this.db.prepare(`UPDATE one_supervisor_tool_approvals SET status='expired',decision='deny',decided_at=?,reason='owner_restarted'
      WHERE status='pending' AND owner_epoch!=?`).run(new Date(this.now()).toISOString(), ownerEpoch).changes);
  }
  /** Keeps the newest settled receipts; pending rows are never pruned. */
  prune(keepSettled = 1000): number {
    return Number(this.db.prepare(`DELETE FROM one_supervisor_tool_approvals WHERE status!='pending' AND rowid NOT IN
      (SELECT rowid FROM one_supervisor_tool_approvals WHERE status!='pending' ORDER BY rowid DESC LIMIT ?)`)
      .run(Math.max(0, Math.floor(keepSettled))).changes);
  }
  cancel(id: string, ownerEpoch: string): void {
    this.db.prepare(`UPDATE one_supervisor_tool_approvals SET status='expired',decision='deny',decided_at=?,reason='run_cancelled'
      WHERE id=? AND owner_epoch=? AND status='pending'`).run(new Date(this.now()).toISOString(), id, ownerEpoch);
  }
  recordConsent(id: string, ownerEpoch: string, receipt: ToolApprovalDurableConsentReceipt): void {
    // This records the existing native persister's receipt. It never creates,
    // retries or broadens a capability grant itself, including after a restart.
    const json = JSON.stringify(receipt);
    this.db.transaction(() => {
      const row = this.row(id);
      if (!row || row.status !== "resolved" || row.decision !== "allow_always" || row.owner_epoch !== ownerEpoch) {
        throw new Error("supervisor_approval_consent_owner_mismatch");
      }
      if (row.consent_json && row.consent_json !== json) throw new Error("supervisor_approval_consent_conflict");
      this.db.prepare("UPDATE one_supervisor_tool_approvals SET consent_json=? WHERE id=? AND consent_json IS NULL").run(json, id);
    }).immediate();
  }
}
