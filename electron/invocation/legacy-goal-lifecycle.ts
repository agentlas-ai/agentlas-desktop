import { createHash } from "node:crypto";
import type { GoalSourceMessage } from "../../shared/auto-goal";
import type { RuntimeSelection } from "../../shared/types";
import type { LongRunRuntimeSelection } from "../../shared/long-run";
import { getDb } from "../store/db";
import { getLegacyGoalLifecycleSnapshot } from "../store/chat-goals";
import { getLongRun, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { restoreExactDesktopRuntimeSelection } from "../long-run/exact-runtime-binding";
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

/** Recover the latest controller's exact persisted selection. Missing or
 * conflicting identity is a refusal; migration never chooses another model. */
export function exactLegacyGoalLifecycleRuntimeSelection(input: {
  longRunId: string;
  chatId: string;
}): RuntimeSelection | null {
  const row = getDb().prepare(`SELECT a.id, a.invocation_run_id, a.runtime_selection_json,
      w.runtime_selection_json AS worker_runtime_selection_json
    FROM long_run_worker_attempts AS a
    JOIN long_run_workers AS w ON w.id = a.worker_id AND w.run_id = a.run_id
    WHERE a.run_id = ? AND w.role = 'controller' AND a.invocation_run_id IS NOT NULL
    ORDER BY a.rowid DESC LIMIT 1`).get(input.longRunId) as {
      id: string;
      invocation_run_id: string;
      runtime_selection_json: string;
      worker_runtime_selection_json: string;
    } | undefined;
  if (!row || row.runtime_selection_json !== row.worker_runtime_selection_json) return null;
  try {
    return restoreExactDesktopRuntimeSelection({
      stored: JSON.parse(row.runtime_selection_json) as LongRunRuntimeSelection,
      context: {
        invocationRunId: row.invocation_run_id,
        longRunId: input.longRunId,
        attemptId: row.id,
        chatId: input.chatId,
      },
    });
  } catch {
    return null;
  }
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
  /** The trusted native Resume handler will acknowledge non-live attempts in
   * the same transaction before applying the prepared migration. */
  nativeUserResume?: boolean;
  /** Startup reads the exact stored user source, but never acknowledges an
   * uncertain attempt or treats a Resume click as new authority. */
  hostStoredSourceRecovery?: boolean;
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
  const original = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
    .get(snapshot.revision.originalRequest.messageId) as { chat_id: string; role: string; text: string } | undefined;
  if (!run || run.goalId !== input.goalId || run.version !== input.expectedVersion || run.status !== input.expectedStatus
    || run.rootChatId !== input.source.chatId || !["one", "work"].includes(run.surface)
    || snapshot.revision.chatId !== input.source.chatId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== snapshot.revision.revision
    || source?.chat_id !== input.source.chatId || source.role !== "user" || source.text !== input.source.text
    || original?.chat_id !== input.source.chatId || original.role !== "user"
    || original.text !== snapshot.revision.originalRequest.text
    || input.source.role !== "user" || !input.source.text.trim()) return result("unavailable", "legacy-lifecycle-source-changed");
  // The generic revision binder cannot reinterpret a still-uncertain attempt.
  // Do not clear it, or invent another acknowledgement, for metadata migration.
  const unsettled = getDb().prepare(`SELECT state FROM long_run_worker_attempts
    WHERE run_id = ? AND state IN ('running','uncertain')
    ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END LIMIT 1`)
    .get(run.id) as { state: "running" | "uncertain" } | undefined;
  if (unsettled && (!input.nativeUserResume || unsettled.state === "running")) {
    return result("unavailable", "legacy-lifecycle-attempt-unsettled");
  }
  const selection = input.runtimeSelection && { ...input.runtimeSelection };
  if (!selection?.kind || !selection.source?.trim() || !selection.model?.trim()) {
    return result("unavailable", "legacy-lifecycle-exact-runtime-required");
  }
  if (input.signal.aborted) return result("unavailable", "legacy-lifecycle-cancelled");
  try {
    const nativeStoredSource = input.nativeUserResume === true || input.hostStoredSourceRecovery === true;
    const decision = await judgeRequired<LifecycleVerdict>({
      kind: input.hostStoredSourceRecovery ? "legacy-goal-lifecycle-host-startup-v1" : "legacy-goal-lifecycle-user-resume-v1",
      question: nativeStoredSource
        ? "Does this exact stored user-authored Goal source explicitly establish a continuing responsibility until the user stops it?"
        : "Does this current explicit user message confirm a continuing responsibility for this exact existing Goal until the user stops it?",
      labels: ["ongoing", "finite", "unknown"],
      input: JSON.stringify({ goalId: input.goalId, revision: snapshot.revision.revision, snapshotDigest,
        objective: snapshot.revision.objective, acceptanceCriteria: snapshot.revision.acceptanceCriteria,
        originalRequest: snapshot.revision.originalRequest, currentRevisionSource: snapshot.revision.sourceMessage,
        ...(nativeStoredSource ? { exactStoredUserSource: input.source } : { currentUserMessage: input.source }) }),
      guidance: (nativeStoredSource
        ? "The Resume click is not ongoing authority and supplies no prose. Evaluate only the exact stored user-authored source together with the immutable objective, every edited criterion and original request. The stored source itself must explicitly say that the responsibility continues without a final end condition until the user stops it."
        : "Evaluate the whole current objective, every edited criterion, original request and current user message together. The current message must actually confirm continuation of that mandate.")
        + " Choose ongoing ONLY for an explicit continuing mandate, with no final deliverable/end condition, retained until the user stops it. Old text outside the exact stored source, quotes, examples, SNS, timers, task difficulty and keywords alone are not authority. A bounded campaign, deadline, target, finite completion request or ordinary resume of finite work is finite. Contradiction, a status question, cancellation, a merely hypothetical request or ambiguous lifetime is unknown. Do not rewrite the goal or any criterion. This changes lifetime metadata only and grants no new permission, budget or external action.",
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
