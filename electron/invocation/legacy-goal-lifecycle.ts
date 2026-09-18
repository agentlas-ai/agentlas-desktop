import { createHash } from "node:crypto";
import type { GoalSourceMessage } from "../../shared/auto-goal";
import type { RuntimeSelection } from "../../shared/types";
import { getDb } from "../store/db";
import { getLegacyGoalLifecycleSnapshot } from "../store/chat-goals";
import { getLongRun, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { judgeRequired, type JudgmentRuntimeReceipt } from "../system-agents/judgment";
import { GOAL_VERIFICATION_MODEL_TIMEOUT_MS } from "../long-run/criterion-proof";

type LifecycleVerdict = "ongoing" | "finite" | "unknown";
export interface LegacyGoalLifecyclePreparation {
  snapshot: NonNullable<ReturnType<typeof getLegacyGoalLifecycleSnapshot>>;
  source: GoalSourceMessage;
  snapshotDigest: string;
  verdict: LifecycleVerdict | "unavailable";
  reasonCode: string;
  runtimeReceipt?: JudgmentRuntimeReceipt;
}

/** Called only from the canonical native durable-message hook. This is a
 * classification, never a grant or resume. The caller revalidates its stopped
 * run CAS and this exact revision before applying anything in one transaction. */
export async function prepareLegacyGoalLifecycle(input: {
  goalId: string;
  longRunId: string;
  expectedVersion: number;
  expectedStatus: "paused" | "blocked";
  source: GoalSourceMessage;
  runtimeSelection?: RuntimeSelection;
  signal: AbortSignal;
}): Promise<LegacyGoalLifecyclePreparation | null> {
  const snapshot = getLegacyGoalLifecycleSnapshot(input.goalId);
  if (!snapshot) return null;
  const snapshotDigest = createHash("sha256").update(snapshot.payloadJson).digest("hex");
  const result = (verdict: LegacyGoalLifecyclePreparation["verdict"], reasonCode: string,
    runtimeReceipt?: JudgmentRuntimeReceipt): LegacyGoalLifecyclePreparation => ({
    snapshot, source: { ...input.source }, snapshotDigest, verdict, reasonCode, ...(runtimeReceipt ? { runtimeReceipt } : {}),
  });
  const run = getLongRun(input.longRunId);
  const source = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
    .get(input.source.messageId) as { chat_id: string; role: string; text: string } | undefined;
  if (!run || run.goalId !== input.goalId || run.version !== input.expectedVersion || run.status !== input.expectedStatus
    || run.rootChatId !== input.source.chatId || !["one", "work"].includes(run.surface)
    || snapshot.revision.chatId !== input.source.chatId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== snapshot.revision.revision
    || source?.chat_id !== input.source.chatId || source.role !== "user" || source.text !== input.source.text
    || input.source.role !== "user" || !input.source.text.trim()) return result("unavailable", "legacy-lifecycle-source-changed");
  // The generic revision binder cannot reinterpret a still-uncertain attempt.
  // Do not clear it, or invent another acknowledgement, for metadata migration.
  if (getDb().prepare("SELECT 1 FROM long_run_worker_attempts WHERE run_id = ? AND state IN ('running','uncertain') LIMIT 1").get(run.id)) {
    return result("unavailable", "legacy-lifecycle-attempt-unsettled");
  }
  const selection = input.runtimeSelection && { ...input.runtimeSelection };
  if (!selection?.kind || !selection.source?.trim() || !selection.model?.trim()) {
    return result("unavailable", "legacy-lifecycle-exact-runtime-required");
  }
  if (input.signal.aborted) return result("unavailable", "legacy-lifecycle-cancelled");
  try {
    const decision = await judgeRequired<LifecycleVerdict>({
      kind: "legacy-goal-lifecycle-user-resume-v1",
      question: "Does this current explicit user message confirm a continuing responsibility for this exact existing Goal until the user stops it?",
      labels: ["ongoing", "finite", "unknown"],
      input: JSON.stringify({ goalId: input.goalId, revision: snapshot.revision.revision, snapshotDigest,
        objective: snapshot.revision.objective, acceptanceCriteria: snapshot.revision.acceptanceCriteria,
        originalRequest: snapshot.revision.originalRequest, currentRevisionSource: snapshot.revision.sourceMessage,
        currentUserMessage: input.source }),
      guidance: "Evaluate the whole current objective, every edited criterion, original request and current user message together. Choose ongoing ONLY for an explicit continuing mandate, with no final deliverable/end condition, retained until the user stops it. The current message must actually confirm continuation of that mandate; old text, quotes, examples, SNS, timers, task difficulty and keywords alone are not authority. A bounded campaign, deadline, target, finite completion request or ordinary resume of finite work is finite. Contradiction, a status question, cancellation, a merely hypothetical request or ambiguous lifetime is unknown. Do not rewrite the goal or any criterion. This changes lifetime metadata only and grants no new permission, budget or external action.",
      runtimeSelection: selection,
      signal: input.signal,
      timeoutMs: GOAL_VERIFICATION_MODEL_TIMEOUT_MS,
      scanSecrets: true,
      maxInputChars: null,
    });
    const receipt = decision.runtimeReceipt;
    if (input.signal.aborted) return result("unavailable", "legacy-lifecycle-cancelled");
    if (decision.source !== "llm" || !decision.verdict || !["ongoing", "finite", "unknown"].includes(decision.verdict)
      || receipt?.route !== "explicit_pin"
      || (["kind", "backend", "source", "model"] as const).some(key => (receipt.selection[key] ?? null) !== (selection[key] ?? null))) {
      return result("unavailable", "legacy-lifecycle-judgment-unavailable");
    }
    return result(decision.verdict, "legacy-lifecycle-" + decision.verdict, receipt);
  } catch {
    return result("unavailable", "legacy-lifecycle-judgment-unavailable");
  }
}
