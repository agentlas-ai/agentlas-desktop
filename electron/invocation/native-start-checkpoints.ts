import type { McpInvocationRequest } from "../../shared/types";
import type { InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { handoffNativePreparation, type NativePreparationLifetime } from "../runtime/native-preparation-lifetime";
import { RuntimeTurnUnsettledError } from "../runtime/runner";

export type NativeOneStartCheckpointKind = "preparation.handoff" | "judge" | "team.prepare" | "team.attachments-required" | "briefing.prepare" | "memory.prepare" | "attachments.claim" | "team.claim" | "briefing.claim" | "memory.claim" | "images.transfer" | "team.fail-start" | "attachments.release";
export interface NativeOneStartBinding { readonly chatId: string; readonly runId: string; readonly admission: InvocationAdmissionIdentity }
export interface NativeOneStartCheckpoint {
  readonly kind: NativeOneStartCheckpointKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly local: () => unknown;
}
export interface NativeOneStartPort {
  assertCurrent(binding: NativeOneStartBinding): void;
  execute(binding: NativeOneStartBinding, checkpoint: Omit<NativeOneStartCheckpoint, "local">, signal: AbortSignal): Promise<unknown>;
  cancel(binding: NativeOneStartBinding): Promise<void>;
  /** Actual Main request/claim quiescence, not transport timeout or missing ACK. */
  quiesce(binding: NativeOneStartBinding, status: "handed-off" | "rejected" | "cancelled" | "uncertain"): Promise<void>;
  /** Cleanup only after preparation quiescence and released custody for non-handoff. */
  finish(binding: NativeOneStartBinding, status: "handed-off" | "rejected" | "cancelled" | "uncertain" | "settled"): Promise<void>;
}
const ports = new WeakSet<object>();
const localPorts = new WeakSet<object>();
export interface LocalInvocationPreparationPorts extends Omit<NativeOneStartPort, "execute"> {
  judge(request: McpInvocationRequest, signal: AbortSignal): Promise<void>;
}
/** Trusted same-process ingress only; wire data never selects local thunks. */
export function createLocalInvocationPreparationPort(implementation: LocalInvocationPreparationPorts): NativeOneStartPort {
  const port = createNativeOneStartPort({ ...implementation, execute: (_binding, checkpoint, signal) => implementation.judge(checkpoint.payload.request as McpInvocationRequest, signal) });
  localPorts.add(port);
  return port;
}
export function isLocalInvocationPreparationPort(port: NativeOneStartPort): boolean { return localPorts.has(port); }
/** Native bootstrap only. No caller-authored request field is this process-private port. */
export function createNativeOneStartPort(implementation: NativeOneStartPort): NativeOneStartPort {
  const port = Object.freeze({ ...implementation });
  ports.add(port);
  return port;
}
export function assertNativeOneStartPort(port: NativeOneStartPort): void {
  if (!ports.has(port)) throw new Error("native_one_start_port_required");
}
export function oneStartCheckpoint(kind: NativeOneStartCheckpointKind, payload: Record<string, unknown>, local: () => unknown): NativeOneStartCheckpoint {
  return Object.freeze({ kind, payload: Object.freeze({ ...payload }), local });
}
export function driveLocalOneStart<T>(steps: Generator<NativeOneStartCheckpoint, T, unknown>): T {
  let step = steps.next();
  while (!step.done) {
    let value: unknown;
    try { value = step.value.local(); }
    catch (error) { step = steps.throw(error); continue; }
    step = steps.next(value);
  }
  return step.value;
}
export async function driveNativeOneStart<T>(steps: Generator<NativeOneStartCheckpoint, T, unknown>, port: NativeOneStartPort, binding: NativeOneStartBinding, signal: AbortSignal, lifetime: NativePreparationLifetime): Promise<T> {
  assertNativeOneStartPort(port);
  let step = steps.next();
  while (!step.done) {
    let value: unknown;
    // Preserve the original local synchronous claim/cleanup sequence. Terminal
    // cleanup is unconditional even when Stop fired inside the preceding thunk.
    if (localPorts.has(port) && step.value.kind !== "judge" && step.value.kind !== "preparation.handoff") {
      const terminalCleanup = step.value.kind === "team.fail-start" || step.value.kind === "attachments.release";
      try {
        if (!terminalCleanup) { port.assertCurrent(binding); signal.throwIfAborted(); }
        value = step.value.local();
        if (!terminalCleanup) { port.assertCurrent(binding); signal.throwIfAborted(); }
      } catch (cause) { step = steps.throw(signal.aborted && !terminalCleanup ? signal.reason : cause); continue; }
      step = steps.next(value);
      continue;
    }
    const terminalCleanup = step.value.kind === "team.fail-start" || step.value.kind === "attachments.release";
    try {
      port.assertCurrent(binding);
      if (!terminalCleanup) signal.throwIfAborted();
      if (step.value.kind === "preparation.handoff") { lifetime.closeAdmission(); await lifetime.quiescent(); }
      // Never race away the actual await: Stop ACK and preparation quiescence are separate.
      value = localPorts.has(port) && step.value.kind !== "judge" ? step.value.local() : await port.execute(binding, { kind: step.value.kind, payload: step.value.payload }, signal);
      await lifetime.awaitRetained();
      port.assertCurrent(binding);
      if (!terminalCleanup) signal.throwIfAborted();
    } catch (cause) {
      await lifetime.awaitRetained();
      const error = signal.aborted && !terminalCleanup ? signal.reason : localPorts.has(port) ? cause : new RuntimeTurnUnsettledError("native-one-claim");
      if (error instanceof Error && error !== cause) Object.defineProperty(error, "cause", { value: cause });
      step = steps.throw(error);
      continue;
    }
    const handingOff = step.value.kind === "preparation.handoff";
    step = handingOff ? handoffNativePreparation(lifetime, () => steps.next(value)) : steps.next(value);
    if (handingOff && !step.done) throw new RuntimeTurnUnsettledError("native-one-handoff");
  }
  return step.value;
}
