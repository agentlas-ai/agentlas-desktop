import { createHash } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import { canonicalInvocationRequestJson, INVOCATION_ADMISSION_DIGEST_VERSION, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import { assertNativeOneStartPort, type NativeOneStartPort, type NativeOneStartBinding } from "./native-start-checkpoints";

export type OrdinaryOneTurnMode = "scope" | "execution" | "message" | "settlement" | "closed";
export interface OrdinaryOneTurnState {
  readonly phase: "preparing" | "admitted" | "settled" | "closed";
  readonly lease?: InvocationRunOwner;
  readonly messageId?: string;
}
declare const ordinaryOneTurnBrand: unique symbol;
export interface OrdinaryOneTurnSource { readonly [ordinaryOneTurnBrand]: true }
export interface OrdinaryOneTurnCapture {
  readonly request: Readonly<McpInvocationRequest>;
  readonly admission: Readonly<InvocationAdmissionIdentity>;
  readonly port: NativeOneStartPort;
  readonly controller: AbortController;
  /** InvocationService's actual private cell, never a SQL/wire projection. */
  readonly readState: () => OrdinaryOneTurnState;
  /** Recheck the exact reservation, pending/record/controller, actor and owner.
   * Observation modes must check physical cleanup even when Stop is set. */
  readonly assertCurrent: (mode: OrdinaryOneTurnMode) => void;
}
interface Held extends OrdinaryOneTurnCapture {
  readonly canonical: string;
  readonly inputDigest: string;
  readonly ownerProcessEpoch: string;
  readonly binding: NativeOneStartBinding;
}
const sources = new WeakMap<object, Held>();
const originalRequests = new WeakMap<object, OrdinaryOneTurnSource>();
function fail(): never { throw Object.assign(new Error("ordinary_one_turn_source_changed"), { code: "ordinary_one_turn_source_changed" }); }
function immutable(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(immutable);
}
/** InvocationService bootstrap only, after original Main admission consumption,
 * native-port registration and exact canonical pending reservation validation.
 * This function never admits a request, starts a run or writes a transcript. */
export function captureOrdinaryOneTurn(input: OrdinaryOneTurnCapture): OrdinaryOneTurnSource {
  assertNativeOneStartPort(input.port);
  if (!(input.controller instanceof AbortController) || !input.request.oneMode || !input.request.runId
    || input.request.chatId !== input.admission.chatId || input.request.runId !== input.admission.runId
    || !input.admission.ownerProcessEpoch || !immutable(input.request)
    || typeof input.readState !== "function" || typeof input.assertCurrent !== "function") fail();
  const canonical = canonicalInvocationRequestJson(input.request as McpInvocationRequest);
  if (canonical !== input.admission.canonicalRequestJson) fail();
  const prior = originalRequests.get(input.request);
  if (prior) {
    const held = sources.get(prior)!;
    if (held.port !== input.port || held.controller !== input.controller || held.admission !== input.admission
      || held.readState !== input.readState || held.assertCurrent !== input.assertCurrent) fail();
    readOrdinaryOneTurn(prior, "scope"); return prior;
  }
  const binding = Object.freeze({ chatId: input.request.chatId, runId: input.request.runId, admission: input.admission });
  const source = Object.freeze({}) as OrdinaryOneTurnSource;
  sources.set(source, Object.freeze({ ...input, canonical, binding, ownerProcessEpoch: input.admission.ownerProcessEpoch,
    inputDigest: createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(canonical).digest("hex") }));
  try { readOrdinaryOneTurn(source, "scope"); }
  catch (error) { sources.delete(source); throw error; }
  originalRequests.set(input.request, source);
  return source;
}
/** A WeakMap lookup and the live InvocationService fence precede every read.
 * Scope is preparation context only, not execution or persisted-message proof. */
export function readOrdinaryOneTurn(source: unknown, mode: OrdinaryOneTurnMode): Readonly<{
  request: Readonly<McpInvocationRequest>; admission: Readonly<InvocationAdmissionIdentity>;
  inputDigest: string; state: Readonly<OrdinaryOneTurnState>;
}> {
  const held = source && typeof source === "object" ? sources.get(source) : undefined;
  if (!held || !["scope", "execution", "message", "settlement", "closed"].includes(mode)) fail();
  assertNativeOneStartPort(held.port);
  held.assertCurrent(mode);
  if (held.request.runId !== held.binding.runId || held.request.chatId !== held.binding.chatId
    || held.admission.runId !== held.binding.runId || held.admission.chatId !== held.binding.chatId
    || held.admission.ownerProcessEpoch !== held.ownerProcessEpoch || held.admission.canonicalRequestJson !== held.canonical
    || canonicalInvocationRequestJson(held.request as McpInvocationRequest) !== held.canonical) fail();
  const state = held.readState();
  if (!state || !["preparing", "admitted", "settled", "closed"].includes(state.phase)) fail();
  if (mode === "scope" || mode === "execution" || mode === "message") {
    held.controller.signal.throwIfAborted(); held.port.assertCurrent(held.binding);
    if (mode === "scope" ? !["preparing", "admitted"].includes(state.phase) : state.phase !== "admitted") fail();
    if (state.phase === "admitted" && (!state.lease || state.lease.chatId !== held.binding.chatId
      || state.lease.runId !== held.binding.runId || state.lease.state !== "active")) fail();
    if (mode === "message" && (typeof state.messageId !== "string" || !state.messageId)) fail();
  } else if (mode === "settlement" ? state.phase !== "settled" : state.phase !== "closed") fail();
  const snapshot = Object.freeze({ ...state, ...(state.lease ? { lease: Object.freeze({ ...state.lease }) } : {}) });
  return Object.freeze({ request: held.request, admission: Object.freeze({ ...held.admission }), inputDigest: held.inputDigest, state: snapshot });
}
