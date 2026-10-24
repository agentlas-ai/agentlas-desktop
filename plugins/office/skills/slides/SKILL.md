---
name: slides
description: Design a new pptx deck in code (document.deck.build), or edit an existing deck live in the Document tab (shape text, new or removed slides, tables, speaker notes, text format) and save it as pptx.
---

# New deck (designed in code)

Use this when the system line `deck:` names `document.deck.build`. Without that line, make the deck with `document.create` and the ops below, and write each slide as a title and body.

1. Plan the story before any code: one message per slide, 5-10 slides unless told otherwise. A slide title is the conclusion ("Handling time fell 62% in six months"), not a topic word, and has no full stop.
2. Choose a look for THIS topic, not a default theme: one dominant colour (60-70% of the visual weight), one supporting tone, one sharp accent. Dark title and closing slides over light content slides, or dark throughout. Repeat one motif (rounded cards, numbered badges, a circle behind the key figure). No line under titles, no stripes down an edge, no default blue, no cream background unless asked.
3. Every slide carries a visual, and neighbouring slides differ: cards, a big number (60-72 pt) with a small label, a timeline or numbered steps, two or three comparison columns, a native chart (`pres.addChart`) for numbers, a table for dense facts. Text-only slides are the failure this path exists to avoid.
4. Type and space: title 32-40 pt bold, section header 20-24 pt, body 14-18 pt, captions 12 pt at the least. Margins 0.5 in or more, gaps 0.3-0.5 in, body text left-aligned, boxes sized for their text. When text does not fit, cut words or enlarge the box before shrinking the type.
5. Korean: `fontFace: "Malgun Gothic"` on every text. PowerPoint on a Mac shows it as a sans-serif; a font that is not installed falls back to whatever the machine picks, often a serif.
6. A picture the slide needs: `media.image.generate` first, then `addImage({ path: "<absolute path>" })`. Never an invented URL.
7. Loop: `document.deck.build` returns the lint findings and a `sessionId`. Call `document.render { sessionId }` and LOOK at every slide image (overlaps, text outside boxes, empty areas, weak contrast), then `document.deck.lint` for the numbers. Fix the errors and the warnings that matter in the script and build again with the same path. Stop after one or two rounds and say what you left.
8. Speaker notes: `slide.addNotes("…")` in the script. A deck that exists is changed with the ops below (`document.apply`), not rebuilt.

# Steps (existing deck, or a deck built op by op)

1. `harness_call {"operation":"document.list"}`: reuse an open session. Otherwise call `harness_call {"operation":"document.open","args":{"path":"<absolute path>"}}`, or `document.create` with a new `.pptx` path (a title slide; then `add_slide`).
2. The `outline` lists `# slide N (id s2)`, then `[s2.sh1] title: …` and `[s2.sh2] body: …` lines. `{…}` shows a shape's text format. A table shows as `[id] (table 3x4)` with its rows; `notes: …` is the slide's speaker notes.
3. Edit with `document.apply` using `sessionId` and `ops`. Edit one slide per call.
4. Save with `document.save`.
5. To check the layout, call `harness_call {"operation":"document.render","args":{"sessionId":"…"}}`. It returns up to 4 slides as images, as the deck is now (saved or not), and lists the boxes whose text overflows. When the reply has `next`, call again with its `from` until every slide has been seen.

# Ops

- `{"op":"set_text","target":"s2.sh1","text":"…"}` replaces a shape's text. `\n` starts a new paragraph, which is one bullet in a body. Do not type `•` or `-` in a body: the layout draws the bullet.
- `{"op":"insert_text","target":"s2.sh2","text":"…"}` appends to a shape's text.
- `{"op":"add_slide","after":"s2","title":"…","body":"line 1\nline 2"}` uses the deck's Title and Content layout.
- `{"op":"delete_slide","target":"s3"}`
- `{"op":"insert_table","after":"s2","rows":[["지표","3분기","4분기"],["첫 답변 시간","10시간","6시간"]],"widths":[2,1,1]}` puts a table on slide `s2`. The first row is the header. The table takes the slide's empty body; otherwise it goes under the slide's text. For a table slide, use `add_slide` with only a title, then `insert_table`.
- `{"op":"set_notes","target":"s2","text":"…"}` writes the slide's speaker notes. `""` clears them.
- `{"op":"set_format","target":"s2.sh1","format":{"bold":true,"size":40,"color":"#ffffff","align":"center"}}`

# Notes

- Pictures and charts on a slide are kept as they are and are not editable here. A table already in the deck is shown with its rows, but its cells are not editable.
- On `revision_conflict`, call `document.read` and apply again.
