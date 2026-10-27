import { getDb } from "../store/db";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { createHash } from "node:crypto";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import { ONE_PREFLIGHT_STEER_REQUEST_KEYS } from "../../shared/one-preflight-steers";
import { onePreflightSteerTemplate } from "../store/one-preflight-steers";
import type { McpInvocationRequest } from "../../shared/types";
import { canonicalInvocationRequestJson, createInvocationAdmission, decideInvocationAdmission, getInvocationAdmission, rearmRejectedInvocationAdmission, INVOCATION_ADMISSION_DIGEST_VERSION, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
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
  originalRequest: McpInvocationRequest; readonly start: NativeStartDescriptor; readonly privateHandle: NativeMainPreparationRouterHandle;
  transportStart?: Promise<unknown>; actualStart: Promise<InvocationStartResult>; cancellation?: Promise<StopResult>; unavailable: boolean; cleanupObservation?: Promise<unknown>;
}
/** `detail` is machine-readable and content-free (top-level key NAMES only); it goes to logs, never to the screen. */
export class NativeGuiOwnerError extends Error { constructor(readonly code: string, readonly detail?: string) { super(code); } }
function fail(code: string, detail?: string): never { throw new NativeGuiOwnerError(code, detail); }
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
  type IssueFailure = { admission: InvocationAdmissionIdentity; error: unknown; timer?: ReturnType<typeof setTimeout>; reconcile?: () => void; needsReconciliation: boolean };
  const issueFailures = new Map<string, IssueFailure>();
  function reconcileIssueFailuresBeforeDistinctStart(): void {
    // These closures own original synchronous pre-dispatch failures only. A new
    // authorized start may reobserve their closed fact, never invoke the producer/RPC again.
    for (const failure of [...issueFailures.values()]) if (failure.needsReconciliation) failure.reconcile?.();
  }
  function issueFailedBeforeDispatch(admission: InvocationAdmissionIdentity, error: unknown): void {
    const failure: IssueFailure = { admission, error, needsReconciliation: false };
    issueFailures.set(admission.runId, failure);
    const reconcile = () => {
      if (failure.timer) clearTimeout(failure.timer);
      failure.timer = undefined; failure.needsReconciliation = false;
      if (issueFailures.get(admission.runId) !== failure) return;
      try {
        // Only these synchronous catches precede channel.dispatch. A foreign owner is never our no-start fact.
        getDb().transaction(() => {
          if (invocationRunOwners.getRunOwner(admission.chatId, admission.runId)) return;
          const a = getInvocationAdmission(admission.runId);
          if (!a || a.chatId !== admission.chatId || a.inputDigest !== rowDigest(admission) || a.ownerProcessEpoch !== admission.ownerProcessEpoch) return;
          if (a.status === "pending") decideInvocationAdmission({ ...admission, decision: "rejected", reasonCode: "native_gui_before_dispatch_failed",
            noStartProof: { kind: "owner-start-boundary-not-crossed", verifiedOwnerProcessEpoch: admission.ownerProcessEpoch } });
        }).immediate();
        const closed = [...issueFailures].filter(([, f]) => { const row = getInvocationAdmission(f.admission.runId); return row?.status === "rejected" && row.chatId === f.admission.chatId && row.ownerProcessEpoch === f.admission.ownerProcessEpoch && row.inputDigest === rowDigest(f.admission); });
        for (const [runId] of closed.slice(0, Math.max(0, closed.length - 128))) issueFailures.delete(runId);
      } catch (cause) {
        failure.needsReconciliation = true;
        let code: unknown; try { if (cause && typeof cause === "object") code = Object.getOwnPropertyDescriptor(cause, "code")?.value; } catch {}
        if (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z_]+)?$/.test(code) && !failure.timer) { failure.timer = setTimeout(reconcile, 1_000); failure.timer.unref?.(); }
      }
    };
    failure.reconcile = reconcile;
    reconcile();
  }
  const watched = new WeakSet<Channel>();
  function activeAuthority(r: Capture): boolean {
    if (!ports.router.closeAuthorityIfSettled(r.privateHandle)) return true;
    // Closed text selectors cannot use the original request again. Preserve
    // digest/run identity and the private cleanup handle, without retaining prompt text.
    r.originalRequest = { chatId: r.start.binding.chatId, runId: r.start.binding.runId, userPrompt: "" };
    if (!r.cleanupObservation) {
      // Local original-handle cleanup only; no nativeStart, checkpoint claim, or ACK replay.
      r.cleanupObservation = Promise.resolve().then(() => ports.router.finishForSettlement(r.privateHandle, "settled"));
      void r.cleanupObservation.then(() => { try { retire(r.start.binding.runId); } catch {} }, () => {});
    }
    return false;
  }
  function liveCapacity(): number {
    const failures = [...issueFailures.values()].filter(f => {
      const a = getInvocationAdmission(f.admission.runId);
      return !a || a.chatId !== f.admission.chatId || a.ownerProcessEpoch !== f.admission.ownerProcessEpoch || a.inputDigest !== rowDigest(f.admission) || a.status !== "rejected";
    }).length;
    return [...captures.values()].filter(activeAuthority).length + failures;
  }
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
    reconcileIssueFailuresBeforeDistinctStart();
    if (liveCapacity() >= ports.maxRetainedStarts) fail("native_gui_capacity_reached");
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
    } catch (error) { issueFailedBeforeDispatch(admission, error); throw error; }
    return captureStart(originalEvent, request, mainAdmission, admission, channel, identity);
  }
  /** Same issuer, reservation and authenticated start RPC; source is a private
   * durable command capability issued by Supervisor, never a fabricated IPC event. */
  function startHost(origin: object, request: McpInvocationRequest): Promise<InvocationStartResult> {
    const sender=ports.authorizeHost?.(origin,request);
    if(!sender || thenable(sender))fail("native_gui_original_host_required");
    // Reauthorization above is mandatory even for a read-only repeated result.
    const available: unknown = ports.assertStartAvailable?.();
    if (thenable(available)) fail("native_gui_synchronous_validation_required");
    const channel=ports.getChannel(),identity=channel&&nativeGuiChannelIdentity(channel);
    if(!channel||!identity)fail("native_gui_enrolled_channel_required");
    if(!request.runId)fail("native_gui_original_start_replayed");
    const admission:InvocationAdmissionIdentity=Object.freeze({chatId:request.chatId,runId:request.runId,canonicalRequestJson:canonicalInvocationRequestJson(request),ownerProcessEpoch:identity.bootId});
    reconcileIssueFailuresBeforeDistinctStart();
    const row=getInvocationAdmission(request.runId), prior=captures.get(request.runId);
    if(row&&(row.chatId!==request.chatId||row.inputDigest!==rowDigest(admission)||row.digestVersion!==INVOCATION_ADMISSION_DIGEST_VERSION))fail("native_gui_host_request_changed");
    const admittedReceipt=()=>!!getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' LIMIT 1").get(request.runId,request.chatId);
    if(prior) {
      if(prior.start.binding.chatId!==request.chatId||prior.start.binding.inputDigest!==rowDigest(admission))fail("native_gui_host_request_changed");
      if(prior.cancellation)fail("native_gui_original_start_cancelled");
      if(row?.status!=="rejected") {
        // Lost ACK is observation of the original attempt, never another RPC.
        requireCurrent(prior);
        if(row?.status==="admitted"&&admittedReceipt())return Promise.resolve({runId:request.runId});
        return prior.actualStart;
      }
      // Rejection is insufficient while original operations/cleanup still run.
      activeAuthority(prior);
      retire(request.runId);
    }
    if(row?.status==="admitted") {
      if(row.ownerProcessEpoch!==identity.bootId||!admittedReceipt())fail("native_gui_original_channel_unavailable");
      return Promise.resolve({runId:request.runId});
    }
    const failed=issueFailures.get(request.runId);
    if(failed) {
      if(row?.status!=="rejected"||failed.admission.chatId!==request.chatId||rowDigest(failed.admission)!==rowDigest(admission))throw failed.error;
      if(failed.timer)clearTimeout(failed.timer);
      issueFailures.delete(request.runId);
    }
    if (liveCapacity() >= ports.maxRetainedStarts) fail("native_gui_capacity_reached");
    const mainAdmission=admitMainInvocation(request.chatId,request.runId);
    if(!mainAdmission)fail("native_invocation_admission_required");
    const reserved=row?.status==="rejected"?rearmRejectedInvocationAdmission(admission):createInvocationAdmission(admission);
    if(reserved.kind!=="created")fail("native_gui_admission_not_fresh");
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
    reconcileIssueFailuresBeforeDistinctStart();
    if (liveCapacity() >= ports.maxRetainedStarts) fail("native_gui_capacity_reached");
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
    } catch (error) { issueFailedBeforeDispatch(admission, error); throw error; }
    const r: Capture = { channel, identity, originalRequest: JSON.parse(canonicalInvocationRequestJson(request)) as McpInvocationRequest, start: issued.start, privateHandle: issued.privateHandle,
      actualStart: undefined as unknown as Promise<InvocationStartResult>, unavailable: false };
    captures.set(runId, r); // BEFORE watching or dispatching; close can be synchronous.
    let dispatchEntered = false;
    try {
      watch(channel);
      requireCurrent(r);
      dispatchEntered = true; // A synchronous throw after this point can still have dispatched.
      r.transportStart = channel.dispatch("invoke.nativeStart", r.start);
      r.actualStart = r.transportStart.then(value => {
        requireCurrent(r);
        // The ACK is a result, never retirement/settlement or new authority.
        if (!value || typeof value !== "object" || (value as { runId?: unknown }).runId !== r.start.binding.runId) fail("native_gui_start_ack_invalid");
        return value as InvocationStartResult;
      });
    } catch (error) {
      if (!dispatchEntered) issueFailedBeforeDispatch(admission, error);
      r.actualStart = Promise.reject(error);
    }
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
    const matches = [...captures.values()].filter(r => activeAuthority(r) && r.start.binding.chatId === request.chatId && (!expectedRunId || r.start.binding.runId === expectedRunId));
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
    if (canonicalInvocationRequestJson(base as McpInvocationRequest) !== canonicalInvocationRequestJson(next as McpInvocationRequest)) {
      // Which top-level choices differ (names only, never values): the refusal used to say nothing about its cause.
      const differing = [...new Set([...Object.keys(base), ...Object.keys(next)])].sort().filter((key) => {
        const a = (base as Record<string, unknown>)[key], b = (next as Record<string, unknown>)[key];
        if (a === undefined && b === undefined) return false;
        try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
      });
      fail("native_gui_text_input_context_changed", `differing_keys=${differing.join(",")}`);
    }
    return Object.freeze({ chatId: r.start.binding.chatId, runId: r.start.binding.runId, inputDigest: r.start.binding.inputDigest });
  }
  function preflightTextInputBinding(originalEvent: object, request: McpInvocationRequest, runId: string) {
    const sender = ports.authorizeRenderer(originalEvent);
    if (!sender || thenable(sender)) fail("native_gui_original_renderer_required");
    const r = captures.get(runId);
    if (!r || !activeAuthority(r) || r.start.binding.chatId !== request.chatId || !r.originalRequest.oneMode) fail("native_gui_original_text_parent_required");
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
    const records=[...captures.values()].filter(r=>activeAuthority(r)&&r.start.binding.chatId===chatId&&(!runId||r.start.binding.runId===runId));
    if(records.length!==1)fail("native_gui_original_text_parent_required");requireCurrent(records[0]);return Object.freeze({...records[0].start.binding});
  }
  function capturedParent(chatId: string, runId: string): boolean { const r = captures.get(runId); return !!r && activeAuthority(r) && r.start.binding.chatId === chatId; }
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
    closedAuthorityChatIds(): string[] { return [...new Set([...captures.values()].filter(r => !activeAuthority(r)).map(r => r.start.binding.chatId))]; },
    activeAuthorityChatIds(): string[] { return [...new Set([...captures.values()].filter(activeAuthority).map(r => r.start.binding.chatId))]; },
    get retainedCount() { return captures.size + issueFailures.size; }, get activeAuthorityCount() { return liveCapacity(); } });
  const channel = ports.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
  if (channel && identity) ownerBootstraps.set(owner, { channel, identity, callbacks: ports.callbackAdapter });
  return owner;
}
