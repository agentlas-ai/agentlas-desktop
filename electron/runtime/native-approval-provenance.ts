import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ToolApprovalRequestEvent } from "../../shared/types";

/** Native source-only authority. No IPC/tool imports these constructors. */
export interface NativeApprovalExecution {
  readonly originalRequest: object;
  readonly runId: string; readonly chatId: string; readonly ownerId: string; readonly leaseId: string;
  readonly signal: AbortSignal;
  readonly actor: Readonly<{ userId: string; workspaceId: string }> | null;
  assertCurrent(): void;
}
interface Owner { source: NativeApprovalExecution; active: boolean }
interface SignalOwner { owner: Owner; parent?: AbortSignal }
export type NativeApprovalObservation = Readonly<Pick<NativeApprovalExecution, "runId" | "chatId" | "ownerId" | "leaseId" | "actor"> & {mode: "live" | "post-denial"}>;
interface Approval { owner: Owner; signal?: AbortSignal; ledger: object | null; digest: string; mode: "live" | "post-denial" }
const scopes = new AsyncLocalStorage<Owner>();
const signals = new WeakMap<AbortSignal, SignalOwner>();
const approvals = new WeakMap<object, Approval>();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function current(owner: Owner): void {
  if (!owner.active || owner.source.signal.aborted) fail("native_approval_execution_ended");
  owner.source.assertCurrent();
}
/** Called inside the actual service-owned MainInvocationLifetime root only. */
export async function withNativeApprovalExecution<T>(source: NativeApprovalExecution | undefined, action: () => Promise<T>): Promise<T> {
  if (!source) return action();
  source.assertCurrent(); source.signal.throwIfAborted();
  if (scopes.getStore() || signals.has(source.signal)) fail("native_approval_execution_rebound");
  const owner: Owner = { source: Object.freeze({ ...source, actor: source.actor ? Object.freeze({ ...source.actor }) : null }), active: true };
  signals.set(source.signal, { owner });
  try { return await scopes.run(owner, action); }
  finally { owner.active = false; }
}
/** Actual child-controller construction sites alone register lineage. Unknown
 * ordinary signals are untouched; native ownership cannot be made from JSON. */
export function registerNativeApprovalChildSignal(parent: AbortSignal | undefined, child: AbortSignal): void {
  if (!parent) return;
  const binding = signals.get(parent);
  if (!binding) return;
  current(binding.owner);
  const prior = signals.get(child);
  if (prior && (prior.owner !== binding.owner || prior.parent !== parent)) fail("native_approval_signal_rebound");
  if (child === parent) fail("native_approval_signal_cycle");
  signals.set(child, { owner: binding.owner, parent });
}
/** Resident socket callbacks restore the original source scope from their
 * registered actual signal. The existing policy/ledger still makes decisions. */
export function withNativeApprovalAsk<T>(signal: AbortSignal | undefined, action: () => T): T {
  const binding = signal && signals.get(signal), scope = scopes.getStore();
  if (!binding) {
    if (scope) fail("native_approval_signal_unregistered");
    return action();
  }
  current(binding.owner); signal!.throwIfAborted();
  if (scope && scope !== binding.owner) fail("native_approval_execution_mismatch");
  return scopes.run(binding.owner, action);
}
export function nativeApprovalActorSnapshot(): { actor: NativeApprovalExecution["actor"] } | undefined {
  const owner = scopes.getStore();
  if (!owner) return undefined;
  current(owner); return { actor: owner.source.actor };
}
/** Stamp the ORIGINAL pending request after its original ledger persist and
 * before publishing it. Serialized copies never recover this association. */
export function stampNativeToolApproval(request: ToolApprovalRequestEvent, signal: AbortSignal | undefined, ledger: object | null): void {
  const binding = signal && signals.get(signal), scope = scopes.getStore();
  if (!binding) { if (scope) fail("native_approval_signal_unregistered"); return; }
  current(binding.owner); signal!.throwIfAborted();
  if (request.chatId !== binding.owner.source.chatId || (scope && scope !== binding.owner)) fail("native_approval_request_mismatch");
  if (approvals.has(request)) fail("native_approval_request_rebound");
  approvals.set(request, { owner: binding.owner, signal: signal!, ledger, digest: digest(request), mode: "live" });
}
/** An original already-denied card conveys consent for later calls only. The
 * immutable source observation survives execution end; it grants no run lease. */
export function stampNativeDeniedApproval(request: ToolApprovalRequestEvent, signal: AbortSignal | undefined, ledger: object | null): void {
  const binding = signal && signals.get(signal), scope = scopes.getStore();
  const owner = binding?.owner ?? scope;
  if (!owner) return;
  if (scope && binding && scope !== binding.owner) fail("native_approval_execution_mismatch");
  current(owner); signal?.throwIfAborted();
  if (request.mode !== "post-denial" || (request.chatId && request.chatId !== owner.source.chatId)) fail("native_approval_request_mismatch");
  if (approvals.has(request)) fail("native_approval_request_rebound");
  approvals.set(request, { owner, signal, ledger, digest: digest(request), mode: "post-denial" });
}
export function nativeToolApprovalOwner(request: ToolApprovalRequestEvent): NativeApprovalObservation | undefined {
  const approval = approvals.get(request);
  if (!approval) return undefined;
  if (digest(request) !== approval.digest) fail("native_approval_request_changed");
  if (approval.mode === "live") { current(approval.owner); approval.signal!.throwIfAborted(); }
  const {runId, chatId, ownerId, leaseId, actor} = approval.owner.source;
  return Object.freeze({runId, chatId, ownerId, leaseId, actor, mode: approval.mode});
}
export function assertNativeToolApproval(request: ToolApprovalRequestEvent, ledger: object | null): NativeApprovalObservation {
  const approval = approvals.get(request);
  if (!approval || approval.ledger !== ledger) fail("native_approval_original_request_required");
  return nativeToolApprovalOwner(request) ?? fail("native_approval_original_request_required");
}

export function assertNativeToolApprovalJoin(request: ToolApprovalRequestEvent, signal: AbortSignal | undefined): void {
  const prior = approvals.get(request), incoming = signal && signals.get(signal);
  if (!prior && !incoming) return;
  if (!prior || !incoming || prior.owner !== incoming.owner) fail("native_approval_join_owner_changed");
  current(prior.owner); signal!.throwIfAborted();
}
