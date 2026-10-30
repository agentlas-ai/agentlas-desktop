import { supervisorError } from "../../shared/one-supervisor";
import type { InvocationRunReceipt, McpInvocationRequest } from "../../shared/types";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { OneSupervisorStore, supervisorHash, type SupervisorRequestRow } from "./supervisor-store";
import { OneSupervisorWorkQueue, type SupervisorWorkLease } from "./supervisor-work-queue";
import {OneBudgetAdmissionDenied} from "./budget-store";
import {TRANSIENT_SEND_DEADLINE_MS,isTransientSendRefusalCode,sendRefusalCode,transientSendBackoffMs, isStoreBusyError } from "../../shared/transient-send-refusal";

export interface SupervisorWorkRuntime {
  start(request: McpInvocationRequest, hostNoticePurpose?: SupervisorHostNoticePurpose): {runId: string} | Promise<{runId: string}>;
  attach(chatId: string): {runId: string} | null;
  receipt(runId: string): InvocationRunReceipt | null;
  onSettled(listener: (event: {runId: string; chatId: string; receipt: InvocationRunReceipt}) => void): () => void;
  /** True only when the durable admission ledger proves nothing was started for this run (no row, or a rejected one). */
  noStartProof?(runId: string): boolean;
}
export interface SupervisorWorkExecutorOptions {
  queue: OneSupervisorWorkQueue;
  store: OneSupervisorStore;
  runtime: SupervisorWorkRuntime;
  ownerEpoch: string;
  ownerKind: "desktop-main" | "work-daemon";
  assertOwner(): void;
  assertBinding(lease: SupervisorWorkLease, request: SupervisorRequestRow): void;
  locale(): "ko" | "en";
  leaseMs?: number;
  tickMs?: number;
  reconcileMs?: number;
  now?(): number;
  onFailure?(error: unknown): void;
}
const terminal = (status: string) => ["completed", "failed", "cancelled", "interrupted"].includes(status);

/** Claims and dispatches real native invocations independently of a renderer.
 * The adapter's lifetime determines whether this is a Main host worker or a
 * daemon worker; a queue/table alone never establishes daemon ownership.
 */
export class OneSupervisorWorkExecutor {
  private closed = false;
  private started = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFailure: string | null = null;
  private readonly dispatching = new Set<string>();
  private readonly reconciled = new Map<string, {version: string; checkedAt: number}>();
  /** Jobs whose start was refused before dispatch: how often, and since when (the shared deadline gives up on them). */
  private readonly refusals = new Map<string, {attempts: number; firstAt: number}>();
  private readonly unsubscribe: () => void;
  constructor(private readonly deps: SupervisorWorkExecutorOptions) {
    if (deps.queue.db !== deps.store.db) throw supervisorError('supervisor_work_store_mismatch');
    this.unsubscribe = deps.runtime.onSettled(event => {
      if (this.closed || !this.started) return;
      try {
        deps.assertOwner();
        const job = deps.queue.forRun(event.runId);
        if (job?.chat_id === event.chatId) this.settle(job, event.receipt);
        this.tick(false);
      } catch (error) { deps.onFailure?.(error); }
    });
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.started = true;
    this.tick();
    this.timer = setInterval(() => this.tick(false), this.deps.tickMs ?? 1_000);
    this.timer.unref?.();
  }
  close(): void {
    this.closed = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.reconciled.clear();
    this.unsubscribe();
    // A UI disconnect never cancels a worker. Native host shutdown remains the
    // single owner of its child tree, deadlines and terminal interruption receipt.
  }
  kick(): void { this.tick(); }
  tick(reconcileNow = true): void {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      this.deps.assertOwner();
      this.deps.queue.recoverUnstarted();
      const active = this.deps.queue.active(), retained = new Set<string>();
      const now = this.deps.now?.() ?? Date.now();
      // Enqueue/control kicks and settled events stay immediate. The one-second
      // watchdog still checks ownership and queue claims, but an unchanged job
      // need not rebuild its full durable receipt on every safety tick.
      const reconcileMs = Math.max(0, Math.min(this.deps.reconcileMs ?? 5_000, (this.deps.leaseMs ?? 30_000) / 3));
      for (const job of active) {
        retained.add(job.command_id);
        const version = this.deps.queue.version(job), prior = this.reconciled.get(job.command_id);
        const renewalDue = job.owner_epoch === this.deps.ownerEpoch && (job.phase === "starting" || job.phase === "running")
          && this.deps.queue.heartbeatDue(job, this.deps.leaseMs);
        if (reconcileNow || !prior || prior.version !== version || now < prior.checkedAt || now - prior.checkedAt >= reconcileMs || renewalDue) {
          this.reconcile(job);
          this.reconciled.set(job.command_id, {version, checkedAt: now});
        }
      }
      for (const id of this.reconciled.keys()) if (!retained.has(id)) this.reconciled.delete(id);
      // One decides which work to delegate. Claim every queued delegation once;
      // native runtime admission owns resource scheduling, not a fixed Work cap.
      for (;;) {
        this.deps.assertOwner();
        const claimed = this.deps.queue.claim({ownerEpoch: this.deps.ownerEpoch, ownerKind: this.deps.ownerKind, leaseMs: this.deps.leaseMs});
        if (!claimed) break;
        void this.dispatch(claimed);
      }
      this.lastFailure = null;
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      if (code !== this.lastFailure) this.deps.onFailure?.(error);
      this.lastFailure = code;
    }
    finally { this.ticking = false; }
  }
  private async dispatch(claimed: SupervisorWorkLease): Promise<void> {
    this.dispatching.add(claimed.command_id);
    let starting: SupervisorWorkLease | null = null;
    try {
      this.deps.assertOwner();
      const row = this.deps.store.get(claimed.command_id);
      if (!row || row.state !== "stored" || row.one_id !== claimed.one_id || row.task_id !== claimed.task_id || row.run_id !== claimed.run_id) {
        throw supervisorError('supervisor_work_ingress_changed');
      }
      const {workerChatId, ...input} = JSON.parse(row.payload_json);
      if (workerChatId !== claimed.chat_id || supervisorHash([row.one_id, "work", input]) !== row.payload_hash) {
        throw supervisorError('supervisor_work_payload_changed');
      }
      this.deps.assertBinding(claimed, row);
      // Commit the uncertain-effect boundary before any native start. An expired
      // pre-start claim or cancelled generation cannot cross it afterward.
      starting = this.deps.queue.begin(claimed);
      if (!starting) return;
      this.deps.store.update(row, {state: "dispatching"});
      this.deps.assertOwner();
      // A brief One wrote (bound to its reply) is shown in the Work session as handed over by One, never as the
      // owner's words, and carries no owner authority (no automatic Goal, no user model pin). The owner's own brief stays theirs.
      const byOne = row.source_reply_run_id !== null;
      const issued = this.deps.runtime.start({runId: starting.run_id, chatId: starting.chat_id,
        userPrompt: input.text, taskIntent: "task", permissions: input.permissions,
        locale: this.deps.locale(), runtimeSelection: input.runtimeSelection,
        ...(byOne ? {promptOrigin: "system" as const} : {})}, byOne ? "one-dispatch-brief" : undefined);
      const started = "then" in issued ? await issued : issued;
      if (started.runId !== starting.run_id) throw supervisorError('supervisor_work_native_run_mismatch');
      this.deps.assertOwner();
      const current = this.deps.queue.get(starting.command_id)!;
      if(current.generation!==starting.generation || current.owner_epoch!==starting.owner_epoch)throw supervisorError('supervisor_work_owner_fenced');
      if (current.phase === "starting") {
        this.deps.queue.transition(current, "running");
        const request = this.deps.store.get(current.command_id)!;
        if (request.state === "dispatching") this.deps.store.update(request, {state: "accepted", acknowledgement: "delivered"});
      }
      this.refusals.delete(starting.command_id);
    } catch (error) {
      try { this.deps.assertOwner(); } catch { return; }
      const current = this.deps.queue.get(claimed.command_id);
      if (!current || current.generation !== claimed.generation || terminal(current.phase)) return;
      const reason = error instanceof Error ? error.message : "supervisor_work_dispatch_unknown";
      if(error instanceof OneBudgetAdmissionDenied){
        this.deps.queue.transition(current,"failed",reason);
        const row=this.deps.store.get(claimed.command_id);
        if(row && ["stored","dispatching"].includes(row.state))this.deps.store.update(row,{state:"failed",acknowledgement:"settled",reason});
        return;
      }
      // A start refused for a "not ready yet" reason (shared/transient-send-refusal.ts: the daemon channel is reattaching, the
      // chat is held by another host) reached no model. It is not an uncertain effect: the job waits and starts again.
      const refusal = this.preStartRefusal(current, !starting, error);
      if (refusal) { this.retryAfterRefusal(current, refusal); return; }
      // Only this pre-begin branch may mint the local-cancellation marker.
      // A native error can carry arbitrary text after the uncertain boundary.
      const heldReason = !starting ? 'held_before_native_dispatch'
        : reason === 'held_before_native_dispatch' ? 'native_dispatch_outcome_unknown' : reason;
      this.deps.queue.transition(current, "held", heldReason);
      const row = this.deps.store.get(claimed.command_id);
      if (row && ["stored", "dispatching"].includes(row.state)) this.deps.store.update(row, {
        state: "held", acknowledgement: starting ? "unknown" : "stored",
        reason: starting ? reason : "work_binding_requires_review",
      });
    } finally { this.dispatching.delete(claimed.command_id); }
  }
  /** The typed code of a start refused before anything reached a model, or null when that cannot be proven. A job that never
   * began (`neverBegan`) crossed no boundary at all; after begin() the admission ledger must show no start for the run. */
  private preStartRefusal(job: SupervisorWorkLease, neverBegan: boolean, error: unknown): string | null {
    const code = sendRefusalCode(error);
    const refusal = code && isTransientSendRefusalCode(code) ? code : isStoreBusyError(error) ? "store_busy" : null;
    if (!refusal) return null;
    return neverBegan || (this.deps.runtime.noStartProof?.(job.run_id) ?? true) ? refusal : null;
  }
  /** Waits out the shared backoff as an unstarted (queued, cancellable) claim, then starts the same run again; gives up at the deadline. */
  private retryAfterRefusal(job: SupervisorWorkLease, code: string): void {
    const now = this.deps.now?.() ?? Date.now(), prior = this.refusals.get(job.command_id);
    const attempts = (prior?.attempts ?? 0) + 1, firstAt = prior?.firstAt ?? now;
    const row = this.deps.store.get(job.command_id);
    if (now - firstAt > TRANSIENT_SEND_DEADLINE_MS) {
      // The cause stays on the job and the request; One is told through the usual failed-Work review.
      this.refusals.delete(job.command_id);
      this.deps.queue.transition(job, "failed", code);
      if (row && ["stored", "dispatching", "held"].includes(row.state)) {
        this.deps.store.update(row, {state: "failed", acknowledgement: "settled", reason: code});
        this.deps.store.notice(row, "failed");
      }
      return;
    }
    if (!this.deps.queue.retryRefused(job, transientSendBackoffMs(attempts - 1), code)) return;
    this.refusals.set(job.command_id, {attempts, firstAt});
    if (row && ["dispatching", "held"].includes(row.state)) this.deps.store.update(row, {state: "stored", acknowledgement: "stored", reason: code});
    if (attempts === 1) this.deps.onFailure?.(Object.assign(new Error(code), {code}));
  }
  /** A job held by an older build for such a refusal (nothing ever started it again), with the ledger proving no start. */
  private heldRefusalRecoverable(job: SupervisorWorkLease): string | null {
    if (job.phase !== "held" || !job.reason || !isTransientSendRefusalCode(job.reason) || !this.deps.runtime.noStartProof) return null;
    if ((this.deps.now?.() ?? Date.now()) - job.updated_at > TRANSIENT_SEND_DEADLINE_MS || this.deps.runtime.receipt(job.run_id)) return null;
    return this.deps.runtime.noStartProof(job.run_id) ? job.reason : null;
  }
  private settle(job: SupervisorWorkLease, receipt: InvocationRunReceipt): void {
    if (receipt.runId !== job.run_id || receipt.chatId !== job.chat_id || !terminal(receipt.status)) return;
    this.deps.queue.db.transaction(() => {
      const current = this.deps.queue.get(job.command_id)!;
      if (terminal(current.phase)) return;
      const phase = receipt.status === "completed" ? "completed" : receipt.status === "cancelled" ? "cancelled" : "failed";
      const reason = receipt.status === "interrupted" ? "interrupted_requires_review" : null;
      this.deps.queue.transition(current, phase, reason);
      const row = this.deps.store.get(job.command_id)!;
      if (["stored", "dispatching", "accepted", "held"].includes(row.state)) {
        this.deps.store.update(row, {state: phase, acknowledgement: "settled", reason});
        this.deps.store.notice(row, receipt.status);
      }
    }).immediate();
  }
  private reconcile(job: SupervisorWorkLease): void {
    if (this.dispatching.has(job.command_id)) return;
    if (job.phase === "queued" || job.phase === "claimed" || terminal(job.phase)) return;
    const refused = this.heldRefusalRecoverable(job);
    if (refused) { this.retryAfterRefusal(job, refused); return; }
    const receipt = this.deps.runtime.receipt(job.run_id);
    if (receipt && receipt.runId === job.run_id && receipt.chatId === job.chat_id && terminal(receipt.status)) {
      this.settle(job, receipt);
      return;
    }
    const live = receipt?.runId === job.run_id && receipt.chatId === job.chat_id
      && this.deps.runtime.attach(job.chat_id)?.runId === job.run_id;
    if (live && job.owner_epoch === this.deps.ownerEpoch) {
      const running = job.phase === "running" ? job : this.deps.queue.transition(job, "running", "recovered_from_native_receipt");
      if (running) {
        if (this.deps.queue.heartbeatDue(running, this.deps.leaseMs)) this.deps.queue.heartbeat(running, this.deps.leaseMs);
        const row = this.deps.store.get(job.command_id)!;
        if (["dispatching", "held"].includes(row.state)) this.deps.store.update(row, {
          state: "accepted", acknowledgement: "delivered", reason: "recovered_from_native_receipt",
        });
      }
    } else if (job.phase !== "held") {
      this.deps.queue.transition(job, "held", "work_owner_unconfirmed");
      const row = this.deps.store.get(job.command_id)!;
      if (["dispatching", "accepted"].includes(row.state)) this.deps.store.update(row, {
        state: "held", acknowledgement: "unknown", reason: "work_owner_unconfirmed",
      });
    }
  }
}
