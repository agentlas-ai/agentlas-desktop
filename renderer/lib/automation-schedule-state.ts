import type { Automation } from "@shared/types";

/** An enabled time schedule with no due timestamp cannot be picked up by the
 * scheduler. This is only a visibility classification: the cause (including
 * side-effect reconciliation) must be read from the run history, not guessed
 * from enabled/nextRunAt alone. Event/poll triggers intentionally have no
 * next_run_at and must not be reported as halted. */
export function enabledScheduleWithoutNextRun(automation: Automation): boolean {
  return automation.enabled
    && (automation.triggerType ?? automation.trigger?.kind ?? "schedule") === "schedule"
    && automation.nextRunAt == null;
}

/** A one-time automation that has run (or whose time passed) and is switched off. It cannot be turned back on:
 * only a new time brings it back (Edit), so every list says "Ended" the same way instead of offering a switch that refuses. */
export function isEndedOneShot(automation: Automation): boolean {
  return !automation.enabled && automation.scheduleSpec?.kind === "once" && automation.nextRunAt == null;
}
