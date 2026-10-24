/*
 * When a graph node may be cut: only once it has stopped making progress, never while it is working.
 *
 * Dev replay r05 of the daily TCIagent graph (2026-10-17, 3b559daa): the step's One worked for 60 minutes (shell,
 * patches, image checks, teammate steering; a provider tool frame every few seconds, the last one 11 s before the cut)
 * and the run ended at exactly node start + 60 min. The invocation timer aborted the node's signal, the inner node saw
 * an aborted turn without its own timeout flag, and the step was recorded MUTATION_UNVERIFIED (ambiguous outside
 * effect) with the owner asked to check by hand. Owner order 2026-10-16: no wall-clock cap on healthy work; a loop is
 * stopped by its own signal (runtime/degenerate-output.ts), a silent runner by its silence.
 *
 * The node's declared deadline (run-graph nodeTimeoutMs) still applies to a node that has gone quiet: no model text and
 * no provider tool frame for NODE_STALL_MS, or for NODE_ACTIVE_TOOL_STALL_MS while one of its tool calls is open (a
 * render or an upload can run for minutes without a frame). The two windows mirror the run watchdog
 * (automation-scheduler.ts STALL_INACTIVITY_MS / ACTIVE_TOOL_STALL_MS defaults), which records stalls but never aborts.
 * Host status lines (thinking/status/notice frames, Agentlas Plugins preflight) are not progress: a runner heartbeat
 * ("session alive, waiting for output") must not keep a dead turn alive.
 *
 * Every place that decides whether a node is still allowed to run (the invocation timer, the node timer, the worker
 * owner check) reads liveUntil() so they can never disagree again.
 */

/** No model text and no provider tool frame for this long: the node is quiet. */
export const NODE_STALL_MS = 8 * 60_000;
/** Quiet while one of its tool calls is open (long renders, uploads). */
export const NODE_ACTIVE_TOOL_STALL_MS = 20 * 60_000;

/** The subset of a runner event this needs (mcp/client.ts EventSink events). */
export interface NodeLivenessEvent {
  kind: string;
  text?: unknown;
  delta?: unknown;
  done?: unknown;
  tool?: { name?: unknown; id?: unknown; result?: unknown } | null;
}

export interface NodeLiveness {
  /** Feed every event of the node's turns; only provider progress counts. */
  note(event: NodeLivenessEvent, isHostTool?: (name: string) => boolean): void;
  /** Until when the node may not be cut for silence. */
  liveUntil(): number;
  /** Counts for receipts and gates. */
  snapshot(): { lastProgressAt: number; openTools: number };
}

export function createNodeLiveness(startedAt: number, now: () => number = Date.now): NodeLiveness {
  let lastProgressAt = startedAt;
  const openTools = new Set<string>();
  return {
    note(event, isHostTool) {
      if (!event || typeof event.kind !== "string") return;
      if (event.kind === "partial") {
        const text = typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
        if (text.length > 0) lastProgressAt = now();
        return;
      }
      if (event.kind !== "tool-use") return;
      const name = typeof event.tool?.name === "string" ? event.tool.name : "";
      if (!name || isHostTool?.(name)) return;
      lastProgressAt = now();
      const id = typeof event.tool?.id === "string" ? event.tool.id : "";
      if (!id) return;
      if (event.tool?.result !== undefined || event.done === true) openTools.delete(id);
      else openTools.add(id);
    },
    liveUntil() {
      return lastProgressAt + (openTools.size > 0 ? NODE_ACTIVE_TOOL_STALL_MS : NODE_STALL_MS);
    },
    snapshot() {
      return { lastProgressAt, openTools: openTools.size };
    },
  };
}
