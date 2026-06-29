# Source-To-HQ Traceability

This file exists to prevent shallow "research theater." Each HQ must trace behavior to source-backed frameworks.

## External Research Sources

| Source | What It Contributes | HQ Impact |
|---|---|---|
| YC Startup Library | Launch quickly, build something people want, find intense early users, keep MVP scope small. | Orchestrator and Idea Foundry must prefer fast validation and 2h/1d/3d execution windows. |
| Steve Blank Customer Development | A startup is searching for customers and a repeatable business model before scaling. | Idea Foundry and Market Intelligence must label hypotheses and require customer evidence. |
| Strategyzer Business Model Canvas | Value proposition, customer segments, channels, revenue, resources, activities, partners, and costs. | Idea Foundry and Business Plan must produce business model logic, not just product ideas. |
| Strategyzer Value Proposition Canvas | Jobs, pains, gains, pain relievers, and gain creators. | Idea Foundry must attach each solution claim to a customer job, pain, or gain. |
| Jobs To Be Done | Functional, social, and emotional forces explain switching behavior. | Idea Foundry and Market Intelligence must capture switching forces and current alternatives. |
| Lean Product Process | Target customer, underserved needs, value proposition, MVP feature set, prototype, customer testing. | Market Intelligence and PRD Maker must feed Product Development only after scope is testable. |
| SBA Business Plan Guide | Executive summary, company description, market analysis, organization, product line, sales, funding, financial projections. | Business Plan HQ must produce Word-ready plans with financial assumptions and evidence labels. |
| Founder Playbook GitHub repo | AI-usable skill packs for founder books and decision trees. | Repo structure should use explicit skills, triggers, and operating protocols rather than passive docs. |
| Ultimate Product Discovery Skill GitHub repo | Discovery artifacts such as market analysis, customers, JTBD, Lean Canvas, SWOT, PMF, scenarios. | Idea and Market HQs should output artifacts, not just advice. |
| Startup CTO Handbook GitHub repo | Startup engineering leadership and technical decision scope. | Product Development HQ must include architecture, tech-risk, team/process, and QA discipline. |
| Playwright Test Agents | Planner/generator/healer loop for browser testing. | Product Development QA worker must require visual/browser evidence for web surfaces. |
| Defect-Driven Slide Studio | Defect DB, render-measure-correct loop, editable PPTX path, action-title narrative, and deck visual QA. | Pitch Deck / IR HQ must create deck outlines and artifacts with source labels, defect reports, and residual-risk notes. |
| Product Design plugin | Design brief gate, URL/screenshot capture, image-to-code, URL-to-code, and design QA contracts. | PRD Maker and Product Development must capture visual sources before wireframes/builds and block UI completion on fidelity QA. |
| Creative Production plugin | Explore-stage creative paths, mood boards, positioning, offers, scenes, ads, and generative polish. | PRD Maker must use visual territories when no single target exists, and Product Development must preserve selected assets/directions. |

## HQ Coverage Matrix

| HQ | Required Frameworks | Must Produce | Must Refuse / Block |
|---|---|---|---|
| Idea Foundry HQ | YC, Customer Development, BMC, VPC, JTBD | problem, customer, current alternative, value proposition, revenue model, 2h/1d/3d plan | "everyone" customer, no buyer, no current alternative, no 3-day evidence path |
| Market Intelligence HQ | Customer Development, Lean Product Process, TAM/SAM/SOM, JTBD | competitor matrix, substitutes, status quo, persona swarm, differentiation | simulated feedback treated as validation, AI-only differentiation, no sources |
| Business Plan HQ | SBA, BMC, VPC | Word-ready business plan, assumptions table, financial logic, risks | generic prose, unsupported market claims, financials without assumptions |
| Product Planning PRD Maker | PRD templates, Lean Product Process, interview cards, Product Design, Creative Production | PRD, UX flow, reference-backed design.md, wireframes, anchored question cards, builder export | coding before requirements, internal jargon in beginner UI, wireframes without visual source map |
| Product Development HQ | Startup CTO Handbook, Playwright test-agent model, Product Design fidelity QA | architecture, frontend/backend/data/auth/payment plan, design source map, QA evidence | ambiguous PRD, implied auth/payment, no testable 3-day artifact, UI build without visual target |
| Pitch Deck / IR HQ | Defect-Driven Slide Studio, Minto/SCQA, assertion-evidence, render-and-measure QA | claim spine, slide outline, source map, editable deck artifact path, defect QA summary | invented claims, fake logos, unsupported numbers, flattened editable diagrams, no visual inspection |

## Minimum Evidence Labels

Use one of:

- `source-backed`
- `user-provided`
- `inferred`
- `simulated`
- `needs validation`
- `blocked`

## Audit Verdict

The first local version created the initial Startup skeleton but under-specified the HQ operating rules. The 2026-06-19 update added the explicit Pitch Deck / IR HQ from the paid Forge slide studio and widened this traceability layer before treating it as a serious agent package.
