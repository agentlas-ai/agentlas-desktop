# Startup Studio PRD Package

Status: draft for rebuild
Owner agent: `Startup/04-product-planning-prd-maker/agents/70-architect`
Last updated: 2026-06-19

This folder is the PRD Maker handoff for the Startup Founder Studio web surface.
It replaces ad hoc UI iteration with a traceable product contract.

## Artifact Index

| Artifact | Purpose |
|---|---|
| [spec.md](spec.md) | Product requirements, EARS clauses, acceptance criteria, scope boundaries |
| [ux-flow.md](ux-flow.md) | Founder journey, user workflow, service blueprint, state transitions |
| [ui-spec.md](ui-spec.md) | Screen design, routes, components, states, copy, accessibility |
| [wireframes.md](wireframes.md) | Desktop and mobile low-fidelity layouts linked to requirements |
| [design.md](design.md) | Visual direction, source map, component rules, build handoff constraints |

## Rebuild Principle

Startup Studio is not a chatbot, not a deck generator, and not a generic
dashboard. It is a founder operating board:

1. Capture one raw idea.
2. Force one customer/problem decision.
3. Turn that decision into evidence-backed startup artifacts.
4. Send the PRD package to a design provider when high-fidelity UI is needed.
5. Show the artifacts as linked product work, not disconnected documents.
6. Hand off a buildable first version with no hidden internal routing exposed.

## Hard Rules For The Next Build

- The visible workflow must be lifecycle-first: `아이디어 구체화 -> 시장 검증 ->
  사업 설계 -> PRD/화면 설계 -> 앱 제작 -> 웹 제작 -> QA/출시`.
- Do not ship the legacy four-button prompt UX.
- The right side must embed actual app and web artifact previews, not static
  explanation cards.
- Do not expose internal HQ, routing, manifest, backend, token, or engine words in
  founder-facing copy.
- Do not make a marketing landing page as the first screen.
- Do not copy Linear, Liner, Sudowrite, GPAI, Sinas, or Manyfast assets or exact
  layouts. Use them only as source signals documented in [design.md](design.md).
- Every UI-bearing requirement must map to at least one screen, flow node, and
  wireframe.
- When Stitch or Claude Design is selected, require one-button login/session
  reuse and a captured provider output before implementation.
- App build must include iOS App Intents planning and Android emulator QA when
  those targets are in scope.
- Web build must include a real preview artifact and browser inspection.
