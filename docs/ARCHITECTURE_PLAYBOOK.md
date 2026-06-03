# Agentlas Architecture Playbook

> How the built-in agent architecture works, and how to research / extend it
> **without breaking installs**. Read this before changing anything under
> `electron/architecture/` or `electron/memory/`.

## 1. The two runtimes (web vs app/terminal)

Agentlas runs the same *research architectures* in two places, with different hosts:

| Surface | Host | What runs |
|---|---|---|
| **agentlas.cloud (web)** | Hosted | Builder and orchestration services that run server-side. |
| **Desktop app + `agentlas` CLI** | The user's machine (BYOC) | A local **architecture agent** (Hermes-style): always-present built-in agents + a memory substrate, running on the user's own Claude/Codex/Gemini/BYOK runtime. |

Both consume the **same source-of-truth agent repos**:

- `agent_project_pm_soul` — per-project continuity + memory (PM Soul)
- `agent_memory_curator_agent` — curated durable memory (Memory Curator)
- `agentlas_task_bias` — AI Sitemap governance to reduce task-selection bias

The desktop/terminal **bakes condensed, operational versions** of these into every
install. The canonical research lives in the repos; the app ships a runtime distillation.

## 2. What ships on install (app + terminal)

On first launch (and on every CLI run), the app seeds the local **built-in agents**
(`installed_agents.builtin = 1`) and a **memory substrate**. Built-in agents are
runtime control routes, so they ship as `background` and stay out of user-facing
agent lists:

```
electron/architecture/
  manifest.ts     ← SINGLE SOURCE OF TRUTH (version + agent prompts + memory contract)
  seed.ts         ← idempotent, version-gated seeding into the DB
  activation.ts   ← repeated-folder-work detection → auto-activates a project
electron/memory/
  events.ts       ← parses the "## Memory Events" block from an agent reply
  curator.ts      ← deterministic always-on curator (safety, scope, dedup, persist)
  store.ts        ← memory_entries CRUD
  project-files.ts← .agentlas/ materialization (soul memory, sitemap, log)
  context.ts      ← builds the memory injected into each system prompt
cli/
  agentlas.cjs            ← terminal CLI (mirrors seeding + memory, CommonJS)
  architecture.data.json  ← GENERATED from manifest.ts (do not hand-edit)
```

### How a turn flows (app, `electron/mcp/client.ts`)
1. Resolve agent + project. If the chat has a **working folder**, record a visit
   (`activation.recordFolderVisit`). The **2nd visit activates** the folder → creates
   `<folder>/.agentlas/` (soul memory + sitemap).
2. **Inject memory context** (`context.buildMemoryContext`) — project soul + sitemap
   summary + recent curated memory (or global memory when there's no active folder).
3. **Append the emitter block** (`MEMORY_EMITTER_BLOCK`) to every system prompt so any
   agent can emit Memory Events.
4. Run the agent.
5. **Curate the reply** (`curator.curateReply`) — parse the `## Memory Events` block,
   apply safety/scope/dedup **in code (no extra LLM call)**, persist durable items to
   `memory_entries` + `.agentlas/`, and **strip the block** from the visible answer.

The CLI mirrors this for its API path (BYOK/Ollama); native CLI sessions (claude/codex/
gemini) get memory context injected but keep their own session loop.

### Auto-activation
One-off folders stay untouched. A folder a user **works in repeatedly** (≥2 chats with
that working folder) auto-activates: PM Soul memory + AI Sitemap start living in
`<folder>/.agentlas/`. This is the "프로젝트에서 작업 반복 → 자동으로 PM 메모리/사이트맵/
task-bias가 작동" behavior.

### Always-on curator
Every conversation — even basic chat with no explicit agent — carries the emitter block
and is curated. That is the "전역 curator agent가 모든 대화/에이전트의 메모리를 관리"
behavior. The **Memory Curator built-in agent** remains available for explicit, deep
curation; the deterministic curator is the cheap always-on substrate.

### Five-scope memory source map
The production contract is five-scope: `user_identity`, `team_memory`, `project`,
`agent_repo`, `session`, plus `discard`. `agent_team` is accepted only as a
legacy alias for `team_memory`. The active project should also carry
`.agentlas/memory-map.json` so Desktop, terminal, AppBridge, and llm-wiki can
agree on where memory lives, who can write it, and how corrections are promoted.

### Request-context recall
Each durable memory entry can also carry a compact `request_context` capsule:
`user_intent`, `trigger_terms`, `cwd_at_request`, `target_project`,
`target_path`, `cross_context`, and `outcome`. This is a redacted provenance
summary for recall, not the raw user prompt. It lets a later request from another
folder find the relevant memory by the situation that created it.

## 3. The upgrade contract (DO THIS to extend safely)

The whole point: research and change the architecture repeatedly **without corrupting
existing installs**. The mechanism is a single version gate.

To change agent prompts or the memory contract:

1. Edit `electron/architecture/manifest.ts` (prompts, agents, contract constants).
2. **Bump `ARCHITECTURE_VERSION`** (semver) in the same file.
3. `npm run build:electron` — this recompiles AND regenerates `cli/architecture.data.json`
   (via `scripts/gen-cli-architecture.mjs`). Never hand-edit the JSON.
4. Ship. On next boot/CLI run, the seeder sees the new version and **re-syncs only the
   built-in agents' name/prompt/role**. It never touches user chats, marketplace agents,
   local imports, or project memory.

To add a **new** built-in agent: add an entry to `BUILTIN_AGENTS` (stable `slug`) with
`visibility: "background"`, bump the version, rebuild. `builtinAgentId(slug)` keeps the
row id stable across app + CLI. User-facing agents should come from installed agent repos
or firms, not desktop built-ins.

To change the **DB schema** (new memory field, new table): add a `userVersion < N` block
in `electron/store/db.ts` (additive, guarded with column/`IF NOT EXISTS` checks like the
existing ones) and bump `SCHEMA_VERSION`. The CLI does **not** migrate — it guards on
schema readiness and waits for one app launch. Keep migrations backward-compatible.

To create, upload, sync, import, or seed an **agent**, apply the visibility contract in
`docs/AGENT_VISIBILITY_CONTRACT.md`: every agent row must persist exactly one of
`visible`, `background`, or `private` in `installed_agents.visibility`. Renderer hiding is
not enough; main-process install/search/list paths must enforce the contract first.

To change the **memory event contract**: update `MEMORY_EMITTER_BLOCK`, `MEMORY_KINDS`,
`MEMORY_SCOPES` in the manifest (+ bump version). `events.ts` / `curator.ts` coerce
unknown kinds/scopes to safe defaults, so older replies never crash the curator.

### Invariants (don't break these)
- The manifest is **data + pure helpers only** — no `electron`/`node` imports — so it
  compiles into `dist/electron/**` (packaged) and the JSON generator can `require` it.
- `dist/shared/**` **must** stay in `electron-builder*.yml` `files` (runtime values in
  `shared/models.ts` are required at launch).
- Seeding is **idempotent and version-gated**; never delete/recreate user rows.
- Agent visibility is a **DB contract** (`visible` | `background` | `private`), not just
  a UI concern. Private web-only agents must never ship in desktop package artifacts.
- The curator must **never persist secrets** (see `SECRET_PATTERNS`) and must run with
  **zero extra LLM calls** on the always-on path.

## 4. Source-of-truth ↔ runtime sync

When the research repos change, reflect the operational distillation into
`manifest.ts` and bump the version. Keep prompts faithful but condensed — the repos hold
the full paper/contract; the app ships the operating instructions. The relationship is
recorded in `.agentlas/project-soul-memory.md` of this repo (the desktop project dogfoods
its own PM Soul).
