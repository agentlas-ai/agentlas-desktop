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
