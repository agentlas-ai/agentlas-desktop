import { assertClosedNativePreparationLifetime, type NativePreparationLifetime } from "../runtime/native-preparation-lifetime";
import { createNativeIngressClosureSource } from "../runtime/native-ingress-closure";
import {admitMainInvocation,type MainInvocationAdmission} from "../runtime/scheduled-root-context";
import { createHash } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import { getInvocationAdmission, canonicalInvocationRequestJson, INVOCATION_ADMISSION_DIGEST_VERSION, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import type { NativeOneStartPort } from "./native-start-checkpoints";
export interface NativeIngressIdentity { readonly peer: object; readonly generation: string; readonly serviceIdentity: string; readonly bootId: string; readonly ownerId: string; readonly storeIdentity: string }
export interface NativeIngressBinding { readonly chatId: string; readonly runId: string; readonly inputDigest: string; readonly ownerProcessEpoch: string }
declare const ingressBrand: unique symbol;
export interface NativeInvocationIngressSource { readonly [ingressBrand]: true }
export interface NativeIngressPrepared { request: McpInvocationRequest; port: NativeOneStartPort; hostNoticePurpose?: SupervisorHostNoticePurpose }
export interface NativeIngressSourcePorts {
  authenticatedIdentity(channel: object): Readonly<NativeIngressIdentity> | undefined;
  /** Closed bootstrap registry: captures exact original unused Main issuer binding; grants ZERO admission. Never accept peer identity or JSON as the issuer. */
  captureOriginalMainHandle(channel: object, identity: Readonly<NativeIngressIdentity>, originalIssuer: object): NativeIngressBinding;
  /** Actual closed Main callback; returns only a root-private verified-proof object. JSON/peer authentication is never this proof. */
  authorize(channel: object, originalIssuer: object, binding: Readonly<NativeIngressBinding>, signal: AbortSignal): Promise<object>;
  consumeVerifiedOriginalMainIssuer(identity: Readonly<NativeIngressIdentity>, binding: Readonly<NativeIngressBinding>, verifiedProof: object): void;
  read(channel: object, originalIssuer: object, binding: Readonly<NativeIngressBinding>, signal: AbortSignal): Promise<NativeIngressPrepared>;
  cancel(channel: object, originalIssuer: object, binding: Readonly<NativeIngressBinding>): Promise<void>;
  quiesce(channel: object, originalIssuer: object, binding: Readonly<NativeIngressBinding>): Promise<void>;
  finish(channel: object, originalIssuer: object, binding: Readonly<NativeIngressBinding>, status: "handed-off" | "cancelled" | "uncertain"): Promise<void>;
}
interface Record { transferPreparedForEntry(value: NativeIngressPrepared): void; captureClosedReturnedBeforeTransfer(value: NativeIngressPrepared, lifetime: NativePreparationLifetime, assertClosed: () => void): object; closeUnused(signal: AbortSignal): boolean; captureClosedBeforePrepared(assertClosed: () => void): object; binding: Readonly<NativeIngressBinding>; assertCurrent(): void; authorize(signal: AbortSignal): Promise<MainInvocationAdmission>; read(signal: AbortSignal): Promise<NativeIngressPrepared>; cancel(): Promise<void>; quiesce(): Promise<void>; finish(status: "handed-off" | "cancelled" | "uncertain"): Promise<void> }
const records = new WeakMap<NativeInvocationIngressSource, Record>();

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function reserved(binding: Readonly<NativeIngressBinding>): void {
  const row = getInvocationAdmission(binding.runId);
  if (!row || row.chatId !== binding.chatId || row.inputDigest !== binding.inputDigest || row.ownerProcessEpoch !== binding.ownerProcessEpoch || row.status !== "pending") fail("native_ingress_reservation_required");
}
function same(a: Readonly<NativeIngressIdentity> | undefined,b: Readonly<NativeIngressIdentity>): boolean { return !!a && a.peer===b.peer && a.generation===b.generation && a.serviceIdentity===b.serviceIdentity && a.bootId===b.bootId && a.ownerId===b.ownerId && a.storeIdentity===b.storeIdentity; }
/** Node-safe source custody only. Does not mint Main admission, root authority, owner lease or start receipt. */
export function createNativeInvocationIngressSources(ports: NativeIngressSourcePorts) {
  return { issue(channel: object, originalIssuer: object): NativeInvocationIngressSource {
    const observed = ports.authenticatedIdentity(channel);
    if (!observed || !observed.peer || typeof observed.peer !== "object" || [observed.generation,observed.serviceIdentity,observed.bootId,observed.ownerId,observed.storeIdentity].some(v=>typeof v!=="string"||!v)) fail("native_ingress_channel_required");
    const identity = Object.freeze({...observed});
    const binding = Object.freeze({...ports.captureOriginalMainHandle(channel,identity,originalIssuer)});
    if (!binding.chatId || !binding.runId || !/^[a-f0-9]{64}$/.test(binding.inputDigest) || binding.ownerProcessEpoch !== identity.bootId) fail("native_ingress_issuer_binding_invalid");
    reserved(binding);
    const assertCurrent = () => { if (!same(ports.authenticatedIdentity(channel),identity)) fail("native_ingress_channel_changed"); };
    const source = Object.freeze({}) as NativeInvocationIngressSource;
    let sourceSignal: AbortSignal | undefined, authorizing = false, authorizedOnce = false, authorizeSettled = false, authorizeSucceeded = false;
    let reading = false, readEntered = false, readSettled = false, preparedReturned = false, unusedClosed = false;
    let returnedPrepared: WeakRef<NativeIngressPrepared> | undefined, preparedTransferStarted = false;
    let returnedLifetime: NativePreparationLifetime | undefined;
    let returnedPort: WeakRef<NativeOneStartPort> | undefined, returnedRequest: WeakRef<McpInvocationRequest> | undefined;
    const captureSignal = (signal: AbortSignal) => {
      if (sourceSignal && sourceSignal !== signal) fail("native_ingress_original_signal_changed");
      sourceSignal = signal;
    };
    const closed = createNativeIngressClosureSource(binding, () => {
      if ((!unusedClosed && (!authorizedOnce || !authorizeSettled)) || authorizing || reading || (readEntered && !readSettled)
        || preparedReturned || !sourceSignal?.aborted) fail("native_ingress_source_dispatch_not_closed");
    });
    const returnedClosed = createNativeIngressClosureSource(binding, () => {
      if (!authorizeSucceeded || authorizing || reading || !readSettled || !preparedReturned || !returnedPrepared
        || preparedTransferStarted || !sourceSignal?.aborted || !returnedLifetime) fail("native_ingress_returned_dispatch_not_closed");
      assertClosedNativePreparationLifetime(returnedLifetime, binding);
    });
    records.set(source,{transferPreparedForEntry(value) {
      if (!value || !readSettled || !preparedReturned || value !== returnedPrepared?.deref() || value.port !== returnedPort?.deref() || value.request !== returnedRequest?.deref() || preparedTransferStarted || !sourceSignal) fail("native_ingress_original_prepared_required");
      assertCurrent(); sourceSignal.throwIfAborted(); reserved(binding);
      // Dispatch authority transfers only after the service's genuine Main
      // admission take and entry registration. This is not a claimed brain start.
      preparedTransferStarted = true; returnedPrepared = undefined; returnedPort = undefined; returnedRequest = undefined;
    },captureClosedReturnedBeforeTransfer(value, lifetime, assertClosed) {
      if (!value || value !== returnedPrepared?.deref() || value.port !== returnedPort?.deref()) fail("native_ingress_original_prepared_required");
      assertClosedNativePreparationLifetime(lifetime, binding);
      if (returnedLifetime && returnedLifetime !== lifetime) fail("native_ingress_original_lifetime_required");
      returnedLifetime = lifetime;
      return returnedClosed.capture(assertClosed);
    },closeUnused(signal) {
      if (authorizedOnce || readEntered || authorizing || reading) return false;
      if (!signal.aborted) fail("native_ingress_unused_signal_open");
      captureSignal(signal); unusedClosed = true; return true;
    },captureClosedBeforePrepared: closed.capture,binding,assertCurrent,
      authorize:async(signal)=>{
        if (unusedClosed || authorizedOnce) fail("native_ingress_authorization_replayed");
        authorizedOnce = true; captureSignal(signal); authorizing = true;
        try { signal.throwIfAborted();assertCurrent();reserved(binding);
          const proof=await ports.authorize(channel,originalIssuer,binding,signal);
          signal.throwIfAborted();assertCurrent();reserved(binding);
          ports.consumeVerifiedOriginalMainIssuer(identity,binding,proof);
          const admission=admitMainInvocation(binding.chatId,binding.runId);if(!admission)fail("native_ingress_root_admission_required");authorizeSucceeded=true;return admission;
        } finally { authorizing = false; authorizeSettled = true; }
      },
      read:async(signal)=>{
        if (!authorizeSettled || !authorizeSucceeded || readEntered) fail("native_ingress_original_read_required");
        captureSignal(signal); readEntered = true; reading = true;
        try { signal.throwIfAborted();const value=await ports.read(channel,originalIssuer,binding,signal);returnedPrepared=new WeakRef(value);returnedPort=new WeakRef(value.port);returnedRequest=new WeakRef(value.request);preparedReturned=true;return value; }
        finally { reading=false;readSettled=true; }
      },
      cancel:()=>ports.cancel(channel,originalIssuer,binding),quiesce:()=>ports.quiesce(channel,originalIssuer,binding),finish:status=>ports.finish(channel,originalIssuer,binding,status)});

    return source;
  } };
}
export function takeNativeInvocationIngressSource(source: NativeInvocationIngressSource): Record {
  const record=records.get(source); if (!record) fail("native_ingress_source_required"); records.delete(source); record.assertCurrent(); reserved(record.binding); return record;
}
export function validateNativeIngressRequest(binding: Readonly<NativeIngressBinding>, request: McpInvocationRequest): InvocationAdmissionIdentity {
  if (request.chatId !== binding.chatId || request.runId !== binding.runId) fail("native_ingress_request_identity_mismatch");
  const canonicalRequestJson=canonicalInvocationRequestJson(request);
  const digest=createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION+"\0").update(canonicalRequestJson).digest("hex");
  if (digest!==binding.inputDigest) fail("native_ingress_request_digest_mismatch");
  reserved(binding);
  return {chatId:binding.chatId,runId:binding.runId,canonicalRequestJson,ownerProcessEpoch:binding.ownerProcessEpoch};
}
