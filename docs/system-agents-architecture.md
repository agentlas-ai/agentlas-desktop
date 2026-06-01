# System-Agent Architecture (context-engineered)

Agentlas system agents follow a **minimal always-on CORE + low-frequency ON-DEMAND
modules** structure. The goal is the smallest high-signal context per request
(avoid "context rot"), uniformly across **claude / codex / gemini** — without
depending on any one provider's caching.

Pattern lineage: *Instruction-Tool Retrieval (ITR)* and Anthropic's *Tool Search*
(`defer_loading`). Claude can use the native feature; codex/gemini use the same
file-based BM25 retrieval implemented here, so the result is provider-portable.

## The backbone — `electron/system-agents/`

| File | Role |
|---|---|
| `types.ts` | `OnDemandModule`, `SystemAgentSpec`, `SelectionResult` |
| `bm25.ts` | dependency-free ko/en BM25 ranker (`tokenize`, `Bm25`) |
| `discovery.ts` | `selectModules(query, modules, opts)` — picks modules per request |
| `assemble.ts` | `assembleSystemPrompt(agent, query)` = core + selected modules |
| `index.ts` | public exports |

```ts
import { assembleSystemPrompt, type SystemAgentSpec } from "../system-agents";
const { systemPrompt, loadedModuleIds, chars } = assembleSystemPrompt(agent, userPrompt);
```

`selectModules` rules (the only real failure point is router reliability):
- `alwaysOn: true` modules are **never gated** → always included.
- gated modules need BM25 score ≥ `threshold` (default `0.8`) → over-trigger suppressed.
- nothing matches → empty selection (core only) → safe under-trigger.

## What goes in CORE vs ON-DEMAND

**CORE (always on, target ~1–2KB):**
1. Agent identity / role.
2. **Safety & policy rules** — never gate these (a missed trigger would drop the
   rule entirely). Mark them `alwaysOn` if expressed as a module.
3. Output contract / format needed every turn.
4. The discovery mechanism itself (a one-line hint pointing at on-demand capabilities).
5. The 3–5 most-used tools.

**ON-DEMAND (gated, retrieved per request):** domain procedures, long examples,
reference docs, capability protocols used in a minority of turns. In the desktop
chat agent these are the heavy blocks: `SURFACE_PROTOCOL` (~16KB),
`GLOBAL_CONNECTION_SKILL` (~7KB), `AUTOMATION_PROTOCOL`.

## How to add a new system agent

1. **Folder.** Create `electron/system-agents/<agent-id>/` with:
   - `core.ts` — exports the minimal core string (identity + safety + output contract + discovery hint).
   - `modules/<module-id>.ts` — each exports an `OnDemandModule` (`id`, `title`,
     `keywords`, `description`, `load()`; `alwaysOn` only for safety/identity).
   - `index.ts` — exports a `SystemAgentSpec` ( `{ id, core, modules }` ).
2. **Register** the spec where the runtime assembles prompts (the dispatch picks
   the agent, then calls `assembleSystemPrompt(spec, userPrompt)`).
3. **Tune discovery keywords/descriptions** — these drive trigger reliability.
   Use strong, unambiguous signals; avoid generic words ("report", "table") that
   appear in unrelated requests. Add ko + en keywords.
4. **Add routing cases** to `scripts/test-system-agent-routing.cjs`: intent → expected
   loaded modules, plus a plain-chat case that must load zero heavy modules.
5. **Measure miss-rate** (loaded vs expected) as the operating KPI; retune
   descriptions when under/over-trigger appears.

## Provider portability

- **claude**: may additionally use native Tool Search (`defer_loading: true`) for MCP tools.
- **codex / gemini**: use this BM25 retrieval directly (no native feature needed).
- The structural split (core + on-demand) is the universal layer; provider caching
  (claude prefix cache, codex input cache + session resume) is a bonus on top, never
  the foundation — because it is not uniform across providers.

## Inventory (to be migrated onto the backbone)

- **Web** (`AgentsAtlas/app`): one system agent — the meta-agent
  (`src/lib/draft/meta-agent.ts`); `knowledge.md` (20 sections) is the prime
  on-demand candidate.
- **App + Terminal** (this repo): memory system agents (`architecture/manifest.ts`:
  memory-curator / pm-soul / task-bias + `MEMORY_EMITTER_BLOCK`) and the
  **Surface Builder** (`surface-emitter.ts` + `app-factory/` + `tool-factory/` +
  `agent-os/` + packs). Current always-on injection is ~26KB/turn; target is core-only
  for plain chat with heavy blocks loaded on intent.

> Status: backbone (`electron/system-agents/`) is implemented and routing-tested
> (`scripts/test-system-agent-routing.cjs`, 5/5). Wiring the existing agents onto it
> is pending consolidation of in-flight work in `surface-emitter.ts` / `runner.ts` /
> `client.ts` / `architecture/`.
