import type Database from "better-sqlite3";
import type { SettledToolApproval, ToolApprovalDecision, ToolApprovalDurableConsentReceipt, ToolApprovalRequestEvent, ToolApprovalResolutionReceipt } from "../../shared/types";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import { supervisorHash } from "./supervisor-store";
import { redactSecrets } from "../../shared/secret-patterns";

/**
 * BB-1a: who closed a settled request, one closed word in the optional column `handled_by`.
 *   desktop | phone      the owner's answer came from this desktop's screen / from the phone (a human answer)
 *   always_allow | full_access | unattended   no card was shown: a saved "always allow" / the run's full access covered a delete or send call, or the run had nobody to ask (BB-1c: an unattended write-mode run; an automatic approval, recorded once, see `recordAuto`)
 * NULL = not said (an expired card, an answer through a path that does not know its device, every row written before this column). Read by `listSettled` (the conversation's quiet line);
 * it lives and dies with its row (`prune` keeps the newest settled rows, as for every settled row).
 */
export type ApprovalHandledBy = "desktop" | "phone" | "always_allow" | "full_access" | "unattended";
const HANDLED_BY: ReadonlySet<string> = new Set(["desktop", "phone", "always_allow", "full_access", "unattended"]);
const AUTO_KINDS: ReadonlySet<string> = new Set(["delete", "send"]);   // money is asked every time and never passes without a card; the other kinds are not asked at all

interface ApprovalRow {
  id: string; owner_epoch: string; owner_identity: string; chat_id: string; request_json: string; request_hash: string;
  status: "pending" | "resolved" | "expired";
  expires_at: number; lease_until: number; decision: ToolApprovalDecision | null;
  action_id: string | null; decided_at: string | null; reason: string | null;
  consent_json: string | null;
  handled_by?: string | null;
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
  /** The ledger of this database has the optional column (added by the schema owner; a reader opened first on an older file simply does not read or write it). */
  private readonly hasHandledBy: boolean;
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
    const hasColumn = (): boolean => (db.prepare("PRAGMA table_info(one_supervisor_tool_approvals)").all() as Array<{ name: string }>).some((column) => column.name === "handled_by");
    // A file made before BB-1a gets the one optional column here, once; the rows it already holds are not rewritten (they stay NULL = not said). A second process adding it at the same moment loses the race harmlessly.
    if (schemaOwner && !hasColumn()) { try { db.exec("ALTER TABLE one_supervisor_tool_approvals ADD COLUMN handled_by TEXT"); } catch { /* added by the other host */ } }
    this.hasHandledBy = hasColumn();
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
    assertCurrent: (request: ToolApprovalRequestEvent) => void, via?: ApprovalHandledBy): ToolApprovalResolutionReceipt {
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
      const handler = this.hasHandledBy && via && HANDLED_BY.has(via) ? via : null;
      const changed = this.db.prepare(`UPDATE one_supervisor_tool_approvals SET status='resolved',decision=?,action_id=?,decided_at=?${handler ? ",handled_by=?" : ""}
        WHERE id=? AND status='pending' AND lease_until>? AND expires_at>?`)
        .run(decision, actionId, new Date(this.now()).toISOString(), ...(handler ? [handler] : []), id, this.now(), this.now());
      if (changed.changes !== 1) throw new Error("supervisor_approval_state_conflict");
      return this.receipt(this.row(id)!, decision);
    }).immediate();
  }
  consume(id: string, ownerEpoch: string, assertCurrent: (request: ToolApprovalRequestEvent) => void):
    {decision: ToolApprovalDecision; decidedAt: string} | null {
    return this.db.transaction(() => {
      const row = this.row(id);
      if (!row || row.status !== "resolved" || row.owner_epoch !== ownerEpoch || !row.decision || !row.decided_at
        || row.lease_until <= this.now() || row.expires_at <= this.now()) return null;
      // Revocation, run cancellation, private identity, native resource and policy
      // revision checks belong here, immediately before the runtime receives allow.
      assertCurrent(JSON.parse(row.request_json) as ToolApprovalRequestEvent);
      // Retire execution authority atomically, keeping the owner's decision as a
      // replayable receipt. The CAS also fences cancellation or a nested consume
      // during the native check; a second host/handle never receives this allow.
      const changed = this.db.prepare(`UPDATE one_supervisor_tool_approvals SET lease_until=0
        WHERE id=? AND status='resolved' AND owner_epoch=? AND request_hash=? AND decision=? AND decided_at=?
          AND lease_until>? AND expires_at>?`)
        .run(id, ownerEpoch, row.request_hash, row.decision, row.decided_at, this.now(), this.now());
      return changed.changes === 1 ? {decision: row.decision, decidedAt: row.decided_at} : null;
    }).immediate();
  }
  /**
   * The answered or closed cards of these conversations, newest last, for the one quiet line the conversation keeps where the card was
   * (Agentlas 2.0 AL). A read of the rows the ledger already keeps (no new table, no new column); the retention is `prune`. Only the
   * closed words and the fields of the redacted request projection leave: no hash, owner identity or consent receipt.
   */
  listSettled(chatIds: readonly string[], limit = 200): SettledToolApproval[] {
    this.expire();
    if (chatIds.length === 0) return [];
    if (chatIds.length > 128 || chatIds.some((id) => !id || id.length > 256)) throw new Error("supervisor_approval_scope_invalid");
    const cap = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT id, chat_id, request_json, status, decision, decided_at, reason${this.hasHandledBy ? ", handled_by" : ""} FROM one_supervisor_tool_approvals
      WHERE status!='pending' AND chat_id IN (${chatIds.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT ?`)
      .all(...chatIds, cap) as Array<{ id: string; chat_id: string; request_json: string; status: "resolved" | "expired"; decision: ToolApprovalDecision | null; decided_at: string | null; reason: string | null; handled_by?: string | null }>;
    const out: SettledToolApproval[] = [];
    for (const row of rows.reverse()) {
      let request: ToolApprovalRequestEvent;
      try { request = JSON.parse(row.request_json) as ToolApprovalRequestEvent; } catch { continue; }
      const outcome = row.status === "expired" ? "expired" : row.decision === "deny" ? "declined" : row.decision ? "approved" : null;
      if (!outcome) continue;
      out.push({
        id: row.id, chatId: row.chat_id, tool: String(request.tool ?? "").slice(0, 200),
        ...(request.detail ? { detail: String(request.detail).slice(0, 600) } : {}),
        ...(request.capability ? { capability: String(request.capability).slice(0, 32) } : {}),
        ...(request.agentId ? { agentId: String(request.agentId).slice(0, 200) } : {}),
        requestedAt: String(request.requestedAt ?? ""), outcome,
        ...(outcome !== "expired" && row.decision ? { choice: row.decision } : {}),
        ...(outcome === "expired" ? { closeReason: row.reason === "run_cancelled" ? "cancelled" as const : row.reason === "owner_restarted" ? "restarted" as const : "timed_out" as const } : {}),
        decidedAt: row.decided_at ?? String(request.requestedAt ?? ""),
        // The device only for a human answer, the basis only for an automatic one; a value this build does not know is not drawn.
        ...(outcome !== "expired" && (row.handled_by === "desktop" || row.handled_by === "phone") ? { device: row.handled_by } : {}),
        ...(request.remoteAsk ? { remote: true as const } : {}),
        ...(outcome === "approved" && (row.handled_by === "always_allow" || row.handled_by === "full_access" || row.handled_by === "unattended") ? { auto: row.handled_by } : {}),
      });
    }
    return out;
  }
  /**
   * BB-1a: a call that went through with no card because a saved "always allow" or the run's full access covered it. One settled row (a record, never an authority: lease 0, so `consume` cannot return it
   * and a restart has nothing to retire), kept only for delete and send calls of a conversation; the same retention as every settled row (`prune`). Anything else is refused (false): a payment is never
   * passed without a card, and a call of no kind is not recorded (no row per ordinary tool call). Returns whether a row was written; never throws on a refusal.
   */
  recordAuto(event: { runtime: string; tool: string; detail?: string; cwd?: string; chatId: string; capability: string; agentId?: string }, owner: { epoch: string; identity: string }, basis: "always_allow" | "full_access" | "unattended"): boolean {
    if (!this.hasHandledBy || !HANDLED_BY.has(basis) || (basis !== "always_allow" && basis !== "full_access" && basis !== "unattended") || !AUTO_KINDS.has(event.capability)) return false;
    if (!event.chatId || event.chatId.length > 256 || !event.tool || !owner.epoch || owner.epoch.length > 200 || !owner.identity || owner.identity.length > 256) return false;
    const at = this.now(), iso = new Date(at).toISOString();
    const id = `auto:${at.toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    const projection: ToolApprovalRequestEvent = { id, runtime: event.runtime, tool: event.tool.slice(0, 200), mode: "live", requestedAt: iso, chatId: event.chatId,
      ...(event.detail ? { detail: redactSecrets(event.detail).slice(0, 600) } : {}), ...(event.cwd ? { cwd: redactSecrets(event.cwd).slice(0, 600) } : {}),
      capability: event.capability, ...(event.agentId ? { agentId: event.agentId.slice(0, 200) } : {}) };
    const json = JSON.stringify(projection);
    if (Buffer.byteLength(json, "utf8") > 64 * 1024) return false;
    this.db.prepare(`INSERT INTO one_supervisor_tool_approvals(id,owner_epoch,owner_identity,chat_id,request_json,request_hash,status,expires_at,lease_until,decision,decided_at,reason,handled_by)
      VALUES(?,?,?,?,?,?,'resolved',?,0,'allow_once',?,?,?)`).run(id, owner.epoch, owner.identity, event.chatId, json, supervisorHash([owner.epoch, owner.identity, projection]), at, iso, "auto_" + basis, basis);
    // The ledger's own keep ("the newest 1000 settled rows", `prune`, which used to run at start only) is applied here too: a run that passes many calls with no card must not grow the table until the next start.
    try { this.prune(); } catch { /* the next start prunes */ }
    return true;
  }
  /**
   * BB-1a: names the device of an answer that was given through a host that holds the request itself (the background service's approvals, answered from this desktop or the phone). Only a row that is
   * resolved and has no device yet; a second answer or a replay never overwrites it. Returns whether the row was marked.
   */
  markHandler(id: string, via: "desktop" | "phone"): boolean {
    if (!this.hasHandledBy || (via !== "desktop" && via !== "phone")) return false;
    return this.db.prepare("UPDATE one_supervisor_tool_approvals SET handled_by=? WHERE id=? AND status='resolved' AND handled_by IS NULL").run(via, id).changes === 1;
  }
  /** The requests of this host's earlier process generations still pending (read just before retireEarlierOwners closes them). */
  pendingOfEarlierOwners(ownerEpoch: string, hostKind: "main" | "daemon" = "main"): Array<{ id: string; chatId: string }> {
    const prefix = `${hostKind}:`;
    if (!ownerEpoch.startsWith(prefix)) return [];
    return (this.db.prepare(`SELECT id, chat_id FROM one_supervisor_tool_approvals WHERE status='pending' AND owner_epoch!=? AND substr(owner_epoch,1,?)=?`)
      .all(ownerEpoch, prefix.length, prefix) as Array<{ id: string; chat_id: string }>).map((row) => ({ id: row.id, chatId: row.chat_id }));
  }
  /** Restart retires this native host's waiters, never the other host's live requests. */
  retireEarlierOwners(ownerEpoch: string, hostKind: "main" | "daemon" = "main"): number {
    const prefix = `${hostKind}:`;
    if ((hostKind !== "main" && hostKind !== "daemon") || !ownerEpoch.startsWith(prefix)
      || ownerEpoch.length <= prefix.length || ownerEpoch.length > 200) {
      throw new Error("supervisor_approval_host_invalid");
    }
    return Number(this.db.prepare(`UPDATE one_supervisor_tool_approvals SET
      status=CASE WHEN status='pending' THEN 'expired' ELSE status END,
      decision=CASE WHEN status='pending' THEN 'deny' ELSE decision END,
      decided_at=CASE WHEN status='pending' THEN ? ELSE decided_at END,lease_until=0,
      reason=CASE WHEN status='pending' THEN 'owner_restarted' ELSE reason END
      WHERE (status='pending' OR status='resolved' AND lease_until>0) AND owner_epoch!=? AND substr(owner_epoch,1,?)=?`)
      .run(new Date(this.now()).toISOString(), ownerEpoch, prefix.length, prefix).changes);
  }
  /** Keeps the newest settled receipts; pending rows are never pruned. */
  prune(keepSettled = 1000): number {
    return Number(this.db.prepare(`DELETE FROM one_supervisor_tool_approvals WHERE status!='pending' AND rowid NOT IN
      (SELECT rowid FROM one_supervisor_tool_approvals WHERE status!='pending' ORDER BY rowid DESC LIMIT ?)`)
      .run(Math.max(0, Math.floor(keepSettled))).changes);
  }
  cancel(id: string, ownerEpoch: string): void {
    this.db.prepare(`UPDATE one_supervisor_tool_approvals SET
      status=CASE WHEN status='pending' THEN 'expired' ELSE status END,
      decision=CASE WHEN status='pending' THEN 'deny' ELSE decision END,
      decided_at=CASE WHEN status='pending' THEN ? ELSE decided_at END,lease_until=0,
      reason=CASE WHEN status='pending' THEN 'run_cancelled' ELSE reason END
      WHERE id=? AND owner_epoch=? AND (status='pending' OR status='resolved' AND lease_until>0)`)
      .run(new Date(this.now()).toISOString(), id, ownerEpoch);
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
