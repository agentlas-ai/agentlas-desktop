---
name: author
description: Author a bounded Flint chart input for Agentlas Desktop and Web surfaces.
---

# Purpose

Turn a table into a portable `data.<name>.flint` object. The host compiles the
same object to Vega-Lite and renders it with the local Desktop runtime or the
Web server runtime. This skill is an authoring contract, not a compiler.

## Input shape

Put the chart input beside the table rows and reference it with a `chart`
widget:

```json
{
  "data": {
    "sales": {
      "type": "table",
      "rows": [{"month": "Jan", "revenue": 120}],
      "flint": {
        "chart_spec": {
          "chartType": "Bar Chart",
          "title": "Revenue by month",
          "encodings": {"x": "month", "y": "revenue"},
          "baseSize": {"width": 560, "height": 320},
          "canvasSize": {"width": 900, "height": 520}
        },
        "semantic_types": {"month": "Month", "revenue": "Currency"},
        "options": {"addTooltips": true}
      }
    }
  },
  "widgets": [{"type": "chart", "data": "sales"}]
}
```

## Rules

- Use inline rows only. Never put secrets, credentials, arbitrary URLs, or
  executable expressions in the chart input.
- Keep the table bounded: at most 2,000 rows and 64 columns for a chart.
- Use a real Flint template name such as `Bar Chart`, `Line Chart`, or
  `Scatter Plot`; encodings refer only to fields present in the rows.
- Mark important numeric claims with the surrounding Surface evidence/claims
  fields. A chart is not evidence by itself.
- Preserve the table as the source of truth. The chart is a view over the rows,
  not a second copy of the dataset.

## Verification

The host rejects oversized or malformed input, disallows remote data sources,
and reports a renderer error instead of silently showing a blank chart. A
successful Desktop/Web render means the input compiled and the Vega renderer
completed; it does not verify the underlying data claims.

## Provenance

This workflow follows the public Flint Chart authoring contract:
https://github.com/microsoft/flint-chart/blob/main/agent-skills/flint-chart-author/SKILL.md
