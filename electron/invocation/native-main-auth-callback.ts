import { AsyncLocalStorage } from "node:async_hooks";
import { consumeNativeGuiIngressNoStart, consumeNativeGuiServiceObservation, nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeIngressNoStartObservation, NativeServiceObservation } from "../daemon/native-auth-credentials";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { nativePreparationWireRequest, nativeStartDescriptor, sameNativeStartBinding, type NativePreparationWireRequest, type NativeStartDescriptor } from "../daemon/native-start-protocol";
import type { createNativeMainPreparationRouter, NativeMainPreparationRouterHandle } from "./native-main-preparation-router";

type Router = ReturnType<typeof createNativeMainPreparationRouter>;
type CallbackRecord = { channel: object; identity: NativeAuthenticatedIdentity; raw: unknown; request: NativePreparationWireRequest; observation?: NativeIngressNoStartObservation; serviceObservation?: NativeServiceObservation; serviceConsumed: boolean; active: boolean; consumed: boolean };
export class NativeMainAuthCallbackError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new NativeMainAuthCallbackError(code); }
/** Native bootstrap only. No ALS, proof issuer, IPC or generic grant factory is
 * exported. The native caller binds its actual router exactly once. */
export function createNativeMainAuthCallbackAdapter(ports: { getChannel(): object | undefined }) {
  let router: Router | undefined;
  const issued = new WeakMap<NativeMainPreparationRouterHandle, { start: NativeStartDescriptor; channel: object; identity: NativeAuthenticatedIdentity }>();
  const callbacks = new AsyncLocalStorage<CallbackRecord>();
  function currentChannel(): { channel: object; identity: NativeAuthenticatedIdentity } {
    const channel = ports.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
    if (!channel || !identity) fail("native_main_callback_channel_required"); return { channel, identity };
  }
  return Object.freeze({
    bindRouter(actualRouter: Router): void { if (router || !actualRouter) fail("native_main_callback_router_already_bound"); router = actualRouter; },
    registerIssued(value: NativeStartDescriptor, actualPrivateHandle: NativeMainPreparationRouterHandle): void {
      if (!router) fail("native_main_callback_router_required");
      const { channel, identity } = currentChannel(), state = router.inspect(actualPrivateHandle);
      if (state.released || state.detached || issued.has(actualPrivateHandle)) fail("native_main_callback_issue_invalid");
      issued.set(actualPrivateHandle, { start: nativeStartDescriptor(value), channel, identity });
    },
    async onRequest(method: "native.checkpoint", rawWire: unknown, actualIdentity: NativeAuthenticatedIdentity): Promise<unknown> {
      if (!router || method !== "native.checkpoint") fail("native_main_callback_router_required");
      const { channel, identity } = currentChannel(); if (identity !== actualIdentity) fail("native_main_callback_identity_changed");
      // R5 observes the original decoder object. Consume it BEFORE the parser
      // creates a fresh normalized request for the original router.
      const observation = rawWire && typeof rawWire === "object" && (rawWire as { action?: unknown }).action === "ingress.reject"
        ? consumeNativeGuiIngressNoStart(channel, identity, rawWire) : undefined;
      const observedAction = rawWire && typeof rawWire === "object" ? (rawWire as { action?: unknown; payload?: { kind?: unknown } }) : undefined;
      const serviceObservation = observedAction && (observedAction.action === "finish" || observedAction.action === "checkpoint" && observedAction.payload?.kind === "attachments.claim")
        ? (() => { try { return consumeNativeGuiServiceObservation(channel, identity, rawWire); } catch { return undefined; } })() : undefined;
      const request = nativePreparationWireRequest(rawWire);
      const actualRouter = router;
      const record: CallbackRecord = { channel, identity, raw: rawWire, request, observation, serviceObservation, serviceConsumed: false, active: true, consumed: false };
      try { return await callbacks.run(record, () => actualRouter.handleCheckpoint(channel, method, rawWire, identity)); }
      finally { record.active = false; record.observation = undefined; record.serviceObservation = undefined; }
    },
    assertExecutionCwd(binding: { chatId: string; runId: string; inputDigest: string }, cwd: string): void {
      const r = callbacks.getStore(), observation = r?.serviceObservation;
      if (!r?.active || r.serviceConsumed || !observation || observation.kind !== "native-execution-cwd-selected-v1") fail("native_main_callback_cwd_proof_required");
      const { channel, identity } = currentChannel();
      if (r.channel !== channel || r.identity !== identity || observation.binding.ownerProcessEpoch !== identity.bootId
        || !sameNativeStartBinding(binding, observation.binding) || !sameNativeStartBinding(binding, r.request.start.binding)
        || r.request.action !== "checkpoint" || r.request.payload.kind !== "attachments.claim"
        || observation.cwd !== cwd || (r.request.payload.payload as Record<string, unknown>).resultFolder !== cwd) fail("native_main_callback_cwd_proof_required");
      r.serviceConsumed = true;
    },
    assertNoBrainDispatch(binding: { chatId: string; runId: string; inputDigest: string }, lease: { leaseId: string; ownerId: string; ownerKind: string; chatId: string; runId: string }): void {
      const r = callbacks.getStore(), observation = r?.serviceObservation;
      if (!r?.active || r.serviceConsumed || !observation || observation.kind !== "native-undispatched-start-v1") fail("native_main_callback_undispatched_proof_required");
      const { channel, identity } = currentChannel();
      if (r.channel !== channel || r.identity !== identity || r.request.action !== "finish"
        || observation.binding.ownerProcessEpoch !== identity.bootId || !sameNativeStartBinding(binding, observation.binding)
        || !sameNativeStartBinding(binding, r.request.start.binding) || lease.leaseId !== observation.leaseId
        || lease.ownerId !== identity.bootId || lease.ownerKind !== "daemon" || lease.chatId !== binding.chatId || lease.runId !== binding.runId) fail("native_main_callback_undispatched_proof_required");
      r.serviceConsumed = true;
    },
    assertClosedIngressNoStart(actualChannel: object, actualIdentity: NativeAuthenticatedIdentity, actualPrivateHandle: NativeMainPreparationRouterHandle, parsedWire: NativePreparationWireRequest): void {
      const r = callbacks.getStore(), registered = issued.get(actualPrivateHandle);
      if (!router || !r?.active || r.consumed || !r.observation || !registered) fail("native_main_callback_ingress_proof_required");
      const { channel, identity } = currentChannel(), request = nativePreparationWireRequest(parsedWire), observation = r.observation;
      if (actualChannel !== r.channel || actualChannel !== channel || actualIdentity !== r.identity || actualIdentity !== identity || registered.channel !== channel || registered.identity !== identity || request.action !== "ingress.reject" || request.requestId !== r.request.requestId || request.start.handle !== r.request.start.handle || request.start.handle !== registered.start.handle || !sameNativeStartBinding(request.start.binding, r.request.start.binding) || !sameNativeStartBinding(request.start.binding, registered.start.binding) || Object.keys(request.payload).length !== 0 || observation.kind !== "native-ingress-closed-before-prepared-v1" || observation.binding.ownerProcessEpoch !== identity.bootId || !sameNativeStartBinding(observation.binding, request.start.binding)) fail("native_main_callback_ingress_proof_required");
      const state = router.inspect(actualPrivateHandle); if (state.released || state.detached) fail("native_main_callback_ingress_proof_required");
      r.consumed = true;
    },
  });
}
