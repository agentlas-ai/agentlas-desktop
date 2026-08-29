// GENERATED from one-briefing-contract.v1.json. Do not edit by hand.
// schema-sha256: 57d99a9e164bfe9dce0a4432a9cc4753282fa0ede386c4f6d0f493d547db73eb
export const ONE_BRIEFING_CONTRACT_VERSION = "1.0.0" as const;
export const ONE_BRIEFING_KINDS = ["risk", "opportunity", "anomaly", "repetition", "decision", "completion"] as const;
export const ONE_BRIEFING_CADENCES = ["important_only", "daily", "weekdays", "weekly"] as const;
export const ONE_BRIEFING_CONFIDENCES = ["high", "medium", "low"] as const;
export const ONE_BRIEFING_SOURCE_KINDS = ["project_folder", "automation_run", "canonical_task"] as const;
export const ONE_BRIEFING_PREPARED_ACTION_KINDS = ["open_project", "open_automation", "open_task"] as const;
export const ONE_BRIEFING_REASON_CODES = ["project_folder_missing", "project_folder_unreadable", "project_folder_not_directory", "project_deadline_conflict", "automation_error", "automation_blocked", "automation_needs_input", "automation_partial", "task_waiting_decision_stale", "task_running_without_active_run", "task_failed_repeated", "task_failed_abandoned", "task_partial_abandoned"] as const;
export const ONE_BRIEFING_ACTION_SOURCE = {
  "open_project": "project_folder",
  "open_automation": "automation_run",
  "open_task": "canonical_task",
} as const;
export const ONE_BRIEFING_REASON_SOURCE = {
  "project_folder_missing": "project_folder",
  "project_folder_unreadable": "project_folder",
  "project_folder_not_directory": "project_folder",
  "project_deadline_conflict": "project_folder",
  "automation_error": "automation_run",
  "automation_blocked": "automation_run",
  "automation_needs_input": "automation_run",
  "automation_partial": "automation_run",
  "task_waiting_decision_stale": "canonical_task",
  "task_running_without_active_run": "canonical_task",
  "task_failed_repeated": "canonical_task",
  "task_failed_abandoned": "canonical_task",
  "task_partial_abandoned": "canonical_task",
} as const;
export type OneBriefingKind = typeof ONE_BRIEFING_KINDS[number];
export type OneBriefingCadence = typeof ONE_BRIEFING_CADENCES[number];
export type OneBriefingConfidence = typeof ONE_BRIEFING_CONFIDENCES[number];
export type OneBriefingSourceKind = typeof ONE_BRIEFING_SOURCE_KINDS[number];
export type OneBriefingPreparedActionKind = typeof ONE_BRIEFING_PREPARED_ACTION_KINDS[number];
export type OneBriefingReasonCode = typeof ONE_BRIEFING_REASON_CODES[number];
