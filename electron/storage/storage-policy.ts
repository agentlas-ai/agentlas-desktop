/**
 * Agentlas storage budget: owner decisions of 2026-10-16, applied for every user.
 * A small disk (256 GB) must not fill up after a little use. Completed
 * deliverables (videos, documents), conversation content and settings are
 * never deleted automatically. Only these lose detail:
 *
 * - agent intermediates (frame sequences, temp files): removed once the work
 *   is done ("완료 즉시 삭제"). The work is done 10 minutes after a recorded
 *   verified finish, or after 24 quiet hours without one.
 * - run detail (each tool call's arguments and output, model reasoning):
 *   kept 3 days, after which only the result, cost and error summary remain
 * - CLI resume transcripts: removed for chats unused for 30 days; the chat
 *   stays, and the next turn starts a fresh CLI session
 * - low disk (under 15 GB or 10% free): transcripts after 7 days, then a notice
 * - delivered automation trigger events: removed 30 days after delivery once
 *   their run is over; the run itself and parked events stay
 * - Telegram attachment copies: removed 7 days after their run is over, since
 *   Telegram keeps the original (owner decision OD-4). Desktop chat images are
 *   conversation content and are never removed.
 * - cloud agent package folders (cloud-agent-packages/<slug>-<stamp>/, the
 *   JSON bundle written for each Cloud save or publish and read only during
 *   it): removed after 7 days; the newest folder of each agent always stays
 * - durable judgment verdicts (a cache of model verdicts): removed 30 days
 *   after their last use; a removed one costs one model call at most
 * - managed DB-upgrade copies (agentlas.sqlite.migration-backup.v1.*): the
 *   newest three stay (store/db.ts MAX_MANAGED_MIGRATION_BACKUPS); older ones
 *   go after integrity checks of the live store and of the three that stay.
 *   Updater recovery copies and other ad-hoc DB copies are never touched.
 */
export const STORAGE_POLICY = {
  runDetailDays: 3,
  cliTranscriptIdleDays: 30,
  triggerEventDeliveredDays: 30,
  telegramAttachmentDays: 7,
  cloudPackageDays: 7,
  judgmentVerdictDays: 30,
  /** "Done" for a project whose agent recorded a verified finish (verification.json or .agentlas-complete). */
  intermediateIdleMinutes: 10,
  /**
   * "Done" without that record. A render waiting for owner review must keep its
   * frames; deleting them after a short pause would force a full re-render.
   */
  intermediateUnverifiedIdleHours: 24,
  sweepIntervalMinutes: 30,
  lowDisk: {
    freeBytes: 15 * 1024 ** 3,
    freeRatio: 0.1,
    cliTranscriptIdleDays: 7,
  },
} as const;

export const DAY_MS = 86_400_000;
