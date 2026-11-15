import { createHash, createPublicKey, verify } from "node:crypto";
import type Database from "better-sqlite3";
import type { SupervisorTask } from "../../shared/one-supervisor";
import { companionHandoffProofBytes, companionWorkReceiptBytes, COMPANION_WORK_FULL_CHUNK_BYTES, COMPANION_WORK_FULL_MAX_BYTES } from "../../shared/companion-handoff-proof";
import { nativeCompanionPublicKey, signNativeCompanionWorkReceipt, signNativeCompanionWorkFullChunk, type NativeCredential } from "../daemon/native-auth-credentials";
import { supervisorExactResult } from "./supervisor-presentation";
import type { OneSupervisorStore } from "./supervisor-store";
import type { OneSupervisorWorkQueue } from "./supervisor-work-queue";

type Identity = { userId: string; workspaceId: string; authEpoch: number; accountSubject: string; deviceId: string; hostId: string; oneId: string };
type Binding = Identity & { familyId: string; turnId: string; commandId: string; payloadDigest: string; method: string };
type Output = { receipt: Record<string, unknown>; signature: string; truncated: boolean };

/** Confirmed remote retirement fences a still-unstarted local claim before
 * no-start evidence is sent, so a late authorization cannot begin it. */
export function retireCompanionUnstarted(options: {store: OneSupervisorStore; queue: OneSupervisorWorkQueue; commandId: string;
  noStartProof(runId:string):boolean; nativeReceipt(runId:string):unknown}): void {
  options.store.db.transaction(() => {
    const job = options.queue.get(options.commandId), row = options.store.get(options.commandId);
    if (!job || !row || row.kind !== "work" || row.state !== "stored" || row.one_id !== job.one_id || row.task_id !== job.task_id ||
        row.run_id !== job.run_id || !["queued", "claimed"].includes(job.phase) || options.nativeReceipt(job.run_id) || !options.noStartProof(job.run_id)) return;
    if (!options.queue.cancelUnstarted(job)) return;
    options.store.update(row,{state:"cancelled",acknowledgement:"settled",reason:"cancelled_before_dispatch"});
  }).immediate();
}

/** Only used after the service confirms retirement. A terminal notice is
 * durable evidence from the native owner; an unstarted cancellation also
 * requires the admission ledger to prove that this exact run never started. */
export function readCompanionRetirementReceipt(options: {
  db: Database.Database; credential: NativeCredential; commandId: string; assertOwner(): void;
  noStartProof(runId: string): boolean; nativeReceipt(runId: string): unknown;
  carrierRunId?(runId:string,chatId:string):string|null;
}): Output | null {
  try {
    return options.db.transaction(() => {
      options.assertOwner();
      const row = options.db.prepare(`SELECT h.binding_json,r.one_id,r.kind,r.state,r.task_id,r.run_id,r.created_at,r.receipt_json,
        q.phase,q.one_id AS queue_one_id,q.task_id AS queue_task_id,q.chat_id AS queue_chat_id,q.run_id AS queue_run_id FROM one_companion_handoffs h
        JOIN one_supervisor_requests r ON r.command_id=h.command_id JOIN one_supervisor_work_jobs q ON q.command_id=r.command_id
        WHERE h.command_id=?`).get(options.commandId) as {binding_json:string;one_id:string;kind:string;state:string;task_id:string;run_id:string;created_at:string;receipt_json:string;phase:string;queue_one_id:string;queue_task_id:string;queue_chat_id:string;queue_run_id:string} | undefined;
      if (!row || row.kind !== "work" || !row.run_id || row.run_id !== row.queue_run_id || row.one_id !== row.queue_one_id || row.task_id !== row.queue_task_id) return null;
      const carrier=options.carrierRunId?.(row.run_id,row.queue_chat_id) ?? row.run_id;
      if (typeof carrier !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(carrier)) return null;
      const stored = JSON.parse(row.receipt_json) as {acknowledgement?:string;reason?:string};
      const localTerminal = ["completed", "failed", "cancelled"].includes(row.state) && ["completed", "failed", "cancelled"].includes(row.phase) && stored.acknowledgement === "settled";
      const notice = localTerminal && options.db.prepare(`SELECT 1 FROM one_supervisor_notices WHERE one_id=? AND task_id=? AND run_id=? AND created_at>=?
        AND state IN ('completed','failed','cancelled','interrupted') LIMIT 1`).get(row.one_id,row.task_id,carrier,row.created_at);
      const native = options.nativeReceipt(carrier) as {runId?:unknown;chatId?:unknown;status?:unknown} | null;
      const nativeTerminal = !!native && native.runId === carrier && native.chatId === row.queue_chat_id && typeof native.status === "string" &&
        ["completed", "failed", "cancelled", "interrupted"].includes(native.status);
      const neverStarted = carrier === row.run_id && localTerminal && row.phase === "cancelled" && ["cancelled_before_dispatch", "owner_stopped_before_start"].includes(stored.reason ?? "") &&
        !native && options.noStartProof(row.run_id) === true;
      if (!notice && !nativeTerminal && !neverStarted) return null;
      const binding = JSON.parse(row.binding_json) as Binding;
      companionHandoffProofBytes(binding);
      if (binding.method !== "one.work-handoff.send.v1" || binding.commandId !== options.commandId || binding.oneId !== row.one_id) return null;
      const receipt = { userId:binding.userId,workspaceId:binding.workspaceId,authEpoch:binding.authEpoch,accountSubject:binding.accountSubject,
        familyId:binding.familyId,deviceId:binding.deviceId,hostId:binding.hostId,oneId:binding.oneId,turnId:binding.turnId,
        commandId:binding.commandId,payloadDigest:binding.payloadDigest,state:"interrupted",result:"",
        resultDigest:createHash("sha256").update("").digest("hex"),resultVerified:false,fullResultPending:false };
      options.assertOwner();
      return {receipt,signature:signNativeCompanionWorkReceipt(options.credential,receipt),truncated:false};
    }).immediate();
  } catch { return null; }
}
function boundedResult(text: string): { text: string; altered: boolean } {
  const safe = text.replace(/[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "\uFFFD");
  if (safe === text && Buffer.byteLength(safe, "utf8") <= 6000) return { text, altered: false };
  let result = "", size = 0;
  for (const char of safe) { const bytes = Buffer.byteLength(char, "utf8"); if (size + bytes > 5996) break; result += char; size += bytes; }
  return { text: `${result}\n…`, altered: true };
}

/** A trusted Main/daemon owner supplies the current identity and actual task
 * projection. The caller supplies only a command id, never result text. The
 * verified ingress owns `one_companion_handoffs` and must insert its binding
 * in the same transaction as Work admission; this reader never creates it.
 */
export function createCompanionWorkReceiptOwner(options: {
  db: Database.Database; credential: NativeCredential; identity(): Identity | null; tasks(): SupervisorTask[]; assertCurrent(): void;
  carrierRunId?(originalRunId: string, chatId: string): string | null;
  executionReceipt?(runId: string): unknown;
}) {
  const { db, credential } = options;
  function read(commandId: string): Output | null {
    if (typeof commandId !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(commandId)) return null;
    try {
      return db.transaction(() => {
        options.assertCurrent();
        const identity = options.identity();
        if (!identity) return null;
        const row = db.prepare(`SELECT h.binding_json, r.one_id, r.kind, r.state, r.task_id, r.run_id, r.created_at, r.receipt_json, r.payload_json
          FROM one_companion_handoffs h JOIN one_supervisor_requests r ON r.command_id=h.command_id
          WHERE h.command_id=?`).get(commandId) as { binding_json: string; one_id: string; kind: string; state: string; task_id: string | null; run_id: string | null; created_at: string; receipt_json: string; payload_json: string } | undefined;
        if (!row || row.kind !== "work" || row.one_id !== identity.oneId || !row.task_id) return null;
        const binding = JSON.parse(row.binding_json) as Binding;
        companionHandoffProofBytes(binding); // validates the complete, closed binding shape
        if (binding.method !== "one.work-handoff.send.v1" || binding.commandId !== commandId ||
            (["userId", "workspaceId", "authEpoch", "accountSubject", "deviceId", "hostId", "oneId"] as const).some((key) => binding[key] !== identity[key])) return null;
        db.exec(`CREATE TABLE IF NOT EXISTS one_companion_work_receipts (
          command_id TEXT PRIMARY KEY REFERENCES one_supervisor_requests(command_id) ON DELETE CASCADE,
          receipt_json TEXT NOT NULL, signature TEXT NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS one_companion_work_full_results (
          command_id TEXT PRIMARY KEY REFERENCES one_supervisor_requests(command_id) ON DELETE CASCADE,
          result_text TEXT NOT NULL, result_digest TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS one_companion_receipt_delete AFTER DELETE ON one_supervisor_requests BEGIN
          DELETE FROM one_companion_work_receipts WHERE command_id=OLD.command_id;
          DELETE FROM one_companion_work_full_results WHERE command_id=OLD.command_id;
        END;`);
        const saved = db.prepare("SELECT receipt_json,signature FROM one_companion_work_receipts WHERE command_id=?").get(commandId) as { receipt_json: string; signature: string } | undefined;
        if (saved) {
          const receipt = JSON.parse(saved.receipt_json) as Record<string, unknown>;
          const bytes = companionWorkReceiptBytes(receipt), raw = Buffer.from(saved.signature, "base64url");
          const publicKey = createPublicKey({ key: Buffer.from(nativeCompanionPublicKey(credential), "base64url"), format: "der", type: "spki" });
          if (raw.length !== 64 || raw.toString("base64url") !== saved.signature || !verify(null, bytes, publicKey, raw) ||
              (["userId", "workspaceId", "authEpoch", "accountSubject", "familyId", "deviceId", "hostId", "oneId", "turnId", "commandId", "payloadDigest"] as const)
                .some((key) => receipt[key] !== binding[key])) return null;
          options.assertCurrent();
          const full = db.prepare("SELECT 1 FROM one_companion_work_full_results WHERE command_id=?").get(commandId);
          return { receipt, signature: saved.signature, truncated: !!full };
        }
        const storedReceipt = JSON.parse(row.receipt_json) as { acknowledgement?: string };
        let state: string, result = "", resultVerified = false, executionModel: string | null = null, executionHost: "desktop" | "daemon" | "terminal" | null = null;
        if (row.state === "accepted" && storedReceipt.acknowledgement === "delivered") state = "accepted";
        else {
          if (!["completed", "failed", "cancelled"].includes(row.state) || storedReceipt.acknowledgement !== "settled") return null;
          const workerChatId = (JSON.parse(row.payload_json) as { workerChatId?: unknown }).workerChatId;
          if (typeof workerChatId !== "string" || !row.run_id) return null;
          const carrier = options.carrierRunId?.(row.run_id,workerChatId) ?? row.run_id;
          if (typeof carrier !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(carrier)) return null;
          const notice = db.prepare(`SELECT run_id,state FROM one_supervisor_notices WHERE one_id=? AND task_id=? AND created_at>=?
            AND run_id=? AND state IN ('completed','failed','cancelled','interrupted') ORDER BY rowid DESC LIMIT 1`).get(identity.oneId, row.task_id, row.created_at,carrier) as { run_id: string; state: string } | undefined;
          if (!notice) return null;
          state = notice.state;
          // V3 is opt-in: both facts must come from the exact terminal carrier
          // run, never the requested model or the process doing this read.
          if (options.executionReceipt) {
            const evidence = options.executionReceipt(carrier) as {runId?:unknown;chatId?:unknown;status?:unknown;model?:unknown} | null;
            if (evidence && evidence.runId === carrier && evidence.chatId === workerChatId &&
                ["completed", "failed", "cancelled", "interrupted"].includes(String(evidence.status))) {
              if (typeof evidence.model === "string" && evidence.model.trim().length > 0 && evidence.model.length <= 160 && !/[\p{Cs}\u0000-\u001f\u007f]/u.test(evidence.model)) executionModel = evidence.model;
              const runOwner = db.prepare("SELECT owner_kind FROM invocation_run_owners WHERE run_id=? AND chat_id=?").get(carrier,workerChatId) as {owner_kind?:unknown} | undefined;
              if (runOwner && (runOwner.owner_kind === "desktop" || runOwner.owner_kind === "daemon" || runOwner.owner_kind === "terminal")) executionHost = runOwner.owner_kind;
            }
          }
          const task = options.tasks().find((candidate) => candidate.taskId === row.task_id && candidate.runId === notice.run_id);
          const exact = supervisorExactResult(db, workerChatId, notice.run_id)?.text;
          const source = task?.state === "completed" && typeof task.result === "string" && task.result ? task.result : exact;
          if (state === "completed" && !source) return null;
          if (source) {
            const bounded = boundedResult(source);
            result = bounded.text;
            resultVerified = state === "completed" && !!task && source === task.result && task.resultVerified === true && !bounded.altered;
            if (bounded.altered && state === "completed") db.prepare("INSERT INTO one_companion_work_full_results(command_id,result_text,result_digest) VALUES(?,?,?)")
              .run(commandId, source, createHash("sha256").update(source, "utf8").digest("hex"));
          }
        }
        const truncated = !!db.prepare("SELECT 1 FROM one_companion_work_full_results WHERE command_id=?").get(commandId);
        const receipt = { userId: binding.userId, workspaceId: binding.workspaceId, authEpoch: binding.authEpoch, accountSubject: binding.accountSubject,
          familyId: binding.familyId, deviceId: binding.deviceId, hostId: binding.hostId, oneId: binding.oneId, turnId: binding.turnId,
          commandId, payloadDigest: binding.payloadDigest, state, result, resultDigest: createHash("sha256").update(result, "utf8").digest("hex"), resultVerified, fullResultPending: truncated, ...(options.executionReceipt ? {executionModel, executionHost} : {}) };
        // Accepted is provisional and must not occupy the terminal replay slot.
        const signature = signNativeCompanionWorkReceipt(credential, receipt);
        if (state !== "accepted") db.prepare("INSERT INTO one_companion_work_receipts(command_id,receipt_json,signature) VALUES(?,?,?)")
          .run(commandId, JSON.stringify(receipt), signature);
        options.assertCurrent();
        return { receipt, signature, truncated };
      }).immediate();
    } catch { return null; }
  }
  function readFullChunk(commandId: string, index: number): { chunk: Record<string, unknown>; signature: string } | null {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const signed = read(commandId);
    if (!signed?.truncated) return null;
    try {
      return db.transaction(() => {
        options.assertCurrent();
        const stored = db.prepare("SELECT result_text,result_digest FROM one_companion_work_full_results WHERE command_id=?").get(commandId) as
          { result_text: string; result_digest: string } | undefined;
        if (!stored || typeof stored.result_text !== "string") return null;
        const bytes = Buffer.from(stored.result_text, "utf8"), count = Math.ceil(bytes.length / COMPANION_WORK_FULL_CHUNK_BYTES);
        if (!bytes.length || bytes.length > COMPANION_WORK_FULL_MAX_BYTES || index >= count || createHash("sha256").update(bytes).digest("hex") !== stored.result_digest) return null;
        const part = bytes.subarray(index * COMPANION_WORK_FULL_CHUNK_BYTES, (index + 1) * COMPANION_WORK_FULL_CHUNK_BYTES), r = signed.receipt;
        const chunk = { userId: r.userId, workspaceId: r.workspaceId, authEpoch: r.authEpoch, accountSubject: r.accountSubject, familyId: r.familyId,
          deviceId: r.deviceId, hostId: r.hostId, oneId: r.oneId, turnId: r.turnId, commandId: r.commandId, payloadDigest: r.payloadDigest,
          resultDigest: r.resultDigest, fullDigest: stored.result_digest, totalBytes: bytes.length, index, count,
          chunkDigest: createHash("sha256").update(part).digest("hex"), data: part.toString("base64url") };
        const signature = signNativeCompanionWorkFullChunk(credential, chunk);
        options.assertCurrent();
        return { chunk, signature };
      }).immediate();
    } catch { return null; }
  }
  /** Authenticated local bridge recovery, including results too large for the
   * cloud copy. Each page is bounded and the phone verifies the full digest. */
  function readFullPage(commandId: string, index: number): { index: number; count: number; totalBytes: number; fullDigest: string; data: string } | null {
    if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000 || !read(commandId)?.truncated) return null;
    try {
      return db.transaction(() => {
        options.assertCurrent();
        const row = db.prepare(`SELECT length(CAST(result_text AS BLOB)) AS total_bytes,result_digest,
          substr(CAST(result_text AS BLOB),?,?) AS part FROM one_companion_work_full_results WHERE command_id=?`)
          .get(index * COMPANION_WORK_FULL_CHUNK_BYTES + 1, COMPANION_WORK_FULL_CHUNK_BYTES, commandId) as
          { total_bytes: number; result_digest: string; part: Uint8Array } | undefined;
        if (!row || !Number.isSafeInteger(row.total_bytes) || row.total_bytes < 1 || !(row.part instanceof Uint8Array) ||
            !/^[a-f0-9]{64}$/.test(row.result_digest)) return null;
        const count = Math.ceil(row.total_bytes / COMPANION_WORK_FULL_CHUNK_BYTES);
        if (index >= count || row.part.length !== Math.min(COMPANION_WORK_FULL_CHUNK_BYTES, row.total_bytes - index * COMPANION_WORK_FULL_CHUNK_BYTES)) return null;
        options.assertCurrent();
        return { index, count, totalBytes: row.total_bytes, fullDigest: row.result_digest, data: Buffer.from(row.part).toString("base64url") };
      }).immediate();
    } catch { return null; }
  }
  return Object.freeze({ read, readFullChunk, readFullPage });
}
