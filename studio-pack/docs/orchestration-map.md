# Orchestration Map

```mermaid
flowchart TD
  Founder["Founder request"] --> O["Startup Orchestrator"]
  O --> I["01 Idea Foundry HQ"]
  I --> M["02 Market Intelligence HQ"]
  M --> B["03 Business Plan HQ"]
  O --> G["Design Reference Lane\nProduct Design + Creative Production"]
  G --> P
  B --> P["04 Product Planning PRD Maker"]
  P --> D["05 Product Development HQ"]
  D --> R["06 Pitch Deck / IR HQ"]
  R --> O
  O --> Out["Founder-ready execution packet"]
```

## Language Handling

- English by default.
- Korean response when the founder writes Korean.
- Artifact IDs stay English for portability.

## Evidence Handling

Each HQ must mark claims:

- `source-backed`
- `user-provided`
- `inferred`
- `simulated`
- `needs validation`

## Design Reference Handling

When the founder supplies a reference URL, screenshot, Figma frame, brand asset,
or asks for a visual concept, the Orchestrator routes that input through the
Design Reference Lane before Product Development:

- Product Design confirms the design brief and captures permitted URL or image
  evidence.
- Creative Production explores visual territories when the visual target is not
  fixed yet.
- PRD Maker writes the reference source map into the product `design.md` and
  `wireframes.md`.
- Product Development preserves that design package and verifies the rendered
  result with browser/app evidence.
