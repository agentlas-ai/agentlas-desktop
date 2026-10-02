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

/** Latest classification per exact source. Do not erase unrelated constraints
 * or guess semantic supersession from a keyword or a fixed history window. */
export function foldGoalExecutionDirectives(input: {
  goalId: string; chatId: string; revision: number; records: readonly unknown[];
}): GoalExecutionDirectiveRecord[] {
  const bySource = new Map<string, GoalExecutionDirectiveRecord>();
  for (const raw of input.records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as GoalExecutionDirectiveRecord;
    if (record.schemaVersion !== "agentlas.goal-execution-directive.v1" || record.goalId !== input.goalId
      || record.chatId !== input.chatId || !Number.isSafeInteger(record.goalRevision)
      || record.goalRevision < 1 || record.goalRevision > input.revision
      || typeof record.sourceMessageId !== "string" || !record.sourceMessageId
      || typeof record.sourceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.sourceDigest)
      || !["method", "constraint", "pending", "ignored"].includes(record.kind)
      || typeof record.reasonCode !== "string") continue;
    bySource.set(record.sourceMessageId, record);
  }
  return [...bySource.values()].filter(record => record.kind !== "ignored");
}
