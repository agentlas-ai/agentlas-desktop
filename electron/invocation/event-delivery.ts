import type { McpInvocationEvent } from "../../shared/types";
import type { RunEventReplayInput, RunEventReplay } from "../../shared/run-event-delivery";

interface Journal {
  chatId: string; ordinal: number; bytes: number; touchedAt: number; terminalAt: number | null;
  entries: Map<number, { event: McpInvocationEvent; bytes: number }>;
  terminalEvent: McpInvocationEvent | null;
}
/**
 * Session-local wire replay. Durable receipts/history own recovery after eviction/restart.
 *
 * Retention (perf review 2026-10-17, R-11). Up to 32 journals of up to 8 MB were kept with no regard to whether their
 * run was still live: finished runs (their history is durable) sat beside live ones for the 10-minute TTL, and a live
 * run that went quiet was the "least recently touched" one evicted when finished runs piled up, sending its viewers
 * to a ledger hydration. Finished journals now go first: at most `terminalRuns` of them stay. A live journal is never
 * dropped for a finished one; background runs keep theirs (they get no push, so replay is their only live channel),
 * and `runs` in all bounds only a host with that many live runs at once. (Holding each event as its JSON string
 * instead of a parsed copy was measured and rejected: it saved nothing for code and English, and a JSON string with
 * any Korean in it is stored two bytes per character, keys included, where a parsed copy keeps its keys one-byte.)
 */
export class RunEventDeliveryJournal {
  private readonly runs = new Map<string, Journal>();
  constructor(private readonly limits = { events: 20_000, bytes: 8 * 1024 * 1024, runs: 32, terminalRuns: 8, ttlMs: 10 * 60_000 }, private readonly now = Date.now) {}
  publish(runId: string, chatId: string, event: McpInvocationEvent, ordinal: number): McpInvocationEvent {
    let journal = this.runs.get(runId);
    if (journal && journal.chatId !== chatId) throw new Error("run-event-delivery-owner-mismatch");
    if (!journal) {
      journal = { chatId, ordinal: 0, bytes: 0, touchedAt: this.now(), terminalAt: null, entries: new Map(), terminalEvent: null };
      this.runs.set(runId, journal);
    }
    const delivered: McpInvocationEvent = { ...event, delivery: { schemaVersion: "agentlas.run-event-delivery.v1", runId, chatId,
      ordinal, ...(Number.isSafeInteger(event.sequence) ? { sourceSequence: event.sequence } : {}) } };
    if (!Number.isSafeInteger(ordinal) || ordinal <= journal.ordinal) throw new Error("run-event-delivery-ordinal-invalid");
    journal.ordinal = ordinal;
    journal.touchedAt = this.now();
    // 토큰마다 지나는 길이다 — 직렬화 한 번으로 크기와 격리 스냅샷을 함께 얻는다(structuredClone 별도 호출 제거).
    const json = JSON.stringify(delivered);
    const bytes = Buffer.byteLength(json);
    const snapshot = JSON.parse(json) as McpInvocationEvent;
    journal.entries.set(ordinal, { event: snapshot, bytes }); journal.bytes += bytes;
    while (journal.entries.size > this.limits.events || journal.bytes > this.limits.bytes) {
      const first = journal.entries.entries().next().value!;
      journal.bytes -= first[1].bytes; journal.entries.delete(first[0]);
    }
    if (event.kind === "final" || event.kind === "error") {
      journal.terminalAt = this.now();
      // Reserve a bounded terminal summary; the full final text remains in canonical chat history.
      journal.terminalEvent = { kind: event.kind, sequence: event.sequence, observedAt: event.observedAt, delivery: delivered.delivery,
        ...(event.kind === "error" && event.error ? { error: { code: event.error.code, message: event.error.message.slice(0, 1000) } } : {}),
        ...(event.durableMessageId ? { durableMessageId: event.durableMessageId } : {}) };
    }
    this.prune();
    return delivered;
  }
  replay(input: RunEventReplayInput): Omit<RunEventReplay, "receipt"> {
    this.prune();
    const journal = this.runs.get(input.runId);
    if (journal && journal.chatId !== input.chatId) throw new Error("run-event-delivery-owner-mismatch");
    const base = { schemaVersion: "agentlas.run-event-replay.v1" as const, runId: input.runId, chatId: input.chatId };
    if (!journal) return { ...base, status: "unavailable", latestOrdinal: 0, events: [], terminalEvent: null };
    if (input.afterOrdinal > journal.ordinal) throw new Error("run-event-replay-cursor-ahead");
    const first = journal.entries.keys().next().value ?? journal.ordinal + 1;
    const complete = input.afterOrdinal >= first - 1;
    const events: McpInvocationEvent[] = [];
    if (complete && input.afterOrdinal < journal.ordinal) {
      // Most polls are caught up or need only a short tail. Avoid allocating
      // and scanning the entire retained journal on each observer request.
      const span = journal.ordinal - input.afterOrdinal;
      if (span <= journal.entries.size) {
        for (let ordinal = input.afterOrdinal + 1; ordinal <= journal.ordinal; ordinal++) {
          const row = journal.entries.get(ordinal);
          if (row) events.push(row.event);
        }
      } else {
        // A sparse publisher remains bounded by retained entries, not the
        // numerical distance between cursors.
        for (const row of journal.entries.values()) {
          if (row.event.delivery!.ordinal > input.afterOrdinal) events.push(row.event);
        }
      }
    }
    return { ...base, status: complete ? "complete" : "truncated", latestOrdinal: journal.ordinal,
      events: events.length ? structuredClone(events) : [],
      terminalEvent: structuredClone(journal.terminalEvent) };
  }
  private prune(): void {
    const now = this.now();
    let terminal = 0;
    for (const [id, run] of this.runs) {
      if (run.terminalAt === null) continue;
      if (now - run.touchedAt > this.limits.ttlMs) this.runs.delete(id);
      else terminal++;
    }
    // Finished runs first (least recently touched), then, only past the total bound, the least recently touched run.
    while (terminal > this.limits.terminalRuns) {
      const oldest = this.leastRecentlyTouched(true);
      if (!oldest) break;
      this.runs.delete(oldest); terminal--;
    }
    while (this.runs.size > this.limits.runs) {
      const oldest = this.leastRecentlyTouched(terminal > 0);
      if (!oldest) break;
      if (this.runs.get(oldest)!.terminalAt !== null) terminal--;
      this.runs.delete(oldest);
    }
  }
  private leastRecentlyTouched(terminalOnly: boolean): string | undefined {
    let oldest: [string, Journal] | undefined;
    for (const entry of this.runs) {
      if (terminalOnly && entry[1].terminalAt === null) continue;
      if (!oldest || entry[1].touchedAt < oldest[1].touchedAt) oldest = entry;
    }
    return oldest?.[0];
  }
}
