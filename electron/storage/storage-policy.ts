/**
 * Agentlas storage budget: owner decisions of 2026-10-16, applied for every user.
 * A small disk (256 GB) must not fill up after a little use. Completed
 * deliverables (videos, documents), conversation content and settings are
 * never deleted automatically. Only these lose detail:
 *
 * - agent intermediates (frame sequences, temp files): removed once the work
 *   is done ("완료 즉시 삭제")
 * - run detail (each tool call's arguments and output, model reasoning):
 *   kept 3 days, after which only the result, cost and error summary remain
 * - CLI resume transcripts: removed for chats unused for 30 days; the chat
 *   stays, and the next turn starts a fresh CLI session
 * - low disk (under 15 GB or 10% free): transcripts after 7 days, then a notice
 */
export const STORAGE_POLICY = {
  runDetailDays: 3,
  cliTranscriptIdleDays: 30,
  /** "Done" for an agent workspace: nothing in the project written for this long. */
  intermediateIdleMinutes: 10,
  sweepIntervalMinutes: 30,
  lowDisk: {
    freeBytes: 15 * 1024 ** 3,
    freeRatio: 0.1,
    cliTranscriptIdleDays: 7,
  },
} as const;

export const DAY_MS = 86_400_000;
