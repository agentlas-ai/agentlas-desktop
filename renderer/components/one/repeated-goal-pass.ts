import type { GoalResultPresentation } from "../../../shared/goal-result";

type GoalPassMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  createdAt?: string;
  goalResult?: GoalResultPresentation;
  hostNotice?: unknown;
  images?: readonly string[];
  files?: readonly unknown[];
  chatFiles?: readonly unknown[];
  chatFileGroupIds?: readonly string[];
};

const MAX_REPEATED_PASS_GAP_MS = 5 * 60 * 1_000;

function isUnboundPendingGoalResult(result?: GoalResultPresentation): result is GoalResultPresentation {
  return result?.status === "pending" && result.runId === null;
}

function hasVisibleAttachments(message: GoalPassMessage): boolean {
  return Boolean(
    message.images?.length
    || message.files?.length
    || message.chatFiles?.length
    || message.chatFileGroupIds?.length,
  );
}

function isRepeatedPendingGoalPass(previous: GoalPassMessage, current: GoalPassMessage): boolean {
  if (previous.role !== "assistant" || current.role !== "assistant") return false;
  if (!previous.text.trim() || previous.text !== current.text) return false;
  if (!isUnboundPendingGoalResult(previous.goalResult) || !isUnboundPendingGoalResult(current.goalResult)) return false;
  if (previous.goalResult.goalId !== current.goalResult.goalId) return false;
  if (previous.hostNotice || current.hostNotice || hasVisibleAttachments(previous) || hasVisibleAttachments(current)) return false;
  if (!previous.createdAt || !current.createdAt) return false;
  const gap = Date.parse(current.createdAt) - Date.parse(previous.createdAt);
  return Number.isFinite(gap) && gap >= 0 && gap <= MAX_REPEATED_PASS_GAP_MS;
}

/**
 * A continuous Goal pass is persisted before the host knows whether another
 * pass is required. If the next pass produces the exact same pending result,
 * retain only the newer durable row that the terminal event can own.
 */
export function collapseRepeatedPendingGoalPasses<T extends GoalPassMessage>(messages: readonly T[]): T[] {
  const visible: T[] = [];
  for (const message of messages) {
    const previous = visible[visible.length - 1];
    if (previous && isRepeatedPendingGoalPass(previous, message)) visible[visible.length - 1] = message;
    else visible.push(message);
  }
  return visible;
}
