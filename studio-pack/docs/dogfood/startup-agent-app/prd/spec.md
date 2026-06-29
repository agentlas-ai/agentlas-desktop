# PRD: Startup Package Agent App

## Goal

Help a founder move from raw idea to build-ready startup package without losing
context across idea, market, business, PRD, design, app, web, and launch work.

## Requirements

### REQ-DOG-001 Lifecycle Workflow

The first screen must show the lifecycle:

`아이디어 구체화 -> 시장 검증 -> 사업 설계 -> PRD/화면 설계 -> 앱 제작 -> 웹 제작 -> QA/출시`

Acceptance:

- Stage buttons are visible in the GUI.
- Stage state changes update the decision card and work board.
- The old prompt-button model is not the primary UX.

### REQ-DOG-002 Business Idea Engine

The idea stage must use the uploaded `business-idea-engine` skill before normal
Idea Foundry output.

Acceptance:

- The skill is bundled in the Idea Foundry folder.
- The manifest references it.
- The output includes Korea saturation, moat, risk, and verdict.

### REQ-DOG-003 Google Stitch Handoff

The PRD package must be ready to send to Google Stitch.

Acceptance:

- A Stitch prompt exists.
- The package lists account/API-key prerequisites.
- Generated Stitch output becomes a `REF-GEN-*` design source before coding.
- `REF-GEN-STITCH-001-v2` is stored under `stitch/generated/` with screenshot
  and HTML evidence.

### REQ-DOG-004 App And Web Artifact Dock

The Startup webapp must show both app and web previews on the right side.

Acceptance:

- `app-preview.html` is embedded.
- `web-preview.html` is embedded.
- Desktop and mobile QA confirm both iframes exist and no horizontal overflow.

### REQ-DOG-005 Hephaestus Network Monitoring

Dogfood runs must check Hephaestus auth, network status, and benchmark surface
without exposing credentials or private paths.

Acceptance:

- A reusable check script exists.
- Output redacts local paths.
- Issues are recorded in the QA/network log.

### REQ-DOG-006 Sellable Founder Package

The product must expose a paid package choice inside the working app, not only
inside the business-plan document.

Acceptance:

- The webapp shows Starter, Studio, and Concierge package choices.
- Choosing a package updates the visible package status.
- The Founder Packet records the selected package, price hypothesis, buyer fit,
  and next paid-pilot action.
- The package UI is tested in the browser without creating a real payment.

### REQ-DOG-007 Paid Pilot Tracker

The product must help the seller run the first three paid pilot conversations
without pretending that revenue is already validated.

Acceptance:

- The webapp shows three anonymous pilot candidates.
- The seller can select a pilot candidate, objection, and next action.
- The seller can update each pilot's conversation status.
- The UI shows conversation progress such as `2/3 대화 기록`.
- The Founder Packet records the selected pilot, intended package, objection,
  conversation status, progress, paid count, and next action.
- The UI states that revenue is not proven until three real paid pilots are
  recorded outside the demo.
