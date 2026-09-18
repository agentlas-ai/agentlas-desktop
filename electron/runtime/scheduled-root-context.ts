import { AsyncLocalStorage } from "node:async_hooks";

// Main-only capability: never serialize this scope into a request, env, MCP
// message or renderer event. Lost async context is deliberately unknown.
interface ScheduledRoot { lifetime: AbortController }
interface AgyDispatch { active: boolean; root: ScheduledRoot | undefined }
const roots = new AsyncLocalStorage<ScheduledRoot | undefined>();
const ancestry = new AsyncLocalStorage<readonly AgyDispatch[]>();

/** Only the scheduler's native due callback enters a fresh independent root.
 * Re-entry cannot launder inherited/expired authority or an AGY ancestor. */
export async function withMainScheduledRoot<T>(action: () => Promise<T>): Promise<T> {
  if (roots.getStore() || ancestry.getStore()?.length) return roots.run(undefined, action);
  const root: ScheduledRoot = { lifetime: new AbortController() };
  return roots.run(root, async () => {
    try { return await action(); }
    finally { root.lifetime.abort(new Error("agy_scheduled_root_expired")); }
  });
}

/** Enclose the entire adapter invocation, including preparation and drainage.
 * Retain even expired ancestors in inherited callbacks: they are not roots. */
export async function withAgyDispatchAncestry<T>(action: () => Promise<T>): Promise<T> {
  const parents = ancestry.getStore() ?? [];
  const frame: AgyDispatch = { active: true, root: parents.length === 0 ? roots.getStore() : undefined };
  return ancestry.run([...parents, frame], async () => {
    try { return await action(); }
    finally { frame.active = false; }
  });
}

/** Null means keep the ordinary bounded wait. Even an attested independent
 * root needs its caller's cancellation/deadline; revocation also aborts it. */
export function scheduledRootAgySignal(caller: AbortSignal | undefined): AbortSignal | null {
  const frames = ancestry.getStore();
  if (!caller || !frames || frames.length !== 1 || !frames[0].active) return null;
  const root = frames[0].root;
  if (!root || roots.getStore() !== root || root.lifetime.signal.aborted) return null;
  return AbortSignal.any([caller, root.lifetime.signal]);
}
