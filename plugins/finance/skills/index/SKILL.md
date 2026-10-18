---
name: index
description: Route Finance research, dashboard edits, evidence reports and monitor requests to authenticated host tools.
---

# Routing

- Asset discovery, filings, financial facts, news and public discussion → $research (`../research/SKILL.md`).
- Dashboard layout, filters, widgets and report drafts → $workspace (`../workspace/SKILL.md`).
- Recurring research, run history and pausing → $monitor (`../monitor/SKILL.md`).

Use `harness_search` for `finance`, then `harness_describe` for the chosen operation. Workflows can be read with `harness_describe` using `plugin:finance/research`, `plugin:finance/workspace` or `plugin:finance/monitor` when file access is unavailable. Call `harness_call` with `operation` and `args`; the host owns account binding, storage, permissions and provider retrieval.

Start from `finance.load` to resolve saved IDs and revision. A refused or unavailable result is a boundary to explain, not a reason to bypass the host through scripts or direct storage. Report actual saved revisions, report IDs and run statuses. This plugin does not trade, connect brokerage accounts, publish or send reports externally.
