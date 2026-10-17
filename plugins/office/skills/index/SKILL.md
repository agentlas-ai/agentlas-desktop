---
name: index
description: Route Word, Hangul, Excel and PowerPoint file edits to the live Document tab workflows.
---

# Routing

- .docx, .hwp, .hwpx (reports, plans, letters, forms) → `$document` (`../document/SKILL.md`)
- .xlsx (sheets, tables, numbers, formulas) → `$sheet` (`../sheet/SKILL.md`)
- .pptx (slides, decks) → `$slides` (`../slides/SKILL.md`)

# Rule

Edit these files only through `harness_call` with the `document.*` operations. The owner watches each edit typed into the Document tab, and the save keeps the file's own format.
Do not rewrite the file with a script (python-docx, openpyxl, python-pptx, LibreOffice). If `document.open` answers refused or unavailable, report the reason and stop.
