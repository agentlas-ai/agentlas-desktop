/** Goal model only. Adapters own intent classification, authority and scheduling. */
export const AUTO_GOAL_SCHEMA = "agentlas.auto-goal.v1" as const;

/** Goal lifetime, not an episode budget or permission to perform effects. */
export type GoalLifecycle = "finite" | "ongoing";

/** Legacy revisions/host decisions retain finite semantics; corrupt values fail closed. */
export function resolveGoalLifecycle(value: unknown): GoalLifecycle {
  if (value === undefined) return "finite";
  if (value === "finite" || value === "ongoing") return value;
  throw new Error("goal_lifecycle_invalid");
}

/**
 * A bounded series the owner asked for: the same work repeated at a stated interval, ending after a stated number of
 * runs ("once an hour, ten in all"). Typed numbers the intake read from the owner's words; the host does the arithmetic
 * (goalCadenceDeadlineAt) and never reads the words again. Only a finite Goal carries one.
 */
export interface GoalCadence {
  everySeconds: number;
  maxRuns: number;
}

export const GOAL_CADENCE_LIMITS = {
  /** A timer wait closer than a minute is refused anyway (goal_wait_timer_invalid). */
  minEverySeconds: 60,
  maxEverySeconds: 7 * 86_400,
  /** One run is not a series. */
  minRuns: 2,
  maxRuns: 1_000,
  /** The wall-clock span of the whole series, last run plus one interval of slack. */
  maxHorizonMs: 180 * 86_400_000,
} as const;

/** The whole series in milliseconds: every run plus one interval of slack after the last scheduled one. */
export function goalCadenceHorizonMs(cadence: GoalCadence): number {
  return cadence.everySeconds * 1_000 * (cadence.maxRuns + 1);
}

/** Absent stays absent; a present value is exactly two in-range integers or the Goal is not admitted (fails closed). */
export function resolveGoalCadence(value: unknown): GoalCadence | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("goal_cadence_invalid");
  const { everySeconds, maxRuns } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(everySeconds) || !Number.isSafeInteger(maxRuns)) throw new Error("goal_cadence_invalid");
  const every = everySeconds as number, runs = maxRuns as number;
  if (every < GOAL_CADENCE_LIMITS.minEverySeconds || every > GOAL_CADENCE_LIMITS.maxEverySeconds
    || runs < GOAL_CADENCE_LIMITS.minRuns || runs > GOAL_CADENCE_LIMITS.maxRuns
    || goalCadenceHorizonMs({ everySeconds: every, maxRuns: runs }) > GOAL_CADENCE_LIMITS.maxHorizonMs) throw new Error("goal_cadence_invalid");
  return { everySeconds: every, maxRuns: runs };
}

/** The end of a series that started at `createdAt`; timer waits are allowed up to it. Null when the start is unreadable. */
export function goalCadenceDeadlineAt(createdAt: string, cadence: GoalCadence): string | null {
  const start = Date.parse(createdAt);
  return Number.isFinite(start) ? new Date(start + goalCadenceHorizonMs(cadence)).toISOString() : null;
}

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
  /** New judged execution decisions supply this; absent legacy decisions are finite. */
  lifecycle?: GoalLifecycle;
     
                                                                                           
                                                                                            
                                                                                             
                                                                                                       
     
  turnScope?: "single" | "multi";
  /**
   * A bounded series the intake read as typed numbers.
   * Present only on a finite, multi-turn execution decision; the Goal then carries it on its revision, timer waits are
   * allowed up to its end, and the service-turn follower hands the series to the host's own schedule instead of ending the
   * Goal with the first run.
   */
  cadence?: GoalCadence;
}

export interface GoalCriterion {
  id: string;
  text: string;
}

/**
 * A host-owned authority link for an explicit human amendment.  The original
 * request and its criteria remain audit data; this metadata only explains why
 * a later revision may carry a new, separately approved execution change.
 */
export interface GoalAmendment {
  kind: "automation_strategy";
  proposalId: string;
  proposalInputDigest: string;
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
  /** Missing only on legacy data. Ongoing criteria verify an episode, never end the goal. */
  lifecycle?: GoalLifecycle;
  /** A bounded series (finite only): the interval and the number of runs the owner stated. Kept by every later revision. */
  cadence?: GoalCadence;
  acceptanceCriteria: GoalCriterion[];
  /** References to existing host grants; this model cannot issue new grants. */
  authorityRefs: string[];
  /** Present only when a human explicitly approved a typed strategy change. */
  amendment?: GoalAmendment;
  /** Host-authored reauthorization metadata; changing permission is not a model amendment. */
  authorityChangedAt?: string;
  authorityChangeReason?: "user_permission_changed";
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
  if (!criteria.length) throw new Error("goal_criteria_required");
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

function validateAmendment(amendment: GoalAmendment | undefined): void {
  if (amendment === undefined) return;
  if (amendment.kind !== "automation_strategy"
    || typeof amendment.proposalId !== "string" || !amendment.proposalId.trim()
    || typeof amendment.proposalInputDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/i.test(amendment.proposalInputDigest)) {
    throw new Error("goal_amendment_invalid");
  }
}

/** Remove host attachment metadata and command syntax from derived goal text only.
 * Original/source messages remain exact authority evidence, including attachment bindings. */
export function goalObjectiveText(text: string): string {
  const visible = text.replace(/<!--\s*agentlas-chat-files:v1:([0-9a-f-]{36})\s*-->/giu, "");
  const objective = /^\s*\/goal(?:\s+|$)/.test(visible) ? visible.replace(/^\s*\/goal(?:\s+|$)/, "").trim() : visible;
  return visible === text ? objective : objective.trim();
}

/** Conservative admission: uncertainty never arms a background campaign. */
export function admitsAutomaticGoal(source: GoalSourceMessage, decision: GoalIntakeDecision): boolean {
  validateSource(source);
  const lifecycle = resolveGoalLifecycle(decision.lifecycle);
  if (resolveGoalCadence(decision.cadence) && lifecycle !== "finite") throw new Error("goal_cadence_requires_finite");
  return decision.messageId === source.messageId && decision.intent === "execute" && decision.commitment === "now"
    && decision.turnScope !== "single";
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
  required(goalObjectiveText(input.source.text), "goal_objective_required");
  validateTime(input.createdAt);
  input.authorityRefs.forEach((ref) => required(ref, "goal_authority_ref_invalid"));
  const cadence = resolveGoalCadence(input.decision.cadence);
  return {
    schemaVersion: AUTO_GOAL_SCHEMA,
    goalId: input.goalId,
    chatId: input.source.chatId,
    revision: 1,
    parentRevision: null,
    originalRequest: { ...input.source },
    sourceMessage: { ...input.source },
    objective: goalObjectiveText(input.source.text),
    reason: "initial_execution_request",
    lifecycle: resolveGoalLifecycle(input.decision.lifecycle),
    ...(cadence ? { cadence } : {}),
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
  amendment?: GoalAmendment;
}): GoalRevision {
  const { current, source } = input;
  validateSource(source);
  validateTime(input.createdAt);
  if (source.chatId !== current.chatId) throw new Error("goal_chat_mismatch");
  if (input.expectedRevision !== current.revision) throw new Error("goal_revision_conflict");
  if (source.messageId === current.sourceMessage.messageId) throw new Error("goal_message_already_applied");
  if (Date.parse(input.createdAt) < Date.parse(current.createdAt)) throw new Error("goal_timestamp_regression");
  required(goalObjectiveText(input.objective), "goal_objective_required");
  required(input.reason, "goal_revision_reason_required");
  validateAmendment(input.amendment);
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
  const { amendment: _previousAmendment, ...currentWithoutAmendment } = current;
  return {
    ...currentWithoutAmendment,
    revision: current.revision + 1,
    parentRevision: current.revision,
    originalRequest: { ...current.originalRequest },
    sourceMessage: { ...source },
    objective: goalObjectiveText(input.objective),
    reason: input.reason,
    // An ordinary amendment cannot silently change an ongoing mandate's lifetime.
    lifecycle: resolveGoalLifecycle(current.lifecycle),
    acceptanceCriteria: criteriaCopy([...input.retainedCriteria, ...input.addedCriteria]),
    authorityRefs: [...current.authorityRefs],
    ...(input.amendment ? { amendment: { ...input.amendment } } : {}),
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

/** Structural evidence gate (episode evidence for ongoing goals, not goal termination).
 * Evidence content/freshness on the target surface
 * must additionally be verified by the adapter, including Science lifecycle gates.
 */
export function hasCurrentGoalEvidence(goal: GoalRevision, evidence: readonly GoalCriterionEvidence[]): boolean {
  return goal.acceptanceCriteria.length > 0 && goal.acceptanceCriteria.every((criterion) => {
    const receipts = evidence.filter((item) => item.goalId === goal.goalId && item.revision === goal.revision && item.criterionId === criterion.id);
    return receipts.length === 1 && receipts[0]!.verdict === "passed" && Boolean(receipts[0]!.evidenceRef.trim()) &&
      Number.isFinite(Date.parse(receipts[0]!.verifiedAt)) && Date.parse(receipts[0]!.verifiedAt) >= Date.parse(goal.createdAt);
  });
}
