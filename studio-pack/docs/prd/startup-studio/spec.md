---
id: startup-studio-prd-001
type: requirements
project: agentlas-startup-founder-studio
feature: startup-studio-web-surface
status: draft
version: 0.3.0
owner_role: PRD Maker Architect
depends_on: [../../design.md, ../../startup-gui-ux.md]
satisfies: []
linked_decisions: []
last_validated: 2026-06-19
---

# PRD — Startup Studio Web Surface

## Product Thesis

Startup Studio helps a founder move from a raw idea to a buildable startup
package in one focused workspace. The product must feel like a Korean Linear
for startup creation: a compact product board where ideas, evidence, PRD work,
documents, screens, build scope, and pitch claims stay linked.

## PRD Type

| Field | Value |
|---|---|
| Product surface | `web` |
| Agentic mode | `agentic-ai-native` |
| Builder target | `human-build + agentic-runtime` |
| Visible language | Korean-first when the founder writes Korean |
| Internal artifact IDs | English |

## Personas

| Persona | Need | Success signal |
|---|---|---|
| Solo founder | Turn a vague idea into a coherent first product plan | Has one target customer, one problem, one first screen, app/web previews, and a build checklist |
| Early startup CEO | Prepare market, plan, PRD, and deck material without losing the thread | Can see which claim needs evidence and which work item comes next |
| Builder agent | Receive a buildable package instead of a broad prompt | Gets requirements, workflow, screen spec, wireframes, and QA checks |

## Out Of Scope

- Public marketing homepage as the first screen.
- Direct payment, investor CRM, or account management.
- Full multi-user collaboration.
- Automatic publication to a public Hub.
- Replacing the six Startup HQ packages. This surface coordinates them; it does
  not expose their internals to the founder.

## Requirements

### REQ-001: Founder idea intake {#req-001}

**User Story:** As a founder, I want to paste a raw startup idea into one place,
so that the studio can shape it into a focused startup package.

**EARS:**
- WHEN the founder opens the Studio workspace, THE SYSTEM SHALL show one primary
  idea input above any generated artifact previews.
- WHEN the founder enters idea text, THE SYSTEM SHALL reflect that text in the
  artifact preview without requiring navigation.
- IF the idea input is empty, THEN THE SYSTEM SHALL show starter guidance and
  SHALL NOT create fake market or investor claims.

**Acceptance Criteria:**
- [ ] AC-001.1 — The first viewport contains one obvious idea input.
- [ ] AC-001.2 — Empty state copy asks for an idea, not an internal route.
- [ ] AC-001.3 — Generated preview labels unsupported claims as needing evidence.

**Links:** [ux-flow.md#flow-001](ux-flow.md#flow-001) ·
[ui-spec.md#scr-001](ui-spec.md#scr-001) ·
[wireframes.md#wf-001](wireframes.md#wf-001)

---

### REQ-002: One-question founder narrowing {#req-002}

**User Story:** As a founder, I want the product to ask only the next most useful
question, so that I do not feel buried under a long form.

**EARS:**
- WHEN the founder selects a lifecycle stage, THE SYSTEM SHALL present exactly
  one next decision question tied to the current artifact gap.
- WHEN the founder answers a question, THE SYSTEM SHALL update the work board,
  document preview, and next proof needed.
- IF a question blocks a required artifact, THEN THE SYSTEM SHALL show the
  blocked artifact and the accepting agent role.

**Acceptance Criteria:**
- [ ] AC-002.1 — Only one primary question is visually dominant at a time.
- [ ] AC-002.2 — The answer changes at least one artifact preview and one board row.
- [ ] AC-002.3 — Unanswered blockers become interview cards, not hidden TODOs.

**Links:** [ux-flow.md#flow-002](ux-flow.md#flow-002) ·
[ui-spec.md#scr-002](ui-spec.md#scr-002) ·
[wireframes.md#wf-002](wireframes.md#wf-002)

---

### REQ-003: Startup artifact board {#req-003}

**User Story:** As a founder, I want to see startup outputs as linked work items,
so that market, plan, PRD, screen, build, and deck work do not become separate
chat responses.

**EARS:**
- WHEN the founder reviews the lifecycle workbench, THE SYSTEM SHALL show a
  product board of startup artifacts grouped by stage: Idea, Market, Business,
  PRD/Screen, App Build, Web Build, QA/Launch.
- WHERE an artifact has enough input, THE SYSTEM SHALL show its current status,
  evidence state, owner, and next action.
- IF an artifact lacks evidence, THEN THE SYSTEM SHALL mark it as unsupported
  rather than presenting it as fact.

**Acceptance Criteria:**
- [ ] AC-003.1 — Board rows have stable IDs such as `STU-101`.
- [ ] AC-003.2 — Every row shows stage, status, evidence label, and next action.
- [ ] AC-003.3 — Board rows link to a document or screen preview.

**Links:** [ux-flow.md#flow-003](ux-flow.md#flow-003) ·
[ui-spec.md#scr-003](ui-spec.md#scr-003) ·
[wireframes.md#wf-003](wireframes.md#wf-003)

---

### REQ-004: Business document writer {#req-004}

**User Story:** As a founder, I want business-plan and documentation copy to be
drafted with source gaps visible, so that I can continue writing without
inventing evidence.

**EARS:**
- WHEN the current stage is Plan or Deck, THE SYSTEM SHALL show a document
  workspace with sections for research, draft, fact-check, and edit.
- WHEN a statement needs support, THE SYSTEM SHALL label it as `needs evidence`.
- IF the founder changes the audience, THEN THE SYSTEM SHALL adapt document
  emphasis without erasing prior idea context.

**Acceptance Criteria:**
- [ ] AC-004.1 — Document preview separates claim, evidence, and next question.
- [ ] AC-004.2 — Audience changes alter copy emphasis.
- [ ] AC-004.3 — Unsupported slide or plan claims are never shown as verified.

**Links:** [ux-flow.md#flow-004](ux-flow.md#flow-004) ·
[ui-spec.md#scr-004](ui-spec.md#scr-004) ·
[wireframes.md#wf-004](wireframes.md#wf-004)

---

### REQ-005: PRD and screen planning {#req-005}

**User Story:** As a founder, I want PRD work to become screens and build tasks,
so that the next agent can implement without guessing.

**EARS:**
- WHEN the founder selects Product as the current need, THE SYSTEM SHALL show
  PRD scope, user workflow, screen list, and wireframe preview together.
- WHEN a requirement is added, THE SYSTEM SHALL map it to at least one screen,
  one flow node, and one acceptance check.
- IF no first user action is known, THEN THE SYSTEM SHALL block build handoff and
  request that action.

**Acceptance Criteria:**
- [ ] AC-005.1 — Product view includes PRD, workflow, screen design, and wireframe areas.
- [ ] AC-005.2 — Each requirement has links to `SCR-*`, `FLOW-*`, and `WF-*`.
- [ ] AC-005.3 — Build handoff is blocked until first action and success state exist.

**Links:** [ux-flow.md#flow-005](ux-flow.md#flow-005) ·
[ui-spec.md#scr-005](ui-spec.md#scr-005) ·
[wireframes.md#wf-005](wireframes.md#wf-005)

---

### REQ-006: Build handoff packet {#req-006}

**User Story:** As a builder agent, I want the founder's current package copied
as a structured handoff, so that implementation starts from the same decisions
the founder saw.

**EARS:**
- WHEN the founder copies the current work bundle, THE SYSTEM SHALL assemble the
  current idea, customer, problem, evidence gaps, board rows, screen list, app
  build scope, web build scope, and QA scope into one structured handoff packet.
- IF browser clipboard access is unavailable, THEN THE SYSTEM SHALL show the
  packet in a copyable panel.
- THE SYSTEM SHALL NOT include local paths, credentials, private account data,
  or hidden memory content in the packet.

**Acceptance Criteria:**
- [ ] AC-006.1 — The copy action produces a deterministic packet for the current state.
- [ ] AC-006.2 — Clipboard failure has an in-app fallback.
- [ ] AC-006.3 — Public safety scan finds no private paths or credentials.

**Links:** [ux-flow.md#flow-006](ux-flow.md#flow-006) ·
[ui-spec.md#scr-006](ui-spec.md#scr-006) ·
[wireframes.md#wf-006](wireframes.md#wf-006)

---

### REQ-007: Durable project memory {#req-007}

**User Story:** As a founder, I want the studio to preserve approved concept
decisions, so that future sessions continue from the same product direction.

**EARS:**
- WHEN a visual direction, audience, or artifact decision is accepted, THE
  SYSTEM SHALL write a memory candidate to the project memory ticket stream.
- WHEN the memory curator accepts a ticket, THE SYSTEM SHALL merge it into
  durable project design memory.
- THE SYSTEM SHALL NOT store raw transcripts, credentials, private account data,
  or unrelated local runtime details.

**Acceptance Criteria:**
- [ ] AC-007.1 — Durable memory candidates use `.agentlas/memory-tickets.jsonl`.
- [ ] AC-007.2 — Accepted design decisions appear in `.agentlas/design-memory.md`.
- [ ] AC-007.3 — Rejected or superseded directions remain auditable.

**Links:** [ux-flow.md#flow-007](ux-flow.md#flow-007) ·
[design.md#memory-rules](design.md#memory-rules)

---

### REQ-008: External design provider handoff {#req-008}

**User Story:** As a builder agent, I want to send the complete PRD package to
Stitch or Claude Design before implementation, so that the UI is based on a real
design target instead of improvised styling.

**EARS:**
- WHEN a UI rebuild requires high-fidelity design, THE SYSTEM SHALL select a
  design provider from `.agentlas/design-provider-mcp.json`.
- WHEN the selected provider requires authentication, THE SYSTEM SHALL expose a
  one-button login action and SHALL reuse an existing provider session when
  available.
- WHEN provider output is received, THE SYSTEM SHALL record it as `REF-GEN-*`
  and map every generated screen to `REQ-*`, `FLOW-*`, `SCR-*`, and `WF-*`.
- IF provider login, provider output capture, or visual QA is unavailable, THEN
  THE SYSTEM SHALL block UI implementation or record an explicit fallback.

**Acceptance Criteria:**
- [ ] AC-008.1 — Build plan names the provider decision: used, skipped, blocked,
  or unavailable.
- [ ] AC-008.2 — Build plan records auth/session status without exposing
  credentials or raw cookies.
- [ ] AC-008.3 — Provider screens are mapped to PRD, workflow, screen, and
  wireframe anchors before frontend tasks are created.
- [ ] AC-008.4 — Generated design output has desktop and mobile QA evidence.

**Links:** [ux-flow.md#flow-008](ux-flow.md#flow-008) ·
[design.md#external-design-provider-mcp](design.md#external-design-provider-mcp) ·
[ui-spec.md#scr-007](ui-spec.md#scr-007) ·
[wireframes.md#wf-007](wireframes.md#wf-007)

---

### REQ-009: Right app and web artifact dock {#req-009}

**User Story:** As a founder, I want the Startup webapp to show actual app and
web previews on the right, so that product creation feels real and inspectable.

**EARS:**
- WHEN the web surface loads, THE SYSTEM SHALL embed a local app artifact preview
  and a local web artifact preview in the right dock.
- WHEN the founder changes lifecycle stage, THE SYSTEM SHALL update the artifact
  statuses to reflect the active stage.
- IF either artifact preview is missing, THEN THE SYSTEM SHALL fail package
  verification.

**Acceptance Criteria:**
- [ ] AC-009.1 — `webapp/index.html` embeds `webapp/artifacts/app-preview.html`.
- [ ] AC-009.2 — `webapp/index.html` embeds `webapp/artifacts/web-preview.html`.
- [ ] AC-009.3 — Desktop and mobile browser QA confirm both previews are visible.

**Links:** [ux-flow.md#flow-009](ux-flow.md#flow-009) ·
[ui-spec.md#scr-008](ui-spec.md#scr-008) ·
[wireframes.md#wf-008](wireframes.md#wf-008)

---

### REQ-010: App and web build plugin lanes {#req-010}

**User Story:** As a builder agent, I want app and web build lanes to name their
required tools, so that implementation and QA do not stop at PRD text.

**EARS:**
- WHEN the active stage is App Build, THE SYSTEM SHALL include iOS App Intents
  planning and Android emulator QA in the build handoff when applicable.
- WHEN the active stage is Web Build, THE SYSTEM SHALL include a real preview
  artifact and browser QA.
- IF an app or web lane cannot produce a visible artifact, THEN THE SYSTEM SHALL
  mark that lane blocked.

**Acceptance Criteria:**
- [ ] AC-010.1 — Product Development HQ names the iOS App Intents skill.
- [ ] AC-010.2 — Product Development HQ names the Android test plugin.
- [ ] AC-010.3 — Product Development HQ names the web build and browser QA path.

**Links:** [ux-flow.md#flow-010](ux-flow.md#flow-010) ·
[ui-spec.md#scr-008](ui-spec.md#scr-008) ·
[wireframes.md#wf-008](wireframes.md#wf-008)

## Risks

### RISK-001: Fake productivity dashboard {#risk-001}

The UI can look busy without actually reducing founder uncertainty.
Mitigation: every panel must answer one of three questions: who is the first
customer, what artifact changed, or what proof is missing.

### RISK-002: Reference over-copying {#risk-002}

The product may copy Linear or Liner too literally.
Mitigation: references are adaptation signals only; exact brand, assets, and
copy are disallowed in [design.md](design.md).

### RISK-003: Internal machinery leakage {#risk-003}

Founder-facing UI can expose HQ, routing, manifest, backend, token, or engine
terms.
Mitigation: visible-copy scan remains part of package verification.
