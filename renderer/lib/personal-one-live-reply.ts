// The personal agent's live reply: what Main's ordered run events say right now (text so far, activity, a key request).
// The state used to be published to React on every event, so a fast stream rendered the whole workspace once per chunk.
// Streamed text now commits at most once per frame (and every 50 ms), through the same createFrameBatcher One's shell uses;
// every other event flushes the queued text first and commits at once, so nothing ever overtakes the streamed text.
// No React here: renderer/lib/use-personal-one-reply.ts only wires it to the subscription and to setState.
import type { SupervisorActivityItem } from "../../shared/one-supervisor";
import type { McpInvocationEvent, McpRunKeyRequest } from "../../shared/types";
import type { RunEventReplay } from "../../shared/run-event-delivery";
import type { FrameBatcher } from "./frame-coalescer";

export interface LiveReplyState {
  runId: string;
  text: string;
  activity: SupervisorActivityItem[];
  keyRequest: McpRunKeyRequest | null;
}

/** Most live text kept: the saved answer is the full one. */
export const LIVE_REPLY_TEXT_LIMIT = 24_000;

export interface LiveReplyFeedOptions {
  runId: string;
  /** Re-read the saved conversation (a saved answer or a terminal event). */
  refresh: () => Promise<void>;
  emit: (state: LiveReplyState) => void;
  batcher: FrameBatcher;
}

export interface LiveReplyFeed {
  consume(event: McpInvocationEvent): void;
  /** Canonical recovery of the text so far (a replay that cannot be applied event by event). */
  recover(value: Pick<RunEventReplay, "partialText">): void;
}

export function createLiveReplyFeed(options: LiveReplyFeedOptions): LiveReplyFeed {
  const { runId, refresh, emit, batcher } = options;
  let text = "", reasoningKey = "reasoning";
  let keyRequest: McpRunKeyRequest | null = null;
  const activity = new Map<string, SupervisorActivityItem>();
  let queued = false;
  const publish = () => {
    queued = false;
    emit({ runId, text, activity: [...activity.values()].slice(-20), keyRequest });
  };
  /** Streamed text: commit with the next frame, once however many chunks arrive before it. */
  const tick = () => {
    if (queued) return;
    queued = true;
    batcher.enqueue(publish);
  };
  /** Anything else: the queued text goes first, then this change, both at once. */
  const now = () => {
    batcher.flush();
    publish();
  };
  return {
    consume(event) {
      if (event.agentId || event.nodeId) return;
      if (event.kind === "partial") {
        if (event.durableMessageId) { batcher.flush(); text = ""; void refresh(); now(); return; }
        if (typeof event.text === "string") { text = event.text.slice(0, LIVE_REPLY_TEXT_LIMIT); tick(); return; }
        if (typeof event.delta === "string") { text = (text + event.delta).slice(0, LIVE_REPLY_TEXT_LIMIT); tick(); return; }
        return;
      }
      if (event.kind === "reasoning") {
        // A thought delta changes nothing this view shows: no commit.
        if (event.reasoning?.phase === "start") reasoningKey = `reasoning:${event.sequence ?? 0}`;
        if (event.reasoning?.phase === "start" || event.reasoning?.phase === "end") {
          activity.set(reasoningKey, { id: reasoningKey, kind: "reasoning", label: "Thinking", state: event.reasoning.phase === "end" ? "completed" : "running",
            summary: event.reasoning.phase === "end" ? event.reasoning.text?.slice(0, 2000) : undefined, durationMs: event.reasoning.durationMs });
          now();
        }
        return;
      }
      if (event.kind === "tool-use" && event.tool) {
        const key = `tool:${event.tool.id ?? event.sequence}`;
        activity.set(key, { id: key, kind: "tool", label: event.tool.name.slice(0, 240), state: event.tool.isError ? "failed" : event.tool.result !== undefined ? "completed" : "running" });
        now();
        return;
      }
      if (event.kind === "mcp-key-request" && event.keyRequest?.runId === runId
        && event.keyRequest.requestId === runId && event.keyRequest.expiresAt > Date.now()) {
        keyRequest = event.keyRequest;
        now();
        return;
      }
      if (event.kind === "final" || event.kind === "error") {
        batcher.flush();
        text = ""; keyRequest = null; void refresh();
        now();
        return;
      }
      // Any other event kind used to commit the unchanged state; nothing changed, so nothing is committed.
    },
    recover(value) {
      batcher.flush();
      text = value.partialText?.slice(0, LIVE_REPLY_TEXT_LIMIT) ?? "";
      publish();
    },
  };
}
