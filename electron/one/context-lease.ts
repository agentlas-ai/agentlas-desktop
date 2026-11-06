import { reportSystemPermissionIssue } from "../os-permission-guidance";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { OneContextLeaseState, OneContextReadiness } from "../../shared/one-context";
import { abortableDelay, assertRequestCurrent } from "../computer-use/request-lifetime";

export const ONE_OS_EXECUTION_ENV = "AGENTLAS_ONE_OS_EXECUTION";
export interface OneOsExecutionBinding {
  oneId: string;
  taskId: string;
  runId: string;
  ownerEpoch: string;
  permissions: "read" | "write" | "full";
  contextGrantId?: string;
}
export interface OneOsExecutionCapability { version: "agentlas.one-os-execution.v1"; executionId: string; token: string }
export interface OneOsActionTarget { appTarget: string; allowFocus?:boolean; resolvedPid?:number; resolvedProcessStartMs?:number; resolvedWindowId?:number; sourceId?: string; points?: ReadonlyArray<{ x: number; y: number }>; elementFrame?: { x: number; y: number; width: number; height: number } }
interface Execution { binding: Readonly<OneOsExecutionBinding>; token: string; assertCurrent(): void; signal?: AbortSignal; controller: AbortController; dispose(): void; revoked: boolean }
export interface OneOsLeasePorts {
  readiness(): OneContextReadiness;
  validateTarget(binding: Readonly<OneOsExecutionBinding>, target: OneOsActionTarget): Promise<void>;
  validateObservation?(binding: Readonly<OneOsExecutionBinding>, input: { appTarget?: string; sourceId?: string }): Promise<void>;
  now?(): number;
  changed?(): void;
  /** A scoped execution was disposed (run finished, cancelled or revoked). Cosmetic listeners only; must not throw into the broker. */
  executionEnded?(binding: Readonly<OneOsExecutionBinding>): void;
  resourceLockPath?: string;
}
export class OneOsLeaseError extends Error { constructor(readonly code: string) { super(code); this.name = "OneOsLeaseError"; } }
const fail = (code: string): never => { throw new OneOsLeaseError(code); };
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f]/.test(value); }
/** Private execution authority is registered only by the original prepared native source, never by renderer IPC. */
const HUMAN_INPUT_SETTLE_MS = 8_000;
/**
 * How long an action or a window arrangement waits for the owner's keyboard and mouse to go quiet, inside the computer-use request
 * budget (request-lifetime.ts: 40 s per action, 20 s per observation). Eight seconds handed Hope's Finder step back to the owner as
 * "finish using the computer and ask again" during an ordinary pause in their typing (one-os-human-active, 1.3.116). The
 * safety rule is unchanged: input during the action still stops it, and an owner who stays busy past the wait is still refused.
 */
export const HUMAN_INPUT_ACTION_WAIT_MS = 25_000;
export const HUMAN_INPUT_ARRANGE_WAIT_MS = 10_000;

/**
 * A screen-lock file is stale by its age, one rule for every way a holder can be gone: a dead pid, a pid the system gave to another
 * process, a file cut short by a crash, a leftover repair marker. A holder keeps the lock for one action (lease 30 s, request budget
 * 40 s), so a live-looking pid past this age no longer owns it; its lease expired and its next checkpoint refuses.
 */
const LOCK_MAX_AGE_MS = 120_000;
/** A file a crash left empty or cut short is stale after this; a younger one may still be being written by another process. */
const LOCK_PARTIAL_GRACE_MS = 2_000;
/** A repair marker older than this was left by a process that died mid-repair. */
const LOCK_REPAIR_MAX_AGE_MS = 30_000;
function judgeLockFile(file: string): { verdict: "gone" | "busy" | "stale"; raw: string } {
  let raw: string, ageMs: number;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return { verdict: "busy", raw: "" };
    raw = fs.readFileSync(file, "utf8"); ageMs = Date.now() - stat.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { verdict: "gone", raw: "" };
    throw error;
  }
  let pid: unknown;
  try { pid = (JSON.parse(raw) as { pid?: unknown } | null)?.pid; } catch { pid = undefined; }
  // A clock that moved back gives a negative age: the file counts as young, never as stale.
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return { verdict: ageMs > LOCK_PARTIAL_GRACE_MS ? "stale" : "busy", raw };
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return { verdict: "stale", raw }; if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  return { verdict: ageMs > LOCK_MAX_AGE_MS ? "stale" : "busy", raw };
}

export class OneOsResourceLeaseBroker {
  private executions = new Map<string, Execution>();
  private holder: { leaseId: string; executionId: string; target: OneOsActionTarget; until: number; controller: AbortController; reason?: string } | null = null;
  private lastWaiting: OneContextLeaseState | null = null;
  constructor(private readonly ports: OneOsLeasePorts) {}
  private processLock(): () => void {
    const file = this.ports.resourceLockPath; if (!file) return () => undefined;
    const directory=path.dirname(file);fs.mkdirSync(directory, {recursive:true,mode:0o700});
    const directoryStat=fs.lstatSync(directory);if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||process.getuid && directoryStat.uid!==process.getuid())fail("one-os-resource-lock-unavailable");
    const nonce = randomUUID();
    for(let attempt=0;attempt<3;attempt++) {
      try { fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce}),{flag:"wx",mode:0o600});
        return () => { try { const row=JSON.parse(fs.readFileSync(file,"utf8"));if(row.pid===process.pid && row.nonce===nonce)fs.unlinkSync(file); } catch {} };
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=="EEXIST")fail("one-os-resource-lock-unavailable");
      }
      try {
        const first=judgeLockFile(file);
        if(first.verdict==="gone")continue;
        if(first.verdict==="busy")fail("one-os-resource-busy");
        // Serialize stale cleanup across competing processes. The file is re-read under the repair marker, and only the very
        // text that was judged stale is removed, so a lock another process created in between is never unlinked.
        const repair=`${file}.repair`;
        try { if(Date.now()-fs.lstatSync(repair).mtimeMs>LOCK_REPAIR_MAX_AGE_MS)fs.unlinkSync(repair); } catch(check) { if((check as NodeJS.ErrnoException).code!=="ENOENT")throw check; }
        let repaired=false;
        try {
          try { fs.writeFileSync(repair,String(process.pid),{flag:"wx",mode:0o600});repaired=true; }
          catch(check) { if((check as NodeJS.ErrnoException).code==="EEXIST")fail("one-os-resource-busy");throw check; }
          const latest=judgeLockFile(file);
          if(latest.verdict==="gone")continue;
          if(latest.verdict==="busy"||latest.raw!==first.raw)fail("one-os-resource-busy");
          try { fs.unlinkSync(file); } catch(check) { if((check as NodeJS.ErrnoException).code!=="ENOENT")throw check; }
        } finally { if(repaired){ try { fs.unlinkSync(repair); } catch { /* a stale-marker sweep may have removed it */ } } }
      } catch(check) { if(check instanceof OneOsLeaseError)throw check;fail("one-os-resource-lock-unavailable"); }
    }
    return fail("one-os-resource-busy");
  }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
  registerExecution(binding: OneOsExecutionBinding, assertExecutionCurrent: () => void, signal?: AbortSignal): { capability: OneOsExecutionCapability; dispose(): void } {
    if (![binding.oneId, binding.taskId, binding.runId, binding.ownerEpoch].every(identifier)
      || !["read", "write", "full"].includes(binding.permissions) || typeof assertExecutionCurrent !== "function"
      || binding.contextGrantId !== undefined && !identifier(binding.contextGrantId)) fail("one-os-execution-binding-invalid");
    assertExecutionCurrent(); if (signal?.aborted) fail("one-os-execution-revoked");
    if (this.executions.size >= 128) fail("one-os-execution-capacity");
    const executionId = randomUUID(), token = randomBytes(32).toString("hex");
    const controller = new AbortController();
    const dispose = () => {
      const record = this.executions.get(executionId); if (!record || record.revoked) return;
      record.revoked = true; signal?.removeEventListener("abort", dispose);
      controller.abort();
      if (this.holder?.executionId === executionId) { this.holder.reason = "one-os-execution-revoked"; this.holder.controller.abort(); }
      this.executions.delete(executionId); this.ports.changed?.();
      try { this.ports.executionEnded?.(record.binding); } catch { /* a listener never blocks revocation */ }
    };
    this.executions.set(executionId, { binding: Object.freeze({ ...binding }), token, assertCurrent: assertExecutionCurrent, signal, controller, dispose, revoked: false });
    signal?.addEventListener("abort", dispose, { once: true });
    return { capability: { version: "agentlas.one-os-execution.v1", executionId, token }, dispose };
  }
  private execution(value: unknown): { id: string; record: Execution } {
    const cap = value as Partial<OneOsExecutionCapability> | null;
    if (!cap || typeof cap !== "object" || cap.version !== "agentlas.one-os-execution.v1" || !identifier(cap.executionId)
      || typeof cap.token !== "string" || !/^[a-f0-9]{64}$/.test(cap.token)) throw new OneOsLeaseError("one-os-execution-capability-invalid");
    const record = this.executions.get(cap.executionId!);
    if (!record || record.revoked || !timingSafeEqual(Buffer.from(record.token, "hex"), Buffer.from(cap.token!, "hex"))) throw new OneOsLeaseError("one-os-execution-capability-unavailable");
    record.assertCurrent(); if (record.signal?.aborted) fail("one-os-execution-revoked");
    return { id: cap.executionId!, record };
  }
  assertExecutionCurrent(capability:unknown):void {this.execution(capability);if(this.ports.readiness().session!=="awake")fail("one-os-session-unavailable");}
  /** Includes explicit disposal even when the original source supplied no signal. */
  executionSignal(capability: unknown): AbortSignal { return this.execution(capability).record.controller.signal; }
  /** The authorized binding of a live capability (throws like every other capability check). */
  executionBinding(capability:unknown):Readonly<OneOsExecutionBinding> {return this.execution(capability).record.binding;}
  hasContextGrant(capability:unknown):boolean {return Boolean(this.execution(capability).record.binding.contextGrantId);}
  snapshot(): OneContextLeaseState {
    const holder = this.holder;
    if (!holder) return this.lastWaiting ?? { state: "idle" };
    const binding = this.executions.get(holder.executionId)?.binding;
    return { state: holder.reason || holder.until <= this.now() ? "waiting" : "held", ...(binding ? { oneId: binding.oneId, taskId: binding.taskId, runId: binding.runId } : {}),
      target: holder.target.appTarget, expiresAt: new Date(holder.until).toISOString(), ...(holder.reason ? { reasonCode: holder.reason } : holder.until <= this.now() ? { reasonCode: "one-os-lease-expired" } : {}) };
  }
  async authorizeObservation(capability: unknown, input: { appTarget?: string; sourceId?: string }): Promise<{ binding: Readonly<OneOsExecutionBinding>; assertCurrent(): void }> {
    const execution = this.execution(capability);
    const assertCurrent = () => { this.execution(capability); if (this.ports.readiness().session !== "awake") fail("one-os-session-unavailable"); };
    assertCurrent(); await this.ports.validateObservation?.(execution.record.binding, input); assertCurrent();
    return { binding: execution.record.binding, assertCurrent };
  }
  /**
   * Waits briefly for the keyboard and mouse to go quiet before an action asks for the lease. Idle time counts synthesized input too
   * (context-platform.ts), so an agent's second click inside two seconds of its first read as "the owner is active" and came back
   * refused, as did a click during a pause in the owner's typing. The lease's own check is unchanged.
   */
  async settleHumanInput(timeoutMs = HUMAN_INPUT_SETTLE_MS, signal?: AbortSignal): Promise<void> {
    assertRequestCurrent(signal);
    const deadline = this.now() + timeoutMs;
    while (true) {
      const ready = this.ports.readiness();
      if (ready.session !== "awake") fail("one-os-session-unavailable");
      if (!ready.humanBusy || this.now() >= deadline) break;
      await abortableDelay(200, signal);
    }
    assertRequestCurrent(signal);
  }
  /** Bind cancellation to this request without changing the shared broker or
   * another caller's default signal. Authority remains in the original methods. */
  forRequest(signal: AbortSignal) {
    return {
      settleHumanInput: (timeoutMs?: number) => this.settleHumanInput(timeoutMs, signal),
      acquireLegacyAction: () => { assertRequestCurrent(signal); return this.acquireLegacyAction(); },
    };
  }
  async acquireForAction(capability: unknown, target: OneOsActionTarget): Promise<{ leaseId: string; signal: AbortSignal; checkpoint(): Promise<void>; release(): void }> {
    const execution = this.execution(capability), binding = execution.record.binding;
    if (binding.permissions === "read") fail("one-os-input-permission-denied");
    if (!identifier(target.appTarget)) fail("one-os-action-target-required");
    if (this.holder) fail("one-os-resource-busy");
    const ready = this.ports.readiness();
    if (ready.session !== "awake") fail("one-os-session-unavailable");
    if (!ready.driverAvailable || ready.accessibility !== "granted") {
      if (ready.platform === "darwin" && ready.accessibility !== "granted") reportSystemPermissionIssue("accessibility", "one-context");
      fail("one-os-input-unavailable");
    }
    if (ready.humanBusy) {
      this.lastWaiting = { state: "waiting", oneId: binding.oneId, taskId: binding.taskId, runId: binding.runId, target: target.appTarget, reasonCode: "one-os-human-active" };
      this.ports.changed?.(); fail("one-os-human-active");
    }
    // Claim before the async target/geometry observation so competing runs cannot acquire.
    const holder = { leaseId: randomUUID(), executionId: execution.id, target: { ...target }, until: this.now() + 30_000, controller: new AbortController(), reason: undefined as string | undefined };
    const unlock = this.processLock();
    this.holder = holder; this.lastWaiting = null; this.ports.changed?.();
    let released = false;
    const release = () => { if (released) return; released = true; unlock(); if (this.holder === holder) { this.holder = null; this.lastWaiting = null; this.ports.changed?.(); } };
    const checkpoint = async () => {
      if (released || this.holder !== holder || holder.controller.signal.aborted || holder.until <= this.now()) fail(holder.reason ?? "one-os-lease-unavailable");
      this.execution(capability);
      const state = this.ports.readiness();
      if (state.session !== "awake" || !state.driverAvailable || state.accessibility !== "granted") fail("one-os-input-unavailable");
      if (state.humanBusy) fail("one-os-human-active");
      await this.ports.validateTarget(binding, target);
      this.execution(capability);
      if (released || holder.controller.signal.aborted || holder.until <= this.now()) fail(holder.reason ?? "one-os-lease-unavailable");
      // Target validation is asynchronous. Human input or screen lock that
      // arrived during it must win before the caller dispatches native work.
      const latest = this.ports.readiness();
      if (latest.session !== "awake" || !latest.driverAvailable || latest.accessibility !== "granted") fail("one-os-input-unavailable");
      if (latest.humanBusy) fail("one-os-human-active");
    };
    try { await checkpoint(); } catch (error) { release(); throw error; }
    return { leaseId: holder.leaseId, signal: holder.controller.signal, checkpoint, release };
  }
  revokeGrant(grantId: string, reason = "one-context-revoked"): void {
    for (const record of [...this.executions.values()]) if (record.binding.contextGrantId === grantId) record.dispose();
    if (this.holder && this.holder.controller.signal.aborted) this.holder.reason = reason;
  }
  suspend(reason = "one-os-session-unavailable"): void {
    if (this.holder) { this.holder.reason = reason; this.holder.controller.abort(); }
    this.lastWaiting = { state: "waiting", reasonCode: reason }; this.ports.changed?.();
  }
  /** Existing bearer-authorized Computer Use retains its authority, but shares the OS resource. */
  acquireLegacyAction(): { signal: AbortSignal; checkpoint():Promise<void>; release():void } {
    if(this.holder)fail("one-os-resource-busy");
    const check=()=>{const ready=this.ports.readiness();if(ready.session!=="awake")fail("one-os-session-unavailable");if(ready.humanBusy)fail("one-os-human-active");};check();
    const unlock=this.processLock(),holder={leaseId:randomUUID(),executionId:"legacy",target:{appTarget:"legacy-authorized"},until:this.now()+30_000,controller:new AbortController(),reason:undefined as string|undefined};this.holder=holder;
    let released=false;
    return {signal:holder.controller.signal,checkpoint:async()=>{if(released||holder.controller.signal.aborted||holder.until<=this.now())fail("one-os-lease-unavailable");check();},release:()=>{if(released)return;released=true;unlock();if(this.holder===holder)this.holder=null;}};
  }
  dispose(): void { for (const record of [...this.executions.values()]) record.dispose(); this.suspend("one-os-host-closed"); }
}
let broker: OneOsResourceLeaseBroker | null = null;
export function configureOneOsLeaseBroker(value: OneOsResourceLeaseBroker): void { broker?.dispose(); broker = value; }
export function oneOsLeaseBroker(): OneOsResourceLeaseBroker { if (!broker) fail("one-os-lease-host-unavailable"); return broker!; }
export function configuredOneOsLeaseBroker(): OneOsResourceLeaseBroker | null { return broker; }

let hostAvailable=false;
export function markOneOsHostAvailable(value:boolean):void {hostAvailable=value;}
export function isOneOsHostAvailable():boolean {return hostAvailable && broker!==null;}
