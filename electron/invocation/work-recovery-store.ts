import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { WORK_RECOVERY_POLICY_VERSION, MAX_SAME_METHOD_STARTS, MAX_USER_REQUESTS, USER_REQUEST_SPACING_MS, sameWorkIdentity, type WorkUnit, type WorkUnitState, type WorkRecoveryJournal, type ExpectedWorkOutcome, type WorkOutcomeObservation } from "../../shared/work-recovery";
import { getDb } from "../store/db";
import { recordRunEvent, type RecordRunEventInput } from "../store/run-events";

type Writer = (input: RecordRunEventInput) => { id: string };
const KIND = "work_unit_transition";

export function workUnitId(input: { runId: string; taskId: string; stepId: string; revision: string }): string {
  return createHash("sha256").update(JSON.stringify([input.runId, input.taskId, input.stepId, input.revision])).digest("hex");
}

/** Execution facts live in the existing host ledger. Domain tasks remain in their original stores. */
export class DesktopWorkRecoveryJournal implements WorkRecoveryJournal {
  constructor(private readonly db: Database.Database = getDb(), private readonly write: Writer = recordRunEvent,
    private readonly ownerEpoch?: () => string, private readonly clock: () => number = Date.now) {}

  read(runId: string, unitId: string): WorkUnit | null {
    const row = this.db.prepare(`SELECT payload_json FROM run_events
      WHERE run_id=? AND kind=? AND json_extract(payload_json,'$.unitId')=? ORDER BY seq DESC LIMIT 1`)
      .get(runId, KIND, unitId) as { payload_json: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (p.policyVersion !== WORK_RECOVERY_POLICY_VERSION || p.unitId !== unitId || p.runId !== runId) return null;
    if (!["ready", "started", "succeeded", "failed", "cancelled", "waiting_user", "held"].includes(String(p.state))
      || [p.taskId, p.revision, p.inputDigest, p.methodId, p.ownerEpoch].some(v => typeof v !== "string" || !v)
      || !Number.isSafeInteger(p.generation) || Number(p.generation) < 1
      || !Number.isSafeInteger(p.methodStarts) || Number(p.methodStarts) < 0
      || typeof p.attemptId !== "string" || typeof p.dependencyIds !== "string") throw new Error("work_unit_record_invalid");
    const dependencies = JSON.parse(p.dependencyIds);
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) throw new Error("work_unit_dependencies_invalid");
    return { runId, unitId, taskId: String(p.taskId), parentUnitId: typeof p.parentUnitId === "string" ? p.parentUnitId : null,
      revision: String(p.revision), inputDigest: String(p.inputDigest), state: p.state as WorkUnitState,
      methodId: String(p.methodId), generation: Number(p.generation), ownerEpoch: String(p.ownerEpoch),
      attemptId: String(p.attemptId), methodStarts: Number(p.methodStarts), dependencyIds: dependencies,
      ...(typeof p.resultRef === "string" ? { resultRef: p.resultRef } : {}) };
  }

  transition(unit: WorkUnit, state: WorkUnitState, detail: { reason: string; resultRef?: string; evidenceRef?: string; question?: boolean; questionKey?: string }): WorkUnit | null {
    return this.db.transaction(() => {
      const current = this.read(unit.runId, unit.unitId);
      if (current ? current.generation !== unit.generation || current.ownerEpoch !== unit.ownerEpoch
        || current.attemptId !== unit.attemptId || current.revision !== unit.revision
        || current.inputDigest !== unit.inputDigest || current.methodId !== unit.methodId
        || current.taskId !== unit.taskId || current.parentUnitId !== unit.parentUnitId
        || current.methodStarts !== unit.methodStarts || JSON.stringify(current.dependencyIds) !== JSON.stringify(unit.dependencyIds)
        || current.state !== unit.state : unit.generation !== 0 || unit.state !== "ready" || unit.methodStarts !== 0) return null;
      if (current?.state === "succeeded" || current?.state === "cancelled") return null;
      const started = state === "started";
      if (started && unit.methodStarts >= MAX_SAME_METHOD_STARTS) return null;
      if ([unit.runId, unit.taskId, unit.unitId, unit.revision, unit.inputDigest, unit.methodId, unit.ownerEpoch].some(v => !v || v.length > 240)
        || JSON.stringify(unit.dependencyIds).length > 800 || (detail.resultRef?.length ?? 0) > 800
        || (state === "succeeded" && !detail.resultRef)) throw new Error("work_unit_identity_invalid");
      const next: WorkUnit = { ...unit, state, generation: unit.generation + 1,
        ownerEpoch: started ? this.ownerEpoch?.() ?? unit.ownerEpoch : unit.ownerEpoch,
        attemptId: started ? randomUUID() : unit.attemptId,
        methodStarts: unit.methodStarts + (started ? 1 : 0),
        ...(detail.resultRef ? { resultRef: detail.resultRef } : {}) };
      const event = this.write({ runId: unit.runId, kind: KIND,
        sourceEventId: `work-unit:${unit.unitId}:${next.generation}`,
        payload: { policyVersion: WORK_RECOVERY_POLICY_VERSION, runId: unit.runId, taskId: unit.taskId,
          unitId: unit.unitId, parentUnitId: unit.parentUnitId, revision: unit.revision, inputDigest: unit.inputDigest,
          state, methodId: next.methodId, generation: next.generation, ownerEpoch: next.ownerEpoch,
          attemptId: next.attemptId, methodStarts: next.methodStarts,
          dependencyIds: JSON.stringify(unit.dependencyIds), resultRef: next.resultRef,
          reason: detail.reason, evidenceRef: detail.evidenceRef, question: detail.question ?? false } });
      if (!event?.id) throw new Error("work_unit_start_not_durable");
      if (detail.question && !this.reserveQuestion(unit.runId, detail.questionKey ?? unit.unitId)) throw new Error("work_user_request_limit");
      const stored = this.read(unit.runId, unit.unitId);
      if (!stored || stored.generation !== next.generation || stored.attemptId !== next.attemptId
        || stored.inputDigest !== next.inputDigest || stored.ownerEpoch !== next.ownerEpoch || stored.methodId !== next.methodId
        || stored.resultRef !== next.resultRef || stored.state !== state) throw new Error("work_unit_record_not_durable");
      return stored;
    }).immediate();
  }

  questionFacts(runId: string, questionKey: string): { count: number; lastAskedAt: number | null } {
    const rows = this.db.prepare(`SELECT ts FROM run_events WHERE run_id=? AND kind='work_user_request'
      AND json_extract(payload_json,'$.questionKey')=? ORDER BY seq`).all(runId, questionKey) as { ts: string }[];
    return { count: rows.length, lastAskedAt: rows.length ? Date.parse(rows[rows.length - 1]!.ts) : null };
  }

  questionScope(runId: string, questionKey: string): string | null {
    const row = this.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND kind='work_user_request'
      AND json_extract(payload_json,'$.questionKey')=? ORDER BY seq DESC LIMIT 1`).get(runId, questionKey) as { payload_json: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.payload_json).scopeDigest;
    return typeof value === "string" ? value : null;
  }

  observe(unit: WorkUnit, expected: ExpectedWorkOutcome, observed: WorkOutcomeObservation): boolean {
    return this.db.transaction(() => {
      const current = this.read(unit.runId, unit.unitId);
      if (!current || current.generation !== unit.generation || current.attemptId !== unit.attemptId
        || current.ownerEpoch !== unit.ownerEpoch || !sameWorkIdentity(unit, expected) || !sameWorkIdentity(unit, observed)
        || expected.targetRef !== observed.targetRef) return false;
      const event = this.write({ runId: unit.runId, kind: "work_outcome_checked",
        payload: { policyVersion: WORK_RECOVERY_POLICY_VERSION, unitId: unit.unitId, generation: unit.generation,
          ownerEpoch: unit.ownerEpoch, attemptId: unit.attemptId,
          revision: unit.revision, inputDigest: unit.inputDigest, targetRef: expected.targetRef,
          expectedDescription: expected.description, status: observed.status, evidenceRef: observed.evidenceRef,
          resultRef: observed.resultRef, querySucceeded: observed.querySucceeded, complete: observed.complete,
          fresh: observed.fresh, propagationSettled: observed.propagationSettled,
          remoteExecutionEnded: observed.remoteExecutionEnded } });
      if (!event?.id) throw new Error("work_outcome_not_durable");
      return true;
    }).immediate();
  }

  latestObservation(unit: WorkUnit): WorkOutcomeObservation | null {
    const row = this.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND kind='work_outcome_checked'
      AND json_extract(payload_json,'$.unitId')=? AND json_extract(payload_json,'$.generation')=?
      AND json_extract(payload_json,'$.ownerEpoch')=? AND json_extract(payload_json,'$.attemptId')=? ORDER BY seq DESC LIMIT 1`)
      .get(unit.runId, unit.unitId, unit.generation, unit.ownerEpoch, unit.attemptId) as { payload_json: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_json);
    return p.policyVersion === WORK_RECOVERY_POLICY_VERSION && sameWorkIdentity(unit, p) ? p as WorkOutcomeObservation : null;
  }

  /** Only the host's explicit read-output regeneration path may reopen a completed leaf.
   * The original completion remains immutable; its method count and ids survive the new generation. */
  reopenCompletedRead(unit: WorkUnit, inputDigest: string, evidenceRef: string): WorkUnit | null {
    return this.reopenCompleted(unit, inputDigest, evidenceRef, "failed", "host_read_output_regeneration");
  }

  /** An explicit revised request can replace a confirmed completed outcome,
   * without replacing its unit id or resetting the same-method start budget. */
  reopenCompletedRequest(unit: WorkUnit, inputDigest: string, evidenceRef: string): WorkUnit | null {
    if (unit.inputDigest === inputDigest) return null;
    return this.reopenCompleted(unit, inputDigest, evidenceRef, "ready", "host_completed_request_revised");
  }

  private reopenCompleted(unit: WorkUnit, inputDigest: string, evidenceRef: string,
    state: "ready" | "failed", reason: string): WorkUnit | null {
    return this.db.transaction(() => {
      const current = this.read(unit.runId, unit.unitId);
      if (!current || current.state !== "succeeded" || JSON.stringify(current) !== JSON.stringify(unit)
        || !inputDigest || inputDigest.length > 240 || !evidenceRef || evidenceRef.length > 800
        || current.methodStarts >= MAX_SAME_METHOD_STARTS) return null;
      const next = { ...current, state, inputDigest, generation: current.generation + 1 };
      this.write({ runId: unit.runId, kind: KIND, sourceEventId: `work-unit:${unit.unitId}:${next.generation}`,
        payload: { policyVersion: WORK_RECOVERY_POLICY_VERSION, runId: unit.runId, taskId: unit.taskId,
          unitId: unit.unitId, parentUnitId: unit.parentUnitId, revision: unit.revision, inputDigest,
          state: next.state, methodId: unit.methodId, generation: next.generation, ownerEpoch: unit.ownerEpoch,
          attemptId: unit.attemptId, methodStarts: unit.methodStarts, dependencyIds: JSON.stringify(unit.dependencyIds),
          reason, evidenceRef } });
      const stored = this.read(unit.runId, unit.unitId);
      if (!stored || stored.generation !== next.generation || stored.inputDigest !== inputDigest
        || stored.methodStarts !== unit.methodStarts || stored.state !== state || stored.resultRef) throw new Error("work_completed_reopening_not_durable");
      return stored;
    }).immediate();
  }

  /** Controller-selected strategies retain their own durable count, including an A→B→A cycle. */
  selectMethod(unit: WorkUnit, methodId: string): WorkUnit | null {
    return this.db.transaction(() => {
      const current = this.read(unit.runId, unit.unitId);
      if (!current || current.generation !== unit.generation || current.attemptId !== unit.attemptId
        || current.ownerEpoch !== unit.ownerEpoch || !["held", "failed"].includes(current.state)
        || !methodId || methodId.length > 240 || methodId === current.methodId) return null;
      const count = this.db.prepare(`SELECT count(*) AS n FROM run_events WHERE run_id=? AND kind=?
        AND json_extract(payload_json,'$.unitId')=? AND json_extract(payload_json,'$.methodId')=?
        AND json_extract(payload_json,'$.state')='started'`).get(unit.runId, KIND, unit.unitId, methodId) as { n: number };
      const next = { ...current, state: "held" as const, methodId, methodStarts: count.n, generation: current.generation + 1 };
      this.write({ runId: unit.runId, kind: KIND, sourceEventId: `work-unit:${unit.unitId}:${next.generation}`,
        payload: { policyVersion: WORK_RECOVERY_POLICY_VERSION, runId: unit.runId, taskId: unit.taskId,
          unitId: unit.unitId, parentUnitId: unit.parentUnitId, revision: unit.revision, inputDigest: unit.inputDigest,
          state: next.state, methodId, generation: next.generation, ownerEpoch: next.ownerEpoch,
          attemptId: next.attemptId, methodStarts: next.methodStarts, dependencyIds: JSON.stringify(unit.dependencyIds),
          reason: "controller_selected_alternative" } });
      const stored = this.read(unit.runId, unit.unitId);
      if (!stored || stored.generation !== next.generation || stored.methodId !== methodId) throw new Error("work_method_not_durable");
      return stored;
    }).immediate();
  }

  /** Reserve before presenting the existing question UI; restart cannot reset its count. */
  reserveQuestion(runId: string, questionKey: string, now = this.clock(), scopeDigest?: string): boolean {
    return this.db.transaction(() => {
      const previous = this.questionFacts(runId, questionKey);
      if (!questionKey || questionKey.length > 240 || !Number.isFinite(now)
        || (previous.lastAskedAt !== null && !Number.isFinite(previous.lastAskedAt))) return false;
      if (previous.count >= MAX_USER_REQUESTS || (previous.lastAskedAt !== null
        && now - previous.lastAskedAt < USER_REQUEST_SPACING_MS)) return false;
      if (scopeDigest !== undefined && (!scopeDigest || scopeDigest.length > 240
        || (previous.count > 0 && this.questionScope(runId, questionKey) !== scopeDigest))) return false;
      const receipt = this.write({ runId, kind: "work_user_request",
        sourceEventId: `work-question:${questionKey}:${previous.count + 1}`,
        payload: { policyVersion: WORK_RECOVERY_POLICY_VERSION, questionKey, ordinal: previous.count + 1,
          ...(scopeDigest ? { scopeDigest } : {}) } });
      if (!receipt?.id || this.questionFacts(runId, questionKey).count !== previous.count + 1) {
        throw new Error("work_user_request_not_durable");
      }
      return true;
    }).immediate();
  }
}
