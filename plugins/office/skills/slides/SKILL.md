---
name: slides
description: Edit a pptx deck live in the Document tab (shape text, new or removed slides, text format) and save it as pptx.
---

# Steps

1. `harness_call {"operation":"document.list"}`: reuse an open session. Otherwise call `harness_call {"operation":"document.open","args":{"path":"<absolute path>"}}`, or `document.create` with a new `.pptx` path (a title slide; then `add_slide`).
2. The `outline` lists `# slide N (id s2)`, then `[s2.sh1] title: …` and `[s2.sh2] body: …` lines. `{…}` shows a shape's text format.
3. Edit with `document.apply` using `sessionId` and `ops`. Edit one slide per call.
4. Save with `document.save`.

# Ops

- `{"op":"set_text","target":"s2.sh1","text":"…"}` replaces a shape's text. `\n` starts a new paragraph, which is one bullet in a body. Do not type `•` or `-` in a body: the layout draws the bullet.
- `{"op":"insert_text","target":"s2.sh2","text":"…"}` appends to a shape's text.
- `{"op":"add_slide","after":"s2","title":"…","body":"line 1\nline 2"}` uses the deck's Title and Content layout.
- `{"op":"delete_slide","target":"s3"}`
- `{"op":"set_format","target":"s2.sh1","format":{"bold":true,"size":40,"color":"#ffffff","align":"center"}}`

# Notes

- Pictures, charts and tables on a slide are kept as they are and are not editable here.
- On `revision_conflict`, call `document.read` and apply again.
