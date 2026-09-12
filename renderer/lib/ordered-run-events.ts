import type { McpInvocationEvent } from "@shared/types";
import type { RunEventReplay, RunEventReplayInput } from "@shared/run-event-delivery";

interface Options {
  runId: string; chatId: string;
  listen: (listener: (event: McpInvocationEvent) => void) => () => void;
  replay: (input: RunEventReplayInput) => Promise<RunEventReplay>;
  consume: (event: McpInvocationEvent) => void;
  /** Canonical transcript/activity hydration, not replay of evicted side effects. */
  recover: (snapshot: RunEventReplay) => Promise<void>;
  schedule?: (callback: () => void) => () => void;
  pollMs?: number;
}
/** One gate before every projection and legacy effect; reducer-only dedupe is too late. */
export function subscribeOrderedRunEvents(options: Options): () => void {
  let disposed = false, cursor = 0, querying = false, cancelFlush: (() => void) | null = null;
  const pending = new Map<number, McpInvocationEvent>();
  const sizes = new Map<number, number>();
  let pendingBytes = 0, needsHydration = false;
  const schedule = options.schedule ?? (callback => { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); });
  const owns = (event: McpInvocationEvent) => event.delivery?.schemaVersion === "agentlas.run-event-delivery.v1"
    && event.delivery.runId === options.runId && event.delivery.chatId === options.chatId
    && Number.isSafeInteger(event.delivery.ordinal) && event.delivery.ordinal > 0;
  const enqueue = (event: McpInvocationEvent) => {
    if (!owns(event) || event.delivery!.ordinal <= cursor || pending.has(event.delivery!.ordinal)) return;
    const bytes = JSON.stringify(event).length * 2;
    if (pending.size >= 20_000 || pendingBytes + bytes > 16 * 1024 * 1024) {
      pending.clear(); sizes.clear(); pendingBytes = 0; needsHydration = true; void query(true); return;
    }
    pending.set(event.delivery!.ordinal, event);
    sizes.set(event.delivery!.ordinal, bytes); pendingBytes += bytes;
  };
  const flush = () => {
    cancelFlush = null;
    if (disposed || querying) return;
    let partial: McpInvocationEvent | null = null;
    const emitPartial = () => { if (partial && !disposed) options.consume(partial); partial = null; };
    let count = 0;
    const deadline = performance.now() + 8;
    while (!disposed && pending.has(cursor + 1) && count++ < 20_000 && performance.now() < deadline) {
      const event = pending.get(++cursor)!; pending.delete(cursor);
      pendingBytes -= sizes.get(cursor) ?? 0; sizes.delete(cursor);
      // Keep provider sequence in delivery.sourceSequence. UI sequence cannot collide
      // with unsequenced host notices or intentional provider-side gaps.
      const projected = { ...event, sequence: cursor };
      if (event.kind === "partial" && !event.agentId) {
        if (partial && typeof event.delta === "string") {
          partial = typeof partial.text === "string"
            ? { ...projected, delta: undefined, text: partial.text + event.delta }
            : { ...projected, delta: (partial.delta ?? "") + event.delta };
        } else partial = projected;
      } else { emitPartial(); if (!disposed) options.consume(projected); }
    }
    emitPartial();
    if (disposed) return;
    if (pending.has(cursor + 1)) armFlush();
    else if (pending.size) void query();
  };
  const armFlush = () => { if (!disposed && !querying && !cancelFlush) cancelFlush = schedule(flush); };
  const query = async (forceHydration = false) => {
    if (disposed || querying) return;
    querying = true;
    try {
      const snapshot = await options.replay({ runId: options.runId, chatId: options.chatId, afterOrdinal: cursor });
      if (disposed || snapshot.runId !== options.runId || snapshot.chatId !== options.chatId) return;
      if (snapshot.status === "complete" && !forceHydration && !needsHydration) {
        for (const event of snapshot.events) enqueue(event);
      } else if (snapshot.receipt) {
        await options.recover(snapshot);
        if (disposed) return;
        needsHydration = false;
        cursor = Math.max(cursor, snapshot.latestOrdinal);
        for (const ordinal of pending.keys()) if (ordinal <= cursor) {
          pending.delete(ordinal); pendingBytes -= sizes.get(ordinal) ?? 0; sizes.delete(ordinal);
        }
      }
    } catch { /* Keep cursor and pending state. The bounded poll retries; Stop never waits here. */ }
    finally { querying = false; armFlush(); }
  };
  const stopListening = options.listen(event => {
    if (disposed) return;
    // Older hosts retain their legacy path; a forged/mismatched typed identity is never accepted.
    if (!event.delivery) { options.consume(event); return; }
    enqueue(event);
    if (pending.has(cursor + 1)) armFlush();
    else if (pending.size) void query();
  });
  // Subscribe first, then catch the dispatch/attach IPC race through the same ordered gate.
  void query();
  const poll = setInterval(() => { void query(); }, options.pollMs ?? 1000);
  return () => { if (disposed) return; disposed = true; stopListening(); clearInterval(poll); cancelFlush?.(); pending.clear(); sizes.clear(); pendingBytes = 0; };
}
