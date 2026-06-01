# Project Soul Memory: Agentlas Desktop

Durable memory for the Agentlas Desktop app + `agentlas` CLI, maintained by the PM Soul.
This is the dogfood instance: the architecture keeps its own project memory here.

## Project Purpose

Ship the Agentlas desktop app and terminal CLI as a local "architecture agent" runtime
(Hermes-style) that bakes three research architectures into every install: Project PM
Soul, Memory Curator, and Task Bias Curator — plus a curated memory substrate.

## Current State

- v0.1.0: built-in architecture agents auto-seed on app boot + CLI run (version-gated).
- Memory substrate live: `memory_entries` (DB) + per-project `.agentlas/` files.
- Always-on deterministic curator runs after every turn (no extra LLM call).
- Repeated work in a folder (≥2 visits) auto-activates PM Soul + AI Sitemap.
- Single source of truth: `electron/architecture/manifest.ts` → generates
  `cli/architecture.data.json`.

## Folder Map

- `electron/architecture/` — manifest (truth), seed, activation
- `electron/memory/` — events, curator, store, project-files, context
- `cli/agentlas.cjs` — terminal mirror; `cli/architecture.data.json` (generated)
- `docs/ARCHITECTURE_PLAYBOOK.md` — how to extend safely
- `electron/store/db.ts` — schema (v12 added meta/memory/folder_activity)
- `docs/AGENT_VISIBILITY_CONTRACT.md` — required `visible` / `background` / `private` agent classification

## Decisions

| Date | Decision | Rationale | Evidence |
|------|----------|-----------|----------|
| 2026-05-29 | Manifest lives under `electron/` not `shared/` | Only `dist/electron/**` is packaged; `dist/shared/**` was not | electron-builder.yml files list |
| 2026-05-29 | Add `dist/shared/**` to packaging | `shared/models.ts` has runtime values value-imported by `detect.ts`/`byok.ts` → prod crash | electron-builder*.yml |
| 2026-05-29 | Deterministic always-on curator (no LLM) | Memory must run on every turn cheaply; LLM Curator agent is the explicit/deep path | electron/memory/curator.ts |
| 2026-05-29 | Version-gated idempotent seeding | Research the architecture, bump ARCHITECTURE_VERSION, ship — never corrupt installs | electron/architecture/seed.ts |
| 2026-05-29 | Auto-activate a folder on the 2nd visit | "repeated work in a folder" = continuity should start early | electron/architecture/activation.ts |
| 2026-05-29 | CLI seeds from generated JSON, guarded on schema | CLI is CommonJS + doesn't migrate; waits for one app launch on old DBs | cli/agentlas.cjs seedBuiltins |
| 2026-05-31 | Every created/uploaded/installed agent must persist one visibility class: `visible`, `background`, or `private` | Public desktop must hide background control agents and block private web-only IP before renderer surfaces | docs/AGENT_VISIBILITY_CONTRACT.md; electron/store/db.ts; electron/agents/policy.ts |

## Risks

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|
| Emitter block adds tokens to every prompt | Minor cost on every turn | Block is short; only durable items are emitted | accepted |
| Native CLI sessions (claude/codex) bypass curation | Memory not captured for native loops | Inject context; GUI + API path carry curation | accepted v1 |
| Schema drift between app (migrates) and CLI (doesn't) | CLI no-op on stale DB | CLI guards on table/column existence | mitigated |
| New agent-building flows forget visibility classification | Background/private agents leak into user-facing desktop or public package surfaces | Require `installed_agents.visibility`; enforce in main-process policy before renderer filtering | active guard |

## User Preferences

- Autonomous delivery: finish without asking, then deploy a new version.
- Tool-use / thinking should look like Claude Code (no oval animation).

## Lessons Learned

| Date | Lesson | Reuse Rule |
|------|--------|------------|
| 2026-05-29 | `shared/types.ts` is type-only → imports elided; `shared/models.ts` has runtime values | Runtime-valued shared modules MUST be in the packaging `files` list |

## Auto-curated memory
