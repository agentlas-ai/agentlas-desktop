import { carryRunnerTurnContext, finalizeRunnerTurnContext, renderRunnerTurnContext, runnerTurnContextSource } from "./runner-turn-context-binding";
import type { DeclaredPromptPart } from "./prompt-order";
import type { SessionChannel } from "./session-scope";
import { renderChannelLine, sessionChannelTag } from "./session-channel";
import { createHash } from "node:crypto";
import { UNKNOWN_CONTEXT_WINDOW } from "../../shared/models";
import { getDb } from "../store/db";
import {
  createAgentContextStore, agentContextKey, agentContextProviderKey,
  type AgentContextIdentity, type AgentContextProvider, type AgentContextEvent,
  type AgentContextSnapshot, type AgentContextDelivery, type AgentContextPendingDelivery, type AgentContextAdoption,
} from "../store/agent-context";
import type { Runner, RunnerRequest, RunnerEvents, RunnerResult } from "./runner";
import { markRefusedBeforeDispatch, runnerRefusedBeforeDispatch } from "./runner";
import { innermostTypedCode, STORE_BUSY_CODE } from "../../shared/turn-settlement";
import type { ChatHistoryEntry, RuntimeSelection } from "../../shared/types";
import { redactOperationalSecrets } from "../invocation/event-secret-redaction";
import { redactSecrets } from "../../shared/secret-patterns";
import { composeResumeTurnPrompt, nativeStableTurnContextEpoch } from "./continuity";
import { parseMemoryEvents, stripAllMemoryEventBlocks } from "../memory/events";
import { decideGeneration, runtimeContextWindow, runtimeContextWindowProvenance } from "./session-generation";
import { stripGoalWaitDisplayText } from "../long-run/wait-emitter";
import { stripGoalCompleteMarker, stripStormbreakerContinueMarker } from "../hephaestus/loop-engineering";
import { stripStaffGuidance } from "../one/owner-prompt";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { retainedResponsesPromptPacket, type ResponsesContextPolicy, type RetainedResponsesPromptPacket } from "./responses-context-policy";
import { sessionCheckpointStore, type SessionTaskBoundary, type SessionHostObservation } from "../memory/session-checkpoints";
import { getMemoryStoreInfo } from "../memory/database";
import { findCanonicalTaskForChat } from "../store/tasks";
import { estimateTransportTokens } from "./compact";

declare const contextCapability: unique symbol;
/** A private host object, never an identity or grant accepted from JSON. */
export interface AgentContextCapability { readonly [contextCapability]: true }
export interface AgentContextTurnBinding {
  turnId: string;
  /** Reuses the actual invocation/workspace authority; context grants none. */
  assertCurrent(): void;
}
const capabilities = new WeakMap<object, { identity: AgentContextIdentity; binding: AgentContextTurnBinding }>();
const prepared = new WeakMap<object, { capability: AgentContextCapability; acknowledged: boolean }>();
const store = createAgentContextStore(getDb);
/** Existing host records, never a topic classifier or a renderer supplied id. */
function checkpointTask(req: RunnerRequest): SessionTaskBoundary | null {
  if (!req.chatId) return null;
  try {
    const goal = getDb().prepare(`SELECT goal_id,objective,acceptance_criteria_json,updated_at
      FROM chat_goal_contracts WHERE chat_id=? AND status='active' AND objective IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`).get(req.chatId) as {
      goal_id: string; objective: string; acceptance_criteria_json: string; updated_at: string;
    } | undefined;
    if (goal) {
      const criteria: unknown = JSON.parse(goal.acceptance_criteria_json);
      return { id: `goal:${goal.goal_id}`, revision: Date.parse(goal.updated_at) || 0, goal: goal.objective,
        constraints: Array.isArray(criteria) ? criteria.filter((v): v is string => typeof v === "string") : [] };
    }
    const task = findCanonicalTaskForChat(req.chatId);
    return task ? { id: `task:${task.id}`, revision: task.version, goal: task.title, constraints: [] } : null;
  } catch { return null; }
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
// A host refusal before the native runner was entered: RuntimeTurnDelivery "not-dispatched" (runner.ts), its code kept.
function refuseBeforeDispatch(code: string, cause?: unknown): never {
  const error = Object.assign(new Error(code), { code });
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
  throw markRefusedBeforeDispatch(error);
}
// Process-local high-water marks of allocated turn ordinals: two binds of one [chat, run] that have not appended yet.
const reservedTurnOrdinals = new Map<string, number>();
/**
 * The ordinal for the next agent-context turn of one invocation run on one chat. Every runMcpInvocation counts its own
 * attempts from 1, but one run can invoke the same chat's agent again: graph agent steps share their automation chat and
 * run id (run-graph.ts claimInvocationRunOwner reopenReleased). The second step then bound step1's turn id, its first
 * journal append collided with step1's recorded event (agent_context_event_collision) and the refusal was reported as
 * "antigravity ... may have acted" (production 1.3.49, 2026-10-16 08:02:17Z, run-cdf732ca-…-56680954). The ordinal is
 * the caller's attempt or the next one after every turn this conversation's journal (and this process) already holds.
 */
export function nextAgentContextTurnOrdinal(identity: AgentContextIdentity, chatId: string, runId: string, floor: number): number {
  const prefix = `agent-context-turn:${JSON.stringify([chatId, runId]).slice(0, -1)},`;
  const reservationKey = `${agentContextKey(identity)}\0${prefix}`;
  const ordinal = Math.max(floor, store.maxTurnOrdinal(identity, prefix) + 1, (reservedTurnOrdinals.get(reservationKey) ?? 0) + 1);
  reservedTurnOrdinals.delete(reservationKey);
  reservedTurnOrdinals.set(reservationKey, ordinal);
  // The journal stays authoritative; the marks only cover binds that have not appended yet.
  if (reservedTurnOrdinals.size > 512) reservedTurnOrdinals.delete(reservedTurnOrdinals.keys().next().value!);
  return ordinal;
}
function current(capability: AgentContextCapability) {
  const value = capabilities.get(capability);
  if (!value) fail("agent_context_host_capability_required");
  value.binding.assertCurrent();
  return value;
}
/** The chat and run of a host-built turn id `agent-context-turn:[chatId, runId, ordinal]` (agent-context-admission.ts). */
function turnRunRef(turnId: string): { chatId: string; runId: string } | null {
  if (!turnId.startsWith("agent-context-turn:")) return null;
  try {
    const source: unknown = JSON.parse(turnId.slice("agent-context-turn:".length));
    return Array.isArray(source) && typeof source[0] === "string" && source[0] && typeof source[1] === "string" && source[1]
      ? { chatId: source[0], runId: source[1] } : null;
  } catch { return null; }
}
/** One structured run event of this layer: ids, enums and counts only (no text, no path); evidence, never a control. */
function recordAgentContextRunEvent(turnId: string, agentId: string, kind: string, payload: Record<string, unknown>, sourceEventId?: string): void {
  try {
    const ref = turnRunRef(turnId);
    const { tryRecordRunEvent } = require("../store/run-events") as typeof import("../store/run-events");
    tryRecordRunEvent({ runId: ref?.runId ?? "agent-context-unscoped", ...(ref ? { chatId: ref.chatId } : {}), agentId, kind, payload,
      ...(sourceEventId ? { sourceEventId } : {}) });
  } catch { /* The journal and the binding row stay the record. */ }
}
export const AGENT_CONTEXT_ADOPTION_EVENT_KIND = "agent_context_adoption";
export const AGENT_CONTEXT_GENERATION_EVENT_KIND = "agent_context_generation";
const contextRef = (key: string): string => key.slice(0, 16);
/** The machine-readable cause of an adoption failure, from the error's own code (SQLite or this layer's), never its words. */
export function agentContextAdoptionCause(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code : "";
  if (/^SQLITE_(?:BUSY|LOCKED)/.test(code) || code === "SQLITE_PROTOCOL" || code === STORE_BUSY_CODE
    || (!code && innermostTypedCode(error) === STORE_BUSY_CODE)) return "agent_context_adoption_busy";
  if (/^SQLITE_CONSTRAINT/.test(code)) return "agent_context_adoption_conflict";
  if (/^agent_context_[a-z0-9_]+$/.test(code)) return code;
  return "agent_context_adoption_failed";
}
/** Outcomes already reported by this process (one event per conversation, head and cause, not one per Goal pass). */
const reportedAdoptions = new Set<string>();
/** The cause of this process's last failed adoption per conversation; the adoption that later succeeds names it. */
const failedAdoptions = new Map<string, string>();
function firstReport(mark: string): boolean {
  if (reportedAdoptions.has(mark)) return false;
  reportedAdoptions.add(mark);
  if (reportedAdoptions.size > 4096) reportedAdoptions.delete(reportedAdoptions.values().next().value!);
  return true;
}
/*
 * G09: adoption is a typed outcome, never a silent catch. Production 2026-10-12..18 kept five pairs of heads of one agent in
 * one conversation (Yotube One chat 8f3e09ee: old rev 1,598 beside the live rev 23,981); a failure here was swallowed, so
 * nobody could tell a failed move from a kept older journal. Each outcome other than an unchanged head is one run event:
 *  - adopted: the newest earlier head moved under this identity (native handles, cursors and deliveries with it), naming
 *    the cause of a failed attempt before it when there was one;
 *  - retained: older heads of the same conversation that stay where they are;
 *  - failed: the cause code. A busy store refuses this turn before dispatch: the next turn adopts the same journal, where
 *    starting another head would fork the conversation for good. Any other cause keeps the turn going on this identity's
 *    own head (no dead end), loudly.
 */
function adoptPriorJournal(identity: AgentContextIdentity, turnId: string): void {
  const key = agentContextKey(identity), event = (payload: Record<string, unknown>) => recordAgentContextRunEvent(turnId, identity.agentId,
    AGENT_CONTEXT_ADOPTION_EVENT_KIND, { schemaVersion: "agentlas.agent-context-adoption.v1", contextRef: contextRef(key), ...payload });
  let adoption: AgentContextAdoption;
  try { adoption = store.adoptPriorHeadReport(identity); }
  catch (error) {
    const causeCode = agentContextAdoptionCause(error);
    const sqliteCode = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
      && /^SQLITE_[A-Z_]+$/.test((error as { code: string }).code) ? (error as { code: string }).code : undefined;
    console.warn(`[agent-context] adoption outcome=failed cause=${causeCode}${sqliteCode ? ` sqlite=${sqliteCode}` : ""} context=${contextRef(key)}`);
    failedAdoptions.set(key, causeCode);
    if (failedAdoptions.size > 1024) failedAdoptions.delete(failedAdoptions.keys().next().value!);
    if (firstReport(`failed\0${key}\0${causeCode}`)) event({ outcome: "failed", causeCode, ...(sqliteCode ? { sqliteCode } : {}) });
    if (causeCode === "agent_context_adoption_busy") refuseBeforeDispatch(causeCode, error);
    return;
  }
  const recoveredFrom = failedAdoptions.get(key);
  if (adoption.outcome === "adopted") {
    failedAdoptions.delete(key);
    console.info(`[agent-context] adoption outcome=adopted context=${contextRef(key)} from=${contextRef(adoption.fromKey)} retained=${adoption.retainedKeys.length}`);
    for (const retained of adoption.retainedKeys) firstReport(`retained\0${key}\0${retained}`);
    event({ outcome: "adopted", fromRef: contextRef(adoption.fromKey), fromRevision: adoption.fromRevision, fromThroughSeq: adoption.fromThroughSeq,
      retainedRefs: adoption.retainedKeys.map(contextRef), ...(recoveredFrom ? { recoveredFromCause: recoveredFrom } : {}) });
    return;
  }
  if (adoption.outcome !== "current" || !adoption.retainedKeys.length) return;
  if (!adoption.retainedKeys.map(retained => firstReport(`retained\0${key}\0${retained}`)).includes(true)) return;
  event({ outcome: "retained", retainedRefs: adoption.retainedKeys.map(contextRef) });
}
/** Called only from the authenticated host's original invocation preparation.
 * Account/install identity and visibility domain must already be authorized.
 * Do not expose this constructor in renderer IPC, MCP or a control API. */
export function createAgentContextCapability(identity: AgentContextIdentity, binding: AgentContextTurnBinding): AgentContextCapability {
  if (!binding?.turnId?.trim() || typeof binding.assertCurrent !== "function") fail("agent_context_turn_binding_required");
  binding.assertCurrent();
  // Validation does not create a context row or copy legacy chat transcripts. An existing journal of the same agent in the
  // same conversation is moved under this identity's key when only its service-instance part changed (a reboot).
  agentContextKey(identity);
  adoptPriorJournal(identity, binding.turnId);
  const capability = Object.freeze({}) as AgentContextCapability;
  capabilities.set(capability, {identity:{...identity},binding:{...binding}});
  return capability;
}
export function isAgentContextCapability(value: unknown): value is AgentContextCapability {
  return !!value && typeof value === "object" && capabilities.has(value);
}
export function readAgentContext(capability: AgentContextCapability): AgentContextSnapshot {
  return store.read(current(capability).identity);
}
export function readPendingAgentContext(capability:AgentContextCapability):AgentContextPendingDelivery|null {
  return store.readPendingDelivery(current(capability).identity);
}
/** The turn that holds this journal right now (its open delivery), or null. Read-only: a wait for a shared session polls this. */
export function openAgentContextTurnId(capability: AgentContextCapability): string | null {
  return store.openDeliveryTurnId(current(capability).identity);
}
/**
 * One run event when a one-to-one seat conversation was given its seat's journal (session-scope.ts): the context refs of the
 * journal it continues and of the others that stay, never a conversation id. Evidence, not a control.
 */
export function recordAgentContextScopeAdoption(turnId: string, identity: AgentContextIdentity,
  assignment: { outcome: "adopted" | "fresh" | "healed"; scopeKind: string; retainedDomains: readonly string[] }): void {
  const ref = (domain: string): string => contextRef(agentContextKey({ ...identity, visibilityDomain: domain }));
  recordAgentContextRunEvent(turnId, identity.agentId, AGENT_CONTEXT_ADOPTION_EVENT_KIND, {
    schemaVersion: "agentlas.agent-context-adoption.v1", contextRef: contextRef(agentContextKey(identity)),
    outcome: assignment.outcome === "adopted" ? "scope_adopted" : assignment.outcome === "healed" ? "scope_healed" : "scope_fresh", scopeKind: assignment.scopeKind,
    retainedRefs: assignment.retainedDomains.slice(0, 32).map(ref), retainedCount: assignment.retainedDomains.length,
  }, `agent-context-scope:${contextRef(agentContextKey(identity))}:${assignment.outcome}`);
}
/**
 * One run event when the seat's journal could not be resolved for a turn and the turn was refused (session-scope.ts, "unavailable"):
 * the machine cause only (a SQLite code or this layer's own), no conversation id and no text. Evidence for whoever asks why a seat
 * conversation did not start; the owner sees a plain sentence instead.
 */
export function recordAgentContextScopeFailure(turnId: string, agentId: string, failure: { scopeKind: string; causeCode: string }): void {
  recordAgentContextRunEvent(turnId, agentId, AGENT_CONTEXT_ADOPTION_EVENT_KIND, {
    schemaVersion: "agentlas.agent-context-adoption.v1", outcome: "scope_unavailable", scopeKind: failure.scopeKind, causeCode: failure.causeCode,
    refused: true }, `agent-context-scope-unavailable:${createHash("sha256").update(turnId).digest("hex").slice(0, 16)}`);
}
export function agentContextSessionKey(capability: AgentContextCapability): string {
  return agentContextKey(current(capability).identity);
}
/** Internal host bridge only; this projection grants no authority when copied
 * into JSON. The original capability and invocation assertion stay private. */
export function agentContextHostBinding(capability:AgentContextCapability):Readonly<{identity:Readonly<AgentContextIdentity>} & AgentContextTurnBinding> {
  const value=current(capability);
  return Object.freeze({identity:Object.freeze({...value.identity}),...value.binding});
}
/** A fresh host cannot recreate an old provider receipt. It may retain that
 * turn as uncertain after the existing native owner/recovery authority proves
 * the previous execution is terminal or explicitly cancelled. */
export function reconcileInterruptedAgentContext(capability:AgentContextCapability,
  assertPreviousTurnTerminal:(turnId:string)=>void):boolean {
  const value=current(capability),pending=store.readOpenPendingDelivery(value.identity);
  if(!pending || pending.status!=="pending")return false;
  if(pending.turnId===value.binding.turnId)fail("agent_context_turn_replayed");
  assertPreviousTurnTerminal(pending.turnId);current(capability);
  store.markDeliveryUncertain(value.identity,pending);
  return true;
}
/** Explicit host-approved initial import only. Later chat-row projections must
 * not duplicate the journal's already retained per-turn inputs and outputs. */
export function bootstrapAgentContextHistory(capability: AgentContextCapability, history: readonly ChatHistoryEntry[]): boolean {
  const value=current(capability);
  if(store.readHead(value.identity).throughSeq!==0)return false;
  for(const row of history)appendAgentContextEvent(capability,{eventId:`message:${row.durableMessageId??row.id}`,kind:"message",payload:{
    role:row.role,text:row.text,createdAt:row.createdAt,...(row.speakerAgentId?{speakerAgentId:row.speakerAgentId}:{}),
    ...(row.hostNotice?.purpose?{hostAuthored:row.hostNotice.purpose}:{}),
    ...(row.imageDataUrls?{imageDataUrls:row.imageDataUrls}:{}),...channelPayload(capability),
  }});
  return true;
}
/**
 * What a conversation brings into a shared journal it joins late (importSharedChatHistory): the newest rows of its own history,
 * bounded like the host's other replays. The character bound counts everything a row puts into the journal: its text AND the
 * data URLs of its images (a late joiner with eighty rows of one-megabyte pictures used to add eighty megabytes). A row whose
 * pictures do not fit comes in without them; the newest row's text always comes in.
 */
export const SHARED_IMPORT_MAX_ROWS = 80;
export const SHARED_IMPORT_MAX_CHARS = 60_000;
/**
 * A conversation that joins a journal shared with other conversations (runtime/session-scope.ts) after that journal has begun was
 * never bootstrapped into it: bootstrapAgentContextHistory seeds an EMPTY journal only, so the first conversation's history is in
 * and the later ones' is not. Without this a one-to-one conversation the owner reopens (its text is on the seat's screen) would
 * continue a session that has never read it. Its recent messages go in once, with the ids the bootstrap uses, as recorded context
 * the journal's session reads like any other entry it did not produce; a conversation that has taken a turn here, or was imported
 * before, adds nothing. Call it while no other turn holds the journal: appended rows are never part of that turn's own observations.
 * The count and the marker say what this call put in: a row the journal already holds (the first conversation's own bootstrap, a
 * partly finished import) is not counted, and a call that added nothing writes no marker.
 */
export function importSharedChatHistory(capability: AgentContextCapability, chatId: string, history: readonly ChatHistoryEntry[]): number {
  const value = current(capability), marker = `scope-import:${chatId}`;
  if (!history.length || store.readHead(value.identity).throughSeq === 0) return 0;
  // A late chat projection cannot reintroduce pre-quarantine bytes after a
  // forward-only generation; its actual next input is journaled normally.
  const recorded = store.readRange(value.identity);
  if (recorded.entries.some(entry => entry.kind === "checkpoint-reference" && entry.payload.schema === FORWARD_BARRIER_SCHEMA)) return 0;
  if (store.hasEvent(value.identity, marker) || store.chatTookTurn(value.identity, chatId)) return 0;
  const rows: Array<{ row: ChatHistoryEntry; images: readonly string[] | undefined }> = [];
  let chars = 0;
  for (let index = history.length - 1; index >= 0 && rows.length < SHARED_IMPORT_MAX_ROWS; index -= 1) {
    const row = history[index];
    if (typeof row.text !== "string" || !row.text) continue;
    if (rows.length && chars + row.text.length > SHARED_IMPORT_MAX_CHARS) break;
    const imageChars = (row.imageDataUrls ?? []).reduce((sum, url) => sum + (typeof url === "string" ? url.length : 0), 0);
    const withImages = !!row.imageDataUrls?.length && chars + row.text.length + imageChars <= SHARED_IMPORT_MAX_CHARS;
    chars += row.text.length + (withImages ? imageChars : 0);
    rows.unshift({ row, images: withImages ? row.imageDataUrls : undefined });
  }
  let imported = 0;
  for (const { row, images } of rows) {
    const eventId = `message:${row.durableMessageId ?? row.id}`;
    try {
      if (store.hasEvent(value.identity, eventId)) continue;
      appendAgentContextEvent(capability, { eventId, kind: "message", payload: {
        role: row.role, text: row.text, createdAt: row.createdAt, ...(row.speakerAgentId ? { speakerAgentId: row.speakerAgentId } : {}),
        ...(row.hostNotice?.purpose ? { hostAuthored: row.hostNotice.purpose } : {}),
        ...(images ? { imageDataUrls: images } : {}), ...channelPayload(capability) } });
      imported += 1;
    } catch { /* A row the journal refuses is skipped; the rest still go in. */ }
  }
  if (imported) appendAgentContextEvent(capability, { eventId: marker, kind: "system", payload: { text: "", scopeImport: true, rows: imported } });
  return imported;
}
export function appendAgentContextEvent(capability: AgentContextCapability, event: AgentContextEvent, expectedRevision?: number) {
  return store.append(current(capability).identity,sanitizeEvent(event),expectedRevision);
}
function sanitizeEvent(event:AgentContextEvent):AgentContextEvent {
  const redact=event.kind==="tool"?redactOperationalSecrets:redactSecrets;
  function clean(value:unknown,key=""):unknown {
    if(typeof value==="string"){
      if(/^(?:authorization|cookie|cookies|set-cookie|session[_-]?(?:id|token)|password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)$/i.test(key))return "[redacted-secret]";
      if(event.kind==="tool" && (key==="arguments" || key==="result")){
        try{const parsed:unknown=JSON.parse(value);if(parsed && typeof parsed==="object")return JSON.stringify(clean(parsed));}catch{/* Non-JSON tool prose uses the shared operational redactor. */}
      }
      return key==="data" && event.kind==="attachment"?value:redact(value);
    }
    if(Array.isArray(value))return value.map(v=>clean(v));
    if(value && typeof value==="object"){
      if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return value;
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v,k)]));
    }
    return value;
  }
  return {...event,payload:clean(event.payload) as Record<string,unknown>};
}
/** Main-only forward inspection: a new native generation in the existing journal.
 * The opaque authority keeps its domain-specific effect/current-state checks. */
const forwardGenerations = new WeakMap<object, { id: string; assertCurrent(): void; memoryBoundaryKey?: string }>();
export function markAgentContextForwardGeneration(capability: AgentContextCapability, input: { id: string; assertCurrent(): void }): void {
  current(capability);
  if (!input.id?.trim() || typeof input.assertCurrent !== "function") fail("agent_context_forward_authority_required");
  input.assertCurrent();
  forwardGenerations.set(capability, Object.freeze({ ...input }));
}
export function copyAgentContextForwardGeneration(from: AgentContextCapability, to: AgentContextCapability): void {
  const held = forwardGenerations.get(from);
  if (held) markAgentContextForwardGeneration(to, held);
}
/** Provider adapters may accept the shared owner only for this exact active delivery. */
export function isAgentContextForwardGenerationRequest(req: RunnerRequest): boolean {
  const cap = req.agentContext;
  if (!cap || !forwardGenerations.has(cap)) return false;
  const held = forwardGenerations.get(cap)!;
  current(cap); held.assertCurrent();
  const delivery = activeDeliveries.get(cap);
  return !!delivery && req.runtimeSessionId === undefined
    && req.runtimeSessionOwnerId === `agent-context:${delivery.contextKey}:${delivery.bindingKey}`
    && req.sessionFingerprintSeed === `agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}${nativeGenerationSeed(delivery.generation)}`;
}
const FORWARD_BARRIER_SCHEMA = "agentlas.agent-context-forward-barrier.v1";
/** A narrowed source audience must not inherit older checkpoint/history/native
 * state. Keep the journal and install its existing forward barrier once for
 * the authenticated audience key, including after a process restart. */
export function enforceAgentContextMemoryBoundary(capability: AgentContextCapability, input: { key: string | null; assertCurrent(): void }): void {
  const value=current(capability);input.assertCurrent();
  const snapshot=store.readRange(value.identity);
  const latest=[...snapshot.entries].reverse().find(entry=>entry.kind==="checkpoint-reference"&&entry.payload.schema===FORWARD_BARRIER_SCHEMA);
  if(!input.key&&!latest?.payload.memoryBoundaryKey)return;
  const key=input.key??"ordinary-memory.v1";
  const prior=forwardGenerations.get(capability);
  if(latest?.payload.memoryBoundaryKey===key&&!prior)return;
  forwardGenerations.set(capability,Object.freeze({id:prior?.id??`memory-boundary:${key}`,memoryBoundaryKey:key,
    assertCurrent(){prior?.assertCurrent();input.assertCurrent();}}));
}
/** Older bytes remain inspectable evidence; they are never automatic replay. */
function replayableSnapshot<T extends Pick<AgentContextSnapshot, "entries">>(snapshot: T): T {
  let after = -1;
  for (const entry of snapshot.entries) if (entry.kind === "checkpoint-reference" && entry.payload.schema === FORWARD_BARRIER_SCHEMA) after = entry.seq;
  return after < 0 ? snapshot : { ...snapshot, entries: snapshot.entries.filter(entry => entry.seq > after) };
}
export function prepareAgentContextTurn(capability: AgentContextCapability, input: {
  turnId: string; provider: AgentContextProvider; signal?: AbortSignal;
  events: readonly AgentContextEvent[]; expectedRevision?: number;
}): AgentContextDelivery {
  input.signal?.throwIfAborted();
  const value=current(capability);
  if(input.turnId!==value.binding.turnId)fail("agent_context_turn_binding_changed");
  if(input.expectedRevision!==undefined && store.readHead(value.identity).revision!==input.expectedRevision)fail("agent_context_revision_changed");
  const forward = forwardGenerations.get(capability);
  const begin = () => {
    if (forward) {
      forward.assertCurrent();
      // One transaction retires every old adapter, records the replay barrier and
      // opens the real delivery. A busy/replayed turn rolls all three back.
      const bindings = getDb().prepare("SELECT provider_json,generation FROM agent_context_bindings WHERE context_key=?")
        .all(agentContextKey(value.identity)) as Array<{ provider_json: string; generation: number }>;
      for (const binding of bindings) store.invalidateProvider(value.identity, JSON.parse(binding.provider_json) as AgentContextProvider, binding.generation);
      appendAgentContextEvent(capability, { eventId: `forward-barrier:${input.turnId}`, kind: "checkpoint-reference",
        payload: { schema: FORWARD_BARRIER_SCHEMA, authorityId: forward.id, turnId: input.turnId,
          ...(forward.memoryBoundaryKey?{memoryBoundaryKey:forward.memoryBoundaryKey}:{}) } });
    }
    for(const event of input.events){input.signal?.throwIfAborted();appendAgentContextEvent(capability,event);}
    input.signal?.throwIfAborted();current(capability);
    return store.beginDelivery(value.identity,input.provider,{turnId:input.turnId});
  };
  const delivery = forward ? getDb().transaction(begin).immediate() : begin();
  prepared.set(delivery,{capability,acknowledged:false});
  if (forward) recordAgentContextRunEvent(delivery.turnId, value.identity.agentId, AGENT_CONTEXT_GENERATION_EVENT_KIND, {
    schemaVersion: "agentlas.agent-context-generation.v1", runtime: input.provider.kind, reason: "forward_recovery",
    fromGeneration: delivery.generation - 1, toGeneration: delivery.generation, windowSource: "none",
    contextRef: contextRef(delivery.contextKey), bindingRef: contextRef(delivery.bindingKey),
  }, `agent-context-generation:${delivery.contextKey}:${delivery.bindingKey}:${delivery.generation}`);
  return delivery;
}
export function acknowledgeAgentContextTurn(capability: AgentContextCapability, delivery: AgentContextDelivery,
  receipt: {receiptId:string;nativeHandle?:string|null;observedThroughSeq?:number}): boolean {
  const record=prepared.get(delivery);
  if(!record || record.capability!==capability)fail("agent_context_delivery_capability_required");
  const acknowledged=store.acknowledgeDelivery(current(capability).identity,delivery,receipt);
  if(acknowledged)record.acknowledged=true;
  return acknowledged;
}
export function markAgentContextTurnUncertain(capability: AgentContextCapability, delivery: AgentContextDelivery): void {
  const record=prepared.get(delivery);
  if(!record || record.capability!==capability)fail("agent_context_delivery_capability_required");
  // This is data custody, so cancellation still records uncertainty even when
  // an invocation's execution grant has expired. No effect is admitted here.
  const value=capabilities.get(capability);if(!value)fail("agent_context_host_capability_required");
  if(!record.acknowledged)store.markDeliveryUncertain(value.identity,delivery);
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/*
 * Who wrote a turn's input, as a machine marker. A turn the host wrote on its own (a Goal continuation pass, the wake
 * after an update) is recorded as `hostAuthored: <purpose>` on its journal row; replay then carries one short line
 * instead of the prompt (which repeated the previous answer under "Previous assistant output:" and the Goal contract).
 * The purpose comes from the typed ChatHostNotice purpose the dispatcher already passes, never from reading the text.
 * Rows that are the owner's words, or a host brief the receiving agent must still see (one-dispatch-brief,
 * one-delegation-review), are not marked.
 */
const hostAuthoredTurns = new WeakMap<object, string>();
export function markAgentContextHostAuthored(capability: AgentContextCapability, purpose: string | undefined): void {
  if (purpose) hostAuthoredTurns.set(capability, purpose); else hostAuthoredTurns.delete(capability);
}
/** The marker belongs to the turn, not to one capability object: the daemon creates its own capability for the same turn. */
export function copyAgentContextHostAuthored(from: AgentContextCapability, to: AgentContextCapability): void {
  markAgentContextHostAuthored(to, hostAuthoredTurns.get(from));
}
/*
 * Where a shared session is being spoken to on this turn (session-scope.ts names the channel from the conversation's row,
 * session-channel.ts words it). Admission marks only a turn whose journal several conversations share; every other turn has no
 * entry, so its prompt and its journal rows are exactly what they were. The mark does three things, all host-side data: the
 * `agent-context.channel` line of the turn context (withAgentContext), a `channel` tag on every journal event of the turn (what a
 * host-side filter would read; readers that do not know the key skip it), and nothing else: it grants no tool, owner or session.
 */
const channelOfTurn = new WeakMap<object, { tag: string; line: string }>();
export function markAgentContextChannel(capability: AgentContextCapability, channel: SessionChannel | null): void {
  const tag = channel ? sessionChannelTag(channel) : null, line = channel ? renderChannelLine(channel) : null;
  if (tag && line) channelOfTurn.set(capability, { tag, line }); else channelOfTurn.delete(capability);
}
/** The mark belongs to the turn, not to one capability object: the daemon creates its own capability for the same turn. */
export function copyAgentContextChannel(from: AgentContextCapability, to: AgentContextCapability): void {
  const held = channelOfTurn.get(from);
  if (held) channelOfTurn.set(to, held); else channelOfTurn.delete(to);
}
const channelPayload = (capability: object | undefined): { channel?: string } => {
  const held = capability ? channelOfTurn.get(capability) : undefined;
  return held ? { channel: held.tag } : {};
};
/*
 * Same-session continuation of a turn that ended without its terminal receipt (mcp/client.ts invokeCurrentRuntime).
 *
 * Custody semantics, so the guarantees stay as they were:
 *  - The unsettled turn's delivery is already `uncertain` (markAgentContextTurnUncertain, below): its receipt is kept as
 *    evidence, the binding's cursor and native handle are not advanced, and the journal head has no open delivery. The
 *    host's existing invocation authority therefore admits the continuation as the NEXT attempt of the same invocation
 *    with its own turn id (attempt ordinal), exactly like a Goal pass or a recovery pass. Nothing resolves, reuses or
 *    acknowledges the uncertain delivery on its behalf; agent_context_delivery_unresolved / _busy still refuse a second
 *    writer and a replayed turn id.
 *  - The continuation is acknowledged only by its OWN completed receipt. That receipt covers the journal through its own
 *    input frontier, which is the turn the model already holds in its native transcript; nothing is replayed to it.
 *  - If the first turn created the native session, the binding has no handle for it (handles are recorded on
 *    acknowledgement only). The host passes the observed handle as a continuation handle for exactly the next turn id and
 *    only for a native, non-Responses adapter: the same conversation is resumed, never an unrelated caller id.
 *  - A turn that stays unsettled (or cannot be resumed) retires the binding generation (store.invalidateProvider), so the
 *    next owner turn opens a new native session seeded from this journal. One continuation per unsettled turn: the bound is
 *    structural, the host never loops.
 */
export interface AgentContextUnsettledTurn {
  /** Journal-backed adapters resume from the journal; native ones need a handle. */
  readonly resumable: boolean;
  /** The native handle the turn ran on or created, when one is known. */
  readonly handle: string | null;
  /** Bumps the binding generation (decideGeneration symptom "resume_failed"); idempotent and never throws. */
  retire(): void;
}
const BOUNDED_TURN_ENTRIES = 64;
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key); map.set(key, value);
  while (map.size > BOUNDED_TURN_ENTRIES) map.delete(map.keys().next().value as string);
}
const unsettledTurns = new Map<string, AgentContextUnsettledTurn>();
const continuationHandles = new Map<string, string>();
/** What the host may do after the turn `turnId` ended without a terminal receipt; null when it was not a journal turn. */
export function agentContextUnsettledTurn(turnId: string): AgentContextUnsettledTurn | null { return unsettledTurns.get(turnId) ?? null; }
/** Host-only: the next delivery of `turnId` resumes this native handle (a continuation of an unsettled turn). */
export function markAgentContextContinuationHandle(turnId: string, handle: string | undefined): void {
  if (handle) remember(continuationHandles, turnId, handle); else continuationHandles.delete(turnId);
}
function errorSessionId(error: unknown): string | null {
  const value = error && typeof error === "object" ? (error as { sessionId?: unknown }).sessionId : undefined;
  return typeof value === "string" && value.trim() ? value : null;
}
const COMPACT_HOST_PURPOSES: ReadonlyMap<string, string> = new Map([
  ["goal-continuation", "goal continuation"], ["update-resume", "resumed after update"], ["run-recovery", "recovery pass"],
]);
/*
 * LEGACY ONLY. Journals written before the marker above carry no purpose on host-written rows (production 2026-10-13:
 * 166 such rows, ~300k chars in the Yotube room journals). The prefixes below are the fixed first words of the host's
 * own prompt builders (hephaestus/loop-engineering.ts buildGoalDrivenContinuationPrompt and
 * buildStormbreakerContinuationPrompt, invocation/automatic-goal.ts); a row WITH the marker never reaches this list.
 * Delete once no journal predates the marker.
 */
const LEGACY_HOST_PROMPT_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["Continue persistent-goal execution pass ", "goal-continuation"], ["Continue Stormbreaker execution pass ", "goal-continuation"],
  ["Resume the existing goal under its original permissions.", "goal-continuation"],
];
function legacyHostPurpose(text: string): string | undefined {
  return LEGACY_HOST_PROMPT_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1];
}
/** Assistant text as the owner saw it: hidden host blocks (memory envelopes, wait requests, goal markers) removed. */
export function replayVisibleAssistantText(text: string): string {
  let out = stripAllMemoryEventBlocks(text).cleanedText;
  out = stripGoalWaitDisplayText(out);
  out = stripGoalCompleteMarker(out).text;
  out = stripStormbreakerContinueMarker(out).text;
  return out.trim();
}
function contextEvents(req: RunnerRequest, turnId: string, bindingKey: string, stableBlocks: readonly string[] = req.turnContextStable ?? []): AgentContextEvent[] {
  const events:AgentContextEvent[]=[{eventId:`system:${digest(req.systemPrompt)}`,kind:"system",payload:{text:req.systemPrompt}}];
  if(req.turnContext || stableBlocks.length)events.push({eventId:`turn:${turnId}:context`,kind:"turn-context",producerBinding:bindingKey,payload:{text:req.turnContext??"",stableBlocks:[...stableBlocks]}});
  events.push({eventId:`turn:${turnId}:input`,kind:"message",producerBinding:bindingKey,payload:{role:"user",text:req.userPrompt,createdAt:new Date().toISOString(),turnId,
    ...(req.agentContext&&hostAuthoredTurns.get(req.agentContext)?{hostAuthored:hostAuthoredTurns.get(req.agentContext)}:{}),...channelPayload(req.agentContext)}});
  for(const [index,image]of(req.images??[]).entries())events.push({eventId:`turn:${turnId}:image:${index}`,kind:"attachment",producerBinding:bindingKey,payload:{turnId,mediaType:image.mediaType,data:image.data,...(image.name?{name:image.name}:{}),...channelPayload(req.agentContext)}});
  return events;
}
/** Provider-neutral semantic transcript. Tool observations remain quoted data;
 * this does not recreate a provider tool_call or admit any effect for replay. */
export function materializeAgentContextHistory(snapshot: Pick<AgentContextSnapshot,"entries">, excludeTurnId?: string, limits?: {toolLines?: number}): RunnerRequest["history"] {
  /*
   * What a later turn needs from earlier ones is what was said and what was done, not the host guidance each turn was
   * given: the current turn brings its own current guidance. Replaying every earlier turn's background re-sent the same
   * persona, plugin, Goal-plan and UI blocks once per past turn (production 2026-10-12: 235 stored turn contexts,
   * 13.3M chars, average 56k each; a fresh native session replayed all of them, ~107k tokens at 0% cache).
   * Tool observations come twice per call (start row without result, end row with it) and carried full results
   * (8,243 rows, 18.9M chars). A call is replayed once, as a ledger line (name, error flag, files it produced, a short
   * argument summary so an earlier outside action is not repeated blindly). The model re-reads a result if it needs one.
   */
  snapshot = replayableSnapshot(snapshot);
  const lastRowOfCall=new Map<string,number>();
  snapshot.entries.forEach((entry,index)=>{
    const callId=entry.kind==="tool"?entry.payload.callId:undefined;
    if(typeof callId==="string" && callId)lastRowOfCall.set(callId,index);
  });
  type Row=NonNullable<RunnerRequest["history"]>[number];
  const rows:Array<{row:Row;ledger?:ToolLedger}>=[];
  for(const [index,entry] of snapshot.entries.entries()){
    const p=entry.payload;
    if(entry.kind==="turn-context")continue;
    if(entry.kind==="tool"){
      const callId=p.callId;
      if(typeof callId==="string" && callId && lastRowOfCall.get(callId)!==index)continue;
      const argumentText=p.arguments===undefined?"":typeof p.arguments==="string"?p.arguments:JSON.stringify(p.arguments);
      const ledger:ToolLedger={name:String(p.name),...(p.isError===true?{isError:true}:{}),
        ...(Array.isArray(p.artifactPaths)&&p.artifactPaths.length?{artifactPaths:p.artifactPaths.filter((v):v is string=>typeof v==="string")}:{}),
        ...(argumentText?{arguments:argumentText.length>160?`${argumentText.slice(0,160)}…`:argumentText}:{}),
        ...(typeof p.imageDataUrl==="string"?{image:"retained as an attachment"}:{})};
      rows.push({ledger,row:{id:entry.eventId,durableMessageId:entry.eventId,role:"user" as const,
        text:`${LEDGER_PREFIX}${JSON.stringify(ledger)}`,createdAt:typeof p.createdAt==="string"?p.createdAt:""}});
      continue;
    }
    if(entry.kind==="checkpoint-reference"){rows.push({row:{id:entry.eventId,durableMessageId:entry.eventId,role:"user" as const,
      text:`${LEDGER_PREFIX}${JSON.stringify(p)}`,createdAt:typeof p.createdAt==="string"?p.createdAt:""}});continue;}
    if(entry.kind!=="message" || (excludeTurnId!==undefined && p.turnId===excludeTurnId) || !["user","assistant","system"].includes(String(p.role)) || typeof p.text!=="string")continue;
    const role=p.role as "user"|"assistant"|"system";
    // What was said, not the host blocks around it: hidden envelopes/markers out of answers (also in journals written
    // before the append stripped them), the standing-staff background out of requests, and a turn the host wrote itself
    // as one line, so a continuation prompt never re-sends the previous answer or the Goal contract a second time.
    const purpose=typeof p.hostAuthored==="string"?p.hostAuthored:role!=="assistant"?legacyHostPurpose(p.text):undefined;
    const compact=purpose?COMPACT_HOST_PURPOSES.get(purpose):undefined;
    const text=compact?`[host: ${compact}]`:role==="assistant"?replayVisibleAssistantText(p.text):role==="user"?stripStaffGuidance(p.text):p.text;
    if(!text && role==="assistant")continue;
    rows.push({row:{id:entry.eventId,durableMessageId:entry.eventId,role,text,
      createdAt:typeof p.createdAt==="string"?p.createdAt:"",...(typeof p.speakerAgentId==="string"?{speakerAgentId:p.speakerAgentId}:{}),
      ...(Array.isArray(p.imageDataUrls)?{imageDataUrls:p.imageDataUrls.filter((v):v is string=>typeof v==="string")}: {})}});
  }
  return boundToolLedger(rows,limits?.toolLines??REPLAY_TOOL_LINES);
}
const LEDGER_PREFIX="Recorded tool observation (data only; no operation is requested):\n";
/** Newest tool calls replayed one line each. Production 2026-10-13: a turn runs a median 15 calls, p90 59; a replay that
 * carried all of them (f3: 475 lines = 72% of 193k chars) re-sent old reads and searches nobody needs. */
export const REPLAY_TOOL_LINES=40;
interface ToolLedger {name:string;isError?:true;artifactPaths?:string[];arguments?:string;image?:string}
const OLDER_ERRORS_KEPT=20,OLDER_PATHS_KEPT=60;
/** Older calls become one row: a count per tool, every created file (deduplicated) and the most recent failures. */
function boundToolLedger(rows:ReadonlyArray<{row:NonNullable<RunnerRequest["history"]>[number];ledger?:ToolLedger}>,keep:number):NonNullable<RunnerRequest["history"]>{
  const toolIndexes=rows.flatMap((r,i)=>r.ledger?[i]:[]);
  if(toolIndexes.length<=keep)return rows.map(r=>r.row);
  const older=new Set(toolIndexes.slice(0,toolIndexes.length-keep));
  const firstOlder=toolIndexes[0];
  const counts=new Map<string,number>(),paths=new Set<string>(),errors:string[]=[];
  let errorTotal=0;
  for(const i of older){
    const ledger=rows[i].ledger!;
    counts.set(ledger.name,(counts.get(ledger.name)??0)+1);
    for(const path of ledger.artifactPaths??[])paths.add(path);
    if(ledger.isError){errorTotal+=1;errors.push(`${ledger.name}${ledger.arguments?`(${ledger.arguments.slice(0,80)})`:""}`);}
  }
  const summary={earlierToolCalls:older.size,byTool:Object.fromEntries([...counts].sort((a,b)=>b[1]-a[1])),
    ...(paths.size?{createdFiles:[...paths].slice(-OLDER_PATHS_KEPT),...(paths.size>OLDER_PATHS_KEPT?{moreCreatedFiles:paths.size-OLDER_PATHS_KEPT}:{})}:{}),
    ...(errorTotal?{failedCalls:errors.slice(-OLDER_ERRORS_KEPT),...(errorTotal>OLDER_ERRORS_KEPT?{moreFailedCalls:errorTotal-OLDER_ERRORS_KEPT}:{})}:{})};
  const first=rows[firstOlder].row;
  const out:NonNullable<RunnerRequest["history"]>=[];
  for(const [i,r] of rows.entries()){
    if(i===firstOlder)out.push({id:`${first.id}:earlier-tools`,durableMessageId:`${first.id}:earlier-tools`,role:"user",
      text:`${LEDGER_PREFIX}${JSON.stringify(summary)}`,createdAt:first.createdAt});
    else if(!older.has(i))out.push(r.row);
  }
  return out;
}
function materializeAttachments(entries: AgentContextSnapshot["entries"], excludeTurnId: string): NonNullable<RunnerRequest["images"]> {
  return replayableSnapshot({ entries }).entries.flatMap(entry=>{
    if(entry.kind==="attachment" && entry.payload.turnId!==excludeTurnId
      && typeof entry.payload.mediaType==="string" && typeof entry.payload.data==="string")return [
      {mediaType:entry.payload.mediaType,data:entry.payload.data,...(typeof entry.payload.name==="string"?{name:entry.payload.name}:{})}];
    if(entry.kind==="tool" && typeof entry.payload.imageDataUrl==="string"){
      const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(entry.payload.imageDataUrl);
      if(match)return [{mediaType:match[1],data:match[2]}];
    }
    return [];
  });
}
/** API adapters inspect active exact delivery through the host capability;
 * an arbitrary JSON handle or request string is insufficient. */
export function agentContextDeliveryForRequest(req: RunnerRequest): AgentContextDelivery | null {
  const cap=(req as RunnerRequest & {agentContext?:AgentContextCapability}).agentContext;
  if(!cap)return null;current(cap);
  return activeDeliveries.get(cap)??null;
}
export interface AgentContextBootstrapPacket {
  readonly history: readonly ChatHistoryEntry[];
  readonly images: readonly NonNullable<RunnerRequest["images"]>[number][];
  readonly currentPrompt: string;
  readonly turnContext: string;
  readonly throughSeq: number;
  readonly turnId: string;
  readonly nativeHandle: string | null;
  readonly locale: RunnerRequest["locale"];
}
const activeBootstraps = new WeakMap<AgentContextCapability, {
  delivery: AgentContextDelivery;
  packet?: Readonly<AgentContextBootstrapPacket>;
  create(): Readonly<AgentContextBootstrapPacket>;
  /** The provider kind and request of the turn, for a cold native session's host facts. */
  kind: string;
  request: RunnerRequest;
  hostFactsApplied?: boolean;
}>();
/** Data for a measured cold native session, resolved only while the exact
 * original host delivery is active. It grants no replay or tool authority.
 * Current input is captured before this wrapper adds foreign-path history. */
export function agentContextBootstrapForRequest(req: RunnerRequest): Readonly<AgentContextBootstrapPacket> | null {
  const capability = req.agentContext;
  if (!capability) return null;
  current(capability);
  const held = activeBootstraps.get(capability);
  if (!held || activeDeliveries.get(capability) !== held.delivery) return null;
  return held.packet ??= held.create();
}
/**
 * A runner whose native session turned out cold although the host expected to resume it (an unusable handle, an
 * unloaded ACP session) seeds the new session from the journal; that is a host replay, so the host facts lead the
 * packet's turn context exactly as on a fresh turn (native-harness NH13). The facts already installed for this turn
 * are reused, never journaled twice.
 */
export async function agentContextColdBootstrapForRequest(req: RunnerRequest): Promise<Readonly<AgentContextBootstrapPacket> | null> {
  const packet = agentContextBootstrapForRequest(req);
  const capability = req.agentContext, held = capability ? activeBootstraps.get(capability) : undefined;
  if (!packet || !capability || !held || held.hostFactsApplied) return packet;
  held.hostFactsApplied = true;
  const block = hostFactsSent.get(capability)?.block ?? await installHostFacts(capability, held.request, held.kind, held.delivery, packet.history);
  if (!block || activeBootstraps.get(capability) !== held) return packet;
  // Same declared parts and canonical order as a fresh turn's composition (withAgentContext contextParts): the original
  // typed task parts stay ahead of the per-turn facts, the facts stay ahead of the checkpoint summary. An unbound original
  // is one opaque tail, so its bytes and position are unchanged.
  const parts = bootstrapParts.get(packet);
  const cold = parts ? [coldBootstrapPart("agent-context.host-facts", ["checkpoint", "retrieval"], block), ...parts] : null;
  const next = Object.freeze({ ...packet, turnContext: cold ? renderRunnerTurnContext(cold) : [block, packet.turnContext].filter(Boolean).join("\n\n") });
  if (cold) bootstrapParts.set(next, cold);
  return held.packet = next;
}
/** A cold packet's turn context as declared parts (the fresh-turn declarations), kept beside the frozen packet. */
const bootstrapParts = new WeakMap<object, readonly DeclaredPromptPart[]>();
function coldBootstrapPart(id: "agent-context.host-facts" | "agent-context.checkpoint-replay" | "agent-context.channel",
  changeTriggers: DeclaredPromptPart["changeTriggers"], text: string, order?: number): DeclaredPromptPart {
  return { id, revision: 1, stability: "turn-context", changeTriggers, ...(order === undefined ? {} : { order }), text };
}
/*
 * Host facts for a native session that starts from host history (native-harness NH13, docs 05:76,83, 07 G11): a new
 * generation after an 80% rotation or a retired handle, a new binding (an Antigravity model change), or a handle the
 * runner could not use. The facts come from host stores at dispatch time (grants in force, unconfirmed effects, Goal
 * revision and active plan nodes, the frontier of what this session is given), are rendered ahead of any checkpoint
 * summary, and are journaled with the turn: the turn's delivery ACK is their install receipt, recorded once acknowledged.
 */
const hostFactsSent = new WeakMap<AgentContextCapability, { block: string; eventId: string; factsDigest: string;
  turnId: string; bindingKey: string; generation: number }>();
type MetaStore = { getMeta(key: string): string | null; setMeta(key: string, value: string): void };
function metaStore(): MetaStore | null {
  try { return require("../store/meta") as MetaStore; } catch { return null; }
}
const rotationMetaKey = (contextKey: string, bindingKey: string) => `agent-context-rotation:${contextKey}:${bindingKey}`;
const hostFactsMetaKey = (contextKey: string, bindingKey: string) => `agent-context-host-facts:${contextKey}:${bindingKey}`;
interface AgentContextRotationRecord { fromGeneration: number; toGeneration: number; reason: "context_ratio" | "resume_failed";
  reportedInputTokens: number | null; contextWindowTokens: number | null; rotatedAt: string }
function recordRotation(delivery: AgentContextDelivery, record: Omit<AgentContextRotationRecord, "fromGeneration" | "toGeneration" | "rotatedAt">,
  origin?: { runtime: string; agentId: string; windowSource: string }): void {
  try {
    metaStore()?.setMeta(rotationMetaKey(delivery.contextKey, delivery.bindingKey), JSON.stringify({ fromGeneration: delivery.generation,
      toGeneration: delivery.generation + 1, rotatedAt: new Date().toISOString(), ...record } satisfies AgentContextRotationRecord));
  } catch { /* The rotation itself is in the binding row; a lost reason renders as "none". */ }
  // One run event per generation switch (none existed: production 2026-10-18 showed 0 rotations and nothing to count them by).
  if (origin) recordAgentContextRunEvent(delivery.turnId, origin.agentId, AGENT_CONTEXT_GENERATION_EVENT_KIND, {
    schemaVersion: "agentlas.agent-context-generation.v1", runtime: origin.runtime, reason: record.reason,
    fromGeneration: delivery.generation, toGeneration: delivery.generation + 1,
    ...(record.reportedInputTokens !== null ? { reportedInputTokens: record.reportedInputTokens } : {}),
    ...(record.contextWindowTokens !== null ? { contextWindowTokens: record.contextWindowTokens } : {}),
    windowSource: origin.windowSource, contextRef: contextRef(delivery.contextKey), bindingRef: contextRef(delivery.bindingKey),
  }, `agent-context-generation:${delivery.contextKey}:${delivery.bindingKey}:${delivery.generation + 1}`);
}
function readRotation(delivery: AgentContextDelivery): AgentContextRotationRecord | null {
  try {
    const raw = metaStore()?.getMeta(rotationMetaKey(delivery.contextKey, delivery.bindingKey));
    const value = raw ? JSON.parse(raw) as AgentContextRotationRecord : null;
    return value && value.toGeneration === delivery.generation ? value : null;
  } catch { return null; }
}
async function installHostFacts(capability: AgentContextCapability, req: RunnerRequest, kind: string, delivery: AgentContextDelivery,
  history: readonly ChatHistoryEntry[]): Promise<string | null> {
  const sent = hostFactsSent.get(capability);
  if (sent) return sent.turnId === delivery.turnId ? sent.block : null;
  try {
    const { collectHostFacts, renderHostFacts } = await import("./handoff-facts");
    const rotation = readRotation(delivery), task = checkpointTask(req);
    const facts = await collectHostFacts({ chatId: req.chatId ?? null, agentId: req.agentId ?? null, runtime: kind, kind: "host-replay",
      fromGeneration: rotation?.fromGeneration ?? null, toGeneration: delivery.generation, ...(rotation ? { reason: rotation.reason } : {}),
      deliveredHistory: [...history], goalId: task?.id.startsWith("goal:") ? task.id.slice("goal:".length) : null });
    if (activeDeliveries.get(capability) !== delivery) return null;
    const block = renderHostFacts(facts), eventId = `turn:${delivery.turnId}:host-facts`;
    appendAgentContextEvent(capability, { eventId, kind: "turn-context", producerBinding: delivery.bindingKey,
      payload: { text: block, hostFacts: facts, generation: delivery.generation } });
    hostFactsSent.set(capability, { block, eventId, factsDigest: digest(facts), turnId: delivery.turnId,
      bindingKey: delivery.bindingKey, generation: delivery.generation });
    return block;
  } catch { return null; }
}
/** The install receipt: the facts reached the provider in a turn whose delivery the runtime acknowledged. */
function recordHostFactsInstalled(capability: AgentContextCapability, delivery: AgentContextDelivery, receiptId: string, nativeHandle: string | undefined): void {
  const sent = hostFactsSent.get(capability);
  if (!sent || sent.turnId !== delivery.turnId) return;
  try {
    metaStore()?.setMeta(hostFactsMetaKey(delivery.contextKey, delivery.bindingKey), JSON.stringify({ generation: sent.generation,
      turnId: sent.turnId, eventId: sent.eventId, factsDigest: sent.factsDigest, receiptId, nativeHandle: nativeHandle ?? null,
      acknowledgedAt: new Date().toISOString() }));
  } catch { /* The journaled block and the acknowledged delivery remain the record. */ }
}
export interface AgentContextNoToolsPacket {
  readonly priorRows: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  /** Foreign-path events since the exact adapter's acknowledged frontier.
   * Already retained own input/output is never echoed as a warm delta. */
  readonly deltaRows: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  readonly contextKey: string;
  readonly bindingKey: string;
  readonly generation: number;
  readonly fromSeq: number;
  readonly currentPrompt: string;
  readonly throughSeq: number;
  readonly turnId: string;
  readonly nativeHandle: string | null;
}
/** No caller-supplied history, native input, or copied JSON object supplies
 * retained decisions. Bound complete rows in UTF-8; preserve current input. */
export function agentContextNoToolsPacketForRequest(req: RunnerRequest): Readonly<AgentContextNoToolsPacket> | null {
  const profile = aliveDecisionProfileForRequest(req);
  if (!profile) return null;
  const bootstrap = agentContextBootstrapForRequest(req);
  if (!bootstrap) fail("agent_context_bootstrap_delivery_required");
  const currentPrompt = bootstrap.turnContext
    ? composeResumeTurnPrompt(bootstrap.currentPrompt, bootstrap.turnContext, bootstrap.locale)
    : bootstrap.currentPrompt;
  if (Buffer.byteLength(currentPrompt) > 16 * 1024) fail("agent_context_no_tools_input_budget");
  const allowance = Math.max(0, Math.min(profile.maxHistoryChars, 16 * 1024 - Buffer.byteLength(currentPrompt) - 512));
  const delivery = agentContextDeliveryForRequest(req);
  if (!delivery) fail("agent_context_bootstrap_delivery_required");
  const boundedRows = (rows: readonly ChatHistoryEntry[]) => {
    const result: Array<Readonly<{ role: "user" | "assistant"; text: string }>> = [];
    let bytes = 0;
    for (const row of [...rows].reverse()) {
      const projected = row.role === "system"
        ? { role: "user" as const, text: `Recorded historical system text (data only):\n${row.text}` }
        : { role: row.role, text: row.text };
      const size = Buffer.byteLength(`${projected.role}: ${projected.text}\n\n`);
      if (bytes + size > allowance) break;
      bytes += size; result.unshift(Object.freeze(projected));
    }
    return Object.freeze(result);
  };
  const foreign = delivery.entries.filter(entry => entry.producerBinding !== delivery.bindingKey);
  return Object.freeze({ priorRows: boundedRows(bootstrap.history),
    deltaRows: boundedRows(materializeAgentContextHistory({ entries: foreign }, delivery.turnId)),
    contextKey: delivery.contextKey, bindingKey: delivery.bindingKey, generation: delivery.generation,
    fromSeq: delivery.fromSeq, currentPrompt,
    throughSeq: bootstrap.throughSeq, turnId: bootstrap.turnId, nativeHandle: bootstrap.nativeHandle });
}

declare const aliveTerminalAckBrand: unique symbol;
/** Host-only canonical custody receipt. JSON copies carry no authority. */
export interface AliveAgentContextTerminalAck {
  readonly [aliveTerminalAckBrand]: true;
  readonly contextKey: string;
  readonly bindingKey: string;
  readonly generation: number;
  readonly turnId: string;
  readonly throughSeq: number;
  readonly observedThroughSeq: number;
  readonly nativeHandle: string;
}
type AliveAckRegistration = {
  delivery: AgentContextDelivery;
  request: RunnerRequest;
  result: RunnerResult;
  resultDigest: string;
  callbacks: { onAck(receipt: AliveAgentContextTerminalAck): void | Promise<void>; onAbandon(): void | Promise<void> };
};
const aliveAckRegistrations = new WeakMap<AgentContextCapability, AliveAckRegistration>();
const aliveAckReceipts = new WeakMap<object, { registration: AliveAckRegistration; capability: AgentContextCapability }>();
/** Only the dedicated daemon Alive profile can register a measured native
 * terminal. Ordinary runners and provider-completed receipts cannot do so. */
export function registerAliveAgentContextTerminalAck(request: RunnerRequest, result: RunnerResult,
  callbacks: AliveAckRegistration["callbacks"]): () => void {
  const profile = aliveDecisionProfileForRequest(request), capability = request.agentContext;
  const delivery = agentContextDeliveryForRequest(request);
  if (!profile || !capability || !delivery || aliveAckRegistrations.has(capability)
    || result.failure || result.ownerControlTerminal !== "completed" || typeof result.text !== "string"
    || typeof result.sessionId !== "string" || !result.sessionId.trim()
    || typeof callbacks.onAck !== "function" || typeof callbacks.onAbandon !== "function") {
    fail("agent_context_alive_terminal_required");
  }
  profile.assertCurrent(); current(capability);
  const registration: AliveAckRegistration = { delivery, request, result,
    resultDigest: digest([result.text, result.sessionId]), callbacks };
  aliveAckRegistrations.set(capability, registration);
  return () => { if (aliveAckRegistrations.get(capability) === registration) aliveAckRegistrations.delete(capability); };
}
/** Called synchronously by the registered transport while its original
 * host turn is still current. Each exact journal ACK is single-consumer. */
export function consumeAliveAgentContextTerminalAck(receipt: AliveAgentContextTerminalAck,
  request: RunnerRequest, result: RunnerResult): boolean {
  const held = receipt && typeof receipt === "object" ? aliveAckReceipts.get(receipt) : undefined;
  if (!held || held.registration.request !== request || held.registration.result !== result
    || request.agentContext !== held.capability || activeDeliveries.get(held.capability) !== held.registration.delivery
    || prepared.get(held.registration.delivery)?.acknowledged !== true
    || result.failure || result.ownerControlTerminal !== "completed"
    || digest([result.text, result.sessionId]) !== held.registration.resultDigest) return false;
  try { if (!aliveDecisionProfileForRequest(request)) return false; current(held.capability); }
  catch { return false; }
  aliveAckReceipts.delete(receipt);
  return true;
}
async function publishAliveTerminalAck(capability: AgentContextCapability, delivery: AgentContextDelivery,
  result: RunnerResult, observedThroughSeq: number): Promise<void> {
  const held = aliveAckRegistrations.get(capability);
  if (!held || held.delivery !== delivery || held.result !== result
    || digest([result.text, result.sessionId]) !== held.resultDigest || !result.sessionId) return;
  current(capability);
  const profile = aliveDecisionProfileForRequest(held.request);
  if (!profile) return;
  profile.assertCurrent();
  const receipt = Object.freeze({ contextKey: delivery.contextKey, bindingKey: delivery.bindingKey,
    generation: delivery.generation, turnId: delivery.turnId, throughSeq: delivery.throughSeq,
    observedThroughSeq, nativeHandle: result.sessionId }) as AliveAgentContextTerminalAck;
  aliveAckReceipts.set(receipt, { registration: held, capability });
  try {
    await held.callbacks.onAck(receipt);
    aliveAckRegistrations.delete(capability);
  } catch {
    // Canonical success is already durable. Failure to retain an auxiliary
    // provider chain closes that chain without fabricating a failed journal ACK.
    try { await held.callbacks.onAbandon(); } catch { /* Captured close is unconditional. */ }
    aliveAckRegistrations.delete(capability);
  } finally { aliveAckReceipts.delete(receipt); }
}
export interface AgentContextTransport {
  readonly policy: Readonly<ResponsesContextPolicy>;
  readonly packet: Readonly<RetainedResponsesPromptPacket>;
}
/** Only the active host preparation resolves a transport; request/IPC fields
 * cannot supply a retained ID, endpoint, prompt packet or reset proof. */
export function agentContextTransportForRequest(req:RunnerRequest):AgentContextTransport|null {
  if(!req.agentContext)return null;current(req.agentContext);
  return activeTransports.get(req.agentContext)??null;
}
export function appendAgentContextReference(req:RunnerRequest,reference:{action_id:string;step_id:string}):void {
  const cap=req.agentContext;if(!cap)return;
  const delivery=agentContextDeliveryForRequest(req);if(!delivery)fail("agent_context_reference_delivery_required");
  if(![reference.action_id,reference.step_id].every(value=>typeof value==="string" && !!value.trim() && value.length<=512))fail("agent_context_reference_invalid");
  const ordinal=(referenceOrdinals.get(cap)??0)+1;referenceOrdinals.set(cap,ordinal);
  appendAgentContextEvent(cap,{eventId:`turn:${delivery.turnId}:checkpoint:${ordinal}`,kind:"checkpoint-reference",
    producerBinding:delivery.bindingKey,payload:{action_id:reference.action_id,step_id:reference.step_id}});
}
const activeDeliveries=new WeakMap<AgentContextCapability,AgentContextDelivery>();
const activeTransports=new WeakMap<AgentContextCapability,AgentContextTransport>();
const referenceOrdinals=new WeakMap<AgentContextCapability,number>();
export interface AgentContextRunnerOptions {
  configurationSource?:string;
  /** Exact selected host profile/command contract, never a model grant. */
  configurationIdentity?:string;
  transportForRequest?(req:RunnerRequest):ResponsesContextPolicy|null;
  /** The exact adapter's opaque, single-use pre-effect rejection proof. */
  consumePreviousContextMissingProof?(error:unknown,req:RunnerRequest):boolean;
}
function omitAcknowledgedBlocks(text:string,blocks:readonly string[],known:Set<string>):string {
  for(const block of blocks){if(block && known.has(digest(block)))text=text.split(block).join("");}
  return text.replace(/\n{3,}/g,"\n\n").trim();
}
// Antigravity resumes its own conversation (agy --conversation) like every other CLI here (native-harness NH11).
const NATIVE_CONTEXT_RESUME_KINDS=new Set(["claude-code","codex","kimi","grok","cursor","acp","antigravity"]);
/** Declared host-alternative (native-harness NH11): an Antigravity conversation belongs to the model that produced it
 * (antigravity.ts antigravitySessionFingerprint), so its native binding keeps the model. A model change opens another
 * binding of the same journal, seeded by host replay, instead of handing one model's conversation to another. */
const MODEL_OWNED_NATIVE_KINDS=new Set(["antigravity"]);
const HOST_MESSAGE_CONTEXT_KINDS=new Set(["byok","agentlas","lmstudio","mlx","agentlas-local","ollama"]);
/** Built from the same private host metadata that selected the adapter, not a
 * display label or renderer claim. An unknown ACP seat cannot be substituted. */
function checkpointRuntimeSelection(req: RunnerRequest, provider: Omit<AgentContextProvider,"model"|"configurationDigest">,
  options: AgentContextRunnerOptions): RuntimeSelection | undefined {
  if (!NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind) && !HOST_MESSAGE_CONTEXT_KINDS.has(provider.kind) && provider.kind !== "antigravity") return undefined;
  let acpAgentId: string | undefined;
  if (provider.kind === "acp") {
    try { const spec: unknown = JSON.parse(options.configurationIdentity ?? "null");
      if (Array.isArray(spec) && typeof spec[0] === "string" && spec[0].trim()) acpAgentId = spec[0];
    } catch { /* Without an exact host seat, only the configured no-tools pool may run. */ }
    if (!acpAgentId) return undefined;
  }
  return { kind: provider.kind as RuntimeSelection["kind"],
    ...(provider.backend ? { backend: provider.backend as RuntimeSelection["backend"] } : {}),
    ...(req.runtimeSource ?? options.configurationSource ? { source: req.runtimeSource ?? options.configurationSource } : {}),
    ...(acpAgentId ? { acpAgentId } : {}), ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}), ...(req.longContext !== undefined ? { longContext: req.longContext } : {}) };
}
/** The daemon retains the neutral transcript. Stateless providers still get
 * materialized messages; only adapters with measured session handles may send
 * an incremental provider wire request. The wrapper never invents a handle. */
/**
 * The agent instructions a native session last received, per binding and native handle. A session created with the
 * system prompt has it; a resumed one gets the current version as one stable turn-context block when it changed (the
 * runners' dedupeStableTurnContext sends an identical block once per session). Unknown after a restart: sent once.
 */
/** The native-session seed suffix of a binding generation: none for the first (existing sessions keep their fingerprint). */
export function nativeGenerationSeed(generation: number): string {
  return Number.isSafeInteger(generation) && generation > 1 ? `:g${generation}` : "";
}
const deliveredInstructions=new Map<string,string>();
const nativeStableAcknowledgements=new Map<string,{epoch:number;hashes:ReadonlySet<string>}>();
const MAX_DELIVERED_INSTRUCTIONS=512;
/** Short ACK key for one instructions version: it rides the turn's stable-block list, so the store's stable-block ACK index
 * remembers which version the session received across restarts without journaling another copy of the prompt. */
const instructionsAckKey=(systemPrompt:string)=>`agent-instructions:${digest(systemPrompt)}`;
function instructionsBlockFor(bindingKey:string,resumedHandle:string|null|undefined,systemPrompt:string|undefined,acknowledged?:ReadonlySet<string>):{block:string|null;delivered:(handle:string)=>void}{
  const current=digest(systemPrompt??"");
  const remember=(handle:string)=>{
    const key=`${bindingKey}\0${handle}`;
    deliveredInstructions.delete(key);deliveredInstructions.set(key,current);
    while(deliveredInstructions.size>MAX_DELIVERED_INSTRUCTIONS)deliveredInstructions.delete(deliveredInstructions.keys().next().value as string);
  };
  if(!resumedHandle || !systemPrompt?.trim())return {block:null,delivered:remember};
  if(deliveredInstructions.get(`${bindingKey}\0${resumedHandle}`)===current)return {block:null,delivered:remember};
  // After a restart the memo is empty; the acknowledged stable blocks of this binding generation still name the version.
  if(acknowledged?.has(digest(instructionsAckKey(systemPrompt)))){remember(resumedHandle);return {block:null,delivered:remember};}
  return {block:`[Agent instructions, current version: replaces earlier ones]\n${systemPrompt}\n[End agent instructions]`,delivered:remember};
}

export function withAgentContext(runner: Runner, provider: Omit<AgentContextProvider,"model"|"configurationDigest">,options:AgentContextRunnerOptions={}): Runner {
  return async(req,events)=>{
    const capability=(req as RunnerRequest & {agentContext?:AgentContextCapability}).agentContext;
    if(!capability)return runner(req,events);
    if(!isAgentContextCapability(capability))fail("agent_context_host_capability_required");
    req.signal?.throwIfAborted();const value=current(capability),turnId=value.binding.turnId;
    // A genuine restricted recall rotates the provider conversation when its
    // selected sources or forget epoch change. Read before request copies;
    // JSON fields cannot supply this process-local reader binding.
    let surfaceMemory: typeof import("../memory/surface-recall") | null = null;
    try { surfaceMemory = require("../memory/surface-recall") as typeof import("../memory/surface-recall"); }
    catch { /* An unavailable optional reader has no derived binding. */ }
    const surfaceMemoryRequest = req;
    const derivedMemoryKey = surfaceMemory?.sourceMemoryRequestKey(surfaceMemoryRequest) ?? null;
    const assignedMemoryBoundary=surfaceMemory?.assignedTargetMemoryRequestBoundary?.(surfaceMemoryRequest)??null;
    const assertSurfaceMemoryCurrent = () => {
      if (derivedMemoryKey && surfaceMemory?.sourceMemoryRequestKey(surfaceMemoryRequest) !== derivedMemoryKey)
        fail("agent_context_memory_source_changed");
    };
    // The recall reader registered this exact prefix under the original host
    // source scope. Unknown/foreign/manual data remains in the original input.
    let memoryWire: typeof import("../memory/generation-pack") | null = null;
    let memoryBinding: import("../memory/generation-pack").MemoryPackWireBinding | null = null;
    enforceAgentContextMemoryBoundary(capability,{key:assignedMemoryBoundary?derivedMemoryKey:null,
      assertCurrent:()=>assignedMemoryBoundary?.assertCurrent()});
    try { if(!assignedMemoryBoundary){memoryWire = require("../memory/generation-pack") as typeof import("../memory/generation-pack");
      memoryBinding = memoryWire.prepareMemoryPackWire(req, value.identity, checkpointTask(req)); }
    }
    catch { /* Missing coverage cannot suppress any input. */ }
    const memoryBlocks = memoryWire?.memoryPackWireBlocks(memoryBinding) ?? [];
    if (memoryBlocks.length) req = carryRunnerTurnContext(req, { ...req, turnContextStable: [...new Set([...(req.turnContextStable ?? []), ...memoryBlocks])] });
    const decision=aliveDecisionProfileForRequest(req);
    let checkpointCustody: ReturnType<typeof getMemoryStoreInfo> | null = null;
    if (!decision) try { checkpointCustody = getMemoryStoreInfo(); } catch { /* Journal-only execution remains available. */ }
    if(req.agentId!==value.identity.agentId)refuseBeforeDispatch("agent_context_actor_binding_changed");
    const policy=options.transportForRequest?.(req)??null;
    const consumeMissingProof=options.consumePreviousContextMissingProof;
    if(policy && typeof consumeMissingProof!=="function")refuseBeforeDispatch("agent_context_transport_proof_required");
    const packet=policy?retainedResponsesPromptPacket(req):null;
    /*
     * A native session is the agent's conversation with its runtime, not one turn's tool surface. The tools routed for a
     * turn (mcpAllowedTools), an isolated MCP grant such as the browser and a catalog-only grant change what the process
     * exposes, not the conversation: Codex resumes a thread in a process with other servers (codex.ts turn-scoped
     * app-server), Claude Code resumes with another --mcp-config, ACP loads a session with new mcpServers. Keyed on
     * them, every routing change opened a new native session: production 2026-10-12, Motiondirector's one Yotube room
     * chat started five new Codex threads in a day (02:40-08:47Z), each first request re-sending ~107k tokens at 0%
     * cache. The system prompt is not in the key either: it varies with the sections a turn needs (instructions sizes
     * 5,844-12,636 tokens in that chat), and a resumed native session is given the current version as a stable
     * turn-context block once it differs from what that session last received (instructionsBlockFor).
     * Model, permission, cwd, plan mode and locale are per-turn inputs of a native turn, not a new conversation (owner
     * 2026-10-12: "모델·권한·폴더·지시가 바뀐다고 세션이 바뀔 이유가 없다"): Codex reasserts sandbox, approval and cwd on every
     * turn/start and carries the thread's history into a model change itself; Claude Code resumes with another --model
     * and --permission-mode; the locale reaches the session with the instructions. So the key is the agent's
     * conversation with one runtime and its account source. A workforce tool grant keeps its exact configuration (its
     * observation acknowledges the thread it starts). Stateless and Responses-transport providers keep the full key.
     */
    const forwardGeneration = forwardGenerations.get(capability);
    forwardGeneration?.assertCurrent();
    const nativeSessionKey=NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind) && !policy;
    const adapter:AgentContextProvider={...provider,...(nativeSessionKey && !MODEL_OWNED_NATIVE_KINDS.has(provider.kind)?{}:{model:req.model}),configurationDigest:digest(nativeSessionKey ? [
      "native-session.v3",req.runtimeSource??options.configurationSource??"",options.configurationIdentity??"",
      req.workforceRuntimeToolGrant?.canonicalConfigSha256??null,...(derivedMemoryKey?["derived-memory.v1",derivedMemoryKey]:[])] : [
      req.runtimeSource??options.configurationSource??"",options.configurationIdentity??"",req.locale,req.permission??"",req.planMode??false,
      req.cwd??null,req.isolatedMcpConfig??false,req.mcpGrantCatalogOnly??false,req.mcpAllowedTools??null,
      req.workforceRuntimeToolGrant?.canonicalConfigSha256??null,
      packet?digest(packet.systemPrompt):NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind)?digest(req.systemPrompt):"",
      policy??null,...(derivedMemoryKey?["derived-memory.v1",derivedMemoryKey]:[])])};
    const bindingKey=agentContextProviderKey(adapter);
    // A journal refusal here (a busy or unresolved delivery, a replayed turn, a colliding event) precedes every provider send.
    const delivery=(()=>{try{return prepareAgentContextTurn(capability,{turnId,provider:adapter,signal:req.signal,events:contextEvents(req,turnId,bindingKey,[...(req.turnContextStable??[]),...(packet?.stableBlocks??[]),
      ...(nativeSessionKey && req.systemPrompt?.trim() ? [instructionsAckKey(req.systemPrompt)] : [])])});}
      catch(error){throw markRefusedBeforeDispatch(error);}})();
    activeDeliveries.set(capability,delivery);
    const nativeKind=NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind);
    const continuationHandle=continuationHandles.get(turnId)??null;continuationHandles.delete(turnId);
    // The conversation this turn resumes: the host's continuation handle (native, non-Responses adapters only), else the binding's.
    const nativeHandle=nativeKind && !policy && continuationHandle ? continuationHandle : delivery.nativeHandle;
    const retentionScope = { chatId: delivery.contextKey, runtimeKind: provider.kind, sessionId: nativeHandle ?? "" };
    const enteredRetentionEpoch = nativeSessionKey && nativeHandle && nativeHandle === delivery.nativeHandle
      ? nativeStableTurnContextEpoch(retentionScope, true) : undefined;
    const retentionAckKey = enteredRetentionEpoch === undefined ? null
      : JSON.stringify([delivery.contextKey, delivery.bindingKey, delivery.generation, nativeHandle]);
    const nativeStableAck = retentionAckKey === null ? undefined : nativeStableAcknowledgements.get(retentionAckKey);
    const nativeStableReuse = nativeStableAck?.epoch === enteredRetentionEpoch && enteredRetentionEpoch !== undefined;
    let nativeDeliveredHashes: readonly string[] = [];
    const noteUnsettled=(observed:string|null)=>{
      const handle=observed??nativeHandle??null,stateful=nativeKind||!!policy;
      remember(unsettledTurns,turnId,{resumable:stateful?!!handle:true,handle,retire(){
        // The same rule as a completed turn's rotation (session-generation.ts), with the symptom the host observed.
        if(decideGeneration({kind:provider.kind,contextWindowTokens:null,lastInputTokens:null,symptom:"resume_failed"}).action!=="new_generation")return;
        try{store.invalidateProvider(value.identity,adapter,delivery.generation);
          recordRotation(delivery,{reason:"resume_failed",reportedInputTokens:null,contextWindowTokens:null},
            {runtime:provider.kind,agentId:value.identity.agentId,windowSource:"none"});}catch{/* a concurrent delivery or generation owns the binding */}
      }});
    };
    if(policy && packet)activeTransports.set(capability,Object.freeze({policy:Object.freeze({...policy}),packet}));
    const saveCheckpoint = async (allowSemantic: boolean, observation: SessionHostObservation): Promise<void> => {
      if (!checkpointCustody || decision) return;
      try {
        const assertCustody = () => {
          const custody = getMemoryStoreInfo();
          if (custody.ownerNamespace !== checkpointCustody!.ownerNamespace || custody.revocationEpoch !== checkpointCustody!.revocationEpoch)
            fail("session_checkpoint_custody_changed");
          assertSurfaceMemoryCurrent();
        };
        assertCustody(); if (allowSemantic) current(capability);
        const observed = store.readRange(value.identity, { after: delivery.throughSeq });
        let throughSeq = delivery.throughSeq;
        for (const entry of observed.entries) { if (entry.producerBinding !== delivery.bindingKey) break; throughSeq = entry.seq; }
        const source = replayableSnapshot(store.readRange(value.identity, { through: throughSeq })), sourceHead = store.readHead(value.identity);
        // Unknown window: the shared, labelled degraded value (docs native-harness 07 G08), not a literal guess.
        const task = checkpointTask(req), window = runtimeContextWindow(provider.kind, req.model) ?? UNKNOWN_CONTEXT_WINDOW;
        const historyBudgetTokens = Math.max(0, Math.floor(window * 0.5) - estimateTransportTokens(req.systemPrompt)
          - estimateTransportTokens(req.userPrompt) - estimateTransportTokens(req.turnContext ?? ""));
        await sessionCheckpointStore.save({ identity: value.identity, snapshot: { ...source, throughSeq },
          rows: materializeAgentContextHistory(source), task, historyBudgetTokens,
          ...(allowSemantic ? { signal: req.signal } : {}), allowSemantic, hostObservation: observation,
          expectedForgetEpoch: checkpointCustody.revocationEpoch, runtimeSelection: checkpointRuntimeSelection(req, provider, options),
          assertSourceCurrent() {
            // Stop revokes execution, not the original actor's data custody.
            // This path grants no tool, provider ACK, native handle or resume.
            assertCustody(); if (allowSemantic) current(capability);
            const head = store.readHead(value.identity);
            if (head.revision !== sourceHead.revision || head.throughSeq !== sourceHead.throughSeq) fail("session_checkpoint_source_revision_changed");
            if (digest(checkpointTask(req)) !== digest(task)) fail("session_checkpoint_task_revision_changed");
          },
        });
      } catch { /* Prior checkpoint plus authoritative journal delta remains usable. */ }
    };
    let toolIndex=0, partialTail="", toolBoundaryTokens=0;
    // Typed dispatch evidence for the catch below: the native runner (and any provider send) starts only at this call.
    let runnerEntered=false;
    const enterRunner:Runner=(request,runnerEvents)=>{runnerEntered=true;return runner(request,runnerEvents);};
    const recordUnsettled = (outcome: "failed" | "cancelled" | "uncertain", text: string, failureCode?: string): void => {
      try {
        // A stale derived read cannot become a new partial-output source.
        assertSurfaceMemoryCurrent();
        if (!checkpointCustody || getMemoryStoreInfo().ownerNamespace !== checkpointCustody.ownerNamespace
          || getMemoryStoreInfo().revocationEpoch !== checkpointCustody.revocationEpoch) return;
        const clean = replayVisibleAssistantText(text);
        if (clean) store.append(value.identity, sanitizeEvent({ eventId: `turn:${turnId}:partial-output`, kind: "message",
          producerBinding: delivery.bindingKey, payload: { role: "assistant", text: clean, turnId, partial: true,
            representation: "observed-partial-extract", createdAt: new Date().toISOString(), ...channelPayload(capability) } }));
        store.append(value.identity, sanitizeEvent({ eventId: `turn:${turnId}:terminal-observation`, kind: "checkpoint-reference",
          producerBinding: delivery.bindingKey, payload: { turnId, continuationOutcome: outcome, providerAcknowledged: false,
            ...(failureCode ? { failureCode } : {}) } }));
      } catch { /* Recording continuity never changes the original failure/Stop result. */ }
    };
    const wrapped:RunnerEvents={...events,onPartial(text) {
      partialTail = `${partialTail}${text}`.slice(-4096); events.onPartial?.(text);
    },onTool(name,args,result,id,isError,artifactPaths,imageDataUrl,origin,toolKind){
      // Actual adapter emissions, retained as context data with canonical host
      // references when supplied. Tool effect authority remains in its ledger.
      appendAgentContextEvent(capability,{eventId:`turn:${turnId}:tool:${toolIndex++}`,kind:"tool",producerBinding:delivery.bindingKey,
        payload:{name,createdAt:new Date().toISOString(),...(args!==undefined?{arguments:args}:{}),...(result!==undefined?{result}:{}),...(id?{callId:id}:{}),...(isError!==undefined?{isError}:{}),...(artifactPaths?{artifactPaths:[...artifactPaths]}:{}),...(imageDataUrl?{imageDataUrl}:{}),...(origin?{origin}:{}),...channelPayload(capability)}});
      events.onTool?.(name,args,result,id,isError,artifactPaths,imageDataUrl,origin,toolKind);
      if (result !== undefined) {
        toolBoundaryTokens += estimateTransportTokens(typeof result === "string" ? result : JSON.stringify(result));
        // The size trigger needs a known window; an unknown one never checkpoints on a guessed number (G08).
        const boundaryWindow = runtimeContextWindow(provider.kind, req.model);
        if (isError || artifactPaths?.length || (boundaryWindow != null && toolBoundaryTokens > boundaryWindow * 0.5)) {
          toolBoundaryTokens = 0;
          void saveCheckpoint(false, { turnId, outcome: "processing", providerAcknowledged: false });
        }
      }
    }};
    try {
      const native=nativeKind,stateful=native || !!policy,resume=stateful && !!nativeHandle;
      let result: RunnerResult;
      let instructions: ReturnType<typeof instructionsBlockFor> | null = null;
      if (forwardGeneration) {
        forwardGeneration.assertCurrent();
        result = await enterRunner({ ...req, history: [], runtimeSessionId: undefined,
          runtimeSessionOwnerId: `agent-context:${delivery.contextKey}:${delivery.bindingKey}`,
          sessionFingerprintSeed: `agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}${nativeGenerationSeed(delivery.generation)}` }, wrapped);
        forwardGeneration.assertCurrent();
      } else {
      // The prepared input frontier is immutable. Later owner updates stay
      // for their own authorized turn, even if another writer appends now.
      const snapshot=!resume && !decision
        ?replayableSnapshot(store.readRange(value.identity,{through:delivery.throughSeq}))
        :{contextKey:delivery.contextKey,revision:0,throughSeq:delivery.throughSeq,entries:delivery.entries};
      const taskBoundary = decision ? null : checkpointTask(req);
      const rawHistory = materializeAgentContextHistory(snapshot, turnId);
      let checkpointReplay: ReturnType<typeof sessionCheckpointStore.restore> = null;
      if (!resume && !decision) {
        try { checkpointReplay = sessionCheckpointStore.restore(value.identity, snapshot, rawHistory, taskBoundary); }
        catch { /* The journal is authoritative; a missing/damaged projection never blocks a turn. */ }
      }
      const originalPrompt=req.userPrompt,originalContext=req.turnContext??"",originalLocale=req.locale;
      // Where this turn is spoken, for a session several conversations share; absent for every other turn (channelOfTurn).
      const channelLine = capability ? channelOfTurn.get(capability)?.line : undefined;
      // The original turn context as declared parts: the exact bound Main parts when they render this text, else one
      // opaque tail (bytes kept). A cold packet composes them like the fresh turn below, never by string prepend.
      const originalSource=runnerTurnContextSource(req);
      const originalParts:readonly DeclaredPromptPart[]=!originalContext?[]
        :originalSource && renderRunnerTurnContext(originalSource.parts)===originalContext?originalSource.parts
        :[{ id: "runner.turn-context.opaque", revision: 1, stability: "turn-context", changeTriggers: ["task", "owner-input", "checkpoint"], order: Number.MAX_SAFE_INTEGER, text: originalContext }];
      const originalImages=(req.images??[]).map(image=>Object.freeze({...image}));
      activeBootstraps.set(capability, { delivery, kind: provider.kind, request: req, create: () => {
        const full=resume?replayableSnapshot(store.readRange(current(capability).identity,{through:delivery.throughSeq})):snapshot;
        let bootstrapReplay = checkpointReplay;
        if (resume && !decision) {
          try { bootstrapReplay = sessionCheckpointStore.restore(value.identity, full, materializeAgentContextHistory(full, turnId), taskBoundary); }
          catch { /* Missing native state still falls back to the authoritative journal. */ }
        }
        const coldParts = [...(channelLine ? [coldBootstrapPart("agent-context.channel", ["task", "owner-input"], channelLine, -1)] : []),
          ...(bootstrapReplay?.block ? [coldBootstrapPart("agent-context.checkpoint-replay", ["checkpoint", "goal-revision"], bootstrapReplay.block)] : []), ...originalParts];
        const packet = Object.freeze({
        history: Object.freeze((bootstrapReplay?.history ?? materializeAgentContextHistory(full, turnId)).map(row => Object.freeze({ ...row,
          ...(row.imageDataUrls ? { imageDataUrls: Object.freeze([...row.imageDataUrls]) as unknown as string[] } : {}) }))),
        images: Object.freeze([...materializeAttachments(full.entries, turnId), ...originalImages].map(value => Object.freeze({ ...value }))),
        currentPrompt: originalPrompt, turnContext: renderRunnerTurnContext(coldParts), throughSeq: delivery.throughSeq,
        turnId, nativeHandle: nativeHandle ?? null,locale:originalLocale,
      });
        bootstrapParts.set(packet, coldParts);
        return packet; } });
      const foreignEntries=replayableSnapshot({ entries: delivery.entries }).entries.filter(entry=>entry.producerBinding!==delivery.bindingKey);
      // The prior ceiling is a UTF-8 byte budget, shared by current input
      // and retained observations. Keep whole rows; never fabricate cut JSON.
      const priorBudget=decision?Math.max(0,Math.min(decision.maxHistoryChars,
        16*1024-Buffer.byteLength(req.userPrompt)-Buffer.byteLength(req.turnContext??"")-512)):Infinity;
      const boundRows=(rows:RunnerRequest["history"])=>{
        if(!decision)return rows;
        const bounded:typeof rows=[];let bytes=0;
        for(const row of [...rows].reverse()){
          const size=Buffer.byteLength(`${row.role}: ${row.text}\n\n`);
          if(bytes+size>priorBudget)break;
          bounded.unshift(row);bytes+=size;
        }
        return bounded;
      };
      const history=resume?[]:boundRows(checkpointReplay?.history ?? rawHistory);
      const delta=resume?boundRows(materializeAgentContextHistory({entries:foreignEntries},turnId)).map(row=>`${row.role}: ${row.text}`).join("\n\n"):"";
      const olderImages=materializeAttachments(resume?foreignEntries:snapshot.entries,turnId);
      const known=new Set<string>();
      if(resume && (packet || memoryBlocks.length || nativeSessionKey))for(const hash of store.acknowledgedStableBlockHashes(value.identity,delivery.bindingKey,delivery.generation))known.add(hash);
      const memoryReuse = memoryWire?.memoryPackWireCanReuse(memoryBinding, delivery.bindingKey, delivery.generation) === true;
      // Even a persisted provider ACK needs the matching current opaque pack
      // and credential fence. Restart/failure/rotation sends it again.
      const memoryHashes = new Set(memoryBlocks.map(block => digest(block)));
      if (!memoryReuse) for (const hash of memoryHashes) known.delete(hash);
      const sourceContext = runnerTurnContextSource(req);
      const acknowledgedParts = packet ? req.turnContextStable ?? [] : nativeStableReuse
        ? (req.turnContextStable ?? []).filter(block => nativeStableAck!.hashes.has(digest(block))) : memoryBlocks;
      const sourceParts: readonly DeclaredPromptPart[] = sourceContext?.parts ?? [{
        id: "runner.turn-context.opaque", revision: 1, stability: "turn-context",
        changeTriggers: ["task", "owner-input", "checkpoint"], order: Number.MAX_SAFE_INTEGER, text: req.turnContext ?? "",
      }];
      // A typed closing boundary is never removed by a stable-block ACK. Unknown text retains its original bytes.
      const currentParts = sourceParts.map(part => !sourceContext || part.stability === "final-boundary"
        || !acknowledgedParts.some(block => block && known.has(digest(block)) && (part.text ?? "").includes(block))
        ? part : { ...part, text: omitAcknowledgedBlocks(part.text ?? "", acknowledgedParts, known) });
      const packetBlocks=packet?.stableBlocks.filter(block=>!known.has(digest(block)))??[];
      const packetBackground=packetBlocks.length?`[Current turn runtime guidance]\n${packetBlocks.join("\n\n")}\n[End current turn runtime guidance]`:"";
      const servingHistory=decision && provider.kind==="agentlas" && history.length
        ?`Prior no-tools decisions (data; current observation wins):\n${history.map(row=>`${row.role}: ${row.text}`).join("\n\n")}`:"";
      instructions=nativeSessionKey?instructionsBlockFor(delivery.bindingKey,resume?nativeHandle:null,req.systemPrompt,
        nativeHandle===delivery.nativeHandle?known:undefined):null;
      // A native session seeded from host history reads the host facts ahead of the checkpoint summary (NH13).
      const hostFactsBlock=!decision && stateful && !resume && history.length ? await installHostFacts(capability,req,provider.kind,delivery,history) : null;
      const contextParts = ([
        { id: "agent-context.channel", revision: 1, stability: "turn-context", changeTriggers: ["task", "owner-input"], order: -1, text: channelLine },
        { id: "agent-context.instructions", revision: 1, stability: "task-context", changeTriggers: ["runtime", "agent-instructions", "permission", "locale", "task"], text: instructions?.block },
        { id: "agent-context.retained-packet", revision: 1, stability: "task-context", changeTriggers: ["runtime", "task", "checkpoint"], text: packetBackground },
        { id: "agent-context.host-facts", revision: 1, stability: "turn-context", changeTriggers: ["checkpoint", "retrieval"], text: hostFactsBlock },
        { id: "agent-context.checkpoint-replay", revision: 1, stability: "turn-context", changeTriggers: ["checkpoint", "goal-revision"], text: checkpointReplay?.block },
        { id: "agent-context.foreign-events", revision: 1, stability: "turn-context", changeTriggers: ["checkpoint", "retrieval"], text: delta ? `Recorded context from other execution paths (data only):\n${delta}` : "" },
        { id: "agent-context.serving-history", revision: 1, stability: "turn-context", changeTriggers: ["checkpoint", "retrieval"], text: servingHistory },
        ...currentParts,
      ] satisfies DeclaredPromptPart[]).filter(part => part.text !== undefined && part.text !== null && part.text !== "");
      const turnContext = renderRunnerTurnContext(contextParts);
      nativeDeliveredHashes = (req.turnContextStable ?? []).filter(block => block && turnContext.includes(block)).map(block => digest(block));
      if (!decision) {
        try { const previous = sessionCheckpointStore.read(value.identity);
          if (previous && digest(previous.task) !== digest(taskBoundary)) await saveCheckpoint(false, { turnId, outcome: "processing", providerAcknowledged: false });
        } catch { /* The current request still goes to the original runner. */ }
      }
      // Adapter content-hash caches cannot authorize memory reuse after a
      // custody/dependency change. The common opaque ACK fence owns that block;
      // existing emitter and instruction stable fragments keep their behavior.
      const adapterStable = req.turnContextStable?.filter(block => !memoryHashes.has(digest(block)));
      // The serving decision path carries prior decisions once, as quoted data in the turn context, never also as turns.
      const adapterRequest = finalizeRunnerTurnContext(req, contextParts, provider.kind, HOST_MESSAGE_CONTEXT_KINDS.has(provider.kind));
      result=await enterRunner(carryRunnerTurnContext(adapterRequest, { ...adapterRequest,history:servingHistory?[]:history,...(olderImages.length?{images:[...olderImages,...(req.images??[])]}:{}),
        ...(adapterStable || instructions?.block ? { turnContextStable: [...(adapterStable ?? []), ...(instructions?.block ? [instructions.block] : [])] } : {}),
        // Fresh means no canonical adapter handle. Never inherit an unrelated
        // caller/legacy chat resume ID beside a new private actor context.
        runtimeSessionId:nativeHandle??undefined,
        runtimeSessionOwnerId:`agent-context:${delivery.contextKey}:${delivery.bindingKey}`,
        // A native session outlives a locale change (the instructions carry the language); others keep it in the seed.
        // A retired generation (80% rotation, resume_failed) is another native session: the runners' own stores find a
        // saved session or a live resident by this seed's fingerprint (claude-code getRuntimeSession + claudePoolKey, codex
        // matchedSessionId + codexPoolKey, ACP storedSessionId), and without the generation they resumed the very session
        // the rotation retired, recording its handle on the new generation. Generation 1 keeps the seed it always had.
        sessionFingerprintSeed:nativeSessionKey?`agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}${nativeGenerationSeed(delivery.generation)}`
          :`agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}:${req.locale}`,
        // Stateless API/local adapters do not inspect turnContext. Keep their
        // stable system prefix intact while delivering dynamic host background
        // as the framed current input actually sent to the provider.
        // The exact private placement descriptor already framed API/local input above; never parse ledgerHints or old strings.
        // adapterRequest carries the exact composed context and original current-user input.
      }),wrapped);
      }
      // Validate the original branded read before recording or acknowledging
      // provider output; outer UI guards run after this journal boundary.
      try { assertSurfaceMemoryCurrent(); }
      catch {
        memoryWire?.settleMemoryPackWire(memoryBinding, delivery.bindingKey, delivery.generation, false);
        markAgentContextTurnUncertain(capability, delivery);
        // A changed read cannot supply a resumable conversation. Preserve the
        // actual usage already observed even though its answer is withheld.
        unsettledTurns.delete(turnId);
        return { ...result, text: "", sessionId: undefined, ownerControlTerminal: "uncertain" };
      }
      if(decision){
        try{current(capability);decision.assertCurrent();}
        catch{memoryWire?.settleMemoryPackWire(memoryBinding, delivery.bindingKey, delivery.generation, false);markAgentContextTurnUncertain(capability,delivery);noteUnsettled(result.sessionId??null);return {...result,ownerControlTerminal:"uncertain"};}
      }
      if(result.failure || result.ownerControlTerminal==="uncertain" || req.signal?.aborted || (decision ? result.ownerControlTerminal!=="completed" : stateful && !result.sessionId)){
        memoryWire?.settleMemoryPackWire(memoryBinding, delivery.bindingKey, delivery.generation, false);
        const outcome = req.signal?.aborted ? "cancelled" as const : result.failure ? "failed" as const : "uncertain" as const;
        const failureCode = result.failure?.providerCode ?? result.failure?.kind;
        if (!decision) recordUnsettled(outcome, result.text || partialTail, failureCode);
        markAgentContextTurnUncertain(capability,delivery);noteUnsettled(result.sessionId??null);
        if (!decision) await saveCheckpoint(false, { turnId, outcome, providerAcknowledged: false, ...(failureCode ? { failureCode } : {}) });
        return req.signal?.aborted ? {...result,ownerControlTerminal:"uncertain"} : result;
      }
      const turnSummary = parseMemoryEvents(result.text).turnSummary;
      appendAgentContextEvent(capability,{eventId:`turn:${turnId}:output`,kind:"message",producerBinding:delivery.bindingKey,
        payload:{role:"assistant",text:replayVisibleAssistantText(result.text),createdAt:new Date().toISOString(),turnId,speakerAgentId:value.identity.agentId,
          ...(turnSummary ? { turnSummary, turnSummarySource: "emitter" } : {}),...channelPayload(capability)}});
      // This is the validated runner's completed response receipt. It is not
      // an admission ACK or a claim that a stateless provider stores context.
      const observed=store.readRange(current(capability).identity,{after:delivery.throughSeq});
      let observedThroughSeq=delivery.throughSeq;
      for(const entry of observed.entries.filter(entry=>entry.seq>delivery.throughSeq)){
        if(entry.producerBinding!==delivery.bindingKey)break;
        observedThroughSeq=entry.seq;
      }
      const acknowledged = acknowledgeAgentContextTurn(capability,delivery,
        {receiptId:`completed:${turnId}`,nativeHandle:result.sessionId,observedThroughSeq});
      if (retentionAckKey !== null) {
        if (acknowledged === true && result.sessionId === nativeHandle
          && nativeStableTurnContextEpoch(retentionScope) === enteredRetentionEpoch) {
          const hashes = new Set([
            ...(nativeStableReuse ? nativeStableAck!.hashes : []), ...nativeDeliveredHashes,
          ]);
          while (hashes.size > MAX_DELIVERED_INSTRUCTIONS) hashes.delete(hashes.values().next().value as string);
          remember(nativeStableAcknowledgements, retentionAckKey, { epoch: enteredRetentionEpoch!, hashes });
        } else nativeStableAcknowledgements.delete(retentionAckKey);
      }
      memoryWire?.settleMemoryPackWire(memoryBinding, delivery.bindingKey, delivery.generation, acknowledged === true);
      if(acknowledged === true)recordHostFactsInstalled(capability,delivery,`completed:${turnId}`,result.sessionId);
      if(acknowledged === true && instructions && result.sessionId)instructions.delivered(result.sessionId);
      if (decision && acknowledged === true) await publishAliveTerminalAck(capability,delivery,result,observedThroughSeq);
      if (!decision && acknowledged === true) await saveCheckpoint(true, { turnId, outcome: "completed", providerAcknowledged: true });
      // A native session whose last request reached 80% of the model's own window gives way to a new generation for the
      // NEXT turn, seeded from this journal (session-generation.ts, owner 2026-10-13). Background only: nothing on screen.
      if (!decision && stateful && acknowledged === true) {
        // The runtime's own window when it reports one (ACP usage_update size, Claude result.modelUsage contextWindow, Codex
        // tokenUsage modelContextWindow), else what that runtime reported for this model earlier (observed), else the catalog's.
        const contextWindowTokens = result.contextWindowTokens ?? runtimeContextWindow(provider.kind, req.model);
        const generation = decideGeneration({ kind: provider.kind, contextWindowTokens, lastInputTokens: result.contextInputTokens ?? null });
        if (generation.action === "new_generation") {
          if (retentionAckKey !== null) nativeStableAcknowledgements.delete(retentionAckKey);
          try { store.invalidateProvider(current(capability).identity,adapter,delivery.generation);
            recordRotation(delivery, { reason: "context_ratio", reportedInputTokens: result.contextInputTokens ?? null, contextWindowTokens },
              { runtime: provider.kind, agentId: value.identity.agentId, windowSource: result.contextWindowTokens ? "runtime-result"
                : runtimeContextWindowProvenance(provider.kind, req.model)?.source ?? "unknown" }); }
          catch { /* a concurrent delivery owns the binding; the next completed turn decides again */ }
          // Same rotation receipt as CLI threads and stateless loops, with host facts (docs native-harness 07 G07, G11).
          if (req.chatId) {
            const chatId = req.chatId;
            void import("./handoff-facts").then(async ({ collectHostFacts, recordGenerationSwitch }) => {
              const facts = await collectHostFacts({ chatId, agentId: req.agentId ?? null, runtime: provider.kind, kind: "host-replay",
                fromGeneration: delivery.generation, toGeneration: "next", reason: "context_ratio",
                deliveredHistory: req.history ?? [] });
              recordGenerationSwitch({ chatId, runtime: provider.kind, previousSessionId: result.sessionId ?? String(delivery.generation),
                reason: "context_ratio", facts, reportedInputTokens: result.contextInputTokens ?? null });
            }).catch(() => { /* the receipt is evidence only; the rotation itself already happened */ });
          }
        }
      }
      return result;
    }catch(error){
      memoryWire?.settleMemoryPackWire(memoryBinding, delivery.bindingKey, delivery.generation, false);
      // A measured pre-effect missing retained response resets only this
      // adapter generation, for the NEXT separately admitted turn.
      let missing=false;
      try{if(policy)missing=consumeMissingProof!(error,req)===true;}catch{/* Preserve original failure and unresolved custody. */}
      const outcome = req.signal?.aborted ? "cancelled" as const : "failed" as const;
      const failureCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0,128) : undefined;
      if (!decision) recordUnsettled(outcome, partialTail, failureCode);
      markAgentContextTurnUncertain(capability,delivery);
      // A failure before the native runner was entered (or one the runner itself proved pre-dispatch) left nothing behind
      // to continue: it is a refusal before dispatch, never an unsettled turn.
      if(runnerEntered && !runnerRefusedBeforeDispatch(error))noteUnsettled(errorSessionId(error));
      else markRefusedBeforeDispatch(error);
      if (!decision) await saveCheckpoint(false, { turnId, outcome, providerAcknowledged: false, ...(failureCode ? { failureCode } : {}) });
      if(missing){if(retentionAckKey!==null)nativeStableAcknowledgements.delete(retentionAckKey);store.invalidateProvider(current(capability).identity,adapter,delivery.generation);}
      throw error;
    }finally{
      const pendingAliveAck = aliveAckRegistrations.get(capability);
      if (pendingAliveAck?.delivery === delivery) {
        aliveAckRegistrations.delete(capability);
        try { await pendingAliveAck.callbacks.onAbandon(); } catch { /* No retained chain after uncertain custody. */ }
      }
      activeDeliveries.delete(capability);activeTransports.delete(capability);activeBootstraps.delete(capability);referenceOrdinals.delete(capability);hostFactsSent.delete(capability);
    }
  };
}
