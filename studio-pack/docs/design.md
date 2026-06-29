# Design Concept And Plugin Workflow

## Purpose

Startup Founder Studio should feel like a founder operating room, not a generic
chat prompt. The user brings a raw idea, reference sites, screenshots, or brand
notes; the studio turns them into a traceable product concept, wireframes,
build plan, and visual QA path.

The design system is reference-first:

- Every UI direction starts from either a supplied visual source, a captured URL,
  saved Product Design context, or a clearly marked exploratory concept.
- Product Design owns design-brief confirmation, URL/screenshot capture,
  source-to-prototype fidelity, and `design-qa.md`.
- Creative Production owns visual territory exploration, mood boards,
  positioning directions, scene/offer/ad concepts, and polished image assets.
- Product Planning PRD Maker converts the selected direction into `design.md`,
  `ui-spec.md`, `ux-flow.md`, `wireframes.md`, and anchored interview cards.
- Product Development turns the approved design package into a build plan and
  requires browser/app visual evidence before calling the UI complete.

## Experience Concept

The first screen should stay beginner-friendly while moving toward a
Linear-grade founder workspace: lifecycle stages, package choice, pilot status,
and artifact previews are the visible workflow spine. Old generic command
buttons such as start, ask, view, and send must not be the primary UX. The
internal HQ machinery stays hidden from the visible UI, but the product should
quietly preserve the user's idea spine, selected audience, reference design
sources, and current concept direction across sessions.

The founder-facing experience should emphasize:

- one clear next action instead of many internal modes;
- a visible idea-to-product lifecycle instead of prompt-command framing;
- evidence labels for market, investor, and product claims;
- visual references beside product decisions, not buried in notes;
- short 2-hour, 1-day, and 3-day execution windows;
- a handoff that a coding agent can build without guessing.

The visual tone should be calm, operational, and dense enough for repeated work:
structured panels, compact evidence cards, readable tables, timeline/status
strips, and restrained color. Avoid marketing hero pages, decorative empty
cards, fake dashboards, and unexplained internal labels.

## Reference Source Map

Current status: `captured`, except Genspark visual capture, which returned a
waiting screen and is used only for positioning text.

| Source | Evidence | What to borrow | What to avoid |
|---|---|---|---|
| `REF-001 Linear` | `output/reference-captures/linear-desktop.png`, `output/reference-captures/linear-mobile.png`, https://linear.app/ | Dark side rail, issue-detail density, product-roadmap language, product direction from idea to launch. | Do not clone brand marks, exact copy, or issue UI pixel-for-pixel. |
| `REF-002 Manyfast` | `output/reference-captures/manyfast-desktop.png`, https://manyfast.io/ko/ | Korean novice-friendly entry, PRD to user-flow to wireframe sequence, one central idea input. | Do not keep the old "Manifest" framing as the visible PRD metaphor. |
| `REF-003 Liner Write` | `output/reference-captures/liner-write-desktop.png`, `output/reference-captures/liner-write-mobile.png`, https://liner.com/ko/write | Document-writing promise: research, draft, fact-check, edit in one window. Use for business plan and documentation copy. | Do not turn Startup Studio into a pure writing landing page. |
| `REF-004 Sudowrite` | `output/reference-captures/sudowrite-desktop.png`, https://sudowrite.com/ | Writer-workflow energy: blank page relief, draft momentum, rewrite/polish loop. Use for concept copy, not visual palette. | Avoid beige storybook styling and celebrity/social proof layout. |
| `REF-005 GPAI` | `output/reference-captures/gpai-desktop.png`, `output/reference-captures/gpai-mobile.png`, attached screenshots | Left recent-task rail, central answer/document surface, right follow-up questions, accuracy/cross-check cue. | Avoid education-only framing and login wall as the main product. |
| `REF-006 Sinas` | `output/reference-captures/sinas-desktop.png`, https://sinas.co/ | Technical confidence, unified API/tools language, dark premium restraint. | Avoid developer-platform terminal hero as the primary founder screen. |
| `REF-007 Genspark` | https://www.genspark.ai/ | All-in-one AI workspace positioning and multi-tool navigation. | Visual capture was blocked by a waiting screen; do not use as visual evidence. |
| `REF-008 Attached AppBridge/Paddle-style screenshot` | Task attachment image #1 | Dense operational sidebar, checklist/cards, status-first right panels. | Do not copy payment-product nouns or Paddle-specific IA. |

## Selected Direction

Startup Studio should become "the Korean Linear for startup creation":

- **Primary metaphor:** product board, not a chat page and not a static document.
- **Left rail:** stable workspace navigation, recent work, and progress.
- **Center:** current idea as an issue/document, with PRD-style work items and
  document preview below.
- **Right inspector:** follow-up questions, cross-check status, and next proof
  needed.
- **Copy model:** Liner Write for business-plan/document creation, Sudowrite for
  blank-page relief and draft momentum, GPAI for follow-up questions and
  accuracy checks.
- **PRD direction:** Linear-like issue/roadmap/task view instead of visible
  "manifest" language.
- **Generated Stitch source:** `REF-GEN-STITCH-001-v2` confirms the dense
  three-pane operating-board direction with Korean labels, all three package
  choices, `2/3 대화 기록`, and app/web artifact preview treatment. Use it as a
  visual source, but keep the local webapp contract stricter when generated
  output omits required controls.

## Global Plugin Tools

The package advertises these global plugin dependencies in
`.agentlas/global-plugin-tools.json`.

| Need | Preferred Tool Path | Output |
|---|---|---|
| Confirm design brief | Product Design `get-context` | approved product, visual source, and interactivity brief |
| Capture a reference URL | Product Design `url-to-code` capture flow plus Browser/Chrome evidence | desktop/mobile screenshots, DOM/style notes, assets, interaction states |
| Use a supplied screenshot or mock | Product Design `image-to-code` source analysis | visual target inventory, asset plan, build fidelity checklist |
| Audit an existing flow | Product Design `audit` | screenshot-backed UX/design/accessibility findings |
| Explore visual directions | Creative Production `explore` then `moodboard-explorer` or `positioning-explorer` | reviewable directions and handoff notes |
| Produce concept assets | Creative Production `offer-explorer`, `scene-explorer`, `ads-explorer`, or `generative-polish` | selected assets, manifest, and review surface |
| Verify implementation fidelity | Product Design `design-qa` plus Product Development QA Visual Agent | `design-qa.md`, viewport observations, residual issues |

Browser capture order follows Product Design policy: Browser skill first, Chrome
second, and Playwright only after user approval.

## Reference Intake Contract

When the founder gives a reference website address, screenshot, Figma frame,
brand asset, or design-system link, the design lane must create a source map
before writing wireframes:

| Field | Required Content |
|---|---|
| `source_id` | stable ID such as `REF-001` |
| `type` | `url`, `screenshot`, `figma`, `brand_asset`, `saved_context`, or `generated_concept` |
| `permission_status` | `user-owned`, `permission-claimed`, `public-reference-only`, or `unknown` |
| `capture_status` | `captured`, `blocked`, `not-needed`, or `needs-user-input` |
| `desktop_evidence` | screenshot path, browser observation, or blocker |
| `mobile_evidence` | screenshot path, browser observation, or blocker |
| `extract` | layout, typography, color, spacing, interaction, asset, and content signals |
| `adaptation_rule` | what to preserve, transform, avoid, or label as exploratory |

Do not hotlink source assets in final artifacts. If a source cannot be captured,
state the blocker and continue only with clearly labeled exploratory design work.
Do not clone a third-party site unless the user owns it or has permission.

## Wireframe Agent Contract

`Startup/04-product-planning-prd-maker/agents/70-architect/agent.md` is the
wireframe owner. For UI-bearing work it must:

1. Read this file, `.agentlas/design-memory.md`, and any supplied reference map.
2. Ask Product Design to confirm the design brief when product, visual source,
   or interactivity is unclear.
3. Use Product Design capture/audit paths when URL or screenshot evidence exists.
4. Use Creative Production for mood boards or visual territories when no single
   approved visual target exists.
5. Write reference-backed sections into the produced `design.md` and
   `wireframes.md`.
6. Emit memory events for selected visual direction, rejected directions,
   reusable component decisions, and unresolved design questions.

## Build Agent Contract

`Startup/05-product-development-hq/agents/10-frontend-builder/agent.md` is the
build handoff owner. It must:

1. Require a PRD, user flow, wireframes, and a design source map before planning
   implementation.
2. Use Product Design `image-to-code` or `url-to-code` only after the design
   brief is confirmed and the target is permitted.
3. Preserve the selected visual direction rather than inventing a new style.
4. Produce a build plan with design source map, asset plan, component states,
   responsive rules, accessibility checks, and visual QA checkpoints.
5. Require browser/app evidence and `design-qa.md` before declaring UI complete.

## Memory Contract

Design memory is project-scoped, not a transcript dump.

Persist these through `.agentlas/memory-tickets.jsonl` and curate into
`.agentlas/design-memory.md`:

- approved visual direction and why it won;
- founder-specific concept language and avoid-list;
- reusable references and what they should influence;
- rejected references or failed approaches and why;
- stable design-system decisions such as radius, density, typography, navigation,
  and core screen patterns;
- QA findings that future builders should not repeat.

Never store credentials, private account data, raw logs, complete transcripts,
or local machine paths.

## Current Studio Concept Snapshot

Status: `inferred`, pending future founder-specific references.

The default concept is a compact founder command surface:

- Top level: idea spine, evidence gaps, current HQ route, and next action.
- Product planning: source-backed design brief, UI flow, wireframe preview, and
  interview cards beside unresolved decisions.
- Product development: build route, architecture scope, frontend component map,
  backend/auth/payment decisions, and visual QA checklist.
- Deck/IR: claim spine, source map, editable artifact path, and defect summary.

This concept should be superseded when the founder supplies actual product
references, screenshots, or brand assets.
