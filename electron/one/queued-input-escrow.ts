import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpInvocationRequest } from "../../shared/types";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Main custody, minted before the FIRST start, not from a renderer queue id.
 * ownerId is stable across retries; originRunId is the first reserved run. */
export interface QueuedInputOwner {
  ownerId: string;
  originRunId: string;
  chatId: string;
  submissionId: string;
  requestDigest: string;
}
export interface QueuedInputAttempt { readonly runId: string; readonly revision: number; readonly previousRunId: string | null }
export type QueuedInputOperation = "reserve" | "read" | "adopt" | "attempt" | "complete" | "cancel";
export interface QueuedInputEscrowDependencies {
  root: string;
  /** A shared durable owner transaction (Main and daemon must use the same
   * SQLite owner store). It must serialize the entire synchronous callback. */
  withOwnerLock<T>(owner: QueuedInputOwner, operation: () => T): T;
  /** Verify exact original submission/queue row, chat, permission-bearing
   * request digest and ownership epoch, current account and owner stop. This
   * durable custody is distinct from the consumed capability's short lease.
   * A missing/unknown owner, changed permission or consent must throw. */
  assertOwner(owner: QueuedInputOwner, queueId: string | null, operation: QueuedInputOperation): void;
  /** Called inside the queue's transaction BEFORE its provisional owner is
   * adopted. If that DB transaction rolls back, assertOwner must reject the
   * orphaned adoption; a filesystem record alone never grants execution. */
  assertAdoption(owner: QueuedInputOwner, queueId: string, previousQueueId?: string | null): void;
  /** Immutable digest in the authoritative owner DB, separate from the media
   * manifest. Disk metadata plus a self-reported hash is not an authority. */
  sealResource(owner: QueuedInputOwner, kind: "attachments" | "team", digest: string): void;
  assertResource(owner: QueuedInputOwner, kind: "attachments" | "team", digest: string): void;
  /** SQLite is the attempt authority; the filesystem manifest is a projection. */
  attemptHead(owner: QueuedInputOwner): QueuedInputAttempt | null;
  sealAttempt(owner: QueuedInputOwner, previous: QueuedInputAttempt | null, next: QueuedInputAttempt): void;
  /** not-dispatched requires a closed attempt and typed durable proof of no
   * effect. A missing receipt, live run, stale owner or error is unconfirmed. */
  placement(runId: string): "not-dispatched" | "placed" | "unconfirmed";
  now?(): number;
}
interface Resource { payload: unknown; digest: string; capturedLeaseExpiresAt: number }
interface RecordV1 {
  schemaVersion: 1;
  owner: QueuedInputOwner;
  queueId: string | null;
  attempt: QueuedInputAttempt | null;
  resources: Partial<Record<"attachments" | "team", Resource>>;
}

export class QueuedInputEscrowError extends Error {
  constructor(readonly code: "queued_input_invalid" | "queued_input_owner_changed" | "queued_input_effect_unconfirmed" | "queued_input_already_placed" | "queued_input_expired", message: string) {
    super(message);
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function queuedInputDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
/** Retry run ids and one-use tokens rotate; owner text, permissions, runtime,
 * attachment SET id, proposal/mode and exact Task version do not. Main must
 * also validate both original capabilities before reserving their resources. */
export function queuedInputRequestDigest(request: McpInvocationRequest): string {
  const { runId: _run, preflightSubmissionId: _submission, oneAttachmentRef, oneTeamPreflightRef, ...stable } = request;
  return queuedInputDigest({ ...stable,
    ...(oneAttachmentRef ? { oneAttachmentRef: {
      contractVersion: oneAttachmentRef.contractVersion, attachmentSetId: oneAttachmentRef.attachmentSetId,
    } } : {}),
    ...(oneTeamPreflightRef ? { oneTeamPreflightRef: {
      contractVersion: oneTeamPreflightRef.contractVersion, proposalId: oneTeamPreflightRef.proposalId,
      mode: oneTeamPreflightRef.mode, expectedTaskId: oneTeamPreflightRef.expectedTaskId,
      expectedTaskVersion: oneTeamPreflightRef.expectedTaskVersion,
    } } : {}),
  });
}
function validateOwner(owner: QueuedInputOwner): void {
  if (!owner || Object.keys(owner).sort().join(",") !== "chatId,originRunId,ownerId,requestDigest,submissionId"
    || ![owner.ownerId, owner.originRunId, owner.chatId, owner.submissionId].every(value => typeof value === "string" && ID.test(value))
    || !DIGEST.test(owner.requestDigest)) throw new QueuedInputEscrowError("queued_input_invalid", "Invalid queued input owner");
}
function privateDirectory(directory: string): string {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new QueuedInputEscrowError("queued_input_invalid", "Queued input directory changed");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  return fs.realpathSync.native(directory);
}
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncTreeDirectories(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new QueuedInputEscrowError("queued_input_invalid", "Queued input snapshot contains a symbolic link");
    if (entry.isDirectory()) syncTreeDirectories(path.join(directory, entry.name));
  }
  syncDirectory(directory);
}

/** Durable OWNER INPUT, separate from process-local pending attachments.
 * This module is intentionally not registered as an IPC or model tool. */
export class QueuedInputEscrow {
  constructor(private readonly deps: QueuedInputEscrowDependencies) {}

  private directory(owner: QueuedInputOwner, create: boolean): string {
    validateOwner(owner);
    const root = create ? privateDirectory(this.deps.root) : fs.realpathSync.native(this.deps.root);
    if (!fs.lstatSync(this.deps.root).isDirectory()) throw new QueuedInputEscrowError("queued_input_invalid", "Queued input root changed");
    const directory = path.join(root, queuedInputDigest(owner.ownerId).slice(7));
    if (create) return privateDirectory(directory);
    if (!fs.lstatSync(directory).isDirectory()) throw new QueuedInputEscrowError("queued_input_invalid", "Queued input owner directory changed");
    return directory;
  }
  private read(owner: QueuedInputOwner): { directory: string; record: RecordV1 } {
    const directory = this.directory(owner, false);
    const target = path.join(directory, "owner.json");
    if (!fs.lstatSync(target).isFile()) throw new QueuedInputEscrowError("queued_input_invalid", "Queued input manifest changed");
    const record = JSON.parse(fs.readFileSync(target, "utf8")) as RecordV1;
    if (record.schemaVersion !== 1 || canonical(record.owner) !== canonical(owner)
      || record.queueId !== null && (typeof record.queueId !== "string" || !ID.test(record.queueId))
      || !record.resources || typeof record.resources !== "object" || Array.isArray(record.resources)
      || Object.keys(record.resources).some(kind => kind !== "attachments" && kind !== "team")
      || record.attempt !== null && (!record.attempt || !ID.test(record.attempt.runId)
        || !Number.isSafeInteger(record.attempt.revision) || record.attempt.revision < 1
        || record.attempt.previousRunId !== null && !ID.test(record.attempt.previousRunId))) {
      throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input owner record changed");
    }
    const head = this.deps.attemptHead(owner);
    if (head !== null && (!ID.test(head.runId) || !Number.isSafeInteger(head.revision) || head.revision < 1
      || head.previousRunId !== null && !ID.test(head.previousRunId))) {
      throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input attempt authority changed");
    }
    // A filesystem write can survive a rolled-back adoption/attempt transaction.
    // Only the SQLite head can advance or rewind this projection; editing a
    // manifest to erase an uncertain attempt never creates retry authority.
    record.attempt = head === null ? null : { ...head };
    for (const [kind, resource] of Object.entries(record.resources)) {
      if (!resource || !Number.isFinite(resource.capturedLeaseExpiresAt) || queuedInputDigest(resource.payload) !== resource.digest) {
        throw new QueuedInputEscrowError("queued_input_invalid", "Queued input snapshot changed");
      }
      this.deps.assertResource(owner, kind as "attachments" | "team", resource.digest);
    }
    return { directory, record };
  }
  private write(directory: string, record: RecordV1): void {
    const target = path.join(directory, "owner.json");
    const temporary = path.join(directory, `owner.${process.pid}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
      syncDirectory(directory);
      syncDirectory(path.dirname(directory));
    }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  private checkPrevious(record: RecordV1): void {
    if (!record.attempt) return;
    let placement: ReturnType<QueuedInputEscrowDependencies["placement"]>;
    try { placement = this.deps.placement(record.attempt.runId); }
    catch { throw new QueuedInputEscrowError("queued_input_effect_unconfirmed", "Earlier queued input effect cannot be read"); }
    if (placement === "placed") throw new QueuedInputEscrowError("queued_input_already_placed", "Queued input already reached execution");
    if (placement !== "not-dispatched") throw new QueuedInputEscrowError("queued_input_effect_unconfirmed", "Earlier queued input effect is unconfirmed");
  }
  reserve(owner: QueuedInputOwner, kind: "attachments" | "team", expiresAt: number,
    capture: (directory: string) => unknown): void {
    if (kind !== "attachments" && kind !== "team") throw new QueuedInputEscrowError("queued_input_invalid", "Invalid queued input resource kind");
    this.deps.withOwnerLock(owner, () => {
      this.deps.assertOwner(owner, null, "reserve");
      if (!Number.isFinite(expiresAt) || expiresAt <= (this.deps.now?.() ?? Date.now())) {
        throw new QueuedInputEscrowError("queued_input_expired", "Queued input capability expired before reservation");
      }
      const directory = this.directory(owner, true);
      const target = path.join(directory, "owner.json");
      const record: RecordV1 = fs.existsSync(target) ? this.read(owner).record
        : { schemaVersion: 1, owner: { ...owner }, queueId: null, attempt: null, resources: {} };
      // Record custody before copying media, so even a failed capture has an
      // exact owner and can be cancelled without guessing from a filename.
      if (!fs.existsSync(target)) this.write(directory, record);
      if (record.queueId || record.attempt) throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input was already handed off");
      if (record.resources[kind]) return;
      const resourceDirectory = path.join(directory, kind);
      if (fs.existsSync(resourceDirectory)) throw new QueuedInputEscrowError("queued_input_invalid", "An incomplete input reservation requires owner recovery");
      privateDirectory(resourceDirectory);
      try {
        const payload = capture(resourceDirectory);
        if (!payload || typeof payload !== "object" || typeof (payload as { then?: unknown }).then === "function") {
          throw new QueuedInputEscrowError("queued_input_invalid", "Queued input capture must be synchronous JSON");
        }
        syncTreeDirectories(resourceDirectory);
        record.resources[kind] = { payload, digest: queuedInputDigest(payload), capturedLeaseExpiresAt: expiresAt };
        this.deps.sealResource(owner, kind, record.resources[kind]!.digest);
        this.write(directory, record);
      } catch (error) { fs.rmSync(resourceDirectory, { recursive: true }); throw error; }
    });
  }
  /** Recover only the complete, DB-sealed capture that preceded every source
   * attempt. A partial directory or a digest supplied by the manifest is not proof. */
  confirmCaptured(owner: QueuedInputOwner, kinds: readonly ("attachments"|"team")[]): boolean {
    return this.deps.withOwnerLock(owner,() => {
      const {record}=this.read(owner);
      this.deps.assertOwner(owner,null,"reserve");
      return record.queueId===null && record.attempt===null && kinds.length>0
        && Object.keys(record.resources).sort().join(",")===[...kinds].sort().join(",");
    });
  }
  adopt(owner: QueuedInputOwner, queueId: string): void {
    this.deps.withOwnerLock(owner, () => {
      if (!ID.test(queueId)) throw new QueuedInputEscrowError("queued_input_invalid", "Invalid queue owner");
      const { directory, record } = this.read(owner);
      this.deps.assertAdoption(owner, queueId, record.queueId);
      this.checkPrevious(record);
      record.queueId = queueId;
      this.write(directory, record);
    });
  }
  beginAttempt(owner: QueuedInputOwner, runId: string): QueuedInputAttempt {
    return this.deps.withOwnerLock(owner, () => {
      if (!ID.test(runId)) throw new QueuedInputEscrowError("queued_input_invalid", "Invalid queued input run");
      const { directory, record } = this.read(owner);
      this.deps.assertOwner(owner, record.queueId, "attempt");
      // Capture required a live short lease. Once Main took durable owner
      // custody, waiting does not revoke the person's request; current owner
      // authority and the adapters' exact content/scope checks govern retry.
      // Same-run calls may observe a receipt, but must never mint another ref.
      if (record.attempt?.runId === runId) throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input attempt is already reserved");
      if (!record.attempt && runId !== owner.originRunId && !record.queueId) {
        throw new QueuedInputEscrowError("queued_input_owner_changed", "Provisional input belongs to its original run");
      }
      this.checkPrevious(record);
      const next = { runId, revision: (record.attempt?.revision ?? 0) + 1, previousRunId: record.attempt?.runId ?? null };
      this.deps.sealAttempt(owner,record.attempt,next);
      record.attempt = next;
      this.write(directory, record);
      return Object.freeze({ ...record.attempt });
    });
  }
  withAttempt<T>(owner: QueuedInputOwner, attempt: QueuedInputAttempt, action: () => T): T {
    return this.deps.withOwnerLock(owner, () => {
      const { record } = this.read(owner);
      this.deps.assertOwner(owner, record.queueId, "read");
      if (!record.attempt || canonical(record.attempt) !== canonical(attempt)) {
        throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input ownership or attempt changed");
      }
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new QueuedInputEscrowError("queued_input_invalid", "Queued input owner transaction cannot outlive its synchronous callback");
      }
      return result;
    });
  }
  resource(owner: QueuedInputOwner, kind: "attachments" | "team", attempt: QueuedInputAttempt): { payload: unknown; directory: string } {
    if (kind !== "attachments" && kind !== "team") throw new QueuedInputEscrowError("queued_input_invalid", "Invalid queued input resource kind");
    return this.deps.withOwnerLock(owner, () => {
      const { directory, record } = this.read(owner);
      this.deps.assertOwner(owner, record.queueId, "read");
      if (!record.attempt || canonical(record.attempt) !== canonical(attempt)) {
        throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input attempt changed");
      }
      const resource = record.resources[kind];
      if (!resource) {
        throw new QueuedInputEscrowError("queued_input_expired", "Queued input is unavailable");
      }
      // A single-use ref must be issued only once by the adapter. Mark that
      // issue durably before returning bytes, including across module reloads.
      const issued = path.join(directory, `${kind}.${attempt.revision}.issued`);
      let fd: number;
      try { fd = fs.openSync(issued, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new QueuedInputEscrowError("queued_input_owner_changed", "Queued input ref was already issued for this attempt");
        }
        throw error;
      }
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(directory);
      return { payload: resource.payload, directory: privateDirectory(path.join(directory, kind)) };
    });
  }
  finish(owner: QueuedInputOwner, outcome: "placed" | "cancelled", missing?: { queueId: string | null; lastRunId: string | null }): void {
    if (outcome !== "placed" && outcome !== "cancelled") throw new QueuedInputEscrowError("queued_input_invalid", "Invalid queued input settlement");
    this.deps.withOwnerLock(owner, () => {
      if (missing) {
        // Exact DB custody authorizes cleanup, not the untrusted media manifest.
        // Placement additionally names this owner's authoritative latest attempt.
        this.deps.assertOwner(owner,missing.queueId,outcome === "placed" ? "complete" : "cancel");
        if (outcome === "placed") {
          const head=this.deps.attemptHead(owner);
          if (!head || head.runId!==missing.lastRunId || this.deps.placement(head.runId)!=="placed") {
            throw new QueuedInputEscrowError("queued_input_effect_unconfirmed","Queued input placement is unconfirmed");
          }
        }
        const target=path.join(this.deps.root,queuedInputDigest(owner.ownerId).slice(7));
        if (fs.existsSync(target)) {
          const directory=this.directory(owner,false);
          fs.rmSync(directory,{recursive:true});
          if (fs.existsSync(directory)) throw new QueuedInputEscrowError("queued_input_invalid","Queued input cleanup is incomplete");
          syncDirectory(path.dirname(directory));
        }
        return; // Also recovers exact deletion whose DB commit rolled back.
      }
      const { directory, record } = this.read(owner);
      this.deps.assertOwner(owner, record.queueId, outcome === "placed" ? "complete" : "cancel");
      if (outcome === "placed" && (!record.attempt || this.deps.placement(record.attempt.runId) !== "placed")) {
        throw new QueuedInputEscrowError("queued_input_effect_unconfirmed", "Queued input placement is unconfirmed");
      }
      fs.rmSync(directory, { recursive: true });
      if (fs.existsSync(directory)) throw new QueuedInputEscrowError("queued_input_invalid", "Queued input cleanup is incomplete");
      syncDirectory(path.dirname(directory));
    });
  }
}
