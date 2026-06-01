# Agent Visibility Contract

Every Agentlas agent created, imported, uploaded, synced, or installed must resolve to
exactly one visibility class before it is persisted.

This is a product and database contract, not a renderer-only filter.

## Classes

| Value | Meaning | Desktop behavior |
|---|---|---|
| `visible` | User-facing assistant, team entry, or imported local agent. | Shows in Library, pickers, automation targets, and CLI `list`. |
| `background` | Control-plane agent used for routing, memory, governance, evaluation, or other behind-the-scenes work. | Can run internally, but is hidden from user-facing agent lists and pickers. |
| `private` | Proprietary web-only agent or other IP that must not ship with the desktop app. | Must be blocked from desktop install, sync, search, list, and package output. |

## Storage Contract

The local SQLite source of truth is:

```sql
installed_agents.visibility TEXT NOT NULL
  CHECK(visibility IN ('visible','background','private'))
```

Schema migration lives in `electron/store/db.ts`. Runtime classification and
back-compat fingerprints live in `electron/agents/policy.ts`.

Renderer filtering is a secondary safety layer only. The main process must classify
and block rows first.

## Creation And Upload Rules

Any flow that creates or uploads an agent must set one of the three values:

- New marketplace/public user agent: `visible`
- Local folder import: `visible`
- Built-in router, memory, PM, task-governance, eval, or similar control role: `background`
- Proprietary builder/research/review agent meant only for the private web product: `private`

If a manifest omits `visibility`, Agentlas Desktop treats it as `visible` unless
`electron/agents/policy.ts` identifies it as `background` or `private`.

## Required Gates

Before shipping an agent-producing change, verify:

1. The manifest or API payload includes `visibility`.
2. `installed_agents.visibility` stores the same class after install/import/sync.
3. `private` agents are absent from desktop marketplace search, cargo import, Library,
   CLI `list`, and generated package artifacts.
4. `background` agents can still run internally but are absent from user-facing pickers.

Do not put proprietary agent names, prompts, or private source text in public docs.
Use neutral role descriptions or hashed fingerprints in code when a deny-list is needed.
