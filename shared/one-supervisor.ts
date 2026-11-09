import type { RuntimeSelection, ChatHistoryEntry, ImageAttachment } from "./types";
import { endsWithQuietMarker, stripAgentControlMarkers } from "./agent-control-markers";
import type { OneBubbleColor } from "./one-profile";
import type { SupervisorControlProgress, SupervisorJournalInput, SupervisorJournalPage, SupervisorRuntimeOwner, SupervisorStopInput } from "./one-supervisor-runtime";

/** Personal identity is One's durable oneId; none of these IDs is a provider session. */
export const ONE_SUPERVISOR_SCHEMA = "agentlas.one-supervisor.v1" as const;
export type SupervisorSurface = "one" | "work" | "science";
/** Automatic follow-ups One may send to one delegated task since the owner's latest direction (owner-asked ones are not
 * counted). The host enforces it; the overlay and the tool description render this same number (22 O9). */
export const ONE_SUPERVISOR_FOLLOW_UP_LIMIT = 2;
export type SupervisorRequestState = "stored" | "dispatching" | "accepted" | "completed" | "cancelled" | "failed" | "held";
export interface SupervisorCommandReceipt {
  commandId: string;
  kind: "reply" | "work" | "science" | "steer" | "cancel" | "stop-reply" | "appearance" | "follow-up" | "checkin" | "chat-send";
  state: SupervisorRequestState;
  taskId: string | null;
  runId: string | null;
  /** Received/delivered is never a claim that a model applied an instruction. */
  acknowledgement: "stored" | "delivered" | "settled" | "unknown";
  reason: string | null;
  control?: SupervisorControlProgress;
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
  owner: "desktop-main" | "work-daemon" | "science-daemon";
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
  /** Cursor for command receipt transitions, separate from per-run token ordinals. */
  journalCursor?: number;
  runtimeOwner?: SupervisorRuntimeOwner | null;
  executor: "desktop-local" | "agentlas-cloud";
  workOwner: "desktop-main" | "work-daemon";
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
  checkins?: OneCheckin[];
}
export interface SupervisorSendInput { commandId: string; text: string; runtimeSelection?: RuntimeSelection; oneId?:string; permissions?:"read"|"write"|"full"; images?:ImageAttachment[]; fileGroupId?:string }
export interface SupervisorWorkInput extends SupervisorSendInput { projectId?: string; permissions?: "read" | "write" | "full"; budgetId?:string;
  /** What must be true when the work is finished, one checkable item each: handed to Work with the brief and to One's review. */
  doneWhen?: string[] }
export const SUPERVISOR_DONE_WHEN_LIMITS = { items: 8, chars: 240 } as const;
/** Lenient by design: a hand-off never fails over its checklist. Non-strings and blanks drop, items are cut, the first 8 stay. */
export function supervisorDoneWhen(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string").map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean).map((item) => item.slice(0, SUPERVISOR_DONE_WHEN_LIMITS.chars)).slice(0, SUPERVISOR_DONE_WHEN_LIMITS.items);
  return items.length ? items : undefined;
}
/** The text a Work's worker receives: the brief, then the finished-when list. Without a list the brief, byte for byte.
 * The dispatch builds the request with it and the binding check compares against it: one function, so they cannot differ. */
export function withDoneWhen(brief: string, doneWhen: unknown): string {
  const items = supervisorDoneWhen(doneWhen);
  return items ? `${brief}\n\nFinished when:\n${items.map((item) => `- ${item}`).join("\n")}` : brief;
}
export interface SupervisorScienceInput { commandId: string; text: string; projectId: string; oneId?:string }
/**
 * One speaks first only when it matters (dots parity, owner 2026-10-04). A host-started One turn — a finished
 * delegation's review or a check-in the owner asked for — may end with exactly this reply: then nothing is saved to
 * the conversation and no alert fires.
 */
export const ONE_QUIET_REPLY = "[quiet]" as const;
/** A reply that ends with the marker is quiet even after a progress preamble (shared/agent-control-markers.ts). */
/**
 * One chose to say nothing: the reply ends with the quiet marker and what comes before it is at most a short progress line
 * (a model's "checking the run…" preamble). A real report that happens to end with the marker is not dropped: it is shown
 * without the marker, because losing a result the owner needed is worse than one extra line.
 */
export const ONE_QUIET_PREAMBLE_MAX_CHARS = 240;
export function isOneQuietReply(text: string): boolean {
  if (!endsWithQuietMarker(text)) return false;
  const before = stripAgentControlMarkers(text).trim();
  return before.length <= ONE_QUIET_PREAMBLE_MAX_CHARS && before.split(/\n/u).filter((line) => line.trim()).length <= 1;
}

/**
 * The one test every site uses for "this host-started review or check-in ended quietly" (mcp/client.ts decides whether to save,
 * invocation/service.ts decides whether the saved row must exist). Until the check was an exact match of the whole reply, so a
 * model that wrote a progress line before the marker was saved and alerted every time (108 of 111 check-in reviews in one owner database);
 * one helper keeps the save site and the verification site from disagreeing again.
 */
export function isHostQuietReply(purpose: unknown, text: string): boolean {
  return (purpose === "one-delegation-review" || purpose === "one-checkin") && isOneQuietReply(text);
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
/**
 * What bounds the model-made check-ins' cost and consent. minMinutes above stays the validity floor (an older row below the new
 * minimum must still parse, or its sweep would cancel it); the policy floor is applied where a cadence is created and where one fires.
 * A request below the floor is raised to it and shown that way on the owner's card, never refused.
 */
export const ONE_CHECKIN_POLICY = {
  minIntervalMinutes: 60,
  perCheckinPerDay: 24,
  perOnePerDay: 48,
  /** A missed slot fires once only inside this allowance (half the interval, at most 2 h; daily: 2 h), else it moves to the next slot. */
  staleCapMs: 2 * 60 * 60_000,
  /** An unanswered owner card expires with its proposal. */
  proposalTtlMs: 24 * 60 * 60_000,
  maxPendingProposals: 5,
  /** Check-ins that come due together are queued a few per sweep, not all at once. */
  maxFiresPerSweep: 2,
} as const;
/** The cadence as it will run: an interval below the policy floor is raised to it. Invalid cadences pass through for nextCheckinAt to refuse. */
export function clampCheckinCadence(cadence: OneCheckinCadence): { cadence: OneCheckinCadence; raisedFrom: number | null } {
  if (cadence.kind !== "interval" || !Number.isFinite(cadence.minutes) || !Number.isInteger(cadence.minutes) || cadence.minutes > ONE_CHECKIN_LIMITS.maxMinutes
    || cadence.minutes >= ONE_CHECKIN_POLICY.minIntervalMinutes) return { cadence, raisedFrom: null };
  return { cadence: { kind: "interval", minutes: ONE_CHECKIN_POLICY.minIntervalMinutes }, raisedFrom: Math.max(1, cadence.minutes) };
}
/** The owner's own UI and the host are not held to the model's floor, only to the validity floor: a faster request is raised to it, never refused. */
export function raiseToValidityFloor(cadence: OneCheckinCadence): { cadence: OneCheckinCadence; raisedFrom: number | null } {
  if (cadence.kind !== "interval" || !Number.isFinite(cadence.minutes) || cadence.minutes >= ONE_CHECKIN_LIMITS.minMinutes) return { cadence, raisedFrom: null };
  return { cadence: { kind: "interval", minutes: ONE_CHECKIN_LIMITS.minMinutes }, raisedFrom: Math.max(0, cadence.minutes) };
}
/** How late a due check-in may still fire (a slot missed while the app was closed or asleep is skipped beyond this). */
export function checkinStaleAllowanceMs(cadence: OneCheckinCadence): number {
  return cadence.kind === "daily" ? ONE_CHECKIN_POLICY.staleCapMs
    : Math.min(ONE_CHECKIN_POLICY.staleCapMs, Math.max(1, Math.floor(Math.max(cadence.minutes, ONE_CHECKIN_POLICY.minIntervalMinutes) * 60_000 / 2)));
}
/** The next time a check-in runs strictly after `from` (local time for daily). Throws on an invalid cadence. */
export function nextCheckinAt(cadence: OneCheckinCadence, from: number): number {
  if (cadence.kind === "interval") {
    if (!Number.isInteger(cadence.minutes) || cadence.minutes < ONE_CHECKIN_LIMITS.minMinutes || cadence.minutes > ONE_CHECKIN_LIMITS.maxMinutes) {
      throw supervisorError('supervisor_checkin_interval_invalid', true);
    }
    return from + cadence.minutes * 60_000;
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cadence.time);
  if (!match) throw supervisorError('supervisor_checkin_time_invalid', true);
  const next = new Date(from);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}
export interface SupervisorCheckinInput {
  commandId: string; action: "create" | "cancel" | "list";
  instruction?: string; everyMinutes?: number; dailyAt?: string; notify?: "important" | "always"; checkinId?: string; oneId?: string;
  /** Set only by the model tool path (team-control-server): the reply run that asked. A create from it is a proposal the owner must turn on. */
  modelReplyRunId?: string;
}

/** A new turn in a delegated Work session after its run settled (live runs are steered instead). */
export interface SupervisorFollowUpInput { commandId: string; taskId: string; text: string; oneId?: string }
/** How a host-started supervisor turn is labelled in its chat: One's own brief in a worker session, or One's review line. */
export type SupervisorHostNoticePurpose = "one-dispatch-brief" | "one-delegation-review" | "one-checkin";
/**
 * A room the personal agent oversees (its Work hand-offs, rooms it messaged, its teammate dispatches; Main decides,
 * electron/one/supervised-approvals.ts). The personal conversation draws that room's waiting approval cards (owner
 * 2026-10-27); each card still answers the original room.
 */
export interface SupervisedRoom { chatId: string; title: string | null }
export interface SupervisedRoomsInput { conversationChatId: string; chatIds: string[] }
export interface PersonalAgentRoomReleaseInput { chatId: string }
export interface PersonalAgentRoomRelease { chatId: string; released: true; releasedAt: string; alreadyReleased: boolean }
export interface SupervisorControlInput { commandId: string; taskId: string; expectedVersion: string; action: "steer" | "cancel"; text?: string; oneId?:string; runId?: string }
export interface OneSupervisorAPI {
  budgets(input:import("./one-budget").OneBudgetListInput):Promise<import("./one-budget").OneBudgetSnapshot[]>;
  budgetConfigure(input:import("./one-budget").OneBudgetConfigureInput):Promise<import("./one-budget").OneBudgetConfigureResult>;
  snapshot(): Promise<OneSupervisorSnapshot>;
  send(input: SupervisorSendInput): Promise<SupervisorCommandReceipt>;
  startWork(input: SupervisorWorkInput): Promise<SupervisorCommandReceipt>;
  startScience(input: SupervisorScienceInput): Promise<SupervisorCommandReceipt>;
  control(input: SupervisorControlInput): Promise<SupervisorCommandReceipt>;
  stopReply(input: { commandId: string; runId: string; oneId?:string }): Promise<SupervisorCommandReceipt>;
  appearance(input:{commandId:string;oneId:string;expectedVersion:number;displayName:string;bubbleColor:OneBubbleColor}):Promise<SupervisorCommandReceipt>;
  journal(input: SupervisorJournalInput): Promise<SupervisorJournalPage>;
  receipt(input: {oneId:string;commandId:string}): Promise<SupervisorCommandReceipt | null>;
  stopTask(input: SupervisorStopInput): Promise<SupervisorCommandReceipt>;
  checkin(input: SupervisorCheckinInput): Promise<{receipt?:SupervisorCommandReceipt;checkin?:OneCheckin;checkins?:OneCheckin[]}>;
  /** Of the given rooms, the ones the personal agent oversees, with their titles. Read-only. */
  supervisedRooms(input: SupervisedRoomsInput): Promise<SupervisedRoom[]>;
  /** "내가 직접 이어가기": a room the personal agent runs becomes an ordinary Work room. Owner-only. */
  releaseRoom(input: PersonalAgentRoomReleaseInput): Promise<PersonalAgentRoomRelease>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
export function supervisorIdentifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw supervisorError('supervisor_identifier_invalid', true);
  return value;
}
export function supervisorText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_000 || /\u0000/u.test(value)) throw supervisorError('supervisor_text_invalid', true);
  return value.trim();
}
export function supervisorObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw supervisorError('supervisor_input_invalid', true);
  return value as Record<string, unknown>;
}

/** Preserve existing machine-readable domain refusals over authenticated RPC. */
export function supervisorError(code:string,typeError=false):Error & {code:string} {
  return Object.assign(typeError ? new TypeError(code) : new Error(code),{code});
}
