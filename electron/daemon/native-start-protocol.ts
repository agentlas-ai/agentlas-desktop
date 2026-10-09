import { randomBytes } from "node:crypto";
import type { NativeOneStartCheckpointKind } from "../invocation/native-start-checkpoints";

/** Closed data shapes only. Authentication and original issuer provenance are
 * held by the native host, not conferred by any field in these messages. */
export interface NativeStartInputBinding { readonly chatId: string; readonly runId: string; readonly inputDigest: string }
export interface NativeStartDescriptor {
  readonly version: "agentlas.native-start.v1";
  readonly handle: string;
  readonly binding: NativeStartInputBinding;
}
export type NativeMainCheckpointKind = Exclude<NativeOneStartCheckpointKind, "judge" | "preparation.handoff">
export type NativePreparationWireAction = "supervisor.command" | "issuer.authorize" | "request.snapshot" | "checkpoint" | "json.read" | "one.image.read" | "one.inline.image.read" | "work.image.read" | "cancel" | "quiesce" | "finish" | "ingress.reject";
export interface NativePreparationWireRequest {
  readonly version: "agentlas.native-preparation.v1";
  readonly requestId: string;
  readonly start: NativeStartDescriptor;
  readonly action: NativePreparationWireAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export class NativeStartProtocolError extends Error { constructor(readonly code: string) { super(code); } }
function denied(code: string): never { throw new NativeStartProtocolError(code); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value); }
export function nativeStartInputBinding(value: unknown): NativeStartInputBinding {
  if (!exact(value, ["chatId", "runId", "inputDigest"]) || !id(value.chatId) || !id(value.runId)
    || typeof value.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.inputDigest)) denied("native_start_binding_invalid");
  return Object.freeze({ chatId: value.chatId, runId: value.runId, inputDigest: value.inputDigest });
}
export function nativeStartDescriptor(value: unknown): NativeStartDescriptor {
  if (!exact(value, ["version", "handle", "binding"]) || value.version !== "agentlas.native-start.v1"
    || typeof value.handle !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.handle)) denied("native_start_descriptor_invalid");
  return Object.freeze({ version: "agentlas.native-start.v1", handle: value.handle, binding: nativeStartInputBinding(value.binding) });
}
export function sameNativeStartBinding(a: NativeStartInputBinding, b: NativeStartInputBinding): boolean {
  return a.chatId === b.chatId && a.runId === b.runId && a.inputDigest === b.inputDigest;
}
const actions = new Set<NativePreparationWireAction>(["supervisor.command", "issuer.authorize", "request.snapshot", "checkpoint", "json.read", "one.image.read", "one.inline.image.read", "work.image.read", "cancel", "quiesce", "finish", "ingress.reject"]);
export function nativePreparationWireRequest(value: unknown): NativePreparationWireRequest {
  if (!exact(value, ["version", "requestId", "start", "action", "payload"]) || value.version !== "agentlas.native-preparation.v1"
    || typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/.test(value.requestId)
    || typeof value.action !== "string" || !actions.has(value.action as NativePreparationWireAction)
    || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)
    || (Object.getPrototypeOf(value.payload) !== Object.prototype && Object.getPrototypeOf(value.payload) !== null)) denied("native_preparation_request_invalid");
  return Object.freeze({ version: "agentlas.native-preparation.v1", requestId: value.requestId, start: nativeStartDescriptor(value.start),
    action: value.action as NativePreparationWireAction, payload: Object.freeze({ ...(value.payload as Record<string, unknown>) }) });
}
export function makeNativePreparationWireRequest(start: NativeStartDescriptor, action: NativePreparationWireAction, payload: Record<string, unknown>): NativePreparationWireRequest {
  return nativePreparationWireRequest({ version: "agentlas.native-preparation.v1", requestId: randomBytes(32).toString("hex"), start, action, payload });
}
export function assertNativePreparationAcknowledgement(value: unknown, request: NativePreparationWireRequest, status: "authorized" | "cancelled" | "quiescent" | "released" | "quiesced-retained" | "retained-uncertain" | "cleanup-recorded" | "rejected-before-start"): void {
  if (!exact(value, ["requestId", "binding", "status"]) || value.requestId !== request.requestId || value.status !== status
    || !sameNativeStartBinding(nativeStartInputBinding(value.binding), request.start.binding)) denied("native_preparation_acknowledgement_invalid");
}
