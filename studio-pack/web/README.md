# Startup Studio — Web Surface

A **Plane-grade founder operating board** that turns the six Startup HQ agents'
output into a dense, beautiful, wow-moment UI: a three-pane workspace (rail →
board → inspector), an animated **agent-run reveal**, evidence-labeled work
items, and a per-stage **decision card**.

This is the redesigned front end for `agentlas-startup-founder-studio`. It
replaces the old single-file `webapp/` mock.

## Production readiness

| Area | Status |
|---|---|
| Build / typecheck | `npm run build` (tsc strict + Vite) — clean |
| Lint / test / CI gate | `npm run check` = `tsc -b --noEmit && eslint . && vitest run` — clean, **6 tests pass** |
| Crash safety | App-level `ErrorBoundary` → recoverable screen, never a blank page |
| Persistence | Per-domain journey (run state, answers, current stage) saved to `localStorage` — a reload keeps progress |
| Accessibility | `prefers-reduced-motion` honored, visible focus rings, `role="dialog"`/`aria-modal` on overlays, labelled controls |
| Mobile | Sidebar drawer + **agent-chat bottom-sheet** (FAB) — no desktop-only dead-ends |
| PWA / SEO | `manifest.webmanifest`, theme-color, apple-touch, OG/Twitter meta, installable |
| i18n | EN (source) + KO, 3 domains — `npm run check` validates content integrity |

### Connecting the real agents (Hephaestus network)

The six HQ agents are **real and already on the Agentlas Hephaestus network** —
this is not a mocked backend:

- The orchestrator `agents/00-startup-orchestrator/agent.md` routes to the six
  real HQ packages (`Startup/01..06`).
- The package is registered on the network as `private/agentlas-startup-founder-studio`
  (`.agentlas/routing-card.json`, alias `"startup"`). `hep-network startup`
  resolves to it.
- Verified 2026-06-20 with `scripts/hephaestus-network-check.py`: runner
  authenticated to `agentlas.cloud`, network initialized (111 routing-ready
  cards), and the **startup route benchmark passes 12/12 (top-1 = 1.0)** — every
  EN/KO trigger routes to this package.

So the agents run through the **Hephaestus runtime** (it executes the agent.md
specs with an LLM). What this web app currently does is replay seeded
`StudioContent` for an offline, instant demo. The remaining integration is a thin
**runtime bridge**, not a new backend:

1. Stand up a small local endpoint (or Vite middleware / Claude Agent SDK host)
   that invokes the already-authenticated Hephaestus runner for a stage —
   conceptually `hephaestus run` of the matching HQ — and returns the artifact.
2. Give each HQ agent a `StageData` output contract (the shape in
   `src/data/types.ts`) so its output drops straight into the UI.
3. Point `runAgent(stage)` in `src/store/studio-context.tsx` at that endpoint and
   stream — **no view changes needed**.

Auth is already done (the runner is signed in to agentlas.cloud); the
`localStorage` journey persistence can move behind the same store API when a
real per-user store is added.

## How this relates to Plane

[makeplane/plane](https://github.com/makeplane/plane)'s web app is a Vite +
React Router monorepo wired to a Django backend through ~10 `@plane/*` workspace
packages — it cannot be "copied as-is" and run standalone. So we copied the part
that *makes Plane look like Plane* and rebuilt the rest on our own data:

- **Design tokens copied verbatim** — `src/styles/variables.css` and
  `src/styles/animations.css` are Plane's `@plane/tailwind-config` files
  unchanged (OKLCH color system, semantic tokens, dark/light + high-contrast,
  shadows, typography scale). This is why both themes match Plane 1:1.
- **Component patterns ported** — the Button variants, list rows, three-pane
  app shell, sidebar, peek overlay and command palette mirror Plane's structure,
  reskinned for the founder workflow.
- **Wired to our agents, not Plane's API** — every screen renders the Startup
  HQ output model in `src/data/`, not Django issues.

### Design language — Apple Liquid Glass

On top of Plane's tokens we layer an **Apple HIG / Liquid Glass** material:
`lg-glass` / `lg-glass-strong` / `lg-veil` utilities (translucent + backdrop-blur
+ vibrancy + bright specular top edge), an `lg-app-bg` ambient gradient backdrop,
capsule controls (`rounded-full`), and large continuous corners. Liquid progress
bars (`.studio-liquid`) visualize per-stage readiness. Works in light + dark.

> Token constraint inherited from Plane: only **semantic tokens**
> (`bg-surface-1`, `text-primary`, `border-subtle`, `bg-accent-primary`…),
> **label colors** (`bg-label-emerald-bg`…) and the defined numeric text sizes
> (`text-9/10/11/12/13/14/16/18/20/24/28/32/40`) exist. Raw Tailwind scales
> (`bg-red-600`, `text-15`) are intentionally **not** generated.

## Run

```bash
cd web
npm install
npm run dev        # http://localhost:5273
# or
npm run build && npm run preview   # production build on :4173
```

## Structure

### Languages

English-first with an i18n layer. `src/i18n/content.en.ts` is the source of
truth; `content.ko.ts` mirrors it; `ui.ts` holds chrome strings. Switch with the
**EN / KO** toggle in the top bar (default EN, persisted). Components read content
through `useContent()` / `useT()` — they never import the data tree directly.

```
src/
  styles/        Plane design tokens (verbatim) + globals
  i18n/          content.en (source) + content.ko + ui strings + LangProvider
  data/          domain types + visual meta
  store/         StudioProvider: theme, stage nav, agent-run state machine
  components/
    ui/          Button, chips, stage icons
    shell/       sidebar, topbar, command palette (⌘K), app shell
    board/       work-item row, peek overlay
    inspector/   agent chat (right panel — talk to the stage agent)
    run/         streaming agent-run reveal (the wow)
    stages/      overview pipeline + per-stage shell (picks the output view)
    views/       the six stage-specific output surfaces
  pages/         workspace switch (overview vs stage)
```

## Each stage has its own output surface

The deliverable is what matters, so every stage renders a surface shaped like
its real output — not a generic board:

| Stage | Output surface (`src/components/views/`) |
|---|---|
| 아이디어 | **린 캔버스** — 문제·고객·솔루션·수익모델·검증을 칸으로 |
| 시장 | **경쟁 리포트** — 경쟁 비교표(‘우리 자리’ 강조) + 가상 고객 반대 신호 |
| 사업 설계 | **사업계획서 문서 에디터** — 목차 + 편집 모드 + 근거칩 (Liner Write 풍) |
| 제품 기획 | **PRD 워크스페이스** — 요구사항 + 유저 플로우 + **와이어프레임 폰** |
| 제품 개발 | **제품 미리보기** — 실제 ‘오늘 발주’ 화면 폰 목업 + 빌드/QA |
| IR / 피치덱 | **슬라이드 빌더** — 썸네일 레일 + 슬라이드 캔버스 + PPTX 내보내기 (Genspark 풍) |

The board (work items) is kept as a secondary `작업` tab on each stage.

## Content tiers (how output is packaged)

Every rendered piece is intentionally placed in one of four tiers:

1. **중요 (Tier 1)** — the takeaway: verdict pill + one-line `headline` + the
   single decision question + the primary KPI. Largest, accent-weighted.
2. **보조 (Tier 2)** — work-item titles, supporting metrics, evidence chips.
3. **숨김 가능 (Tier 3)** — full content, document body, cross-check notes →
   behind the peek overlay / expandable sections.
4. **시스템 내부 (Tier 4)** — HQ paths, engine names, internal IDs (`STU-xxx`),
   owner HQ. **Hidden by default** via the `<SystemInfo>` gate; the sidebar
   footer **시스템 정보** toggle reveals it for debugging.

## Lifecycle → HQ mapping

Each of the six stages routes 1:1 to a Startup HQ package:

| Stage | HQ |
|---|---|
| 아이디어 구체화 | `Startup/01-idea-foundry-hq` |
| 시장 검증 | `Startup/02-market-intelligence-hq` |
| 사업 설계 | `Startup/03-business-plan-hq` |
| 제품 기획 (PRD) | `Startup/04-product-planning-prd-maker` |
| 제품 개발 | `Startup/05-product-development-hq` |
| IR / 피치덱 | `Startup/06-pitch-deck-ir-hq` |

## Connecting real agents (the seam)

The agents are "already attached" — today the UI replays seeded output with a
realistic stream so the experience is demonstrable offline. There is **one seam**
to make it live:

1. `src/store/studio-context.tsx` → `runAgent(stage)` currently advances a timer
   over `stage.runSteps`. Replace its body with a call to the HQ runtime (e.g.
   stream from a `/api/run/{stage}` endpoint or the Hephaestus network) and push
   the returned `StageData` into state.
2. `src/data/types.ts` is the contract. Have the HQ agent emit a `StageData`
   (work items, decision card, cross-checks, document) and the views render it
   unchanged.

No view component needs to change to go from demo to live.
