import type { InvocationRunReceipt, McpInvocationEvent } from "./types";

/** Delivery identity is independent of provider/lifecycle evidence sequencing. */
export interface RunEventDelivery {
  schemaVersion: "agentlas.run-event-delivery.v1";
  runId: string;
  chatId: string;
  ordinal: number;
  sourceSequence?: number;
}
export interface RunEventReplayInput { runId: string; chatId: string; afterOrdinal: number }
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
  receipt: InvocationRunReceipt | null;
}
export function parseRunEventReplayInput(value: unknown): RunEventReplayInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("run-event-replay-input-invalid");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["runId", "chatId", "afterOrdinal"].includes(key))
    || typeof v.runId !== "string" || !v.runId || v.runId.length > 256
    || typeof v.chatId !== "string" || !v.chatId || v.chatId.length > 256
    || !Number.isSafeInteger(v.afterOrdinal) || Number(v.afterOrdinal) < 0) throw new TypeError("run-event-replay-input-invalid");
  return { runId: v.runId, chatId: v.chatId, afterOrdinal: Number(v.afterOrdinal) };
}
