import { createHash } from "node:crypto";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import { ONE_PREFLIGHT_STEER_REQUEST_KEYS } from "../../shared/one-preflight-steers";
import { onePreflightSteerTemplate } from "../store/one-preflight-steers";
import type { McpInvocationRequest } from "../../shared/types";
import { canonicalInvocationRequestJson, createInvocationAdmission, getInvocationAdmission, INVOCATION_ADMISSION_DIGEST_VERSION, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { admitMainInvocation, type MainInvocationAdmission } from "../runtime/scheduled-root-context";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import type { NativeStartDescriptor } from "../daemon/native-start-protocol";
import type { InvocationStartResult } from "./service";
import type { createNativeMainPreparationRouter, NativeMainPreparationRouterHandle } from "./native-main-preparation-router";
import type { createNativeMainAuthCallbackAdapter } from "./native-main-auth-callback";

type Channel = object & { dispatch(method: string, params: unknown): Promise<unknown>; onClose(listener: () => void): () => void };
type Router = ReturnType<typeof createNativeMainPreparationRouter>;
type Callbacks = ReturnType<typeof createNativeMainAuthCallbackAdapter>;
type StopResult = "requested" | "already-requested" | "not-found";
const ownerBootstraps = new WeakMap<object, { channel: Channel; identity: NativeAuthenticatedIdentity; callbacks: Callbacks }>();
export function assertNativeGuiOwnerBootstrap(owner: object, callbacks: Callbacks, channel: object, identity: NativeAuthenticatedIdentity): void {
  const registered = ownerBootstraps.get(owner);
  if (!registered || registered.channel !== channel || registered.identity !== identity || registered.callbacks !== callbacks
    || nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_owner_bootstrap_required");
}
interface Capture {
  readonly channel: Channel; readonly identity: NativeAuthenticatedIdentity;
  readonly originalRequest: McpInvocationRequest; readonly start: NativeStartDescriptor; readonly privateHandle: NativeMainPreparationRouterHandle;
  transportStart?: Promise<unknown>; actualStart: Promise<InvocationStartResult>; cancellation?: Promise<StopResult>; unavailable: boolean;
}
export class NativeGuiOwnerError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new NativeGuiOwnerError(code); }
function rowDigest(admission: InvocationAdmissionIdentity): string { return createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(admission.canonicalRequestJson).digest("hex"); }
function thenable(value: unknown): boolean { return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function"; }
/** Main bootstrap only. The guard and sanitizer are adapters to the ORIGINAL
 * IPC producer, including explicit AppControl/mobile/MCP denial; they must be
 * synchronous and must never accept a wire/native boolean as authority. */
export function createNativeGuiOwnerClient(ports: {
  getChannel(): Channel | undefined;
  authorizeRenderer(originalEvent: object): object | null;
  authorizeHost?(origin: object, request: Readonly<McpInvocationRequest>): object | null;
  sanitizeRendererRequest(raw: unknown): McpInvocationRequest;
  validateBeforeReserve(originalEvent: object, request: McpInvocationRequest, identity: NativeAuthenticatedIdentity): void;
  assertStartAvailable?(): void;
  reservePreflightParent?(originalEvent: object, request: McpInvocationRequest, admission: InvocationAdmissionIdentity): void;
  router: Router; callbackAdapter: Callbacks; maxRetainedStarts: number;
}) {
  if (!Number.isSafeInteger(ports.maxRetainedStarts) || ports.maxRetainedStarts < 1) fail("native_gui_capacity_invalid");
  const captures = new Map<string, Capture>();
  // A failed synchronous issuer can have reserved an admission, but cannot mint
  // source-owned noStart proof. Keep the original failure; caller reconciliation
  // owns rejection. Never turn this record into a replay/start or Stop authority.
  const issueFailures = new Map<string, { admission: InvocationAdmissionIdentity; error: unknown }>();
  const watched = new WeakSet<Channel>();
  function requireCurrent(r: Capture): void {
    if (r.unavailable || ports.getChannel() !== r.channel || nativeGuiChannelIdentity(r.channel) !== r.identity) fail("native_gui_original_channel_unavailable");
  }
  function watch(channel: Channel): void {
    if (watched.has(channel)) return;
    watched.add(channel);
    channel.onClose(() => {
      for (const r of captures.values()) if (r.channel === channel) r.unavailable = true;
      // Revokes Main preparations; no remote Stop, quiescence or row decision is
      // inferred. Remote held work remains owned until original promises drain.
      ports.router.disconnect(channel);
    });
  }
  function start(originalEvent: object, raw: unknown): Promise<InvocationStartResult> {
    const available: unknown = ports.assertStartAvailable?.();
    if (thenable(available)) fail("native_gui_synchronous_validation_required");
    const sender = ports.authorizeRenderer(originalEvent);
    if (!sender || thenable(sender)) fail("native_gui_original_renderer_required");
    const request = ports.sanitizeRendererRequest(raw);
    if (!request.runId || captures.has(request.runId) || issueFailures.has(request.runId)) fail("native_gui_original_start_replayed");
    if (captures.size + issueFailures.size >= ports.maxRetainedStarts) fail("native_gui_capacity_reached");
    const channel = ports.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
    if (!channel || !identity) fail("native_gui_enrolled_channel_required");
    const validation: unknown = ports.validateBeforeReserve(originalEvent, request, identity);
    if (thenable(validation)) fail("native_gui_synchronous_validation_required");
    if (ports.getChannel() !== channel || nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable");
    const mainAdmission = admitMainInvocation(request.chatId, request.runId);
    if (!mainAdmission) fail("native_invocation_admission_required");
    const admission: InvocationAdmissionIdentity = Object.freeze({ chatId: request.chatId, runId: request.runId,
      canonicalRequestJson: canonicalInvocationRequestJson(request), ownerProcessEpoch: identity.bootId });
    const result = createInvocationAdmission(admission);
    if (result.kind !== "created") fail("native_gui_admission_not_fresh");
    try {
      const parent: unknown = ports.reservePreflightParent?.(originalEvent, request, admission);
      if (thenable(parent)) fail("native_gui_synchronous_parent_required");
    } catch (error) { issueFailures.set(request.runId, { admission, error }); throw error; }
    return captureStart(originalEvent, request, mainAdmission, admission, channel, identity);
  }
  /** Same issuer, reservation and authenticated start RPC; source is a private
   * durable command capability issued by Supervisor, never a fabricated IPC event. */
  function startHost(origin: object, request: McpInvocationRequest): Promise<InvocationStartResult> {
    const sender=ports.authorizeHost?.(origin,request);
    if(!sender || thenable(sender))fail("native_gui_original_host_required");
    const identity=assertCanStart(request.runId),channel=ports.getChannel()!;
    const mainAdmission=admitMainInvocation(request.chatId,request.runId);
    if(!mainAdmission)fail("native_invocation_admission_required");
    const admission:InvocationAdmissionIdentity=Object.freeze({chatId:request.chatId,runId:request.runId!,canonicalRequestJson:canonicalInvocationRequestJson(request),ownerProcessEpoch:identity.bootId});
    if(createInvocationAdmission(admission).kind!=="created")fail("native_gui_admission_not_fresh");
    return captureStart(origin,request,mainAdmission,admission,channel,identity,origin);
  }
  /** The actual IPC producer has already applied its complete One/Work guards,
   * issued the original Main token and reserved the exact boot-bound row. This
   * path neither sanitizes a second time nor creates a second admission. */
  function startReserved(originalEvent: object, request: McpInvocationRequest,
    mainAdmission: MainInvocationAdmission, admission: InvocationAdmissionIdentity): Promise<InvocationStartResult> {
    const sender = ports.authorizeRenderer(originalEvent);
    if (!sender || thenable(sender)) fail("native_gui_original_renderer_required");
    const identity = assertCanStart(request.runId);
    const channel = ports.getChannel()!;
    const validation: unknown = ports.validateBeforeReserve(originalEvent, request, identity);
    if (thenable(validation)) fail("native_gui_synchronous_validation_required");
    if (nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable");
    const canonical = canonicalInvocationRequestJson(request), row = request.runId && getInvocationAdmission(request.runId);
    if (!row || row.status !== "pending" || admission.runId !== request.runId || admission.chatId !== request.chatId
      || admission.ownerProcessEpoch !== identity.bootId || admission.canonicalRequestJson !== canonical
      || row.chatId !== request.chatId || row.ownerProcessEpoch !== identity.bootId
      || row.inputDigest !== rowDigest(admission)) fail("native_gui_reserved_admission_required");
    return captureStart(originalEvent, request, mainAdmission, admission, channel, identity);
  }
  function assertCanStart(runId: string | undefined): NativeAuthenticatedIdentity {
    const available: unknown = ports.assertStartAvailable?.();
    if (thenable(available)) fail("native_gui_synchronous_validation_required");
    if (!runId || captures.has(runId) || issueFailures.has(runId)) fail("native_gui_original_start_replayed");
    if (captures.size + issueFailures.size >= ports.maxRetainedStarts) fail("native_gui_capacity_reached");
    const channel = ports.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
    if (!identity) fail("native_gui_enrolled_channel_required");
    return identity;
  }
  function captureStart(originalEvent: object, request: McpInvocationRequest,
    mainAdmission: MainInvocationAdmission, admission: InvocationAdmissionIdentity,
    channel: Channel, identity: NativeAuthenticatedIdentity, hostOrigin?: object): Promise<InvocationStartResult> {
    const runId = request.runId; if (!runId) fail("native_gui_original_start_replayed");
    let issued: ReturnType<Router["issue"]>;
    try {
      issued = ports.router.issue({ event: originalEvent, ...(hostOrigin?{hostOrigin}:{}), actualChannel: channel, request, mainAdmission, admission });
      ports.callbackAdapter.registerIssued(issued.start, issued.privateHandle);
    } catch (error) { issueFailures.set(runId, { admission, error }); throw error; }
    const r: Capture = { channel, identity, originalRequest: JSON.parse(canonicalInvocationRequestJson(request)) as McpInvocationRequest, start: issued.start, privateHandle: issued.privateHandle,
      actualStart: undefined as unknown as Promise<InvocationStartResult>, unavailable: false };
    captures.set(runId, r); // BEFORE watching or dispatching; close can be synchronous.
    try {
      watch(channel);
      requireCurrent(r);
      r.transportStart = channel.dispatch("invoke.nativeStart", r.start);
      r.actualStart = r.transportStart.then(value => {
        requireCurrent(r);
        // The ACK is a result, never retirement/settlement or new authority.
        if (!value || typeof value !== "object" || (value as { runId?: unknown }).runId !== r.start.binding.runId) fail("native_gui_start_ack_invalid");
        return value as InvocationStartResult;
      });
    } catch (error) { r.actualStart = Promise.reject(error); }
    // Caller owns the error presentation; attaching a observer prevents a lost
    // IPC listener from creating unhandled rejection, without swallowing it.
    void r.actualStart.catch(() => {});
    return r.actualStart;
  }
  function cancel(runId: string): Promise<StopResult> {
    const r = captures.get(runId);
    if (!r) return Promise.resolve("not-found");
    if (r.cancellation) return r.cancellation;
    // Install the exact shared Promise before invoking either boundary, to
    // prevent re-entrant duplicate sends. Neither lookup nor start ACK is needed.
    let resolve!: (value: StopResult) => void, reject!: (error: unknown) => void;
    const pending = new Promise<StopResult>((yes, no) => { resolve = yes; reject = no; });
    r.cancellation = pending;
    let localError: unknown, localFailed = false;
    try { ports.router.cancel(r.privateHandle); } catch (error) { localFailed = true; localError = error; }
    try {
      requireCurrent(r);
      const actual = r.channel.dispatch("invoke.cancel", r.start);
      void actual.then(value => {
        try { requireCurrent(r); } catch (error) { reject(error); return; }
        // Only a verified daemon ACK proves Stop intake. Main abort is not it.
        if (value !== "requested" && value !== "already-requested" && value !== "not-found") { reject(new NativeGuiOwnerError("native_gui_stop_ack_invalid")); return; }
        if (localFailed) { reject(localError); return; }
        resolve(value);
      }, reject);
    } catch (error) { reject(error); }
    void pending.catch(() => {});
    return pending;
  }
  function textInputBinding(originalEvent: object, request: McpInvocationRequest, expectedRunId?: string) {
    const sender = ports.authorizeRenderer(originalEvent);
    if (!sender || thenable(sender)) fail("native_gui_original_renderer_required");
    const matches = [...captures.values()].filter(r => r.start.binding.chatId === request.chatId && (!expectedRunId || r.start.binding.runId === expectedRunId));
    if (matches.length !== 1) fail("native_gui_original_text_parent_required");
    const r = matches[0]; requireCurrent(r);
    // Text inherits only this already-issued invocation. A new reference or
    // changed execution choice requires a new guarded native preparation.
    for (const key of ["images", "fileGroupId", "oneMemoryUseOnceRef", "oneBriefingActionRef", "oneTeamPreflightRef", "oneAttachmentRef", "oneRecurrenceSelection", "preflightSubmissionId"] as const) {
      if (request[key] !== undefined) fail("native_gui_text_input_requires_new_preparation");
    }
    const base: Partial<McpInvocationRequest> = { ...r.originalRequest }, next: Partial<McpInvocationRequest> = { ...request };
    for (const value of [base, next]) { delete value.runId; delete value.userPrompt; delete value.steeringMode; }
    for (const key of ["images", "fileGroupId", "oneMemoryUseOnceRef", "oneBriefingActionRef", "oneTeamPreflightRef", "oneAttachmentRef", "oneRecurrenceSelection", "preflightSubmissionId"] as const) delete base[key];
    if (canonicalInvocationRequestJson(base as McpInvocationRequest) !== canonicalInvocationRequestJson(next as McpInvocationRequest)) fail("native_gui_text_input_context_changed");
    return Object.freeze({ chatId: r.start.binding.chatId, runId: r.start.binding.runId, inputDigest: r.start.binding.inputDigest });
  }
  function preflightTextInputBinding(originalEvent: object, request: McpInvocationRequest, runId: string) {
    const sender = ports.authorizeRenderer(originalEvent);
    if (!sender || thenable(sender)) fail("native_gui_original_renderer_required");
    const r = captures.get(runId);
    if (!r || r.start.binding.chatId !== request.chatId || !r.originalRequest.oneMode) fail("native_gui_original_text_parent_required");
    requireCurrent(r);
    const expected = onePreflightSteerTemplate(r.originalRequest);
    expected.userPrompt = request.userPrompt; expected.runId = undefined;
    for (const key of ONE_PREFLIGHT_STEER_REQUEST_KEYS) {
      const original = r.originalRequest[key], selected = request[key];
      if (["planMode", "goalMode", "fastMode", "sessionRouting"].includes(key)) {
        if (Boolean(selected) !== Boolean(original)) fail("native_gui_text_input_context_changed");
      } else if (key === "permissions") {
        if (effectiveInvocationPermission(selected, request.planMode) !== effectiveInvocationPermission(original, r.originalRequest.planMode)) fail("native_gui_text_input_context_changed");
      } else if (canonicalInvocationRequestJson({ chatId: request.chatId, userPrompt: "", [key]: selected }) !== canonicalInvocationRequestJson({ chatId: request.chatId, userPrompt: "", [key]: original })) fail("native_gui_text_input_context_changed");
      if (selected !== undefined) Object.assign(expected, { [key]: selected }); else delete expected[key];
    }
    if (canonicalInvocationRequestJson(expected) !== canonicalInvocationRequestJson(request)) fail("native_gui_text_input_context_changed");
    return Object.freeze({ chatId: r.start.binding.chatId, runId, inputDigest: r.start.binding.inputDigest });
  }
  function capturedTextBinding(chatId: string, runId?: string) {
    const records=[...captures.values()].filter(r=>r.start.binding.chatId===chatId&&(!runId||r.start.binding.runId===runId));
    if(records.length!==1)fail("native_gui_original_text_parent_required");requireCurrent(records[0]);return Object.freeze({...records[0].start.binding});
  }
  function capturedParent(chatId: string, runId: string): boolean { const r = captures.get(runId); return !!r && r.start.binding.chatId === chatId; }
  function retire(runId: string): boolean {
    const r = captures.get(runId); if (!r) return false;
    const state = ports.router.inspect(r.privateHandle);
    if (!state.released || !state.finished || state.pendingCount !== 0 || state.uncertain) fail("native_gui_original_custody_retained");
    captures.delete(runId); return true;
  }
  const owner = Object.freeze({ start, startHost, startReserved, assertCanStart, cancel, retire, textInputBinding, preflightTextInputBinding, capturedTextBinding, capturedParent,
    // Authentic source settlement is a wakeup only. Existing private router
    // state remains the sole closure gate; never finish or send another RPC.
    observeSettlement(runId: string): boolean { return retire(runId); },
    inspect(runId: string) { const r = captures.get(runId); return Object.freeze({ retained: !!r,
      issuanceFailed: issueFailures.has(runId), unavailable: r ? r.unavailable || ports.getChannel() !== r.channel || nativeGuiChannelIdentity(r.channel) !== r.identity : false,
      cancellationRequested: !!r?.cancellation, preparation: r ? ports.router.inspect(r.privateHandle) : undefined }); },
    retainedChatIds(): string[] { return [...new Set([...captures.values()].map(r => r.start.binding.chatId))]; },
    get retainedCount() { return captures.size + issueFailures.size; } });
  const channel = ports.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
  if (channel && identity) ownerBootstraps.set(owner, { channel, identity, callbacks: ports.callbackAdapter });
  return owner;
}
