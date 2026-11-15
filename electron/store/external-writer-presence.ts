/**
 * Whether a process other than this one may write the store right now (Agentlas 2.0 P5-2/P5-7). True is the answer to every doubt and the
 * state of the background service itself (Main is its other writer). Main's external-writer gate (store/external-writer-gate.ts) sets it false only
 * when the service is proven gone, and true again at the first sign of one. Timers that exist to pick up what another process wrote (the
 * check-in beat of one/supervisor.ts carries the review of results another process queued) run only while this is true.
 */
let possible = true;
const listeners = new Set<() => void>();
/** The data_version watches running in this process (store/external-chat-changes.ts). Main runs one while a service may exist; the service runs none. */
let watches = 0;
const writeListeners = new Set<() => void>();
const notify = (): void => { for (const listener of [...listeners]) { try { listener(); } catch { /* a listener never decides */ } } };
export function externalWritersPossible(): boolean { return possible; }
export function setExternalWritersPossible(value: boolean): void {
  if (possible === value) return;
  possible = value;
  notify();
}
/** A watch of the store's data_version started; the returned function ends it. It changes who must poll (see externalWritersNeedPolling). */
export function addExternalWriteWatch(): () => void {
  watches += 1;
  notify();
  let live = true;
  return () => { if (!live) return; live = false; watches -= 1; notify(); };
}
/**
 * Another process may write AND nothing in this process would hear it: only then does a timer have to look for its writes. With a data_version watch running
 * (Main while the service may exist) the watch says so the moment another process commits (onExternalWrite), so a job queue needs no period of its own;
 * the service process runs no watch, so its queues keep theirs.
 */
export function externalWritersNeedPolling(): boolean { return possible && watches === 0; }
/** Another process committed to the store (the watch saw data_version move). Called by the watch; one call per observed change, delivered after the current tick. */
export function noteExternalWrite(): void {
  queueMicrotask(() => { for (const listener of [...writeListeners]) { try { listener(); } catch { /* a listener never decides */ } } });
}
export function onExternalWrite(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
}
export function onExternalWritersChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
