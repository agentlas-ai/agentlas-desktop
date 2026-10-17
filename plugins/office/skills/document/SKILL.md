---
name: document
description: Edit a docx, hwp or hwpx file live in the Document tab and save it in its own format.
---

# Steps

1. `harness_call {"operation":"document.list"}`: reuse a session already open in this conversation. Otherwise call `harness_call {"operation":"document.open","args":{"path":"<absolute path>"}}`.
2. Read the returned `outline`. Each line starts with the id that ops address: `[b3]` is a paragraph, and `b5.r2c1` is a table cell (row 2, column 1). `{bold 14pt center}` shows the current format. For a fresh outline, use `document.read` with `sessionId`.
3. Edit with `harness_call {"operation":"document.apply","args":{"sessionId":"…","ops":[…]}}`. Send a few ops per call so the owner can follow along.
4. When the work is done, or when the owner asks, save with `harness_call {"operation":"document.save","args":{"sessionId":"…"}}`.

# Ops

- `{"op":"set_text","target":"b3","text":"…"}` replaces a paragraph or table-cell text. `\n` is a line break inside it.
- `{"op":"insert_text","target":"b3","text":"…","at":0}` inserts text. Without `at`, the text is appended.
- `{"op":"insert_paragraph","after":"b3","text":"…","heading":2}` adds a paragraph. `"after":"start"` puts it first. `heading` is optional.
- `{"op":"insert_table","after":"b3","rows":[["a","b"],["c","d"]]}`: docx only.
- `{"op":"delete_block","target":"b3"}`
- `{"op":"set_format","target":"b3","format":{"bold":true,"size":14,"color":"#c00000","align":"center"},"heading":1}` sets the format of a whole paragraph or cell. `null` removes a value; `heading` 0 is body text.

# Format notes

- HWP binary has no headings. Use size and bold instead.
- A paragraph marked as holding the section settings cannot be deleted; edit its text instead.

# Refusals

- `revision_conflict`: the owner changed the same place. Call `document.read` and apply again.
- `permission_read_only`: this run may not edit. Tell the owner.
- `file_changed_on_disk` or `file_locked`: the file changed or another app has it open. Ask the owner to close it.
