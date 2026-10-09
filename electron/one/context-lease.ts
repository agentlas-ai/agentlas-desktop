import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { OneContextLeaseState, OneContextReadiness } from "../../shared/one-context";

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
interface Execution { binding: Readonly<OneOsExecutionBinding>; token: string; assertCurrent(): void; signal?: AbortSignal; dispose(): void; revoked: boolean }
export interface OneOsLeasePorts {
  readiness(): OneContextReadiness;
  validateTarget(binding: Readonly<OneOsExecutionBinding>, target: OneOsActionTarget): Promise<void>;
  validateObservation?(binding: Readonly<OneOsExecutionBinding>, input: { appTarget?: string; sourceId?: string }): Promise<void>;
  now?(): number;
  changed?(): void;
  resourceLockPath?: string;
}
export class OneOsLeaseError extends Error { constructor(readonly code: string) { super(code); this.name = "OneOsLeaseError"; } }
const fail = (code: string): never => { throw new OneOsLeaseError(code); };
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f]/.test(value); }
/** Private execution authority is registered only by the original prepared native source, never by renderer IPC. */
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
    for(let attempt=0;attempt<2;attempt++) {
      try { fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce}),{flag:"wx",mode:0o600});
        return () => { try { const row=JSON.parse(fs.readFileSync(file,"utf8"));if(row.pid===process.pid && row.nonce===nonce)fs.unlinkSync(file); } catch {} };
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=="EEXIST")fail("one-os-resource-lock-unavailable");
        try { const row=JSON.parse(fs.readFileSync(file,"utf8"));if(!Number.isSafeInteger(row.pid)||row.pid<1)fail("one-os-resource-lock-unavailable");
          try { process.kill(row.pid,0);fail("one-os-resource-busy"); } catch(check) { if((check as NodeJS.ErrnoException).code!=="ESRCH")throw check; }
          // Serialize stale cleanup across competing processes. A live/new owner
          // cannot be unlinked by another contender that observed an older PID.
          const repair=`${file}.repair`;let repaired=false;
          try {fs.writeFileSync(repair,String(process.pid),{flag:"wx",mode:0o600});repaired=true;
            const latest=JSON.parse(fs.readFileSync(file,"utf8"));
            if(latest.pid!==row.pid||latest.nonce!==row.nonce)fail("one-os-resource-busy");
            try {process.kill(latest.pid,0);fail("one-os-resource-busy");}catch(check){if((check as NodeJS.ErrnoException).code!=="ESRCH")throw check;}
            fs.unlinkSync(file);
          } finally {if(repaired)fs.unlinkSync(repair);}
        } catch(check) { if(check instanceof OneOsLeaseError)throw check;fail("one-os-resource-lock-unavailable"); }
      }
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
    const dispose = () => {
      const record = this.executions.get(executionId); if (!record || record.revoked) return;
      record.revoked = true; signal?.removeEventListener("abort", dispose);
      if (this.holder?.executionId === executionId) { this.holder.reason = "one-os-execution-revoked"; this.holder.controller.abort(); }
      this.executions.delete(executionId); this.ports.changed?.();
    };
    this.executions.set(executionId, { binding: Object.freeze({ ...binding }), token, assertCurrent: assertExecutionCurrent, signal, dispose, revoked: false });
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
  async acquireForAction(capability: unknown, target: OneOsActionTarget): Promise<{ leaseId: string; signal: AbortSignal; checkpoint(): Promise<void>; release(): void }> {
    const execution = this.execution(capability), binding = execution.record.binding;
    if (binding.permissions === "read") fail("one-os-input-permission-denied");
    if (!identifier(target.appTarget)) fail("one-os-action-target-required");
    if (this.holder) fail("one-os-resource-busy");
    const ready = this.ports.readiness();
    if (ready.session !== "awake") fail("one-os-session-unavailable");
    if (!ready.driverAvailable || ready.accessibility !== "granted") fail("one-os-input-unavailable");
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
  acquireLegacyAction(): { checkpoint():Promise<void>; release():void } {
    if(this.holder)fail("one-os-resource-busy");
    const check=()=>{const ready=this.ports.readiness();if(ready.session!=="awake")fail("one-os-session-unavailable");if(ready.humanBusy)fail("one-os-human-active");};check();
    const unlock=this.processLock(),holder={leaseId:randomUUID(),executionId:"legacy",target:{appTarget:"legacy-authorized"},until:this.now()+30_000,controller:new AbortController(),reason:undefined as string|undefined};this.holder=holder;
    let released=false;
    return {checkpoint:async()=>{if(released||holder.controller.signal.aborted||holder.until<=this.now())fail("one-os-lease-unavailable");check();},release:()=>{if(released)return;released=true;unlock();if(this.holder===holder)this.holder=null;}};
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
