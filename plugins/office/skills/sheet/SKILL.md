---
name: sheet
description: Edit an xlsx workbook live in the Document tab (cells, formulas, sheets, cell format) and save it as xlsx.
---

# Steps

1. `harness_call {"operation":"document.list"}`: reuse an open session. Otherwise call `harness_call {"operation":"document.open","args":{"path":"<absolute path>"}}`.
2. The `outline` lists `# sheet <name>`, then `A1<TAB>value` lines. Formulas appear as `=SUM(B2:B3)`, followed by the cached value. A `{…}` tag shows the cell's format.
3. Edit with `document.apply` using `sessionId` and `ops`. Write a row or a block at a time.
4. Save with `document.save`.

# Ops

- `{"op":"set_cell","sheet":"Sales","cell":"B4","value":"=SUM(B2:B3)"}` writes a cell. A leading `=` makes a formula, and an empty string clears the cell. Numbers go as plain digits, for example `1250`.
- `{"op":"add_sheet","name":"Summary"}`
- `{"op":"set_format","target":"Sales!A1","format":{"bold":true,"align":"center","color":"#1c7ed6","size":12}}`

# Notes

- The cell keeps its number format (percent, thousands, dates) when only its value changes.
- Formulas are recalculated when the file is next opened in Excel. The tab shows a new formula until then.
- On `revision_conflict`, call `document.read` and apply again.
