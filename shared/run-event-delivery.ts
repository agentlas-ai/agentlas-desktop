import type { InvocationRunReceipt, McpInvocationEvent } from "./types";

/** Delivery identity is independent of provider/lifecycle evidence sequencing. */
export interface RunEventDelivery {
  schemaVersion: "agentlas.run-event-delivery.v1";
  runId: string;
  chatId: string;
  ordinal: number;
  sourceSequence?: number;
}
export interface RunEventReplayInput {
  runId: string; chatId: string; afterOrdinal: number;
  /**
   * The viewer will rebuild from this answer (it dropped events it held), so the live texts must ride along. Main also
   * attaches them for afterOrdinal 0 and for a replay that is not a complete tail; a complete tail applied event by
   * event never needs them (perf review 2026-10-17, R-04 / H2).
   */
  hydrate?: true;
}
export interface RunEventReplay {
  schemaVersion: "agentlas.run-event-replay.v1";
  runId: string;
  chatId: string;
  status: "complete" | "truncated" | "unavailable";
  latestOrdinal: number;
  events: McpInvocationEvent[];
  /** Display recovery only. Never proof that external effects settled. */
  terminalEvent: McpInvocationEvent | null;
  /** Cumulative root text captured at latestOrdinal, only while the run is live. */
  partialText?: string;
  /**
   * Each teammate's (agentId) cumulative live text at latestOrdinal, only on a replay that is not a complete tail and
   * only while the run is live: the bases a hydrating viewer's teammate deltas extend (reassembleAgentLivePartial).
   */
  agentPartialTexts?: Record<string, string>;
  receipt: InvocationRunReceipt | null;
}
export function parseRunEventReplayInput(value: unknown): RunEventReplayInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("run-event-replay-input-invalid");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["runId", "chatId", "afterOrdinal", "hydrate"].includes(key))
    || typeof v.runId !== "string" || !v.runId || v.runId.length > 256
    || typeof v.chatId !== "string" || !v.chatId || v.chatId.length > 256
    || !Number.isSafeInteger(v.afterOrdinal) || Number(v.afterOrdinal) < 0
    || (v.hydrate !== undefined && v.hydrate !== true)) throw new TypeError("run-event-replay-input-invalid");
  return { runId: v.runId, chatId: v.chatId, afterOrdinal: Number(v.afterOrdinal), ...(v.hydrate === true ? { hydrate: true as const } : {}) };
}
