import type { RuntimeSelection, ChatHistoryEntry } from "./types";
import type { OneBubbleColor } from "./one-profile";

/** Personal identity is One's durable oneId; none of these IDs is a provider session. */
export const ONE_SUPERVISOR_SCHEMA = "agentlas.one-supervisor.v1" as const;
export type SupervisorSurface = "one" | "work" | "science";
export type SupervisorRequestState = "stored" | "dispatching" | "accepted" | "completed" | "cancelled" | "failed" | "held";
export interface SupervisorCommandReceipt {
  commandId: string;
  kind: "reply" | "work" | "science" | "steer" | "cancel" | "stop-reply" | "appearance" | "follow-up";
  state: SupervisorRequestState;
  taskId: string | null;
  runId: string | null;
  /** Received/delivered is never a claim that a model applied an instruction. */
  acknowledgement: "stored" | "delivered" | "settled" | "unknown";
  reason: string | null;
}
export interface SupervisorTask {
  taskId: string;
  surface: SupervisorSurface;
  title: string;
  chatId: string | null;
  projectId: string | null;
  goalId?: string | null;
  runId: string | null;
  state: string;
  controlVersion: string;
  observedAt: string;
  owner: "desktop-main" | "science-daemon";
  controls: Array<"steer" | "cancel">;
  result: string | null;
  resultVerified: boolean;
  sourceCommandId?: string | null;
}
export interface SupervisorNotice {
  id: string;
  taskId: string;
  originChatId: string;
  runId: string;
  state: string;
  createdAt: string;
}
export interface SupervisorActivityItem {
  id: string;
  kind: "reasoning" | "tool" | "status";
  label: string;
  state: "running" | "completed" | "failed" | "interrupted";
  /** Only a runtime-supplied public summary, never generated private reasoning. */
  summary?: string;
  durationMs?: number;
}
export interface SupervisorReplyTurn {
  commandId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  state: SupervisorRequestState;
  createdAt: string;
  activity: SupervisorActivityItem[];
}
/** Host-authored handoff provenance. A nearby message or similar title is never an origin. */
export interface SupervisorDelegation {
  commandId: string;
  surface: "work" | "science";
  title: string;
  taskId: string | null;
  runId: string | null;
  originReplyRunId: string | null;
  state: SupervisorRequestState;
  createdAt: string;
}
export interface SupervisorLegacyHistory {
  schemaVersion:1;
  linked:Array<{chatId:string;title:string;messageCount:number}>;
  heldCount:number;
  scannedCount:number;
  limitReached:boolean;
}
export interface OneSupervisorSnapshot {
  schema: typeof ONE_SUPERVISOR_SCHEMA;
  oneId: string;
  displayName: string;
  avatarIcon?: string;
  bubbleColor?: OneBubbleColor;
  profileVersion?:number;
  conversationChatId: string;
  observedAt: string;
  executor: "desktop-local";
  workOwner: "desktop-main";
  scienceAvailable: boolean;
  scienceError: string | null;
  scienceProjects: Array<{projectId:string;title:string}>;
  tasks: SupervisorTask[];
  messages: ChatHistoryEntry[];
  requests: SupervisorCommandReceipt[];
  notices: SupervisorNotice[];
  /** Exact message/run anchors also keep queued conversations in reply order. */
  turns?: SupervisorReplyTurn[];
  delegations?: SupervisorDelegation[];
  legacyHistory?: SupervisorLegacyHistory;
}
export interface SupervisorSendInput { commandId: string; text: string; runtimeSelection?: RuntimeSelection; oneId?:string; permissions?:"read"|"write"|"full" }
export interface SupervisorWorkInput extends SupervisorSendInput { projectId?: string; permissions?: "read" | "write" | "full" }
export interface SupervisorScienceInput { commandId: string; text: string; projectId: string; oneId?:string }
/** A new turn in a delegated Work session after its run settled (live runs are steered instead). */
export interface SupervisorFollowUpInput { commandId: string; taskId: string; text: string; oneId?: string }
/** How a host-started supervisor turn is labelled in its chat: One's own brief in a worker session, or One's review line. */
export type SupervisorHostNoticePurpose = "one-dispatch-brief" | "one-delegation-review";
export interface SupervisorControlInput { commandId: string; taskId: string; expectedVersion: string; action: "steer" | "cancel"; text?: string; oneId?:string }
export interface OneSupervisorAPI {
  snapshot(): Promise<OneSupervisorSnapshot>;
  send(input: SupervisorSendInput): Promise<SupervisorCommandReceipt>;
  startWork(input: SupervisorWorkInput): Promise<SupervisorCommandReceipt>;
  startScience(input: SupervisorScienceInput): Promise<SupervisorCommandReceipt>;
  control(input: SupervisorControlInput): Promise<SupervisorCommandReceipt>;
  stopReply(input: { commandId: string; runId: string; oneId?:string }): Promise<SupervisorCommandReceipt>;
  appearance(input:{commandId:string;oneId:string;expectedVersion:number;displayName:string;bubbleColor:OneBubbleColor}):Promise<SupervisorCommandReceipt>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
export function supervisorIdentifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError("supervisor_identifier_invalid");
  return value;
}
export function supervisorText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_000 || /\u0000/u.test(value)) throw new TypeError("supervisor_text_invalid");
  return value.trim();
}
export function supervisorObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("supervisor_input_invalid");
  return value as Record<string, unknown>;
}
