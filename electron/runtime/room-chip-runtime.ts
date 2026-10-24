import type { RuntimeSelection } from "../../shared/types";

/**
 * Owner rule: the room's model chip governs the room's orchestrator.
 *
 * The chip is the chat's durable pin (`chats.runtime_selection_json`). The owner's own turn carries it because the
 * composer sends it. Turns the host starts in the same chat did not: an automatic Goal resume (sweep, startup, the
 * Resume button), the operational recovery turn after a refused start, a teammate's report, a Mobile message sent
 * without a selection. Those resolved the global orchestrator pool instead. Production 1.3.47, One room "Yotube"
 * pinned to codex gpt-6.1-sol xhigh: every orchestrator call since the pin was set ran at the pool's "high"
 * (owner submissions at xhigh were refused at start, and the host turns that did the work carried no pin).
 *
 * Such a turn now runs the chat's own pin, with the same authority and the same visible fallback chain as the owner's
 * turn. A request that already names a runtime keeps it (checkpoint and wait continuations restore the producer's exact
 * binding; effect observations carry the Goal's runtime). Hosts that own an exact runtime contract keep theirs:
 * automations and graph steps (their own pin), Science and Alive (an explicit selection is required), Site Agent Apps.
 * Host selection only: nothing here reaches a model.
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
