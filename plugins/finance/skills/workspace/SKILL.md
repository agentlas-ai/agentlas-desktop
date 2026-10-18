---
name: workspace
description: Edit Finance dashboards and report prose using revision-checked typed operations.
---

# Dashboard and report workflow

Read `finance.load`, then describe `finance.apply` for the complete operation schema. Resolve IDs from the workspace, construct only the requested canonical operations, and pass its `expectedRevision`. Direct controls and these operations share the same persisted workspace. On a revision conflict reload and reconcile the intended change before retrying.

Widget period can inherit the dashboard period or remain pinned; preserve that distinction when changing a global period. Existing data and provenance come from provider retrieval, not authored operation payloads. New assets use `finance.asset.add`; source evidence uses `finance.query.save`.

`finance.report.create` freezes an existing dashboard using the host snapshot. `finance.report.read` inspects that saved snapshot. `finance.apply` can change report titles or section prose, reorder/remove sections, or explicitly refresh a report using its saved widget configuration and current stored data. Refresh creates a new report revision rather than silently changing evidence in the old report. Prose edits stay pending owner review. Explain any gap between a saved narrative and newer source observations.

# Verification

Read the resulting workspace and report. Confirm the requested layout or text and its saved revision. An export or external sharing request requires a separately available export/sharing tool and the owner's authorization; a Finance report ID alone is not an exported file or a delivery receipt.
