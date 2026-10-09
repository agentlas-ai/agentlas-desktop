import { registerSupervisorNativeRelay } from "../one/supervisor-native-relay";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import type { McpInvocationRequest } from "../../shared/types";
import type { InvocationService, InvocationStartResult } from "../invocation/service";
import { createNativeInvocationIngressSources, validateNativeIngressRequest, type NativeIngressBinding, type NativeIngressIdentity, type NativeInvocationIngressSource } from "../invocation/native-ingress-source";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { invocationProcessOwner } from "../store/invocation-run-owners";
import type { ControlSocketPeer } from "./control-socket";
import { assertNativeAuthBinding, type NativeAuthBinding } from "./native-auth-credentials";
import type { NativeAuthenticatedIdentity } from "./native-session-auth";
import { makeNativePreparationWireRequest, nativeStartDescriptor, sameNativeStartBinding, type NativePreparationWireRequest, type NativeStartDescriptor } from "./native-start-protocol";
import { importNativeJsonValue } from "./native-json-transfer";
import { importNativeWorkImages, type NativeWorkImageChunk, type NativeWorkImageDescriptor } from "./native-image-transport";
import { importNativeOneInlineImages, type NativeOneInlineImageDescriptor, type NativeOneInlineImageChunk } from "./native-one-inline-images";
import { createNativePreparationControl, type NativePreparationControl } from "./native-preparation-control";
import { createDaemonNativePreparationPort } from "./native-preparation-port";

interface TerminalPort { dispatch(request: NativePreparationWireRequest): Promise<unknown> }
interface ClosedIngressPort { dispatch(request: NativePreparationWireRequest, proof: object): Promise<unknown> }
export interface NativeInvocationHostTransport {
  authenticatedPeerIdentity(peer: ControlSocketPeer): NativeAuthenticatedIdentity | undefined;
  request(peer: ControlSocketPeer, method: "native.checkpoint", request: NativePreparationWireRequest): Promise<unknown>;
  createTerminalCheckpointPort(peer: ControlSocketPeer, start: NativeStartDescriptor): TerminalPort;
  createIngressNoStartPort(peer: ControlSocketPeer, start: NativeStartDescriptor): ClosedIngressPort;
  createServiceObservationPort(peer: ControlSocketPeer, start: NativeStartDescriptor): ClosedIngressPort;
}
interface RecordState {
  peer: ControlSocketPeer;
  identity: NativeAuthenticatedIdentity;
  ingressIdentity: Readonly<NativeIngressIdentity>;
  binding: Readonly<NativeIngressBinding>;
  start: NativeStartDescriptor;
  issuer: object;
  source?: NativeInvocationIngressSource;
  control: NativePreparationControl;
  observation: ClosedIngressPort;
  authorized: boolean;
  released: boolean;
  physicallyReleased: boolean;
  ingressDone: boolean;
  releaseSupervisor?:()=>void;
}
function denied(code: string): never { throw Object.assign(new Error(code), { code }); }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}

/** Closed native daemon bootstrap. The caller opens the exact follower store,
 * configures its immutable daemon owner/auth/install, and wins the socket fence
 * before importing this host. No public control socket, model tool or CLI brain
 * invokes this constructor, and no wire field selects an execution owner. */
export function createDaemonNativeInvocationHost(options: {
  binding: NativeAuthBinding;
  bootId: string;
  service: InvocationService;
  transport: NativeInvocationHostTransport;
  assertSocketFence(): void;
  /** Explicit transfer resource admission; not original product content caps
   * and not a whole-process heap ceiling. The host supplies these limits. */
  maxTransferBytes: number;
  maxRecords: number;
  onCustodyReleased?(start: NativeStartDescriptor): void;
}) {
  for (const value of [options.maxTransferBytes, options.maxRecords]) if (!Number.isSafeInteger(value) || value < 1) denied("native_host_capacity_invalid");
  function bootstrapCurrent(): void {
    assertNativeAuthBinding(options.binding); options.assertSocketFence();
    const owner = invocationProcessOwner();
    if (owner.ownerKind !== "daemon" || owner.ownerId !== options.bootId) denied("native_host_process_owner_changed");
  }
  bootstrapCurrent();
  const records = new Map<string, RecordState>(), originalIssuers = new WeakMap<object, RecordState>();
  const proofs = new WeakMap<object, RecordState>();
  let receivingBytes = 0;
  function releaseIfComplete(r: RecordState): void {
    if (r.released || !r.physicallyReleased || !r.ingressDone || records.get(r.start.handle) !== r) return;
    r.releaseSupervisor?.();r.released = true; records.delete(r.start.handle);
    try { options.onCustodyReleased?.(r.start); } catch (error) { console.warn("[native-invocation] custody release observer failed", error); }
  }
  function current(r: RecordState): void {
    bootstrapCurrent();
    if (r.released || options.transport.authenticatedPeerIdentity(r.peer) !== r.identity) denied("native_host_channel_changed");
  }
  function registered(channel: object, originalIssuer: object): RecordState {
    const r = originalIssuers.get(originalIssuer);
    if (!r || channel !== r.peer || records.get(r.start.handle) !== r) denied("native_host_original_issuer_required");
    current(r); return r;
  }
  function reserved(r: RecordState): void {
    const row = getInvocationAdmission(r.binding.runId);
    if (!row || row.chatId !== r.binding.chatId || row.inputDigest !== r.binding.inputDigest || row.ownerProcessEpoch !== options.bootId || row.status !== "pending") denied("native_host_reservation_required");
  }
  async function json(r: RecordState, value: unknown, kind: "original-request" | "checkpoint-value", signal: AbortSignal): Promise<unknown> {
    // Byte length is data from the exact captured signed source callback. It
    // acquires buffer capacity only; it grants no admission or claim authority.
    if (!value || typeof value !== "object" || !Number.isSafeInteger((value as { byteLength?: unknown }).byteLength)) denied("native_host_transfer_invalid");
    const count = (value as { byteLength: number }).byteLength;
    if (count < 1 || count > options.maxTransferBytes - receivingBytes) denied("native_host_transfer_capacity");
    receivingBytes += count;
    try { return await importNativeJsonValue(value, { kind, maxBytes: count, signal, assertCurrent: () => current(r), read: (transferId, offset) => r.control.request("json.read", { transferId, offset }) }); }
    finally { receivingBytes -= count; }
  }
  const sources = createNativeInvocationIngressSources({
    authenticatedIdentity(channel) {
      const identity = options.transport.authenticatedPeerIdentity(channel as ControlSocketPeer);
      const r = [...records.values()].find(item => item.peer === channel && item.identity === identity && !item.released);
      return r?.ingressIdentity;
    },
    captureOriginalMainHandle(channel, identity, originalIssuer) {
      const r = registered(channel, originalIssuer);
      if (identity.peer !== r.identity || identity.generation !== r.identity.generation || identity.bootId !== options.bootId) denied("native_host_issuer_identity_changed");
      reserved(r); return r.binding;
    },
    async authorize(channel, originalIssuer, binding, signal) {
      const r = registered(channel, originalIssuer); signal.throwIfAborted(); reserved(r);
      if (r.authorized || !sameNativeStartBinding(binding, r.start.binding)) denied("native_host_authorization_replayed");
      // Burn before actual Main activation. A lost reply cannot activate again.
      r.authorized = true;
      await r.control.request("issuer.authorize", {});
      signal.throwIfAborted(); current(r); reserved(r);
      const proof = Object.freeze({}); proofs.set(proof, r); return proof;
    },
    consumeVerifiedOriginalMainIssuer(identity, binding, proof) {
      const r = proofs.get(proof); proofs.delete(proof);
      if (!r || identity.peer !== r.identity || !sameNativeStartBinding(binding, r.start.binding) || !r.authorized) denied("native_host_verified_issuer_required");
      current(r); reserved(r);
    },
    async read(channel, originalIssuer, binding, signal) {
      const r = registered(channel, originalIssuer), descriptor = await r.control.request("request.snapshot", {});
      const packet = await json(r, descriptor, "original-request", signal);
      if (!packet || typeof packet !== "object" || Array.isArray(packet)) denied("native_host_original_request_invalid");
      const packetValue = packet as Record<string, unknown>;
      const {hostNoticePurpose,supervisorHost,...p}=packetValue;
      if(supervisorHost!==undefined && supervisorHost!==true)denied("native_host_supervisor_source_invalid");
      if(hostNoticePurpose!==undefined && !["one-dispatch-brief","one-delegation-review","one-checkin"].includes(String(hostNoticePurpose)))denied("native_host_notice_purpose_invalid");
      if (!(exact(p, ["request", "hadImages"]) || exact(p, ["request", "hadImages", "workImages"]) || exact(p, ["request", "hadImages", "oneInlineImages"])) || typeof p.hadImages !== "boolean"
        || !p.request || typeof p.request !== "object" || Array.isArray(p.request)) denied("native_host_original_request_invalid");
      let request = p.request as McpInvocationRequest;
      if (p.hadImages) {
        if (!Array.isArray(request.images)) denied("native_host_image_origin_invalid");
        if (request.oneMode === true) {
          if (!Array.isArray(p.oneInlineImages) || Object.hasOwn(p, "workImages")) denied("native_host_image_origin_invalid");
          const images = await importNativeOneInlineImages(request.images as unknown as Readonly<Record<string, unknown>>[], p.oneInlineImages as NativeOneInlineImageDescriptor[], async payload => {
            current(r); const chunk = await r.control.request("one.inline.image.read", payload); current(r); return chunk as NativeOneInlineImageChunk;
          }, signal);
          request = { ...request, images };
        } else {
          const work = p.workImages;
          if (!exact(work, ["handle", "binding", "images"]) || !Array.isArray(work.images) || !sameNativeStartBinding(work.binding as NativeStartDescriptor["binding"], r.start.binding) || Object.hasOwn(p, "oneInlineImages")) denied("native_host_image_origin_invalid");
          const images = await importNativeWorkImages(work.images as NativeWorkImageDescriptor[], async payload => {
            current(r); const chunk = await r.control.request("work.image.read", payload); current(r); return chunk as NativeWorkImageChunk;
          }, signal);
          // Common service count8 and original mixed-source precedence still
          // apply after the actual issuer-selected input origin reconstruction.
          request = { ...request, images };
        }
      } else if (Object.hasOwn(request, "images") || Object.hasOwn(p, "workImages") || Object.hasOwn(p, "oneInlineImages")) denied("native_host_image_origin_invalid");
      const admission = validateNativeIngressRequest(binding, request);
      const port = createDaemonNativePreparationPort({ start: r.start, request, admission, importCheckpointValue: (value, checkpointSignal) => json(r, value, "checkpoint-value", checkpointSignal), assertCurrent: () => current(r), control: r.control,
        claimAttachments: payload => {
          current(r); if (!r.source) denied("native_host_original_source_required");
          const proof = options.service.takeNativeServiceObservationProof(r.source, "native-execution-cwd-selected-v1");
          if (!proof) denied("native_host_service_observation_required");
          return r.observation.dispatch(makeNativePreparationWireRequest(r.start, "checkpoint", { kind: "attachments.claim", payload }), proof);
        } });
      if(supervisorHost===true && request.oneMode===true)r.releaseSupervisor=registerSupervisorNativeRelay(request.chatId,binding.runId,(name,input)=>r.control.request('supervisor.command',{name,input}));
      return { request, port, ...(hostNoticePurpose?{hostNoticePurpose:hostNoticePurpose as SupervisorHostNoticePurpose}:{}) };
    },
    cancel(channel, originalIssuer) { return registered(channel, originalIssuer).control.cancel(); },
    quiesce(channel, originalIssuer) { return registered(channel, originalIssuer).control.quiesce("uncertain"); },
    async finish(channel, originalIssuer, _binding, status) {
      const r = registered(channel, originalIssuer);
      // The actual service, not a missing receipt or transport flag, owns this
      // narrow closed frontier. Prepared entry permanently denies its token.
      if (status !== "handed-off" && !r.control.preparationCompleted && r.source) {
        const proof = options.service.takeNativeIngressNoStartProof(r.source);
        await r.control.rejectBeforePrepared(proof);
      }
      await r.control.finish(status);
    },
  });
  function start(peer: ControlSocketPeer, input: unknown): Promise<InvocationStartResult> {
    bootstrapCurrent();
    const identity = options.transport.authenticatedPeerIdentity(peer), descriptor = nativeStartDescriptor(input);
    if (!identity || identity.scope !== options.binding.scope || identity.serviceIdentity !== options.binding.serviceIdentity || identity.bootId !== options.bootId) denied("native_host_authenticated_main_required");
    if (records.has(descriptor.handle) || [...records.values()].some(r => r.binding.runId === descriptor.binding.runId)) denied("native_host_original_start_replayed");
    if (records.size >= options.maxRecords) denied("native_host_record_capacity");
    const binding = Object.freeze({ ...descriptor.binding, ownerProcessEpoch: options.bootId });
    const issuer = Object.freeze({}), terminal = options.transport.createTerminalCheckpointPort(peer, descriptor), rejection = options.transport.createIngressNoStartPort(peer, descriptor);
    const r: RecordState = { peer, identity, ingressIdentity: Object.freeze({ peer: identity, generation: identity.generation, serviceIdentity: identity.serviceIdentity, bootId: identity.bootId, ownerId: options.bootId, storeIdentity: identity.scope }), binding, start: descriptor, issuer,
      control: undefined as unknown as NativePreparationControl, observation: options.transport.createServiceObservationPort(peer, descriptor), authorized: false, released: false, physicallyReleased: false, ingressDone: false };
    r.control = createNativePreparationControl({ start: descriptor, assertCurrent: () => current(r), ordinary: wire => options.transport.request(peer, "native.checkpoint", wire), terminal: wire => {
      if (wire.action === "finish" && r.source) {
        const proof = options.service.takeNativeServiceObservationProof(r.source, "native-undispatched-start-v1");
        if (proof) return r.observation.dispatch(wire, proof);
      }
      return terminal.dispatch(wire);
    }, rejectClosedIngress: (wire, proof) => rejection.dispatch(wire, proof), onReleased: () => { r.physicallyReleased = true; releaseIfComplete(r); } });
    reserved(r); records.set(descriptor.handle, r); originalIssuers.set(issuer, r);
    r.source = sources.issue(peer, issuer);
    // InvocationService registers its one controller/lifetime/active projection
    // synchronously before the first authorize/read await, then runs the original
    // start generator and all AI adapters. No surrogate early run ID is returned.
    const actual = options.service.startNativeIngress(r.source);
    const settled = () => { r.ingressDone = true; releaseIfComplete(r); };
    void actual.then(settled, settled);
    return actual;
  }
  function consumeIngressNoStartProof(peer: ControlSocketPeer, input: NativeStartDescriptor, wire: NativePreparationWireRequest, proof: unknown) {
    const r = records.get(input.handle);
    if (!r || r.peer !== peer || !r.source || wire.start.handle !== r.start.handle || wire.action !== "ingress.reject" || !exact(wire.payload, []) || !sameNativeStartBinding(input.binding, r.start.binding) || !sameNativeStartBinding(wire.start.binding, r.start.binding)) denied("native_host_frontier_binding_invalid");
    current(r);
    if (!proof || typeof proof !== "object") denied("native_host_frontier_proof_required");
    return options.service.consumeNativeIngressNoStartProof(r.source, proof);
  }
  function consumeServiceObservationProof(peer: ControlSocketPeer, input: NativeStartDescriptor, wire: NativePreparationWireRequest, proof: unknown) {
    const r = records.get(input.handle);
    if (!r || r.peer !== peer || !r.source || wire.start.handle !== r.start.handle || !sameNativeStartBinding(input.binding, r.start.binding) || !sameNativeStartBinding(wire.start.binding, r.start.binding)) denied("native_host_service_observation_binding_invalid");
    current(r); if (!proof || typeof proof !== "object") denied("native_host_service_observation_proof_required");
    return options.service.consumeNativeServiceObservationProof(r.source, proof);
  }
  function cancelCaptured(peer: ControlSocketPeer, input: unknown) {
    const descriptor = nativeStartDescriptor(input), r = records.get(descriptor.handle);
    if (!r || peer !== r.peer || !sameNativeStartBinding(descriptor.binding, r.start.binding)) denied("native_host_stop_binding_invalid");
    // Native channel validation still applies; run/row/status never gate the
    // actual owned AbortController after a valid captured Stop.
    current(r); return options.service.cancel(r.binding.runId);
  }
  return { start, cancelCaptured, consumeIngressNoStartProof, consumeServiceObservationProof,
    get retainedRecordCount() { return records.size; }, get receivingBytes() { return receivingBytes; } };
}
