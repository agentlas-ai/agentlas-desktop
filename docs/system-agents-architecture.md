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

## Two-pass model-judged gating (for capabilities users don't name)

Keyword/BM25 gating fails for capabilities the user never says explicitly — e.g.
nobody types "make a dashboard", yet a surface is often the better output. For those,
don't gate on user words; gate on the **model's judgment**:

1. Core always carries a tiny intent HINT (e.g. `SURFACE_INTENT_HINT` in `runner.ts`):
   "if this is better as an interactive surface AND recurring/operational, reply with
   exactly `<<surface-intent>>`; for one-offs, just answer."
2. The dispatch (`mcp/client.ts`) detects the marker and re-invokes **once** with a force
   flag (`forceSurface`) that makes `wrapSystemPrompt` inject the full heavy block.
3. A generous keyword fast-path (threshold ~0.4) still short-circuits obvious requests
   to a single pass.

This is the confidence-gated fallback: plain chat stays minimal, the wow-moment fires on
model judgment (not wording), and the one-off vs recurring decision is the model's.
Use this for any capability whose under-trigger is costly but whose trigger isn't a keyword.

## Provider portability

- **claude**: may additionally use native Tool Search (`defer_loading: true`) for MCP tools.
- **codex / gemini**: use this BM25 retrieval directly (no native feature needed).
- The structural split (core + on-demand) is the universal layer; provider caching
  (claude prefix cache, codex input cache + session resume) is a bonus on top, never
  the foundation — because it is not uniform across providers.

## Inventory & status

- **desktop-chat** (`electron/system-agents/desktop-chat/`) — DONE & live. Core (identity,
  safety, ASK contract, capability hints) + on-demand `surface` / `connection` / `automation`
  modules. `wrapSystemPrompt` gates `SURFACE_PROTOCOL` (~16KB) via keyword fast-path + the
  two-pass marker above. Result: plain chat ~9.8KB vs ~24.6KB always-on (live, 5 runners),
  surface turns load the full spec on demand. `CONNECTION_SKILL` stays in core (under-trigger
  on it is a dead-end). Routing/gating tested: `scripts/test-system-agent-routing.cjs`.
- **Surface Builder** (`surface-emitter.ts` + `app-factory/` + `tool-factory/` + `agent-os/`
  + packs + `electron/surface-design/`) — design layer added: `buildDesignCss()` (production
  tokens + `ds-*` components, light/dark/brand) replaces ad-hoc inline CSS; `lazyweb` +
  `shadcn` MCP registered in the catalog; persistent browser profile + captcha human-in-the-
  loop baked into core. Remaining: generated-tool auto-registration to the active runtime.
- **Agentlas App Builder** (`architecture/manifest.ts`, slug `agentlas-app-builder`) —
  background built-in route for app-worthy Apps Generate requests. It turns repeatable
  workflow goals into an Agentlas internal App manifest, keeps generated surfaces/tools as
  support evidence, and uses design-reference patterns without publishing third-party
  service names as product copy.
- **Pending migration onto the backbone** (same pattern, lower urgency — small prompts):
  memory system agents (`architecture/manifest.ts`: memory-curator / pm-soul / task-bias)
  and the **web meta-agent** (`AgentsAtlas/app/src/lib/draft/meta-agent.ts`; `knowledge.md`
  20 sections → on-demand modules). The connection provider catalog (`CONNECTION_PROVIDER_HINTS`,
  ~3KB) is a good next on-demand split (load per provider named).
