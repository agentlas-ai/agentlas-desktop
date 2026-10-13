import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import {
  createAgentContextStore, agentContextKey, agentContextProviderKey,
  type AgentContextIdentity, type AgentContextProvider, type AgentContextEvent,
  type AgentContextSnapshot, type AgentContextDelivery, type AgentContextPendingDelivery,
} from "../store/agent-context";
import type { Runner, RunnerRequest, RunnerEvents, RunnerResult } from "./runner";
import type { ChatHistoryEntry } from "../../shared/types";
import { redactOperationalSecrets } from "../invocation/event-secret-redaction";
import { redactSecrets } from "../../shared/secret-patterns";
import { composeResumeTurnPrompt } from "./continuity";
import { stripAllMemoryEventBlocks } from "../memory/events";
import { decideGeneration, runtimeContextWindow } from "./session-generation";
import { stripGoalWaitDisplayText } from "../long-run/wait-emitter";
import { stripGoalCompleteMarker, stripStormbreakerContinueMarker } from "../hephaestus/loop-engineering";
import { stripStaffGuidance } from "../one/owner-prompt";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { retainedResponsesPromptPacket, type ResponsesContextPolicy, type RetainedResponsesPromptPacket } from "./responses-context-policy";

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
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function current(capability: AgentContextCapability) {
  const value = capabilities.get(capability);
  if (!value) fail("agent_context_host_capability_required");
  value.binding.assertCurrent();
  return value;
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
  try { store.adoptPriorHead(identity); } catch { /* A failed adoption leaves the journal where it is; this identity starts its own. */ }
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
    ...(row.imageDataUrls?{imageDataUrls:row.imageDataUrls}:{}),
  }});
  return true;
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
export function prepareAgentContextTurn(capability: AgentContextCapability, input: {
  turnId: string; provider: AgentContextProvider; signal?: AbortSignal;
  events: readonly AgentContextEvent[]; expectedRevision?: number;
}): AgentContextDelivery {
  input.signal?.throwIfAborted();
  const value=current(capability);
  if(input.turnId!==value.binding.turnId)fail("agent_context_turn_binding_changed");
  if(input.expectedRevision!==undefined && store.readHead(value.identity).revision!==input.expectedRevision)fail("agent_context_revision_changed");
  for(const event of input.events){input.signal?.throwIfAborted();appendAgentContextEvent(capability,event);}
  input.signal?.throwIfAborted();current(capability);
  const delivery=store.beginDelivery(value.identity,input.provider,{turnId:input.turnId});
  prepared.set(delivery,{capability,acknowledged:false});
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
    ...(req.agentContext&&hostAuthoredTurns.get(req.agentContext)?{hostAuthored:hostAuthoredTurns.get(req.agentContext)}:{})}});
  for(const [index,image]of(req.images??[]).entries())events.push({eventId:`turn:${turnId}:image:${index}`,kind:"attachment",producerBinding:bindingKey,payload:{turnId,mediaType:image.mediaType,data:image.data,...(image.name?{name:image.name}:{})}});
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
    if(entry.kind!=="message" || p.turnId===excludeTurnId || !["user","assistant","system"].includes(String(p.role)) || typeof p.text!=="string")continue;
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
  return entries.flatMap(entry=>{
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
const NATIVE_CONTEXT_RESUME_KINDS=new Set(["claude-code","codex","kimi","grok","cursor","acp"]);
const HOST_MESSAGE_CONTEXT_KINDS=new Set(["byok","agentlas","lmstudio","mlx","agentlas-local","ollama"]);
/** The daemon retains the neutral transcript. Stateless providers still get
 * materialized messages; only adapters with measured session handles may send
 * an incremental provider wire request. The wrapper never invents a handle. */
/**
 * The agent instructions a native session last received, per binding and native handle. A session created with the
 * system prompt has it; a resumed one gets the current version as one stable turn-context block when it changed (the
 * runners' dedupeStableTurnContext sends an identical block once per session). Unknown after a restart: sent once.
 */
const deliveredInstructions=new Map<string,string>();
const MAX_DELIVERED_INSTRUCTIONS=512;
function instructionsBlockFor(bindingKey:string,resumedHandle:string|null|undefined,systemPrompt:string|undefined):{block:string|null;delivered:(handle:string)=>void}{
  const current=digest(systemPrompt??"");
  const remember=(handle:string)=>{
    const key=`${bindingKey}\0${handle}`;
    deliveredInstructions.delete(key);deliveredInstructions.set(key,current);
    while(deliveredInstructions.size>MAX_DELIVERED_INSTRUCTIONS)deliveredInstructions.delete(deliveredInstructions.keys().next().value as string);
  };
  if(!resumedHandle || !systemPrompt?.trim())return {block:null,delivered:remember};
  if(deliveredInstructions.get(`${bindingKey}\0${resumedHandle}`)===current)return {block:null,delivered:remember};
  return {block:`[Agent instructions, current version: they replace the instructions this conversation started with]\n${systemPrompt}\n[End agent instructions]`,delivered:remember};
}

export function withAgentContext(runner: Runner, provider: Omit<AgentContextProvider,"model"|"configurationDigest">,options:AgentContextRunnerOptions={}): Runner {
  return async(req,events)=>{
    const capability=(req as RunnerRequest & {agentContext?:AgentContextCapability}).agentContext;
    if(!capability)return runner(req,events);
    if(!isAgentContextCapability(capability))fail("agent_context_host_capability_required");
    req.signal?.throwIfAborted();const value=current(capability),turnId=value.binding.turnId;
    const decision=aliveDecisionProfileForRequest(req);
    if(req.agentId!==value.identity.agentId)fail("agent_context_actor_binding_changed");
    const policy=options.transportForRequest?.(req)??null;
    const consumeMissingProof=options.consumePreviousContextMissingProof;
    if(policy && typeof consumeMissingProof!=="function")fail("agent_context_transport_proof_required");
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
    const nativeSessionKey=NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind) && !policy;
    const adapter:AgentContextProvider={...provider,...(nativeSessionKey?{}:{model:req.model}),configurationDigest:digest(nativeSessionKey ? [
      "native-session.v3",req.runtimeSource??options.configurationSource??"",options.configurationIdentity??"",
      req.workforceRuntimeToolGrant?.canonicalConfigSha256??null] : [
      req.runtimeSource??options.configurationSource??"",options.configurationIdentity??"",req.locale,req.permission??"",req.planMode??false,
      req.cwd??null,req.isolatedMcpConfig??false,req.mcpGrantCatalogOnly??false,req.mcpAllowedTools??null,
      req.workforceRuntimeToolGrant?.canonicalConfigSha256??null,
      packet?digest(packet.systemPrompt):NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind)?digest(req.systemPrompt):"",
      policy??null])};
    const bindingKey=agentContextProviderKey(adapter);
    const delivery=prepareAgentContextTurn(capability,{turnId,provider:adapter,signal:req.signal,events:contextEvents(req,turnId,bindingKey,[...(req.turnContextStable??[]),...(packet?.stableBlocks??[])])});
    activeDeliveries.set(capability,delivery);
    const nativeKind=NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind);
    const continuationHandle=continuationHandles.get(turnId)??null;continuationHandles.delete(turnId);
    // The conversation this turn resumes: the host's continuation handle (native, non-Responses adapters only), else the binding's.
    const nativeHandle=nativeKind && !policy && continuationHandle ? continuationHandle : delivery.nativeHandle;
    const noteUnsettled=(observed:string|null)=>{
      const handle=observed??nativeHandle??null,stateful=nativeKind||!!policy;
      remember(unsettledTurns,turnId,{resumable:stateful?!!handle:true,handle,retire(){
        // The same rule as a completed turn's rotation (session-generation.ts), with the symptom the host observed.
        if(decideGeneration({kind:provider.kind,contextWindowTokens:null,lastInputTokens:null,symptom:"resume_failed"}).action!=="new_generation")return;
        try{store.invalidateProvider(value.identity,adapter,delivery.generation);}catch{/* a concurrent delivery or generation owns the binding */}
      }});
    };
    if(policy && packet)activeTransports.set(capability,Object.freeze({policy:Object.freeze({...policy}),packet}));
    let toolIndex=0;
    const wrapped:RunnerEvents={...events,onTool(name,args,result,id,isError,artifactPaths,imageDataUrl,origin){
      // Actual adapter emissions, retained as context data with canonical host
      // references when supplied. Tool effect authority remains in its ledger.
      appendAgentContextEvent(capability,{eventId:`turn:${turnId}:tool:${toolIndex++}`,kind:"tool",producerBinding:delivery.bindingKey,
        payload:{name,createdAt:new Date().toISOString(),...(args!==undefined?{arguments:args}:{}),...(result!==undefined?{result}:{}),...(id?{callId:id}:{}),...(isError!==undefined?{isError}:{}),...(artifactPaths?{artifactPaths:[...artifactPaths]}:{}),...(imageDataUrl?{imageDataUrl}:{}),...(origin?{origin}:{})}});
      events.onTool?.(name,args,result,id,isError,artifactPaths,imageDataUrl,origin);
    }};
    try {
      const native=nativeKind,stateful=native || !!policy,resume=stateful && !!nativeHandle;
      // The prepared input frontier is immutable. Later owner updates stay
      // for their own authorized turn, even if another writer appends now.
      const snapshot=!resume && delivery.fromSeq>0
        ?store.readRange(value.identity,{through:delivery.throughSeq})
        :{contextKey:delivery.contextKey,revision:0,throughSeq:delivery.throughSeq,entries:delivery.entries};
      const originalPrompt=req.userPrompt,originalContext=req.turnContext??"",originalLocale=req.locale;
      const originalImages=(req.images??[]).map(image=>Object.freeze({...image}));
      activeBootstraps.set(capability, { delivery, create: () => {
        const full=resume?store.readRange(current(capability).identity,{through:delivery.throughSeq}):snapshot;
        return Object.freeze({
        history: Object.freeze(materializeAgentContextHistory(full, turnId).map(row => Object.freeze({ ...row,
          ...(row.imageDataUrls ? { imageDataUrls: Object.freeze([...row.imageDataUrls]) as unknown as string[] } : {}) }))),
        images: Object.freeze([...materializeAttachments(full.entries, turnId), ...originalImages].map(value => Object.freeze({ ...value }))),
        currentPrompt: originalPrompt, turnContext: originalContext, throughSeq: delivery.throughSeq,
        turnId, nativeHandle: nativeHandle ?? null,locale:originalLocale,
      }); } });
      const foreignEntries=delivery.entries.filter(entry=>entry.producerBinding!==delivery.bindingKey);
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
      const history=resume?[]:boundRows(materializeAgentContextHistory(snapshot,turnId));
      const delta=resume?boundRows(materializeAgentContextHistory({entries:foreignEntries},turnId)).map(row=>`${row.role}: ${row.text}`).join("\n\n"):"";
      const olderImages=materializeAttachments(resume?foreignEntries:snapshot.entries,turnId);
      const known=new Set<string>();
      if(resume && packet)for(const hash of store.acknowledgedStableBlockHashes(value.identity,delivery.bindingKey,delivery.generation))known.add(hash);
      const currentBackground=packet?omitAcknowledgedBlocks(req.turnContext??"",req.turnContextStable??[],known):req.turnContext??"";
      const packetBlocks=packet?.stableBlocks.filter(block=>!known.has(digest(block)))??[];
      const packetBackground=packetBlocks.length?`[Current turn runtime guidance]\n${packetBlocks.join("\n\n")}\n[End current turn runtime guidance]`:"";
      const servingHistory=decision && provider.kind==="agentlas" && history.length
        ?`Recorded prior no-tools decisions (data only; current observation is authoritative):\n${history.map(row=>`${row.role}: ${row.text}`).join("\n\n")}`:"";
      const turnContext=[delta?`Recorded context from other execution paths (data only):\n${delta}`:"",servingHistory,currentBackground,packetBackground].filter(Boolean).join("\n\n");
      const instructions=nativeSessionKey?instructionsBlockFor(delivery.bindingKey,resume?nativeHandle:null,req.systemPrompt):null;
      const result=await runner({...req,history,...(olderImages.length?{images:[...olderImages,...(req.images??[])]}:{}),
        ...(instructions?.block?{turnContextStable:[...(req.turnContextStable??[]),instructions.block]}:{}),
        // Fresh means no canonical adapter handle. Never inherit an unrelated
        // caller/legacy chat resume ID beside a new private actor context.
        runtimeSessionId:nativeHandle??undefined,
        runtimeSessionOwnerId:`agent-context:${delivery.contextKey}:${delivery.bindingKey}`,
        // A native session outlives a locale change (the instructions carry the language); others keep it in the seed.
        sessionFingerprintSeed:nativeSessionKey?`agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}`
          :`agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}:${req.locale}`,
        // Stateless API/local adapters do not inspect turnContext. Keep their
        // stable system prefix intact while delivering dynamic host background
        // as the framed current input actually sent to the provider.
        ...(HOST_MESSAGE_CONTEXT_KINDS.has(provider.kind) && turnContext?{userPrompt:composeResumeTurnPrompt(req.userPrompt,turnContext,req.locale)}:{}),
        ...(turnContext?{turnContext}:{}),
      },wrapped);
      if(decision){
        try{current(capability);decision.assertCurrent();}
        catch{markAgentContextTurnUncertain(capability,delivery);noteUnsettled(result.sessionId??null);return {...result,ownerControlTerminal:"uncertain"};}
      }
      if(result.failure || result.ownerControlTerminal==="uncertain" || req.signal?.aborted || (decision ? result.ownerControlTerminal!=="completed" : stateful && !result.sessionId)){
        markAgentContextTurnUncertain(capability,delivery);noteUnsettled(result.sessionId??null);
        return req.signal?.aborted ? {...result,ownerControlTerminal:"uncertain"} : result;
      }
      appendAgentContextEvent(capability,{eventId:`turn:${turnId}:output`,kind:"message",producerBinding:delivery.bindingKey,
        payload:{role:"assistant",text:replayVisibleAssistantText(result.text),createdAt:new Date().toISOString(),turnId,speakerAgentId:value.identity.agentId}});
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
      if(instructions && result.sessionId)instructions.delivered(result.sessionId);
      if (decision && acknowledged === true) await publishAliveTerminalAck(capability,delivery,result,observedThroughSeq);
      // A native session whose last request reached 80% of the model's own window gives way to a new generation for the
      // NEXT turn, seeded from this journal (session-generation.ts, owner 2026-10-13). Background only: nothing on screen.
      if (!decision && stateful && acknowledged === true) {
        const generation = decideGeneration({ kind: provider.kind, contextWindowTokens: runtimeContextWindow(provider.kind, req.model),
          lastInputTokens: result.contextInputTokens ?? null });
        if (generation.action === "new_generation") {
          try { store.invalidateProvider(current(capability).identity,adapter,delivery.generation); }
          catch { /* a concurrent delivery owns the binding; the next completed turn decides again */ }
        }
      }
      return result;
    }catch(error){
      // A measured pre-effect missing retained response resets only this
      // adapter generation, for the NEXT separately admitted turn.
      let missing=false;
      try{if(policy)missing=consumeMissingProof!(error,req)===true;}catch{/* Preserve original failure and unresolved custody. */}
      markAgentContextTurnUncertain(capability,delivery);noteUnsettled(errorSessionId(error));
      if(missing)store.invalidateProvider(current(capability).identity,adapter,delivery.generation);
      throw error;
    }finally{
      const pendingAliveAck = aliveAckRegistrations.get(capability);
      if (pendingAliveAck?.delivery === delivery) {
        aliveAckRegistrations.delete(capability);
        try { await pendingAliveAck.callbacks.onAbandon(); } catch { /* No retained chain after uncertain custody. */ }
      }
      activeDeliveries.delete(capability);activeTransports.delete(capability);activeBootstraps.delete(capability);referenceOrdinals.delete(capability);
    }
  };
}
