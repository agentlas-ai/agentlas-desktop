import type { McpInvocationEvent } from "../../shared/types";
import type { RunEventReplayInput, RunEventReplay } from "../../shared/run-event-delivery";

interface Journal {
  chatId: string; ordinal: number; bytes: number; touchedAt: number; terminalAt: number | null;
  entries: Map<number, { event: McpInvocationEvent; bytes: number }>;
  terminalEvent: McpInvocationEvent | null;
}
/** Session-local wire replay. Durable receipts/history own recovery after eviction/restart. */
export class RunEventDeliveryJournal {
  private readonly runs = new Map<string, Journal>();
  constructor(private readonly limits = { events: 20_000, bytes: 8 * 1024 * 1024, runs: 32, ttlMs: 10 * 60_000 }, private readonly now = Date.now) {}
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
    return { ...base, status: complete ? "complete" : "truncated", latestOrdinal: journal.ordinal,
      events: complete ? structuredClone([...journal.entries.values()].filter(row => row.event.delivery!.ordinal > input.afterOrdinal).map(row => row.event)) : [],
      terminalEvent: structuredClone(journal.terminalEvent) };
  }
  private prune(): void {
    const now = this.now();
    for (const [id, run] of this.runs) if (run.terminalAt !== null && now - run.touchedAt > this.limits.ttlMs) this.runs.delete(id);
    while (this.runs.size > this.limits.runs) {
      const oldest = [...this.runs.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) break;
      this.runs.delete(oldest[0]);
    }
  }
}
