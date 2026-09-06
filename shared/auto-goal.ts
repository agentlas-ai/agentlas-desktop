/** Goal model only. Adapters own intent classification, authority and scheduling. */
export const AUTO_GOAL_SCHEMA = "agentlas.auto-goal.v1" as const;

export interface GoalSourceMessage {
  chatId: string;
  messageId: string;
  role: "user";
  text: string;
}

/** A host decision about the current user message, never a tool/document quote. */
export interface GoalIntakeDecision {
  messageId: string;
  intent: "execute" | "question" | "explore" | "conditional" | "unknown";
  commitment: "now" | "later" | "uncertain";
}

export interface GoalCriterion {
  id: string;
  text: string;
}

export interface GoalRevision {
  schemaVersion: typeof AUTO_GOAL_SCHEMA;
  goalId: string;
  chatId: string;
  revision: number;
  parentRevision: number | null;
  originalRequest: GoalSourceMessage;
  sourceMessage: GoalSourceMessage;
  objective: string;
  reason: string;
  acceptanceCriteria: GoalCriterion[];
  /** References to existing host grants; this model cannot issue new grants. */
  authorityRefs: string[];
  createdAt: string;
}

function required(value: string, code: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
}

function validateSource(source: GoalSourceMessage): void {
  if (source.role !== "user") throw new Error("goal_user_source_required");
  required(source.chatId, "goal_chat_required");
  required(source.messageId, "goal_message_required");
  required(source.text, "goal_request_required");
}

function criteriaCopy(criteria: readonly GoalCriterion[]): GoalCriterion[] {
  if (!criteria.length || criteria.length > 128) throw new Error("goal_criteria_required");
  const ids = new Set<string>();
  return criteria.map((criterion) => {
    required(criterion.id, "goal_criterion_id_required");
    required(criterion.text, "goal_criterion_text_required");
    if (ids.has(criterion.id)) throw new Error("goal_criterion_id_duplicate");
    ids.add(criterion.id);
    return { ...criterion };
  });
}

function validateTime(at: string): void {
  if (!Number.isFinite(Date.parse(at))) throw new Error("goal_timestamp_invalid");
}

/** Conservative admission: uncertainty never arms a background campaign. */
export function admitsAutomaticGoal(source: GoalSourceMessage, decision: GoalIntakeDecision): boolean {
  validateSource(source);
  return decision.messageId === source.messageId && decision.intent === "execute" && decision.commitment === "now";
}

export function createAutomaticGoalRevision(input: {
  goalId: string;
  source: GoalSourceMessage;
  decision: GoalIntakeDecision;
  acceptanceCriteria: readonly GoalCriterion[];
  authorityRefs: readonly string[];
  createdAt: string;
}): GoalRevision | null {
  if (!admitsAutomaticGoal(input.source, input.decision)) return null;
  required(input.goalId, "goal_id_required");
  validateTime(input.createdAt);
  input.authorityRefs.forEach((ref) => required(ref, "goal_authority_ref_invalid"));
  return {
    schemaVersion: AUTO_GOAL_SCHEMA,
    goalId: input.goalId,
    chatId: input.source.chatId,
    revision: 1,
    parentRevision: null,
    originalRequest: { ...input.source },
    sourceMessage: { ...input.source },
    objective: input.source.text,
    reason: "initial_execution_request",
    acceptanceCriteria: criteriaCopy(input.acceptanceCriteria),
    authorityRefs: [...new Set(input.authorityRefs)],
    createdAt: input.createdAt,
  };
}

/** Host must resolve explicit user amendments before calling this function.
 * Existing criteria survive unless the user explicitly removes their IDs.
 * In-place edits of criterion text are forbidden: remove + add preserves audit identity.
 */
export function reviseAutomaticGoal(input: {
  current: GoalRevision;
  expectedRevision: number;
  source: GoalSourceMessage;
  objective: string;
  reason: string;
  retainedCriteria: readonly GoalCriterion[];
  addedCriteria: readonly GoalCriterion[];
  explicitlyRemovedCriterionIds: readonly string[];
  createdAt: string;
}): GoalRevision {
  const { current, source } = input;
  validateSource(source);
  validateTime(input.createdAt);
  if (source.chatId !== current.chatId) throw new Error("goal_chat_mismatch");
  if (input.expectedRevision !== current.revision) throw new Error("goal_revision_conflict");
  if (source.messageId === current.sourceMessage.messageId) throw new Error("goal_message_already_applied");
  if (Date.parse(input.createdAt) < Date.parse(current.createdAt)) throw new Error("goal_timestamp_regression");
  required(input.objective, "goal_objective_required");
  required(input.reason, "goal_revision_reason_required");
  const removed = new Set(input.explicitlyRemovedCriterionIds);
  const previous = new Map(current.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
  if (removed.size !== input.explicitlyRemovedCriterionIds.length || [...removed].some((id) => !previous.has(id))) {
    throw new Error("goal_removed_criterion_invalid");
  }
  const retained = new Map(input.retainedCriteria.map((criterion) => [criterion.id, criterion.text]));
  if (retained.size !== previous.size - removed.size || [...previous].some(([id, text]) =>
    removed.has(id) ? retained.has(id) : retained.get(id) !== text)) {
    throw new Error("goal_criteria_silently_redefined");
  }
  if (input.addedCriteria.some((criterion) => previous.has(criterion.id))) throw new Error("goal_criterion_id_reused");
  return {
    ...current,
    revision: current.revision + 1,
    parentRevision: current.revision,
    originalRequest: { ...current.originalRequest },
    sourceMessage: { ...source },
    objective: input.objective,
    reason: input.reason,
    acceptanceCriteria: criteriaCopy([...input.retainedCriteria, ...input.addedCriteria]),
    authorityRefs: [...current.authorityRefs],
    createdAt: input.createdAt,
  };
}

export interface GoalCriterionEvidence {
  goalId: string;
  revision: number;
  criterionId: string;
  verdict: "passed" | "failed" | "inconclusive";
  evidenceRef: string;
  verifiedAt: string;
}

/** Structural completion gate. Evidence content/freshness on the target surface
 * must additionally be verified by the adapter, including Science lifecycle gates.
 */
export function hasCurrentGoalEvidence(goal: GoalRevision, evidence: readonly GoalCriterionEvidence[]): boolean {
  return goal.acceptanceCriteria.length > 0 && goal.acceptanceCriteria.every((criterion) => {
    const receipts = evidence.filter((item) => item.goalId === goal.goalId && item.revision === goal.revision && item.criterionId === criterion.id);
    return receipts.length === 1 && receipts[0]!.verdict === "passed" && Boolean(receipts[0]!.evidenceRef.trim()) &&
      Number.isFinite(Date.parse(receipts[0]!.verifiedAt)) && Date.parse(receipts[0]!.verifiedAt) >= Date.parse(goal.createdAt);
  });
}
