import { AsyncLocalStorage } from "node:async_hooks";

// Main-only capability: never serialize this scope into a request, env, MCP
// message or renderer event. Lost async context is deliberately unknown.
interface ScheduledRoot { lifetime: AbortController }
interface AgyDispatch { active: boolean; root: ScheduledRoot | undefined }
const roots = new AsyncLocalStorage<ScheduledRoot | undefined>();
const ancestry = new AsyncLocalStorage<readonly AgyDispatch[]>();

declare const mainAdmissionBrand: unique symbol;
export type MainInvocationAdmission = { readonly [mainAdmissionBrand]: true };
type MainAdmissionDomain = "invocation" | "automation";
const admissions = new WeakMap<MainInvocationAdmission, { domain: MainAdmissionDomain; ownerId: string; runId?: string }>();

/** Called only by authenticated native ingress or a validated Main wait claim.
 * No request field, missing ALS store, or deserialized object is an admission. */
export function admitMainInvocation(chatId: string, runId?: string): MainInvocationAdmission | undefined {
  return admitMainRoot("invocation", chatId, runId);
}

/** Native manual-graph ingress only; an automation token cannot admit a chat. */
export function admitMainAutomation(automationId: string): MainInvocationAdmission | undefined {
  return admitMainRoot("automation", automationId);
}

function admitMainRoot(domain: MainAdmissionDomain, ownerId: string, runId?: string): MainInvocationAdmission | undefined {
  if (!ownerId || roots.getStore() || ancestry.getStore()?.length) return undefined;
  const admission = Object.freeze({}) as MainInvocationAdmission;
  admissions.set(admission, { domain, ownerId, runId });
  return admission;
}

/** Transfer ownership at method entry, so a pre-start refusal burns the caller's
 * token too. The replacement remains private even when validation throws. */
export function takeMainInvocationAdmission(admission: MainInvocationAdmission | undefined): MainInvocationAdmission | undefined {
  const binding = admission && admissions.get(admission);
  if (admission) admissions.delete(admission);
  if (!binding) return undefined;
  const owned = Object.freeze({}) as MainInvocationAdmission;
  admissions.set(owned, binding);
  return owned;
}

/** Main-memory ownership of the real execution, not start()'s early ID receipt.
 * Children are retained without delaying provider cleanup (verification reads
 * that cleanup's durable effect boundary). Only the full barrier permits handoff. */
export class MainInvocationLifetime {
  private readonly root: ScheduledRoot | undefined;
  private readonly children = new Set<Promise<unknown>>();
  private finished = false;
  private started = false;
  private acceptingChildren = true;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });

  constructor(admission: MainInvocationAdmission | undefined, ownerId: string, runId: string, domain: MainAdmissionDomain = "invocation") {
    const binding = admission && admissions.get(admission);
    if (admission) admissions.delete(admission);
    if (binding?.domain === domain && binding.ownerId === ownerId && (!binding.runId || binding.runId === runId)
      && !roots.getStore() && !ancestry.getStore()?.length) {
      this.root = { lifetime: new AbortController() };
    }
  }

  /** Read-only proof for this currently executing Main root, never a grant. */
  ownsActiveRoot(): boolean {
    return !!this.root && this.started && !this.finished && !this.root.lifetime.signal.aborted
      && roots.getStore() === this.root && (ancestry.getStore()?.length ?? 0) === 0;
  }

  retain(promise: Promise<unknown>): void {
    if (!this.acceptingChildren) throw new Error("main_invocation_children_closed");
    this.children.add(promise);
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.started) throw new Error("main_invocation_already_started");
    this.started = true;
    const execute = async () => {
      try { return await action(); }
      finally {
        this.acceptingChildren = false;
        // Register children synchronously before the runner settles. The child
        // promises include their own catch/finally; neither is detached here.
        await Promise.allSettled([...this.children]);
        this.finished = true;
        this.root?.lifetime.abort(new Error("main_invocation_root_expired"));
        this.resolveDone();
      }
    };
    if (this.root) return roots.run(this.root, execute);
    return roots.run(undefined, execute);
  }

  /** Exact predecessor identity is private to InvocationService. A completed
   * own adapter frame may be shed; foreign/nested frames never become roots. */
  async afterSettled<T>(action: () => T | Promise<T>): Promise<T> {
    await this.done;
    const frames = ancestry.getStore() ?? [];
    const current = roots.getStore();
    if (!this.root || (current && current !== this.root)
      || frames.some((frame) => frame.active || frame.root !== this.root) || frames.length > 1) return action();
    return roots.run(undefined, () => ancestry.run([], action));
  }

  successor(chatId: string, runId: string): MainInvocationAdmission | undefined {
    // afterSettled supplies the narrowly checked fresh context. A reference to
    // an arbitrary expired token or a still-running predecessor cannot renew.
    return this.finished && this.root ? admitMainInvocation(chatId, runId) : undefined;
  }
}

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
