import type { RuntimeSelection } from "../../shared/types";

/**














 */
const HOST_OWNED_RUNTIME_SOURCES: ReadonlySet<string> = new Set(["automation", "science", "alive", "site-studio"]);

export interface RoomChipRuntimeInput {
  /** The runtime the request itself names (owner composer, checkpoint/wait continuation, effect observation). */
  explicit: RuntimeSelection | null | undefined;
  /** The chat's durable pin, as the chip shows it. */
  chatPin: RuntimeSelection | null | undefined;
  /** InvocationExecutionContext.source of this run, if any. */
  executionSource?: string | null;
  /** A graph step carries its own runtime custody. */
  graphWorker?: boolean;
  automationId?: string | null;
  agentAppMode?: boolean;
}

/** The chip's selection this turn must run, or null when the request keeps its current runtime decision. */
export function roomChipRuntimeSelection(input: RoomChipRuntimeInput): RuntimeSelection | null {
  if (input.explicit || !input.chatPin) return null;
  if (input.agentAppMode || input.automationId || input.graphWorker) return null;
  if (input.executionSource && HOST_OWNED_RUNTIME_SOURCES.has(input.executionSource)) return null;
  // The chat store already normalized the pin (normalizeChatRuntimeSelection): orchestrator role, never inherited.
  return { ...input.chatPin, role: "orchestrator", inherit: false };
}
