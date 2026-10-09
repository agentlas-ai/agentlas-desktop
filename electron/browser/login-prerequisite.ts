import { registerNativeApprovalChildSignal } from "../runtime/native-approval-provenance";
import type { LoginPrerequisiteRef, LoginRecoveryOutcome } from "./login-recovery";

export type { LoginPrerequisiteRef } from "./login-recovery";

/** Main-only custody. Persist prerequisite, never these functions. Restoration
 * is evidence for the consumer's CAS, not permission to replay a tool. */
export interface BrowserLoginWait {
  readonly prerequisite: LoginPrerequisiteRef;
  readonly runtimeQuiesced: boolean;
  onRestored(listener: () => void): () => void;
  cancel(): void;
}

const key = (ref: LoginPrerequisiteRef): string => JSON.stringify([
  ref.prerequisiteId, ref.runId, ref.chatId, ref.nodeId ?? null, ref.sessionId, ref.generation,
]);

export function createBrowserLoginPrerequisite(input: {
  runId: string; chatId: string; nodeId?: string; signal?: AbortSignal;
  onWaiting: (prerequisite: LoginPrerequisiteRef) => void;
}) {
  const owner = new AbortController();
  const execution = new AbortController();
  registerNativeApprovalChildSignal(input.signal, owner.signal);
  registerNativeApprovalChildSignal(input.signal, execution.signal);
  const pending = new Map<string, LoginPrerequisiteRef>();
  const restored = new Set<string>();
  const listeners = new Set<() => void>();
  const scheduled = new Set<() => void>();
  let observations = 0;
  let primary: LoginPrerequisiteRef | undefined;
  let sealed = false;
  let quiesced = false;
  const reason = new Error("browser_login_required");
  const cancel = (): void => {
    if (!owner.signal.aborted) owner.abort(input.signal?.reason ?? new Error("browser_login_wait_closed"));
    if (!execution.signal.aborted) execution.abort(owner.signal.reason);
    listeners.clear();
    input.signal?.removeEventListener("abort", cancel);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const inScope = (ref: LoginPrerequisiteRef): boolean => ref.runId === input.runId
    && ref.chatId === input.chatId && ref.nodeId === input.nodeId;
  const ready = (): boolean => sealed && quiesced && observations === 0 && !owner.signal.aborted && pending.size > 0
    && [...pending.keys()].every(id => restored.has(id));
  const deliver = (): void => {
    if (!ready()) return;
    for (const listener of listeners) {
      if (scheduled.has(listener)) continue;
      scheduled.add(listener);
      queueMicrotask(() => {
        scheduled.delete(listener);
        if (!listeners.has(listener) || !ready()) return;
        listeners.delete(listener);
        listener();
      });
    }
  };
  return {
    ownerSignal: owner.signal,
    signal: execution.signal,
    get waiting(): boolean { return Boolean(primary); },
    beginObservation(): () => void {
      if (execution.signal.aborted) throw execution.signal.reason;
      observations += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        observations -= 1;
        deliver();
      };
    },
    assertRunnable(): void {
      if (execution.signal.aborted) throw execution.signal.reason;
    },
    restored(ref: LoginPrerequisiteRef): void {
      if (owner.signal.aborted || !inScope(ref)) return;
      // A verified event can beat the awaited recovery response. Only references
      // returned by that response can become wait authority below.
      restored.add(key(ref));
      deliver();
    },
    observe(outcomes: readonly LoginRecoveryOutcome[]): void {
      if (owner.signal.aborted) return;
      for (const outcome of outcomes) {
        if (outcome.state !== "awaiting-owner" || !outcome.prerequisite || !inScope(outcome.prerequisite)) continue;
        const ref = Object.freeze({ ...outcome.prerequisite });
        pending.set(key(ref), ref);
        primary ??= ref;
      }
      if (!primary || execution.signal.aborted) return;
      // Persist before requesting native interruption. A failed durable write
      // still closes admission; it must never leak the result to the model.
      try { input.onWaiting(primary); }
      finally { execution.abort(reason); }
    },
    seal(runtimeQuiesced: boolean): BrowserLoginWait | undefined {
      if (!primary || owner.signal.aborted) return undefined;
      quiesced = runtimeQuiesced;
      sealed = true;
      const prerequisite = primary;
      deliver();
      return Object.freeze({
        prerequisite, runtimeQuiesced,
        onRestored(listener: () => void): () => void {
          if (owner.signal.aborted) return () => {};
          let active = true;
          const once = () => { if (active) { active = false; listener(); } };
          listeners.add(once);
          deliver();
          return () => { active = false; listeners.delete(once); };
        },
        cancel,
      });
    },
    cancel,
  };
}

export type BrowserLoginPrerequisiteControl = ReturnType<typeof createBrowserLoginPrerequisite>;
