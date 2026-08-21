---
name: index
description: "Routes design requests to the appropriate workflow skill for visual ideation (3-option generation), target design pinning, side-by-side prototype building, UI motion/animations, URL/image cloning, UX flow audits, and design QA."
---

# Skill Purpose
The router does not perform design tasks directly — it identifies the user's intent and selects the optimal design workflow skill.

# Plugin Purpose
The Design plugin bridges product ideas and working software through a streamlined visual-first pipeline:
`Ideate (3 distinct concepts) → Pin Target Design (assets/target-design.png) → 1:1 Side-by-Side Build ($image-to-code) → Motion & Micro-Interactions ($motion) → Visual QA Gate ($design-qa)`.

## Routing
- Setup, onboarding, or context recall requests → `$user-context`
- New app/prototype/UI concept without visual targets → `$get-context` → `$ideate`
- Visual concept exploration and 3-option ideation → `$ideate`
- Product flow, journey, funnel, onboarding, or accessibility audits → `$audit`
- Recreating/cloning a live URL into an interactive prototype → `$url-to-code`
- Translating a pinned visual mock/image into working code (1:1 side-by-side) → `$image-to-code`
- UI motion, spring physics, tactile micro-interactions, and animations → `$motion`
- Researching user pain points, UX friction, and product feedback → `$research`
- Comparing rendered prototypes against pinned target designs (Side-by-Side QA) → `$design-qa`
- Deploying and sharing prototypes via live links → `$share`
- SEED Design system specifications, components, and Doctor diagnostics → `$seed-design`
- Creative production board generation and asset exploration → `$app-context`

If the user explicitly names a specific skill, load and execute that exact skill directly without substituting it.

## Tools
- Logged-in web flows and CDP-based browser automation → `@agentlas-browser`
- Public page capture and browser testing → `@playwright`
- Desktop application and OS-level operations → `@computer-use`

If a required tool is not available in the environment, report the blocker clearly and stop. Do not pretend to execute tasks with missing tools.

## Critical Overrides
- Follow `$critical-overrides`.
- Follow `$communication-protocol` for concise, effective communication.
- Follow `$motion-system` for interaction design and UI physics.
