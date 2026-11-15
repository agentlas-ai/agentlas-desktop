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

/**
 * Agentlas 2.0 P2 (workspace-rules switch on): marks the curator writes on the evidence of a line an agent or a project keeps, when the proposal it came from was an instruction (the original scope
 * was Personal or the original kind a preference, before the host corrected it). `origin:instruction`: the line never counts towards a skill (agents/workspace-service.ts); `origin:owner-spoke`:
 * the owner wrote the turn (the "my rules" pick list reads the pair). Evidence strings, not kinds or columns: no table, scope or kind is added, and no model reads them (`entryLines` renders none).
 */
export const ORIGIN_INSTRUCTION = "origin:instruction";
export const ORIGIN_OWNER_SPOKE = "origin:owner-spoke";
const ORIGIN_REF = /^origin:(instruction|owner-spoke)$/;

/** The marks an earlier line carries, to keep on the line that replaces it (a consolidation or an owner edit writes a new line; the new line must not lose what the old one said about itself). */
export function originEvidenceRefs(evidence: readonly string[]): string[] {
  return evidence.filter(line => ORIGIN_REF.test(line));
}

/** True when the evidence says the line came from an instruction. */
export function hasInstructionOrigin(evidence: readonly string[]): boolean {
  return evidence.includes(ORIGIN_INSTRUCTION);
}
