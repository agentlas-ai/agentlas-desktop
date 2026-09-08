import type { OneActivityHandoffMessage, OneActivityItem, OneActivityState } from "./one-activity";

/** Identity comes from the enclosing host-owned turn, never the worker's name. */
export interface OneWorkerPanelSelection {
  chatId: string;
  runId: string;
  agentId: string;
  name?: string;
}

export interface OneWorkerPanelRun {
  chatId: string;
  runId: string;
  state: OneActivityState;
}

export const ONE_WORKER_FEED_LIMIT = 120;
export type OneWorkerFeedEntry =
  | { kind: "activity"; id: string; at: string; item: OneActivityItem }
  | { kind: "message"; id: string; at: string; message: OneActivityHandoffMessage };

export function oneWorkerPanelFeed(selection: OneWorkerPanelSelection, run: OneWorkerPanelRun | null): OneWorkerFeedEntry[] {
  if (!run || run.chatId !== selection.chatId || run.runId !== selection.runId || !selection.agentId) return [];
  const entries = new Map<string, OneWorkerFeedEntry>();
  for (const item of run.state.items) {
    // Public handoff reports are below. Provider reasoning/thinking spans
    // are not a worker report and must not become a new raw transcript here.
    if (item.agentId !== selection.agentId || item.kind === "reasoning") continue;
    // The reducer merges lifecycle updates into the original start row. Put
    // a proven worker terminal capsule at its actual update time, not before
    // the tools that ran between start and completion.
    const at = item.kind === "agent" && item.agentTerminalObserved
      ? item.completedAt ?? item.updatedAt ?? item.observedAt : item.observedAt;
    entries.set(`activity:${item.id}`, { kind: "activity", id: `activity:${item.id}`, at, item });
  }
  for (const edge of run.state.handoffs) {
    for (const message of edge.messages) {
      if (message.fromAgentId !== selection.agentId && message.toAgentId !== selection.agentId) continue;
      entries.set(`message:${message.id}`, { kind: "message", id: `message:${message.id}`, at: message.observedAt, message });
    }
  }
  return [...entries.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).slice(-ONE_WORKER_FEED_LIMIT);
}
