




















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
