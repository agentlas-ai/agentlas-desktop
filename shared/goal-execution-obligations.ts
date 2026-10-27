import type { OrchestrationTarget } from "./types";

/** Durable owner intent, never a runtime lease or permission grant. */
export interface GoalExecutionObligations {
  schemaVersion: "agentlas.goal-execution-obligations.v1";
  version: number;
  source: {
    chatId: string; messageId: string; runId: string; promptDigest: string;
    kind: "claimed_preflight" | "owner_invocation";
    proposalId?: string; taskId: string; taskVersion: number;
  };
  participants: Array<{ id: string; target: OrchestrationTarget; role: "participant" | "reviewer" }>;
  reviewAssignments: "unresolved" | "confirmed";
}

export function goalParticipantTargetRef(target: OrchestrationTarget): string {
  return target.source === "local"
    ? `local:${target.entityKind}:${target.entityKind === "agent" ? target.agentId : target.firmId}`
    : `${target.source}:${target.entityKind}:${target.slug}`;
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);

export function copyGoalExecutionObligations(value: GoalExecutionObligations | undefined): GoalExecutionObligations | undefined {
  if (value === undefined) return undefined;
  if (!value || value.schemaVersion !== "agentlas.goal-execution-obligations.v1"
    || !Number.isSafeInteger(value.version) || value.version < 1
    || !["unresolved", "confirmed"].includes(value.reviewAssignments)
    || !value.source || ![value.source.chatId, value.source.messageId, value.source.runId, value.source.taskId].every(text)
    || !["claimed_preflight", "owner_invocation"].includes(value.source.kind)
    || (value.source.kind === "claimed_preflight" && !text(value.source.proposalId))
    || !/^[a-f0-9]{64}$/i.test(value.source.promptDigest)
    || !Number.isSafeInteger(value.source.taskVersion) || value.source.taskVersion < 1
    || !Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 32) {
    throw new Error("goal_execution_obligations_invalid");
  }
  const identities = new Set<string>(), ids = new Set<string>();
  for (const participant of value.participants) {
    const target = participant?.target;
    if (!participant || !text(participant.id) || !["participant", "reviewer"].includes(participant.role)
      || !target || !["local", "cloud", "hub"].includes(target.source) || !["agent", "team"].includes(target.entityKind)
      || !(target.source === "local" ? text(target.entityKind === "agent" ? target.agentId : target.firmId) : text(target.slug))) {
      throw new Error("goal_execution_obligations_invalid");
    }
    const key = goalParticipantTargetRef(target);
    if (ids.has(participant.id) || identities.has(key)) throw new Error("goal_execution_obligations_duplicate");
    ids.add(participant.id); identities.add(key);
  }
  return JSON.parse(JSON.stringify(value)) as GoalExecutionObligations;
}

/** Typed planner roles may only strengthen an already selected participant's duty. */
export function confirmGoalReviewAssignments(current: GoalExecutionObligations, reviewerTargetRefs: readonly string[]): GoalExecutionObligations {
  const next = copyGoalExecutionObligations(current)!;
  const selected = new Set(next.participants.map(p => goalParticipantTargetRef(p.target)));
  if (reviewerTargetRefs.some(ref => !selected.has(ref))) throw new Error("goal_reviewer_not_selected");
  let changed = next.reviewAssignments !== "confirmed";
  next.reviewAssignments = "confirmed";
  for (const participant of next.participants) if (reviewerTargetRefs.includes(goalParticipantTargetRef(participant.target)) && participant.role !== "reviewer") {
    participant.role = "reviewer"; changed = true;
  }
  if (changed) next.version += 1;
  return next;
}

export interface GoalObligationExecutionEvidence {
  schemaVersion: "agentlas.goal-obligation-execution.v1";
  goalId: string; goalRevision: number; obligationVersion: number; invocationRunId: string;
  results: Array<{ targetRef: string; stepId: string; callNodeId: string; callChatId: string; outputDigest: string; reviewComplete: boolean; reviewedInputDigests: string[] }>;
}

/** Structural acceptance only. The host must additionally establish the
 * canonical invocation owner, current revision and actual model-call receipts. */
export function goalExecutionObligationsSatisfied(obligations: GoalExecutionObligations | undefined,
  evidence: GoalObligationExecutionEvidence | null): boolean {
  if (!obligations) return true; // Legacy absence is unknown, not a blanket new completion veto.
  if (!evidence || evidence.schemaVersion !== "agentlas.goal-obligation-execution.v1"
    || !Array.isArray(evidence.results) || evidence.results.some(result => !text(result.targetRef) || !text(result.stepId)
      || !text(result.callNodeId) || !text(result.callChatId) || !/^[a-f0-9]{64}$/.test(result.outputDigest)
      || !Array.isArray(result.reviewedInputDigests)) || evidence.obligationVersion !== obligations.version || obligations.reviewAssignments !== "confirmed") return false;
  const producers = obligations.participants.filter(p => p.role !== "reviewer");
  return obligations.participants.every(participant => {
    const results = evidence.results.filter(result => result.targetRef === goalParticipantTargetRef(participant.target));
    if (!results.length) return false;
    if (participant.role !== "reviewer") return true;
    return results.some(review => review.reviewComplete && producers.every(producer =>
      evidence.results.some(result => result.targetRef === goalParticipantTargetRef(producer.target)
        && review.reviewedInputDigests.includes(result.outputDigest))));
  });
}
