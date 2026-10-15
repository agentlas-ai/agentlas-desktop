import type { DesktopMemoryTarget } from "./desktop-memory-inspector";

/** A setting for this memory and this registered receiver, never a public label. */
export interface AgentAppMemoryReceiver { kind: "agent-app"; appId: string; projectId: string; actorId: string }
export interface AgentAppMemoryChoice extends AgentAppMemoryReceiver { label: string; revision: string }
export interface AgentAppMemorySharing {
  current: AgentAppMemoryReceiver | null;
  choices: AgentAppMemoryChoice[];
  canRevoke: boolean;
}
export type AgentAppMemorySharingInput = DesktopMemoryTarget & { receiver: AgentAppMemoryChoice | null };
