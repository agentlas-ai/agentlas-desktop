import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { acquireAgentContextTurnSlot, type AgentContextTurnSlotOptions } from "./agent-context-turn-order";

/** The logical writer, not a process cache key, a model configuration, or a Work project. */
export interface NativeWriterIdentity {
  runtimeKind: string;
  contextKey?: string | null;
  nativeSessionId?: string | null;
  chatId?: string | null;
  sessionOwnerId?: string | null;
  isolatedOwner?: boolean;
}
export function nativeWriterKey(identity: NativeWriterIdentity): string | null {
  const logical = identity.contextKey ? ["context", identity.contextKey]
    : identity.nativeSessionId ? ["native", identity.runtimeKind, identity.nativeSessionId]
    : identity.chatId ? ["conversation", identity.runtimeKind, identity.chatId,
      identity.sessionOwnerId ?? null, identity.isolatedOwner === true] : null;
  return logical ? createHash("sha256").update(JSON.stringify(["agentlas.native-writer.v1", logical])).digest("hex") : null;
}

interface WriterScope { key: string; keys: readonly string[]; heldKeys: readonly string[]; signal?: AbortSignal; closes: Set<Promise<unknown>> }
const active = new AsyncLocalStorage<WriterScope>();
/** A process whose close has not been measured cannot be replaced even after its caller stopped awaiting it. */
const closing = new Map<string, Set<Promise<unknown>>>();
export function retainNativeWriterClose(key: string, completion: Promise<unknown>): void {
  const pending = closing.get(key) ?? new Set<Promise<unknown>>();
  pending.add(completion); closing.set(key, pending);
  const scope = active.getStore();
  if (scope?.keys.includes(key)) scope.closes.add(completion);
  void completion.then(() => {
    pending.delete(completion);
    if (!pending.size && closing.get(key) === pending) closing.delete(key);
  }, () => { /* Failed termination stays quarantined; cancellation never grants a replacement writer. */ });
}
export function currentNativeWriter(): Readonly<WriterScope> | undefined { return active.getStore(); }

/** Fair, Stop-aware admission. Provider silence/turn budgets begin inside action, never while waiting here. */
export async function acquireNativeWriter(key: string, options: Omit<AgentContextTurnSlotOptions, "blocked"> = {}): Promise<() => void> {
  const slot = await acquireAgentContextTurnSlot(`native-writer:${key}`, {
    ...options, blocked: () => (closing.get(key)?.size ?? 0) > 0,
    waitPastLimit: true,
    onParked: options.onParked ?? (() => {}),
  });
  return slot.release;
}
/** The writer is acquired before a global run slot. Waiting on one thread never consumes the CLI budget. */
export async function withNativeWriter<T>(key: string | null, options: Omit<AgentContextTurnSlotOptions, "blocked">,
  action: () => Promise<T>): Promise<T> {
  return withNativeWriterKeys(key ? [key] : [], () => options, action);
}
/** A journal and its known native handle name the same writer in different hosts. Take both aliases in one fixed
 * order before taking any global capacity, so neither a model switch nor an independent Terminal resume can race it. */
export async function withNativeWriterKeys<T>(aliases: readonly string[],
  optionsFor: (key: string) => Omit<AgentContextTurnSlotOptions, "blocked">, action: () => Promise<T>): Promise<T> {
  const keys = [...new Set(aliases)].sort();
  if (!keys.length) return action();
  const parent = active.getStore();
  // A nested dispatch cannot borrow the parent's active provider thread. Waiting here would deadlock the parent;
  // silently re-entering would violate its single-writer contract. The host must give child work its own session.
  if (keys.some(key => parent?.heldKeys.includes(key))) throw Object.assign(new Error("native_writer_reentrant_dispatch"), {
    code: "native_writer_reentrant_dispatch", turnDelivery: "not-dispatched",
  });
  const releases: Array<() => void> = [];
  let scope: WriterScope | undefined;
  try {
    for (const key of keys) releases.push(await acquireNativeWriter(key, optionsFor(key)));
    const signal = optionsFor(keys[0]).signal;
    signal?.throwIfAborted();
    scope = { key: keys[0], keys, heldKeys: [...(parent?.heldKeys ?? []), ...keys], signal, closes: new Set() };
    return await active.run(scope, action);
  } finally {
    // A runner may return after requesting its pool discard. Keep the durable ticket until the ORIGINAL physical
    // close settles; neither a UI abort race nor releasing the invocation lease proves that another host may resume.
    let observed = 0;
    do {
      const pending = scope ? [...scope.closes] : []; observed = pending.length;
      const drained = await Promise.allSettled(pending);
      const failed = drained.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw Object.assign(new Error("native_writer_close_unconfirmed", { cause: failed.reason }), { code: "native_writer_close_unconfirmed" });
    } while (scope && scope.closes.size > observed);
    for (const release of releases.reverse()) release();
  }
}
