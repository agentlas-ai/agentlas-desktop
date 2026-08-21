# Agentlas Plugin Specification (`agentlas.plugin/v2`)

**Canonical location** `agentlas_desktop/docs/PLUGIN-SPEC.md` · **Gate** `agentlas_desktop/scripts/plugin-spec-gate.cjs`

This document is the **single source of truth**. When Desktop, Terminal, or the Hub needs an answer
about plugins, the answer comes from here. Terminal vendors the Desktop core, so it keeps a pointer
to this file rather than a copy.

---

## 0. What a plugin is

> **An Agentlas plugin is a capability package that any runtime and any agent inside Agentlas
> Desktop or Terminal can use identically and invoke explicitly.**

Consequences that follow directly from that definition:

| | Plugin | Third-party service MCP |
|---|---|---|
| Who uses it | **Every agent identically** — One, built-in, local, Hub-rented | only runs that attached that server |
| Invocation | `@slug` explicit + optional implicit | tool name only |
| Account | none by default | OAuth or a key, usually |
| What it is | a capability package (tools + procedure + state) | one line of connection info |
| Runtime dependence | **none** | only runtimes that can receive MCP |

### 0.1 The two things a plugin can provide

A plugin provides **at least one** of these. Both is fine.

- **`tools` — a tool provider.** Ships an executable capability. `agentlas-browser`,
  `agentlas-computer-use`.
- **`skills` — a procedure provider.** Ships "which tool to use, when, in what order". Markdown.

**There is an important asymmetry.** A procedure provider does not create tools — it calls tools the
host already has, by name. That is why a procedure plugin contains nothing but markdown, and why
runtime independence holds **automatically**. A tool provider is a stdio process, which is likewise
runtime-agnostic.

### 0.2 What is NOT a plugin — host internal services

Not every MCP row in the catalog is a plugin. Only a capability **the user knows about and chooses**
is a plugin. Plumbing the app uses for its own features is classified `host-service` and stays out of
the plugin list.

| | Plugin | Host internal service |
|---|---|---|
| Does the user know it exists | yes — listed, invoked with `@` | no |
| If disabled | that capability disappears | **an app feature breaks** |
| Example | `agentlas-browser`, `agentlas-computer-use` | `hephaestus-network` |

Evidence that `hephaestus-network` is the latter (measured 2026-08-21):
`electron/mcp/workforce-orchestrator.ts:2783` — `installedWorkforceHubMcp()` looks up the installed
row by `catalogId === "hephaestus-network"` to call Hub tools, and fails with
`"Hephaestus Network MCP is not installed or enabled."` when it is absent.
`electron/mcp-tools/client.ts:48` hangs the workforce protocol contract check on that same id. It is
not something the user opts into — the app always needs it.

Host internal services are out of scope for this spec. They remain catalog rows and carry no plugin
package.

### 0.3 Non-goals

- A plugin **is not an agent.** It owns no system prompt, persona, or memory.
- A plugin **is not an MCP server.** MCP is one of several ways a tool gets delivered.
- A plugin **never carries credential values.** It declares environment variable *names* only.

---

## 1. Directory layout

### 1.1 Distribution package (what an author writes)

```
<slug>/
├── plugin.json                 # manifest — the only required file
├── README.md                   # human-facing intro (recommended)
│
├── skills/                     # procedure provider
│   ├── index/
│   │   └── SKILL.md            # ★ router — required whenever skills exist
│   ├── <workflow>/
│   │   ├── SKILL.md
│   │   ├── policy.json         # per-skill activation/permission policy (optional)
│   │   └── references/*.md
│   └── ...
│
├── references/*.md             # shared reference documents
│
├── bin/                        # tool provider — the executable
│   └── <entry>.mjs
│
├── scripts/*.mjs               # helper scripts a skill invokes (optional)
├── templates/                  # scaffolding templates (optional)
└── assets/                     # icons and logos (optional)
    ├── icon.svg
    └── logo.png
```

### 1.2 Installed form (what lands on the user's machine)

```
~/.agentlas/plugins/<slug>/
├── plugin.json                 # as distributed
├── skills/ … bin/ … assets/    # as distributed
│
├── .install.json               # ★ written by the host — source, version, verification result
└── .state/                     # ★ user data — absent from the package, never deleted
    ├── user-context.md         # what the plugin remembers about the user
    └── assets/                 # files the user supplied (screenshots, etc.)
```

**Rules**

- `.state/` is **never touched** on install, update, or removal — it survives uninstall, so a
  reinstall resumes where the user left off.
- Every top-level entry starting with `.` belongs to the host. Do not ship one.
- Desktop and Terminal read the **same path**. No channel gets its own location.

### 1.3 `README.md` — for people, and only for people

The README explains the plugin to a human reader. It **must not restate machine fields that already
live in `plugin.json`** — permissions, `requires`, `os`, schema, slug, invocation mode. Two copies of
the same fact drift, and the copy a human edits is the one that goes stale.

**Belongs in the README**
- what the plugin is for, in a sentence
- the workflow table: skill name → what it does (this is the one thing `plugin.json` cannot express
  well, and the most useful thing a reader wants)
- prerequisites a *person* must act on ("grant Screen Recording in System Settings")
- known limitations

**Does not belong in the README**
- a `## Runtime & Requirements` section transcribing `permissions` / `requires` / `os`
- the schema string, slug, or `implicit` mode
- anything the gate already checks

This rule exists because it was violated on first contact: a generated package restated `requires`
in prose and got it wrong in the process — `win64` for `win32`, and `prereq: ["node"]` where the
schema takes `[{ id, provided-by }]`. Prose copies of machine facts do not merely duplicate; they
diverge silently. G15 now checks those two fields, but the README is where the divergence started.

### 1.4 Built-in plugins (shipped with the app)

```
agentlas_desktop/plugins/<slug>/     ← inside the repo (git-tracked); bundled as an app resource
```

They are materialized idempotently into `~/.agentlas/plugins/<slug>/` at boot, and restored on the
next boot if the user deletes them. A built-in declares `"builtin": true`.

---

## 2. `plugin.json` — the manifest

```jsonc
{
  "schema": "agentlas.plugin/v2",
  "slug": "design",                      // [a-z0-9][a-z0-9-]{1,63} — install path, mention name,
                                         // and assignment key. Immutable.
  "name": "Design",
  "version": "0.1.0",                    // semver
  "builtin": false,                      // true when bundled with the app

  "publisher": { "name": "Agentlas", "url": "https://agentlas.cloud" },

  // ── what the user sees ───────────────────────────────
  "surface": {
    "displayName": "Design",
    "displayNameKo": "디자인",
    "tagline": "Explore and prototype ideas",
    "taglineKo": "…",
    "description": "…",
    "descriptionKo": "…",
    "category": "design",                // design|dev|data|web|productivity|communication|custom
    "brandColor": "#FF66AD",
    "icon": "assets/icon.svg",           // package-relative
    "defaultPrompts": [                  // dropped verbatim into the composer. Not a function.
      "Turn this product idea into three visual directions"
    ]
  },

  // ── how it gets invoked ──────────────────────────────
  "invocation": {
    "mention": "@design",                // derived from slug; may be omitted
    "implicit": "router",                // never | router | always
    "standalone": true                   // callable from chat without an agent assignment
  },

  // ── what it provides (at least one) ──────────────────
  "provides": {
    "skills": {
      "router": "skills/index/SKILL.md", // the only skill that is always loaded
      "workflows": ["get-context", "ideate", "audit", "share"]
    },
    "tools": [
      {
        "id": "agentlas-browser",
        "capability": "browser",         // browser|computer-use|agent-routing|time|data|custom
        "kind": "stdio",                 // stdio | builtin | http
        "command": "${node}",            // ${node} = bundled node, ${pluginDir} = install path
        "args": ["${pluginDir}/bin/browser-cdp.mjs"],
        "envKeys": [],                   // names only, never values
        "timeoutMs": 120000,
        "surface": { /* §2.8 */ }
      }
    ]
  },

  // ── what must exist for it to run ────────────────────
  "requires": {
    "tools": ["browser"],                // capability names; the host says so up front if missing
    "prereq": [{ "id": "node", "provided-by": "app" }],
    "os": ["darwin", "win32", "linux"]
  },

  // ── boundaries ───────────────────────────────────────
  "permissions": {
    "fileWrite": "project-only",         // none | project-only | ask | full
    "network": "ask",                    // none | ask | allow
    "shell": "deny"                      // deny | ask | allow
  },

  // ── state ────────────────────────────────────────────
  "state": { "files": ["user-context.md"], "assets": true },

  // ── integrity ────────────────────────────────────────
  "integrity": {
    "algo": "sha256",
    "files": [{ "path": "skills/index/SKILL.md", "sha256": "…", "bytes": 4211 }]
  }
}
```

### 2.1 Field rules

- **`slug` is identity.** Install path, mention name, and agent-assignment key are all this value.
  It cannot change.
- **An empty `provides` is rejected at install.** Rows that advertised names with nothing behind them
  once numbered 22, and both installers refused every one. The spec now blocks that up front.
- **`integrity.files` must cover every file.** A file present in the package but absent from the list
  fails install. (Because the hash travels in the same channel as the content, this is **transport
  integrity, not an authorship signature.** Authorship is claimed only by the source URL recorded in
  `.install.json`, and this spec states that limit rather than hiding it.)
- **`envKeys` are names.** A value in the manifest fails install.

### 2.2 `invocation.implicit`

| Value | Meaning | When |
|---|---|---|
| `never` | `@slug` only | expensive or high-consequence |
| `router` | the model opens it only when the router's `description` matches | **default, recommended** |
| `always` | the router is always in context | built-in tool providers |

### 2.3 Tool resolution — `kind` and `resolver`

| kind | command/args |
|---|---|
| `stdio` | declared as strings in the manifest |
| `builtin` | **the host builds them** — declare only a `resolver` name |
| `http` | declare a `url` |

```jsonc
{ "id": "cua-driver", "capability": "computer-use",
  "kind": "builtin", "resolver": "computer-use",
  "form": "inline" }                          // §2.4 — the form is stated explicitly

{ "id": "agentlas-browser", "capability": "browser",
  "kind": "builtin", "resolver": "browser-cdp",
  "form": "materialized", "contract": 2,      // materialized form requires a contract (INV-7)
  "upstream": {                                // the server it wraps (INV-8)
    "package": "@playwright/mcp",
    "resolution": "host-injected-at-materialize",
    "onMissing": "fail-loud"
  },
  "gate": "irreversible-actions",              // its own approval gate (INV-9)
  "recipes": { "dir": "~/.agentlas/browser-skills", "format": "agentlas.recipe/v1" } }
```

`form` is **required** on `builtin` tools. Omitting it reproduces the uniformity failure in §2.4
exactly.

`resolver` is a closed list the host owns (`browser-cdp`, `computer-use`, `system-time`,
`hephaestus-cli`). A third-party plugin cannot use `kind: "builtin"` — it is valid only inside a
`builtin: true` package, and rejected otherwise (G9).

### 2.4 There are **three** executable forms — do not unify them

> **This is the most fragile clause in this specification.** Writing a uniform "every executable is a
> file plus a manifest" contract makes at least one of these three lose its guarantee.

| Form | What it is | Where the guarantee comes from | Example |
|---|---|---|---|
| `materialized` | a file the host bakes into `~/.agentlas/<name>.mjs` | contract version + downgrade refusal | `agentlas-browser` |
| `inline` | audited source carried **in argv** | **there is no disk path to swap** | `computer-use`, `agentlas-time` |
| `provisioned` | an executable the app **installs and updates separately** in the runtime home | package version + honest failure when absent | `hephaestus-network` |

`provisioned` was added from measurement. `hephaestus-network` runs as
`~/.agentlas/runtime/current/bin/hephaestus mcp serve` — neither baked by the host nor inlined into
argv. It lives in a runtime home written by **two programs**: the installer and the updater. That
gives it a failure mode of its own — a payload added to only one of them silently disappears on
machines that updated. A `provisioned` tool declares `provisionedBy`, and must not degrade quietly
when its executable is missing.

#### Invariants (INV)

Each carries its measured evidence. An invariant without evidence does not belong here.

**INV-1 · Source carried in argv stays in argv.**
`computerUseMcpLaunchArgs()` is `["-e", INLINE_BOOTSTRAP, INLINE_PAYLOAD]`. The bootstrap gunzips,
then `process.exit(78)` if `b.length > 131072 || sha256(b) !== SOURCE_SHA256`, and only then calls
`vm.runInThisContext` (`electron/computer-use/mcp-server.ts:317-321`). The point is not encryption —
it is **the absence of any path that can be reopened**. A spec that forces these into files destroys
the guarantee.

**INV-2 · Authenticity is recomputed, never stored.**
`isAuthenticComputerUseMcpLaunch` (`mcp-server.ts:338`) rebuilds `computerUseMcpLaunchArgs()` on the
spot and compares bytes. Caching "this row is authentic" in a store or config turns verification into
a **stored claim**, which is worthless.

**INV-3 · The argv budget is part of the authenticity predicate, not a warning.**
`AGENTLAS_COMPUTER_USE_INLINE_ARGS_MAX_JSON_CHARS = 24_000` (`mcp-server.ts:324`) feeds
`computerUseMcpLaunchWithinBudget()`, which feeds the authenticity check. Exceeding the budget does
not produce an error — it produces **"not authentic"**, and the branch at `mcp-config.ts:523-531`
quietly falls back to the wrapper path. Re-measure the budget every time the executable source grows.

**INV-4 · Authenticity is not permission to run — it is *wrapper-bypass privilege*. Failure is
fail-to-wrapper, not fail-closed.**
`mcp-config.ts:523`: only when there are zero secret aliases *and* authenticity holds does the host
bypass the mutable per-run child wrapper and use the inline launch as-is. Otherwise it goes through
the wrapper. A forged row is not silently executed — it **loses a privilege**. Do not "harden" this
into fail-closed; that kills legitimate runs.

**INV-5 · There is exactly one credential drawer.**
The profile path comes only from `browserCdpProfilePath()`. Letting an adapter or plugin config
choose the profile path reproduces the 2026-08-19 incident, where the `playwright` row created a
**second profile** via `--user-data-dir ~/.agentlas/browser-profile`, so a user signed in to Agentlas
Browser was driven in a window with zero logins (`catalog.ts:310-316` comment).

**INV-6 · Do not remove CDP ownership adjudication from in front of attach.**
The launcher finds the listener, confirms that listener's command line carries the same
`--user-data-dir` and `--remote-debugging-port`, cross-checks a 0600 marker (pid/port/profile), and
classifies as `absent | owned | adoptable | foreign | unverifiable`. Simplifying this to "attach to
the endpoint" opens a path to **attaching to somebody else's 9222**.

**INV-7 · Materialization carries a contract version and refuses downgrades.**
Line 3 of the launcher is `// @agentlas-browser-cdp-contract 2`, and
`materializeBrowserCdpLauncher()` **keeps** the installed file when its contract is higher
(`browser-cdp-launcher.ts:1249-1253`). Any new materialization path must inherit this rule, or an
older app silently downgrades a newer user's launcher.

**INV-8 · The upstream path is injected, not resolved.**
`PLAYWRIGHT_MCP_CLI` is baked in as a string at materialization time from `require.resolve`
(`browser-cdp-launcher.ts:901`). The comment states it: *never resolve or download at run time*
(`:24`). Resolving at run time introduces version drift and a network dependency at spawn.

**INV-9 · The approval file path is not plugin-settable.**
`AGENTLAS_BROWSER_APPROVAL_FILE` is validated as absolute and consumed **read-only** (launcher
`:442`). If a plugin could choose this value, the approval gate would be void. Only the host writes it.

### 2.5 `upstream` — the server being wrapped

Used only when a plugin executable **wraps** another MCP server.

```jsonc
"upstream": {
  "package": "@playwright/mcp",
  "resolution": "host-injected-at-materialize",   // the only accepted value (INV-8)
  "onMissing": "fail-loud"                        // the only accepted value
}
```

- `resolution` accepts nothing but `host-injected-at-materialize`. A run-time `require.resolve` or
  download introduces version drift and a spawn-time network dependency.
- `onMissing: "fail-loud"` is a requirement, not a label. A missing upstream must not degrade
  silently. The reference implementation dies immediately with
  `Bundled Playwright MCP runtime is missing: <path>`.

### 2.6 `gate` — the irreversible-action gate

Declares that the executable holds an approval gate **inside its own proxy**.

```jsonc
"gate": "irreversible-actions"
```

When declared, the host **injects** the approval channel file path as an environment variable. The
plugin cannot choose that path (INV-9).

What the gate does is refuse: a refused call is **never seen by the upstream server**. The refusal
must then be reported honestly to the model. The reference implementation's wording:

> `DENIED: The user declined this <kind> browser action. The action was not executed.
> Do not say approval is still pending and do not retry it in this run.`

Blurring this into "approval still pending" makes the model retry, or claim it succeeded.

### 2.7 `recipes` — learned and replayed procedure

A **different kind of procedure** from `skills` (markdown the model reads and judges). Recipes record
a successful tool-call sequence and replay it deterministically, without inference.

```jsonc
"recipes": { "dir": "~/.agentlas/browser-skills", "format": "agentlas.recipe/v1" }
```

Recipe file (`agentlas.recipe/v1`):
```json
{ "name": "instagram-upload", "description": "…", "savedAt": "2026-07-07",
  "steps": [ { "name": "browser_navigate", "arguments": { "url": "…" } } ] }
```

An executable that declares `recipes` **adds** three tools of its own to the upstream tool list —
one to list, one to save, one to replay. The executable owns those names; the manifest does not
dictate them, because renaming a live tool breaks every saved automation that calls it.

The reference implementation names them `browser_skill_list` · `browser_skill_save` ·
`browser_skill_replay` (verified against a running instance 2026-08-21: 27 tools exposed, these
three among them).

> **Naming caveat.** Those tools say "skill", but they are **not** the `SKILL.md` procedures of §3.
> §3 skills are markdown a model reads and reasons about; these are recorded call sequences replayed
> without inference. This spec calls the manifest field `recipes` to keep the two apart in writing,
> while the live tool names stay as they are.

**The gate stays live during replay.** The reference implementation stops mid-replay when the gate
fires and returns `Replay stopped — <kind> action needs approval`. Being a saved sequence never
skips approval.

### 2.8 `provides.tools[].surface` — per-tool presentation

One plugin can expose several tools, and each appears **separately** in the UI. Presentation
therefore lives on the tool, not only on the plugin.

```jsonc
"surface": {
  "name": "Agentlas Browser (real login)",   // localized display name
  "nameEn": "Agentlas Browser (real login)",
  "description": "…", "descriptionEn": "…",
  "category": "web",
  "brandColor": "#1D7E67",
  "mark": "AB",                              // 1–2 character monogram for the tile
  "docsUrl": "https://github.com/microsoft/playwright-mcp"
}
```

Required on every tool, because the host builds the catalog row from it (§4).

---

### 2.9 `hostChannels` — capabilities the host injects at spawn

A tool can be attached, list its tools, and still refuse to do anything. Between "the tool is
attached" and "the tool works" sits one more step: **the host injects a capability the executable
cannot obtain for itself.**

Measured 2026-08-21: spawning `cua-driver` with the exact command and args this spec produces, then
calling `computer_status`, returns

```
-32603  Agentlas Computer Use control capability is unavailable.
```

because `AGENTLAS_COMPUTER_USE_CONTROL_FILE` was absent (`computer-use/mcp-server.ts:134-136`). The
tool list was complete and every argument was correct. Nothing was wrong except a missing channel.

```jsonc
"hostChannels": [
  { "id": "control", "env": "AGENTLAS_COMPUTER_USE_CONTROL_FILE", "mode": "read-only" }
]
```

Rules:

- The manifest declares the **env var name only**. The host decides the path and writes it
  (`mcp-config.ts:498-503`). A plugin that could choose this path could void its own gate (INV-9).
- `mode` is `read-only`. The executable reads the channel; it never writes it.
- Only `builtin: true` packages may declare `hostChannels`. A third-party plugin asking the host for
  a capability channel is asking to be trusted like a built-in.
- **A tool without the channel it needs must fail loudly**, as computer-use does above. Degrading
  into a no-op would make "attached" indistinguishable from "working".

Today the host picks these channels by a hard-coded `catalogId` branch. This field is what lets that
branch be derived from the package instead.

## 3. `SKILL.md` format

### 3.1 Router — `skills/index/SKILL.md`, required whenever skills exist

```markdown
---
name: index
description: "One paragraph on when this plugin applies. The model decides whether to open it from this sentence alone."
---

# Skill Purpose

What this router does, in one line. **The router does no work — it picks the next skill.**

# Plugin Purpose

The problem this plugin solves.

## Routing

- requests like "…" → `$get-context` → `$ideate`
- requests like "…" → `$audit`

If the user names a specific skill, open exactly that one. Never substitute a related skill.

## Tools

Which host tools this plugin uses, and **in what order of preference**:

- a page requiring login → `@agentlas-browser`
- a capture needing no login → `@playwright`
- driving a desktop app → `@computer-use`

If a tool is unavailable, **say so and stop.** Never pretend the work was done with a tool you lacked.

## Critical Overrides

- Follow `$critical-overrides`.
```

### 3.2 Workflow skill — `skills/<name>/SKILL.md`

```markdown
---
name: audit
description: "When this skill applies."
---
# Skill Purpose
# Preconditions      ← what has to happen first
# Steps              ← the order. This is what the plugin is worth
# Outputs            ← what it leaves behind
# Verification       ← what is checked before claiming it was done
```

**`Verification` is not optional.** There is a measured incident where an automation wrote "3 replies
posted" and nothing had been posted. A skill that claims an output must state what verifies that
claim (enforced by G7).

### 3.3 Reference syntax

- `$skill-name` — another skill in the same plugin
- `$reference-name` or `[name](../../references/name.md)` — a shared reference document
- `@tool-name` — a host tool

The host resolves all three into real paths. **Authors never write absolute paths.**

---

## 4. Host wiring

### 4.1 As measured (2026-08-21)

| | Today | Problem |
|---|---|---|
| Plugin representation | `McpToolCatalogEntry` | no field can hold a procedure |
| Agent assignment | `agent_mcp_servers` | **Desktop never reads it at run time** (only Terminal does) |
| Skill delivery | lands in `~/.agentlas/plugins/<slug>/skills/` | **zero readers** — only directory names are counted |
| Publishing | hard-coded array in `catalog.ts` | no third-party publishing |

### 4.2 The target

```
plugins(slug PK, version, builtin, manifest_json, install_source, installed_at, enabled)
plugin_tools(slug, tool_id, capability, server_id)
agent_plugins(agent_id, plugin_slug)      -- ★ replaces agent_mcp_servers
```

The assignment key is a **plugin slug, not a server id**. That is what lets procedure plugins attach
at all.

Run assembly:
```
resolve agent
  → read agent_plugins
  → + any explicitly mentioned @slug
  → + builtin plugins with implicit "always"
  → place each plugin's `provides` per channel:
       tools  → MCP config / in-process tool loop
       skills → router only into context; the rest exposed as paths
  → run
```

**Capability supersession.** When two tools share a capability and only one receives a host
channel (§2.9), the one without it has a strictly smaller capability. In auto mode the host drops
the subset in favour of its peer, and says so in the log — a capability that disappears silently
reads as "the tool never existed" the next time somebody debugs it.

Two conditions bound the rule, both of them load-bearing:

- **The peer must be installed AND enabled.** Dropping a subset whose superset is absent does not
  upgrade the capability, it deletes it. `supersededByLivePeer()` is an exported pure function
  precisely so this half can be tested (`scripts/plugin-channel-supersession-gate.cjs`).
- **An explicit pin outranks it.** A pin is a settings-level decision by the user.

The live case: `playwright` and `agentlas-browser` run the same launcher against the same Chrome
profile and expose the same 27 tools, but only `agentlas-browser` is handed
`AGENTLAS_BROWSER_APPROVAL_FILE`. Without it the launcher's `requestApproval` resolves `denied`
(`AGENTLAS_BROWSER_AUTONOMY` defaults to `gated`), so `playwright` can be refused but can never
complete an irreversible action. Letting judgment pick it in auto mode means failing at the approval
step for a reason the model was never told.

The mapping is derived from the manifests, never from an id comparison — mutation-tested by removing
the `hostChannels` declaration and asserting the mapping disappears.

For built-in tool providers the host derives the catalog row from the package (§2.8 surface +
§2.3 resolver), so **the package is the source of truth and the catalog is generated** — never two
hand-maintained copies.

Install sources are all accepted: local directory or tarball, git URL, Hub manifest. `.install.json`
records which one:
```json
{ "source": { "kind": "git", "url": "…", "ref": "v0.1.0" },
  "installedAt": "…", "verified": true, "manifestSha256": "…" }
```

### 4.3 Migration

1. Move `agent_mcp_servers` → `agent_plugins` (server id → the slug of the plugin providing it).
   Migrate the schema even when the table is empty.
2. Rewrite the built-ins as plugin packages (§5).
3. Everything else in the catalog stays a `third-party` MCP — **it is not a plugin.** Separate it in
   the UI too.

---

## 5. Built-in plugins

Of the five ids in `DEFAULT_MCP_CATALOG_IDS`, **three are plugins**. `hephaestus-network` is excluded
as a host internal service (§0.2).

`agentlas-browser` and `playwright` were **two rows launching the same CDP launcher**, so they are two
tools of one plugin.

| Plugin | Tools | capability |
|---|---|---|
| `agentlas-browser` | `agentlas-browser`, `playwright` | browser |
| `agentlas-computer-use` | `cua-driver` | computer-use |
| `agentlas-time` | `agentlas-time` | time |

All three are `"builtin": true` with `"invocation": { "implicit": "always" }`.

### 5.1 Merging happens at the **plugin** level, never at the tool-id level

`agentlas-browser` and `playwright` are 100% identical in execution — both `command: process.execPath`,
`args: ["~/.agentlas/agentlas-browser-cdp.mjs"]`. Only id, name, description, brandColor
(`#2EAD33` vs `#1D7E67`) and mark (PW vs AB) differ (`catalog.ts:304-344`).

**Even so, neither tool id may be deleted.** Two measured reasons:

1. **Installed identity.** `mcp_servers.catalog_id` exists (`store/db.ts:1323`), so existing
   installations hold rows keyed `playwright`. Deleting the catalog entry orphans them.
2. **Seven consumers branch on that id** (measured 2026-08-21):
   `mcp-tools/defaults.ts:14,47` · `mcp-tools/client.ts:500,920` ·
   `mcp-tools/auto-select.ts:133,453,454` · `mcp-tools/mcp-config.ts:495` ·
   `system-agents/automation-supervisor/index.ts:21` · `renderer/…/RuntimeReadiness.tsx:48`.
   Note `auto-select.ts:453-454`, which gives the two ids **different meanings** per toolMode.

So §5 merges the outer container while both tool ids stay alive. Reversing that order — merging the
tools first — breaks those seven sites and every existing installation.

**And they are not, in fact, fully identical.** Their *launch* is; their *environment* is not.
`mcp-config.ts:498-503` injects `AGENTLAS_BROWSER_APPROVAL_FILE` for `agentlas-browser` and nothing
for `playwright`. The consequence is visible in the launcher: with no approval channel,
`requestApproval` resolves `trustFallback ? "approved" : "denied"`, and `AGENTLAS_BROWSER_AUTONOMY`
defaults to `gated`, so `trustFallback` is false — **denied** (launcher `:466`).

That is fail-closed, not a bypass, and it is the right default. But it means the two ids differ in
capability: `agentlas-browser` can carry out an irreversible action after the user approves it,
while `playwright` can only be refused. §2.9 `hostChannels` is where that difference should be
declared rather than living in a hard-coded branch.

---

## 6. Authoring checklist

1. Fix the `slug`. It cannot change.
2. Fill `surface` and `invocation`.
3. **Decide what it provides** — procedure, tools, or both.
4. For procedures, write `skills/index/SKILL.md` first. Its `description` is the entire activation
   condition.
5. Write the workflow skills. Every one needs `Steps` and `Verification`.
6. Declare host tools in `requires.tools`, and put the **preference order** in the router's `## Tools`.
7. Declare `state.files` if the plugin remembers anything. Never write outside `.state/`.
8. Generate `integrity.files` for every file.
9. Pass the gate below.

### 6.1 Gates (install is refused on any failure)

| # | Check | Why |
|---|---|---|
| G1 | `provides` is non-empty | the 22 name-only rows |
| G2 | router exists; its frontmatter `description` is non-empty | without it nothing ever opens |
| G3 | every `$reference` resolves to a real file | a dead link is a dead procedure |
| G4 | `integrity.files` covers every file (**`builtin:true` exempt** — the signed app bundle vouches) | files outside the list are unverified code |
| G5 | no values in `envKeys`; no `.env`-like files in the package | credential leakage |
| G6 | every `requires.tools` capability exists on the host | a procedure calling a tool that isn't there |
| G7 | any skill claiming `Outputs` has a `Verification` section | automations that only *say* they did it |
| G8 | `.state/` is absent from the package | overwriting user data |
| G9 | `kind:"builtin"` only in `builtin:true`; `resolver` inside the host's closed list | third parties borrowing host execution paths |
| G10 | `kind:"builtin"` tools declare `form` (`materialized`\|`inline`\|`provisioned`) | the §2.4 uniformity failure |
| G11 | `materialized` declares `contract`; `provisioned` declares `provisionedBy` | INV-7 · the two-writer runtime home |
| G12 | `upstream.resolution` is `host-injected-at-materialize`, `onMissing` is `fail-loud` | INV-8 |
| G13 | `gate`/`recipes` only in `builtin:true`; `gate` carries no path | INV-9 — the host injects the channel |
| G14 | every tool declares a `surface` with valid `name`, `description`, `category`, `brandColor` (#RRGGBB), `mark` (1–2 chars) | the host generates the catalog row from it (§4.2) |
| G16 | `hostChannels` only in `builtin:true`; `env` is a NAME (no path/value); `mode` is `read-only` | §2.9 — a plugin that picks the path can void its own gate |
| G15 | `requires.os` uses `process.platform` values; `requires.prereq` entries are `{id, provided-by}` with `provided-by` in `app\|user\|os` | hand- and model-authored manifests drift into plausible-but-wrong values (§1.3) |

**Run it**

```bash
node scripts/plugin-spec-gate.cjs                 # every package under plugins/
node scripts/plugin-spec-gate.cjs <package-dir>   # just one
```

This gate is what keeps the spec from being paper. When a sentence here changes, the gate changes in
the same commit. A rule without a gate is a hope, not a rule.

Negative-tested 2026-08-21 in three passes: 12 seeded violations caught by G2·G3·G4·G5·G6·G7·G8·G9;
7 more by G10·G11·G12·G13; and the two real mistakes from the first generated package
(`win64`, `prereq: ["node"]`) plus three malformed surfaces by G14·G15.

---

## 7. Deliberately out of scope

- **Authorship signatures.** `integrity` covers transport only. A signing-key scheme belongs to v3.
- **Sandboxing.** `permissions` is a declaration; enforcement is the host's existing approval arbiter
  (`runtime/tool-approval.ts`). There is no plugin-specific isolation boundary yet.
- **Paid plugins.** Billing belongs to the Hub economy contract.

---

## Appendix A. `agentlas.plugin/v1` → `/v2`

| v1 | v2 |
|---|---|
| `schema: "agentlas.plugin/v1"` | `schema: "agentlas.plugin/v2"` |
| `mcp: [{name, transport, url/command, envKeys}]` | `provides.tools[]` |
| `skills: [{name, files[]}]` | `provides.skills` + the package `skills/` tree |
| `agents: [{role, intent}]` | removed — a plugin is not an agent |
| `pluginKind: "mcp"\|"skill"` | removed — `provides` states it |
| `runtimes: ["terminal","desktop"]` | removed — those were channels, not runtimes |
| `install: {cli, deepLink}` | moved to `.install.json` on the installed copy |
