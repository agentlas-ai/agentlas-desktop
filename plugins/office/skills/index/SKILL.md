---
name: index
description: Route Word, Hangul, Excel and PowerPoint file edits to the live Document tab workflows.
---

# Routing

- .docx, .hwp, .hwpx (reports, plans, letters, forms) → `$document` (`../document/SKILL.md`)
- .xlsx (sheets, tables, numbers, formulas) → `$sheet` (`../sheet/SKILL.md`)
- .pptx (slides, decks) → `$slides` (`../slides/SKILL.md`): an existing deck is edited with ops; a NEW deck is designed in code when the system line `deck:` says so (see its "New deck" section)

# New files and conversions

- A new file: `harness_call {"operation":"document.create","args":{"path":"<absolute path that does not exist>","title":"…"}}` opens a blank A4 document (or a workbook or deck) in the Document tab; fill it with the same ops. Hangul is created as `.hwpx`; HWP binary cannot be created. A new deck on a runtime whose system prompt has the `deck:` line is not created blank: it is designed in code with `document.deck.build` (`$slides`, "New deck").
- "Make it in Hangul", "turn it into slides", or another format: `document.open` the source and read its outline, `document.create` the target next to it with the new extension, then rebuild the content op by op (paragraphs, headings, tables with `widths` and `merges`, cell `fill`, bold/align, `pageBreak`). Save the target. The source stays unchanged.
- "Hangul" or "hwp" means a Hangul document. Create it as `.hwpx`: Hancom Office opens it as a 한글 file and can save it as .hwp. Say this once, and treat the .hwpx as the requested file.

# Rule

Edit an existing file only through `harness_call` with the `document.*` operations. The owner watches each edit typed into the Document tab, and the save keeps the file's own format.
Do not rewrite an existing file with a script (python-docx, openpyxl, python-pptx, LibreOffice). If `document.open` answers refused or unavailable, report the reason and stop.
The one script that is expected is a new deck's pptxgenjs script passed to `document.deck.build`: it runs in the app's sandbox and writes only the new file.
