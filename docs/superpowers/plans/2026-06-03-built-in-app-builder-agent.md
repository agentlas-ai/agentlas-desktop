# Built-in App Builder Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible built-in Agentlas App Builder Agent that owns Apps Generate and produces internal Agentlas Apps.

**Architecture:** Extend the built-in architecture manifest as the single source of truth, then regenerate CLI architecture data. Route Apps Generate through the same auto-router so Desktop and terminal behavior stay aligned.

**Tech Stack:** Electron main process, TypeScript, SQLite seeded installed agents, Next renderer Apps surfaces, generated App Factory manifest path.

---

### Task 1: Built-in Agent Definition

**Files:**
- Modify: `electron/architecture/manifest.ts`

- [x] **Step 1: Add the agent role and slug**

Add `builder` to `BuiltinRole`, export `APP_BUILDER_SLUG`, and bump `ARCHITECTURE_VERSION`.

- [x] **Step 2: Add the App Builder prompt**

Define a prompt that requires internal Agentlas Apps, `<<agentlas-surface>>` manifests, app-specific workflows, Lazyweb-style pattern extraction without deployed third-party copy, and secure-boundary pauses.

- [x] **Step 3: Add the visible built-in**

Insert `agentlas-app-builder` in `BUILTIN_AGENTS` with `visibility: "visible"` and a stable user-facing name.

### Task 2: Runtime Routing

**Files:**
- Modify: `electron/agents/auto-router.ts`
- Modify: `electron/mcp/client.ts`
- Modify: `cli/agentlas.cjs`

- [x] **Step 1: Add route hints**

Add English/Korean route hints for Apps Generate, app builder, generated app, internal app, and app-generation Korean triggers.

- [x] **Step 2: Route Apps Generate even from non-orchestrator chats**

Change `runMcpInvocation` so `req.appsGenerateMode` invokes auto-routing regardless of the current chat agent.

- [x] **Step 3: Adjust the routing preamble**

Make the preamble explain Apps Generate routing separately from default orchestrator routing.

### Task 3: Product Documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE_PLAYBOOK.md`
- Modify: `docs/system-agents-architecture.md`
- Modify: `docs/generated-app-engine.md`
- Modify: `README.md`
- Modify: `docs/sitemap.yaml`
- Create: `docs/prds/2026-06-03-agentlas-app-builder-agent.md`

- [x] **Step 1: Replace hidden-generator language**

Describe the named built-in App Builder route rather than a hidden prompt wrapper.

- [x] **Step 2: Track the product node**

Add `apps.app_builder` to `docs/sitemap.yaml`.

- [x] **Step 3: Record copy-risk rule**

Document that generated App product copy must not use third-party service names as comparison or "X-style" shorthand.

### Task 4: Verification

**Files:**
- Create: `scripts/test-app-builder-routing.cjs`
- Modify: `package.json`
- Modify after verification: `docs/validation-ledger.jsonl`

- [x] **Step 1: Add routing smoke test**

Verify the generated architecture manifest contains `agentlas-app-builder`, the agent is visible, Korean/English app-generation prompts route to it, and the Electron seeder writes it as a visible built-in row.

- [x] **Step 2: Run verification**

Run:

```bash
npm run test:app-builder-routing
npm run test:app-builder-seed
npm run typecheck
npm run build
```

- [x] **Step 3: Append validation evidence**

Append one JSONL row for `apps.app_builder` with the commands that passed.
