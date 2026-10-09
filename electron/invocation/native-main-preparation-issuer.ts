import { createHash, randomUUID } from "node:crypto";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import type { McpInvocationRequest } from "../../shared/types";
import { canonicalInvocationRequestJson, decideInvocationAdmission, getInvocationAdmission, INVOCATION_ADMISSION_DIGEST_VERSION, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { getDb } from "../store/db";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import { takeMainInvocationAdmission, type MainInvocationAdmission } from "../runtime/scheduled-root-context";
import { createNativePreparationLifetime, withNativePreparationLifetime, runNativePreparation, type NativePreparationLifetime } from "../runtime/native-preparation-lifetime";
import { createNativeOneCapabilityBroker, type NativeOneChannelIdentity, type NativeOneProducer, type NativeOneCapabilityCapsule, type NativeOneCapabilityRefs } from "../one/native-capability-broker";
import { releaseOneAttachmentRun } from "../one/attachments";
import { failOneTeamPreflightStart } from "../one/team-preflight";
import { createNativeWorkImageSnapshots, type NativeWorkImageSnapshot } from "./native-work-image-snapshots";
import { captureNativeOneInlineImages } from "../daemon/native-one-inline-images";
import type { NativeOneStartCheckpointKind } from "./native-start-checkpoints";

export interface NativeMainPreparationBinding { readonly chatId: string; readonly runId: string; readonly inputDigest: string }
export interface NativeMainPreparationHandle { readonly preparation: unique symbol }
export interface NativeMainPreparationCheckpoint {
  readonly requestId: string;
  readonly kind: Exclude<NativeOneStartCheckpointKind, "judge" | "preparation.handoff">;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface NativeMainPreparationIssuerPorts {
  /** The real native top-frame/window guard AND explicit isAppControlEvent denial. */
  authorizeRenderer(event: object): object | null;
  /** Private durable Supervisor source, never a renderer event or wire flag. */
  authorizeHost?(origin: object, request: Readonly<McpInvocationRequest>): object | null;
  hostNoticePurpose?(origin: object, request: Readonly<McpInvocationRequest>): SupervisorHostNoticePurpose | undefined;
  supervisorCommand?(origin:object,request:Readonly<McpInvocationRequest>,name:string,input:Record<string,unknown>):Promise<unknown>;
  /** Adapter over nativeGuiChannelIdentity(actualChannel), never a JSON/PID claim. */
  nativeChannelIdentity(channel: object): Readonly<NativeOneChannelIdentity> | null;
  getRunOwner(chatId: string, runId: string): InvocationRunOwner | null;
  /** Actual server reservation, exact canonical input and daemon boot. */
  assertReservation(admission: Readonly<InvocationAdmissionIdentity>): void;
  /** Exact daemon-selected original execution cwd, not an arbitrary wire path. */
  assertExecutionCwd(binding: Readonly<NativeMainPreparationBinding>, cwd: string): void;
  /** Actual private rejected-before-handoff proof plus durable providerDispatched:false. */
  assertNoBrainDispatch(binding: Readonly<NativeMainPreparationBinding>, leaseId: string): void;
  /** Consumes actual closed Root ingress proof; copied/JSON proof is not authority. */
  consumeVerifiedNativeIngressNoStart(binding: Readonly<NativeMainPreparationBinding>, proof: object): void;
  maxPending?: number;
}
export class NativeMainPreparationError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new NativeMainPreparationError(code); }
const digest = (json: string) => createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(json).digest("hex");
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => comparable(item) ?? null);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => [key, comparable((value as Record<string, unknown>)[key])]));
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
// Match existing JSON snapshot shape while retaining immutable primitive image
// strings; do not stringify/parse multi-megabyte base64 just to clone the request.
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(Array.from(value, item => snapshot(item) ?? null));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, snapshot(item)])));
  return value;
}
interface Completed { kind: string; payload: string; value?: unknown; error?: unknown; pending?: Promise<unknown> }
interface PreparationRecord {
  handle: string; channel: object; identity: Readonly<NativeOneChannelIdentity>; sender: object;
  request: Readonly<McpInvocationRequest>; admission: Readonly<InvocationAdmissionIdentity>; binding: Readonly<NativeMainPreparationBinding>;
  refs: NativeOneCapabilityRefs; producer: NativeOneProducer; capsule?: NativeOneCapabilityCapsule; work?: NativeWorkImageSnapshot; inlineOne?: ReturnType<typeof captureNativeOneInlineImages>;
  lifetime: NativePreparationLifetime; controller: AbortController; done: Promise<void>; resolveDone(): void;
  requests: Map<string, Completed>; kinds: Set<string>; handedOff: boolean; activated: boolean; busy: boolean; uncertain: boolean; closed: boolean; finished: boolean;
  failTeam: boolean; releaseAttachments: boolean; teamFailed: boolean;
  leaseId?: string;
  hostOrigin?: object;
  hostNoticePurpose?: SupervisorHostNoticePurpose;
  attachmentTransfer?: ReturnType<ReturnType<typeof createNativeOneCapabilityBroker>["claimAttachments"]>;
}

/** Main-only issuer/checkpoint adapter. Transport routing and signing stay outside this module. */
export function createNativeMainPreparationIssuer(ports: NativeMainPreparationIssuerPorts) {
  const broker = createNativeOneCapabilityBroker(ports);
  const records = new WeakMap<NativeMainPreparationHandle, PreparationRecord>();
  const handles = new Map<string, NativeMainPreparationHandle>();
  const byRun = new Map<string, PreparationRecord>();
  const work = createNativeWorkImageSnapshots({
    authorizeRenderer: ports.authorizeRenderer, nativeChannelIdentity: ports.nativeChannelIdentity,
    fingerprintRequest(request) { const canonicalRequestJson = canonicalInvocationRequestJson(request); return { canonicalRequestJson, inputDigest: digest(canonicalRequestJson) }; },
    assertBeforeStart(binding) { const r = byRun.get(binding.runId); if (!r || !equal(r.binding, binding)) fail("native_main_preparation_binding_changed"); assertPending(r); },
    maxPending: ports.maxPending,
  });
  const sameIdentity = (a: Readonly<NativeOneChannelIdentity>, b: Readonly<NativeOneChannelIdentity>) => a.peer === b.peer && a.generation === b.generation && a.serviceIdentity === b.serviceIdentity && a.bootId === b.bootId && a.ownerId === b.ownerId && a.storeIdentity === b.storeIdentity;
  function current(r: PreparationRecord, channel = r.channel, terminalIntent = false) {
    const identity = ports.nativeChannelIdentity(channel);
    if (channel !== r.channel || !identity || !sameIdentity(identity, r.identity)) fail("native_main_preparation_channel_changed");
    if (!terminalIntent && (r.closed || r.controller.signal.aborted)) fail("native_main_preparation_cancelled");
    if (!terminalIntent && r.hostOrigin && !r.handedOff && ports.authorizeHost?.(r.hostOrigin,r.request)!==r.sender) fail("native_main_preparation_host_authority_changed");
    if (!terminalIntent && r.uncertain) fail("native_main_preparation_uncertain");
  }
  function record(handle: NativeMainPreparationHandle): PreparationRecord { const r = records.get(handle); if (!r) fail("native_main_preparation_required"); return r; }
  function assertPending(r: PreparationRecord) {
    ports.assertReservation(r.admission);
    const a = getInvocationAdmission(r.binding.runId);
    if (!a || a.status !== "pending" || a.chatId !== r.binding.chatId || a.inputDigest !== r.binding.inputDigest || a.ownerProcessEpoch !== r.identity.bootId) fail("native_main_preparation_pending_required");
    if (getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(r.binding.runId)) fail("native_main_preparation_already_started");
  }
  function ensureCapsule(r: PreparationRecord) {
    if (!r.capsule) {
      if (Object.keys(r.refs).length === 0) fail("native_main_preparation_reference_required");
      r.capsule = broker.prepare(r.producer, { ...r.binding, userPrompt: r.request.userPrompt }, r.refs);
    }
    return r.capsule;
  }
  function issue(input: { event: object; hostOrigin?: object; channel: object; request: McpInvocationRequest; mainAdmission: MainInvocationAdmission | undefined; admission: InvocationAdmissionIdentity }): NativeMainPreparationHandle {
    // Burn even if a later guard refuses this attempted transfer.
    const admission = takeMainInvocationAdmission(input.mainAdmission, { chatId: input.request.chatId, runId: input.request.runId });
    if (!admission) fail("native_main_preparation_admission_required");
    const sender = input.hostOrigin ? ports.authorizeHost?.(input.hostOrigin,input.request) : ports.authorizeRenderer(input.event), identity = ports.nativeChannelIdentity(input.channel);
    if (!sender || typeof sender !== "object") fail("native_main_preparation_native_sender_required");
    if (!identity || identity.ownerId !== identity.bootId) fail("native_main_preparation_channel_required");
    const canonical = canonicalInvocationRequestJson(input.request);
    if (!input.request.runId || input.admission.runId !== input.request.runId || input.admission.chatId !== input.request.chatId || input.admission.canonicalRequestJson !== canonical || input.admission.ownerProcessEpoch !== identity.bootId) fail("native_main_preparation_binding_changed");
    if (handles.size >= (ports.maxPending ?? 32)) fail("native_main_preparation_capacity");
    if (byRun.has(input.request.runId)) fail("native_main_preparation_already_issued");
    const request = snapshot(input.request) as Readonly<McpInvocationRequest>;
    if (canonicalInvocationRequestJson(request) !== canonical) fail("native_main_preparation_binding_changed");
    const refs: NativeOneCapabilityRefs = {
      ...(request.oneTeamPreflightRef ? { team: request.oneTeamPreflightRef } : {}),
      ...(request.oneBriefingActionRef ? { briefing: request.oneBriefingActionRef } : {}),
      ...(request.oneMemoryUseOnceRef ? { memory: request.oneMemoryUseOnceRef } : {}),
      ...(request.oneAttachmentRef ? { attachments: request.oneAttachmentRef } : {}),
    };
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    // The consumed Main token is never used to create another execution root.
    const r: PreparationRecord = { handle: randomUUID(), channel: input.channel, identity: Object.freeze({ ...identity }), sender,
      hostOrigin: input.hostOrigin, hostNoticePurpose: input.hostOrigin ? ports.hostNoticePurpose?.(input.hostOrigin,request) : undefined, request, admission: Object.freeze({ ...input.admission }), binding: Object.freeze({ chatId: request.chatId, runId: request.runId!, inputDigest: digest(canonical) }), refs,
      producer: broker.enroll(input.channel), lifetime: createNativePreparationLifetime({}), controller: new AbortController(), done, resolveDone,
      requests: new Map(), kinds: new Set(), handedOff: false, activated: false, busy: false, uncertain: false, closed: false, finished: false, failTeam: false, releaseAttachments: false, teamFailed: false };
    assertPending(r);
    const handle = Object.freeze({}) as NativeMainPreparationHandle;
    records.set(handle, r); handles.set(r.handle, handle); byRun.set(r.binding.runId, r);
    try {
      if (request.oneMode === true && request.images !== undefined) r.inlineOne = captureNativeOneInlineImages(request.images);
      else if (request.oneMode !== true && request.images !== undefined) {
        if(input.hostOrigin)fail("native_host_work_image_origin_unsupported");
        r.work = work.issue(input.event, input.channel, request);
      }
    }
    catch (error) { handles.delete(r.handle); byRun.delete(r.binding.runId); r.closed = true; r.lifetime.closeAdmission(); r.resolveDone(); throw error; }
    return handle;
  }
  function projection(handle: NativeMainPreparationHandle) {
    const r = record(handle); current(r);
    const { images, ...requestWithoutImages } = r.request;
    // Original Work metadata is in the sealed Work descriptors/components; data never enters a frame.
    return Object.freeze({ handle: r.handle, binding: r.binding, admission: r.admission,
      request: freeze({ ...requestWithoutImages, ...(images !== undefined ? { images: images.map(({ data: _data, ...metadata }) => metadata) } : {}) }), ...(r.work ? { workImages: work.projection(r.work) } : {}), ...(r.inlineOne ? { oneInlineImages: r.inlineOne.descriptors } : {}),
      hadImages: images !== undefined, ...(r.hostOrigin?{supervisorHost:true}:{}), ...(r.hostNoticePurpose ? {hostNoticePurpose:r.hostNoticePurpose}: {}) });
  }
  function activate(handle: NativeMainPreparationHandle, channel: object, expected: NativeMainPreparationBinding) {
    const r = record(handle);
    if (r.activated) fail("native_main_preparation_already_activated");
    r.activated = true; // Uncertain/lost authorization ACK never permits a fresh grant.
    current(r, channel);
    if (!equal(r.binding, expected)) fail("native_main_preparation_binding_changed");
    assertPending(r);
    return projection(handle);
  }
  function resolve(channel: object, handle: string, expected: NativeMainPreparationBinding): NativeMainPreparationHandle {
    const value = handles.get(handle); if (!value) fail("native_main_preparation_required");
    const r = record(value); current(r, channel); if (!equal(r.binding, expected)) fail("native_main_preparation_binding_changed"); return value;
  }
  async function execute(handle: NativeMainPreparationHandle, step: NativeMainPreparationCheckpoint, channel: object): Promise<unknown> {
    const r = record(handle);
    const terminalIntent = step?.kind === "team.fail-start" || step?.kind === "attachments.release";
    current(r, channel, terminalIntent);
    if (!r.activated) fail("native_main_preparation_not_activated");
    if (!terminalIntent && r.lifetime.admissionClosed) fail("native_main_preparation_admission_closed");
    if (!step || !/^[A-Za-z0-9._:-]{1,200}$/.test(step.requestId) || !step.payload || typeof step.payload !== "object" || Array.isArray(step.payload)) fail("native_main_preparation_checkpoint_invalid");
    const fingerprint = JSON.stringify(comparable(step.payload)), prior = r.requests.get(step.requestId);
    if (prior) {
      if (prior.kind !== step.kind || prior.payload !== fingerprint) fail("native_main_preparation_request_conflict");
      if (prior.pending) fail("native_main_preparation_request_pending");
      if (prior.error !== undefined) fail("native_main_preparation_uncertain");
      return prior.value; // Immutable observation; no second claim.
    }
    if (r.busy || r.kinds.has(step.kind) || r.requests.size >= 24) fail("native_main_preparation_checkpoint_replayed");
    const item: Completed = { kind: step.kind, payload: fingerprint };
    r.requests.set(step.requestId, item); r.kinds.add(step.kind); r.busy = true;
    if (terminalIntent) {
      const name = step.kind === "team.fail-start" ? "team" : "attachments";
      if (!equal(step.payload.ref, r.refs[name])) { r.busy = false; fail("native_main_preparation_reference_changed"); }
      if (name === "team") r.failTeam = true; else r.releaseAttachments = true;
      item.value = Object.freeze({ cleanup: "deferred" as const }); r.busy = false; return item.value;
    }
    const operation = withNativePreparationLifetime(r.lifetime, () => runNativePreparation(async () => {
      if (["team.prepare", "briefing.prepare", "memory.prepare", "team.attachments-required", "attachments.claim"].includes(step.kind)) assertPending(r);
      const ref = (name: keyof NativeOneCapabilityRefs) => { if (!equal(step.payload.ref, r.refs[name])) fail("native_main_preparation_reference_changed"); };
      switch (step.kind) {
        case "team.prepare": ref("team"); if (step.payload.chatId !== r.binding.chatId) fail("native_main_preparation_binding_changed"); return broker.projection(r.producer, ensureCapsule(r)).team;
        case "briefing.prepare": ref("briefing"); if (step.payload.chatId !== r.binding.chatId) fail("native_main_preparation_binding_changed"); return broker.projection(r.producer, ensureCapsule(r)).briefing;
        case "memory.prepare": ref("memory"); if (step.payload.chatId !== r.binding.chatId) fail("native_main_preparation_binding_changed"); return broker.projection(r.producer, ensureCapsule(r)).memory;
        case "team.attachments-required": { const p = broker.projection(r.producer, ensureCapsule(r)); if (step.payload.proposalId !== p.team?.proposalId) fail("native_main_preparation_reference_changed"); return p.teamAttachmentsRequired; }
        case "attachments.claim": {
          ref("attachments");
          if (step.payload.chatId !== r.binding.chatId || step.payload.runId !== r.binding.runId || step.payload.userPrompt !== r.request.userPrompt || typeof step.payload.resultFolder !== "string") fail("native_main_preparation_binding_changed");
          const capsule = ensureCapsule(r), p = broker.projection(r.producer, capsule);
          if ((step.payload.teamProposalId ?? null) !== (p.team?.proposalId ?? null)) fail("native_main_preparation_reference_changed");
          ports.assertExecutionCwd(r.binding, step.payload.resultFolder);
          r.attachmentTransfer = broker.claimAttachments(r.producer, capsule, step.payload.resultFolder);
          return r.attachmentTransfer ? { ...r.attachmentTransfer, images: [] } : null;
        }
        case "team.claim": case "briefing.claim": case "memory.claim": {
          if (typeof step.payload.leaseId !== "string") fail("native_main_preparation_lease_required");
          assertActive(r, step.payload.leaseId);
          const claims = broker.claimAfterDurableStart(r.producer, ensureCapsule(r), step.payload.leaseId);
          return claims[step.kind.split(".")[0]];
        }
        case "images.transfer": {
          if (!r.attachmentTransfer || typeof step.payload.leaseId !== "string") fail("native_main_preparation_attachment_required");
          assertActive(r, step.payload.leaseId);
          if (!equal(step.payload.attachments, r.attachmentTransfer.receipt.attachments)) fail("native_main_preparation_attachment_changed");
          return r.attachmentTransfer.images;
        }
        default: return fail("native_main_preparation_checkpoint_unsupported");
      }
    }));
    item.pending = operation;
    try { const value = await operation; current(r, channel); item.value = value; return value; }
    catch (error) { item.error = error; r.uncertain = true; if (step.kind === "team.prepare" || step.kind === "team.claim") r.failTeam = true; throw error; }
    finally { item.pending = undefined; r.busy = false; }
  }
  function assertActive(r: PreparationRecord, leaseId: string) {
    const owner = ports.getRunOwner(r.binding.chatId, r.binding.runId), a = getInvocationAdmission(r.binding.runId);
    if (!owner || owner.chatId !== r.binding.chatId || owner.ownerKind !== "daemon" || owner.ownerId !== r.identity.bootId || owner.leaseId !== leaseId || owner.state !== "active" || !a || a.status !== "admitted" || a.chatId !== r.binding.chatId || a.inputDigest !== r.binding.inputDigest || a.ownerProcessEpoch !== r.identity.bootId) fail("native_main_preparation_durable_start_required");
    if (r.leaseId && r.leaseId !== leaseId) fail("native_main_preparation_lease_changed");
    r.leaseId = leaseId;
  }
  function readOneImageChunk(handle: NativeMainPreparationHandle, channel: object, request: { imageIndex: number; offset: number }) {
    const r = record(handle); current(r, channel); if (!r.activated) fail("native_main_preparation_not_activated"); return broker.readImageChunk(r.producer, ensureCapsule(r), request);
  }
  function readOneInlineImageChunk(handle: NativeMainPreparationHandle, channel: object, request: { imageIndex: number; offset: number }) {
    const r = record(handle); current(r, channel); if (!r.activated) fail("native_main_preparation_not_activated");
    if (!r.inlineOne) fail("native_main_preparation_inline_image_required");
    return r.inlineOne.read(request);
  }
  function readWorkImageChunk(handle: NativeMainPreparationHandle, channel: object, request: Parameters<ReturnType<typeof createNativeWorkImageSnapshots>["readChunk"]>[3]) {
    const r = record(handle); current(r, channel); if (!r.activated) fail("native_main_preparation_not_activated"); if (!r.work) fail("native_main_preparation_work_image_required");
    return work.readChunk(channel, work.projection(r.work).handle, r.binding, request);
  }
  function cancel(handle: NativeMainPreparationHandle) {
    const r = record(handle); r.closed = true; r.lifetime.closeAdmission(); r.controller.abort(new NativeMainPreparationError("native_main_preparation_cancelled"));
    if (r.work) work.cancel(r.work);
    if (r.inlineOne) r.inlineOne.cancel();
    if (r.capsule) { try { broker.cancel(r.producer, r.capsule); } catch { /* Private custody remains; unavailable channel is not settlement. */ } }
  }
  async function quiesce(handle: NativeMainPreparationHandle, _status: "handed-off" | "rejected" | "cancelled" | "uncertain") {
    const r = record(handle); r.lifetime.closeAdmission(); await r.lifetime.quiescent();
  }
  async function rejectNativeIngressBeforeStart(handle: NativeMainPreparationHandle, channel: object, proof: object) {
    const r = record(handle); current(r, channel, true);
    ports.consumeVerifiedNativeIngressNoStart(r.binding, proof);
    await quiesce(handle, "rejected");
    current(r, channel, true);
    assertPending(r);
    const owner = ports.getRunOwner(r.binding.chatId, r.binding.runId);
    if (owner && (owner.state !== "released" || owner.ownerKind !== "daemon" || owner.ownerId !== r.identity.bootId)) fail("native_main_preparation_rejection_required");
    const decision = decideInvocationAdmission({ ...r.admission, decision: "rejected",
      reasonCode: "native_ingress_rejected_before_start",
      noStartProof: { kind: "owner-start-boundary-not-crossed", verifiedOwnerProcessEpoch: r.identity.bootId } });
    if (decision.kind !== "rejected") fail("native_main_preparation_rejection_conflict");
    return Object.freeze({ state: "rejected-before-start" as const, binding: r.binding });
  }
  async function finish(handle: NativeMainPreparationHandle, status: "handed-off" | "rejected" | "cancelled" | "uncertain" | "settled") {
    const r = record(handle); if (r.finished) return Object.freeze({ state: "released" as const });
    await quiesce(handle, status === "settled" ? "handed-off" : status);
    const a = getInvocationAdmission(r.binding.runId), owner = ports.getRunOwner(r.binding.chatId, r.binding.runId);
    if (!a || a.chatId !== r.binding.chatId || a.inputDigest !== r.binding.inputDigest || a.ownerProcessEpoch !== r.identity.bootId) fail("native_main_preparation_settlement_required");
    if (a.status === "rejected") {
      // Actual monotonic server rejection wins even after an unknown transport ACK.
      if (!a.rejectionReasonCode || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(r.binding.runId) || (owner && (owner.state !== "released" || owner.ownerKind !== "daemon" || owner.ownerId !== r.identity.bootId))) fail("native_main_preparation_rejection_required");
    } else if (a.status === "admitted") {
      if (!owner || owner.chatId !== r.binding.chatId || owner.ownerKind !== "daemon" || owner.ownerId !== r.identity.bootId || (r.leaseId !== undefined && owner.leaseId !== r.leaseId)) fail("native_main_preparation_settlement_required");
      r.leaseId = owner.leaseId;
      if (owner.state === "active" && status === "handed-off") { r.handedOff = true; return Object.freeze({ state: "quiesced-retained" as const }); }
      if (owner.state !== "released") {
        if (status === "uncertain") { r.uncertain = true; return Object.freeze({ state: "retained-uncertain" as const }); }
        fail("native_main_preparation_settlement_required");
      }
      if (r.failTeam) ports.assertNoBrainDispatch(r.binding, owner.leaseId);
    } else {
      if (status === "uncertain") { r.uncertain = true; return Object.freeze({ state: "retained-uncertain" as const }); }
      fail("native_main_preparation_settlement_required");
    }
    if (r.failTeam && r.refs.team && !r.teamFailed) { failOneTeamPreflightStart(r.refs.team); r.teamFailed = true; }
    if (r.capsule) { if (a.status === "rejected") broker.releaseRejectedBeforeStart(r.capsule); else broker.releaseAfterSettlement(r.capsule); }
    else if (r.releaseAttachments && r.refs.attachments) releaseOneAttachmentRun(r.refs.attachments);
    if (r.work) work.release(r.work);
    if (r.inlineOne) r.inlineOne.release();
    r.closed = true; r.finished = true; handles.delete(r.handle); byRun.delete(r.binding.runId); r.resolveDone(); return Object.freeze({ state: "released" as const });
  }
  function disconnect(channel: object) {
    for (const r of byRun.values()) if (r.channel === channel) {
      if (r.handedOff) r.closed = true; // Presentation ends; independently owned daemon execution does not.
      else { cancel(recordsHandle(r)); r.uncertain = true; }
      broker.disconnect(r.producer);
    }
  }
  function recordsHandle(r: PreparationRecord) { const h = handles.get(r.handle); if (!h) fail("native_main_preparation_required"); return h; }
  function inspect(handle: NativeMainPreparationHandle) { const r = record(handle); return Object.freeze({ activated: r.activated, handedOff: r.handedOff, aborted: r.controller.signal.aborted, pendingCount: r.lifetime.pendingCount, admissionClosed: r.lifetime.admissionClosed, closed: r.closed, uncertain: r.uncertain, finished: r.finished, checkpointCount: r.requests.size }); }
  function settled(handle: NativeMainPreparationHandle): Promise<void> { return record(handle).done; }
  async function supervisorCommand(handle:NativeMainPreparationHandle,channel:object,name:string,input:Record<string,unknown>):Promise<unknown> {
    const r=record(handle);current(r,channel);
    if(!r.hostOrigin || !r.request.oneMode || !ports.supervisorCommand)fail("native_supervisor_original_source_required");
    return ports.supervisorCommand(r.hostOrigin,r.request,name,input);
  }
  return { supervisorCommand, issue, projection, activate, resolve, inspect, settled, execute, readOneImageChunk, readOneInlineImageChunk, readWorkImageChunk, cancel, quiesce, rejectNativeIngressBeforeStart, finish, disconnect };
}
