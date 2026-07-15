# Agentlas Architecture Playbook

> How the built-in agent architecture works, and how to research / extend it
> **without breaking installs**. Read this before changing anything under
> `electron/architecture/` or `electron/memory/`.

## 1. The three product surfaces

Agentlas carries related *research architectures* across three product surfaces,
with different hosts and responsibilities:

| Surface | Host | What runs |
|---|---|---|
| **agentlas.cloud (web)** | Hosted | Hub discovery/bookmarks, private Agent Cloud storage, groups, and account control-plane state. It does not replace the local LLM runtime. |
| **Agentlas Desktop** | The user's machine (BYOC) | The local GUI runtime: built-in control agents, memory, tools, automation, and user-visible apps. |
| **Agentlas Terminal** | The user's machine (BYOC) | An independent npm product and repository (`agentlas-ai/agentlas-terminal`). It interoperates with Desktop data when available, but is not generated from or bundled under this repo. |

The local runtimes consume the **same source-of-truth agent repos**:

- `agentlas-ai/Agentlas-OS` — public core and single-agent/team/package contract
- `agent_project_pm_soul` — per-project continuity + memory (PM Soul)
- `agent_memory_curator_agent` — curated durable memory (Memory Curator)
- `agentlas_task_bias` — AI Sitemap governance to reduce task-selection bias

Desktop and Terminal each maintain their own tested runtime distillation of these
contracts. The canonical research lives in the repos; neither local product is a
generated subdirectory of the other.

## 2. What ships in Agentlas Desktop

On first launch, the app seeds the local **built-in agents**
(`installed_agents.builtin = 1`) and a **memory substrate**. Built-in agents are
runtime control routes, so they ship as `background` and stay out of user-facing
agent lists:

- Agentlas Orchestrator
- Agentlas App Builder
- Agentlas Core Engine Meta-Agent
- Project PM Soul
- Memory Curator
- Task Bias Curator

```
electron/architecture/
  manifest.ts     ← SINGLE SOURCE OF TRUTH (version + agent prompts + memory contract)
  seed.ts         ← idempotent, version-gated seeding into the DB
  activation.ts   ← repeated-folder-work detection → auto-activates a project
electron/memory/
  events.ts       ← parses the "## Memory Events" block from an agent reply
  curator.ts      ← deterministic always-on curator (safety, scope, dedup, persist)
  store.ts        ← memory_entries CRUD + write-time local embeddings
  local-embedding.ts ← verified Model2Vec+hash adapter + lexical/cosine RRF
  project-files.ts← .agentlas/ materialization + per-agent Core nest projection
  context.ts      ← governed/adaptive Memory context for the current task
electron/experience/
  store.ts        ← reviewed Experience candidates + exact binding filters
  context.ts      ← task-ranked Experience prompt with an adaptive token budget
  relation-index.ts ← semantic relations + explicit governance relations
```

The independent Terminal implementation lives in the separate
[`agentlas-ai/agentlas-terminal`](https://github.com/agentlas-ai/agentlas-terminal)
repository. Cross-surface behavior is maintained with explicit parity tests and
architecture-sync checks, not by restoring a Desktop `cli/` folder.

### How a turn flows (app, `electron/mcp/client.ts`)
1. Resolve agent + project. If the chat has a **working folder**, record a visit
   (`activation.recordFolderVisit`). The **2nd visit activates** the folder → creates
   `<folder>/.agentlas/` (soul memory + sitemap).
2. **Inject governed Memory** (`memory/context.buildMemoryContext`) — pass the
   current effective task, score every eligible owner-scoped row with local
   lexical/vector evidence, and append the adaptive result to the system prompt.
3. **Inject eligible Experience** (`experience/context.buildExperienceContext`) —
   bind the exact agent, package hash, project scope, environment, and reviewed
   outcome; then append task-selected items. An exact Operational overlay takes
   precedence, and restricted Agent App runs skip both Memory and Experience.
4. **Append the emitter block** (`MEMORY_EMITTER_BLOCK`) to every ordinary,
   non-restricted system prompt so the agent can emit Memory Events.
5. Run the agent.
6. **Curate the reply** (`curator.curateReply`) — parse the `## Memory Events` block,
   apply safety/scope/dedup **in code (no extra LLM call)**, persist durable items to
   `memory_entries` + `.agentlas/`, and **strip the block** from the visible answer.

The independent Agentlas Terminal implements the corresponding terminal flow in its
own repository. Claude/Codex/Gemini child sessions keep their own session loops.

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

### Governed local hybrid recall (v0.8.32)

Desktop uses one local embedding implementation for both curated Memory and
reviewed Experience. Packaged builds require the pinned Agentlas OS
`assets/model2vec/potion-base-8M-int8` payload and verify every manifest record,
file size, file SHA-256, and aggregate content identity in `afterPack` before
signing or publication.

The normal vector is 352 dimensions:

- 256 dimensions from the pinned `minishlab/potion-base-8M` semantic table,
  quantized per row to int8;
- 96 dimensions from `LocalHashingVectorAdapter`-compatible deterministic token
  hashing; and
- one normalized, concatenated hybrid vector stored with its adapter identity,
  model checksum, content hash, dimensions, and JSON vector.

The asset is MIT-licensed, read in-process, and marked `networkRequired: false`.
There is no server embedding request, API key, or operator-paid per-user
embedding call. A missing or invalid verified asset explicitly degrades to the
96-dimensional hashing adapter so local recall remains available; packaged
v0.8.32 treats that as a degraded fallback, not the intended quality path.

Retrieval keeps evidence channels independently auditable:

| Reader | Governance before ranking | Rank fusion and prior | Adaptive selection |
|---|---|---|---|
| Curated Memory | live scope, exact agent ownership, verified project identity, and supersession; the curator blocks secret persistence before this stage | lexical overlap rank + local cosine rank through RRF (`k=60`), plus a bounded confidence prior | load all relevant rows if they fit the 800 approximate-token budget; otherwise at most 12 ranked rows that fit |
| Reviewed Experience | confidential/secret source rejection at capture, then exact agent, active pack, package hash, project scope, environment, promoted outcome, and explicit supersession | the same lexical/vector RRF, plus bounded confidence and reviewed-relation evidence | load all task-relevant rows if they fit the dynamic 800-token budget; otherwise at most 8, after reserving separate Taste space |
| Borrowed-agent Core nest | exact `hub:<slug>`, active status, allowed privacy scope, expiry, and valid same-agent/same-scope supersession | lexical rank + cosine rank through RRF, normalized to 85%, plus salience at 15% | `all_relevant` when the set fits; otherwise bounded `hybrid_top_k` |

No reader applies an arbitrary “newest N” window before scoring. Recency remains
a deterministic tie/order input after governance, not a substitute for task
relevance.

Relations also have explicit authority levels:

- `similar_to` is derived from compatible local vectors and is rebuildable. In
  Desktop Experience it never crosses a pack.
- `supersedes` and `contradicts` require a reviewed relation between two promoted
  candidates in the same pack and agent. Vector proximity can never create
  either relation.
- Valid supersession filters its target before semantic ranking. Corrupt,
  cross-owner, cross-agent, and privacy-mismatched edges do not gain authority.

When the deterministic curator accepts `agent_repo` learning from a borrowed
agent, Desktop projects it into:

```text
~/.agentlas/networking/hub-agents/<normalized-slug>/memory/experience.sqlite
```

That database mirrors the public Core `memory_candidates`, `memory_links`, and
`runtime_adapters` schema. Desktop recomputes derived `similar_to` links and
replays authoritative reviewed governance on append/rebuild. Core recalls it
with the exact `hub:<slug>` identity through the installed local ontology CLI;
the runtime no longer injects `project-soul-memory.md` wholesale.

Focused contracts:

```bash
npm run test:model2vec-hybrid-parity
npm run test:memory-hybrid-retrieval
npm run test:curator-nest-core-query
npm run test:experience-relations
```

## 3. The upgrade contract (DO THIS to extend safely)

The whole point: research and change the architecture repeatedly **without corrupting
existing installs**. The mechanism is a single version gate.

To change agent prompts or the memory contract:

1. Edit `electron/architecture/manifest.ts` (prompts, agents, contract constants).
2. **Bump `ARCHITECTURE_VERSION`** (semver) in the same file.
3. `npm run build:electron` — this recompiles the Desktop main-process runtime.
4. Ship. On next Desktop boot, the seeder sees the new version and **re-syncs only the
   built-in agents' name/prompt/role**. It never touches user chats, marketplace agents,
   local imports, or project memory.

To add a **new** built-in agent: add an entry to `BUILTIN_AGENTS` (stable `slug`) with
`visibility: "background"`, bump the version, rebuild. `builtinAgentId(slug)` keeps the
Desktop row id stable across upgrades. User-facing agents should come from installed agent repos
or firms, not desktop built-ins.

To change the **DB schema** (new memory field, new table): add a `userVersion < N` block
in `electron/store/db.ts` (additive, guarded with column/`IF NOT EXISTS` checks like the
existing ones) and bump `SCHEMA_VERSION`. Keep migrations backward-compatible, then run
the cross-surface schema/parity gates in the independent Terminal repository.

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
- Embedding must remain **local and in-process**. Do not add a server embedding
  fallback, hidden API call, or operator-paid per-user dependency.
- Rank every governance-eligible row before the adaptive token budget; do not
  reintroduce a pre-ranking recency cap.
- Semantic similarity may create only rebuildable `similar_to`. Never infer
  `supersedes` or `contradicts` from tags or vector proximity.
- Keep the base and signed-mac `extraResources`/`afterPack` Model2Vec contracts
  synchronized so every published platform carries the same verified asset.

## 4. Source-of-truth ↔ runtime sync

When the research repos change, reflect the operational distillation into
`manifest.ts` and bump the version. Keep prompts faithful but condensed — the repos hold
the full paper/contract; the app ships the operating instructions. The relationship is
recorded in `.agentlas/project-soul-memory.md` of this repo (the desktop project dogfoods
its own PM Soul).
