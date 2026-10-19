import { registerNativeApprovalChildSignal } from "./native-approval-provenance";

/**



 */
export function linkAbort(parent?: AbortSignal) {
  const ctrl = new AbortController();
  const onParent = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else {
      registerNativeApprovalChildSignal(parent, ctrl.signal);
      parent.addEventListener("abort", onParent, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    dispose: () => parent?.removeEventListener("abort", onParent),
  };
}

/** Approval lineage for a child controller that relays its parent by hand and may outlive the native execution that
 * started it (a graph run begun by a turn's app operation keeps going after that turn). While the execution is live the
 * child is registered, so tool asks under it are not refused native_approval_signal_unregistered (audit R-102: the
 * graph controllers and publish auto-fix were the remaining unregistered sites). Once the execution has ended its
 * approvals end with it: the child then carries no lineage, exactly as before, instead of failing the step that made it. */
export function registerApprovalLineageIfLive(parent: AbortSignal | undefined, child: AbortSignal): void {
  try { registerNativeApprovalChildSignal(parent, child); }
  catch { /* the execution behind `parent` ended or moved on: no lineage, asks under `child` stay refused */ }
}
