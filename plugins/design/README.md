# Design Plugin (`@design`)

Agentlas Plugin v2 (`agentlas.plugin/v2`) package for visual design exploration, interactive prototyping, UI motion engineering, UX flow auditing, design system integration, and design review graded against Apple's Human Interface Guidelines.

## 1. Overview
- **Slug**: `design`
- **Schema**: `agentlas.plugin/v2`
- **Invocation**: Explicit `@design` mention or implicit router matching (`implicit: "router"`)

## 2. Core Visual-First Pipeline
```
0. Review ($hig-review)         → Grade an existing UI against Apple HIG before changing it
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
| `$hig-review` | Grades a UI against Apple's Human Interface Guidelines — accessibility, platform conventions, layout, materials, states, writing — citing the guideline behind each finding |
| `$image-to-code` | Implements the pinned target design into high-fidelity, interactive web/mobile prototypes |
| `$motion` | Injects high-craft UI motion, spring physics, and micro-interactions ($motion-system) |
| `$url-to-code` | Clones a live website URL into a standalone, runnable interactive prototype |
| `$research` | Discovers user friction and pain points from community and feedback sources |
| `$design-qa` | Side-by-side visual QA gate comparing coded prototypes against pinned targets |
| `$share` | Builds and deploys prototypes to generate shareable live URLs |
| `$seed-design` | Official SEED Design system documentation lookup and Doctor diagnostics |
| `$app-context` | Creative production board and canvas asset generation |

## 4. Apple HIG grounding

Design judgment in this plugin is backed by Apple's Human Interface Guidelines rather than by
recall. Four documents are committed here and one is generated:

| File | Role |
|---|---|
| `references/apple-hig/hig-lookup.md` | Routing table over all 171 guideline pages (generated) |
| `references/apple-hig/hig-checklist.md` | The pass a design has to survive, in priority order |
| `references/apple-hig/hig-review-protocol.md` | Review process, severity scale, report shape |
| `references/apple-hig/hig-platform-translation.md` | Apple vocabulary → web / Electron / RN / Flutter, and which rules do not transfer |
| `references/apple-hig/liquid-glass.md` | Materials and Liquid Glass, including off-platform implementation |

Apple's own page text is **not** committed — it is Apple's copyright and this repository is
public. It lives in the git-ignored cache `references/apple-hig/.cache/pages/`, which the
packager skips (a leading dot excludes it from `walkFiles`, `copy-builtin-plugins`, and the
integrity manifest). Refill or refresh it with:

```bash
node scripts/fetch-apple-hig.mjs
```

Without the cache, skills fetch a page on demand from
`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`.
See `references/apple-hig/hig-sources.md`.

## 5. Runtime & Requirements
- **Permissions**: `fileWrite: "project-only"`, `network: "ask"`, `shell: "deny"`
- **Requires**: `tools: ["browser"]`, `prereq: ["node"]`
- **Supported Platforms**: `darwin` (macOS), `win32` (Windows), `linux` (Linux)
