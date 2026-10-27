import { createHash } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import type { MainInvocationAdmission } from "../runtime/scheduled-root-context";
import type { InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { nativeAuthCanonical } from "../daemon/native-auth-credentials";
import { createNativeJsonTransfers, NATIVE_SUPERVISOR_JSON_VERSION, nativeSupervisorJsonResult, type NativeSupervisorJsonResult } from "../daemon/native-json-transfer";
import { nativePreparationWireRequest, sameNativeStartBinding, type NativeStartDescriptor, type NativePreparationWireRequest } from "../daemon/native-start-protocol";
import { createNativeMainPreparationIssuer, type NativeMainPreparationIssuerPorts, type NativeMainPreparationHandle } from "./native-main-preparation-issuer";

declare const routerHandle: unique symbol;
export interface NativeMainPreparationRouterHandle { readonly [routerHandle]: true }
type Status = "handed-off" | "rejected" | "cancelled" | "uncertain" | "settled";
export interface NativeMainPreparationRouterPorts extends Omit<NativeMainPreparationIssuerPorts, "nativeChannelIdentity" | "consumeVerifiedNativeIngressNoStart" | "maxPending"> {
  /** Exact ROOT authenticated pending host closure. The host must have no
   * prepared port and settled ALL authorize/read operations. Not absence/JSON. */
  assertClosedIngressNoStart(channel: object, identity: NativeAuthenticatedIdentity, handle: NativeMainPreparationRouterHandle, request: NativePreparationWireRequest): void;
  /** Original producer/schema budgets, supplied explicitly; no smaller fallback. */
  maxRequestBytes: number;
  maxCheckpointBytes: number;
  maxRetainedBytes: number;
  maxRecords?: number;
  maxCallbacks?: number;
}
export class NativeMainPreparationRouterError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new NativeMainPreparationRouterError(code); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const actual = Object.keys(value).sort(), expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function positive(value: number): void { if (!Number.isSafeInteger(value) || value < 1) fail("native_main_router_limit_invalid"); }
function status(value: unknown, settled = false): Status {
  if (value !== "handed-off" && value !== "rejected" && value !== "cancelled" && value !== "uncertain" && !(settled && value === "settled")) fail("native_main_router_status_invalid"); return value as Status;
}
const checkpoints = new Set(["team.prepare", "briefing.prepare", "memory.prepare", "team.attachments-required", "attachments.claim", "team.claim", "briefing.claim", "memory.claim", "images.transfer", "team.fail-start", "attachments.release"]);
/** Validate source JSON values without deleting public object keys. Original
 * request and known producer projection establish their own authority boundary. */
function sourceJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(v => sourceJsonValue(v) ?? null);
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("native_main_router_private_value");
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => v !== undefined).map(([key, v]) => [key, sourceJsonValue(v)]));
}
/** Only this known producer's direct private claim field is omitted. Never
 * reinterpret a public nested literal named claimToken as grant authority. */
function preparedCheckpointValue(kind: string, value: unknown): unknown {
  if (kind === "memory.prepare" && value && typeof value === "object" && !Array.isArray(value)) {
    const { claimToken: _privateMemoryClaim, ...projection } = value as Record<string, unknown>;
    return sourceJsonValue(projection);
  }
  return sourceJsonValue(value);
}
interface SupervisorResultRecord {
  owner: object; digest: string; promise: Promise<NativeSupervisorJsonResult>;
  result?: NativeSupervisorJsonResult; released: boolean;
}
interface RecordState {
  handle: NativeMainPreparationRouterHandle; issuer: NativeMainPreparationHandle; channel: object; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor;
  released: boolean; detached: boolean; nonces: Set<string>; supervisorResults: Map<string, SupervisorResultRecord>; snapshot?: ReturnType<ReturnType<typeof createNativeJsonTransfers>["issue"]>;
}
/** Main native bootstrap only. No method is an IPC/MCP/AppControl dispatcher. */
export function createNativeMainPreparationRouter(ports: NativeMainPreparationRouterPorts) {
  for (const limit of [ports.maxRequestBytes, ports.maxCheckpointBytes, ports.maxRetainedBytes, ports.maxRecords ?? 32, ports.maxCallbacks ?? 32]) positive(limit);
  const records = new Map<string, RecordState>(), handles = new WeakMap<NativeMainPreparationRouterHandle, RecordState>();
  const noStartProofs = new WeakMap<object, RecordState>();
  const resultOwners = new WeakMap<object, RecordState>();
  const closedTerminalRecords = new Map<string, WeakRef<RecordState>>();
  const issuer = createNativeMainPreparationIssuer({ ...ports, maxPending: ports.maxRecords ?? 32,
    nativeChannelIdentity(channel) { const identity = nativeGuiChannelIdentity(channel); return identity ? Object.freeze({ peer: identity, generation: identity.generation, serviceIdentity: identity.serviceIdentity, bootId: identity.bootId, ownerId: identity.bootId, storeIdentity: identity.scope }) : null; },
    consumeVerifiedNativeIngressNoStart(binding, proof) { const r = noStartProofs.get(proof); noStartProofs.delete(proof); if (!r || !sameNativeStartBinding(r.start.binding, binding)) fail("native_main_router_no_start_proof_required"); assertCurrent(r, r.channel, r.identity, true); },
  });
  let callbacks = 0, terminalCallbacks = 0;
  function assertCurrent(r: RecordState, channel = r.channel, identity = r.identity, terminalOnly = false): void {
    if ((!terminalOnly && issuer.inspect(r.issuer).authorityClosed) || r.released || r.detached || channel !== r.channel || identity !== r.identity || nativeGuiChannelIdentity(channel) !== identity) fail("native_main_router_channel_changed");
  }
  const transfers = createNativeJsonTransfers({ isCurrent(owner) { const r = handles.get(owner as NativeMainPreparationRouterHandle) ?? resultOwners.get(owner); return !!r && !r.released && !r.detached && nativeGuiChannelIdentity(r.channel) === r.identity && !issuer.inspect(r.issuer).aborted; }, maxPending: (ports.maxRecords ?? 32) * 24, maxRetainedBytes: ports.maxRetainedBytes });
  function issue(input: { event: object; hostOrigin?: object; actualChannel: object; request: McpInvocationRequest; mainAdmission: MainInvocationAdmission | undefined; admission: InvocationAdmissionIdentity }) {
    // Issuer consumes original admission even when a downstream guard refuses.
    const privateIssuer = issuer.issue({ ...input, channel: input.actualChannel });
    const identity = nativeGuiChannelIdentity(input.actualChannel); if (!identity) fail("native_main_router_channel_required");
    const p = issuer.projection(privateIssuer), handle = Object.freeze({}) as NativeMainPreparationRouterHandle;
    const start: NativeStartDescriptor = Object.freeze({ version: "agentlas.native-start.v1", handle: p.handle, binding: p.binding });
    const r: RecordState = { handle, issuer: privateIssuer, channel: input.actualChannel, identity, start, released: false, detached: false, nonces: new Set(), supervisorResults: new Map() };
    records.set(start.handle, r); handles.set(handle, r);
    return Object.freeze({ start, privateHandle: handle });
  }
  function privateRecord(handle: NativeMainPreparationRouterHandle): RecordState { const r = handles.get(handle); if (!r) fail("native_main_router_handle_required"); return r; }
  function ack(r: RecordState, request: NativePreparationWireRequest, state: string) { return Object.freeze({ requestId: request.requestId, binding: r.start.binding, status: state }); }
  async function handleCheckpoint(actualChannel: object, method: "native.checkpoint", wire: unknown, actualIdentity: NativeAuthenticatedIdentity): Promise<unknown> {
    if (method !== "native.checkpoint" || nativeGuiChannelIdentity(actualChannel) !== actualIdentity || !actualIdentity) fail("native_main_router_authenticated_callback_required");
    const request = nativePreparationWireRequest(wire);
    const terminal = ["cancel", "quiesce", "finish", "ingress.reject"].includes(request.action) || (request.action === "checkpoint" && ["team.fail-start", "attachments.release"].includes(String(request.payload.kind)));
    const r = records.get(request.start.handle) ?? (terminal ? closedTerminalRecords.get(request.start.handle)?.deref() : undefined);
    if (!r || !sameNativeStartBinding(r.start.binding, request.start.binding)) fail("native_main_router_binding_changed");
    assertCurrent(r, actualChannel, actualIdentity, terminal);
    if (terminal ? terminalCallbacks >= 2 : callbacks >= (ports.maxCallbacks ?? 32)) fail("native_main_router_callback_capacity");
    terminal ? terminalCallbacks++ : callbacks++;
    try {
      const p = request.payload;
      switch (request.action) {
        case "json.read": {
          if (!exact(p, ["transferId", "offset"]) || typeof p.transferId !== "string" || !Number.isSafeInteger(p.offset)) fail("native_main_router_payload_invalid");
          const result = [...r.supervisorResults.values()].find(value => !value.released && value.result?.transfer.transferId === p.transferId);
          return transfers.read(result?.owner ?? r.handle, p.transferId, p.offset as number);
        }
        case "one.inline.image.read": {
          if (!exact(p, ["imageIndex", "offset"]) || !Number.isSafeInteger(p.imageIndex) || !Number.isSafeInteger(p.offset)) fail("native_main_router_payload_invalid");
          const value = issuer.readOneInlineImageChunk(r.issuer, actualChannel, p as unknown as { imageIndex: number; offset: number }); assertCurrent(r, r.channel, r.identity, terminal); return value;
        }
        case "one.image.read": {
          if (!exact(p, ["imageIndex", "offset"]) || !Number.isSafeInteger(p.imageIndex) || !Number.isSafeInteger(p.offset)) fail("native_main_router_payload_invalid");
          const value = issuer.readOneImageChunk(r.issuer, actualChannel, p as unknown as { imageIndex: number; offset: number }); assertCurrent(r, r.channel, r.identity, terminal); return value;
        }
        case "work.image.read": {
          if (!exact(p, ["imageIndex", "component", "offset"]) || !Number.isSafeInteger(p.imageIndex) || !Number.isSafeInteger(p.offset) || (p.component !== "image" && p.component !== "metadata")) fail("native_main_router_payload_invalid");
          const value = issuer.readWorkImageChunk(r.issuer, actualChannel, p as unknown as Parameters<typeof issuer.readWorkImageChunk>[2]); assertCurrent(r, r.channel, r.identity, terminal); return value;
        }
        case "request.snapshot": {
          if (!exact(p, [])) fail("native_main_router_payload_invalid");
          if (!issuer.inspect(r.issuer).activated) fail("native_main_router_not_authorized");
          if (!r.snapshot) { const original = issuer.projection(r.issuer); r.snapshot = transfers.issue(r.handle, "original-request", sourceJsonValue({ request: original.request, hadImages: original.hadImages, ...(original.supervisorHost?{supervisorHost:true}:{}), ...(original.hostNoticePurpose ? {hostNoticePurpose:original.hostNoticePurpose}:{}), ...(original.workImages ? { workImages: original.workImages } : {}), ...(original.oneInlineImages ? { oneInlineImages: original.oneInlineImages } : {}) }), ports.maxRequestBytes); }
          return r.snapshot; // Only an immutable original snapshot, never fresh authorization.
        }
      }
      if (request.action === "supervisor.command") {
        const fields = (keys: readonly string[]): boolean => exact(p, keys);
        if (fields(["resultTransport", "release"]) && p.resultTransport === NATIVE_SUPERVISOR_JSON_VERSION) {
          const result = nativeSupervisorJsonResult(p.release, ports.maxCheckpointBytes);
          const retained = r.supervisorResults.get(result.requestId);
          if (!retained?.result || (["version", "transferId", "kind", "byteLength", "digest"] as const)
            .some(key => retained.result!.transfer[key] !== result.transfer[key])) fail("native_supervisor_result_owner_changed");
          if (!retained.released) {
            transfers.releaseOne(retained.owner, result.transfer.transferId);
            retained.released = true; resultOwners.delete(retained.owner);
          }
          return Object.freeze({ version: NATIVE_SUPERVISOR_JSON_VERSION, requestId: result.requestId, released: true });
        }
        const legacy = fields(["name", "input"]);
        if ((!legacy && (!fields(["name", "input", "resultTransport"]) || p.resultTransport !== NATIVE_SUPERVISOR_JSON_VERSION
          || p.name !== "one_app_operations")) || typeof p.name !== "string" || !p.input || typeof p.input !== "object" || Array.isArray(p.input)) fail("native_supervisor_command_invalid");
        // Other commands and legacy peers retain the exact raw-result contract.
        if (legacy) return issuer.supervisorCommand(r.issuer, actualChannel, p.name, p.input as Record<string, unknown>);
        const digest = createHash("sha256").update(nativeAuthCanonical(p)).digest("hex");
        const prior = r.supervisorResults.get(request.requestId);
        if (prior) {
          if (prior.digest !== digest) fail("native_supervisor_result_request_conflict");
          if (prior.released) fail("native_supervisor_result_released");
          return prior.promise;
        }
        // Released entries remain small tombstones: a repeated request never
        // executes again after custody ends. No unconfirmed result is evicted.
        if (r.supervisorResults.size >= (ports.maxCallbacks ?? 32) * 24) fail("native_supervisor_result_capacity");
        const owner = Object.freeze({}); resultOwners.set(owner, r);
        let retained: SupervisorResultRecord;
        const promise = Promise.resolve().then(async () => {
          const value = await issuer.supervisorCommand(r.issuer, actualChannel, p.name as string, p.input as Record<string, unknown>);
          assertCurrent(r, actualChannel, actualIdentity);
          const transfer = transfers.issue(owner, "checkpoint-value", sourceJsonValue(value), ports.maxCheckpointBytes);
          const result = Object.freeze({ version: NATIVE_SUPERVISOR_JSON_VERSION, requestId: request.requestId, transfer });
          retained.result = result; return result;
        });
        retained = { owner, digest, promise, released: false }; r.supervisorResults.set(request.requestId, retained);
        return promise;
      }
      if (request.action === "cancel") { if (!exact(p, [])) fail("native_main_router_payload_invalid"); issuer.cancel(r.issuer); assertCurrent(r, r.channel, r.identity, terminal); return ack(r, request, "cancelled"); }
      if (r.nonces.has(request.requestId)) fail("native_main_router_request_replayed");
      if (r.nonces.size >= (terminal ? 40 : 32)) fail("native_main_router_nonce_capacity");
      // Claim/authorization is never repeated after a lost completion ACK.
      r.nonces.add(request.requestId);
      switch (request.action) {
        case "issuer.authorize": if (!exact(p, [])) fail("native_main_router_payload_invalid"); issuer.activate(r.issuer, actualChannel, request.start.binding); assertCurrent(r, r.channel, r.identity, terminal); return ack(r, request, "authorized");
        case "checkpoint": {
          if (!exact(p, ["kind", "payload"]) || typeof p.kind !== "string" || !checkpoints.has(p.kind) || !p.payload || typeof p.payload !== "object" || Array.isArray(p.payload)) fail("native_main_router_payload_invalid");
          const value = await issuer.execute(r.issuer, { requestId: request.requestId, kind: p.kind as Parameters<typeof issuer.execute>[1]["kind"], payload: p.payload as Record<string, unknown> }, actualChannel);
          assertCurrent(r, r.channel, r.identity, terminal);
          if (p.kind === "team.fail-start" || p.kind === "attachments.release") return ack(r, request, "cleanup-recorded");
          if (value === undefined) fail("native_main_router_checkpoint_value_missing");
          return transfers.issue(r.handle, "checkpoint-value", preparedCheckpointValue(p.kind, value), ports.maxCheckpointBytes);
        }
        case "quiesce": if (!exact(p, ["status"])) fail("native_main_router_payload_invalid"); await issuer.quiesce(r.issuer, status(p.status) as Exclude<Status, "settled">); assertCurrent(r, r.channel, r.identity, terminal); return ack(r, request, "quiescent");
        case "ingress.reject": {
          if (!exact(p, [])) fail("native_main_router_payload_invalid");
          ports.assertClosedIngressNoStart(actualChannel, actualIdentity, r.handle, request);
          const proof = Object.freeze({}); noStartProofs.set(proof, r);
          await issuer.rejectNativeIngressBeforeStart(r.issuer, actualChannel, proof);
          assertCurrent(r, r.channel, r.identity, terminal); return ack(r, request, "rejected-before-start");
        }
        case "finish": {
          if (!exact(p, ["status"])) fail("native_main_router_payload_invalid");
          const result = await issuer.finish(r.issuer, status(p.status, true));
          // Recheck peer even if authoritative cleanup already completed. A lost
          // reply never converts a new peer into the original callback owner.
          assertCurrent(r, r.channel, r.identity, terminal);
          if (result.state === "released") release(r);
          return ack(r, request, result.state);
        }
        default: return fail("native_main_router_action_denied");
      }
    } finally { terminal ? terminalCallbacks-- : callbacks--; }
  }
  function releaseResults(r: RecordState): void {
    for (const result of r.supervisorResults.values()) { transfers.release(result.owner); resultOwners.delete(result.owner); }
    r.supervisorResults.clear();
  }
  function release(r: RecordState): void { releaseResults(r); transfers.release(r.handle); r.released = true; records.delete(r.start.handle); closedTerminalRecords.delete(r.start.handle); }
  /** Private actual custody observer. Never exposed as a JSON router action. */
  async function finishForSettlement(handle: NativeMainPreparationRouterHandle, finalStatus: Status) { const r = privateRecord(handle); const result = await issuer.finish(r.issuer, finalStatus); if (result.state === "released") release(r); return result; }
  function disconnect(actualChannel: object): void { issuer.disconnect(actualChannel); for (const r of records.values()) if (r.channel === actualChannel) r.detached = true; }
  function cancel(handle: NativeMainPreparationRouterHandle): void { issuer.cancel(privateRecord(handle).issuer); }
  function closeAuthorityIfSettled(handle: NativeMainPreparationRouterHandle): boolean {
    const r = privateRecord(handle);
    if (!issuer.closeAuthorityIfSettled(r.issuer)) return false;
    releaseResults(r); transfers.release(r.handle); records.delete(r.start.handle);
    // Only the existing original terminal channel can observe old cleanup. The
    // thin weak index cannot retain source buffers or restore business authority.
    closedTerminalRecords.set(r.start.handle, new WeakRef(r));
    while (closedTerminalRecords.size > 128) closedTerminalRecords.delete(closedTerminalRecords.keys().next().value!);
    return true;
  }
  function inspect(handle: NativeMainPreparationRouterHandle) { const r = privateRecord(handle); return Object.freeze({ ...issuer.inspect(r.issuer), released: r.released, detached: r.detached, nonceCount: r.nonces.size, transferCount: transfers.pendingCount, retainedBytes: transfers.retainedBytes }); }
  return { closeAuthorityIfSettled, issue, handleCheckpoint, finishForSettlement, disconnect, cancel, inspect, get recordCount() { return [...records.values()].filter(r => !closeAuthorityIfSettled(r.handle)).length; } };
}
