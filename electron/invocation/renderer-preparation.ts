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
      // Owner 2026-10-14: the host never blocks the next turn. These judges only refine routing; a judge that fails or
      // times out leaves the request as typed. A 4 s timeout here refused the owner's Yotube message outright
      // (14:16:48Z, codex judge "timeout" -> native-ingress -> runtime_turn_unsettled), and the screen then retried the
      // refused start about five times a second. Up to 5 minutes, and never a refusal.
      const results = await withInvocationPreflightAccounting({ runId: captured.runId, chatId: request.chatId }, () => Promise.allSettled([
        prejudgeOneRequestIntent(request, { timeoutMs: 300_000, signal }),
        prejudgeOneMemoryIntent(request, { timeoutMs: 300_000, signal }),
      ]));
      signal?.throwIfAborted();
      for (const result of results) if (result.status === "rejected") console.warn("[invocation] preflight judge skipped:", result.reason instanceof Error ? result.reason.message : String(result.reason));
    },
    // The host owns this controller and observes all underlying judge promises.
    // Local capability thunks retain their original claim and cleanup lifetimes.
    async cancel() {},
    async quiesce() {},
    async finish() {},
  });
}
