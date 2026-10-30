import { createHash } from "node:crypto";
import { followupRequestJson } from "../../shared/followup-custody";
import type { InvocationCurrentTurnSteerRequest, InvocationCurrentTurnSteerReceipt, McpInvocationRequest } from "../../shared/types";
import type { CurrentTurnSteerSqliteDb } from "./current-turn-steer-core";

export const FOLLOWUP_SOURCE_CLOSED = "followup_source_closed_for_next_turn";
export const FOLLOWUP_STOPPED = "followup_owner_stopped";
const SAFE_REJECTIONS = new Set(["owner_control_run_settled", "owner_control_not_dispatched", "owner_control_run_stopped", FOLLOWUP_STOPPED]);
export interface FollowupCapture {
  intent_id: string; chat_id: string; origin_run_id: string; account_digest: string;
  request_json: string; request_hash: string; state: "entered" | "stopped"; queue_id: string | null;
  closed_attempt_run_id: string | null;
}
type Source = { chat_id: string; run_id: string; prompt_text: string; prompt_hash: string;
  message_id: string; status: InvocationCurrentTurnSteerReceipt["status"]; code: string | null };

/** Host-owned capture is separate from the original source's once-only intake.
 * Both claims share SQLite with every current Desktop/daemon/Terminal reader. */
export function createFollowupCustodyStore(ports: {
  db: CurrentTurnSteerSqliteDb;
  accountDigest(request: McpInvocationRequest): string;
  appendUserMessage(request: McpInvocationRequest): { id: string };
  now?(): string;
}) {
  const { db } = ports;
  const now = ports.now ?? (() => new Date().toISOString());
  const get = (chatId: string, intentId: string): FollowupCapture | null => {
    const row = db.prepare("SELECT * FROM invocation_followup_custody WHERE intent_id=?").get(intentId) as FollowupCapture | undefined;
    if (row && row.chat_id !== chatId) throw new Error("followup_identity_conflict");
    return row ?? null;
  };
  const source = (intentId: string) => db.prepare("SELECT * FROM invocation_current_turn_steers WHERE intent_id=?").get(intentId) as Source | undefined;
  const exactSource = (row: FollowupCapture): Source | undefined => {
    const saved = source(row.intent_id), request = JSON.parse(row.request_json) as McpInvocationRequest;
    if (saved && (saved.chat_id !== row.chat_id || saved.run_id !== row.origin_run_id || saved.prompt_text !== request.userPrompt)) throw new Error("followup_identity_conflict");
    return saved;
  };
  const requestHasResources = (request: McpInvocationRequest) => Boolean(request.images?.length || request.fileGroupId || request.oneAttachmentRef || request.oneTeamPreflightRef);
  const exactMessage = (chatId: string, messageId: string, text: string): boolean => Boolean(messageId && db.prepare(
    "SELECT 1 FROM chat_messages WHERE id=? AND chat_id=? AND role='user' AND text=?").get(messageId, chatId, text));
  function capture(input: InvocationCurrentTurnSteerRequest): { row: FollowupCapture; fresh: boolean } {
    const request = input.fallbackRequest;
    if (!request || request.chatId !== input.chatId || request.userPrompt !== input.text || request.promptOrigin === "system"
      || typeof input.expectedRunId !== "string" || !input.expectedRunId || typeof input.text !== "string" || !input.text.trim()
      || typeof input.intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.intentId)) throw new Error("followup_input_invalid");
    const json = followupRequestJson(request);
    if (Buffer.byteLength(json, "utf8") > 1_000_000) throw new Error("followup_input_too_large");
    const digest = createHash("sha256").update(json, "utf8").digest("hex"), account = ports.accountDigest(request);
    return db.transaction(() => {
      const prior = get(input.chatId, input.intentId);
      if (prior) {
        if (prior.origin_run_id !== input.expectedRunId || prior.request_json !== json || prior.request_hash !== digest
          || prior.account_digest !== account) throw new Error("followup_identity_conflict");
        exactSource(prior);
        return { row: prior, fresh: false };
      }
      const oldSource = source(input.intentId);
      if (oldSource) throw new Error("followup_legacy_identity_requires_reconciliation");
      const timestamp = now();
      db.prepare(`INSERT INTO invocation_followup_custody
        (intent_id,chat_id,origin_run_id,account_digest,request_json,request_hash,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'entered',?,?)`).run(input.intentId, input.chatId, input.expectedRunId, account, json, digest, timestamp, timestamp);
      return { row: get(input.chatId, input.intentId)!, fresh: true };
    }).immediate();
  }
  function receipt(chatId: string, intentId: string): InvocationCurrentTurnSteerReceipt | null {
    const row = get(chatId, intentId);
    if (!row) return null;
    const saved = exactSource(row), request = JSON.parse(row.request_json) as McpInvocationRequest;
    if (row.account_digest !== ports.accountDigest(request)) throw new Error("followup_owner_changed");
    return { chatId, intentId, runId: row.origin_run_id, receiptVersion: 2, requestHash: row.request_hash,
      origin: { kind: "current-turn", runId: row.origin_run_id }, delivery: { kind: "current-turn", runId: row.origin_run_id },
      promptHash: createHash("sha256").update(request.userPrompt, "utf8").digest("hex"), messageId: saved?.message_id ?? "",
      status: row.state === "stopped" && (!saved || saved.status === "queued" || saved.status === "rejected") ? "rejected" : saved?.status ?? "uncertain",
      code: row.state === "stopped" ? FOLLOWUP_STOPPED : saved?.code ?? (saved ? undefined : "followup_source_outcome_unknown"),
      messageCustody: saved && !requestHasResources(request) && exactMessage(chatId, saved.message_id, request.userPrompt) ? "exact" : "unconfirmed" };
  }
  /** Positive no-intake CAS and next-turn custody commit together. An absence
   * observed outside this transaction is never used as no-effect evidence. */
  function handoff(input: InvocationCurrentTurnSteerRequest, enqueue: (request: McpInvocationRequest, messageId?: string) => { id: string; messageId: string }): string | null {
    return db.transaction(() => {
      const row = get(input.chatId, input.intentId);
      if (!row || row.account_digest !== ports.accountDigest(JSON.parse(row.request_json) as McpInvocationRequest)) throw new Error("followup_identity_conflict");
      if (row.queue_id) {
        if (input.resume === true) {
          const changed = db.prepare(`UPDATE pending_chat_sends SET state='queued',run_id=NULL,last_code=NULL,updated_at=?
            WHERE id=? AND state='held' AND ((run_id IS NULL AND last_code=?) OR run_id=?)`)
            .run(Date.now(),row.queue_id,FOLLOWUP_STOPPED,row.closed_attempt_run_id).changes;
          if (changed === 1) db.prepare("UPDATE invocation_followup_custody SET state='entered',updated_at=? WHERE intent_id=?").run(now(),row.intent_id);
        }
        return row.queue_id;
      }
      if (row.state === "stopped" && input.resume !== true) return null;
      const saved = exactSource(row);
      if (saved && (saved.status !== "rejected" || !SAFE_REJECTIONS.has(saved.code ?? ""))) return null;
      if (saved && ["owner_control_run_stopped",FOLLOWUP_STOPPED].includes(saved.code ?? "") && input.resume !== true) return null;
      const request = JSON.parse(row.request_json) as McpInvocationRequest;
      // Opaque resources need their own capture/reprepare flow. Retain exact
      // text and refs here; never make them executable through a text fallback.
      if (request.fileGroupId || request.oneAttachmentRef || request.oneTeamPreflightRef) return null;
      const next = enqueue(request, saved?.message_id);
      if (!exactMessage(row.chat_id, next.messageId, request.userPrompt)) throw new Error("followup_message_custody_missing");
      const timestamp = now();
      if (saved) {
        const changed = db.prepare(`UPDATE invocation_current_turn_steers SET code=?,updated_at=?
          WHERE intent_id=? AND status='rejected' AND code=?`).run(FOLLOWUP_SOURCE_CLOSED, timestamp, row.intent_id, saved.code).changes;
        if (changed !== 1) throw new Error("followup_source_closure_lost");
      } else {
        db.prepare(`INSERT INTO invocation_current_turn_steers
          (intent_id,chat_id,run_id,prompt_text,prompt_hash,message_id,binding_json,status,code,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'rejected',?,?,?)`).run(row.intent_id, row.chat_id, row.origin_run_id, request.userPrompt,
          createHash("sha256").update(request.userPrompt, "utf8").digest("hex"), next.messageId,
          JSON.stringify({ source: "followup-custody-v2", deliveryKind: "queue", queueId: next.id }), FOLLOWUP_SOURCE_CLOSED, timestamp, timestamp);
      }
      db.prepare("UPDATE invocation_followup_custody SET queue_id=?,state='entered',updated_at=? WHERE intent_id=?")
        .run(next.id, timestamp, row.intent_id);
      return next.id;
    }).immediate();
  }
  /** Stop closes every not-yet-entered original source and pauses only its
   * exact queued successor. No account/revision check can disable Stop. */
  function stopRun(runId: string): string[] {
    return db.transaction(() => {
      const rows = db.prepare(`SELECT * FROM invocation_followup_custody WHERE origin_run_id=?
        OR queue_id IN (SELECT id FROM pending_chat_sends WHERE run_id=?)`).all(runId, runId) as FollowupCapture[];
      const active = new Set<string>();
      for (const row of rows) {
        const request = JSON.parse(row.request_json) as McpInvocationRequest, saved = exactSource(row), timestamp = now();
        if (!saved) {
          const message = ports.appendUserMessage(request);
          db.prepare(`INSERT INTO invocation_current_turn_steers
            (intent_id,chat_id,run_id,prompt_text,prompt_hash,message_id,binding_json,status,code,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,'rejected',?,?,?)`).run(row.intent_id,row.chat_id,row.origin_run_id,request.userPrompt,
              createHash("sha256").update(request.userPrompt,"utf8").digest("hex"),message.id,
              JSON.stringify({ source:"followup-custody-v2",deliveryKind:"queue" }),FOLLOWUP_STOPPED,timestamp,timestamp);
        } else if (saved.status === "queued") {
          db.prepare("UPDATE invocation_current_turn_steers SET status='rejected',code=?,updated_at=? WHERE intent_id=? AND status='queued'")
            .run(FOLLOWUP_STOPPED,timestamp,row.intent_id);
        }
        if (row.queue_id) {
          const pending = db.prepare("SELECT run_id FROM pending_chat_sends WHERE id=?").get(row.queue_id) as {run_id:string|null}|undefined;
          if (pending?.run_id) active.add(pending.run_id);
          db.prepare("UPDATE pending_chat_sends SET state='held',last_code=?,updated_at=? WHERE id=? AND state IN ('queued','starting')")
            .run(FOLLOWUP_STOPPED,Date.now(),row.queue_id);
        }
        db.prepare("UPDATE invocation_followup_custody SET state='stopped',updated_at=? WHERE intent_id=?").run(timestamp,row.intent_id);
      }
      return [...active];
    }).immediate();
  }
  const recoverable = (): FollowupCapture[] => db.prepare(`SELECT f.* FROM invocation_followup_custody f
    JOIN invocation_current_turn_steers s ON s.intent_id=f.intent_id AND s.chat_id=f.chat_id AND s.run_id=f.origin_run_id
    WHERE f.state='entered' AND f.queue_id IS NULL AND s.status='rejected'
      AND s.code IN ('owner_control_run_settled','owner_control_not_dispatched')`).all() as FollowupCapture[];
  return { capture, get, receipt, handoff, stopRun, exactMessage, recoverable };
}
