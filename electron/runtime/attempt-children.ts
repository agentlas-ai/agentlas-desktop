import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

/** An invocation owns only children currently checked out to it. Released
 * resident sessions may be borrowed by another invocation and must survive. */
export interface AttemptChildren {
  readonly children: Set<ChildProcess>;
  closing: boolean;
  unconfirmed?: boolean;
  stop: (child: ChildProcess) => void;
}
const context = new AsyncLocalStorage<AttemptChildren>();
const owners = new WeakMap<ChildProcess, AttemptChildren>();

export function withAttemptChildren<T>(scope: AttemptChildren, fn: () => T): T {
  return context.run(scope, fn);
}

/** A remote execution host can disappear after dispatch. An empty local child
 * set must not turn that lost termination receipt into replay authority. */
export function markAttemptQuiescenceUnconfirmed(): void {
  const scope = context.getStore();
  if (scope) scope.unconfirmed = true;
}

export function claimAttemptChild(child: ChildProcess): void {
  const scope = context.getStore();
  const previous = owners.get(child);
  if (previous === scope) return;
  if (previous?.closing) {
    previous.stop(child);
    throw new Error("runtime_attempt_child_closing");
  }
  previous?.children.delete(child);
  if (!scope) { owners.delete(child); return; }
  owners.set(child, scope);
  scope.children.add(child);
  if (scope.closing) scope.stop(child);
}

export function releaseAttemptChild(child: ChildProcess): void {
  const owner = owners.get(child);
  // A cancellation drain must retain ownership until process/group exit is
  // measured, even if an adapter attempts to return its session to the pool.
  if (owner?.closing) { owner.stop(child); return; }
  owner?.children.delete(child);
  owners.delete(child);
}
