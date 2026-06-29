# Agentlas Startup Founder Studio

English-first, Korean-capable startup operating agent system for replacing the early founder workflow: idea shaping, market intelligence, business planning, PRD/product planning, product development, and pitch/IR deck generation.

This package is intentionally shipped as a lean Startup Studio GUI + parent orchestrator. The seven specialist HQs are published separately on Agentlas Hub and are called at runtime through Hephaestus Network with `local_inventory: []`. They are not bundled under a local `Startup/` folder in the public package; that keeps the cloud package small, public-safe, and identical for users who do not have Mason's local `Paid/` inventory.

## Startup HQs

| Hub slug | HQ | Job |
|---|---|---|
| `idea-foundry-hq` | Idea Foundry HQ | Turn raw ideas into a sharp problem, customer, business model, solution, tool stack, and 2-hour to 3-day execution plan. |
| `market-intelligence-hq` | Market Intelligence HQ | Research markets, competitors, customer personas, persona-swarm feedback, and differentiation strategy. |
| `business-plan-hq` | Business Plan HQ | Produce an investor/bank-ready business plan and Word-ready document outline. |
| `agentlas-prd-maker-studio` | Product Planning PRD Maker | Use PRD Maker as the product planning HQ. |
| `product-development-hq` | Product Development HQ | Turn PRDs into web, app, game, backend, DB, auth, payment, and QA execution plans. |
| `defect-driven-slide-studio` | Pitch Deck / IR HQ | Use Defect-Driven Slide Studio for pitch decks, IR decks, market decks, editable PPTX, and defect QA. |
| `Web_master` | Web Master HQ | Owns front-end web/app/mobile/game UI build planning, design systems, external design-provider handoff, and visual QA. Product Development hands off UI/design/visual-QA work here. |

## Design Lane

Reference design work is routed through `docs/design.md` and
`.agentlas/global-plugin-tools.json`.

- Product Design captures or validates URLs, screenshots, Figma frames, saved
  context, and source-to-implementation fidelity.
- Creative Production creates visual territories, mood boards, positioning
  directions, and polished image assets when no single approved visual target
  exists.
- PRD Maker owns reference-backed `design.md`, `ui-spec.md`, `ux-flow.md`, and
  `wireframes.md`.
- Product Development owns the build plan and requires visual/browser evidence
  plus `design-qa.md` before UI completion.
- `.agentlas/design-memory.md` keeps curated concept decisions across future
  runs through the existing memory-ticket flow.

## Orchestrator

The root orchestrator lives at `agents/00-startup-orchestrator/agent.md`. It routes founder requests to the correct HQ, enforces evidence gates, and combines outputs into a founder-ready plan.

Default route:

```text
Raw idea
  -> Idea Foundry HQ
  -> Market Intelligence HQ
  -> Business Plan HQ
  -> Product Planning PRD Maker
  -> Product Development HQ
  -> Pitch Deck / IR HQ
```

## Research Basis

The build plan is grounded in YC startup advice, Steve Blank Customer Development, Strategyzer Business Model Canvas and Value Proposition Canvas, Lean Product/PMF process, SBA business-plan structure, PRD templates, Playwright test-agent patterns, the copied Defect-Driven Slide Studio, and current GitHub founder-skill repositories.

See `docs/research-synthesis.md` and `docs/agent-hq-build-plan.md`.

## Web Surface (Startup Studio)

The primary front end is a **Plane-grade founder operating board** under
[`web/`](web/): a three-pane workspace (rail → board → inspector) that renders
the six HQ agents' output with an animated agent-run reveal, evidence-labeled
work items, per-stage decision cards, dark/light themes, and a ⌘K palette. It
ports Plane's design system (tokens copied verbatim) onto the Startup HQ data
model. See [`web/README.md`](web/README.md).

```bash
cd web && npm install && npm run dev   # http://localhost:5273
```

## Quick Use (legacy GUI)

Open the original single-file beginner GUI:

```bash
python3 scripts/open-studio-gui.py
```

The GUI follows the founder lifecycle: idea shaping, market validation,
business design, PRD/screen design, app build, web build, and QA/launch. It
keeps internal routing terms off the visible screen while still routing into the
six Startup HQ packages.

Private local routing works through the Hephaestus local-first router after this repo is registered as a network source. The package also declares an explicit local GUI shortcut for `startup`, so a Hephaestus runtime with local GUI shortcut support can open the private GUI from the Network surface without publishing the repo.

Ask the orchestrator:

```text
Create a startup workflow for: <idea>
```

It returns:

1. founder decision summary
2. HQ routing plan
3. evidence gaps
4. generated artifacts
5. deck or IR needs, when requested
6. next 2-hour / 1-day / 3-day execution plan

## Verification

```bash
scripts/verify-package.sh
```
