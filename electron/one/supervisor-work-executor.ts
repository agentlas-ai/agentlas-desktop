import type { InvocationRunReceipt, McpInvocationRequest } from "../../shared/types";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { OneSupervisorStore, supervisorHash, type SupervisorRequestRow } from "./supervisor-store";
import { OneSupervisorWorkQueue, type SupervisorWorkLease } from "./supervisor-work-queue";

export interface SupervisorWorkRuntime {
  start(request: McpInvocationRequest, hostNoticePurpose?: SupervisorHostNoticePurpose): {runId: string};
  attach(chatId: string): {runId: string} | null;
  receipt(runId: string): InvocationRunReceipt | null;
  onSettled(listener: (event: {runId: string; chatId: string; receipt: InvocationRunReceipt}) => void): () => void;
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
  private readonly unsubscribe: () => void;
  constructor(private readonly deps: SupervisorWorkExecutorOptions) {
    if (deps.queue.db !== deps.store.db) throw new Error("supervisor_work_store_mismatch");
    this.unsubscribe = deps.runtime.onSettled(event => {
      if (this.closed || !this.started) return;
      try {
        deps.assertOwner();
        const job = deps.queue.forRun(event.runId);
        if (job?.chat_id === event.chatId) this.settle(job, event.receipt);
        this.tick();
      } catch (error) { deps.onFailure?.(error); }
    });
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.started = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 1_000);
    this.timer.unref?.();
  }
  close(): void {
    this.closed = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe();
    // A UI disconnect never cancels a worker. Native host shutdown remains the
    // single owner of its child tree, deadlines and terminal interruption receipt.
  }
  kick(): void { this.tick(); }
  tick(): void {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      this.deps.assertOwner();
      this.deps.queue.recoverUnstarted();
      for (const job of this.deps.queue.active()) this.reconcile(job);
      // claim() enforces the global limit under an immediate SQLite write lock,
      // including another process's unresolved starting/running ownership.
      for (let count = 0; count < 2; count += 1) {
        this.deps.assertOwner();
        const claimed = this.deps.queue.claim({ownerEpoch: this.deps.ownerEpoch, ownerKind: this.deps.ownerKind, leaseMs: this.deps.leaseMs});
        if (!claimed) break;
        this.dispatch(claimed);
      }
      this.lastFailure = null;
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      if (code !== this.lastFailure) this.deps.onFailure?.(error);
      this.lastFailure = code;
    }
    finally { this.ticking = false; }
  }
  private dispatch(claimed: SupervisorWorkLease): void {
    let starting: SupervisorWorkLease | null = null;
    try {
      this.deps.assertOwner();
      const row = this.deps.store.get(claimed.command_id);
      if (!row || row.state !== "stored" || row.one_id !== claimed.one_id || row.task_id !== claimed.task_id || row.run_id !== claimed.run_id) {
        throw new Error("supervisor_work_ingress_changed");
      }
      const {workerChatId, ...input} = JSON.parse(row.payload_json);
      if (workerChatId !== claimed.chat_id || supervisorHash([row.one_id, "work", input]) !== row.payload_hash) {
        throw new Error("supervisor_work_payload_changed");
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
      const started = this.deps.runtime.start({runId: starting.run_id, chatId: starting.chat_id,
        userPrompt: input.text, taskIntent: "task", permissions: input.permissions,
        locale: this.deps.locale(), runtimeSelection: input.runtimeSelection,
        ...(byOne ? {promptOrigin: "system" as const} : {})}, byOne ? "one-dispatch-brief" : undefined);
      if (started.runId !== starting.run_id) throw new Error("supervisor_work_native_run_mismatch");
      const current = this.deps.queue.get(starting.command_id)!;
      if (current.phase === "starting") {
        this.deps.queue.transition(current, "running");
        const request = this.deps.store.get(current.command_id)!;
        if (request.state === "dispatching") this.deps.store.update(request, {state: "accepted", acknowledgement: "delivered"});
      }
    } catch (error) {
      const current = this.deps.queue.get(claimed.command_id);
      if (!current || current.generation !== claimed.generation || terminal(current.phase)) return;
      const reason = error instanceof Error ? error.message : "supervisor_work_dispatch_unknown";
      this.deps.queue.transition(current, "held", reason);
      const row = this.deps.store.get(claimed.command_id);
      if (row && ["stored", "dispatching"].includes(row.state)) this.deps.store.update(row, {
        state: "held", acknowledgement: starting ? "unknown" : "stored",
        reason: starting ? reason : "work_binding_requires_review",
      });
    }
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
    if (job.phase === "queued" || job.phase === "claimed" || terminal(job.phase)) return;
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
        this.deps.queue.heartbeat(running, this.deps.leaseMs);
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
