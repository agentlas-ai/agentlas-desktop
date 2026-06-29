---
id: startup-studio-wireframes-001
type: wireframes
project: agentlas-startup-founder-studio
feature: startup-studio-web-surface
status: draft
version: 0.3.0
owner_role: PRD Maker Architect
depends_on: [spec.md, ui-spec.md, ux-flow.md, design.md]
satisfies: [REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-009, REQ-010]
last_validated: 2026-06-19
---

# Wireframes — Startup Studio Web Surface

## Wireframe Index

| Wireframe | Screen/state | Surface | Satisfies | Visual source |
|---|---|---|---|---|
| WF-001 Workspace Home {#wf-001} | idea intake | desktop+mobile web | [REQ-001](spec.md#req-001) | [REF-001](design.md#ref-001), [REF-002](design.md#ref-002) |
| WF-002 Decision Card {#wf-002} | one-decision mode | desktop+mobile web | [REQ-002](spec.md#req-002) | [REF-005](design.md#ref-005) |
| WF-003 Startup Board {#wf-003} | artifact board | desktop+mobile web | [REQ-003](spec.md#req-003) | [REF-001](design.md#ref-001) |
| WF-004 Document Workspace {#wf-004} | plan/deck writing | desktop+mobile web | [REQ-004](spec.md#req-004) | [REF-003](design.md#ref-003), [REF-004](design.md#ref-004) |
| WF-005 Product Planning Workspace {#wf-005} | PRD/screen planning | desktop+mobile web | [REQ-005](spec.md#req-005) | [REF-001](design.md#ref-001), [REF-002](design.md#ref-002) |
| WF-006 Handoff Panel {#wf-006} | send/copy state | desktop+mobile web | [REQ-006](spec.md#req-006) | [REF-008](design.md#ref-008) |
| WF-007 Design Provider Panel {#wf-007} | external design generation | desktop+mobile web | [REQ-008](spec.md#req-008) | [REF-GEN](design.md#external-design-provider-mcp) |
| WF-008 Artifact Dock {#wf-008} | right app/web previews | desktop+mobile web | [REQ-009](spec.md#req-009), [REQ-010](spec.md#req-010) | [REF-001](design.md#ref-001) |

## WF-001 Workspace Home {#wf-001}

Desktop:

```text
+--------------------------------------------------------------------------------+
| LEFT RAIL      | TOP: Startup package name                    Theme             |
| - Idea refine  |----------------------------------------------------------------|
| - Market       | [One raw idea input                                         ] |
| - Business     | [                                                         ]  |
| - PRD/Screen   | Focus stage [v]          Speed [v]                            |
| - App build    | Active decision card                                           |
| - Web build    | Lifecycle timeline and work board                              |
| - QA/Launch    | RIGHT DOCK: app preview iframe + web preview iframe             |
+--------------------------------------------------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Startup Studio        Theme       |
| Idea -> Build                     |
|----------------------------------|
| Raw idea                          |
| [                              ] |
| [                              ] |
| Current need [v]                  |
| Target output [v]                 |
| Active decision card              |
| Work board                        |
| App preview                       |
| Web preview                       |
+----------------------------------+
```

States:

| State | Trigger | UI response |
|---|---|---|
| empty | route load | sample prompt, no generated claims |
| idea entered | typing | preview updates with `needs evidence` labels |
| stage selected | lifecycle stage | update the active decision card |

## WF-002 Decision Card {#wf-002}

Desktop:

```text
+------------------------------------+
| ACTIVE DECISION                    |
| Stage label + proof status         |
|                                    |
| First customer question             |
| "Who spends time or money first?"  |
|                                    |
| Answer [ select or short input v ] |
|                                    |
| Why this matters                   |
| Affects: Board row STU-101         |
| Blocks: Product first screen       |
| [source] [cross-check] [next]      |
+------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Follow-up   Evidence             |
| First customer question           |
| [ answer v ]                      |
| Why this matters                  |
| Blocks: Product first screen      |
+----------------------------------+
```

Rules:

- The question card must be visually stronger than generated content.
- Only one primary question appears.
- Secondary proof chips are non-button status chips unless clickable behavior is
  fully defined.

## WF-003 Startup Board {#wf-003}

Desktop:

```text
+--------------------------------------------------------------------------------+
| STARTUP BOARD                                                                  |
| Stage tabs: Idea | Market | Plan | Product | Build | Deck                       |
|--------------------------------------------------------------------------------|
| STU-101  First customer problem        Now            needs founder answer      |
| STU-204  Business plan claim spine     Draft          needs evidence            |
| STU-318  PRD + workflow + screens      Blocked        missing first action      |
| STU-422  Buildable first version       Ready?         needs QA proof            |
+--------------------------------------------------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Startup Board                    |
| Idea Market Plan Product Build   |
|----------------------------------|
| STU-101                          |
| First customer problem           |
| Now / needs founder answer       |
|----------------------------------|
| STU-204                          |
| Business plan claim spine        |
| Draft / needs evidence           |
+----------------------------------+
```

Board row fields:

| Field | Example |
|---|---|
| ID | `STU-318` |
| Stage | `Product` |
| Status | `Blocked` |
| Evidence | `needs evidence` |
| Owner | `PRD Maker Architect` |
| Next action | `Define first user action` |

## WF-004 Document Workspace {#wf-004}

Desktop:

```text
+--------------------------------------------------------------------------------+
| DOCUMENT WORKSPACE                                                             |
| Research          | Draft                                      | Fact-check     |
|-------------------|--------------------------------------------|----------------|
| Competitors       | "For solo founders..."                    | needs source   |
| Sources needed    | Business plan outline                     | number missing |
| Audience [v]      | Section cards                             | claim status   |
|                   |                                            |                |
| Edit queue: shorter / investor-ready / support-program-ready / internal         |
+--------------------------------------------------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Document Workspace               |
| Audience [v]                      |
| Research gaps                     |
| Draft section                     |
| Fact-check queue                  |
| Edit mode chips                   |
+----------------------------------+
```

Document sections:

- Research: what is known and missing.
- Draft: current business-plan or deck copy.
- Fact-check: unsupported claims.
- Edit: rewrite intent.

## WF-005 Product Planning Workspace {#wf-005}

Desktop:

```text
+--------------------------------------------------------------------------------+
| PRODUCT PLANNING                                                               |
| PRD requirements     | User workflow             | Screen and wireframe        |
|----------------------|---------------------------|-----------------------------|
| REQ-001 Idea intake  | STEP-001 Open             | SCR-001 Workspace Home      |
| REQ-002 Question     | STEP-003 Answer question  | WF-001 / WF-002 preview     |
| REQ-005 PRD planning | STEP-006 Plan product     | First action: [required]    |
|                      |                           | Build gate status           |
+--------------------------------------------------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Product Planning                 |
| PRD                              |
| - REQ list                       |
| Workflow                         |
| - STEP list                      |
| Screens                          |
| - SCR list                       |
| Wireframe preview                |
| Build gate                       |
+----------------------------------+
```

Ready gate:

| Gate | Required |
|---|---|
| First customer | yes |
| First user action | yes |
| Success state | yes |
| Requirement links | `REQ -> FLOW -> SCR -> WF` |
| QA proof | planned before build complete |

## WF-006 Handoff Panel {#wf-006}

Desktop:

```text
+--------------------------------------------------------------------------------+
| COPY WORK BUNDLE                                                               |
| Summary: idea / customer / problem / current stage                              |
|--------------------------------------------------------------------------------|
| Packet preview                                                                 |
| - Requirements                                                                  |
| - Workflow                                                                      |
| - Screens                                                                       |
| - Wireframes                                                                    |
| - Evidence gaps                                                                 |
| - Build scope                                                                   |
| [Copy packet] [Open fallback panel]                                             |
| Safety: no local paths / no credentials / no transcript dump                    |
+--------------------------------------------------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Work Bundle                      |
| Summary                          |
| Packet preview                   |
| Safety checklist                 |
| [Copy packet]                    |
+----------------------------------+
```

Failure state:

| Trigger | UI response |
|---|---|
| Clipboard denied | Show packet panel with manual copy affordance |
| Missing first action | Block copy, focus product planning gate |
| Private data detected | Block copy and show safety warning |

## WF-007 Design Provider Panel {#wf-007}

Desktop:

```text
+--------------------------------------------------------------------------------+
| DESIGN PROVIDER                                                                |
| Provider: [ Stitch ] [ Claude Design ] [ Product Design fallback ]              |
| Session: authenticated / needs login                                            |
| [ Sign in / Reuse session ]                                                     |
|--------------------------------------------------------------------------------|
| PRD package checklist        | Generated design output                          |
| [x] spec.md                  | REF-GEN-001 Startup workspace                    |
| [x] ux-flow.md               | Desktop preview / Mobile preview                 |
| [x] ui-spec.md               | Screen map: SCR-001 -> provider screen A         |
| [x] wireframes.md            | QA target: screenshot + interaction states       |
| [x] design.md                |                                                   |
| [ Generate design ] [ Use fallback ]                                            |
+--------------------------------------------------------------------------------+
```

Mobile:

```text
+----------------------------------+
| Design Provider                  |
| Provider [v]                     |
| Session status                   |
| [Sign in / Reuse session]        |
| PRD checklist                    |
| Generated output                 |
| Screen map                       |
| [Generate design]                |
+----------------------------------+
```

Rules:

- Provider login is a user action, not a prompt asking for credentials.
- Generated output is source evidence and must become `REF-GEN-*`.
- If provider output cannot be inspected, implementation remains blocked.

## WF-008 Artifact Dock {#wf-008}

Desktop:

```text
+------------------------------------+
| RIGHT ARTIFACT DOCK                |
| Status: active lifecycle stage      |
|------------------------------------|
| App artifact                        |
| +-------------------------------+  |
| | app-preview.html iframe       |  |
| +-------------------------------+  |
|                                    |
| Web artifact                        |
| +-------------------------------+  |
| | web-preview.html iframe       |  |
| +-------------------------------+  |
+------------------------------------+
```

Mobile:

```text
+----------------------------------+
| App artifact                     |
| [app-preview.html]               |
|----------------------------------|
| Web artifact                     |
| [web-preview.html]               |
+----------------------------------+
```

## Component Inventory

| Component | Used by | Required states |
|---|---|---|
| WorkspaceShell | WF-001 through WF-006 | desktop, mobile, dark, light |
| IdeaInput | WF-001 | empty, dirty, validated |
| PrimaryActions | all | start, ask, view, send active states |
| QuestionCard | WF-002 | unanswered, answered, blocked |
| ArtifactBoard | WF-003 | empty, partial, ready |
| DocumentWorkspace | WF-004 | draft, needs evidence, edited |
| ProductPlanningWorkspace | WF-005 | incomplete links, ready gate |
| HandoffPanel | WF-006 | copied, fallback, blocked |
| DesignProviderPanel | WF-007 | no provider, auth needed, sending, output captured, blocked |

## Responsive Rules

| Breakpoint | Layout |
|---|---|
| `<640px` | single column, sticky action bar allowed, no horizontal board scroll unless rows remain readable |
| `640px-1024px` | rail collapses to top nav, inspector stacks below idea input |
| `>1024px` | three-zone layout: rail, canvas, inspector |
