import { createHash } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import { createNativeOneStartPort, type NativeOneStartPort, type NativeOneStartBinding } from "../invocation/native-start-checkpoints";
import { createRendererInvocationPreparation } from "../invocation/renderer-preparation";
import { canonicalInvocationRequestJson, INVOCATION_ADMISSION_DIGEST_VERSION, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { importNativeOneAttachmentImages, type NativeOneImageDescriptor, type NativeOneImageChunk } from "./native-image-transport";
import { nativeStartDescriptor, type NativePreparationWireAction, type NativeStartDescriptor } from "./native-start-protocol";
import type { NativePreparationControl } from "./native-preparation-control";

/** Constructed only after exact authenticated original Main issuer verification
 * and full immutable request import. It runs the original generator checkpoints,
 * never a new start algorithm or provider-specific controller. */
export function createDaemonNativePreparationPort(options: {
  start: NativeStartDescriptor;
  request: McpInvocationRequest;
  admission: InvocationAdmissionIdentity;
  /** Receiver's shared transfer resource admission, not a producer schema cap. */
  importCheckpointValue(value: unknown, signal: AbortSignal): Promise<unknown>;
  assertCurrent(): void;
  control: NativePreparationControl;
  claimAttachments(payload: Readonly<Record<string, unknown>>): Promise<unknown>;
}): NativeOneStartPort {
  const start = nativeStartDescriptor(options.start), admission = Object.freeze({ ...options.admission });
  const capturedRequest = structuredClone(options.request);
  const freeze = (value: unknown): void => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } };
  freeze(capturedRequest);
  if (admission.chatId !== start.binding.chatId || admission.runId !== start.binding.runId
    || capturedRequest.chatId !== admission.chatId || capturedRequest.runId !== admission.runId
    || canonicalInvocationRequestJson(capturedRequest) !== admission.canonicalRequestJson
    || createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(admission.canonicalRequestJson).digest("hex") !== start.binding.inputDigest) throw new Error("native_preparation_input_mismatch");
  const localJudge = createRendererInvocationPreparation(admission);
  if (options.control.start.handle !== start.handle || options.control.start.binding.chatId !== start.binding.chatId
    || options.control.start.binding.runId !== start.binding.runId || options.control.start.binding.inputDigest !== start.binding.inputDigest) throw new Error("native_preparation_input_mismatch");
  function assertCurrent(binding: NativeOneStartBinding): void {
    options.assertCurrent();
    if (binding.chatId !== admission.chatId || binding.runId !== admission.runId || binding.admission.chatId !== admission.chatId
      || binding.admission.runId !== admission.runId || binding.admission.ownerProcessEpoch !== admission.ownerProcessEpoch
      || binding.admission.canonicalRequestJson !== admission.canonicalRequestJson) throw new Error("native_preparation_input_mismatch");
  }
  async function call(action: NativePreparationWireAction, payload: Record<string, unknown>): Promise<unknown> {
    options.assertCurrent();
    const value = await options.control.request(action, payload);
    options.assertCurrent();
    return value;
  }
  async function checkpointValue(kind: string, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    const value = kind === "attachments.claim" ? await options.claimAttachments(payload) : await call("checkpoint", { kind, payload });
    return options.importCheckpointValue(value, signal);
  }
  return createNativeOneStartPort({
    assertCurrent,
    async execute(binding, checkpoint, signal) {
      const terminalCleanup = checkpoint.kind === "team.fail-start" || checkpoint.kind === "attachments.release";
      assertCurrent(binding); if (!terminalCleanup) signal.throwIfAborted();
      if (checkpoint.kind === "judge") {
        // The original judges warm process-local caches. Execute them in this
        // daemon's real preparation ALS, accounting and actual AbortController.
        await localJudge.execute(binding, { kind: "judge", payload: { request: capturedRequest } }, signal);
        assertCurrent(binding); signal.throwIfAborted();
        return undefined;
      }
      if (checkpoint.kind === "preparation.handoff") return undefined;
      if (terminalCleanup) {
        await call("checkpoint", { kind: checkpoint.kind, payload: checkpoint.payload });
        return undefined;
      }
      const value = await checkpointValue(checkpoint.kind, checkpoint.payload, signal);
      assertCurrent(binding); signal.throwIfAborted();
      if (checkpoint.kind !== "images.transfer") return value;
      if (!Array.isArray(value)) throw new Error("one_native_image_metadata_invalid");
      return importNativeOneAttachmentImages(value as NativeOneImageDescriptor[],
        async payload => { const result = await call("one.image.read", payload); assertCurrent(binding); return result as NativeOneImageChunk; }, signal);
    },
    cancel(binding) {
      // The source and prepared driver share one exact actual Stop promise.
      assertCurrent(binding); return options.control.cancel();
    },
    quiesce(binding, status) { assertCurrent(binding); return options.control.quiesce(status); },
    finish(binding, status) { assertCurrent(binding); return options.control.finish(status); },
  });
}
