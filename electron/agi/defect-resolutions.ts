/**
 * Which of the defects AGI filed (agi_defect_reports) a commit has since fixed.
 *
 * The table had no state, so a defect stayed "open" for ever, and 134 of them (2026-09-29..2026-10-06, 65 on one
 * deleted chat's Goal alone) piled up with nobody able to tell which were still real. This audit sorted them by root
 * cause, checked each family against the code and against whether it kept coming after the fix, and records the fixing
 * commits here. applyDefectResolutions() stamps the matching rows at startup; it is idempotent and never touches a
 * report filed after the audit, so a new defect of the same family stays open.
 */
import type Database from "better-sqlite3";

/** Reports filed before this moment were audited; later ones are never marked from this table. */
export const DEFECT_RESOLUTION_AUDIT_CUTOFF_MS = Date.parse("2026-10-06T03:40:00Z");

export interface DefectResolutionRow { code: string; createdAtMs: number }
export interface DefectResolutionRule {
  family: string;
  /** Short commit hashes in this repository's history. */
  commits: readonly string[];
  note: string;
  matches(row: DefectResolutionRow): boolean;
}

const ORPHAN_GOAL = "b01c2315";
const ATTEMPT_FILTER = "fd2dfd0f";
const BROWSER_UPLOAD_CAP_RESET = Date.parse("2026-10-05T22:00:00Z");

/** First match wins; order matters (the narrow families come before the broad loop families). */
export const DEFECT_RESOLUTION_RULES: readonly DefectResolutionRule[] = [
  {
    family: "goal-of-deleted-chat",
    commits: [ORPHAN_GOAL],
    note: "A Goal whose chat was deleted kept being retried and reported on; the sweep now closes it.",
    matches: ({ code }) => code.startsWith("goal_chat_binding_missing") || code === "agi.read.signature-invalid",
  },
  {
    family: "runtime-turn-unsettled",
    commits: ["a40c9ad5"],
    note: "A resident Codex writer held the thread, so every follow-up failed in 0.2 s; handed over after it exits, spaced for every reason.",
    matches: ({ code }) => code.startsWith("runtime_turn_unsettled"),
  },
  {
    family: "goal-offered-work-turn-it-cannot-take",
    commits: ["b1124496"],
    note: "A Goal waiting on a tool was offered a work turn the host then always deferred.",
    matches: ({ code }) => code === "agi.eligibility.assignment_mismatch" || code === "agi.turn.deferred_repeated_with_eligible_tactics",
  },
  {
    family: "browser-tab-limit",
    commits: ["a0aa9530"],
    note: "One continuous run piled up tabs until all 8 were its own; a run now gives up its least recently used tab.",
    matches: ({ code }) => code === "browser_unavailable:browser_ladder:native-tab-limit",
  },
  {
    family: "browser-upload-frame-limit",
    commits: ["355a7377"],
    note: "A native-browser upload exceeded the relay frame limit and the socket hung up.",
    matches: ({ code, createdAtMs }) => code === "browser_unavailable:browser_ladder:native-tool-failed" && createdAtMs >= BROWSER_UPLOAD_CAP_RESET,
  },
  {
    family: "old-observation-read-by-agi",
    commits: ["e3345778", ATTEMPT_FILTER],
    note: "AGI read an old exhausted look as the blocker, and its attempt filter returned unrelated rows; both fixed.",
    matches: ({ code }) => code === "agi.observation_evidence_unavailable" || code === "goal_state_requested_details_missing",
  },
  {
    family: "attempt-filter-ignored",
    commits: [ATTEMPT_FILTER],
    note: "AGI's targeted read of earlier attempts ignored the attempts it asked for; attempt_receipts now filters by attemptIds.",
    matches: ({ code }) => code === "agi.targeted_evidence_reads_unfiltered" || code === "agi.reconciliation_targeted_reads_ignored",
  },
  {
    family: "goal-wait-refused-in-a-loop",
    commits: ["bc6584e3", "2b9ec8ae"],
    note: "Every Goal wait was refused for an unsettled earlier effect and the Goal re-ran every minute; the lock is gone and follow-ups are spaced.",
    matches: ({ code }) => code.startsWith("wait_registration_refused") || code === "goal_wait_registration_failed",
  },
  {
    family: "budget-paused-goal-read-as-payment",
    commits: ["7b7f5a8b"],
    note: "A budget-paused Goal was read as a payment boundary with an attempt due; it is now a stop only the owner lifts.",
    matches: ({ code }) => /budget|paused/i.test(code) || code === "agi.boundary.payment_without_payment_evidence",
  },
  {
    family: "unknown-outcome-held-the-goal",
    commits: ["bc6584e3", "bfde40bf", "1180fda2", "dc911431", "31f0674b"],
    note: "An unknown outside outcome held the Goal and read-only looks at it were mostly inconclusive; the hold and the looks are removed.",
    matches: ({ code }) => /verif|observ|reconcil|uncertain|unchanged|recover|retry|loop|livelock|deadlock|stall|receipt|attempt/i.test(code),
  },
];

export function ensureDefectResolutionColumns(db: Database.Database): void {
  const have = new Set((db.prepare("PRAGMA table_info(agi_defect_reports)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!have.size) return;
  if (!have.has("resolved_at_ms")) db.exec("ALTER TABLE agi_defect_reports ADD COLUMN resolved_at_ms INTEGER");
  if (!have.has("resolved_commit")) db.exec("ALTER TABLE agi_defect_reports ADD COLUMN resolved_commit TEXT");
  if (!have.has("resolution_note")) db.exec("ALTER TABLE agi_defect_reports ADD COLUMN resolution_note TEXT");
}

/** Stamp every audited, still-unresolved report whose family a commit fixed. Returns how many it marked. */
export function applyDefectResolutions(db: Database.Database, now: number = Date.now()): number {
  const rows = db.prepare(`SELECT id, code, created_at_ms AS createdAtMs FROM agi_defect_reports
    WHERE resolved_at_ms IS NULL AND created_at_ms < ?`).all(DEFECT_RESOLUTION_AUDIT_CUTOFF_MS) as Array<{ id: string; code: string; createdAtMs: number }>;
  if (!rows.length) return 0;
  const mark = db.prepare(`UPDATE agi_defect_reports SET resolved_at_ms = ?, resolved_commit = ?, resolution_note = ?
    WHERE id = ? AND resolved_at_ms IS NULL`);
  let marked = 0;
  db.transaction(() => {
    for (const row of rows) {
      const rule = DEFECT_RESOLUTION_RULES.find((candidate) => candidate.matches({ code: row.code, createdAtMs: row.createdAtMs }));
      if (!rule) continue;
      marked += mark.run(now, rule.commits.join(","), rule.note, row.id).changes;
    }
  })();
  return marked;
}
