---
name: workspace
description: Edit Finance dashboards and report prose using revision-checked typed operations.
---

Inside Agentlas Finance, use the corresponding short tool names from the current menu. Outside Finance, describe and call the namespaced `finance.*` harness operations below. The host validates the same account and source boundaries.

# Dashboard and report workflow

Read `finance.load`, then describe `finance.apply` for the complete operation schema. Resolve IDs from the workspace, construct only the requested canonical operations, and pass its `expectedRevision`. Direct controls and these operations share the same persisted workspace. On a revision conflict reload and reconcile the intended change before retrying.

Widget period can inherit the dashboard period or remain pinned; preserve that distinction when changing a global period. Existing data and provenance come from provider retrieval, not authored operation payloads. New assets use `finance.asset.add`; source evidence uses `finance.query.save`.

`finance.report.create` freezes an existing dashboard using the host snapshot. `finance.report.read` inspects that saved snapshot. `finance.apply` can change report titles or section prose, reorder/remove sections, or explicitly refresh a report using its saved widget configuration and current stored data. Refresh creates a new report revision rather than silently changing evidence in the old report. Prose edits stay pending owner review. Explain any gap between a saved narrative and newer source observations.

To ground an existing report in another dataset, use `finance.query.save` with its active `reportId`, `mode: "report"` and current `expectedRevision` before revising the summary. This appends host-retrieved supporting sections while preserving existing sections, numerical projections and source bindings. Attach every dataset used in the prose to the report; a standalone source record does not freeze its data inside that report.

Set the requested BCP47 `language` when creating a report, or in a `report.update` patch when rewriting one. Write titles, headings and prose naturally in that language. Section `presentation` selects `narrative`, `chart`, an explicitly requested `comparison`, or `supporting` material. Keep original numerical projections intact. Favor a short conclusion and a relevant chart; a chart does not need its raw table repeated underneath. Use `finance.calculate` for validated allocation, historical scenarios and option calculations, with localized titles and interpretation in its optional presentation fields.

# Verification

Read the resulting workspace and report. Confirm the requested layout or text and its saved revision. An export or external sharing request requires a separately available export/sharing tool and the owner's authorization; a Finance report ID alone is not an exported file or a delivery receipt.

# Saved material

Use `finance.archives.list` and `finance.archives.read` to inspect preserved editions. `finance.report.read` can resolve a saved report from the active workspace or its archive. For an owner-requested archive, describe `finance.archives.create` and pass the selected report IDs and current revision. An empty selection archives only unused sources. The host preserves the full edition before removing selected active entries; sources referenced by positions, prices or remaining reports stay active. A reclaimed count of zero means capacity was not freed.

`finance.archives.restore` restores selected reports and their source objects into the active workspace at an expected revision. Capacity or conflicting IDs can prevent restoration. Reading or exporting the preserved snapshot does not require restoring it. Archiving is an explicit owner action and is not automatic deletion.
