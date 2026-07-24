<p align="center">
  <img src="assets/agentlas-desktop-banner.svg" alt="Agentlas Desktop banner">
</p>

<h1 align="center">Agentlas Desktop</h1>

<p align="center">
  <strong>We are Agent Trust. Your agent is not a program. It is an asset. — Agentlas —</strong>
</p>

<p align="center">
  Build the agent you need, borrow a public Hub specialist, and run it through a supported LLM and computer you choose.<br>
  Agentlas Desktop is the primary local GUI runtime: model calls, tool use, file access, and credentials stay under that host's permissions.
</p>

<p align="center">
  Agent Cloud stores and restores your private, owner-scoped agent packages. Hub publication is a separate public action.<br>
  <sub><strong>Agent Trust</strong> is a product principle for ownership and portability, not a financial, legal, custody, or fiduciary service.</sub>
</p>

<!-- ── Download (primary action) ───────────────────────────────────────── -->
<p align="center">
  <a href="https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest">
    <img alt="Download for macOS — Apple Silicon" src="https://img.shields.io/badge/Download_for_Mac-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest">
    <img alt="Download for macOS — Intel" src="https://img.shields.io/badge/Download_for_Mac-Intel-555555?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest">
    <img alt="Download for Windows" src="https://img.shields.io/badge/Download_for-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white">
  </a>
  <a href="https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest">
    <img alt="Download for Linux" src="https://img.shields.io/badge/Download_for-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black">
  </a>
</p>
<p align="center">
  <sub>Free · open source (Apache-2.0) · Agentlas sign-in connects the app, Cloud, and Hub · your LLM subscription and API credentials stay local · prefer a standalone terminal? <a href="https://github.com/agentlas-ai/agentlas-terminal">Agentlas Terminal ↗</a></sub>
</p>

<p align="center">
  <a href="https://agentlas.cloud">agentlas.cloud</a>
  ·
  <a href="https://agentlas.cloud/desktop">Desktop page</a>
  ·
  <a href="https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest">Download</a>
  ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest">
    <img alt="Latest stable release" src="https://img.shields.io/github/v/release/agentlas-ai/agentlas-desktop-releases?label=download&color=blue">
  </a>
  <a href="LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green">
  </a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex%20%7C%20Gemini%20%7C%20Grok%20%7C%20Ollama%20%7C%20BYOK-black">
</p>

<p align="center">
  <img alt="Agentlas Desktop running a CEO agent over a live org chart" src="docs/screenshot.png" width="960">
</p>

## Release log

Canonical release history lives in [CHANGELOG](CHANGELOG.md) and the
[Releases page](https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest) (the public download/auto-update channel).
This README keeps the newest source release note. The Releases page remains the
authority for which version is actually public, stable, and downloadable.

- **2026-07-25 · v0.9.12 — owner-scoped borrowed-agent memory nests (schema v78)** —
  borrowed agents keep an owner-scoped memory nest so portable skills carry between your
  projects while project-identifying details stay quarantined to their origin project; schema
  upgrades to v78 (additive, idempotent, existing memory preserved).
  This release binds Agentlas OS v1.1.58 at 47e2368e5c775d6345118c6409850872ec647738.
  This source note does not prove a Desktop Git tag, public installer, GitHub release, or
  update feed.
- **2026-07-24 · v0.9.11 — memory architecture rework: team-member cells, memory import, self-evolution firing** —
  team members become first-class memory/experience owners (schema v75, slug-preserving
  migration so existing member memory links); an "Import existing memory" action (My Agents
  + `agentlas memory import`) turns legacy markdown into Agentlas memory; self-evolution now
  fires on normal runs with trust tiers (low-risk auto-apply + undo, high-risk approval) shown
  on Dashboard, One, and the terminal; the memory relation graph densifies with `similar_to`
  edges; and a Project memory status panel makes PM-soul/code-map/sitemap usage visible. This
  release binds Agentlas OS v1.1.58 at `47e2368e5c775d6345118c6409850872ec647738`. This source
  note does not prove a Desktop Git tag, public installer, GitHub release, or update feed.
- **2026-07-24 · v0.9.10 — provider cards, Hub card cleanup, team-member intake fix** —
  the dashboard LLM connections/usage becomes a responsive grid of collapsible
  provider cards, Hub agent cards drop the first-letter tile for a text- and
  button-focused layout, and experience intake no longer FK-throws for team
  org-chart members bound by slug. This release binds Agentlas OS v1.1.58 at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.
- **2026-07-24 · v0.9.9 — experience map load fix, independent library panes, Hub shelf** —
  fixes the Experience map failing to load for every agent (a stale
  `taste_draft_candidates.statement` column threw a SqliteError), makes the
  agent roster and detail panes scroll independently, surfaces bookmarked and
  recently-borrowed Hub agents/teams in My Agents, and tidies the LLM
  connections/usage box so version text no longer wraps. This release binds
  Agentlas OS v1.1.58 at `47e2368e5c775d6345118c6409850872ec647738`. This
  source note does not prove a Desktop Git tag, public installer, GitHub
  release, or update feed.
- **2026-07-24 · v0.9.8 — experience system rework, clustered Experience Map, One home launcher** —
  experience intake now redacts privacy spans instead of discarding memories
  (secrets stay hard-blocked), successful interactive runs auto-promote
  candidates with durable run receipts, builtin agents accrue local
  experience, and owner-reviewed public unseal makes sellable chips real. The
  3D map clusters by task type with readable cluster labels and stable
  coordinates; terminology is unified (Experience / Experience Chip / Equip);
  the library roster gains usage and bookmark badges (schema v74). One home
  now offers actionable use-case chips with a resume-first rotation slot and
  in-One automation creation, on top of the Work/One surface separation
  (schema v73). This release binds Agentlas OS v1.1.58 at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove
  a Desktop Git tag, public installer, GitHub release, or update feed.
- **2026-07-23 · v0.9.7 — in-app API-key prompts with honest fallback** —
  when an interactive chat run's matched tool needs a credential that isn't in
  the vault yet, Desktop now shows a key-entry sheet in-app: per-tool grouped
  password inputs with catalog labels, hints, and a setup link. Saving stores
  the value through the existing Keychain env vault and the run reconnects the
  tool right away; declining or timing out continues without it and tells the
  model plainly to use an available alternative or say nothing can substitute.
  Unattended surfaces (automations, agent apps, site studio, Telegram, mobile)
  never pause on this gate, and the event/IPC contract carries key names and
  an outcome only — secret values never leave the vault channel. This release
  binds Agentlas OS v1.1.58 at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove
  a Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-23 · v0.9.6 — automation recovery restored with redaction, not removal** —
  v0.9.5 closed a real gap by deleting the automation recovery/evolution
  feature outright instead of fixing it narrowly. v0.9.6 restores the
  feature and keeps both v0.9.5 protections: failure text is redacted (API
  keys, tokens, passwords, bearer headers, private-key blocks, and full URLs
  reduced to host-only) before it can reach a model prompt, agent memory, or
  an Experience record, and the Hub plug-in bridge still only registers
  connection metadata — it never reads or writes a credential value, so a
  remote MCP still needs a person to enter the key in MCP settings. A failed
  automation again forbids repeating the same approach after two consecutive
  failures, demands an auditable "Strategy change" declaration, and applies
  a verified recovery playbook automatically with notification and one-click
  rollback. This release carries forward the signed updater protections from
  v0.9.4 and binds Agentlas OS v1.1.58 at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove
  a Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-23 · v0.9.5 — safe automation recovery and explicit MCP setup** —
  Hub plug-in discovery remains advisory: a matching Hub listing cannot fetch a
  manifest, register or enable an MCP server, or map a Keychain value into a
  remote request. A remote MCP remains an explicit Settings action. Automation
  retries still require a changed approach after repeated failures, but they
  receive only the failure count—not the prior error body—and they cannot
  autonomously write agent prompts, memories, or Experience records. This
  release carries forward the signed updater protections from v0.9.4 and binds
  Agentlas OS v1.1.58 at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-23 · v0.9.4 — sealed macOS runtime and reliable first relaunch** —
  official macOS installs remove only verified unsigned Python caches, recheck
  the exact Developer ID and Gatekeeper boundary, and make embedded runtime
  files read-only before Python starts. A temporary Keychain delay after an
  update now restores the existing encrypted session in-process without being
  misreported as data recovery or deleting Mobile Bridge pairings; permanent
  auth and local-data violations remain fail-closed. Dashboard readiness also
  no longer opens an empty external Chrome/Edge window just to inspect an
  on-demand browser MCP. This release binds
  Agentlas OS v1.1.58 at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-23 · v0.9.3 — restored macOS automatic updates without reinstalling** —
  macOS update ZIPs now stay owner-writable while Squirrel clears quarantine,
  while every embedded Python launch keeps bytecode caches outside signed
  Resources. The release path rejects read-only updater bytes and rechecks
  extended-attribute removal and the exact signing requirement.
  Agentlas OS v1.1.57 also carries the narrowly scoped recovery bridge for
  v0.8.65/v0.8.66: it preserves the installed app and local data, quarantines
  only the stale ShipIt payload tied to the known cleanup failure, and lets
  Retry or the next restart resume the signed channel once this corrected
  Desktop release is present on the feed. This release binds Agentlas OS v1.1.57 at
  `db4b8a2a788f885b51962c5274bf625da2526ff9`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-22 · v0.9.2 — updater recovery and release metadata repair** —
  macOS updater recovery no longer traverses Electron's virtual `app.asar`
  filesystem while clearing a stale ShipIt payload, so a failed native handoff
  can resume the signed update channel instead of remaining paused. Linux `.deb`
  packaging uses the public Agentlas support contact without embedding private
  developer or source-repository metadata in the application manifest. This
  release binds Agentlas OS v1.1.56 at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-22 · v0.9.0 — browser-capable agents that finish the requested work** —
  Work and One now act with full local execution by default, ordinary browser
  navigation no longer stalls behind a hidden approval sheet, and write-mode
  Codex runs can reach the local browser and HTTP while retaining their
  filesystem sandbox. The runtime now treats cause-only diagnosis as incomplete:
  it must investigate, apply the fix, verify it, and report the result unless a
  concrete missing permission or connection makes action impossible. Automation
  attention messages use customer-facing language instead of raw reconciliation
  telemetry. Payment, unsafe browser code, explicit site denials, remote-mobile
  normalization, and read-only mode retain their stricter boundaries. This also
  carries v0.8.66's restored light One surface, supplied orange pixel-dog assets,
  bundled Playwright MCP host, and atomic ambiguous-action pause. This release
  binds Agentlas OS v1.1.56 at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-22 · v0.8.66 — restored One and repaired bundled browser automation** —
  Restored One's original light surface and visible Work / One switch, replaced
  generated mascot art with exact integer-scaled poses from the supplied orange
  pixel-dog sheet, and removed the generated firewall composite. Agentlas
  Browser now ships its pinned Playwright MCP host inside Desktop instead of
  depending on system Node/npm and a run-time `npx` download. Ambiguous external
  actions are also parked atomically after the first uncertain occurrence rather
  than being scheduled again. This release binds Agentlas OS v1.1.56 at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-22 · v0.8.65 — patched image/URI dependency advisories** — Pinned
  `sharp` to a libvips-patched build and `fast-uri` to a non-vulnerable release
  through `overrides`, without changing the pinned Next.js major, clearing the
  high-severity `npm audit` advisories that were failing the release security
  gate. This carries the unreleased v0.8.62 customer-safe One surface, v0.8.63
  on-device semantic routing, and v0.8.64 automation retry fix. This release
  binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-22 · v0.8.64 — automations retry cleanly after a pre-tool failure** —
  A scheduled automation whose run threw before any external tool ran (for
  example a transient LLM connection error) was being classified as an ambiguous
  side effect and silently suspended, clearing its next run instead of retrying.
  Such a failure has no observed tool receipt and no prepared action, so it is
  unambiguously replay-safe: it now retries on the next slot rather than
  suspending. The scheduled run also records its fire time consistently so the
  next run never lands before the last run. This carries the unreleased v0.8.62
  customer-safe One surface and v0.8.63 on-device semantic routing work. This
  release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-21 · v0.8.63 — on-device semantic agent routing** — One's local
  specialist routing no longer relies on a bag-of-words keyword scorer, which
  could pull an unrelated agent (a café restock note mis-routed to a meme-video
  studio) into a task on incidental term overlap. The verified on-device
  multilingual model (potion-multilingual-128M) now acts as a precision veto over
  local recruitment: a lexical candidate is dropped unless the model is
  semantically confident it fits the request, and One stays solo rather than
  mis-route. This brings the same semantic-vs-incidental discrimination the
  Hub/Cloud ontology gives to fully on-device, privacy-preserving local routing;
  explicitly named agents and machines without the model asset keep working
  unchanged. Covered by a new injected-verdict regression. This release binds
  Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-21 · v0.8.62 — a customer-safe One surface** — One now presents a
  single, calm chief-of-staff voice: a shared customer-safe boundary strips every
  internal runtime, CLI, borrowed-agent, session, and result-schema term before it
  can reach progress, result, or error copy, so a beginner never sees
  `Calling Codex CLI...`, a cross-domain studio name, `runtime-session`, or
  "structured result / exactly one safe One Surface". Progress shows the calm
  five-stage label and a specialist count instead of internal names; failed or
  unvalidated results now say so in plain, honest retry copy. The task-force
  synthesis answer is pinned to the run locale, so an English run never ends in
  Korean product copy regardless of a borrowed agent's default language. A new
  behavioral-plus-source regression (`verify-one-customer-safe-copy`) guards the
  exact leaks captured in the official v2 beta cut, and the One suite is realigned
  to the customer-safe copy. This addresses beta feedback items #1, #2, #3, and #7.
  This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-21 · v0.8.61 — in-app update recovery and verified One onboarding** —
  The AI brain button now serializes its provider state before runtime detection,
  eliminating the delayed-write click race. Closing works immediately even
  during detection, reset clears the full tutorial state, locale reaches real
  starter-team provisioning, and the production renderer test covers the
  Korean flow, official provider return, delayed compare-and-swap writes,
  persistent dismissal, reset, and a narrow English viewport. One uses charcoal
  and mint with a clearly dog-shaped flat 2D mascot and flat artwork only. The
  macOS updater repairs only the known
  generated Python-cache seal mutation in app, rechecks the exact official
  `Developer ID Application: Jeongmin Kim (F469CGM7T5)` identity, and resumes
  normal updating without a website download or reinstall. Agentlas OS v1.1.56
  supplies the digest-verified bridge for affected installed v0.8.58/v0.8.59
  clients; runtime caches may take up to 24 hours to refresh. It is pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-21 · v0.8.60 — reliable One onboarding and sealed macOS updates** —
  One now has a durable close-and-resume control, responsive AI subscription
  and provider choices, visible connection progress, and an explicit limited
  path instead of silent buttons. The One surface and all onboarding scenes use
  charcoal and mint rather than paper, cream, or red, with a flat 2D Las and a
  matching local-device illustration. macOS packages now seal bundled
  Hephaestus and Python resources read-only immediately after app signing, then
  re-verify the pinned designated requirement before packaging, preventing
  runtime bytecode caches from mutating the installed app and triggering false update
  recovery. The official `Developer ID Application: Jeongmin Kim
  (F469CGM7T5)` lineage is unchanged. Agentlas OS v1.1.50 remains pinned at
  `5fc22464c1db33dabc0d4de2170053d1584b5682`. This source does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

- **2026-07-20 · v0.8.59 — One first-run onboarding** — A seven-scene,
  keyboard-accessible tutorial now introduces One in everyday language,
  verifies or limits the selected AI provider through the Desktop main process,
  and provisions a pinned five-agent starter team. Availability is checked
  against the signed-in account and local library before execution; onboarding
  does not present a GitHub payment or invented credit grant. The tutorial uses a calm mint
  visual system, a new local-firewall illustration, reduced-motion support,
  explicit install consent, restart recovery, and a direct handoff into the
  first request. This version publishes Desktop installers for macOS, Windows,
  and Linux; mobile store builds are unchanged. Agentlas OS v1.1.50 remains pinned at
  `5fc22464c1db33dabc0d4de2170053d1584b5682`. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-17 · v0.8.55 — durable Hub Workforce automations on every
  supported computer** — Desktop now speaks the exact versioned Workforce
  protocol published by Agentlas OS, validates the complete MCP tool inventory
  and immutable runtime source, and packages a standalone Python runtime for
  macOS, Windows, and Linux. Scheduled graph runs persist trigger events,
  external-effect receipts, and node checkpoints before advancing, so a posted
  comment is never repeated merely because a later Hub step or app restart
  fails. Typed blocked, input, partial, and refusal outcomes keep the schedule
  enabled and expose a recoverable state instead of silently pausing it.
  Agentlas OS v1.1.50 is pinned at
  `5fc22464c1db33dabc0d4de2170053d1584b5682`. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-17 · v0.8.54 — uninterrupted automations and runtime upkeep** —
  Existing chats, scheduled automations, Site Studio, Telegram, and TREX keep
  their selected session agent under the default local-first Hub policy; only
  an explicit Hub-first policy may construct a new Workforce before that
  target. The usage surface now reports each installed subscription CLI's
  detected version, authoritative latest version, and update state. Supported
  CLI updates run only while the shared chat and automation queue is completely
  idle, and completion is reported only after the installed binary version is
  detected again. Narrow Agent Hub cards also reflow credit badges by card
  width so long names remain readable. Agentlas OS v1.1.48 is pinned at
  `98adf6d1bb0bdad5a919884c3916274d5a3e813f`. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-17 · v0.8.53 — Agent Hub, session-first teams, and live model
  catalogs** — Agent Hub is now a first-class destination in the main navigation,
  using a people-style job-market information architecture:
  Agents, Teams, and Hub plugins share semantic job search, real entity filters,
  callable availability, and a reusable candidate pool. An enabled session
  router keeps the people already attached to that conversation and recruits
  the minimum missing role from Agent Hub or Cloud only when the active model
  identifies a real capability or tool gap. API users can select MiniMax, xAI,
  OpenRouter, Kimi, DeepSeek, GLM, Upstage, Google, OpenAI, Anthropic, or a custom
  compatible provider through live model discovery plus a manual model-ID path;
  version-shaped model and effort lists are no longer compiled into Desktop.
  Popovers now dismiss consistently outside or with Escape, near-white surfaces
  use the shared elevation tokens, and the conversation chip reports loaded
  logical history instead of a fake fixed-window percentage. Agentlas OS
  v1.1.48 is pinned at
  `98adf6d1bb0bdad5a919884c3916274d5a3e813f`. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-17 · v0.8.49 — governed federation and real Mobile Cloud actions** —
  Desktop now sends the required network scope to Agentlas OS v1.1.48,
  unwraps the federation envelope for model choice, and preserves the original
  envelope plus source receipts through validation and execution. The model
  remains the non-deterministic chooser; deterministic code is only the
  evidence governor. The reusable sitemap walker has a conservative default,
  while Desktop explicitly retains the full 25,000-node project budget and
  injects it through the 24MB sitemap read boundary. This release also carries
  the user-identity, project-ontology ingest, empty-layer observability, and
  multilingual memory-retrieval fixes introduced in the 0.8.48 source. A
  paired Mobile client can also preview and privately upload a registered local
  Agent or Team, delete only its Cloud/Hub projection with exact hard-delete or
  soft-unpublish semantics, and create or CAS-update combinations of exact Hub
  releases. A remote Hephaestus build starts only after a per-run native Desktop
  approval; accepted starts are explicitly non-replayable, and an interview turn
  reports structured `awaiting-input` with `resumable: false` instead of fake
  completion. Upload receipt-recovery state and structured Cloud refusal details
  remain visible across the bridge.
  Agentlas OS v1.1.48 is pinned at
  `98adf6d1bb0bdad5a919884c3916274d5a3e813f`. This source is not proof of a
  published installer or update-feed release.

- **2026-07-16 · v0.8.48 — memory recall that actually fills and injects** — A
  sweep of the recall layers found the same failure repeated: real writers and
  generators existed, but a gate never opened or a size cap silently dropped the
  result, so the layer read as empty. Fixed four: a stated preference or
  identity fact ("always use 존댓말") now loads the schema block that tells the
  model to file it as user_identity with high confidence, so it stops being
  demoted to a throwaway note; a chat turn with write authority over a folder now
  kicks off a background ontology ingest, so the folder ontology fills instead of
  staying provisioned-but-empty; the sitemap keeps its complete 25,000-node
  project ceiling and reads through a dedicated 24MB cap, so a large repo's
  sitemap is injected instead of blowing the 2MB text cap; and each layer now warns once
  when it injects nothing. Retrieval itself was proven on 468 real memories:
  Top-1 rose from 58.1% to 69.4% after the multilingual embedding, and Korean
  now reaches English memories that scored worse than random before. Agentlas OS v1.1.48
  is pinned at 98adf6d1bb0bdad5a919884c3916274d5a3e813f. This source does not prove a Desktop tag,
  public installer, or update-feed release.

- **2026-07-16 · v0.8.47 — governed memory and project ontology** — Every
  completed, failed, or cancelled model turn now produces one central Memory
  Ticket and episode. A no-tools semantic Curator may propose what is worth
  retaining, while deterministic privacy, ownership, permission, and project
  boundaries retain final authority. User-global, team, agent, and exact-project
  memory share one chronological ledger without allowing one project's local
  memory into another. Project ontology now has a bounded lifecycle, sitemap,
  `.agentlas/pm` input, recursive inbox freshness checks, and fail-closed
  symlink, hardlink, and path-race protection.

  Korean and cross-lingual recall uses the verified multilingual Model2Vec
  asset, and promoted Experience relations can influence routing only under the
  exact attested package, environment, and project relation. Browser approval is
  isolated per app instance, with a pinned Browser host and read-only live
  Browser/Mac previews. Agentlas OS v1.1.48 is pinned at
  98adf6d1bb0bdad5a919884c3916274d5a3e813f. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-16 · v0.8.46 — a pairing QR a phone camera can actually read** — The
  Mobile pairing QR did not decode unless the camera was perfectly focused. The
  payload was 1228 characters, 796 of which were the full DER certificate, so a
  ~101x101 symbol was squeezed into the pairing card at under half a millimetre
  per module. The certificate never needed to travel there: the SHA-256
  fingerprint is the complete pin, because Mobile hashes whatever certificate
  the TLS handshake presents and compares it. The payload is now 410 characters
  and the QR renders at error-correction level M instead of the level-L floor it
  was pinned to purely to fit. Mobile pins from the fingerprint alone with no
  trust anchor and still cross-checks a certificate when one is sent, so the
  trust model is unchanged. The certificate stays in the endpoint manifest,
  where the relay uses it as its CA. A contract test asserts the certificate
  cannot return to the QR and that the payload stays under the density ceiling.
  Agentlas OS v1.1.45 is pinned at
  49752a783e944c898ea023705104661b3beb87b2. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-16 · v0.8.45 — direct Workforce contracts and bounded semantic
  recovery** — The active host LLM now returns direct WorkOrder and Selection
  objects with exact top-level and nested keys. Legacy `toolCall` envelopes are
  rejected rather than normalized, including the observed nested-`name` shape.
  The same pinned model gets at most one bounded schema repair per structured
  turn and at most two total candidate-free semantic WorkOrder refinements. A
  first valid selection expansion uses the same budget and re-searches; repeated
  expansion or a remaining hard gap fails closed.

  `requiredRoles` defaults empty and desired role fit stays in title/task,
  `optionalCommunities`, and `optionalSkills`. Community exclusions represent
  only explicit prohibitions or inherent incompatibilities, not every unused job
  family; exact same-ID positive/negative conflicts fail without host mutation.
  Only post-dispatch ambiguous outer transport failure from read-only candidate
  search can replay once. Pre-request setup errors, explicit MCP errors,
  received malformed tool payloads, selection validation, and execution
  preparation never retry. CandidateSet keys/version are checked against Core,
  candidate text is untrusted evidence, and execution-plan v5 bundles must
  contain executable top-level instructions, an exact permission policy, and a
  direct-agent or nested-team graph matching the recomputed cross-language
  bundle-digest v4 before any worker starts. A private JIT MCP tool inventory is
  scoped to each slot/release/runtime pair; the host LLM chooses semantic
  capability bindings, while each runtime must prove the exact enforced grant.
  The public v2 execution receipt records direct and nested calls without
  leaking the private inventory. Reserved recursive prototype keys are rejected
  by the shared digest domain. Detected Ollama, LM Studio, and MLX models now
  expose a conservative executable allocation profile (`effort=none`) instead
  of appearing in the planner menu without enough facts to run. Codex 0.144.4
  is deliberately absent from untrusted Workforce allocation: a harmless live
  probe still observed a collaboration tool call after all configurable tool
  features, including `multi_agent`, were disabled, so Desktop blocks that path
  before process spawn rather than claiming a no-authority sandbox. Trusted
  ordinary Codex conversations remain available.
  Strict planner examples now contain one fully valid live-runtime allocation
  rather than enum placeholders, and formal `reviews` edges enforce distinct
  immutable releases for independent assurance without host roster mutation.
  Agentlas OS v1.1.45 is pinned at
  49752a783e944c898ea023705104661b3beb87b2. Its finite public coverage-gap
  enum now matches the live Hub emitter exactly and rejects free-form or
  candidate-identifying gap values. This source does not prove a
  Desktop tag, public installer, or update-feed release.

- **2026-07-16 · v0.8.44 — exact seven-route mobile authority gate** — The Linux
  release gate now proves the restricted-read boundary independently for
  Workforce, temporary task forces, saved groups, Hub borrowed task forces,
  swarms, firms, and the direct runner. v0.8.43 stopped before packaging or
  public writes because its test still expected the six pre-Workforce routes;
  the repaired contract and all later OpenCrab security commands pass in the
  same Ubuntu 24.04 x64, Node 22, Electron/Xvfb environment. Agentlas OS v1.1.39
  remains pinned at cf71b8be1732f249b4d79d66246f7d3c0cd0790f. This source does not prove
  a public installer or update-feed release.

- **2026-07-16 · v0.8.43 — deterministic Linux automation release gate** — The
  automation-store suite now injects an exact test runtime before lazily loading
  the scheduler, and its cached-parent deletion interception reaches the real
  `startGraphRun` boundary. v0.8.41 stopped before packaging or public writes;
  the corrected failure point and every remaining Linux security command pass
  under Ubuntu 24.04 x64 and Node 22. The v0.8.42 Workforce source preparation
  is included here instead of being published separately. Agentlas OS v1.1.39 is
  pinned at cf71b8be1732f249b4d79d66246f7d3c0cd0790f. This source does not prove a
  public installer or update-feed release.

- **2026-07-16 · v0.8.42 — default-on host-LLM Workforce with tolerant semantic
  HR matching** — On a fresh install, an ordinary complex first-turn request now
  goes from the top model to the Hub Workforce ontology automatically: the model
  writes a redacted work order, sees only hard-eligible exact releases, chooses
  the roster from candidate content, and runs the real nested task force. Stored
  Network ON/OFF choices survive updates unchanged, while corrupt settings fail
  closed to OFF.

  Work orders use `required*` only for non-negotiable catalog evidence. Broad
  occupational community boundaries and exclusions prevent travel-style
  cross-domain matches, while title/task, summaries, `optionalCommunities`, and
  `optionalSkills` let legacy profiles with empty roles/tools compete on semantic
  fit. The pinned `awo:2026-07-15.2` snapshot adds canonical `payment` and
  `security` aliases and has raw JSON SHA-256
  `d6d30d45fe8d35fb785e165d1e80c6471a72436f0160c3933c21d4a31bf2fb32`.
  Agentlas OS v1.1.39 is pinned at
  cf71b8be1732f249b4d79d66246f7d3c0cd0790f. This source state does not prove a
  public installer or update-feed release.

- **2026-07-15 · v0.8.41 — one schema authority and exact browser failure
  contract** — All tests that mean the current Desktop schema now read the
  package contract rather than copying 65; historical v65 fixtures remain
  unchanged. MCP failure isolation now asserts that Agentlas Browser failure is
  blocked and cannot become a fresh Playwright profile. Machine-specific agent
  memory is also proven session-only when no project is bound, and local-route
  reconciliation checks its explicit missing-folder result. v0.8.40 stopped in
  preflight before packaging or public writes. Agentlas OS v1.1.37 remains
  pinned at c86aa86ccb3424e67be0b45ec253cc408af99df7. This source state is not proof of
  a public installer or update-feed release.

- **2026-07-15 · v0.8.40 — canonical automation schema gate** — The migration
  replay test reads the package's canonical schema target and verifies both Hub
  package and durable runtime pin columns. v0.8.39 passed its Mac scheduler fix
  but stopped in Linux preflight on the stale schema-65 assertion before any
  package or public write. The complete OpenCrab security command sequence passes
  before this tag. Agentlas OS v1.1.37 remains pinned at
  c86aa86ccb3424e67be0b45ec253cc408af99df7. This source state does not prove a
  public installer or update-feed release.

- **2026-07-15 · v0.8.39 — runtime-pin release gate alignment** — The scheduler
  guard fixture now declares the exact mocked Codex runtime required by the
  production fail-closed contract. v0.8.38 stopped in preflight before any
  package, public release, feed, or production metadata write; v0.8.39 retains
  its durable automation/session/browser/orchestration repairs with the corrected
  gate. Agentlas OS v1.1.37 remains pinned at
  c86aa86ccb3424e67be0b45ec253cc408af99df7. This source state does not prove a
  public installer or update-feed release.

- **2026-07-15 · v0.8.38 — durable automation identity and exact nested
  orchestration** — Scheduled runs pin their runtime/provider/model, retain a
  bounded previous-outcome capsule, and refuse to create a fresh Codex or Claude
  CLI conversation after a resume failure. Korean `작업 루트는 /Users/...`
  instructions now bind the real cwd; filesystem denial, halted execution,
  missing input, and failed tool events cannot be reported as success.

  Explicit Agentlas Browser/CDP/9222 jobs keep the authenticated Agentlas browser
  identity and do not fall back to a fresh Playwright profile. Hub packageHash
  pins reach the actual single-agent `hepCall --version` path. The host LLM,
  packaged Team manager, and generated Group manager remain distinct executable
  orchestration levels, including nested Cloud, Hub, and Local units.

  Release finalization now uses the current immutable verifier in the sole
  writer and applies verified metadata to the live Desktop API after stable
  promotion. Agentlas OS v1.1.37 remains pinned at
  c86aa86ccb3424e67be0b45ec253cc408af99df7. This source state does not prove a
  public installer or update feed; the signed cross-platform release and served
  byte gates remain authoritative.

- **2026-07-15 · v0.8.37 — executable hierarchy and fail-closed exact routing** —
  Normal Desktop turns retain the mandatory local Model2Vec hybrid recall:
  effective tasks use owner-scoped Memory and eligible reviewed Experience,
  then rank with the adaptive all-relevant-or-top-k budget. Borrowed-agent
  context remains isolated in per-agent SQLite nests, so governed relations
  survive projection rebuilds without injecting raw Markdown into another
  agent's runtime. This release pins Agentlas OS v1.1.37 at
  c86aa86ccb3424e67be0b45ec253cc408af99df7. Exact Cloud/Hub Agent and Team
  references retain their source and entity kind, and unsigned or incomplete
  Team graphs fail before execution.

  `/hep-storm` now enters the Desktop swarm executor rather than a display-only
  route: it binds verified local runtime inventory to per-worker model/effort
  choices and refuses to call a failed worker packet a completed final gate.
  The executable contract is required by the Windows, Linux, and signed macOS
  release gates. This validates the local Desktop host boundary; it does not
  claim that a Hub call performed a remote model completion.

  The top-level host LLM can now assemble one temporary TF from Cloud, Hub, and
  Local Agents, packaged Teams, and user-created Groups. Teams retain their
  manager/worker graph, Groups receive a generated middle-manager planner, and
  each nested unit returns one synthesized result rather than being flattened.
  Agent Cloud can also upload a registered local Agent or whole Team directly;
  My Agents manages the Team as a unit and leaves background eval/judge roles
  out of the ordinary ownership UI.

  The pinned Core source does not prove a published installer or update-feed
  release; the signed release gates and served bytes remain authoritative.
  v0.8.34 was an unpublished source tag whose invalid workflow produced no
  jobs. v0.8.35 then exposed a stale five-path Linux security assertion after
  the exact temporary-TF path became the sixth restricted-read propagation
  path. v0.8.36 then passed Linux and Windows packaging, but its stale macOS
  routing QA omitted the now-required exact target. The atomic barrier stopped
  it before any partial public release or feed write. v0.8.37 validates the
  target at the renderer trust boundary and aligns both Korean and English QA
  fixtures without rewriting any older tag.

  The updater refuses a running macOS app outside the pinned Developer ID,
  designated-requirement, notarization, and Gatekeeper lineage before download
  or installation. Local candidates use a separate bundle ID, user-data
  namespace, Keychain service, and no update feed; they cannot become an
  official app through a launch environment. A single release writer now
  verifies the complete Windows/Linux/macOS/feed/evidence set locally and
  against GitHub's served bytes before stable/latest promotion. Windows/Linux
  update feeds must bind every declared installer to its computed SHA-512 and
  byte size, and the production-rendered updater recovery UI is a PR and
  release gate. This source note does not claim a published installer, tag, or
  update-feed release.

- **2026-07-15 · v0.8.33 — updater accepts continuity journals across releases** —
  The install journal that guards every auto-update is written by the previous
  app version, so the updater now validates a schemaVersion 2 continuity
  snapshot against the snapshot's own protected-table set, and continuity
  verification plus recovery-copy checks iterate that recorded set. v0.8.32 grew
  `CONTINUITY_CORE_TABLES` from 31 to 32 tables and therefore quarantined every
  healthy inherited journal as corrupt, exited once with "Update recovery
  required", and left automatic updates permanently paused behind a same-version
  corrupt-journal marker; its update-feed entry was withdrawn. Newly captured
  snapshots still protect the complete current table list, schemaVersion 1
  journals keep their frozen historical set, and inconsistent or empty
  protection maps still fail closed. The embedded Agentlas OS v1.1.31 source
  remains pinned to `738b78f40b5efc9b2dd4cc66c94a3805e70c79f5`. v0.8.33 is the
  published stable/latest release; the Releases page remains authoritative for
  its installers and update feeds.

- **2026-07-15 · v0.8.32 — governed local Model2Vec experience memory** —
  Every ordinary Desktop invocation now sends the current effective task through
  automatic, owner-scoped Memory recall and eligible reviewed Experience recall.
  Desktop stores each new row with the verified local `potion-base-8M` int8 +
  hash hybrid: 256 semantic dimensions plus 96 deterministic hash dimensions,
  for one 352-dimensional offline vector. Lexical and cosine ranks are fused with
  RRF, while confidence/relation evidence on Desktop and salience in Core remain
  bounded priors. The adaptive all-relevant-or-top-k token budget loads every
  relevant row when it fits and ranks before truncating when it does not.
  Borrowed-agent memory lives in per-agent SQLite nests; semantic `similar_to`
  links and explicitly reviewed `supersedes` / `contradicts` governance edges
  survive safe rebuilds without whole-file Markdown injection. The packaged model
  is checksum-gated and runs in-process with no embedding server or paid embedding
  API. The embedded Agentlas OS v1.1.31 source is pinned to
  738b78f40b5efc9b2dd4cc66c94a3805e70c79f5. The public Releases page is the
  authority for v0.8.32's signed installer and update-feed status.

- **2026-07-15 · v0.8.30 — Agentlas OS v1.1.29 alignment** — Desktop now
  embeds the exact verified Core release that gives every external `/hep-build`
  host the same final choice: save the finished package privately in Agent
  Cloud or keep it only on this computer. Closing or skipping the choice stays
  local, a Cloud failure preserves the local package, and public Hub publishing
  remains a separate explicit action. Fresh Core interviews also default to
  English while retaining Korean as an explicit locale. The embedded commit is
  pinned identically in package metadata and every macOS, Windows, and Linux
  release workflow.

- **2026-07-15 · v0.8.29 — portable Builds, retry-safe Mobile, Agent Apps, and
  safe MCP consent** — A verified Build is installed locally first, then asks
  exactly `Cloud에 올리기` or `로컬에만 저장`; closing the choice keeps it local,
  public Hub publishing remains separate, and a Cloud failure never removes the
  local package. A second Desktop can restore the private package, after which
  its paired Mobile can invoke it through that Desktop. Paired Mobile also
  retains its secure endpoint across ordinary Desktop restarts and hides raw
  streamed confirmation controls from assistant text. Fresh installs default
  consistently to English while keeping Korean as an explicit choice.
  Agentlas Site can scaffold an isolated
  Astryx app around an owned agent, team, firm, or saved group. Before the first
  build, Desktop shows the exact system-wide MCP recommendation and asks for
  consent; missing keys, decline, stale readiness, malformed legacy rows, and
  connection failure all continue safely without tools. Only the audited
  keyless System Time MCP can currently attach; unpinned Brave Search remains
  visible but blocked. System Time runs from a checksum-verified compressed
  in-memory payload rather than a mutable user-profile script. Packaged app
  code is restricted to ASAR on every target, with embedded ASAR integrity
  validation on supported macOS and Windows packages. Run-as-Node remains a
  global fuse for required workers (internally exact-gated), not a path-scoped
  sandbox; removing it requires migrating those workers to dedicated runtimes.
  Active Desktop agents can read bounded project memory through canonical,
  replacement-safe identities, while Site/Agent App/Mobile restricted surfaces
  remain project-memory-free. Agentlas OS v1.1.28 still
  completes the canonical first-contact privacy contract
  before agent work starts. Codex allocation uses exact live-verified
  context, capability, and reasoning-effort metadata and records the effort
  actually applied without storing prompts or secrets. This entry is a
  released source line once the signed and cross-platform pipelines complete.

- **2026-07-14 · v0.8.24 Unified plugin first contact** — Desktop embeds
  Agentlas OS v1.1.28, so Codex, Claude Code, MCP, Network, owner Cloud, Storm,
  Terminal, and Desktop all install the same merge-only project soul, memory
  map, code map, ontology, Career Graph, and complete `.agentlas/` privacy block
  before agent work starts. Workload allocation still has no vendor alias or
  tier-to-model table: the parent AI selects an exact ID from live-verified
  inventory and Desktop preserves the active model if validation fails.

- **2026-07-14 · v0.8.20 Runtime integrity patch** — the embedded Agentlas OS pin
  is aligned to v1.1.23 across package compatibility and every release workflow,
  bound to exact commit `d121a703`, and carrying the current Windows
  Stormbreaker/native harness fixes. A moved tag or second-fetch mismatch fails
  before packaging. Desktop also
  prevents every production Python launch from writing `__pycache__` into the
  signed app: bytecode is disabled after caller env merging and the defensive
  cache prefix stays under per-user Agentlas data. A release gate runs a real
  synthetic module from a bundle-shaped `Resources/Hephaestus` fixture and
  requires that signed-resource tree to remain byte-for-byte free of `.pyc`.
  macOS packaging additionally exercises the packaged bridge against its real
  embedded runtime and rechecks the exact app with strict deep code-signing
  verification before publication. Ignored Core credentials, local memory, and
  signing material are rejected before packaging, excluded by both builder
  configs, and checked again inside the packaged Resources tree.

- **2026-07-14 · v0.8.19 Mobile security and Memory boundary release** — Mobile can
  start and steer read-only chats, while write/full work must start on Desktop.
  Desktop owns an immutable canonical folder binding, revalidates it across
  queued steering, and keeps project env, unrelated secrets, MCPs, memory
  writes, and local tool authority out of restricted runs. The selected BYOK
  key is used only as a Main-owned transport credential, never as model context.
  BYOK and Ollama remain available;
  Codex, Claude Code, Gemini/Antigravity, and Grok fail closed until their local
  CLI host-file boundary is proven by a cross-platform release gate. Restricted
  mode answers from supplied text, curated context, and images; it does not
  claim to inspect arbitrary local files that were not attached or pasted.
  Schema 64 preserves each Automation's exact read/write authority through
  scheduler and workflow runs. Gemini automatically uses Antigravity when the
  retired official client is rejected, Grok shows its real 402 balance state,
  and retry-safe Dashboard errors replace empty or invented usage. Cross-platform
  assets remain prerelease until the complete signed set can be promoted atomically.
  Interactive Desktop firm chats also keep attributable agent learning in read
  mode without gaining permission to write project-local `.agentlas` files.

- **2026-07-14 · v0.8.18 withdrawn Windows CI candidate** — Linux passed and
  staged as a prerelease, but a new Electron fixture left its SQLite handle open
  while deleting the Windows temp directory. The assertions passed but the
  process could not terminate, so the candidate was never promoted to stable.
  v0.8.19 closes the DB first and gives the Windows gate its own bounded timeout.

- **2026-07-14 · v0.8.17 failed release candidate** — its Experience Ontology
  gate caught the Desktop firm-read learning regression before certificate
  restore, signing, notarization, packaging, or public publication. No 0.8.17
  public release was created; v0.8.18 is its immutable audit replacement tag,
  and v0.8.19 carries the Windows cleanup correction.

- **2026-07-13 · v0.8.16 withdrawn security candidate** — never entered the
  stable channel. Its Windows/Linux files remain audit evidence, no signed Mac
  asset was published, and v0.8.19 replaces its read-to-Automation escalation
  path.

- **2026-07-13 · v0.8.15 runtime recovery and release parity** — the packaged
  app now bundles Agentlas OS v1.1.21 and must execute its real embedded
  Stormbreaker Goal + UltraCode harness before any platform can publish.
  Gemini chat repairs a recoverable local OAuth file and switches once to an
  installed Antigravity runtime when Google rejects the retired official CLI
  client. Grok HTTP 402 is shown as an exhausted quota, while unavailable
  subscription counters stay explicitly unavailable instead of being guessed.

- **2026-07-13 · v0.8.13 Experience and Ontology Chips** — each installed agent
  has a separate Experience/Taste loadout, privacy-filtered candidate history,
  and a 3D relation view. Base agents and chips keep independent ownership and
  release identities; purchase never auto-attaches, and private prompts,
  transcripts, credentials, and local paths are excluded from portable assets.

- **2026-07-11 · v0.7.34 cloud-local stabilization** — Web bookmarks now sync
  into an account-scoped Desktop cache and appear immediately across Dashboard,
  the organization tree, Marketplace, Agent Groups, and Chat. Hub invocation
  revalidates live callability and fails closed instead of fabricating a local
  fallback; automation leases, orphan recovery, updater continuity, and release
  credentials are hardened with production regression gates.

- **2026-07-11 · v0.7.33 pre-mobile production hardening** — a passed Build now
  becomes a durable local asset and appears in Dashboard, My Agents, and Chat
  without reload; Site Studio adds persistent conversational design and a safe
  Build handoff; Chat context reset, run receipts, automation watchdogs, browser
  ownership, Hub bookmarks, and Runtime Readiness are covered by signed-release
  regression gates.

- **2026-06-30 · v0.5.5 Hephaestus v1.0.4 engine pin** — desktop builds now
  bundle the tagged Hephaestus `v1.0.4` router fix, excluding plugins from
  user-facing agent routing so tools like Shopify cannot be launched as agents.
  The composer also expands with typed content instead of staying fixed-height.
- **2026-06-30 · v0.5.4 Chat routing + stop controls** — chat agent calling now
  labels the router as `알아서 에이전트 부르기`, keeps `@` autocomplete selection
  stable, disables auto-routing after explicit agent selection, retries
  recommendation search without closing the sheet, and makes stop visible and
  cancellable. Workspace tours no longer inject hardcoded sample labels into live
  work, and image outputs render inline with right-panel preview support.
- **2026-06-30 · v0.5.3 Agent groups + Hub TF permissions** — saved Agent
  groups can combine org-chart, local, and Hub agents into one higher-level
  orchestrator chat. Borrowed Hub task-force sub-runs now inherit the user's
  selected read/write/full permission instead of being forced read-only, while
  host policy and redaction still keep secrets out of visible output.
- **2026-06-30 · v0.5.2 Live borrowed Hub task forces** — recommendation-sheet
  Network picks with multiple Hub agents now execute as a real
  plan/delegate/synthesize task force. Borrowed Hub sub-runs are read-only,
  do not inherit MCP auto-approval or vault env, and redact common secret shapes
  before status/tool/final output reaches the UI.
- **2026-06-30 · v0.5.0 Desktop Hub parity** — Desktop Marketplace now reads the
  live Hub-only catalog, removes local hardcoded fallback agents, preserves real
  Hub partial results without poisoning cache, and ships Studio/Sidebar/QA fixes
  through the signed public macOS release channel.
- **2026-06-29 · v0.4.4 BYOK Build pricing** — Desktop Build now treats local
  BYOK/BYOC creation as a 0 Agentlas-credit builder action, with model usage
  still handled by the user's own subscription, local runtime, or API key.
  Hub Network calls remain billed separately after quote and confirmation. This
  release also removes local absolute paths and realistic-looking fake keys from
  public source files.
- **2026-06-27 · Always-on Stormbreaker Loop** — non-trivial chat and
  automation runs now get scope lock, goal decomposition, work packets,
  verification, immediate continuation passes, background continuation,
  concrete-error repair, and final-gate discipline without a user-facing
  Stormbreaker toggle. The desktop also auto-selects relevant MCP plugins for
  Claude Code/Codex runs, with Hephaestus Network installed by default for
  Agentlas Hub/Cloud routing.
- **2026-06-06 · v0.2.18 terminal ontology update** — `agentlas` now accepts
  short REPL commands such as `/ontology`, `/ontology list`, and
  `/ontology company ./docs`; company and personal folders stay private unless
  explicitly registered otherwise.
- **2026-06-09 · v0.2.27 Cloud-ready agent packages** — terminal users can now repair
  `agentlas.json`, run a local security scan, compile a manifest-based runtime
  bundle, and test lazy file reads before Cloud sync or Hub publish.
- **2026-06-06 · v0.2.17 public desktop release** — Project Ontology panel and
  `agentlas ontology` terminal status/add/open flow shipped. Each project gets a
  separate `.agentlas/ontology-inbox/`, `.agentlas/ontology-sources.json`, and
  `.agentlas/ontology-runtime.sqlite`; home folders and sibling projects are not
  scanned automatically.

### What you get

| | |
|---|---|
| **Local + BYOK runtimes** | Claude Code · Codex · Gemini/Antigravity · Grok · Ollama · API keys — auto-detected |
| **BYOK providers** | Anthropic · OpenAI · Google · Upstage · GLM · Kimi · DeepSeek · compatible custom endpoints |
| **+$0 to your model bill** | Agentlas runs no model and never proxies a call |
| **100% local** | keys in the OS keychain, chats & agents in local SQLite |
| **Agent Trust assets** | owner scope · source · version · package hash · private/public boundary · restore receipt |
| **Experience/Taste chips** | separately owned releases · explicit loadout · privacy-filtered evidence · automatic local task recall only after an eligible loadout |
| **Agent Cloud, optional** | explicitly save and restore private agent packages; it is not the LLM execution server |
| **Agent teams, visible** | every firm renders as an org chart, not a black box |
| **Stormbreaker loop** | big jobs get automatic scope, goals, work packets, plugin selection, continuation, repair, and final-gate evidence |
| **Apps Store** | install Apps, agent firms, and supporting engines over the Model Context Protocol |
| **3 platforms** | macOS (Apple Silicon + Intel) · Windows · Linux, self-updating |
| **Apache-2.0** | audit it, fork it, ship your own variant |

Connect the AI models you already pay for, install Apps over MCP, and run AI-native
apps or whole agent teams from one local window — with the UI, org chart, and repo
behind every run in plain view. Your keys and your chat history stay on your
machine, never on someone else's agent platform.

- **Bring your own models.** Claude Code, Codex, Gemini/Antigravity, Grok, and
  Ollama, or supported BYOK API keys directly. Agentlas never proxies the model call.
- **Install Apps over MCP.** Drop in an App, an agent, or a whole team — for example
  a package you built on [agentlas.cloud](https://agentlas.cloud) — and run it.
- **Prepare Cloud-ready agents locally.** `agentlas cloud wizard` creates or
  repairs `agentlas.json`; `agentlas cloud runtime bundle` builds the MCP call
  context from manifest allowlists instead of sending a whole ZIP.
- **Apps are first-class.** An App opens inside Agentlas Desktop like a small
  macOS/Windows/Linux window: it can have its own UI, UX, backend adapters,
  generated assets, credential requirements, MCP tools, and sub-engines. Assets,
  vault keys, and MCP servers are support devices for Apps, not separate top-level
  products.
- **See the team, not a black box.** Every agent team renders as an org chart and
  a file tree, so you can see who does what and which repo each run touches.
- **Run and orchestrate locally.** The app supervises the agent processes and
  routes work between roles, all on your disk.
- **Local-first.** Keys in the OS keychain, chats and installed agents in local
  SQLite. Open source, Apache-2.0 — fork it, audit it, ship a variant.

## Who it's for

- **Power users** who already pay for Claude, ChatGPT, Gemini, or Grok and want to run
  agents on that subscription instead of paying a second AI bill to an agent SaaS.
- **Builders** who package Apps or agents on [agentlas.cloud](https://agentlas.cloud) and
  want to run them locally over MCP.
- **Privacy-minded teams** who refuse to hand their API keys and chat history to a
  third-party agent platform.
- **Tinkerers** who want an open-source, auditable, forkable agent runner.

## Features

A complete tour of what ships today.

### Bring your own everything (BYOC)

- **Local CLI runtimes, auto-detected.** Agentlas finds your installed
  `claude-code`, `codex`, `gemini`, and `grok` CLIs plus a local Ollama server and
  runs through them using the connection you already have.
- **Honest provider health.** If the official Gemini CLI is rejected as a
  retired client, one installed Antigravity fallback is attempted. Grok quota
  exhaustion is shown as HTTP 402; usage or reset values that a provider does
  not expose are never invented.
- **BYOK cloud keys.** No CLI? Paste an Anthropic, OpenAI, or Google API key and
  go. Keys are stored in the OS keychain, never a file.
- **Mix and switch freely.** Have Claude Code *and* a Gemini key? Both show up; pick
  the active backend per run. Most apps lock you to one provider — Agentlas doesn't.
- **No proxy, ever.** Every model call goes straight from your machine to the
  provider. Agentlas runs no LLM of its own and adds **$0** to your model bill.

### Agent firms — teams, not a single bot

- **Install a whole company.** A *firm* is a CEO agent that delegates down to
  department heads and workers — e.g. a storefront-ops firm with content, CS, and
  analytics departments.
- **Live org chart.** Every firm renders as a hierarchy so you can see who reports
  to whom and which role handles what — no black box.
- **Chat the CEO, mobilize the team.** Message the CEO and it routes work to the
  right roles, or talk to any single specialist directly.

### Projects, chats, and history that stay yours

- **Projects** group related chats, apply a shared context note, and set a default
  agent so every new chat starts with the right context.
- **Project-local ontology runtime** keeps `.agentlas/ontology-inbox/`, registered
  sources, and the SQLite knowledge store inside that project. It runs as
  background infrastructure for agents rather than a standalone project panel,
  and does not scan your home folder or sibling projects.
- **Independent Terminal loadout receipt** projects only the fresh, currently
  approved exact agent/chip release IDs into a private `terminal-bridge` file.
  Agentlas Terminal must opt in for each run and re-check the local immutable
  Hub binding; recommendations, pending/next-session changes, paths, prompts,
  memory, credentials, and MCP process data never enter this receipt.
- **Chats** support rename, archive/unarchive, switching the bound agent, and full
  message history — all in **local SQLite**, nothing on a server.
- **Image attachments** are sent as multimodal input on BYOK backends.
- **Working-folder panel** pins a folder to a chat with a read-only file tree and
  text preview, so you can see the repo an agent is helping with.
- **Code map** lets an agent find code in a large project without scanning the
  whole tree. On first attach, a compact index (symbols, references, modules,
  entry points) is built in the background under `<project>/.agentlas/code-map/`
  and its seed is injected each turn, so the model orients instead of grepping
  blindly. Generation is non-blocking and reading is fully guarded.

### Governed local Memory and Experience recall

- **Automatic on normal Desktop turns.** `runMcpInvocation` passes the current
  effective task into owner-scoped Memory retrieval every turn and, when the
  exact agent/package/project/environment binding is eligible, automatically
  appends reviewed Experience items to the same system prompt. Restricted Agent
  App runs stay memory-free; an exact Operational overlay can replace the local
  Experience overlay for that conversation.
- **352-dimensional offline embeddings.** The packaged runtime requires a
  checksum-verified, MIT-licensed `potion-base-8M` int8 asset. Desktop combines
  its 256-dimensional semantic vector with the deterministic 96-dimensional hash
  vector and persists the resulting 352-dimensional hybrid at write time. It
  runs in-process and offline; Agentlas has no embedding endpoint and pays no
  per-user embedding bill. Hash-96 alone is a marked degraded fallback if the
  verified local model becomes unavailable.
- **Hybrid ranking before budgeting.** Lexical overlap and local cosine ranks
  stay separate until reciprocal-rank fusion (RRF). Desktop adds bounded
  confidence and reviewed-relation evidence; the per-agent Core reader retains
  salience as its prior. Every governance-eligible row is scored before the
  adaptive selector loads all relevant items that fit or chooses a bounded
  top-k when they do not.
- **Relations have different authority.** `similar_to` is a rebuildable semantic
  edge. `supersedes` and `contradicts` are durable reviewed governance and are
  never guessed from vector proximity. Secret Memory is blocked by the curator,
  confidential/secret source material cannot become Experience, and superseded,
  wrong-agent, wrong-project, wrong-package, and wrong-environment rows are
  excluded before ranking.
- **Borrowed agents keep isolated nests.** Approved `agent_repo` learning is
  projected to
  `~/.agentlas/networking/hub-agents/<slug>/memory/experience.sqlite`. Agentlas
  Core queries that database with the exact `hub:<slug>` identity; it does not
  inject the legacy `project-soul-memory.md` wholesale. Semantic and reviewed
  governance edges are restored when a rebuildable nest is created again.

### Stormbreaker Loop

- **Always on for serious work.** App builds, game builds, agent packaging,
  debugging, deployment, data/report work, automations, trading/ops jobs, and
  other multi-step runs receive a scope-lock -> goal decomposition -> work
  packets/sub-agent architecture -> act -> verify -> bounded continuation ->
  concrete-error repair -> final-gate instruction set. There is no Stormbreaker
  toggle in chat or Settings.
- **Visible in chat.** The same grey working panel used for agent activity shows
  `Stormbreaker Loop` events before the answer is finalized.
- **Plugin-aware.** Claude Code and Codex runs inspect the request and installed
  MCP catalog, then enable relevant tools automatically when credentials are
  already available. Hephaestus Network is part of the default MCP set so Hub and
  Cloud routing/plugin discovery are reachable without a separate manual setup.
- **Continuation.** If the runner reports more safe work remains, the desktop
  continues the same invocation for a bounded number of immediate passes instead
  of stopping at the first draft. If safe work still remains after those passes,
  Agentlas creates a hidden `every-30m` Stormbreaker continuation automation that
  reuses its own durable background session and disables itself once the marker
  stops because the task is complete or blocked.
- **Bounded host repair.** The desktop only performs automatic repair where it
  has a concrete verifier. Today that includes invalid Agentlas Surface manifests:
  Agentlas asks the runner for a corrected manifest, re-parses it, and stops
  after a small bounded retry count.
- **Automation-aware, not account-proof.** Scheduled runs receive the same loop
  prompt, so each background cycle is asked to resume from evidence and record
  what changed. A scheduled prompt is not proof that an external account action
  succeeded unless a connector, browser session, or tool output verifies it.
- **Honest stops.** If auth, missing access, provider policy, unavailable tools,
  or an external outage blocks verification, the run must report that blocked or
  unverified state instead of claiming completion.

### Apps Store — install and generate Apps

- **MCP-native installs.** Browse and install Apps, agents, and whole firms from the
  `agentlas.cloud` Apps Store; they run through local runtime adapters over the
  Model Context Protocol.
- **Operator-published Apps.** Agentlas operators publish App source/bundles to a
  private GitHub repo, GitHub Release, or object storage; `agentlas.cloud` keeps the
  MongoDB marketplace index, permissions, manifest, and version metadata. MongoDB is
  not the blob store for full app bundles.
- **Chat-generated Apps.** Turn on **Apps Generate** beside the Goal control in chat
  and describe the tool you want. The built-in Agentlas App Builder routes the task
  into an internal App manifest, not a standalone localhost web app or loose assets,
  and leaves a stable Apps CTA when the model does not.
- **First proof App.** **Document Studio** opens at `/apps/document-studio` as an
  AI document workspace with tabs, an editable generated draft, figure planning,
  and an "Open in Apps" CTA.
- **Package security grades.** Hub listings show the current package scan grade,
  not a creator reputation or user rating; sideloading unvetted agents is
  gated.
- **Hub-only catalog.** If the network or cloud is down, the marketplace shows an
  empty/error state instead of local hardcoded agents, so stale demo listings never
  masquerade as live Hub results.

### Apps — manage the whole toolbox

- **Installed Apps, Apps Store, Apps Vault, and Apps Engines** live under one sidebar
  section. The vault tracks which credentials each App needs and which are set;
  values live in the keychain, the UI only shows whether a key exists. MCP servers
  and generated assets are engines/artifacts that help Apps run.

### Automations

- **Schedule recurring runs** against an agent or a firm from a prompt template.
  The scheduler checks due runs while the app is open, supports interval forms
  like `hourly` and `every-30m`, and runs each prompt through the Stormbreaker
  loop contract in a durable hidden session per automation. External services
  such as Instagram still require a capable connector/browser path plus
  authenticated proof before the result is verified.

### Migrate in — never locked in

- **Import from OpenClaw and Hermes** in one click: SOUL/persona → an agent, `.env`
  keys → the keychain, scheduled jobs → automations, memories → a project. Dry-run
  and overwrite supported. Secret values never leave the main process.
- **Apache-2.0 open source.** Audit it, fork it, ship your own variant.

### Local-first security

- API keys and tokens live in the **macOS/Windows/Linux keychain** via the main
process — never a plaintext file, never readable by the renderer/UI.
- Chats, projects, firms, and installed agents live in **local SQLite**.
- Agent memories and Experience candidates remain local until the owner
  explicitly saves or publishes a privacy-filtered asset. Hub/Cloud status and
  receipts are separate from local execution state.
- Ontology sources are project-local by default: add files to the project's
  `.agentlas/ontology-inbox/` or register an explicit source with
  `/ontology company ./docs` inside the Agentlas terminal.

### Cross-platform, self-updating, bilingual

- **macOS (arm64 + Intel), Windows (installer + portable), Linux (AppImage + deb).**
- **Auto-updates** via a GitHub Releases feed — a "Restart to update" badge appears
  when a new build is downloaded.
- **Full Korean / English UI** with automatic locale detection.

## How Agentlas compares

Three common ways to run AI agents today — and where Agentlas lands.

| | **Agentlas Desktop** | Hosted agent platform (SaaS) | Single-model desktop chat | Raw terminal CLI |
|---|---|---|---|---|
| Where model calls go | **Direct from your machine** | Through their servers | Direct | Direct |
| Who pays for tokens | **Your existing sub / key** | Platform fee **+** tokens | Your sub / key | Your sub / key |
| Where keys & history live | **Your keychain + local SQLite** | Their cloud | Local (varies) | Local |
| Multi-agent firms + org chart | **Yes** | Sometimes | No | No (manual) |
| Install 3rd-party Apps over MCP | **Yes, Apps Store** | Varies | No | Manual |
| Use local runtimes (Claude Code / Codex / Gemini / Grok / Ollama) | **Yes** | Rarely | No | One at a time |
| Mix CLIs **and** cloud keys in one window | **Yes** | No | No | No |
| Open source (Apache-2.0) | **Yes** | Usually no | Varies | Varies |
| Desktop GUI on mac / win / linux | **Yes** | Web only | Often | No (terminal) |

**Why people pick Agentlas**

- **It runs on the AI you already pay for.** No second model subscription to an
  agent platform — your Claude/ChatGPT/Gemini/Grok plan does the work.
- **The local boundary is explicit.** Keys stay in the OS keychain and chats in
  local SQLite. Model inputs go directly to the provider you chose; packages or
  Experience assets reach Agent Cloud/Hub only after an explicit save or publish.
- **Teams of agents, visible.** Firms with a real org chart beat a single opaque
  chatbot when work needs more than one role.
- **Open and portable.** Apache-2.0, importable from OpenClaw/Hermes, forkable — no
  lock-in.

## Screens

| Screen | What it does |
|--------|--------------|
| **Home** | Landing dashboard — recent chats, installed teams, quick actions. |
| **Chat** | One-on-one conversation with an agent or a firm's CEO. Supports image attachments on BYOK backends. |
| **Archived chats** | Chats you've archived — hidden from the sidebar, restorable anytime. |
| **Projects** | Create and open projects; each carries a default agent and a shared context note. |
| **My Agents · Ontology Chips** | Inspect one agent's curated memory, Experience candidates, privacy blocks, exact chip loadout, and 3D relation map. |
| **Firm detail** | The agent company's org chart — CEO → department heads → workers, plus the firm persona. |
| **Automations** | List, create, and toggle scheduled runs targeting an agent or a firm. |
| **Apps · Installed** | Installed Apps launcher. Includes Document Studio and App Builder generated Apps. |
| **Apps · Store** | Browse and install Apps, agents, and firms from the live `agentlas.cloud` Hub catalog. Offline/error states do not show local hardcoded agents. |
| **Apps · Engines** | Installed MCP servers, backend connectors, and sub-engines used by Apps. |
| **Apps · Vault** | The shared credential vault — which keys are set and which Apps require them. |
| **Settings** | Backend connections, BYOK API keys, language, and migration from OpenClaw / Hermes. |
| **Onboarding** | First-run wizard: welcome → connect a backend → menu tour → install your first team. |

## LLM Providers

Agentlas connects to models two ways — through a **local CLI** you already have
installed, or with a **cloud API key (BYOK)**. Either way the call goes straight
from your machine to the provider; Agentlas never sits in the middle.

| Provider | How it connects | Notes |
|----------|-----------------|-------|
| **Claude Code** | Local CLI (`claude-code`) | Auto-detected. Uses your existing Claude subscription/login. |
| **Codex** | Local CLI (`codex`) | Auto-detected. Uses your existing ChatGPT/OpenAI login. |
| **Gemini** | Local CLI (`gemini`) | Auto-detected. Uses your existing Google login; an installed Antigravity runtime is a one-time fallback for `UNSUPPORTED_CLIENT`. |
| **Grok** | Local CLI (`grok`) | Auto-detected. Uses the CLI login. HTTP 402 is reported as exhausted quota, not a healthy connection. |
| **Ollama** | Local server | Auto-detected from the local Ollama endpoint; models and context stay under the local host configuration. |
| **Anthropic** | BYOK API key | `console.anthropic.com → API Keys`. Stored in the OS keychain. |
| **OpenAI** | BYOK API key | `platform.openai.com/api-keys`. Stored in the OS keychain. |
| **Google (Gemini)** | BYOK API key | `aistudio.google.com/app/apikey`. Stored in the OS keychain. |
| **Other BYOK** | Upstage, GLM, Kimi, DeepSeek, or compatible custom endpoint | Key stored in the OS keychain; provider inventory and pricing remain provider-owned. |

You need **one** of these to start — a single detected CLI or a single API key.
Add more later in **Settings**.

## Quick install

Get the latest build from the [**Releases page**](https://github.com/agentlas-ai/agentlas-desktop-releases/releases/latest).

| OS | File | Notes |
|----|------|-------|
| macOS (Apple silicon) | `Agentlas-x.y.z-arm64.dmg` | M1 and newer · macOS 12 Monterey or newer |
| macOS (Intel) | `Agentlas-x.y.z-x64.dmg` | Intel Macs · macOS 12 Monterey or newer |
| Windows | `Agentlas-x.y.z-Windows-x64-Setup.exe` · `Agentlas-x.y.z-Windows-x64-Portable.exe` | Windows 10/11 (x64) |
| Linux | `Agentlas-x.y.z-Linux-x64.AppImage` · `Agentlas-x.y.z-Linux-x64.deb` | x64 |

### Install from the terminal

Prefer the command line? These one-liners fetch the latest release asset straight
from the public releases repo (no need to hardcode a version).

**macOS** (auto-detects Apple silicon vs Intel):

```bash
arch=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
url=$(curl -fsSL https://api.github.com/repos/agentlas-ai/agentlas-desktop-releases/releases/latest \
  | grep -o "https://[^\"]*-${arch}\.dmg" | head -1)
curl -fL "$url" -o Agentlas.dmg && open Agentlas.dmg
```

**Linux (.deb — Debian/Ubuntu):**

```bash
url=$(curl -fsSL https://api.github.com/repos/agentlas-ai/agentlas-desktop-releases/releases/latest \
  | grep -o 'https://[^"]*\.deb' | head -1)
curl -fL "$url" -o agentlas.deb && sudo dpkg -i agentlas.deb
```

**Linux (AppImage — any distro):**

```bash
url=$(curl -fsSL https://api.github.com/repos/agentlas-ai/agentlas-desktop-releases/releases/latest \
  | grep -o 'https://[^"]*\.AppImage' | head -1)
curl -fL "$url" -o Agentlas.AppImage && chmod +x Agentlas.AppImage && ./Agentlas.AppImage
```

**Windows (PowerShell):**

```powershell
$r = Invoke-RestMethod https://api.github.com/repos/agentlas-ai/agentlas-desktop-releases/releases/latest
$u = ($r.assets | Where-Object { $_.name -like '*Windows-x64-Setup.exe' }).browser_download_url
Invoke-WebRequest $u -OutFile "$env:TEMP\AgentlasSetup.exe"; Start-Process "$env:TEMP\AgentlasSetup.exe"
```

### Turn on project ontology from the terminal

Open a project folder and type `agentlas`. Inside the Agentlas terminal:

```text
/ontology
/ontology list
/ontology company ./company-docs
/ontology personal ~/notes
```

### Prepare an agent for Agentlas Cloud calls

Run these from the Agentlas terminal CLI before private Cloud sync or public Hub
publish:

```bash
agentlas cloud wizard ./some-agent --name instagram-operator
agentlas cloud security scan ./some-agent --strict
agentlas cloud runtime bundle ./some-agent
agentlas cloud runtime read-agent-file ./some-agent AGENTS.md
agentlas cloud field-test
```

The wizard writes `agentlas.json`, the scan writes
`.agentlas/security-scan.json`, and lazy reads obey the package allow/deny
rules so secret-like files stay blocked.

Those commands create/use only this project's `.agentlas/` folder. They do not
scan your home folder or other projects.

### Updates — do I need to reinstall?

No. The app updates itself: ~15s after launch and then hourly it checks GitHub
Releases, downloads a newer build in the background, and shows a **"Restart to
update"** badge (the same idea as Codex's update button). Click it to apply.

- **Windows:** auto-update works for the **installer** build (`Agentlas-Setup-*.exe`).
  The **portable** `.exe` does **not** self-update — re-download it to upgrade.
- **macOS / Linux (AppImage):** self-update in place. The `.deb` updates via the
  same in-app flow.
- **macOS 11 Big Sur:** stays on the last compatible Agentlas release and is
  excluded from macOS 12+ automatic updates.

### First-time setup — opening the app the first time

Agentlas Desktop's public macOS builds are Developer ID signed, notarized, and
Gatekeeper verified before they enter the stable update channel. Windows may
still show SmartScreen reputation warnings, and Linux may require executable
permission for an AppImage.

**macOS** — download the DMG from the official Releases page and move Agentlas
to Applications. If Gatekeeper says Apple cannot check the app, do not remove
quarantine or force-open that copy: delete it and download the current stable
DMG again. The updater also refuses an app whose signing, notarization, bundle,
or designated-requirement lineage does not match the official release policy.

**Windows** — if SmartScreen shows *"Windows protected your PC"*, click
**More info** → **Run anyway**. The portable `.exe` runs without installing.

**Linux** — make the AppImage executable and run it:

```bash
chmod +x Agentlas-*.AppImage
./Agentlas-*.AppImage
# no FUSE on your distro? run:
./Agentlas-*.AppImage --appimage-extract-and-run
```

(Or install the `.deb`: `sudo dpkg -i Agentlas-*.deb`.)

## Getting Started

After installing, the first-run wizard walks you through it — but here's the whole
flow:

1. **Open the app** and let the welcome screen finish (first launch only).
2. **Connect a backend.** Agentlas auto-detects any installed `claude-code`,
   `codex`, or `gemini` CLI. No CLI? Paste an Anthropic / OpenAI / Google API key —
   it goes straight into the OS keychain.
3. **Install an App, team, or agent** from **Apps Store**. Try a firm (a CEO plus
   its departments), a single specialist, or a generated App.
4. **Open Apps** from the sidebar and try **Document Studio**, or start a chat and
   use `/apps` or `/docstudio`.
5. **Pin a working folder** (optional) so the agent can see the repo it's helping with.
6. **Add automations** for recurring runs, and manage App engines and credentials
   from **Apps**.
7. **Coming from OpenClaw or Hermes?** Jump to
   [Migrating from OpenClaw](#migrating-from-openclaw) to bring your SOUL, keys,
   and automations across.

## CLI runtime vs Cloud (BYOK) — quick reference

Agentlas has no separate "CLI app" and "web app" — it's one desktop window. The
choice that matters is **how each run reaches a model**: through a local CLI you've
already logged into, or through a cloud API key you paste in. Both run from your
machine; here's how they differ.

| Action | Local CLI runtime | Cloud API key (BYOK) |
|--------|-------------------|----------------------|
| Connect | Auto-detected (`claude-code` / `codex` / `gemini`) | Paste a key in **Settings → BYOK** |
| Who pays | Your existing subscription / login | Your API account, metered per token |
| Where the key lives | The CLI's own login | The OS keychain (never a file) |
| Works offline-ish | Whatever the CLI supports | No — direct cloud calls |
| Image attachments | Ignored by the CLI (a warning is shown) | Sent as multimodal input |
| Switch active backend | **Settings** → pick a detected runtime | **Settings** → pick a saved key |
| Version pinning | Follows the installed CLI version | Follows the provider's API |

> Agentlas never routes either path through its own servers. The model call goes
> from your machine straight to Anthropic / OpenAI / Google.

## Migrating from OpenClaw

Already running a terminal-style assistant like **OpenClaw**? Bring it across in the
app — **Settings → 다른 도구에서 가져오기 (Import from another tool)**.

Agentlas scans `~/.openclaw` and shows a preview (names and counts only — no secret
values ever leave the main process). Click **Import** and it brings over:

- **Your agent's SOUL / persona** (`workspace/SOUL.md`, `IDENTITY.md`, `USER.md`,
  `AGENTS.md`, `TOOLS.md`) → a new installed agent you can chat with immediately.
- **API keys** from `~/.openclaw/.env` → the OS keychain. Recognized provider keys
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) become BYOK backends;
  other `*_API_KEY` / `*_TOKEN` secrets go into the shared env vault.
- **Scheduled jobs** (`cron/jobs.json`) → automations targeting the imported agent.
- **Memories / workspace** → a "OpenClaw 마이그레이션" project whose context note
  points at your original workspace so you can pin it as a working folder.

Options:

- **Dry run** — preview exactly what would be imported, writing nothing.
- **Overwrite** — re-import on top of a previous import (updates the agent in place).

> Imported automations are session-only in the current M0 build; the persistent
> scheduler lands in V1. Everything else (agent, keys, project) persists.

### Migrating from Hermes

The same importer reads **Hermes** (`~/.hermes`, or `%LOCALAPPDATA%\hermes` on
Windows): `SOUL.md` and workspace instructions become the agent persona, `.env`
keys go to the keychain, and `memories/` are surfaced as a project. Pick **Hermes**
in the same Settings panel.

## Build from source

Requirements: Node.js 22.12+, npm. (macOS also needs Xcode Command Line Tools, and
Linux needs `libsecret-1-dev`, for the native modules.)

```bash
git clone https://github.com/agentlas-ai/agentlas-desktop.git
cd agentlas-desktop
npm install
npm run dev        # Next.js renderer on :3100 + Electron
```

```bash
npm run typecheck  # TypeScript for electron main + renderer
npm run build      # export renderer + compile electron into dist/
```

Package an installer (unsigned — fine for local use):

```bash
npm run dist:win            # Windows: NSIS installer + portable .exe
npm run dist:linux          # Linux: AppImage + .deb
npm run dist:mac:unsigned   # macOS: unsigned .dmg (no Apple cert needed)
```

Output lands in `release/`. Releases for the public download page are built by
the cross-platform GitHub Actions workflow (`.github/workflows/release.yml`) on a
tag push — see [`docs/PUBLIC-RELEASE.md`](docs/PUBLIC-RELEASE.md). End users don't
need any of that.

## Architecture

```text
Agentlas Desktop
├─ electron/          privileged main process
│  ├─ runtime/        Claude Code, Codex, Gemini/Antigravity, Grok, Ollama, BYOK adapters
│  ├─ mcp/            MCP client and installer
│  ├─ marketplace/    agentlas.cloud Apps Store source
│  ├─ migrate/        OpenClaw / Hermes importer
│  ├─ secrets/        OS keychain vault
│  ├─ store/          SQLite-backed local state
│  └─ updater.ts      electron-updater integration
├─ renderer/          Next.js App Router UI
├─ shared/            typed IPC contracts
├─ scripts/           release, signing, and verification tooling
└─ docs/              architecture and release notes
```

The renderer never gets direct filesystem, keychain, or process-supervision
access — it talks to the main process through a typed preload bridge.

## Documentation

| Document | Covers |
|----------|--------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, IPC bridge, runtime adapters, data flow. |
| [docs/ARCHITECTURE_PLAYBOOK.md](docs/ARCHITECTURE_PLAYBOOK.md) | Built-in architecture, per-turn governed Memory/Experience recall, local Model2Vec hybrid, and safe extension invariants. |
| [docs/M0-CHECKLIST.md](docs/M0-CHECKLIST.md) | The M0 spike scope and what's verified. |
| [docs/PUBLIC-RELEASE.md](docs/PUBLIC-RELEASE.md) | Cross-platform CI release + the signed/notarized macOS path. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, what to test, and the public-safety rules. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability. |
| [Migrating from OpenClaw](#migrating-from-openclaw) | Bring a SOUL, keys, and automations over from OpenClaw / Hermes. |

## Security model

- No credentials in Git.
- No API keys written to plaintext local files.
- Renderer code cannot directly read secrets.
- Migration previews send key **names** only — secret values never leave the main process.
- Signing material is git-ignored and injected only during release.
- Auto-update assets are served from GitHub Releases.

Security reports: see [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run
`npm run typecheck`, and keep public safety in mind: no credentials, no local
logs, no signing material. Windows/Linux testing and packaging feedback is
especially appreciated.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
