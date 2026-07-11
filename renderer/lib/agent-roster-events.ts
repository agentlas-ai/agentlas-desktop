import type { InstalledAgent } from "@/lib/types";

export const AGENT_ROSTER_CHANGED_EVENT = "agentlas:agent-roster-changed";
const AGENT_ROSTER_REPLAY_KEY = "agentlas:agent-roster-last-change";
const AGENT_ROSTER_REPLAY_TTL_MS = 30_000;

export type AgentRosterChange = {
  action: "upserted";
  agent: InstalledAgent;
  source: "build" | "local-import" | "cloud-restore";
};

type AgentRosterAnnouncement = {
  id: string;
  announcedAt: number;
  change: AgentRosterChange;
};

function readReplay(): AgentRosterAnnouncement | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(AGENT_ROSTER_REPLAY_KEY) ?? "null") as AgentRosterAnnouncement | null;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.announcedAt !== "number" ||
      Date.now() - parsed.announcedAt > AGENT_ROSTER_REPLAY_TTL_MS ||
      parsed.change?.action !== "upserted" ||
      !parsed.change.agent
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * A local import is durable before this event is emitted. Consumers may apply
 * the included agent optimistically, then reconcile firms and the full roster
 * from SQLite. Keeping this renderer-local avoids polling and makes a Build
 * finishing in the background visible in every mounted product surface.
 */
export function announceAgentRosterChange(change: AgentRosterChange): void {
  if (typeof window === "undefined") return;
  const announcement: AgentRosterAnnouncement = {
    id: typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    announcedAt: Date.now(),
    change,
  };
  try {
    // Replay only the short roster projection. The canonical prompt, MCP list,
    // and environment requirements remain in SQLite and are reloaded by every
    // destination; they do not belong in browser storage.
    const replayAnnouncement: AgentRosterAnnouncement = {
      ...announcement,
      change: {
        ...change,
        agent: {
          ...change.agent,
          systemPrompt: "",
          mcpServers: [],
          envRequirements: [],
        },
      },
    };
    window.sessionStorage.setItem(AGENT_ROSTER_REPLAY_KEY, JSON.stringify(replayAnnouncement));
  } catch {
    // The live event still updates already-mounted consumers.
  }
  window.dispatchEvent(new CustomEvent<AgentRosterAnnouncement>(AGENT_ROSTER_CHANGED_EVENT, { detail: announcement }));
}

export function onAgentRosterChange(handler: (change: AgentRosterChange) => void): () => void {
  if (typeof window === "undefined") return () => {};
  let deliveredId = "";
  const deliver = (announcement: AgentRosterAnnouncement | null) => {
    if (!announcement || announcement.id === deliveredId) return;
    deliveredId = announcement.id;
    handler(announcement.change);
  };
  const listener = (event: Event) => {
    deliver((event as CustomEvent<AgentRosterAnnouncement>).detail);
  };
  window.addEventListener(AGENT_ROSTER_CHANGED_EVENT, listener);
  // Build registration often finishes before the user follows the completion
  // CTA. Replay the recent durable success so the destination opens the right
  // single/team projection instead of hiding the asset behind its default tab.
  queueMicrotask(() => deliver(readReplay()));
  return () => window.removeEventListener(AGENT_ROSTER_CHANGED_EVENT, listener);
}
