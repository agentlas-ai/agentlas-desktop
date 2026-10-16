import { registerNativeApprovalChildSignal } from "./native-approval-provenance";

/** A child AbortController tied to `parent`: the parent's abort reaches it, and it can abort alone (a worker's
 * inactivity timeout). Native approval provenance follows signals, so the child is registered as the parent's
 * lineage: without that, every tool ask made under the child inside a native execution is refused as
 * native_approval_signal_unregistered (production 1.3.49: a room's teammates on Agentlas Light could not list or
 * read one file, because the task force and firm worker turns each ran under a fresh unregistered controller). */
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
