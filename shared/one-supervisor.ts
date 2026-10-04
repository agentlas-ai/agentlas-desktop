import type { RuntimeSelection, ChatHistoryEntry } from "./types";
import type { OneBubbleColor } from "./one-profile";

/** Personal identity is One's durable oneId; none of these IDs is a provider session. */
export const ONE_SUPERVISOR_SCHEMA = "agentlas.one-supervisor.v1" as const;
export type SupervisorSurface = "one" | "work" | "science";
export type SupervisorRequestState = "stored" | "dispatching" | "accepted" | "completed" | "cancelled" | "failed" | "held";
export interface SupervisorCommandReceipt {
  commandId: string;
  kind: "reply" | "work" | "science" | "steer" | "cancel" | "stop-reply" | "appearance" | "follow-up" | "checkin";
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
/**
 * One speaks first only when it matters (dots parity, owner 2026-10-04). A host-started One turn — a finished
 * delegation's review or a check-in the owner asked for — may end with exactly this reply: then nothing is saved to
 * the conversation and no alert fires.
 */
export const ONE_QUIET_REPLY = "[quiet]" as const;
export function isOneQuietReply(text: string): boolean {
  return /^\s*\[quiet\]\s*\.?\s*$/i.test(text);
}

/** A check-in the owner asked One to run on its own: every N minutes, or daily at a local HH:MM. */
export type OneCheckinCadence = { kind: "interval"; minutes: number } | { kind: "daily"; time: string };
export interface OneCheckin {
  id: string;
  instruction: string;
  cadence: OneCheckinCadence;
  /** "important": message the owner only when something matters. "always": a short report every time. */
  notify: "important" | "always";
  nextAt: string;
  lastFiredAt: string | null;
  fires: number;
}
export const ONE_CHECKIN_LIMITS = { active: 20, minMinutes: 5, maxMinutes: 7 * 24 * 60 } as const;
/** The next time a check-in runs strictly after `from` (local time for daily). Throws on an invalid cadence. */
export function nextCheckinAt(cadence: OneCheckinCadence, from: number): number {
  if (cadence.kind === "interval") {
    if (!Number.isInteger(cadence.minutes) || cadence.minutes < ONE_CHECKIN_LIMITS.minMinutes || cadence.minutes > ONE_CHECKIN_LIMITS.maxMinutes) {
      throw new TypeError("supervisor_checkin_interval_invalid");
    }
    return from + cadence.minutes * 60_000;
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cadence.time);
  if (!match) throw new TypeError("supervisor_checkin_time_invalid");
  const next = new Date(from);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}
export interface SupervisorCheckinInput {
  commandId: string; action: "create" | "cancel" | "list";
  instruction?: string; everyMinutes?: number; dailyAt?: string; notify?: "important" | "always"; checkinId?: string; oneId?: string;
}

/** A new turn in a delegated Work session after its run settled (live runs are steered instead). */
export interface SupervisorFollowUpInput { commandId: string; taskId: string; text: string; oneId?: string }
/** How a host-started supervisor turn is labelled in its chat: One's own brief in a worker session, or One's review line. */
export type SupervisorHostNoticePurpose = "one-dispatch-brief" | "one-delegation-review" | "one-checkin";
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
