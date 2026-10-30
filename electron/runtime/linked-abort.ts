import { registerNativeApprovalChildSignal } from "./native-approval-provenance";

/** A child AbortController tied to `parent`: the parent's abort reaches it, and it can abort alone (a worker's
 * inactivity timeout). Native approval provenance follows signals, so the child is registered as the parent's
 * lineage: without that, every tool ask made under the child inside a native execution is refused as
 * native_approval_signal_unregistered (production 1.3.49: a room's teammates on Agentlas Light could not list or
 * read one file, because the task force and firm worker turns each ran under a fresh unregistered controller). */
export function linkAbort(parent?: AbortSignal) {
  const ctrl = new AbortController();
  // The parent's reason travels with its abort. A bare abort() gave every worker the DOM default "This operation was aborted"
  // in place of why the run stopped (app_closed, update_restart, the owner's stop, a steering interrupt): production
  // 2026-10-02..25 recorded that sentence as the cause of 12 interrupted runs and in the teammates' own failure lines.
  const onParent = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
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
