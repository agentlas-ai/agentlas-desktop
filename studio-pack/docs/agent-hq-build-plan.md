# Agent HQ Build Plan

## Root Orchestrator

### Mission

Coordinate the six Startup HQs into one founder workflow.

### Inputs

- raw startup idea
- founder constraints
- target language
- geography
- product type
- business model preference
- build deadline
- deck audience and target format, when deck/IR work is requested

### Outputs

- founder summary
- HQ route
- merged assumptions
- artifacts index
- deck artifact plan
- execution plan

### Routing Logic

| Trigger | HQ |
|---|---|
| "I have an idea" | Idea Foundry HQ |
| "Who is the customer / competitor?" | Market Intelligence HQ |
| "Make a business plan / Word doc" | Business Plan HQ |
| "Make a PRD / product spec / UX flow" | Product Planning PRD Maker |
| "Build app / web / game / backend / payment" | Product Development HQ |
| "Make a pitch deck / IR / PPT / investor deck" | Pitch Deck / IR HQ |

## HQ 1: Idea Foundry

### Worker Roster

- `00-hq`: decides proceed / pivot / kill.
- `10-problem-framer`: turns vague idea into problem and customer pain.
- `20-customer-segmenter`: defines customer segments and early adopter wedge.
- `30-business-modeler`: proposes revenue model, business model, and short execution plan.

### Gates

- Problem is specific.
- Customer segment is reachable.
- Revenue model has at least one plausible buyer.
- 2-hour / 1-day / 3-day plan exists.

## HQ 2: Market Intelligence

### Worker Roster

- `00-hq`: owns market evidence and differentiation strategy.
- `10-competitor-analyst`: maps direct competitors, substitutes, and alternatives.
- `20-persona-swarm`: simulates persona feedback while marking assumptions.
- `30-differentiation-strategist`: chooses wedge, positioning, and risks.

### Gates

- Competitors and substitutes are separated.
- Persona feedback is labeled as simulated unless sourced from real evidence.
- Differentiation is customer-facing, not just feature-facing.

## HQ 3: Business Plan

### Worker Roster

- `00-hq`: owns final plan quality.
- `10-plan-architect`: outlines the business plan.
- `20-financial-modeler`: creates assumptions and projection tables.
- `30-docx-writer`: writes a Word-ready document structure.

### Gates

- SBA-style sections are present.
- Financial assumptions are explicit.
- Unsupported claims are marked.
- Word-ready output can be converted without structural edits.

## HQ 4: Product Planning PRD Maker

Copied from `agentlas-prd-maker-studio` at commit `9655c7a`.

### Gates

- PRD has UX flow and wireframes.
- Floating interview cards ask one question at a time.
- Beginner UI avoids internal terms.
- Export target is selected.

## HQ 5: Product Development

### Worker Roster

- `00-hq`: owns build route and delivery risk.
- `10-frontend-builder`: web/app/game UI execution plan.
- `20-backend-architect`: API, DB, auth, payment, and infrastructure plan.
- `30-qa-visual-agent`: browser QA, visual review, and Playwright-style checks.

### Gates

- No credentials copied or embedded.
- Architecture matches product type.
- Payment/auth scopes are explicit.
- Browser or app surface is visually checked when present.

## HQ 6: Pitch Deck / IR

Copied from `Paid/defect-driven-slide-studio` on 2026-06-19.

### Worker Roster

- `00-orchestrator`: owns slide studio routing and the prevention -> measurement -> correction loop.
- `60-narrative-architect`: creates claim spine, SCQA/Minto structure, and action titles.
- `70-layout-composer`: creates editable deck IR, visual hierarchy, and infographic components.
- `80-render-measure-gate`: renders and runs machine-checkable defect detectors.
- `90-defect-fixer`: fixes flagged defects through a bounded loop.
- `130-visual-inspector`: performs render-and-look inspection for overflow, clipping, collision, and relevance.
- `40-eval-qa`: checks sourcing, unsupported claims, residual risks, and final review needs.

### Gates

- No fabricated metrics, logos, citations, traction, or customer quotes.
- One main claim per slide.
- Slide claims must carry evidence labels.
- Deck artifacts must preserve editability where practical.
- Defect QA must run before a deck is called ready.

## Cross-HQ Artifact Flow

```text
idea-brief.md
  -> market-report.md
  -> business-plan.md / business-plan.docx
  -> prd-package/
  -> build-plan.md
  -> pitch-deck-ir/
```
