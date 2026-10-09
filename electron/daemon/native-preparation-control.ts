import { assertNativePreparationAcknowledgement, makeNativePreparationWireRequest, nativeStartDescriptor, type NativePreparationWireAction, type NativePreparationWireRequest, type NativeStartDescriptor } from "./native-start-protocol";

export type NativePreparationStatus = "handed-off" | "rejected" | "cancelled" | "uncertain";
export interface NativePreparationControl {
  readonly start: NativeStartDescriptor;
  readonly preparationCompleted: boolean;
  request(action: NativePreparationWireAction, payload: Readonly<Record<string, unknown>>): Promise<unknown>;
  cancel(): Promise<void>;
  quiesce(status: NativePreparationStatus): Promise<void>;
  finish(status: NativePreparationStatus | "settled"): Promise<void>;
  /** A genuine service-held frontier token, never a wire value or boolean. */
  rejectBeforePrepared(proof: object): Promise<void>;
}

/** One native source and its prepared port share these exact promises. This
 * owns no admission, brain, execution root or expiry/retry mechanism. */
export function createNativePreparationControl(options: {
  start: NativeStartDescriptor;
  assertCurrent(): void;
  ordinary(request: NativePreparationWireRequest): Promise<unknown>;
  terminal(request: NativePreparationWireRequest): Promise<unknown>;
  rejectClosedIngress(request: NativePreparationWireRequest, proof: object): Promise<unknown>;
  onReleased?(): void;
}): NativePreparationControl {
  const start = nativeStartDescriptor(options.start);
  let cancellation: Promise<void> | undefined;
  let quiescence: Promise<void> | undefined;
  let preparationFinish: Promise<void> | undefined;
  let executionFinish: Promise<void> | undefined;
  let ingressRejection: Promise<void> | undefined;
  let preparationCompleted = false;
  let physicallyReleased = false;
  let preparationRequested!: () => void;
  const requestedPreparation = new Promise<void>(resolve => { preparationRequested = resolve; });
  function released(): void {
    if (!physicallyReleased) { physicallyReleased = true; options.onReleased?.(); }
  }
  function call(action: NativePreparationWireAction, payload: Readonly<Record<string, unknown>>, proof?: object) {
    const request = makeNativePreparationWireRequest(start, action, { ...payload });
    // Cache owners retain this whole real promise, including signed completion.
    // Local queue refusal, channel loss, or lost ACK never creates another call.
    return Promise.resolve().then(() => {
      options.assertCurrent();
      if (action === "ingress.reject") {
        if (!proof || typeof proof !== "object") throw new Error("native_ingress_frontier_proof_required");
        return options.rejectClosedIngress(request, proof);
      }
      const terminal = action === "cancel" || action === "quiesce" || action === "finish"
        || (action === "checkpoint" && (payload.kind === "team.fail-start" || payload.kind === "attachments.release"));
      return terminal ? options.terminal(request) : options.ordinary(request);
    }).then(value => { options.assertCurrent(); return { request, value }; });
  }
  function acknowledge(action: NativePreparationWireAction, payload: Readonly<Record<string, unknown>>, expected: Parameters<typeof assertNativePreparationAcknowledgement>[2], proof?: object): Promise<void> {
    return call(action, payload, proof).then(({ request, value }) => { assertNativePreparationAcknowledgement(value, request, expected); });
  }
  const control: NativePreparationControl = {
    start,
    get preparationCompleted() { return preparationCompleted; },
    request(action, payload) {
      // Terminal custody operations have one owner; arbitrary request callers
      // cannot bypass their original retained/cached promises.
      if (["cancel", "quiesce", "finish", "ingress.reject"].includes(action)) return Promise.reject(new Error("native_preparation_control_method_required"));
      return call(action, payload).then(({ request, value }) => {
        if (action === "issuer.authorize") assertNativePreparationAcknowledgement(value, request, "authorized");
        if (action === "checkpoint" && (payload.kind === "team.fail-start" || payload.kind === "attachments.release")) {
          assertNativePreparationAcknowledgement(value, request, "cleanup-recorded");
        }
        return value;
      });
    },
    cancel() { return cancellation ??= acknowledge("cancel", {}, "cancelled"); },
    quiesce(status) { return quiescence ??= acknowledge("quiesce", { status }, "quiescent"); },
    finish(status) {
      if (status === "settled") return executionFinish ??= requestedPreparation.then(() => preparationFinish).then(() => {
        // A fast brain can settle before preparation's signed finish. Wait for
        // that exact completion; an already released custody needs no new RPC.
        if (physicallyReleased) return;
        return acknowledge("finish", { status }, "released").then(released);
      });
      // Parent ingress status can differ from the child prepared catch status.
      // Both observe one original completion; they do not consume another nonce.
      if (!preparationFinish) {
        preparationFinish = call("finish", { status }).then(({ request, value }) => {
          // Main may observe the real owner already released before handoff.
          // Both outcomes are exact signed acknowledgements of this request.
          const releasedAtHandoff = status === "handed-off" && value !== null && typeof value === "object"
            && (value as { status?: unknown }).status === "released";
          assertNativePreparationAcknowledgement(value, request,
            status === "handed-off" && !releasedAtHandoff ? "quiesced-retained" : "released");
          preparationCompleted = true;
          if (status !== "handed-off" || releasedAtHandoff) released();
        });
        preparationRequested();
      }
      return preparationFinish;
    },
    rejectBeforePrepared(proof) { return ingressRejection ??= acknowledge("ingress.reject", {}, "rejected-before-start", proof); },
  };
  return Object.freeze(control);
}
