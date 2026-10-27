import { createHash } from "node:crypto";
import { decideWorkRecovery, WORK_RECOVERY_POLICY_VERSION, type WorkUnit, type ExpectedWorkOutcome,
  type WorkOutcomeObservation, type WorkRecoveryFacts, type WorkRecoveryDecision } from "../../shared/work-recovery";
import { DesktopWorkRecoveryJournal, workUnitId } from "../invocation/work-recovery-store";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface GraphWorkRecoveryScope {
  automationId: string; occurrenceId: string; nodeId: string; graphDigest: string;
  /** Only enclosing loops count: independent branches must not reset this node's budget. */
  loops: readonly (readonly [string, number])[];
  inputDigest: string;
  ownerEpoch: string;
}

/** A recovery decision that refused a dispatch. Same message as before (`work_recovery_<reason>`); the decision is typed. */
export class WorkRecoveryRefused extends Error {
  constructor(readonly decision: WorkRecoveryDecision) {
    super(`work_recovery_${decision.reason}`);
    this.name = "WorkRecoveryRefused";
  }
}

/** Thin Graph adapter: existing checkpoint and Worker receipts own result/effect verification. */
export class GraphWorkRecovery {
  private readonly journal: DesktopWorkRecoveryJournal;
  constructor(journal?: DesktopWorkRecoveryJournal, ownerEpoch?: () => string) {
    this.journal = journal ?? new DesktopWorkRecoveryJournal(undefined, undefined, ownerEpoch);
  }
  unit(scope: GraphWorkRecoveryScope): WorkUnit {
    const runId = `graph-work:${digest([scope.automationId, scope.occurrenceId])}`;
    const unitId = workUnitId({ runId, taskId: scope.nodeId, stepId: digest(scope.loops), revision: scope.graphDigest });
    const saved = this.journal.read(runId, unitId);
    if (saved) {
      if (saved.inputDigest !== scope.inputDigest) {
        const revised = this.journal.reviseInput(saved, scope.inputDigest, `graph-request:${scope.ownerEpoch}:${scope.inputDigest}`);
        if (!revised) throw new Error("work_recovery_record_changed");
        return revised;
      }
      return saved;
    }
    return { runId, unitId, taskId: scope.nodeId, parentUnitId: scope.automationId, revision: scope.graphDigest,
      inputDigest: scope.inputDigest, state: "ready", methodId: `graph-node:${scope.nodeId}`, generation: 0,
      ownerEpoch: scope.ownerEpoch, attemptId: "", methodStarts: 0, dependencyIds: [] };
  }
  /** Called only for an already-ended read/pure code leaf that the current authoritative
   * Graph resume explicitly needs to regenerate. Mutation leaves never enter this path. */
  regenerateCompletedRead(scope: GraphWorkRecoveryScope, evidenceRef: string): WorkUnit | null {
    const runId = `graph-work:${digest([scope.automationId, scope.occurrenceId])}`;
    const unitId = workUnitId({ runId, taskId: scope.nodeId, stepId: digest(scope.loops), revision: scope.graphDigest });
    const previous = this.journal.read(runId, unitId);
    if (previous?.state !== "succeeded") return null;
    const regenerated = this.journal.reopenCompletedRead(previous, scope.inputDigest, evidenceRef);
    if (!regenerated) throw new Error("work_recovery_read_regeneration_not_admitted");
    return regenerated;
  }
  /** Keep the original record and append the current request revision. */
  reviseCompletedRequest(scope: GraphWorkRecoveryScope, evidenceRef: string): WorkUnit | null {
    const runId = `graph-work:${digest([scope.automationId, scope.occurrenceId])}`;
    const unitId = workUnitId({ runId, taskId: scope.nodeId, stepId: digest(scope.loops), revision: scope.graphDigest });
    const previous = this.journal.read(runId, unitId);
    if (!previous || previous.inputDigest === scope.inputDigest) return null;
    const revised = this.journal.reviseInput(previous, scope.inputDigest, evidenceRef);
    if (!revised) throw new Error("work_recovery_request_revision_not_admitted");
    return revised;
  }
  begin(unit: WorkUnit, facts: Pick<WorkRecoveryFacts, "userStopped" | "authorized" | "budgetAvailable" | "scopeCurrent">): WorkUnit {
    if (facts.userStopped) throw new Error("work_recovery_user_stopped");
    if (unit.state === "succeeded") {
      const reopened = this.journal.reopenCompletedForContinuation(unit, `graph-result-regeneration:${unit.unitId}`);
      if (!reopened) throw new Error("work_recovery_record_changed");
      unit = reopened;
    }
    let diagnostic: WorkRecoveryDecision | undefined;
    if (unit.state !== "ready") {
      const observation = this.journal.latestObservation(unit);
      diagnostic = decideWorkRecovery(unit, { ...facts, policyVersion: WORK_RECOVERY_POLICY_VERSION,
        worker: observation?.remoteExecutionEnded ? "terminated" : "unknown", alternateAvailable: false,
        requiresUser: false, methodRefused: false, questionCount: 0, lastAskedAt: null, now: Date.now() }, this.expected(unit), observation);
    }
    // Recovery facts describe the earlier attempt. They never veto the current
    // request or fabricate its outcome; every new attempt remains in the journal.
    const started = this.journal.transition(unit, "started", { reason: unit.state === "ready" ? "graph_dispatch" : "graph_continue",
      ...(diagnostic ? { diagnosticAction: diagnostic.action, diagnosticReason: diagnostic.reason } : {}) });
    if (!started) throw new Error("work_recovery_record_changed");
    return started;
  }
  /** Import the already durable Graph intent only after its exact Worker receipt proves it ended without effects. */
  adoptStarted(unit: WorkUnit, evidenceRef: string): WorkUnit {
    if (unit.state !== "ready") return unit;
    const started = this.journal.transition(unit, "started", { reason: "adopt_durable_graph_intent", evidenceRef });
    if (!started) throw new Error("work_recovery_adoption_not_durable");
    return started;
  }
  private expected(unit: WorkUnit): ExpectedWorkOutcome {
    return { unitId: unit.unitId, revision: unit.revision, inputDigest: unit.inputDigest,
      description: "This Graph node's validated output and declared values must be durably checkpointed.", targetRef: `graph-node:${unit.unitId}` };
  }
  complete(unit: WorkUnit, resultRef: string): void {
    if (!this.journal.transition(unit, "succeeded", { reason: "graph_checkpoint_completed", resultRef })) {
      throw new Error("work_recovery_completion_owner_changed");
    }
  }
  fail(unit: WorkUnit): WorkUnit {
    const failed = this.journal.transition(unit, "failed", { reason: "graph_attempt_failed" });
    if (!failed) throw new Error("work_recovery_failure_owner_changed");
    return failed;
  }
  /** Preserve the caller's measured checkpoint, effect and worker facts; recovery diagnostics do not veto continuation. */
  retry(unit: WorkUnit, read: {
    checkpointMatches: boolean; completed: boolean; resultRef?: string; evidenceRef: string;
    effectSafe: boolean; workerEnded: boolean;
  }, facts: Pick<WorkRecoveryFacts, "userStopped" | "authorized" | "budgetAvailable" | "scopeCurrent">): WorkRecoveryDecision {
    const expected = this.expected(unit);
    const observed: WorkOutcomeObservation = { ...expected, status: read.completed ? "matched" : "absent",
      resultRef: read.resultRef, evidenceRef: read.evidenceRef, querySucceeded: read.checkpointMatches,
      complete: read.checkpointMatches, fresh: read.checkpointMatches, propagationSettled: read.effectSafe,
      remoteExecutionEnded: read.workerEnded };
    if (facts.userStopped) return { action: "cancel", reason: "user_stopped", attention: "none" };
    if (!this.journal.observe(unit, expected, observed)) return { action: "retry", reason: "outcome_not_durable", attention: "none" };
    const diagnostic = decideWorkRecovery(unit, { ...facts, policyVersion: WORK_RECOVERY_POLICY_VERSION,
      worker: read.workerEnded ? "terminated" : "unknown", alternateAvailable: false, requiresUser: false,
      methodRefused: false, questionCount: 0, lastAskedAt: null, now: Date.now() }, expected, observed);
    return diagnostic.action === "complete" ? diagnostic : { ...diagnostic, action: "retry", attention: "none" };
  }
}
