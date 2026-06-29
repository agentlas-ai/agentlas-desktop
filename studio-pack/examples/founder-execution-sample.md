# Founder Execution Packet Sample

This is a contract sample, not a claim of real market validation.

## Founder Request

Build an AI web app that helps solo founders turn messy startup ideas into a validated business brief, PRD, and first build plan.

## HQ Route

| Step | HQ | Reason | Status |
|---|---|---|---|
| 1 | Idea Foundry HQ | The request starts as a raw idea and needs problem/customer/business model shaping. | completed |
| 2 | Market Intelligence HQ | The market needs competitor, substitute, persona, and differentiation analysis. | completed with simulated persona caveat |
| 3 | Business Plan HQ | The founder needs a Word-ready business plan path. | completed with assumptions |
| 4 | Product Planning PRD Maker | The product needs PRD, UX flow, interview cards, and builder export. | completed via copied PRD Maker HQ |
| 5 | Product Development HQ | The PRD needs a build route for web/backend/auth/payment/QA. | completed as build plan |
| 6 | Pitch Deck / IR HQ | The founder may need an investor or market deck based on the execution packet. | completed as deck plan with unsupported claims labeled |

## Idea Foundry Output

### Problem

Solo founders use AI tools to write startup documents, but the outputs are scattered, generic, and disconnected from market evidence.

Evidence status: `inferred`.

### Target Customer

Primary early adopter: non-technical or semi-technical solo founders who are trying to validate and build AI-enabled web products within days.

Buyer/user: same person for self-serve subscription; budget owner is the founder.

### Jobs / Pains / Gains

| Type | Item | Evidence Status |
|---|---|---|
| Job | Turn a vague idea into a concrete next action. | inferred |
| Pain | AI outputs do not preserve traceability across research, plan, PRD, and build tasks. | inferred |
| Gain | Founder gets one execution packet instead of five disconnected docs. | inferred |

### Business Model

Self-serve SaaS with free starter export and paid workspace/project limits.

Evidence status: `needs validation`.

### Next 2 Hours

- Interview 3 founders who recently used AI to plan an app.
- Collect current workaround screenshots or notes.
- Build landing-page copy for the problem.

### Next 1 Day

- Create clickable prototype.
- Run 5 customer discovery calls.
- Draft pricing test.

### Next 3 Days

- Build a working single-flow prototype.
- Test PRD export quality with 5 founder ideas.
- Measure whether users complete idea-to-build-plan without external prompting.

## Market Intelligence Output

### Competitor / Substitute Matrix

| Name | Type | Customer | Promise | Opening | Evidence Status |
|---|---|---|---|---|---|
| ChatGPT / Claude | Substitute | Founders | General ideation and document generation | Lacks packaged founder workflow and artifact gates. | source-backed generally, product-specific gap inferred |
| Lovable / Bolt / v0 | Adjacent builder | Builders/founders | Turn prompts into apps | Needs stronger upstream planning and validation. | source-backed generally, gap inferred |
| PRD generator tools | Direct/adjacent | PMs/founders | Generate PRDs | Usually stops before market/business/build linkage. | needs validation |

### Persona Swarm

All rows are `simulated`.

| Persona | Reaction | Objection | Buying Trigger | Proof Needed |
|---|---|---|---|---|
| Urgent solo founder | Wants a single workflow. | Worried it is another generic AI doc tool. | Produces useful PRD and build tasks in under 30 minutes. | Side-by-side output comparison. |
| Skeptical technical founder | Likes artifact structure. | Distrusts simulated market claims. | Clear evidence labels and exportable assumptions. | Transparent source/evidence table. |
| Budget owner founder | Interested if it saves paid consultant time. | Needs pricing clarity. | Free first project or low entry tier. | Time-saved proof. |

### Differentiation

Wedge: founder workflow continuity from idea to market to plan to PRD to build, with evidence labels and short execution windows.

Evidence status: `inferred`, requires user testing.

## Business Plan Output

### Plan Type

Lean startup plan first; traditional SBA-style plan when funding is needed.

### Financial Assumptions

| Assumption | Base Case | Status |
|---|---:|---|
| Paid conversion from activated users | 5% | assumption |
| Monthly price | 19 USD | assumption |
| First acquisition channel | founder communities and AI builder communities | needs validation |
| Gross margin | high, software-only | assumption |

### Risks

- Users may prefer general chat tools.
- Market research quality may be distrusted without live sources.
- Builder integrations may change quickly.

## Product Planning PRD Maker Output

### PRD Scope

- one-sentence idea input
- PRD type selector
- floating interview card
- market comparison view
- builder export
- beginner-safe UI

### Interview Card

Question 1: Is the product supposed to work autonomously, or only assist one task?

Answer options:

- autonomous AI workflow
- assist one task
- not sure yet

## Product Development Output

### Build Route

`web`

### Architecture

- frontend: single-page web app
- backend: optional first; required for saved projects, auth, billing
- data: project, artifact, answer, export target
- auth: email/OAuth when saving projects
- payment: subscription only after value proof
- deployment: static prototype first, hosted app later

### QA Plan

- desktop and mobile visual inspection
- no internal jargon on beginner screens
- four-button budget on main UI
- export text copy check
- no horizontal overflow

## Pitch Deck / IR Output

### Deck Purpose

Investor-facing seed-style pitch deck for testing the story, not for fundraising
without real validation.

### Claim Spine

1. Solo founders lose time because AI planning outputs are disconnected.
2. A guided founder workflow can connect idea, market, plan, PRD, and build tasks.
3. The first wedge is fast, evidence-labeled execution packets for solo founders.
4. Demand, pricing, and retention remain unvalidated.

### Slide Outline

| Slide | Claim | Evidence Status |
|---|---|---|
| 1 | Solo founders need one workflow from idea to build plan. | inferred |
| 2 | Current substitutes are fragmented across chat tools and AI builders. | source-backed generally, product-specific gap inferred |
| 3 | The product creates a founder execution packet with evidence labels. | user-provided / inferred |
| 4 | Early validation should focus on completion quality, not vanity deck polish. | source-backed generally |
| 5 | Pricing and demand need direct customer tests. | needs validation |

### Defect QA Requirement

Run Pitch Deck / IR HQ render-measure-visual QA before calling any deck ready.

## Final Verdict

Proceed to prototype, but treat market demand and pricing as unvalidated.
