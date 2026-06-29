# Research Synthesis

This synthesis defines what each Startup HQ must inherit from established startup practice, public GitHub repos, and practical agent workflows.

## Sources Reviewed

### Startup theory and operator frameworks

- Y Combinator Startup Library: founder advice, startup idea evaluation, and startup school framing.
- Steve Blank startup tools: Customer Development, Lean LaunchPad, market research, and startup tools.
- Strategyzer Business Model Canvas: business model design, challenge, invention, and pivoting.
- Strategyzer Value Proposition Canvas: customer jobs, pains, gains, pain relievers, gain creators, and product-market fit evidence.
- Lean Startup / Lean Product Playbook PMF process: target customer, underserved needs, value proposition, MVP feature set, prototype, and customer tests.
- SBA business plan guide: executive summary, company description, market analysis, organization, service/product line, marketing/sales, funding request, and financial projections.

### Public GitHub / agent references

- `getagentseal/founder-playbook`: a structured skill pack turning founder books into AI-usable decision trees; relevant for Mom Test, Customer Development, Lean Startup, positioning, and traction routing.
- `ipavelm/ultimate-product-discovery-skill`: product discovery skill with market analysis, customers, strategy, validation, scenarios, artifacts, JTBD, Lean Canvas, OST, SWOT, PMF, and financial plan coverage.
- `ZachGoldberg/Startup-CTO-Handbook`: engineering leadership and technical execution reference for startup product development.
- `storj/roadmap` PRD template: PRD objective, features, release, and analytics structure.
- Playwright Test Agents: planner, generator, and healer pattern for browser-based QA workflows.
- `Paid/defect-driven-slide-studio`: local Forge paid package for deck generation, editable PPTX output, Defect DB quality gates, render-measure-correct loops, and visual inspection.

### Hub check

Hephaestus cloud search returned no matching owned startup founder workflow package, so this repo uses new local packaging rather than adapting an owned Hub package.

## Design Decisions

### 1. Do not build a single giant founder agent

The founder workflow has different evidence standards by phase. A single agent tends to blur idea quality, market evidence, business plan prose, PRD detail, engineering feasibility, and investor-deck narrative quality. This repo uses six HQs plus a root orchestrator.

### 2. Keep time windows short

The user requested AI-assisted schedules from a few hours to at most three days. Every HQ must produce:

- 2-hour plan
- 1-day plan
- 3-day plan

Longer horizons are allowed only as strategic context.

### 3. Separate evidence from narrative

Each HQ must mark assumptions as:

- `known`
- `inferred`
- `needs evidence`
- `blocked`

### 4. English-first, Korean-capable

Artifacts are English by default for global startup/investor/developer portability. Korean output is allowed when the founder speaks Korean or asks for Korean.

## HQ Requirements Derived From Research

### Idea Foundry HQ

Must implement:

- problem statement
- target customer segment
- customer jobs / pains / gains
- solution hypothesis
- value proposition
- business model / revenue model
- execution method and schedule
- kill / pivot / proceed recommendation

Research basis:

- Strategyzer Value Proposition Canvas
- Business Model Canvas
- YC startup idea evaluation
- Customer Development

### Market Intelligence HQ

Must implement:

- market category and segment map
- competitor table
- substitute and alternative analysis
- persona swarm feedback
- differentiation strategy
- evidence-backed market risks

Research basis:

- Customer Development
- Lean PMF process
- market research / competitive analysis
- public product discovery skill repositories

### Business Plan HQ

Must implement:

- Word-ready business plan
- SBA-style sections
- financial assumptions and projections
- market and sales strategy
- funding/use-of-funds if requested
- appendix and evidence list

Research basis:

- SBA business plan guide
- Business Model Canvas
- Value Proposition Canvas

### Product Planning PRD Maker

Must implement:

- PRD
- UX flow
- wireframes
- interview cards
- export profile for builders
- beginner-safe UI language

Research basis:

- copied PRD Maker repo
- PRD templates
- product discovery skill repos

### Product Development HQ

Must implement:

- architecture plan
- frontend/backend/data/auth/payment plan
- build task graph
- visual QA
- Playwright-style test planning
- credential-safe integration rules

Research basis:

- Startup CTO Handbook
- Playwright test-agent pattern
- AppBridge-style practical engineering flow, without private code or credentials

### Pitch Deck / IR HQ

Must implement:

- pitch deck, IR deck, market deck, sales deck, or investor update routing
- claim spine and action-title outline
- slide source map and unsupported-claim labeling
- editable deck artifact path, including PPTX when requested
- render-and-measure defect report
- visual inspection and residual-risk summary

Research basis:

- copied Defect-Driven Slide Studio package
- Minto/SCQA and assertion-evidence slide structure
- detector registry and Defect DB quality loop

## Source Links

- YC Startup Library: https://www.ycombinator.com/library/4D-yc-s-essential-startup-advice
- Steve Blank Startup Tools: https://steveblank.com/tools-and-blogs-for-entrepreneurs/
- Business Model Canvas: https://www.strategyzer.com/library/the-business-model-canvas
- Value Proposition Canvas: https://www.strategyzer.com/library/the-value-proposition-canvas
- Lean Startup Co. PMF Playbook: https://leanstartup.co/resources/articles/a-playbook-for-achieving-product-market-fit/
- SBA Business Plan Guide: https://www.sba.gov/business-guide/plan-your-business/write-your-business-plan
- Founder Playbook: https://github.com/getagentseal/founder-playbook
- Ultimate Product Discovery Skill: https://github.com/ipavelm/ultimate-product-discovery-skill
- Startup CTO Handbook: https://github.com/ZachGoldberg/Startup-CTO-Handbook
- Storj PRD Template: https://github.com/storj/roadmap/blob/main/Product%20Requirements%20Document%20Template
- Playwright Test Agents: https://playwright.dev/docs/test-agents
- Defect-Driven Slide Studio: local Forge package `Paid/defect-driven-slide-studio`
