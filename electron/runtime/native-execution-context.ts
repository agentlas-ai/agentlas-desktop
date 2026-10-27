import { AsyncLocalStorage } from "node:async_hooks";

/** Original service-owned invocation lifetime. No serialized request or model output can install this source. */
export interface NativeExecutionSource {
  readonly runId: string;
  readonly chatId: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly signal: AbortSignal;
  /** Exact service-owned references. Never exposed on the observable token or reconstructed from IDs. */
  readonly invocationIdentity: Readonly<{
    record: object;
    request: object;
    controller: Pick<AbortController, "signal">;
    lease: object;
  }>;
  assertCurrent(): void;
}
declare const liveNativeExecution: unique symbol;
/** Stable process-private object identity, never a permission grant or a serializable run selector. */
export interface LiveNativeExecution extends Omit<NativeExecutionSource, "invocationIdentity"> { readonly [liveNativeExecution]: true }
const executions = new AsyncLocalStorage<LiveNativeExecution>();
const originalSources = new WeakMap<LiveNativeExecution, {
  source: NativeExecutionSource;
  identity: NativeExecutionSource["invocationIdentity"];
}>();

/** Bound only by the invocation service alongside its existing root lifetime. All providers/hosts use the same source. */
export async function withNativeExecution<T>(source: NativeExecutionSource | undefined, action: () => Promise<T>): Promise<T> {
  if (!source) return executions.exit(action);
  source.assertCurrent(); source.signal.throwIfAborted();
  const identity = source.invocationIdentity;
  if (!identity || !identity.record || !identity.request || !identity.lease
    || identity.controller?.signal !== source.signal) {
    throw Object.assign(new Error("native_execution_source_invalid"), { code: "native_execution_source_invalid" });
  }
  // An independently owned service invocation may begin in an inherited async context, including after its parent
  // finished. Compare the original references without reviving or requiring that parent's lifetime.
  const inherited = executions.getStore();
  const prior = inherited && originalSources.get(inherited);
  if (inherited && (!prior || source === prior.source || source.runId === inherited.runId || source.leaseId === inherited.leaseId
    || source.signal === inherited.signal || identity.record === prior.identity.record
    || identity.request === prior.identity.request || identity.controller === prior.identity.controller
    || identity.lease === prior.identity.lease)) {
    throw Object.assign(new Error("native_execution_rebound"), { code: "native_execution_rebound" });
  }
  let active = true;
  const observed = Object.freeze({ runId: source.runId, chatId: source.chatId, ownerId: source.ownerId,
    leaseId: source.leaseId, signal: source.signal,
    assertCurrent() {
      if (!active) throw Object.assign(new Error("native_execution_ended"), { code: "native_execution_ended" });
      if (executions.getStore() !== observed) throw Object.assign(new Error("native_execution_scope_mismatch"), { code: "native_execution_scope_mismatch" });
      source.signal.throwIfAborted(); source.assertCurrent();
    },
  }) as LiveNativeExecution;
  originalSources.set(observed, { source, identity: Object.freeze({ ...identity }) });
  try { return await executions.run(observed, action); }
  finally { active = false; }
}
export function currentNativeExecution(): LiveNativeExecution | undefined {
  const observed = executions.getStore(); observed?.assertCurrent(); return observed;
}
