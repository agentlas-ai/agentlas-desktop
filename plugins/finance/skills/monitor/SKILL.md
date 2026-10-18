---
name: monitor
description: Create research monitors, run evidence briefings and inspect or pause schedules.
---

# Monitor workflow

Read the workspace, resolve saved assets, then `finance.monitor.create` with a name, research query, asset IDs and current revision. This creates a draft. `finance.monitor.run` executes the saved research and returns an actual run result; `finance.monitor.runs` retrieves history and report references.

To change an existing monitor, use `finance.monitor.update` with its saved ID, current workspace revision and only the changed name, research query or asset IDs. Reload the returned workspace to confirm the same monitor changed; do not create a duplicate. An active schedule must be paused first, and a running check must finish before its research definition can change.

For an explicitly requested recurring schedule, `finance.monitor.schedule` supports `every-5m`, `hourly`, `daily-09:00` and `weekday-09:00`. These are host scheduler times, not an inferred market calendar. Describe only the returned execution availability; app-running is not an always-on cloud guarantee. Use `finance.monitor.pause` when asked to stop future scheduled executions. Pausing does not claim to cancel an already running execution.

These monitors retrieve evidence and produce research briefings. They do not promise tick-by-tick price alerts, exchange-session coverage, automatic trading or a fixed provider/LLM cost. Source outages and configured model limits can produce partial or failed runs. Distinguish draft, scheduled, running, partial, failed and succeeded from the actual receipts.

Use a clear company/topic question in the requested report language. The monitor combines available asset news, prices, issuer evidence and relevant public discussion; unavailable sources remain coverage gaps. Its briefing should state the conclusion and material uncertainty without listing raw rows. The separate Finance settings toggle enables the Pro-or-higher daily holdings review through One Supervisor; a research monitor schedule is not proof that this daily review was enabled or delivered.

# Verification

After a run, inspect its status, warnings and report ID, then read the report when present. After schedule or pause, reload the monitor's host-projected status. Do not claim a future run has happened merely because a schedule was created.

`finance.monitor.runs` supports bounded pages. Continue with its returned cursor to retain the same history snapshot; a fresh first-page query starts a new snapshot. An index-building or migration status means older coverage is not yet confirmed. A linked report remains readable after owner-requested archiving.
