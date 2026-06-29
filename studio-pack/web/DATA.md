# Studio data contract — session output → GUI

The GUI does **not** need a backend to "call agents." A `/hep-network startup`
session in Claude Code / Codex **is** the agent runtime (the Agentlas MCP loads
the orchestrator system prompt into that session). So the session's answer and
the GUI content are the same thing — the GUI just renders what the session wrote.

## How it works

1. The session produces the founder output as a `StudioContent` object
   (the shape in [`src/data/types.ts`](src/data/types.ts): `ideaSpine` + 6
   `stages`, each with headline / metrics / workItems / decision / document and
   the stage-specific surfaces — `competitors`, `marketSizing`, `personas`,
   `businessModel`, `financials`, `userFlow`, `wireframe`, `product`, `slides`…).
2. The session writes it to **`web/public/studio-data.json`**:

   ```json
   { "name": "<idea name>", "en": { /* StudioContent */ }, "ko": { /* optional */ } }
   ```

   (A bare `StudioContent` object is also accepted and treated as `en`.)
3. The GUI fetches `/studio-data.json` on load. If present, it renders that as the
   **live** idea (sidebar badge: `라이브 · 이 세션`). If absent, it falls back to
   the bundled worked examples (badge: `예시 데이터`).

No build step, no server, no `runAgent` bridge — just a static file the session
drops next to the app. `studio-data.json` is git-ignored (it's per-run output).

## What is real vs. example

- **Real**: the GUI rendering, all exports (editable **.pptx** via pptxgenjs,
  **.doc**, HTML deck, the live `<iframe>` app, founder-packet JSON in the legacy
  console), navigation, theme, decision recording, evidence panels.
- **Example until a session writes `studio-data.json`**: the idea/market/business/
  PRD/build/deck content (the three bundled demos: café / meal-prep / tutor).
- **Production decks**: the in-browser PPTX is a quick draft. The defect-QA'd
  editable deck is produced by the **Defect-Driven Slide Studio**
  (`Startup/06-pitch-deck-ir-hq`, python-pptx + IR + detector gates).
