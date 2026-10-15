import type { Writable } from "node:stream";
import { captureNativeAuthBinding, provisionNativeGuiCredential, nativeDaemonEnrollment, type NativeAuthBinding, type NativeCredential } from "../daemon/native-auth-credentials";
import { connectNativeGuiChannel, nativeAuthSocketPath, nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { userDataDir } from "../runtime-paths";
import { CHAT_HANDOVER_VERSION, chatReleaseReplyFromWire, registerChatHandoverPeer } from "../runtime/chat-host-handover";
import { assertNativeGuiOwnerBootstrap, type createNativeGuiOwnerClient } from "./native-gui-owner";
import { invocationAdmissionEpochsReservedHere, rejectPendingAdmissionsOfTerminatedEpochs } from "../store/invocation-admissions";
import type { createNativeMainAuthCallbackAdapter } from "./native-main-auth-callback";
import { NATIVE_PUBLIC_OPTIONAL_KINDS, nativePublicKindsOperation } from "./native-public-events";

declare const enrolledGui: unique symbol;
export interface NativeGuiEnrollment { readonly [enrolledGui]: true }
type Channel = Awaited<ReturnType<typeof connectNativeGuiChannel>>;
type Owner = ReturnType<typeof createNativeGuiOwnerClient>;
type Adapter = ReturnType<typeof createNativeMainAuthCallbackAdapter>;
export type NativeGuiCapabilities = Readonly<{ start: boolean; stop: boolean; events: boolean; approvals: boolean; recovery: boolean }>;
type Attachment = Readonly<{ ready: boolean; capabilities: NativeGuiCapabilities; identity: NativeAuthenticatedIdentity }>;
/** Events carry the identity of the generation that produced them (undefined only before authentication completes). */
export type NativeGuiEventSink = (method: string, params: unknown, identity?: NativeAuthenticatedIdentity, sourceMode?: "live" | "post-denial") => void;
export interface NativeGuiAttachHooks {
  onAuthenticated?(channel: Channel, identity: NativeAuthenticatedIdentity): void;
  onObservationReset?(channel: Channel, identity: NativeAuthenticatedIdentity, stream: string): void;
  /** Fresh endpoint/snapshot only. Historical approval cards never join this barrier. */
  onObservationReady?(channel: Channel, identity: NativeAuthenticatedIdentity): Promise<boolean>;
}
interface State { binding: NativeAuthBinding; credential: NativeCredential; wire: string; written: boolean; channel?: Channel; identity?: NativeAuthenticatedIdentity; capabilities?: NativeGuiCapabilities; ready?: boolean; adapter?: Adapter; owner?: Owner; attachBoot?: string; attachment?: Promise<Attachment>; attachPending?: boolean; generation: number; observationStream?: string; observationRevision?: number; observationRecovery?: Promise<Attachment> }
const enrollments = new WeakMap<object, State>();
let installed: State | undefined;
function fail(code: string): never { throw new Error(code); }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Object.keys(value).sort(), expected = [...fields].sort(); return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function state(enrollment: NativeGuiEnrollment): State { const value = enrollments.get(enrollment); if (!value) fail("native_gui_registered_enrollment_required"); return value; }
/** Main-only protected IO. The registry-last credential loader preserves GUI
 * reopen and independently started daemon keys. Unavailable is never absence. */
export async function prepareNativeGuiEnrollment(): Promise<NativeGuiEnrollment> {
  const binding = captureNativeAuthBinding(), credential = await provisionNativeGuiCredential(binding);
  const wire = await nativeDaemonEnrollment(binding, credential);
  const enrollment = Object.freeze({}) as NativeGuiEnrollment;
  enrollments.set(enrollment, { binding, credential, wire, written: false, generation: 0 });
  return enrollment;
}
/** The launcher delivers only the daemon-role enrollment through inherited fd3.
 * Private key records never enter argv/env/preload or provider child processes. */
export function writePreparedNativeEnrollment(pipe: Writable, enrollment: NativeGuiEnrollment): Promise<void> {
  const value = state(enrollment); if (value.written || pipe.destroyed || !pipe.writable) fail("native_gui_enrollment_pipe_unavailable");
  value.written = true; // An attempted write is never retried after uncertainty.
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { pipe.off("error", failed); pipe.off("finish", finished); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const finished = () => { cleanup(); resolve(); };
    pipe.once("error", failed); pipe.once("finish", finished);
    try { pipe.end(value.wire); } catch (error) { cleanup(); reject(error); }
  });
}
/** Rotate only disposable observation subscriptions on the original authenticated
 * control channel. Never reissue starts, renew run authority, or close writers. */
export function recoverNativeGuiObservation(enrollment: NativeGuiEnrollment, onEvent: NativeGuiEventSink | undefined, hooks: NativeGuiAttachHooks): Promise<Attachment> {
  const value = state(enrollment);
  if (value.observationRecovery) return value.observationRecovery;
  const channel = value.channel, identity = value.identity;
  if (!channel || !identity || nativeGuiChannelIdentity(channel) !== identity || !hooks.onObservationReset || !hooks.onObservationReady) fail("native_gui_observation_recovery_unavailable");
  const originalGeneration = value.generation;
  const current = () => { if (value.channel !== channel || value.identity !== identity || value.generation !== originalGeneration || nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable"); };
  const operation = (async () => {
    current();
    let reset: unknown;
    try { reset = await channel.dispatch("native.attach", {version: "agentlas.native-observation-reset.v1"}); }
    catch (error) {
      // A genuinely older daemon does not implement this optional operation.
      // Preserve its healthy legacy attach; never pretend recovery succeeded.
      if ((error as {code?:unknown}).code === "native_invocation_attach_invalid" && value.ready === true && value.capabilities) return Object.freeze({ready: true, capabilities: value.capabilities, identity});
      throw error;
    }
    current(); value.ready = false;
    if (!exact(reset, ["version", "stream"]) || reset.version !== "agentlas.native-observation-reset.v1" || typeof reset.stream !== "string" || !/^[a-f0-9]{64}$/.test(reset.stream)) fail("native_gui_observation_reset_invalid");
    hooks.onObservationReset!(channel, identity, reset.stream); value.observationStream = reset.stream;
    const originalRevision = value.observationRevision ?? 0;
    const activated = await channel.dispatch("native.attach", {version: "agentlas.native-observation-activate.v1", stream: reset.stream});
    current();
    if (!exact(activated, ["version", "stream", "notifications", "status"]) || activated.version !== "agentlas.native-observation-activate.v1" || activated.stream !== reset.stream || !Array.isArray(activated.notifications)) fail("native_gui_observation_activation_invalid");
    for (const event of activated.notifications) {
      if ((!exact(event, ["method", "params"]) && !exact(event, ["method", "params", "mode"])) || !["invocation.public.ready", "invocation.approval.ready", "invocation.approval.resolved", "invocation.approval.unavailable"].includes(String(event.method))) fail("native_gui_observation_activation_invalid");
      if ((event.mode !== undefined && event.mode !== "live" && event.mode !== "post-denial") || (event.method === "invocation.approval.ready" && event.mode === undefined)) fail("native_gui_observation_mode_invalid");
      onEvent?.(String(event.method), event.params, identity, event.mode as "live" | "post-denial" | undefined);
    }
    const reply = activated.status;
    if (!exact(reply, ["version", "bootId", "serviceIdentity", "ready", "capabilities"]) || reply.version !== "agentlas.native-attach.v1" || reply.bootId !== identity.bootId || reply.serviceIdentity !== identity.serviceIdentity || typeof reply.ready !== "boolean"
      || !exact(reply.capabilities, ["start", "stop", "events", "approvals", "recovery"]) || Object.values(reply.capabilities).some(flag => typeof flag !== "boolean")) fail("native_gui_attach_reply_invalid");
    const endpointReady = await hooks.onObservationReady!(channel, identity);
    current();
    if ((value.observationRevision ?? 0) !== originalRevision) fail("native_gui_observation_recovery_faulted");
    value.capabilities = Object.freeze({...reply.capabilities}) as NativeGuiCapabilities;
    value.ready = reply.ready && endpointReady && Object.values(value.capabilities).every(Boolean);
    return Object.freeze({ready: value.ready, capabilities: value.capabilities, identity});
  })();
  value.observationRecovery = operation;
  const settled = () => { if (value.observationRecovery === operation) value.observationRecovery = undefined; };
  operation.then(settled, settled); void operation.catch(() => {}); return operation;
}
/**
 * A daemon killed (or a Desktop crashed) before its start boundary leaves a pending reservation that only that
 * dead process could decide, and a pending reservation locks its chat: every later owner turn waited forever on
 * invocation_admission_chat_pending (measured: daemon SIGKILL while a turn waited on Main, respawn, re-attach).
 * The authenticated attach is the proof point. The signed transcript names the one live daemon boot; Electron's
 * exclusive single-instance lock proves every earlier Desktop process ended; this process's own epochs are the ones
 * it reserved under minus the daemon boots it attached to. Every other epoch has terminated. Without the lock (dev
 * multi-instance, headless host) nothing is decided. Lazy electron require: the daemon never calls this.
 */
const attachedDaemonBoots = new Set<string>();
function settleReservationsOfEndedOwners(liveDaemonBootId: string): void {
  attachedDaemonBoots.add(liveDaemonBootId);
  let exclusive = false;
  try { exclusive = (require("electron") as { app?: { hasSingleInstanceLock?: () => boolean } }).app?.hasSingleInstanceLock?.() === true; }
  catch { /* not an Electron GUI host: no exclusivity proof */ }
  if (!exclusive) return;
  try {
    const ownEpochs = invocationAdmissionEpochsReservedHere().filter(epoch => !attachedDaemonBoots.has(epoch));
    const settled = rejectPendingAdmissionsOfTerminatedEpochs({ liveOwnerProcessEpochs: [liveDaemonBootId, ...ownEpochs], reasonCode: "owner_process_epoch_terminated" });
    if (settled.length > 0) console.warn("[native-invocation] settled reservations left by ended processes", { runIds: settled.map(row => row.runId) });
  } catch (error) {
    // The next authenticated attach observes again; an unreadable store is not a decision.
    console.warn("[native-invocation] ended-process reservations remain unsettled", (error as { code?: unknown })?.code ?? (error as Error)?.message);
  }
}
/** Public ping supplies discovery only. The boot becomes trusted solely after
 * the actual enrolled signature and strict native.attach transcript agree. */
export function attachNativeGuiDaemon(enrollment: NativeGuiEnrollment, discoveredBootId: string,
  onEvent?: NativeGuiEventSink, hooks?: NativeGuiAttachHooks): Promise<Attachment> {
  const value = state(enrollment);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(discoveredBootId)) fail("native_gui_boot_discovery_invalid");
  if (value.attachment) {
    // One attach at a time: neither concurrent ensures nor a lost ACK can create a second handshake.
    if (value.attachPending) {
      if (value.attachBoot !== discoveredBootId) fail("native_gui_original_boot_required");
      return value.attachment;
    }
    const live = !!value.channel && !!nativeGuiChannelIdentity(value.channel) && value.attachBoot === discoveredBootId && value.ready === true;
    if (live) return value.attachment.then(result => {
      if (!value.channel || nativeGuiChannelIdentity(value.channel) !== result.identity) fail("native_gui_original_channel_unavailable");
      return result;
    });
    if (value.channel && value.identity && nativeGuiChannelIdentity(value.channel) === value.identity && value.attachBoot === discoveredBootId && hooks?.onObservationReset) {
      return recoverNativeGuiObservation(enrollment, onEvent, hooks);
    }
    // A closed channel or a new daemon boot starts a new physical generation.
    // Never two live channels: the superseded one is closed before the next connect.
    value.ready = false; value.capabilities = undefined;
    const old = value.channel; if (old) { try { old.close(); } catch { /* already closed */ } }
  }
  value.attachBoot = discoveredBootId;
  const gen = ++value.generation; value.ready = false;
  const current = () => { if (value.generation !== gen) fail("native_gui_attach_superseded"); };
  let genIdentity: NativeAuthenticatedIdentity | undefined;
  const attachment = (async () => {
    const channel = await connectNativeGuiChannel({ address: nativeAuthSocketPath(userDataDir()), binding: value.binding,
      credential: value.credential, bootId: discoveredBootId,
      onEvent: onEvent && ((method, params) => {
        if (value.generation !== gen) return;
        if (method === "invocation.approval.observation") {
          if ((!exact(params, ["version", "stream", "method", "params"]) && !exact(params, ["version", "stream", "method", "params", "mode"])) || params.version !== "agentlas.native-approval-observation.v1"
            || !["invocation.approval.ready", "invocation.approval.resolved", "invocation.approval.unavailable"].includes(String(params.method)) || (params.mode !== undefined && params.mode !== "live" && params.mode !== "post-denial")) return;
          if (params.stream !== value.observationStream) return;
          onEvent(String(params.method), params.params, genIdentity, params.mode as "live" | "post-denial" | undefined); return;
        }
        if (value.observationStream && method.startsWith("invocation.approval.")) return;
        onEvent(method, params, genIdentity);
      }),
      onRequest(method, raw, identity) {
        current();
        // Device bridge (1.3.0 A3): the service's device requests (scoped screen control, idle snapshot) arrive on the same
        // authenticated callback path. They answer with a value and need no installed preparation adapter.
        if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === "agentlas.device-bridge.v1") {
          const live = value.channel;
          return import("./device-bridge-main").then(async m => (await m.deviceBridgeMain()).handle(raw, live as object, identity));
        }
        if (!value.adapter) fail("native_gui_callback_not_initialized"); return value.adapter.onRequest(method, raw, identity);
      } });
    try { current(); } catch (error) { channel.close(); throw error; }
    value.channel = channel; value.observationStream = undefined; value.identity = undefined; value.capabilities = undefined; value.ready = false;
    try {
      const identity = nativeGuiChannelIdentity(channel); if (!identity) fail("native_gui_enrolled_channel_required");
      value.identity = identity; genIdentity = identity;
      hooks?.onAuthenticated?.(channel, identity);
      if (nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable");
      const handoff = (await import("../auth")).sessionForDaemonHandoff();
      const session = handoff === null ? null : Object.fromEntries(Object.entries(handoff).filter(([, field]) => field !== undefined));
      const reply = await channel.dispatch("native.attach", { version: "agentlas.native-attach.v1", session });
      current();
      if (nativeGuiChannelIdentity(channel) !== identity || !exact(reply, ["version", "bootId", "serviceIdentity", "ready", "capabilities"])
        || reply.version !== "agentlas.native-attach.v1" || reply.bootId !== identity.bootId || reply.serviceIdentity !== identity.serviceIdentity
        || typeof reply.ready !== "boolean" || !exact(reply.capabilities, ["start", "stop", "events", "approvals", "recovery"])
        || Object.values(reply.capabilities).some(flag => typeof flag !== "boolean")) fail("native_gui_attach_reply_invalid");
      const capabilities = Object.freeze({ ...reply.capabilities }) as NativeGuiCapabilities;
      value.capabilities = capabilities; value.ready = reply.ready;
      settleReservationsOfEndedOwners(identity.bootId);
      // This receiver accepts the newer live kinds (the plan checklist); say so before any observation starts. An older
      // daemon refuses the unknown op (native_invocation_attach_invalid) and never emits them; the attach stays healthy.
      try { await channel.dispatch("native.attach", nativePublicKindsOperation(NATIVE_PUBLIC_OPTIONAL_KINDS)); }
      catch (error) { if ((error as {code?:unknown}).code !== "native_invocation_attach_invalid") console.warn("[native-invocation] optional live kinds not enabled", (error as {code?:unknown}).code ?? "unknown"); }
      current();
      // Device bridge: revoke daemon-run screen scopes if this channel closes, forward lock/sleep, push the current state.
      void import("./device-bridge-main").then(async m => (await m.deviceBridgeMain()).attached(channel as never)).catch(() => undefined);
      // Chat host handover (1.3.0 A2): this process can ask the attached service to release its idle resident sessions of a
      // chat before Desktop runs that chat's next turn. Tied to this exact channel generation.
      const unregisterHandover = registerChatHandoverPeer("daemon", async (chatId, deadlineMs) => {
        if (value.channel !== channel || nativeGuiChannelIdentity(channel) !== identity) throw Object.assign(new Error("chat_handover_peer_unavailable"), { code: "chat_handover_peer_unavailable" });
        return chatReleaseReplyFromWire(await channel.dispatch("native.attach", { version: CHAT_HANDOVER_VERSION, op: "release", chatId, deadlineMs }));
      });
      channel.onClose(unregisterHandover);
      if (hooks?.onObservationReset) {
        try { return await recoverNativeGuiObservation(enrollment, onEvent, hooks); }
        catch (error) { console.warn("[native-invocation] observation recovery unavailable", (error as {code?:unknown}).code ?? "native_gui_observation_recovery_unavailable"); value.ready = false; return Object.freeze({ready: false, capabilities, identity}); }
      }
      return Object.freeze({ ready: reply.ready && Object.values(capabilities).every(flag => flag === true), capabilities, identity });
    } catch (error) { channel.close(); throw error; }
  })();
  value.attachment = attachment; value.attachPending = true;
  const settle = () => { if (value.attachment === attachment) value.attachPending = false; };
  attachment.then(settle, settle);
  void attachment.catch(() => {});
  return attachment;
}
/** Root installs its original issuer/router and actual custody observers only
 * after ALL counterpart paths are connected. Availability flags alone cannot
 * construct a router, native sender, private handle, cwd proof or approval. */
export function installNativeGuiOwner(enrollment: NativeGuiEnrollment, owner: Owner, adapter: Adapter): void {
  const value = state(enrollment);
  if (installed || value.owner || !value.channel || !value.identity || nativeGuiChannelIdentity(value.channel) !== value.identity
    || value.ready !== true || !value.capabilities || !Object.values(value.capabilities).every(flag => flag === true)) fail("native_gui_activation_prerequisites_missing");
  assertNativeGuiOwnerBootstrap(owner, adapter, value.channel, value.identity);
  value.adapter = adapter; value.owner = owner; installed = value;
}
export function assertNativeGuiStartAvailable(enrollment: NativeGuiEnrollment): void {
  const value = state(enrollment);
  if (!value.channel || !value.identity || nativeGuiChannelIdentity(value.channel) !== value.identity
    || value.ready !== true || !value.capabilities || !Object.values(value.capabilities).every(flag => flag === true)) fail("native_gui_activation_prerequisites_missing");
}
/** Revocation of the CURRENT generation only; a later successful attach makes starts available again.
 * A call carrying an old channel/identity (a previous generation) is ignored and returns false. */
export function revokeNativeGuiStartAvailability(enrollment: NativeGuiEnrollment, channel: object, identity: NativeAuthenticatedIdentity): boolean {
  const value = state(enrollment);
  if (value.channel !== channel || value.identity !== identity) return false;
  value.ready = false; value.observationRevision = (value.observationRevision ?? 0) + 1; return true;
}
export function nativeGuiAttachGeneration(enrollment: NativeGuiEnrollment): number { return state(enrollment).generation; }
export function nativeGuiEnrollmentChannel(enrollment: NativeGuiEnrollment): Channel | undefined { return state(enrollment).channel; }
/** Sticky after enrollment: channel loss cannot silently choose legacy start. */
export function configuredNativeGuiOwner(): Owner | undefined { return installed?.owner; }

/** Read the already enrolled authenticated channel; never provisions credentials. */
export function configuredNativeGuiChannel(): Channel | undefined { return installed?.channel; }
