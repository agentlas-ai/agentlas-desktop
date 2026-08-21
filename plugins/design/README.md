# Design Plugin (`@design`)

Agentlas Plugin v2 (`agentlas.plugin/v2`) package for visual design exploration, interactive prototyping, UI motion engineering, UX flow auditing, and design system integration.

## 1. Overview
- **Slug**: `design`
- **Schema**: `agentlas.plugin/v2`
- **Invocation**: Explicit `@design` mention or implicit router matching (`implicit: "router"`)

## 2. Core Visual-First Pipeline
```
1. Ideate ($ideate)             → Generate 3 distinct visual concepts with Image Gen
2. Pin Target (assets/)         → Confirm user selection & save as assets/target-design.png
3. Build 1:1 ($image-to-code)   → Continuously reference pinned target to build interactive code
4. Motion ($motion)             → Inject tactile spring physics & 60fps micro-interactions
5. Visual QA ($design-qa)       → Side-by-side comparison loop until pixel-faithful alignment
```

## 3. Workflows & Capabilities
| Skill | Description |
|---|---|
| `$index` | **Router** — Evaluates incoming requests and activates the appropriate focused skill |
| `$get-context` | Resolves the minimum required design brief (target & user outcome) quickly |
| `$user-context` | Manages plugin onboarding, saved brand preferences, and design context |
| `$ideate` | Generates 3 independent visual design concepts and pins the selected target |
| `$audit` | Captures and reviews product journeys with step-by-step screenshot evidence for UX and accessibility |
| `$image-to-code` | Implements the pinned target design into high-fidelity, interactive web/mobile prototypes |
| `$motion` | Injects high-craft UI motion, spring physics, and micro-interactions ($motion-system) |
| `$url-to-code` | Clones a live website URL into a standalone, runnable interactive prototype |
| `$research` | Discovers user friction and pain points from community and feedback sources |
| `$design-qa` | Side-by-side visual QA gate comparing coded prototypes against pinned targets |
| `$share` | Builds and deploys prototypes to generate shareable live URLs |
| `$seed-design` | Official SEED Design system documentation lookup and Doctor diagnostics |
| `$app-context` | Creative production board and canvas asset generation |

## 4. Runtime & Requirements
- **Permissions**: `fileWrite: "project-only"`, `network: "ask"`, `shell: "deny"`
- **Requires**: `tools: ["browser"]`, `prereq: ["node"]`
- **Supported Platforms**: `darwin` (macOS), `win32` (Windows), `linux` (Linux)
