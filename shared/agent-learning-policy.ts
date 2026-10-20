/**
 * When a learning may become a candidate to change an agent's files.
 *
 * A learning is one turn's note. It earns a candidate by coming back: the same lesson written by distinct runs. The host
 * counts runs (a count, not days); whether the lesson is portable, already covered by the instructions, or one task's
 * facts is the compiler model's judgment (electron/agents/workspace-service.ts). The owner then reads the diff and decides.
 */
export const AGENT_LEARNING_POLICY = Object.freeze({
  /** Distinct runs a lesson must come from. Two notes from one run are one observation. */
  minRuns: 3,
  /** Proposals the background proposer makes per agent per day (model cost, and the owner's reading time). */
  proposalsPerAgentPerDay: 1,
  /** Run ids kept per lesson when following consolidation pointers. */
  maxRunsTracked: 400,
});

/** Evidence the host resolved for one lesson (a group of near-duplicate learnings). Counts only; no model text. */
export interface LessonEvidence {
  /** Distinct runs the lesson came from, through memory tickets, run references and consolidation pointers. */
  runs: number;
  /** Owner messages sent into those runs while they were working: the owner correcting course. */
  ownerCorrections: number;
  /** Failed invocations and tool errors in those runs. Context for the card, not proof of the lesson. */
  failures: number;
  /** A few concrete failures (time, error code) the card can cite. */
  samples: Array<{ at: string; kind: string; code: string | null }>;
}
