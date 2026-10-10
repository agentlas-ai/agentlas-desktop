import type { Writable } from "node:stream";
import { captureNativeAuthBinding, provisionNativeGuiCredential, nativeDaemonEnrollment, type NativeAuthBinding, type NativeCredential } from "../daemon/native-auth-credentials";
import { connectNativeGuiChannel, nativeAuthSocketPath, nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { userDataDir } from "../runtime-paths";
import { assertNativeGuiOwnerBootstrap, type createNativeGuiOwnerClient } from "./native-gui-owner";
import type { createNativeMainAuthCallbackAdapter } from "./native-main-auth-callback";

declare const enrolledGui: unique symbol;
export interface NativeGuiEnrollment { readonly [enrolledGui]: true }
type Channel = Awaited<ReturnType<typeof connectNativeGuiChannel>>;
type Owner = ReturnType<typeof createNativeGuiOwnerClient>;
type Adapter = ReturnType<typeof createNativeMainAuthCallbackAdapter>;
export type NativeGuiCapabilities = Readonly<{ start: boolean; stop: boolean; events: boolean; approvals: boolean; recovery: boolean }>;
type Attachment = Readonly<{ ready: boolean; capabilities: NativeGuiCapabilities; identity: NativeAuthenticatedIdentity }>;
export interface NativeGuiAttachHooks {
  onAuthenticated?(channel: Channel, identity: NativeAuthenticatedIdentity): void;
}
interface State { binding: NativeAuthBinding; credential: NativeCredential; wire: string; written: boolean; channel?: Channel; identity?: NativeAuthenticatedIdentity; capabilities?: NativeGuiCapabilities; ready?: boolean; adapter?: Adapter; owner?: Owner; attachBoot?: string; attachment?: Promise<Attachment> }
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
  enrollments.set(enrollment, { binding, credential, wire, written: false });
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
/** Public ping supplies discovery only. The boot becomes trusted solely after
 * the actual enrolled signature and strict native.attach transcript agree. */
export function attachNativeGuiDaemon(enrollment: NativeGuiEnrollment, discoveredBootId: string,
  onEvent?: (method: string, params: unknown) => void, hooks?: NativeGuiAttachHooks): Promise<Attachment> {
  const value = state(enrollment);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(discoveredBootId)) fail("native_gui_boot_discovery_invalid");
  if (value.attachment) {
    if (value.attachBoot !== discoveredBootId) fail("native_gui_original_boot_required");
    return value.attachment.then(result => {
      if (!value.channel || nativeGuiChannelIdentity(value.channel) !== result.identity) fail("native_gui_original_channel_unavailable");
      return result;
    });
  }
  value.attachBoot = discoveredBootId;
  // Retain the actual first attempt synchronously. Neither concurrent ensures
  // nor a lost ACK can create a second handshake or adopt another boot.
  const attachment = (async () => {
    const channel = await connectNativeGuiChannel({ address: nativeAuthSocketPath(userDataDir()), binding: value.binding,
      credential: value.credential, bootId: discoveredBootId, onEvent,
      onRequest(method, raw, identity) { if (!value.adapter) fail("native_gui_callback_not_initialized"); return value.adapter.onRequest(method, raw, identity); } });
    value.channel = channel;
    try {
      const identity = nativeGuiChannelIdentity(channel); if (!identity) fail("native_gui_enrolled_channel_required");
      value.identity = identity;
      hooks?.onAuthenticated?.(channel, identity);
      if (nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable");
      const handoff = (await import("../auth")).sessionForDaemonHandoff();
      const session = handoff === null ? null : Object.fromEntries(Object.entries(handoff).filter(([, field]) => field !== undefined));
      const reply = await channel.dispatch("native.attach", { version: "agentlas.native-attach.v1", session });
      if (nativeGuiChannelIdentity(channel) !== identity || !exact(reply, ["version", "bootId", "serviceIdentity", "ready", "capabilities"])
        || reply.version !== "agentlas.native-attach.v1" || reply.bootId !== identity.bootId || reply.serviceIdentity !== identity.serviceIdentity
        || typeof reply.ready !== "boolean" || !exact(reply.capabilities, ["start", "stop", "events", "approvals", "recovery"])
        || Object.values(reply.capabilities).some(flag => typeof flag !== "boolean")) fail("native_gui_attach_reply_invalid");
      const capabilities = Object.freeze({ ...reply.capabilities }) as NativeGuiCapabilities;
      value.capabilities = capabilities; value.ready = reply.ready;
      return Object.freeze({ ready: reply.ready && Object.values(capabilities).every(flag => flag === true), capabilities, identity });
    } catch (error) { channel.close(); throw error; }
  })();
  value.attachment = attachment;
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
/** Negative revocation only, validated against the actual original native objects.
 * It cannot restore capability or cause a legacy downgrade. Stop is unaffected. */
export function revokeNativeGuiStartAvailability(enrollment: NativeGuiEnrollment, channel: object, identity: NativeAuthenticatedIdentity): void {
  const value = state(enrollment);
  if (value.channel !== channel || value.identity !== identity || nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_required");
  value.ready = false;
}
export function nativeGuiEnrollmentChannel(enrollment: NativeGuiEnrollment): Channel | undefined { return state(enrollment).channel; }
/** Sticky after enrollment: channel loss cannot silently choose legacy start. */
export function configuredNativeGuiOwner(): Owner | undefined { return installed?.owner; }

/** Read the already enrolled authenticated channel; never provisions credentials. */
export function configuredNativeGuiChannel(): Channel | undefined { return installed?.channel; }
