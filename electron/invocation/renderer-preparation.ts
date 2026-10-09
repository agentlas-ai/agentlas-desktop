import { createLocalInvocationPreparationPort } from "./native-start-checkpoints";
import type { InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { withInvocationPreflightAccounting } from "../long-run/accounting-context";
import { prejudgeOneRequestIntent } from "../one/judged-request-intent";
import { prejudgeOneMemoryIntent } from "../one/memory-detector";

/** Called only after the trusted renderer boundary reserves this exact request.
 * The common host keeps preparation, Stop and drain ahead of every AI adapter. */
export function createRendererInvocationPreparation(admission: InvocationAdmissionIdentity) {
  const captured = Object.freeze({ ...admission });
  return createLocalInvocationPreparationPort({
    assertCurrent(binding) {
      if (binding.runId !== captured.runId || binding.chatId !== captured.chatId
        || binding.admission.runId !== captured.runId || binding.admission.chatId !== captured.chatId
        || binding.admission.ownerProcessEpoch !== captured.ownerProcessEpoch
        || binding.admission.canonicalRequestJson !== captured.canonicalRequestJson) {
        throw new Error("invocation_admission_request_identity_mismatch");
      }
    },
    async judge(request, signal) {
      // Work has its own execution contract; only One uses these semantic judges.
      if (request.oneMode !== true) return;
      await withInvocationPreflightAccounting({ runId: captured.runId, chatId: request.chatId }, () => Promise.all([
        prejudgeOneRequestIntent(request, { timeoutMs: 4_000, signal }),
        prejudgeOneMemoryIntent(request, { timeoutMs: 4_000, signal }),
      ]));
    },
    // The host owns this controller and observes all underlying judge promises.
    // Local capability thunks retain their original claim and cleanup lifetimes.
    async cancel() {},
    async quiesce() {},
    async finish() {},
  });
}
