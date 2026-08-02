import type { OneAutoRecoveryVerification } from "../../shared/types";
import { listChatMessages } from "../store/chats";
import { getInvocationRunReceipt, recordRunEvent } from "../store/run-events";
import { judgeOneRecoveryOutcome, type OneRecoveryOutcomeResult } from "./auto-recovery";

export interface VerifyOneRecoveryOutcomeInput {
  originalRunId: string;
  recoveryRunId: string;
  chatId: string;
  goal: string;
  attemptsSpent: number;
}

interface VerificationDependencies {
  judge?: typeof judgeOneRecoveryOutcome;
  messages?: typeof listChatMessages;
}

/**
 * Main-owned closure gate for automatic recovery. Kept outside IPC so the
 * receipt binding and durable assessment can be exercised as a real service,
 * not only source-inspected through an Electron handler.
 */
export async function verifyOneRecoveryOutcome(
  input: VerifyOneRecoveryOutcomeInput,
  dependencies: VerificationDependencies = {},
): Promise<OneAutoRecoveryVerification | null> {
  const { originalRunId, recoveryRunId, chatId } = input;
  if (!originalRunId || !recoveryRunId || !chatId || originalRunId === recoveryRunId) return null;
  const originalReceipt = getInvocationRunReceipt(originalRunId);
  const recoveryReceipt = getInvocationRunReceipt(recoveryRunId);
  if (
    !originalReceipt
    || !recoveryReceipt
    || originalReceipt.chatId !== chatId
    || recoveryReceipt.chatId !== chatId
    || !["failed", "interrupted"].includes(originalReceipt.status)
    || recoveryReceipt.status !== "completed"
  ) return null;

  const recoveryStartedAt = Date.parse(recoveryReceipt.startedAt);
  const recoveryFinishedAt = Date.parse(recoveryReceipt.finishedAt ?? recoveryReceipt.updatedAt);
  const resultText = (dependencies.messages ?? listChatMessages)(chatId, 200)
    .filter((message) => {
      const createdAt = Date.parse(message.createdAt);
      return message.role === "assistant"
        && Number.isFinite(createdAt)
        && createdAt >= recoveryStartedAt
        && createdAt <= recoveryFinishedAt + 1_000;
    })
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const judge = dependencies.judge ?? judgeOneRecoveryOutcome;
  const result: OneRecoveryOutcomeResult = await judge({
    originalReceipt,
    recoveryReceipt,
    goal: input.goal.slice(0, 4_000),
    resultText,
    attemptsSpent: Math.max(0, input.attemptsSpent),
  });
  const outcome = result.decision.verified
    ? "verified"
    : result.decision.retry
      ? "retry"
      : "stopped";
  const assessment = recordRunEvent({
    runId: recoveryRunId,
    chatId,
    kind: "one_recovery_outcome_assessed",
    payload: {
      originalRunId,
      recoveryRunId,
      outcome,
      ...(!result.decision.verified && !result.decision.retry
        ? { reason: result.decision.reason }
        : {}),
      decidedBy: result.decidedBy,
      attemptsSpent: Math.max(0, input.attemptsSpent),
    },
  });
  return {
    verified: result.decision.verified,
    retry: result.decision.retry,
    ...(result.decision.retry ? { attempt: result.decision.attempt } : {}),
    ...(!result.decision.verified && !result.decision.retry
      ? { reason: result.decision.reason }
      : {}),
    diagnosis: result.diagnosis,
    decidedBy: result.decidedBy,
    originalRunId,
    recoveryRunId,
    assessmentReceiptId: assessment.id,
  };
}
