import { NATIVE_ONE_IMAGE_CHUNK_CHARS, type NativeOneImageChunk } from "../daemon/native-image-transport";
import { ONE_MEMORY_CONTRACT_VERSION } from "../../shared/one-memory";
import { randomUUID } from "node:crypto";
import { prepareOneTeamPreflightClaim, claimPreparedOneTeamPreflight, type PreparedOneTeamPreflightClaim } from "./team-preflight";
import { prepareOneBriefingActionClaim, claimPreparedOneBriefingAction, type PreparedOneBriefingActionClaim } from "./briefing-actions";
import { prepareOneMemoryUseOnceClaim, claimPreparedOneMemoryUseOnce, type PreparedOneMemoryUseOnceClaim } from "./memory-candidates";
import { prepareOneAttachmentClaim, teamProposalRequiresOneAttachments, claimPreparedOneAttachments, releasePreparedOneAttachments, type PreparedOneAttachmentClaim } from "./attachments";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { getDb } from "../store/db";
import { listRunEvents } from "../store/run-events";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { OneTeamPreflightRef } from "../../shared/one-team-preflight";
import type { OneBriefingActionRef } from "../../shared/one-briefing";
import type { OneMemoryUseOnceRef } from "../../shared/one-memory";
import type { OneAttachmentRef } from "../../shared/one-attachments";

/** Private Main bootstrap authorizes the actual channel, never serialized actor claims. */
export interface NativeOneChannelIdentity { peer: object; generation: string; serviceIdentity: string; bootId: string; ownerId: string; storeIdentity: string }
export interface NativeOneCapabilityBrokerPorts {
  nativeChannelIdentity(channel: object): Readonly<NativeOneChannelIdentity> | null;
  getRunOwner(chatId: string, runId: string): InvocationRunOwner | null;
  now?(): number;
  maxPending?: number;
}
export interface NativeOneCapabilityBinding { chatId: string; runId: string; userPrompt: string; inputDigest: string }
export interface NativeOneCapabilityRefs { team?: OneTeamPreflightRef; briefing?: OneBriefingActionRef; memory?: OneMemoryUseOnceRef; attachments?: OneAttachmentRef }
// These empty objects are deliberately process private. Their shape is no authority.
export interface NativeOneProducer { readonly producer: unique symbol }
export interface NativeOneCapabilityCapsule { readonly capsule: unique symbol }
type State = "prepared" | "attachments_claimed" | "claimed" | "uncertain" | "cancelled" | "released";
interface CapsuleRecord {
  producer: NativeOneProducer; identity: Readonly<NativeOneChannelIdentity>; binding: Readonly<NativeOneCapabilityBinding>; handle: string;
  team?: PreparedOneTeamPreflightClaim; briefing?: PreparedOneBriefingActionClaim; memory?: PreparedOneMemoryUseOnceClaim; attachments?: PreparedOneAttachmentClaim;
  teamAttachmentsRequired: boolean; state: State; cancelled: boolean; postClaimEntered: boolean; attachmentClaimEntered: boolean; claims: Record<string, unknown>; attachmentResult?: ReturnType<typeof claimPreparedOneAttachments>; executionCwd?: string; leaseId?: string; errorCode?: string; imageOffsets: Map<number, number>; lastChunks: Map<number, NativeOneImageChunk>;
}
export class NativeOneCapabilityError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new NativeOneCapabilityError(code); };
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim() === v && !/[\u0000-\u001f]/.test(v);
export function createNativeOneCapabilityBroker(ports: NativeOneCapabilityBrokerPorts) {
  const producers = new WeakMap<NativeOneProducer, { channel: object; identity: Readonly<NativeOneChannelIdentity>; connected: boolean }>();
  const capsules = new WeakMap<NativeOneCapabilityCapsule, CapsuleRecord>();
  const handles = new Map<string, NativeOneCapabilityCapsule>();
  function producer(proof: NativeOneProducer) {
    const r = producers.get(proof); if (!r || !r.connected) return fail("one_native_channel_unavailable");
    const current = ports.nativeChannelIdentity(r.channel);
    if (!current || current.peer !== r.identity.peer || current.generation !== r.identity.generation || current.bootId !== r.identity.bootId
      || current.serviceIdentity !== r.identity.serviceIdentity || current.ownerId !== r.identity.ownerId || current.storeIdentity !== r.identity.storeIdentity) return fail("one_native_channel_changed");
    return r;
  }
  function capsule(proof: NativeOneProducer, value: NativeOneCapabilityCapsule, claim = true) {
    producer(proof); const r = capsules.get(value); if (!r || r.producer !== proof) return fail("one_native_capability_unavailable");
    if (claim && (r.cancelled || r.state === "uncertain" || r.state === "released")) return fail(r.errorCode ?? "one_native_capability_closed");
    return r;
  }
  function enroll(channel: object): NativeOneProducer {
    const identity = ports.nativeChannelIdentity(channel);
    if (!identity || !identity.peer || ![identity.generation, identity.serviceIdentity, identity.bootId, identity.ownerId, identity.storeIdentity].every(id)) return fail("one_native_channel_required");
    const proof = Object.freeze({}) as NativeOneProducer; producers.set(proof, { channel, identity: Object.freeze({ ...identity }), connected: true }); return proof;
  }
  function prepare(proof: NativeOneProducer, binding: NativeOneCapabilityBinding, refs: NativeOneCapabilityRefs): NativeOneCapabilityCapsule {
    const p = producer(proof);
    if (handles.size >= (ports.maxPending ?? 128)) return fail("one_native_capability_capacity");
    if (Object.keys(binding).sort().join(",") !== "chatId,inputDigest,runId,userPrompt" || !id(binding.chatId) || !id(binding.runId)
      || typeof binding.userPrompt !== "string" || !binding.userPrompt.trim() || !/^[a-f0-9]{64}$/.test(binding.inputDigest)
      || !refs || Object.keys(refs).some(k => !["team", "briefing", "memory", "attachments"].includes(k)) || !Object.keys(refs).length) return fail("one_native_capability_invalid");
    if ((refs.team && (refs.briefing || refs.memory)) || (refs.briefing && (refs.memory || refs.attachments))) return fail("one_native_capability_combination_denied");
    const team = refs.team ? prepareOneTeamPreflightClaim(refs.team, binding.chatId) : undefined;
    const briefing = refs.briefing ? prepareOneBriefingActionClaim(refs.briefing, binding.chatId) : undefined;
    if ((team && (team.ref.reservedRunId !== binding.runId || team.userAuthoredPrompt !== binding.userPrompt))
      || (briefing && briefing.ref.reservedRunId !== binding.runId)) return fail("one_native_capability_binding_changed");
    const teamAttachmentsRequired = !!team && teamProposalRequiresOneAttachments(team.proposalId);
    if (teamAttachmentsRequired && !refs.attachments) return fail("one_native_attachment_required");
    const memory = refs.memory ? prepareOneMemoryUseOnceClaim(refs.memory, binding.chatId) : undefined;
    const attachments = refs.attachments ? prepareOneAttachmentClaim({ ref: refs.attachments, chatId: binding.chatId, userPrompt: binding.userPrompt, teamProposalId: team?.proposalId ?? null }) : undefined;
    const value = Object.freeze({}) as NativeOneCapabilityCapsule;
    const r: CapsuleRecord = { producer: proof, identity: p.identity, binding: Object.freeze({ ...binding }), handle: randomUUID(), team, briefing, memory, attachments, teamAttachmentsRequired,
      state: "prepared", cancelled: false, postClaimEntered: false, attachmentClaimEntered: false, claims: {}, imageOffsets: new Map(), lastChunks: new Map() };
    capsules.set(value, r); handles.set(r.handle, value); return value;
  }
  function resolve(proof: NativeOneProducer, handle: string): NativeOneCapabilityCapsule {
    producer(proof); const value = handles.get(handle); if (!value) return fail("one_native_capability_unavailable"); capsule(proof, value, false); return value;
  }
  function projection(proof: NativeOneProducer, value: NativeOneCapabilityCapsule) {
    const r = capsule(proof, value, false);
    return Object.freeze({ handle: r.handle, binding: r.binding, teamAttachmentsRequired: r.teamAttachmentsRequired, team: r.team && Object.freeze({ ...r.team }), briefing: r.briefing && Object.freeze({ ...r.briefing }),
      // The Main-only claim token NEVER leaves this process.
      memory: r.memory && Object.freeze({ context: r.memory.context, receiptId: r.memory.receiptId, candidateId: r.memory.candidateId, candidateVersion: r.memory.candidateVersion, binding: r.memory.binding }),
      attachments: r.attachments && r.attachments.receipt });
  }
  function attachmentProjection(r: CapsuleRecord) {
    const value = r.attachmentResult; if (!value) return fail("one_native_claim_uncertain");
    const imageItems = value.receipt.attachments.filter(item => item.kind === "image");
    if (imageItems.length !== value.images.length) return fail("one_native_image_metadata_invalid");
    return Object.freeze({ ref: value.ref, receipt: value.receipt, runtimeContext: value.runtimeContext, redactions: value.redactions,
      images: Object.freeze(value.images.map((image, imageIndex) => { const item = imageItems[imageIndex];
        if (image.name !== item.name || image.mediaType !== item.mediaType) return fail("one_native_image_metadata_invalid");
        return Object.freeze({ imageIndex, name: item.name, mediaType: item.mediaType, byteLength: item.size, base64Length: image.data.length, digest: item.digest }); })) });
  }
  function readImageChunk(proof: NativeOneProducer, value: NativeOneCapabilityCapsule, request: { imageIndex: number; offset: number }): NativeOneImageChunk {
    const r = capsule(proof, value); if (!r.attachmentResult) return fail("one_native_attachment_claim_required");
    if (!request || Object.keys(request).sort().join(",") !== "imageIndex,offset" || !Number.isSafeInteger(request.imageIndex)
      || !Number.isSafeInteger(request.offset) || request.imageIndex < 0 || request.offset < 0) return fail("one_native_image_offset_invalid");
    const descriptor = attachmentProjection(r).images[request.imageIndex]; if (!descriptor) return fail("one_native_image_offset_invalid");
    const cached = r.lastChunks.get(request.imageIndex); if (cached?.offset === request.offset) return cached; // read-only observation; never claim again
    const expected = r.imageOffsets.get(request.imageIndex) ?? 0;
    if (request.offset !== expected || request.offset >= descriptor.base64Length) return fail("one_native_image_offset_invalid");
    const data = r.attachmentResult.images[request.imageIndex].data.slice(request.offset, request.offset + NATIVE_ONE_IMAGE_CHUNK_CHARS);
    if (!data) return fail("one_native_image_chunk_empty");
    const nextOffset = request.offset + data.length;
    const chunk = Object.freeze({ ...descriptor, offset: request.offset, nextOffset, done: nextOffset === descriptor.base64Length, data });
    if (Buffer.byteLength(JSON.stringify(chunk), "utf8") > 256 * 1024) return fail("one_native_image_chunk_too_large");
    r.imageOffsets.set(request.imageIndex, nextOffset); r.lastChunks.set(request.imageIndex, chunk); return chunk;
  }
  function claimAttachments(proof: NativeOneProducer, value: NativeOneCapabilityCapsule, executionCwd: string) {
    const r = capsule(proof, value); if (!r.attachments) return null;
    if (r.executionCwd !== undefined && r.executionCwd !== executionCwd) return fail("one_native_execution_cwd_changed");
    if (r.attachmentClaimEntered) return r.attachmentResult ? attachmentProjection(r) : fail("one_native_claim_uncertain");
    r.attachmentClaimEntered = true; r.executionCwd = executionCwd;
    try { r.attachmentResult = claimPreparedOneAttachments(r.attachments, { runId: r.binding.runId, resultFolder: executionCwd }); r.state = "attachments_claimed"; return attachmentProjection(r); }
    catch (e) { r.state = "uncertain"; r.errorCode = "one_native_attachment_claim_failed"; throw e; }
  }
  function assertDurableStart(r: CapsuleRecord, leaseId: string) {
    const owner = ports.getRunOwner(r.binding.chatId, r.binding.runId), admission = getInvocationAdmission(r.binding.runId);
    if (!owner || owner.ownerKind !== "daemon" || owner.ownerId !== r.identity.ownerId || owner.leaseId !== leaseId || owner.state !== "active"
      || !admission || admission.chatId !== r.binding.chatId || admission.inputDigest !== r.binding.inputDigest || admission.ownerProcessEpoch !== r.identity.bootId || admission.status !== "admitted"
      || !listRunEvents(r.binding.runId, 20).some(e => e.kind === "invoke_started" && e.chatId === r.binding.chatId)) return fail("one_native_durable_start_required");
    if (r.leaseId && r.leaseId !== leaseId) return fail("one_native_owner_changed"); r.leaseId = leaseId;
  }
  function claimAfterDurableStart(proof: NativeOneProducer, value: NativeOneCapabilityCapsule, leaseId: string) {
    const r = capsule(proof, value); assertDurableStart(r, leaseId);
    if (r.attachments && !r.attachmentResult) return fail("one_native_attachment_claim_required");
    if (r.postClaimEntered) return Object.freeze({ ...r.claims });
    r.postClaimEntered = true;
    try {
      // Async transport creates a gap absent from today's synchronous start. Revalidate
      // existing issuer authority again; never refresh the already-reviewed projection.
      if (r.team && JSON.stringify(prepareOneTeamPreflightClaim(r.team.ref, r.binding.chatId)) !== JSON.stringify(r.team)) return fail("one_native_capability_binding_changed");
      if (r.briefing && JSON.stringify(prepareOneBriefingActionClaim(r.briefing.ref, r.binding.chatId)) !== JSON.stringify(r.briefing)) return fail("one_native_capability_binding_changed");
      if (r.memory && JSON.stringify(prepareOneMemoryUseOnceClaim({ contractVersion: ONE_MEMORY_CONTRACT_VERSION, receiptId: r.memory.receiptId }, r.binding.chatId)) !== JSON.stringify(r.memory)) return fail("one_native_capability_binding_changed");
      if (r.team) r.claims.team = claimPreparedOneTeamPreflight(r.team); if (r.briefing) r.claims.briefing = claimPreparedOneBriefingAction(r.briefing);
      if (r.memory) r.claims.memory = claimPreparedOneMemoryUseOnce(r.memory); r.state = "claimed"; return Object.freeze({ ...r.claims }); }
    catch (e) { r.state = "uncertain"; r.errorCode = "one_native_claim_uncertain"; throw e; }
  }
  function observe(proof: NativeOneProducer, value: NativeOneCapabilityCapsule) { const r = capsule(proof, value, false); return Object.freeze({ state: r.state, cancelled: r.cancelled, errorCode: r.errorCode, claims: Object.freeze({ ...r.claims }), attachmentReceipt: r.attachmentResult?.receipt, attachmentTransfer: r.attachmentResult && attachmentProjection(r) }); }
  function cancel(proof: NativeOneProducer, value: NativeOneCapabilityCapsule) { const r = capsule(proof, value, false); r.cancelled = true; if (!r.postClaimEntered) r.state = "cancelled"; }
  // This is a private Main lifetime callback, never an RPC taking a JSON capsule.
  // Cleanup must remain possible after the presentation channel disconnects.
  function releaseAfterSettlement(value: NativeOneCapabilityCapsule) {
    const r = capsules.get(value); if (!r) return fail("one_native_capability_unavailable"); if (r.state === "released") return;
    const owner = ports.getRunOwner(r.binding.chatId, r.binding.runId);
    if (!owner || owner.ownerId !== r.identity.ownerId || owner.ownerKind !== "daemon" || owner.state !== "released" || (r.leaseId !== undefined && owner.leaseId !== r.leaseId)) return fail("one_native_settlement_required");
    const admission = getInvocationAdmission(r.binding.runId);
    if (!admission || admission.chatId !== r.binding.chatId || admission.status !== "admitted" || admission.inputDigest !== r.binding.inputDigest
      || admission.ownerProcessEpoch !== r.identity.bootId) return fail("one_native_settlement_required");
    if (r.attachments) releasePreparedOneAttachments(r.attachments); r.state = "released"; handles.delete(r.handle);
  }
  function releaseRejectedBeforeStart(value: NativeOneCapabilityCapsule) {
    const r = capsules.get(value); if (!r) return fail("one_native_capability_unavailable");
    if (r.state === "released") return;
    const admission = getInvocationAdmission(r.binding.runId), owner = ports.getRunOwner(r.binding.chatId, r.binding.runId);
    if (!admission || admission.status !== "rejected" || admission.chatId !== r.binding.chatId || admission.inputDigest !== r.binding.inputDigest
      || admission.ownerProcessEpoch !== r.identity.bootId || !admission.rejectionReasonCode
      || getDb().prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'invoke_started' LIMIT 1").get(r.binding.runId)
      || (owner && (owner.state !== "released" || owner.ownerKind !== "daemon" || owner.ownerId !== r.identity.ownerId))) return fail("one_native_verified_rejection_required");
    if (r.attachments) releasePreparedOneAttachments(r.attachments); r.state = "released"; handles.delete(r.handle);
  }
  function disconnect(proof: NativeOneProducer) { const p = producers.get(proof); if (p) p.connected = false; /* Custody and claimed staging remain unchanged; never replay. */ }
  return { enroll, prepare, resolve, projection, claimAttachments, readImageChunk, claimAfterDurableStart, observe, cancel, releaseAfterSettlement, releaseRejectedBeforeStart, disconnect };
}
