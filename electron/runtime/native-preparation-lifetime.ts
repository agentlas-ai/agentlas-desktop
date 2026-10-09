import { AsyncLocalStorage } from "node:async_hooks";

/** Node-only custody retention. It confers no prompt, permission or run-owner
 * authority: the native service supplies its already-owned opaque owner. */
export interface NativePreparationLifetime {
  readonly pendingCount: number;
  readonly admissionClosed: boolean;
  closeAdmission(): void;
  /** Open-phase checkpoint barrier; not a final custody release certificate. */
  awaitRetained(): Promise<void>;
  /** Final barrier requires admission closed and actual retained settlement. */
  quiescent(): Promise<void>;
}
interface State {
  owner: object;
  closed: boolean;
  pending: Set<Promise<unknown>>;
  waiters: Set<() => void>;
}
const scopes = new AsyncLocalStorage<NativePreparationLifetime | undefined>();
const states = new WeakMap<object, State>();
const ownerScopes = new WeakMap<object, NativePreparationLifetime>();
function denied(code: string): never { throw Object.assign(new Error(code), { code }); }
function stateFor(lifetime: NativePreparationLifetime): State {
  const state = states.get(lifetime);
  if (!state) denied("native_preparation_scope_unregistered");
  return state;
}
function current(): State | undefined {
  const scope = scopes.getStore();
  return scope === undefined ? undefined : stateFor(scope);
}
async function waitRetained(state: State): Promise<void> {
  while (state.pending.size > 0) {
    await new Promise<void>(resolve => { state.waiters.add(resolve); });
  }
}
function retain<T>(state: State, promise: Promise<T>): Promise<T> {
  if (state.pending.has(promise)) return promise;
  state.pending.add(promise);
  const settled = () => {
    state.pending.delete(promise);
    if (state.pending.size === 0) {
      const waiters = [...state.waiters]; state.waiters.clear();
      for (const resolve of waiters) resolve();
    }
  };
  // Both handlers return normally; a late rejection must never create another
  // rejecting observer promise or an unhandled rejection after UI detachment.
  void promise.then(settled, settled);
  return promise;
}
export function createNativePreparationLifetime(owner: object): NativePreparationLifetime {
  if (!owner || typeof owner !== "object") denied("native_preparation_owner_invalid");
  if (ownerScopes.has(owner)) denied("native_preparation_owner_already_registered");
  const state: State = { owner, closed: false, pending: new Set(), waiters: new Set() };
  const lifetime: NativePreparationLifetime = {
    get pendingCount() { return stateFor(this).pending.size; },
    get admissionClosed() { return stateFor(this).closed; },
    closeAdmission() { stateFor(this).closed = true; },
    awaitRetained() { return waitRetained(stateFor(this)); },
    async quiescent() {
      const owned = stateFor(this);
      if (!owned.closed) denied("native_preparation_admission_open");
      await waitRetained(owned);
    },
  };
  states.set(lifetime, state); ownerScopes.set(owner, lifetime);
  return Object.freeze(lifetime);
}
export function withNativePreparationLifetime<T>(lifetime: NativePreparationLifetime, action: () => T): T {
  const state = stateFor(lifetime), inherited = current();
  if (state.closed) denied("native_preparation_admission_closed");
  if (inherited && inherited !== state) denied("native_preparation_owner_mismatch");
  if (inherited?.closed) denied("native_preparation_admission_closed");
  return scopes.run(lifetime, action);
}
/** The original promise is registered before any abort grace/race; no native
 * scope is exactly a no-op. Closed orphan scopes cannot register new work. */
export function retainNativePreparation<T>(promise: Promise<T>): Promise<T> {
  const state = current();
  if (!state || state.pending.has(promise)) return promise;
  if (state.closed) denied("native_preparation_admission_closed");
  return retain(state, promise);
}
/** Prevent an inherited closed/native-wrong-owner continuation from dispatching
 * before it manufactures the promise passed to the UI grace helper. */
export function runNativePreparation<T>(start: () => PromiseLike<T>): Promise<T> {
  const state = current();
  if (state?.closed) denied("native_preparation_admission_closed");
  const promise = Promise.resolve(start());
  // If Stop closed admission synchronously inside an admitted start, custody
  // still retains that original operation until its actual settlement.
  return state ? retain(state, promise) : promise;
}

/** Once native preparation admission is closed and every original operation
 * settled, advance the admitted native generator without inheriting its closed
 * preparation ALS. Old orphan continuations keep their original closed scope. */
export function handoffNativePreparation<T>(lifetime: NativePreparationLifetime, action: () => T): T {
  const state = stateFor(lifetime), inherited = current();
  if (inherited && inherited !== state) denied("native_preparation_owner_mismatch");
  if (!state.closed) denied("native_preparation_admission_open");
  if (state.pending.size !== 0) denied("native_preparation_not_quiescent");
  return scopes.run(undefined, action);
}
