/**
 * The run a learning came from, as an evidence line.
 *
 * A learning's own evidence is mostly a memory-ticket id; the ticket knows its run, but a ticket row is not always at hand
 * (consolidation merges learnings, tickets can be trimmed). `run:<runId>` names the run directly so the lesson's recurrence
 * (the same lesson from distinct runs, electron/agents/learning-evidence.ts) can be counted from the learning alone.
 * What the host recorded in those runs (owner corrections, failures) is read when a change is prepared, not stored here:
 * a stored copy would go stale and would suggest a failure was caused by the lesson.
 */
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RUN_REF = /^run:[A-Za-z0-9_.:-]{1,128}$/;

export function runEvidenceRef(runId: string | null | undefined): string[] {
  return runId && RUN_ID.test(runId) ? [`run:${runId}`] : [];
}

/** Run references an earlier learning carries, to keep on a consolidated learning that replaces it. */
export function runEvidenceRefs(evidence: readonly string[]): string[] {
  return evidence.filter(line => RUN_REF.test(line));
}
