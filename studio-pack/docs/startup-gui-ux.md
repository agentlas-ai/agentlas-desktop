# Startup GUI UX Map

This document describes the beginner-facing GUI wrapper for Startup Founder Studio.
It is developer-facing and intentionally separate from the visible UI copy.

The rebuild contract for this surface now lives in
[`docs/prd/startup-studio/`](prd/startup-studio/). Use that PRD package for the
user workflow, PRD requirements, screen design, and wireframes before changing
the web UI again.

## UX Principle

The user should not choose an internal department, backend engine, manifest, or routing card.
They should move through a visible startup lifecycle:

1. 아이디어 구체화
2. 시장 검증
3. 사업 설계
4. PRD/화면 설계
5. 앱 제작
6. 웹 제작
7. QA/출시

This follows progressive disclosure while making the product feel like an
actual founder workflow, not a generic prompt box.

## Visible Choice To Internal Route

| Visible stage | Internal package | Main output |
|---|---|---|
| 아이디어 구체화 | `Startup/01-idea-foundry-hq` | Business Idea Engine pressure test, first customer, problem, verdict, fast validation plan |
| 시장 검증 | `Startup/02-market-intelligence-hq` | Market scan, competitor comparison, persona-swarm critique |
| 사업 설계 | `Startup/03-business-plan-hq` | Business plan outline, assumptions, revenue model |
| PRD/화면 설계 | `Startup/04-product-planning-prd-maker` | PRD, user flow, screen spec, wireframe notes, interview cards |
| 앱 제작 | `Startup/05-product-development-hq` | iOS App Intents plan, Android emulator QA path, app artifact preview |
| 웹 제작 | `Startup/05-product-development-hq` | Web route/build scope, browser QA path, web artifact preview |
| QA/출시 | `Startup/05-product-development-hq` + `Startup/06-pitch-deck-ir-hq` | Release checks, visual evidence, deck/IR claim readiness |

## Right Artifact Dock

The Startup webapp must show actual renderable artifacts on the right side:

- `webapp/artifacts/app-preview.html`
- `webapp/artifacts/web-preview.html`

These are not decorative placeholders. They are local preview surfaces that make
app and web build work visible inside the Startup control surface.

## Launch Contract

- Local GUI file: `webapp/index.html`
- Launcher: `scripts/open-studio-gui.py`
- Preferred local command: `/startup`
- Desired network phrase: `/Hephaestus-network startup`

Current Hephaestus runtime behavior is split:

- Local-first routing: `hephaestus route "startup" --no-hub` can select this private package after `network add-source`.
- Hub-only network surface: `hephaestus hephaestus-network "startup"` normally skips local cards and searches the public Hub only.
- Explicit local GUI shortcut: this package opts in with `network_shortcut.enabled=true`, so a Hephaestus runtime that supports local GUI shortcuts can open the private GUI for exact phrases such as `startup`.

Without that runtime support, a literal `/Hephaestus-network startup` launch still requires Hub publication or a deliberate Hephaestus runtime policy change. The repo should not embed local machine paths or credentials.
