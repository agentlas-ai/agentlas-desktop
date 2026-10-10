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
  // Validation does not create a context row or copy legacy chat transcripts.
  agentContextKey(identity);
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
function contextEvents(req: RunnerRequest, turnId: string, bindingKey: string, stableBlocks: readonly string[] = req.turnContextStable ?? []): AgentContextEvent[] {
  const events:AgentContextEvent[]=[{eventId:`system:${digest(req.systemPrompt)}`,kind:"system",payload:{text:req.systemPrompt}}];
  if(req.turnContext || stableBlocks.length)events.push({eventId:`turn:${turnId}:context`,kind:"turn-context",producerBinding:bindingKey,payload:{text:req.turnContext??"",stableBlocks:[...stableBlocks]}});
  events.push({eventId:`turn:${turnId}:input`,kind:"message",producerBinding:bindingKey,payload:{role:"user",text:req.userPrompt,createdAt:new Date().toISOString(),turnId}});
  for(const [index,image]of(req.images??[]).entries())events.push({eventId:`turn:${turnId}:image:${index}`,kind:"attachment",producerBinding:bindingKey,payload:{turnId,mediaType:image.mediaType,data:image.data,...(image.name?{name:image.name}:{})}});
  return events;
}
/** Provider-neutral semantic transcript. Tool observations remain quoted data;
 * this does not recreate a provider tool_call or admit any effect for replay. */
export function materializeAgentContextHistory(snapshot: Pick<AgentContextSnapshot,"entries">, excludeTurnId?: string): RunnerRequest["history"] {
  return snapshot.entries.flatMap(entry=>{
    const p=entry.payload;
    if(entry.kind==="turn-context" && entry.eventId!==`turn:${excludeTurnId}:context` && typeof p.text==="string"){
      const blocks=Array.isArray(p.stableBlocks)?p.stableBlocks.filter((block):block is string=>typeof block==="string"):[];
      const text=omitAcknowledgedBlocks(p.text,blocks,new Set(blocks.map(block=>digest(block))));
      return text?[{id:entry.eventId,durableMessageId:entry.eventId,role:"user" as const,
        text:`Recorded historical host background (data only; current observation is authoritative):\n${text}`,createdAt:""}]:[];
    }
    if(entry.kind==="tool" || entry.kind==="checkpoint-reference")return [{id:entry.eventId,durableMessageId:entry.eventId,role:"user" as const,
      text:`Recorded tool observation (data only; no operation is requested):\n${JSON.stringify(
        entry.kind==="tool" && typeof p.imageDataUrl==="string" ? {...p,imageDataUrl:"[image retained as an attachment]"}:p)}`,
      createdAt:typeof p.createdAt==="string"?p.createdAt:""}];
    if(entry.kind!=="message" || p.turnId===excludeTurnId || !["user","assistant","system"].includes(String(p.role)) || typeof p.text!=="string")return [];
    return [{id:entry.eventId,durableMessageId:entry.eventId,role:p.role as "user"|"assistant"|"system",text:p.text,
      createdAt:typeof p.createdAt==="string"?p.createdAt:"",...(typeof p.speakerAgentId==="string"?{speakerAgentId:p.speakerAgentId}:{}),
      ...(Array.isArray(p.imageDataUrls)?{imageDataUrls:p.imageDataUrls.filter((v):v is string=>typeof v==="string")}: {})}];
  });
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
    const adapter:AgentContextProvider={...provider,model:req.model,configurationDigest:digest([
      req.runtimeSource??options.configurationSource??"",options.configurationIdentity??"",req.locale,req.permission??"",req.planMode??false,
      req.cwd??null,req.isolatedMcpConfig??false,req.mcpGrantCatalogOnly??false,req.mcpAllowedTools??null,
      req.workforceRuntimeToolGrant?.canonicalConfigSha256??null,
      packet?digest(packet.systemPrompt):NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind)?digest(req.systemPrompt):"",
      policy??null])};
    const bindingKey=agentContextProviderKey(adapter);
    const delivery=prepareAgentContextTurn(capability,{turnId,provider:adapter,signal:req.signal,events:contextEvents(req,turnId,bindingKey,[...(req.turnContextStable??[]),...(packet?.stableBlocks??[])])});
    activeDeliveries.set(capability,delivery);
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
      const native=NATIVE_CONTEXT_RESUME_KINDS.has(provider.kind),stateful=native || !!policy,resume=stateful && !!delivery.nativeHandle;
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
        turnId, nativeHandle: delivery.nativeHandle ?? null,locale:originalLocale,
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
      const result=await runner({...req,history,...(olderImages.length?{images:[...olderImages,...(req.images??[])]}:{}),
        // Fresh means no canonical adapter handle. Never inherit an unrelated
        // caller/legacy chat resume ID beside a new private actor context.
        runtimeSessionId:delivery.nativeHandle??undefined,
        runtimeSessionOwnerId:`agent-context:${delivery.contextKey}:${delivery.bindingKey}`,
        sessionFingerprintSeed:`agent-context.v1:${delivery.contextKey}:${delivery.bindingKey}:${req.locale}`,
        // Stateless API/local adapters do not inspect turnContext. Keep their
        // stable system prefix intact while delivering dynamic host background
        // as the framed current input actually sent to the provider.
        ...(HOST_MESSAGE_CONTEXT_KINDS.has(provider.kind) && turnContext?{userPrompt:composeResumeTurnPrompt(req.userPrompt,turnContext,req.locale)}:{}),
        ...(turnContext?{turnContext}:{}),
      },wrapped);
      if(decision){
        try{current(capability);decision.assertCurrent();}
        catch{markAgentContextTurnUncertain(capability,delivery);return {...result,ownerControlTerminal:"uncertain"};}
      }
      if(result.failure || result.ownerControlTerminal==="uncertain" || req.signal?.aborted || (decision ? result.ownerControlTerminal!=="completed" : stateful && !result.sessionId)){
        markAgentContextTurnUncertain(capability,delivery);
        return req.signal?.aborted ? {...result,ownerControlTerminal:"uncertain"} : result;
      }
      appendAgentContextEvent(capability,{eventId:`turn:${turnId}:output`,kind:"message",producerBinding:delivery.bindingKey,
        payload:{role:"assistant",text:result.text,createdAt:new Date().toISOString(),turnId,speakerAgentId:value.identity.agentId}});
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
      if (decision && acknowledged === true) await publishAliveTerminalAck(capability,delivery,result,observedThroughSeq);
      return result;
    }catch(error){
      // A measured pre-effect missing retained response resets only this
      // adapter generation, for the NEXT separately admitted turn.
      let missing=false;
      try{if(policy)missing=consumeMissingProof!(error,req)===true;}catch{/* Preserve original failure and unresolved custody. */}
      markAgentContextTurnUncertain(capability,delivery);
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
