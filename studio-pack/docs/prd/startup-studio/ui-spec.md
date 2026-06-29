---
id: startup-studio-ui-spec-001
type: ui-spec
project: agentlas-startup-founder-studio
feature: startup-studio-web-surface
status: draft
version: 0.3.0
owner_role: PRD Maker Architect
depends_on: [spec.md, design.md]
satisfies: [REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-009, REQ-010]
last_validated: 2026-06-19
---

# UI Spec — Startup Studio Web Surface

## Screen Index

| Screen | Route | Satisfies | Wireframe |
|---|---|---|---|
| SCR-001 Workspace Home {#scr-001} | `/webapp/index.html` | [REQ-001](spec.md#req-001) | [WF-001](wireframes.md#wf-001) |
| SCR-002 Decision Card {#scr-002} | same route, decision state | [REQ-002](spec.md#req-002) | [WF-002](wireframes.md#wf-002) |
| SCR-003 Startup Board {#scr-003} | same route, board state | [REQ-003](spec.md#req-003) | [WF-003](wireframes.md#wf-003) |
| SCR-004 Document Workspace {#scr-004} | same route, document state | [REQ-004](spec.md#req-004) | [WF-004](wireframes.md#wf-004) |
| SCR-005 Product Planning Workspace {#scr-005} | same route, product state | [REQ-005](spec.md#req-005) | [WF-005](wireframes.md#wf-005) |
| SCR-006 Handoff Panel {#scr-006} | same route, copy state | [REQ-006](spec.md#req-006) | [WF-006](wireframes.md#wf-006) |
| SCR-007 Design Provider Panel {#scr-007} | same route, provider state | [REQ-008](spec.md#req-008) | [WF-007](wireframes.md#wf-007) |
| SCR-008 Artifact Dock {#scr-008} | same route, right dock | [REQ-009](spec.md#req-009), [REQ-010](spec.md#req-010) | [WF-008](wireframes.md#wf-008) |

## Global Layout

The screen has three stable zones on desktop:

1. **Left rail:** workspace identity, current startup package, stage progress.
2. **Center canvas:** idea intake, active artifact, board/document/product view.
3. **Right artifact dock:** one actual app preview and one actual web preview.

On mobile, these zones stack as:

1. Compact header.
2. Idea intake.
3. Current decision card.
4. Board/document/product sections.
5. App artifact preview.
6. Web artifact preview.
7. Handoff panel.

## SCR-001: Workspace Home {#scr-001}

- **Purpose:** Get a founder from blank page to first structured idea.
- **Primary components:** `WorkspaceShell`, `IdeaInput`, `LifecycleStageList`,
  `DecisionCard`, `ArtifactDock`.
- **Primary navigation:** lifecycle stage selection.
- **Empty state:** Example idea and promise: "아이디어를 쓰면 고객, 문제, 문서, 화면,
  빌드 범위를 연결합니다."
- **Accessibility:** Idea input has a visible label; stage controls are keyboard
  reachable; empty-state helper is not placeholder-only.

**States:**

| State | Trigger | UI response |
|---|---|---|
| empty | first load | starter prompt, no fake artifact claims |
| dirty | founder types | preview updates, evidence labels remain pending |
| stage selected | lifecycle stage click | decision card updates to the current stage |

## SCR-002: Decision Card {#scr-002}

- **Purpose:** Present one decision that reduces the next artifact gap.
- **Primary components:** `QuestionCard`, `AnswerControl`, `WhyThisMatters`,
  `EvidenceStrip`, `BlockedArtifactBadge`.
- **Primary action:** answer the current stage question.
- **Rule:** One dominant question. Secondary suggestions are chips, not competing
  cards.
- **Accessibility:** Question heading is announced; answer control has label;
  answer changes update a polite live region.

**Question model:**

| Field | Description |
|---|---|
| `question_id` | stable `CARD-*` or `Q-*` |
| `anchor_ref` | requirement, flow step, screen, or wireframe being unblocked |
| `answer_type` | select, short text, evidence URL, file note |
| `blocked_artifact` | artifact that cannot proceed without the answer |

## SCR-003: Startup Board {#scr-003}

- **Purpose:** Show startup artifacts as linked work items.
- **Primary components:** `ArtifactBoard`, `StageColumn`, `IssueRow`,
  `EvidenceBadge`, `NextAction`.
- **Required stages:** Idea, Market, Business, PRD/Screen, App Build, Web Build,
  QA/Launch.
- **Row fields:** ID, title, stage, status, owner, evidence state, next action.

**Board statuses:**

| Status | Meaning |
|---|---|
| `Now` | current founder focus |
| `Draft` | generated but needs founder review |
| `Needs Evidence` | unsupported claim or missing source |
| `Blocked` | needs a question answered |
| `Ready` | can move into handoff packet |

## SCR-004: Document Workspace {#scr-004}

- **Purpose:** Draft business-plan and deck copy without hiding source gaps.
- **Primary components:** `DocumentOutline`, `ClaimCard`, `EvidenceNeeded`,
  `DraftEditor`, `RevisionQueue`.
- **Borrowed source signal:** Liner Write's research/draft/fact-check/edit flow;
  Sudowrite's draft momentum.
- **Rule:** Every strong claim has a source state: `verified`, `needs evidence`,
  or `founder assertion`.

**Sections:**

| Section | Content |
|---|---|
| Research | source list, search gaps, competitor notes |
| Draft | founder-facing business-plan or deck copy |
| Fact-check | unsupported claims and missing numbers |
| Edit | rewrite focus: shorter, investor-ready, support-program-ready, internal |

## SCR-005: Product Planning Workspace {#scr-005}

- **Purpose:** Turn PRD into user workflow, screens, and wireframes.
- **Primary components:** `RequirementList`, `FlowPreview`, `ScreenList`,
  `WireframePreview`, `BuildReadinessGate`.
- **Borrowed source signal:** Linear's issue/detail density and roadmap language.
- **Rule:** A requirement without a flow, screen, and wireframe link is not ready.

**Required panes:**

| Pane | Minimum content |
|---|---|
| PRD | `REQ-*`, user story, EARS clause, acceptance criteria |
| Workflow | `FLOW-*`, `STEP-*`, state transition |
| Screen design | `SCR-*`, components, states, copy keys |
| Wireframe | `WF-*`, desktop/mobile layout, empty/loading/error states |
| Build gate | first action, saved data, QA proof, out-of-scope list |

## SCR-006: Handoff Panel {#scr-006}

- **Purpose:** Make work-bundle copy visible and reversible.
- **Primary components:** `HandoffSummary`, `PacketPreview`, `CopyStatus`,
  `SafetyChecklist`.
- **Primary action:** copy current work bundle.
- **Clipboard fallback:** If copy fails, open a panel containing the packet.
- **Safety:** Strip private paths, credentials, raw logs, and transcript dumps.

## SCR-007: Design Provider Panel {#scr-007}

- **Purpose:** Make external design generation explicit and recoverable.
- **Primary components:** `ProviderSelector`, `ProviderLoginAction`,
  `SessionStatus`, `PRDPackageChecklist`, `ProviderOutputMap`,
  `GeneratedDesignPreview`.
- **Providers:** Stitch, Claude Design, Product Design fallback, Creative
  Production fallback.
- **Primary action:** `Generate design`.
- **Login action:** One visible button per selected provider. The button opens
  provider auth through the host CLI/app and reuses the provider session after
  success.
- **Rule:** Do not create frontend implementation tasks until provider output is
  captured as `REF-GEN-*` or the fallback is explicitly approved.

**States:**

| State | Trigger | UI response |
|---|---|---|
| no provider | product rebuild starts | provider choices visible |
| auth needed | provider selected without session | one-button login action |
| sending | PRD package submitted | progress and checklist |
| output captured | provider returns design | preview, source-map ID, screen map |
| blocked | auth or output fails | fallback options and exact blocker |

## SCR-008: Artifact Dock {#scr-008}

- **Purpose:** Show that app and web build stages produce actual previewable
  surfaces.
- **Primary components:** `ArtifactDock`, `AppArtifactFrame`,
  `WebArtifactFrame`, `ArtifactStatus`.
- **App preview source:** `webapp/artifacts/app-preview.html`.
- **Web preview source:** `webapp/artifacts/web-preview.html`.
- **Rule:** The dock is part of the primary product surface, not an optional
  decorative sidebar.

**States:**

| State | Trigger | UI response |
|---|---|---|
| idea | first load | app and web previews show planning status |
| app build | App stage selected | app status names the app build lane |
| web build | Web stage selected | web status names the web build lane |
| QA | QA/Launch stage selected | both previews show QA status |

## Copy Rules

| UI area | Use | Avoid |
|---|---|---|
| Founder actions | 아이디어 구체화, 시장 검증, 사업 설계, PRD/화면 설계, 앱 제작, 웹 제작, QA/출시 | route, manifest, backend, engine, token |
| Artifact board | 작업, 근거, 다음 행동, 준비됨 | internal HQ names |
| Document workspace | 조사, 초안, 근거 확인, 편집 | fake "verified" language |
| Product workspace | 요구사항, 흐름, 화면, 와이어프레임 | abstract planning-only copy |
| Build handoff | 첫 화면, 저장 범위, 확인 방법 | magic deploy promises |
| Design provider | 디자인 생성, 로그인, 세션, 결과 확인 | provider credentials, raw cookie, hidden auth paths |

## Accessibility Requirements

- WCAG AA contrast for text and controls.
- Keyboard order follows visual order.
- The active question and handoff result use `aria-live="polite"`.
- No control relies on color alone for state.
- Mobile tap targets are at least 44px high.
