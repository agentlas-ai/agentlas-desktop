import { randomUUID } from "node:crypto";
import { UNCONFIRMED_MAX_RESENDS, unconfirmedRunShouldBeSentAgain, withEarlierAttempt } from "../invocation/earlier-attempt";
import { supervisorDoneWhen, supervisorError } from "../../shared/one-supervisor";
import type { InvocationRunReceipt, McpInvocationRequest } from "../../shared/types";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { OneSupervisorStore, supervisorHash, type SupervisorRequestRow } from "./supervisor-store";
import { OneSupervisorWorkQueue, type SupervisorWorkLease } from "./supervisor-work-queue";
import {OneBudgetAdmissionDenied} from "./budget-store";
import {onRuntimeSignal} from "../runtime/runtime-signals";
import {UNDISPATCHED_START_MAX_ATTEMPTS,isTransientSendRefusalCode,sendRefusalCode,startRefusalWaitsLong, isStoreBusyError, isRefusedBeforeDispatch } from "../../shared/transient-send-refusal";

import {rebindSupervisorUnconfirmed, SUPERVISOR_UNCONFIRMED_MAX_SENDS, countSupervisorPreBeginRefusal, retainSupervisorStartVerdict, supervisorInternalStartRefusal, supervisorDispatchFrame, supervisorDispatchRetry, reserveSupervisorDispatch, supervisorRefusalDelay, wakeSupervisorDispatch} from "./supervisor-dispatch-retry";


/** The brief as Work receives it: the brief itself, then One's checklist for "finished" when it gave one. */
export function withDoneWhen(brief: string, doneWhen: unknown): string {
  const items = supervisorDoneWhen(doneWhen);
  return items ? `${brief}\n\nFinished when:\n${items.map((item) => `- ${item}`).join("\n")}` : brief;
}

export interface SupervisorWorkRuntime {
  start(request: McpInvocationRequest, hostNoticePurpose?: SupervisorHostNoticePurpose): {runId: string} | Promise<{runId: string}>;
  attach(chatId: string): {runId: string} | null;
  cancel?(runId:string): string | Promise<string>;
  receipt(runId: string): InvocationRunReceipt | null;
  onSettled(listener: (event: {runId: string; chatId: string; receipt: InvocationRunReceipt}) => void): () => void;
  /** True only when the durable admission ledger proves nothing was started for this run (no row, or a rejected one). */
  noStartProof?(runId: string): boolean;
  placement?(runId: string): "placed" | "not-dispatched" | "unconfirmed";
  /** Goal-owned execution keeps its own continuation authority; the Work lane must not duplicate it. */
  unconfirmedRetryAllowed?(chatId: string, sinceMs?: number): boolean;
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
/** Holds the executor wrote itself when it lost track of a start (a restart, an owner that went away): no refusal of the brief. */
const LOST_BINDING_CODES: ReadonlySet<string> = new Set(["personal_data_session_changed", "personal_data_follow_up_page_changed", "supervisor_work_native_binding_changed"]);
const BOOKKEEPING_HOLDS: ReadonlySet<string> = new Set(["work_owner_unconfirmed", "native_dispatch_outcome_unknown"]);
/** The typed reason of a job proven never started and given up on (same word as the supervisor's replies and chat sends). */

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
  private readonly dispatching = new Map<string,{runId:string;startedAt:number}>();
  private readonly reconciled = new Map<string, {version: string; checkedAt: number}>();
  private readonly unsubscribe: () => void;
  private readonly stopWakes: Array<() => void> = [];
  constructor(private readonly deps: SupervisorWorkExecutorOptions) {
    // A runtime signal or a sign-in ends a long refusal wait now (the cause may have cleared).
    try { this.stopWakes.push(onRuntimeSignal(() => this.wakeLongWaits())); } catch { /* the step ends by itself */ }
    try { this.stopWakes.push((require("../auth") as typeof import("../auth")).onAuthSessionRestored(() => this.wakeLongWaits())); } catch { /* the step ends by itself */ }
    if (deps.queue.db !== deps.store.db) throw supervisorError('supervisor_work_store_mismatch');
    this.unsubscribe = deps.runtime.onSettled(event => {
      if (this.closed || !this.started) return;
      try {
        deps.assertOwner();
        const job = deps.queue.forRun(event.runId);
        if (job?.one_id===deps.queue.activeIdentity() && job?.chat_id === event.chatId) this.settle(job, event.receipt);
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
    for (const stop of this.stopWakes.splice(0)) { try { stop(); } catch { /* nothing to undo */ } }
    // A UI disconnect never cancels a worker. Native host shutdown remains the
    // single owner of its child tree, deadlines and terminal interruption receipt.
  }
  /** Claims waiting out a long step (attempts past the old cap) are claimable now. */
  private wakeLongWaits(): void {
    if (this.closed || !this.started) return;
    try {
      this.deps.assertOwner();
      const identity = this.deps.queue.activeIdentity();
      let woken = false;
      for (const job of identity ? this.deps.queue.waitingRefused(identity) : []) {
        const row = this.deps.store.get(job.command_id);
        if (!row || row.state !== "stored" || (supervisorDispatchRetry(row)?.attempts ?? 0) < UNDISPATCHED_START_MAX_ATTEMPTS) continue;
        if (!this.deps.store.db.transaction(() => { const fresh = this.deps.store.get(job.command_id); return !!fresh && fresh.state === "stored" && wakeSupervisorDispatch(this.deps.store, fresh, this.deps.now?.() ?? Date.now()) && this.deps.queue.wakeRefused(job); }).immediate()) continue;
        woken = true;
      }
      if (woken) this.tick(false);
    } catch (error) { this.deps.onFailure?.(error); }
  }
  kick(): void { this.tick(); }
  tick(reconcileNow = true): void {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      this.deps.assertOwner();
      const identity=this.deps.queue.activeIdentity();
      if(!identity)return;
      this.deps.queue.recoverUnstarted(identity);
      const active = this.deps.queue.active().filter(job=>job.one_id===identity), retained = new Set<string>();
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
    this.dispatching.set(claimed.command_id,{runId:claimed.run_id,startedAt:this.deps.now?.() ?? Date.now()});
    let starting: SupervisorWorkLease | null = null;
    try {
      this.deps.assertOwner();
      if(claimed.one_id!==this.deps.queue.activeIdentity())return;
      const row = this.deps.store.get(claimed.command_id);
      if (!row || row.state !== "stored" || row.one_id !== claimed.one_id || row.task_id !== claimed.task_id || row.run_id !== claimed.run_id) {
        throw supervisorError('supervisor_work_ingress_changed');
      }
      const {workerChatId, ...input} = JSON.parse(row.payload_json);
      if (workerChatId !== claimed.chat_id || supervisorHash([row.one_id, "work", input]) !== row.payload_hash) {
        throw supervisorError('supervisor_work_payload_changed');
      }
      if (this.workWasStopped(row)) {
        if (this.deps.queue.cancelUnstarted(claimed)) this.deps.store.update(row,{state:"cancelled",acknowledgement:"settled",reason:"cancelled_before_dispatch"});
        return;
      }
      if((supervisorDispatchRetry(row)?.unconfirmedResends ?? 0)>0 && !this.unconfirmedAllowed(claimed,row)) {
        if(this.deps.queue.transition(claimed,"held","held_before_native_dispatch")) this.deps.store.update(row,{state:"held",acknowledgement:"stored",reason:"work_binding_requires_review"});
        return;
      }
      this.deps.assertBinding(claimed, row);
      const now = this.deps.now?.() ?? Date.now();
      const frame = supervisorDispatchFrame(this.deps.store, row, () => ({locale:this.deps.locale(),runtimeSelection:input.runtimeSelection}), now);
      // Commit the uncertain-effect boundary before any native start. An expired
      // pre-start claim or cancelled generation cannot cross it afterward.
      starting = this.deps.queue.begin(claimed);
      if (!starting) return;
      this.deps.store.update(row, {state: "dispatching"});
      const admission = reserveSupervisorDispatch(this.deps.store, this.deps.store.get(row.command_id)!, now);
      if (admission !== "ready") { this.retryAfterRefusal(starting, JSON.parse(row.receipt_json).reason ?? "supervisor_start_retry_exhausted"); return; }
      this.deps.assertOwner();
      // A brief One wrote (bound to its reply) is shown in the Work session as handed over by One, never as the
      // owner's words, and carries no owner authority (no automatic Goal, no user model pin). The owner's own brief stays theirs.
      const byOne = row.source_reply_run_id !== null;
      const request = {runId: starting.run_id, chatId: starting.chat_id,
        userPrompt: withDoneWhen(input.text, input.doneWhen), taskIntent: "task" as const, permissions: input.permissions,
        locale: frame.locale, runtimeSelection: frame.runtimeSelection,
        ...(byOne ? {promptOrigin: "system" as const} : {})};
      const resends=supervisorDispatchRetry(this.deps.store.get(row.command_id)!)?.unconfirmedResends ?? 0;
      const issued=this.deps.runtime.start(resends>0 ? withEarlierAttempt(request,resends>UNCONFIRMED_MAX_RESENDS) : request,byOne ? "one-dispatch-brief" : undefined);
      const started = "then" in issued ? await issued : issued;
      if (started.runId !== starting.run_id) throw supervisorError('supervisor_work_native_run_mismatch');
      this.deps.assertOwner();
      const current = this.deps.queue.get(starting.command_id)!;
      if(current.one_id!==this.deps.queue.activeIdentity() || current.run_id!==starting.run_id || current.generation!==starting.generation || current.owner_epoch!==starting.owner_epoch)throw supervisorError('supervisor_work_owner_fenced');
      if (current.phase === "starting") {
        this.deps.queue.transition(current, "running");
        const request = this.deps.store.get(current.command_id)!;
        if (request.state === "dispatching") this.deps.store.update(request, {state: "accepted", acknowledgement: "delivered"});
        // A Stop that arrived while preparation was pending is retried against the exact run once its late ACK lands.
        if(this.workWasStopped(request) && this.deps.runtime.cancel)try {
          const stop=this.deps.runtime.cancel(current.run_id);
          if(stop && typeof (stop as Promise<string>).then==="function")void Promise.resolve(stop).catch(error=>this.deps.onFailure?.(error));
        }catch(error){this.deps.onFailure?.(error);}
      }
    } catch (error) {
      try { this.deps.assertOwner(); } catch { return; }
      const current = this.deps.queue.get(claimed.command_id);
      if (!current || current.one_id!==this.deps.queue.activeIdentity() || current.run_id !== claimed.run_id || current.generation !== claimed.generation || terminal(current.phase)) return;
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
      if (refusal) { this.retryAfterRefusal(current, refusal, !starting); return; }
      // Only this pre-begin branch may mint the local-cancellation marker.
      // A native error can carry arbitrary text after the uncertain boundary.
      const heldRow = this.deps.store.get(claimed.command_id);
      if (starting && heldRow) retainSupervisorStartVerdict(this.deps.store, heldRow, error);
      const heldReason = !starting ? 'held_before_native_dispatch'
        : reason === 'held_before_native_dispatch' ? 'native_dispatch_outcome_unknown' : reason;
      this.deps.queue.transition(current, "held", heldReason);
      const row = this.deps.store.get(claimed.command_id);
      if (row && ["stored", "dispatching"].includes(row.state)) this.deps.store.update(row, {
        state: "held", acknowledgement: starting ? "unknown" : "stored",
        reason: starting ? reason : "work_binding_requires_review",
      });
    } finally { if(this.dispatching.get(claimed.command_id)?.runId===claimed.run_id)this.dispatching.delete(claimed.command_id); }
  }
  /** The typed code of a start refused before anything reached a model, or null when that cannot be proven. A job that never
   * began (`neverBegan`) crossed no boundary at all; after begin() the admission ledger must show no start for the run. */
  private preStartRefusal(job: SupervisorWorkLease, neverBegan: boolean, error: unknown): string | null {
    if ((error as {runtimeFailure?:unknown} | null)?.runtimeFailure || !neverBegan && this.deps.runtime.receipt(job.run_id)) return null;
    const code = sendRefusalCode(error);
    const proven = neverBegan || (this.deps.runtime.noStartProof?.(job.run_id) ?? isRefusedBeforeDispatch(error));
    const refusal = code && isTransientSendRefusalCode(code) ? code : isStoreBusyError(error) ? "store_busy"
      : !neverBegan && proven && supervisorInternalStartRefusal(error)
        ? code ?? "supervisor_start_refused" : null;
    return refusal && (proven || !this.deps.runtime.noStartProof && isTransientSendRefusalCode(refusal)) ? refusal : null;
  }
  /** Waits out the shared backoff as an unstarted (queued, cancellable) claim, then starts the same run again. A received brief is never
   * given up by a count or an age: no model turn was sent (a tool-selection judge may have run), and only the owner's Stop (workWasStopped) or a refusal the owner alone can
   * clear (never listed by preStartRefusal) ends it. */
  private retryAfterRefusal(job: SupervisorWorkLease, code: string, beforeBegin = false): void {
    const now = this.deps.now?.() ?? Date.now();
    this.deps.store.db.transaction(() => {
      const current = this.deps.queue.get(job.command_id);
      let row = this.deps.store.get(job.command_id);
      if (!current || current.one_id!==this.deps.queue.activeIdentity() || current.generation !== job.generation || current.owner_epoch !== job.owner_epoch
        || !["claimed", "starting", "held"].includes(current.phase) || !row
        || !["stored", "dispatching", "held"].includes(row.state) || row.run_id !== current.run_id || this.workWasStopped(row)) return;
      supervisorDispatchFrame(this.deps.store, row, () => ({locale:this.deps.locale(),runtimeSelection:JSON.parse(row!.payload_json).runtimeSelection}), now);
      row = this.deps.store.get(job.command_id)!;
      if (beforeBegin) { countSupervisorPreBeginRefusal(this.deps.store,row,now); row = this.deps.store.get(job.command_id)!; }
      const delay = supervisorRefusalDelay(this.deps.store, row, now, startRefusalWaitsLong(code));
      if (!this.deps.queue.retryRefused(current, delay, code)) throw supervisorError("supervisor_work_owner_fenced");
      if (row.state !== "stored") this.deps.store.update(row, {state: "stored", acknowledgement: "stored", reason: code});
    }).immediate();
  }
  /** A held job whose hold is a refusal that clears by itself, or the executor's own lost-track bookkeeping, and for which the run left no
   * receipt and the admission ledger proves no start: nothing ever started it again. */
  private heldNeverStarted(job: SupervisorWorkLease): boolean {
    if (job.phase !== "held" || !job.reason || job.reason === "held_before_native_dispatch" || !this.deps.runtime.noStartProof) return false;
    if (!(isTransientSendRefusalCode(job.reason) || BOOKKEEPING_HOLDS.has(job.reason)
      || supervisorInternalStartRefusal(Object.assign(new Error(job.reason), {code:job.reason})))) return false;
    const request = this.deps.store.get(job.command_id);
    if (request && supervisorDispatchRetry(request)?.retryStopped) return false;
    if (this.deps.runtime.receipt(job.run_id)) return false;
    return this.deps.runtime.noStartProof(job.run_id);
  }
  /** Such a job starts again under the same run id, however old it is (a brief the host received is delivered, not aged out); the typed
   * cause stays on its request. The owner's Stop is checked by closeStopped before this and by retryAfterRefusal itself. */
  private heldRefusalRecoverable(job: SupervisorWorkLease): string | null {
    return this.heldNeverStarted(job) ? job.reason : null;
  }
  private workWasStopped(row: SupervisorRequestRow): boolean {
    const prior=supervisorDispatchRetry(row)?.priorRunId ?? null;
    return !!row.task_id && !!this.deps.store.db.prepare(`SELECT 1 FROM one_supervisor_requests
      WHERE one_id=? AND task_id=? AND kind='cancel'
        AND (state<>'failed' OR json_extract(receipt_json,'$.control.phase')='settled'
          OR json_extract(receipt_json,'$.reason') IN ('cancel_raced_terminal_outcome','interrupted_requires_review'))
        AND (run_id=? OR run_id=?) LIMIT 1`)
      .get(row.one_id,row.task_id,row.run_id,prior);
  }
  private unconfirmedAllowed(job: SupervisorWorkLease, row=this.deps.store.get(job.command_id)): boolean {
    if(!row || row.one_id!==job.one_id || row.task_id!==job.task_id || row.run_id!==job.run_id)return false;
    try {return this.deps.runtime.unconfirmedRetryAllowed?.(job.chat_id,supervisorDispatchRetry(row)?.firstAt ?? Date.parse(row.created_at))===true;}
    catch {return false;}
  }
  /** The owner wrote something else in this Work chat since the command first started: their newer message is the direction now (the verify-first send is not made). */
  private ownerWroteSince(job: SupervisorWorkLease, row: SupervisorRequestRow): boolean {
    try {
      const text=(JSON.parse(row.payload_json) as {text?: unknown}).text;
      const since=new Date(supervisorDispatchRetry(row)?.firstAt ?? Date.parse(row.created_at)).toISOString();
      const written=this.deps.store.db.prepare("SELECT text FROM chat_messages WHERE chat_id=? AND role='user' AND created_at>? LIMIT 20").all(job.chat_id,since) as Array<{text:string}>;
      return written.some(entry=>typeof text!=="string" || !String(entry.text).startsWith(text));
    } catch { return true; }
  }
  /** No further send of this command: the plain resend and the verify-first send are both spent, or the plain one is and the owner has written since. */
  private unconfirmedSendsSpent(job: SupervisorWorkLease, row: SupervisorRequestRow): boolean {
    const sent=supervisorDispatchRetry(row)?.unconfirmedResends ?? 0;
    return sent>=SUPERVISOR_UNCONFIRMED_MAX_SENDS || (sent>=UNCONFIRMED_MAX_RESENDS && this.ownerWroteSince(job,row));
  }
  private retryUnconfirmed(job: SupervisorWorkLease, receipt: InvocationRunReceipt | null): boolean {
    if (!this.unconfirmedAllowed(job) || !unconfirmedRunShouldBeSentAgain(receipt)
      || this.deps.runtime.placement?.(job.run_id)!=="unconfirmed" || this.deps.runtime.attach(job.chat_id)) return false;
    if (receipt && (receipt.runId!==job.run_id || receipt.chatId!==job.chat_id)) return false;
    const now=this.deps.now?.() ?? Date.now();
    if (!receipt && (job.phase!=="held" || job.lease_until>now)) return false;
    return this.deps.store.db.transaction(()=>{
      this.deps.assertOwner();
      const current=this.deps.queue.get(job.command_id),row=this.deps.store.get(job.command_id);
      if(!current || current.one_id!==this.deps.queue.activeIdentity() || current.run_id!==job.run_id || current.generation!==job.generation || current.owner_epoch!==job.owner_epoch
        || !row || row.run_id!==job.run_id || !["dispatching","accepted","held"].includes(row.state) || this.workWasStopped(row)
        || !this.unconfirmedAllowed(job) || this.deps.runtime.attach(job.chat_id)
        || this.deps.runtime.placement?.(job.run_id)!=="unconfirmed")return false;
      const observed=this.deps.runtime.receipt(job.run_id);
      if(receipt ? !observed || observed.runId!==job.run_id || observed.chatId!==job.chat_id || !unconfirmedRunShouldBeSentAgain(observed) : !!observed)return false;
      // Revalidate the original task/chat/identity binding; a scoped original-issuer grant is never manufactured for a replay.
      try { this.deps.assertBinding(current,row); } catch (error) { this.deps.onFailure?.(error); return false; }
      if(this.unconfirmedSendsSpent(job,row))return false;
      supervisorDispatchFrame(this.deps.store,row,()=>({locale:this.deps.locale(),runtimeSelection:JSON.parse(row.payload_json).runtimeSelection}),now);
      const nextRunId=randomUUID(),delay=rebindSupervisorUnconfirmed(this.deps.store,this.deps.store.get(row.command_id)!,nextRunId,now);
      if(delay===null)return false;
      if(!this.deps.queue.retryUnconfirmed(current,nextRunId,delay))throw supervisorError("supervisor_work_owner_fenced");
      return true;
    }).immediate();
  }
  /** The chat, task, account or personal-data page this job was bound to is no longer the same one: assertBinding (supervisor.ts) threw one of
   * the three typed codes below, and no resend can ever apply. Anything else clears by itself and is waited for: a locked store, a sign-in
   * that is not restored yet (personal_data_sign_in_required: signed out, or just after start), an adapter not initialised yet
   * (history_native_execution_adapter_required). */
  private bindingChanged(job: SupervisorWorkLease, row: SupervisorRequestRow): boolean {
    const current=this.deps.queue.get(job.command_id);
    if(!current)return false;
    try { this.deps.assertBinding(current,row); return false; }
    catch (error) {
      const code = (error as {code?: unknown} | null)?.code ?? (error instanceof Error ? error.message : null);
      return typeof code === "string" && LOST_BINDING_CODES.has(code);
    }
  }
  /** The plain resend and the one verify-first send of an effect-unknown run are spent (or the owner wrote since), or its binding is gone for good: close the automatic lane,
   * retaining an unknown outcome rather than inventing success or cleanup. Only the effect-unknown cap ends it, never an age. */
  private closeUnconfirmed(job: SupervisorWorkLease): boolean {
    const now=this.deps.now?.() ?? Date.now(),row=this.deps.store.get(job.command_id);
    if(!row || job.phase!=="held" || job.lease_until>now || this.workWasStopped(row)
      || !this.unconfirmedAllowed(job) || this.deps.runtime.placement?.(job.run_id)!=="unconfirmed"
      || this.deps.runtime.receipt(job.run_id) || this.deps.runtime.attach(job.chat_id))return false;
    const retry=supervisorDispatchRetry(row);
    if(retry?.retryStopped || !((retry?.unconfirmedResends ?? 0)>=UNCONFIRMED_MAX_RESENDS && this.unconfirmedSendsSpent(job,row) || this.bindingChanged(job,row)))return false;
    return this.deps.store.db.transaction(()=>{
      this.deps.assertOwner();const current=this.deps.queue.get(job.command_id),saved=this.deps.store.get(job.command_id);
      if(!current || current.one_id!==this.deps.queue.activeIdentity() || current.run_id!==job.run_id || current.generation!==job.generation || current.owner_epoch!==job.owner_epoch || current.phase!=="held"
        || !saved || saved.run_id!==job.run_id || !["dispatching","accepted","held"].includes(saved.state)
        || this.workWasStopped(saved) || supervisorDispatchRetry(saved)?.retryStopped
        || !this.unconfirmedAllowed(job) || this.deps.runtime.placement?.(job.run_id)!=="unconfirmed"
        || this.deps.runtime.receipt(job.run_id) || this.deps.runtime.attach(job.chat_id))return false;
      if(!this.deps.queue.transition(current,"failed","native_dispatch_outcome_unknown"))return false;
      this.deps.store.update(saved,{state:"failed",acknowledgement:"unknown",reason:"native_dispatch_outcome_unknown"});
      this.deps.store.notice(saved,"failed");return true;
    }).immediate();
  }
  private settle(job: SupervisorWorkLease, receipt: InvocationRunReceipt): void {
    if (receipt.runId !== job.run_id || receipt.chatId !== job.chat_id || !terminal(receipt.status)) return;
    if (this.retryUnconfirmed(job,receipt)) return;
    this.deps.queue.db.transaction(() => {
      this.deps.assertOwner();
      const current = this.deps.queue.get(job.command_id)!;
      if (current.one_id!==this.deps.queue.activeIdentity() || current.run_id!==job.run_id || terminal(current.phase)) return;
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
  /**
   * Stop always wins: a Work the owner stopped while it was held, with no run of it live here and no receipt of any run, is closed as
   * cancelled together with the Stop itself. The recovery lanes (retryAfterRefusal, retryUnconfirmed, closeUnconfirmed) all step aside
   * for a recorded Stop, so nothing else ever settled it: the card read "stopping" for two hours and then "failed: not started"
   * (169fda2a7 review). A run that left a receipt settles through settle as before.
   */
  private closeStopped(job: SupervisorWorkLease): boolean {
    if (job.phase !== "held") return false;
    const row = this.deps.store.get(job.command_id);
    if (!row || !this.workWasStopped(row) || this.deps.runtime.receipt(job.run_id) || this.deps.runtime.attach(job.chat_id)) return false;
    const proven = this.deps.runtime.noStartProof?.(job.run_id) === true;
    const reason = proven ? "owner_stopped_before_start" : "owner_stopped_outcome_unknown";
    return this.deps.store.db.transaction(() => {
      this.deps.assertOwner();
      const current = this.deps.queue.get(job.command_id), saved = this.deps.store.get(job.command_id);
      if (!current || current.one_id!==this.deps.queue.activeIdentity() || current.run_id!==job.run_id || current.generation!==job.generation
        || current.owner_epoch!==job.owner_epoch || current.phase!=="held" || !saved || saved.run_id!==job.run_id || !this.workWasStopped(saved)) return false;
      if (!this.deps.queue.transition(current, "cancelled", reason)) return false;
      if (["stored", "dispatching", "accepted", "held"].includes(saved.state)) {
        this.deps.store.update(saved, {state: "cancelled", acknowledgement: proven ? "settled" : "unknown", reason});
      }
      const stops = this.deps.store.db.prepare(`SELECT * FROM one_supervisor_requests WHERE one_id=? AND task_id=? AND kind='cancel'
        AND state IN ('dispatching','accepted','held') AND (run_id=? OR run_id IS NULL)`).all(saved.one_id, saved.task_id, saved.run_id) as SupervisorRequestRow[];
      for (const stop of stops) this.deps.store.update(stop, {state: "cancelled", acknowledgement: "settled", reason: "work_closed_by_stop"});
      return true;
    }).immediate();
  }
  private reconcile(job: SupervisorWorkLease): void {
    const flight=this.dispatching.get(job.command_id);
    if (flight?.runId===job.run_id && (this.deps.now?.() ?? Date.now())-flight.startedAt<200_000) return;
    if (job.phase === "queued" || job.phase === "claimed" || terminal(job.phase)) return;
    if (this.closeStopped(job)) return;
    const refused = this.heldRefusalRecoverable(job);
    if (refused) { this.retryAfterRefusal(job, refused); return; }
    const receipt = this.deps.runtime.receipt(job.run_id);
    if (receipt && receipt.runId === job.run_id && receipt.chatId === job.chat_id && terminal(receipt.status)) {
      this.settle(job, receipt);
      return;
    }
    if (!receipt && job.phase==="held" && (this.retryUnconfirmed(job,null) || this.closeUnconfirmed(job))) return;
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
