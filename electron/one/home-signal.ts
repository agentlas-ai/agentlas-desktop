/*
 * "A cause that held the home's move has ended" - a signal, not a timer (Agentlas 2.0 home D2).
 * The move machine (home-move.ts) waits with a code when something on THIS computer is in the way: the personal agent is working, dreaming runs,
 * the engine is busy. Nothing used to tell it when that stopped, so it went on only at the next pointer read. The places that know the cause ended
 * (the supervisor store when a request leaves its open states, dreaming when a pass ends, the memory-move gate when it goes idle) say so here;
 * home.ts listens and drives the move once - and only when a move record is waiting for a local cause. No state is kept here; a call with no listener is a no-op.
 * No imports: the store and dreaming may load this without pulling the home in.
 */
export type HomeCause = "personal_agent" | "dreaming" | "engine";
const listeners = new Set<(cause: HomeCause) => void>();

/** home.ts subscribes once. Returns the unsubscribe. */
export function onHomeCauseEnded(listener: (cause: HomeCause) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Called after the cause ended (never inside a database transaction: the listener runs in a later task). */
export function homeCauseEnded(cause: HomeCause): void {
  if (!listeners.size) return;
  setImmediate(() => { for (const l of [...listeners]) { try { l(cause); } catch { /* an observer never changes the caller */ } } });
}
