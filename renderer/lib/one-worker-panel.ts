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
    if (item.agentId !== selection.agentId) continue;
    entries.set(`activity:${item.id}`, { kind: "activity", id: `activity:${item.id}`, at: item.observedAt, item });
  }
  for (const edge of run.state.handoffs) {
    for (const message of edge.messages) {
      if (message.fromAgentId !== selection.agentId && message.toAgentId !== selection.agentId) continue;
      entries.set(`message:${message.id}`, { kind: "message", id: `message:${message.id}`, at: message.observedAt, message });
    }
  }
  return [...entries.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).slice(-ONE_WORKER_FEED_LIMIT);
}
