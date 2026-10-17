import type { McpInvocationEvent } from "@shared/types";
import type { RunEventReplay, RunEventReplayInput } from "@shared/run-event-delivery";
import { isLivePartialCommitBoundary, reassembleAgentLivePartial } from "@shared/interrupted-partial";

/*
 * When the subscriber asks Main to replay (perf review 2026-10-17, R-04). Push is the live channel; replay is the
 * safety net. The net polled every second whatever push did, and asked from the painted cursor, which stops while a
 * hidden window has no animation frames, so Main re-sent the whole retained backlog each second. For a run Main does
 * not host (the daemon's), every quiet poll also re-read the run's ledger. These pure rules keep the net but cast it
 * only for a hole, a failed request, a hydration need, or a silent push. They live in this file because the
 * existing gates load it alone (a new import would not resolve there).
 */

/** No push for this long and the tick asks Main once (then backs off). */
export const RUN_EVENT_QUIET_MS = 2_000;
/** Longest gap between safety polls while push stays silent. A missed final still lands within this. */
export const RUN_EVENT_MAX_BACKOFF_MS = 8_000;

/** Highest ordinal held without a hole: the projected cursor extended over contiguous received ordinals. */
export function receivedThroughOrdinal(cursor: number, pending: { has(ordinal: number): boolean }): number {
  let through = cursor;
  while (pending.has(through + 1)) through++;
  return through;
}

/** A received ordinal sits beyond a missing one. Pending ordinals are all above the cursor. */
export function hasDeliveryGap(cursor: number, receivedThrough: number, pendingSize: number): boolean {
  return pendingSize > receivedThrough - cursor;
}

export interface RunEventTickInput {
  now: number;
  hidden: boolean;
  gap: boolean;
  needsHydration: boolean;
  /** The last replay request failed (not a permanent refusal): it is asked again on the next tick. */
  retryDue: boolean;
  lastPushAt: number;
  lastQueryAt: number;
  backoffMs: number;
  quietMs: number;
}

/** Whether a poll tick sends a replay request. A hidden window asks once when it is shown again instead. */
export function shouldQueryOnTick(input: RunEventTickInput): boolean {
  if (input.hidden) return false;
  if (input.gap || input.needsHydration || input.retryDue) return true;
  return input.now - input.lastPushAt >= input.quietMs && input.now - input.lastQueryAt >= input.backoffMs;
}

/** A quiet replay that brought nothing new doubles the wait, up to the cap. Any push resets it to the base. */
export function nextQuietBackoff(currentMs: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(baseMs, currentMs * 2));
}

export interface RunEventRecoverInput {
  status: "complete" | "truncated" | "unavailable";
  receiptStatus: string | null | undefined;
  gap: boolean;
  needsHydration: boolean;
  /** The subscription's first replay: the dispatch/attach catch-up keeps its one canonical hydration. */
  initial: boolean;
  /** Push has been silent for the quiet window. */
  quiet: boolean;
}

/**
 * Whether a replay that is not a complete wire tail runs the canonical recovery. Main answers "unavailable" for a
 * live run it does not host; while push for that run is healthy and nothing is missing there is nothing to recover.
 * A terminal receipt, a hole, a hydration need, the first replay and a silent push still recover.
 */
export function shouldRecoverReplay(input: RunEventRecoverInput): boolean {
  if (input.status !== "unavailable") return true;
  if (input.receiptStatus !== "running" && input.receiptStatus !== "cancelling") return true;
  return input.gap || input.needsHydration || input.initial || input.quiet;
}

interface RecoveryCheckpoint {
  throughOrdinal: number;
  /** Check immediately before applying asynchronous hydration, outside queued state updaters. */
  isCurrent: () => boolean;
}
interface Options {
  runId: string; chatId: string;
  listen: (listener: (event: McpInvocationEvent) => void) => () => void;
  replay: (input: RunEventReplayInput) => Promise<RunEventReplay>;
  consume: (event: McpInvocationEvent) => void;
  /** Canonical transcript/activity hydration, not replay of evicted side effects. */
  recover: (snapshot: RunEventReplay, checkpoint: RecoveryCheckpoint) => Promise<boolean>;
  schedule?: (callback: () => void) => () => void;
  pollMs?: number;
  /** Safety-poll tuning (see run-event-poll-policy.ts); tests shorten them. */
  quietMs?: number;
  maxBackoffMs?: number;
}
/** One gate before every projection and legacy effect; reducer-only dedupe is too late. */
export function subscribeOrderedRunEvents(options: Options): () => void {
  let disposed = false, cursor = 0, querying = false, cancelFlush: (() => void) | null = null;
  // The host says this run belongs to another chat. That answer never changes for this (run, chat) pair.
  let refused = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let projectionRevision = 0;
  const pending = new Map<number, McpInvocationEvent>();
  const sizes = new Map<number, number>();
  // Each teammate's accumulated live text. Main sends teammate partials as deltas (perf review 2026-10-17, R-03);
  // every projection below still receives the teammate's whole `text`, in delivery order.
  const teammateTexts = new Map<string, string>();
  let pendingBytes = 0, needsHydration = false;
  // Safety-poll state: push health, the last replay request, and the current quiet backoff.
  const pollMs = options.pollMs ?? 1000, quietMs = options.quietMs ?? RUN_EVENT_QUIET_MS;
  const maxBackoffMs = options.maxBackoffMs ?? RUN_EVENT_MAX_BACKOFF_MS;
  let lastPushAt = Date.now(), lastQueryAt = 0, backoffMs = pollMs, queries = 0, retryDue = false;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const gapNow = () => hasDeliveryGap(cursor, receivedThroughOrdinal(cursor, pending), pending.size);
  const schedule = options.schedule ?? (callback => { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); });
  const consume = (event: McpInvocationEvent) => { projectionRevision++; options.consume(event); };
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
    if (disposed) return;
    let partial: McpInvocationEvent | null = null;
    const emitPartial = () => { if (partial && !disposed) consume(partial); partial = null; };
    let count = 0;
    const deadline = performance.now() + 8;
    while (!disposed && pending.has(cursor + 1) && count++ < 20_000 && performance.now() < deadline) {
      const delivered = pending.get(++cursor)!; pending.delete(cursor);
      pendingBytes -= sizes.get(cursor) ?? 0; sizes.delete(cursor);
      const event = delivered.kind === "partial" && delivered.agentId
        ? reassembleAgentLivePartial(teammateTexts, delivered.agentId, delivered) : delivered;
      // Keep provider sequence in delivery.sourceSequence. UI sequence cannot collide
      // with unsequenced host notices or intentional provider-side gaps.
      const projected = { ...event, sequence: cursor };
      // A turn-commit boundary is not newer text; it seals the text before it. Merging it
      // would drop the pending deltas (and a delta merged onto it would drop the seal).
      if (event.kind === "partial" && !event.agentId && !isLivePartialCommitBoundary(event)) {
        if (partial && typeof event.delta === "string") {
          partial = typeof partial.text === "string"
            ? { ...projected, delta: undefined, text: partial.text + event.delta }
            : { ...projected, delta: (partial.delta ?? "") + event.delta };
        } else partial = projected;
      } else { emitPartial(); if (!disposed) consume(projected); }
    }
    emitPartial();
    if (disposed) return;
    if (pending.has(cursor + 1)) armFlush();
    else if (pending.size) void query();
  };
  // Replay owns only its request, never delivery of an already available live prefix.
  const armFlush = () => { if (!disposed && pending.has(cursor + 1) && !cancelFlush) cancelFlush = schedule(flush); };
  const query = async (forceHydration = false) => {
    if (disposed || querying || refused) return;
    querying = true;
    const queryCursor = cursor, queryRevision = projectionRevision;
    const isCurrent = () => !disposed && cursor === queryCursor && projectionRevision === queryRevision;
    const initial = queries++ === 0;
    lastQueryAt = Date.now();
    try {
      // Ask after what this view already holds, not after what it has painted: a hidden window paints nothing, and
      // asking from the painted cursor made Main re-send the whole retained backlog every poll. These ordinals came
      // from Main, so the request is never ahead of its journal; recovery below still checkpoints on `cursor`.
      const afterOrdinal = receivedThroughOrdinal(queryCursor, pending);
      // Main attaches the live texts only to an answer the view rebuilds from (perf review 2026-10-17, H2): this one is,
      // when held events were dropped or a rebuild is owed; a complete tail from a later cursor is not.
      const snapshot = await options.replay({ runId: options.runId, chatId: options.chatId, afterOrdinal,
        ...(forceHydration || needsHydration ? { hydrate: true as const } : {}) });
      retryDue = false;
      if (disposed || snapshot.runId !== options.runId || snapshot.chatId !== options.chatId) return;
      if (snapshot.status === "complete" && !forceHydration && !needsHydration) {
        const before = pending.size;
        for (const event of snapshot.events) enqueue(event);
        if (pending.size > before) backoffMs = pollMs;
        else if (Date.now() - lastPushAt >= quietMs) backoffMs = nextQuietBackoff(backoffMs, pollMs, maxBackoffMs);
      } else if (snapshot.receipt) {
        // A live run Main does not host answers "unavailable" on every poll. With push healthy and nothing missing,
        // re-reading its ledger each second recovered nothing (and cost a 500-event read and a re-projection).
        if (!forceHydration && !shouldRecoverReplay({ status: snapshot.status, receiptStatus: snapshot.receipt.status,
          gap: gapNow(), needsHydration, initial, quiet: Date.now() - lastPushAt >= quietMs })) return;
        if (Date.now() - lastPushAt >= quietMs) backoffMs = nextQuietBackoff(backoffMs, pollMs, maxBackoffMs);
        // An unavailable journal has no known wire cursor. Its canonical recovery
        // must retain our cursor, and no recovery may overwrite newer live/legacy UI.
        if (!isCurrent() || (snapshot.status !== "unavailable" && snapshot.latestOrdinal < cursor)) return;
        const throughOrdinal = Math.max(cursor, snapshot.latestOrdinal);
        const applied = await options.recover(snapshot, { throughOrdinal, isCurrent });
        if (!applied || !isCurrent()) return;
        needsHydration = false;
        cursor = throughOrdinal;
        // Teammate deltas after the hydrated cursor extend Main's bases at that cursor. Without them (a replay that
        // only says "unavailable" keeps what this view holds) a teammate shows no new words until its next whole frame.
        if (snapshot.agentPartialTexts || snapshot.status !== "unavailable") {
          teammateTexts.clear();
          for (const [agentId, text] of Object.entries(snapshot.agentPartialTexts ?? {})) teammateTexts.set(agentId, text);
        }
        for (const ordinal of pending.keys()) if (ordinal <= cursor) {
          pending.delete(ordinal); pendingBytes -= sizes.get(ordinal) ?? 0; sizes.delete(ordinal);
        }
      }
    } catch (error) {
      retryDue = true;
      // A permanent refusal must not be retried every second for as long as the screen stays open (81 calls in 80 s,
      // 2026-10-12 1.3.4). Anything else keeps the cursor and pending state and the poll retries; Stop never waits here.
      if (/run-event-replay-owner-mismatch/.test(String((error as { message?: unknown } | null)?.message ?? error))) {
        refused = true;
        if (poll !== undefined) clearInterval(poll);
      }
    }
    finally { querying = false; armFlush(); }
  };
  const stopListening = options.listen(event => {
    if (disposed) return;
    if (!event.delivery || owns(event)) { lastPushAt = Date.now(); backoffMs = pollMs; }
    // Older hosts retain their legacy path; a forged/mismatched typed identity is never accepted.
    if (!event.delivery) { consume(event); return; }
    enqueue(event);
    if (pending.has(cursor + 1)) armFlush();
    else if (pending.size) void query();
  });
  // Subscribe first, then catch the dispatch/attach IPC race through the same ordered gate.
  void query();
  // The safety poll asks only for a hole, a failed request, a hydration need, or a silent push (backing off to maxBackoffMs).
  poll = setInterval(() => {
    if (shouldQueryOnTick({ now: Date.now(), hidden: hidden(), gap: gapNow(), needsHydration, retryDue, lastPushAt, lastQueryAt, backoffMs, quietMs })) void query();
  }, pollMs);
  if (refused) clearInterval(poll);
  // A hidden window skips the ticks; it asks once as soon as it is shown again.
  const onVisibility = () => { if (!hidden()) void query(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  return () => {
    if (disposed) return; disposed = true; stopListening(); if (poll !== undefined) clearInterval(poll); cancelFlush?.(); pending.clear(); sizes.clear(); pendingBytes = 0;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
}
