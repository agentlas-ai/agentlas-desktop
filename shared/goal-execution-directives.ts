/** Main classifies existing owner messages; this projection cannot grant permissions. */
export type GoalExecutionDirectiveKind = "method" | "constraint" | "pending" | "ignored";
export interface GoalExecutionDirectiveRecord {
  schemaVersion: "agentlas.goal-execution-directive.v1";
  goalId: string;
  chatId: string;
  goalRevision: number;
  sourceMessageId: string;
  sourceDigest: string;
  kind: GoalExecutionDirectiveKind;
  reasonCode: string;
}

/** The review reasonCode prefix for "the judge gave no answer" (timeout, limit, pool change). It is an outage, not a
 * classification: unlike a semantic `unknown`, it is asked again (goal-owner-amendment.ts retry). */
export const GOAL_DIRECTIVE_JUDGE_UNAVAILABLE_PREFIX = "judge_unavailable:";

/** A pending record that stands only on a judge outage, so a later healthy judge may still classify the message. */
export function goalDirectiveReviewRetryable(record: Pick<GoalExecutionDirectiveRecord, "kind" | "reasonCode">): boolean {
  return record.kind === "pending" && record.reasonCode.startsWith(GOAL_DIRECTIVE_JUDGE_UNAVAILABLE_PREFIX);
}

export function isGoalExecutionDirectiveRecord(input: { goalId: string; chatId: string; revision: number }, raw: unknown):
  raw is GoalExecutionDirectiveRecord {
  if (!raw || typeof raw !== "object") return false;
  const record = raw as GoalExecutionDirectiveRecord;
  return !(record.schemaVersion !== "agentlas.goal-execution-directive.v1" || record.goalId !== input.goalId
    || record.chatId !== input.chatId || !Number.isSafeInteger(record.goalRevision)
    || record.goalRevision < 1 || record.goalRevision > input.revision
    || typeof record.sourceMessageId !== "string" || !record.sourceMessageId
    || typeof record.sourceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.sourceDigest)
    || !["method", "constraint", "pending", "ignored"].includes(record.kind)
    || typeof record.reasonCode !== "string");
}

/** Latest classification per exact source. Do not erase unrelated constraints
 * or guess semantic supersession from a keyword or a fixed history window. */
export function foldGoalExecutionDirectives(input: {
  goalId: string; chatId: string; revision: number; records: readonly unknown[];
}): GoalExecutionDirectiveRecord[] {
  const bySource = new Map<string, GoalExecutionDirectiveRecord>();
  for (const raw of input.records) {
    if (!isGoalExecutionDirectiveRecord(input, raw)) continue;
    bySource.set(raw.sourceMessageId, raw);
  }
  return [...bySource.values()].filter(record => record.kind !== "ignored");
}
