# Changelog

## 0.8.5 — 2026-07-12

### Fixed

- **Oberon shows the real connection state for every image and video engine.**
  The main-process status API now probes the full provider catalog instead of
  returning only the three globally selected providers, so an OAuth-ready Grok
  image/video stack is labeled connected rather than login required.

## 0.8.4 — 2026-07-12

### Fixed

- **Oberon now uses Grok Imagine for the selected cut-image and video engines.**
  Grok-generated keyframes flow into image-to-video rendering and the existing
  clip assembly/delivery pipeline instead of being relabeled as Codex or blocked
  behind the Veo-only renderer.
- **Grok CLI 0.2.93 media jobs start reliably without widening host access.**
  The broken headless tool allowlist is replaced by the strict OS sandbox plus
  explicit shell/edit denials, while prompt files, session harvesting, cleanup,
  OAuth-only subscription billing, and unrelated-secret isolation remain gated.

## 0.8.3 — 2026-07-12

### Added

- **채팅 실행이 Claude Code 데스크탑처럼 살아 움직입니다.** ✳ 글리프 스피너
  상태줄이 경과 시간·라이브 토큰 수·생각 문구("생각 중…"→"아직 생각 중…"→
  "더 생각 중…"→"거의 다 생각했어요…", 종료 후 "N초 동안 생각함")를 실시간으로
  보여주고, 도구 실행은 본문 문단 사이에 "읽는 중 ›" 라이브 라벨 →
  "실행됨 명령 N개, 읽기 파일 N개 ›" 접힘 요약으로 끼워집니다. 행을 클릭하면
  읽은 파일이 우측 파일 뷰어로 열립니다.
- **질문 시트가 영상 UX로 다듬어졌습니다.** 제출 ↵ 버튼, 기타 숫자키 포커스,
  답변 후 질문+답 인용 카드(원문 스캐폴드 버블은 숨김, 재로드 시 질문별 답 복원).
- **메시지 호버 액션** — 복사 아이콘 + 읽어주기(TTS).

### Fixed

- **완료 순간 중간 해설이 사라지던 문제.** claude CLI의 result가 마지막 메시지만
  담아 스트리밍 전사본을 덮어쓰던 것을 전사본 우선으로 수정했습니다.
- codex 도구 행 중복(command_execution 완료 미인식), 모델 팝오버가 트리거
  반대편에 열리던 문제, 실행 중 채팅 재진입 시 경과 시간이 0초부터 다시 세던
  문제를 함께 수정했습니다.

## 0.8.1 — 2026-07-12

### Fixed

- **Grok Imagine is visible again in multimodal settings.** The image and
  video choices reuse the existing official Grok CLI/OAuth media boundary and
  remain explicit selections, so the automatic provider order is unchanged.
- **The catalog regression is release-gated.** OAuth readiness, provider
  round-tripping, and the built Settings UI now verify both Grok entries.

## 0.7.46 — 2026-07-12

### Fixed

- **The live Hub status regression gate is deterministic on hosted Linux.**
  Normal loopback catalog responses use a CI-safe deadline, while the dedicated
  slow-endpoint case still proves that production readiness checks remain
  bounded well below the 15-second catalog request timeout.

## 0.7.45 — 2026-07-12

### Fixed

- **The v0.7.44 mobile and studio work now ships with the full production
  stabilization line.** Browser scrolling/profile ownership, durable drafts,
  chat routing, updater continuity, Electron 43, and the signed-release gates
  from v0.7.43 are integrated instead of being silently rolled back by the
  parallel release history.
- **Dashboard readiness reports real evidence.** Agentlas OS reads the active
  runtime `RELEASE`/manifest version instead of showing Python, CLI versions are
  parsed across Claude/Codex/Gemini/Grok output formats, and an explicit full
  check bypasses stale runtime caches.
- **Hub status no longer treats a five-minute catalog cache as a live
  connection.** Bounded, single-flight catalog probes distinguish live,
  partial, cached, and offline states without unrelated Firm/Bundle failures
  overwriting the Dashboard result.
- **Unverified Grok media stays fail-closed.** The official Grok CLI remains a
  supported text runtime, while image/video options stay hidden until the CLI
  exposes a verifiable production capability.
- **Release identity is now atomic.** Tag, `package.json`, both package-lock
  version fields, embedded Agentlas OS, update compatibility, and
  `HEPHAESTUS_REF` must agree before any platform can publish.

## 0.7.44 — 2026-07-12

### Added

- **Desktop-to-mobile pairing foundations** add a local TLS bridge, scoped
  device authority, replay protection, sanitized projections, and Settings QR
  management without moving the LLM runtime to Agentlas Cloud.
- **T-rex and Oberon generation paths** gain stronger active-runtime routing
  and preserve the supported Grok text model stack.

## 0.7.43 — 2026-07-12

### Fixed

- **Chat routing QA is locale-independent.** Stable mode, stop-state, gate, and
  destination-page contracts now verify Find agent and cancellation flows in
  Korean and English without relying on translated button text.

## 0.7.42 — 2026-07-12

### Fixed

- **Chat routing QA matches clean-device inventory.** Keyboard-to-pointer
  autocomplete selection is verified with the agents actually present, rather
  than depending on an unrelated third local item.

## 0.7.41 — 2026-07-12

### Fixed

- **Prompts retry QA waits for the destination document.** The retained-prompt
  assertion now waits for the new chat execution context, removing a clean-mac
  navigation race without weakening the product contract.

## 0.7.40 — 2026-07-12

### Fixed

- **Cross-platform release gates follow Electron 43's install contract.** Linux
  CI installs the lazy Electron platform binary before configuring the SUID
  sandbox helper, and fails closed instead of bypassing Chromium's sandbox.
- **Startup Studio UI QA is locale-independent.** The new-idea handoff is
  verified on clean English CI runners as well as Korean dogfood machines.

## 0.7.39 — 2026-07-11

### Added

- **Oberon opens as a production console, not a marketing hero.** Seven real
  production gates, execution boundaries, saved local projects, and one clear
  start action replace the decorative demo surface. T-rex gains source-safe
  attachments, resilient AI content generation, and select-to-edit.
- **Official xAI Grok CLI is available as a text runtime.** Agentlas uses the
  official OAuth-capable CLI contract, keeps prompts out of process arguments,
  and parses streaming output without exposing private thought events.

### Fixed

- **Dashboard LLM connections stay visible above the fold.** A stale collapsed
  preference can no longer hide the connection and usage panel.
- **Browser explanations reflow and scroll correctly.** Long structured
  explanations remain readable in narrow windows, and the browser surface
  accepts normal wheel scrolling.
- **Draft and retry paths preserve user work.** Document Studio restores local
  drafts, Prompt Store retains failed starts for retry, Settings isolates
  partial provider failures, and Startup Studio receives the idea entered on
  launch.
- **Chat no longer waits on unrelated metadata.** A slow Hub, MCP, generated-App,
  or Keychain/env read cannot leave a valid local agent chat disabled, and a
  delayed agent switch cannot undo a newer auto-routing choice.
- **Telegram and updater transitions are bounded and recoverable.** Telegram
  requests have finite deadlines and binding creation compensates Keychain/DB
  failures; accepted Windows updates relaunch the app explicitly.
- **Grok media is fail-closed.** The installed official CLI does not expose a
  verifiable image/video capability, so T-rex, Oberon, and multimodal settings
  no longer advertise Grok Imagine as ready. Grok text chat remains available.
- **Desktop and Terminal keep an explicit product boundary.** Documentation and
  regression gates point to the independent Agentlas Terminal repository
  instead of the removed Desktop CLI mirror.
- **The packaged shell is back on a supported security line.** Electron moves
  from the end-of-life 33 line to 43.1.0, the packaging toolchain moves to
  26.15.6, the SQLite binding moves to its Node 24-compatible line, and PostCSS
  is pinned above the current escaping advisory.

## 0.7.34 — 2026-07-11

### Added

- **Hub bookmarks now follow the signed-in Agentlas workspace.** Desktop keeps an
  account-scoped local cache and offline outbox while the Web bookmark API remains
  canonical. Fresh snapshots propagate immediately to Dashboard, the organization
  tree, Marketplace, Agent Groups, and Chat without waiting for a remount or polling.

### Fixed

- **Hub calls fail closed against live authority.** A bookmark, stale registry row,
  refused bundle, empty response, or partial task force can no longer be presented or
  executed as a generic borrowed expert. Explicit borrowed agents and saved groups are
  revalidated on every invocation, and remote package instructions stay in user input
  rather than being promoted to a system prompt.
- **Long automations keep an owned, recoverable lease.** Active runs renew their lease,
  persist throttled progress, stop when ownership is lost, and recover only after more
  than four hours of real silence. Removing an automation now removes its run
  projections atomically; the v52 migration clears historical orphan rows and closes
  abandoned running snapshots without touching live work.
- **Updates capture continuity only after mutable background work settles.** New
  automation dispatch and Hub bookmark sync are fenced and drained before the updater
  snapshots the database. Cancelled or failed installs resume those writers; accepted
  installs keep them quiesced through restart.
- **Release jobs use exact tagged source and narrowly scoped credentials.** Manual and
  tag releases validate strict SemVer, require `HEAD` to match the tag commit, disable
  persisted checkout credentials, keep signing/Railway/publish secrets on only the
  steps that need them, and use the dedicated cross-repository release token.
- **Pre-mobile production regressions are executable gates.** v52/v53 migrations,
  bookmark account switching, automation lease loss, updater continuity, borrowed Hub
  refusal, child-process `EPIPE`, browser ownership/scroll, Build registration, and
  renderer roster readiness run before signed packaging.

## 0.7.33 — 2026-07-11

### Added

- **Site Studio now keeps a durable design conversation.** Generate, inspect,
  select, revise, and version screens with live user-facing feedback, then hand
  an immutable design revision into Build without overwriting an active build.
- **Agent Trust readiness is visible on Dashboard.** The runtime panel reports
  the actual local engine, host runtimes, Cloud session, and Hub callability
  boundaries without presenting package security grades as creator reputation.

### Fixed

- **A successful Build becomes a local asset immediately.** Registration no
  longer waits on a second unbounded LLM classification. A passed package is
  committed to the installed-agent registry and, for teams, its firm and org in
  one transaction; Dashboard, My Agents, and Chat reconcile without reload in
  both fast and delayed completion paths.
- **Agent names are not mistaken for hidden system workers.** User-owned agents
  named “Orchestrator”, “App Builder”, “Packager”, or “Governance” follow the
  explicit visibility field. Background built-ins remain hidden.
- **Re-import and security transitions stay consistent.** Concurrent automatic
  and manual imports are single-flight, stale Build completions cannot mutate a
  newer session, a passed re-scan resumes registration once, route rollback is
  atomic, and team-to-single changes remove obsolete organization projections.
- **Chat reset is an atomic context reset.** `/clear` removes messages and every
  local runtime resume pointer together, rejects active runs, invalidates stale
  recap/steering state, and keeps the approved working folder. Completed run
  receipts collapse while failed or interrupted receipts remain open.
- **Site and T-rex state survive real product transitions.** Site transcripts
  use atomic replacement and surface corruption instead of overwriting it;
  project operations remain locked across page remounts; T-rex labels and model
  choices follow the selected language.
- **Signed release gates cover the new contracts.** macOS release CI now blocks
  on local import, Build roster synchronization, Site Studio durability, Chat
  reset, T-rex locale, automation watchdog, browser ownership, Hub bookmark,
  and Runtime Readiness regressions.

## 0.7.32 — 2026-07-11

### Fixed

- **Automation timeouts distinguish a hang from a long tool.** An idle runner still
  stops after 480 seconds without events, while a known active tool gets a separate
  1,200-second silence budget. This keeps genuine hangs visible without aborting a
  healthy build, render, or browser action merely because the tool emits no interim
  semantic events.
- **Closed child pipes no longer crash the Electron main process.** Runtime prompt
  delivery, Document Studio, T-rex, and the generated Browser MCP launcher now guard
  early child exit and late stdin/stdout writes, including asynchronous `EPIPE`.
- **Hub bookmarks stay callable in Chat immediately.** A delayed mount-time bookmark
  snapshot or transient IPC read failure can no longer erase a bookmark event from
  the `@` autocomplete list.

## 0.7.31 — 2026-07-11

### Fixed

- **Reliable dedicated-browser login handoff.** Agentlas now settles transient
  macOS process snapshots before classifying CDP port 9222, shares concurrent
  ownership checks, serializes login-window requests, and only calls a listener
  “external” after a persistent verified mismatch. Uncertain and foreign states
  remain fail-closed; the immediate local error keeps the precise failure while
  durable activity logs store only credential-safe reason codes. Legacy browser
  rows containing URL userinfo are removed or redacted before they reach the UI.
- **Browser screen interaction.** Sign-in buttons expose a pending state and
  reject duplicate clicks. The add-site dialog owns its scroll area on short or
  zoomed windows, while the main Browser screen keeps native wheel behavior.
- **Compatible dependency security patches.** Updates the locked Hono, Next.js,
  form-data, shell-quote, js-yaml, and temporary-file packages within their
  existing supported ranges, removing the critical audit findings without a
  forced Electron or packaging-stack major upgrade.

## 0.7.28 — 2026-07-10

### Added

- **Current Codex/GPT model discovery.** Desktop reads the models exposed by the
  signed-in Codex runtime—including current GPT family previews—then preserves
  the chosen model and provider across refreshes without inventing unavailable
  choices.
- **Durable agent and project boundaries.** New run identities, project-scoped
  memory selection, filesystem capabilities, and recovery metadata keep agent
  work portable without leaking one project, task force, or secret into another.

### Fixed

- **Browser actions fail closed.** Payment and unsafe-code actions can no longer
  bypass explicit approval when the approval surface is unavailable. Browser
  passwords are never captured, personal Chrome profiles are never copied, and
  failed legacy Keychain cleanup stays visible and retryable.
- **Safe file access.** File reads require a picker, drop, project, or workspace
  grant; real-path containment blocks traversal and symlink escapes, including
  local media URLs.
- **Data-preserving database repair.** Orphaned chats with messages, run history,
  custom titles, or prior use are recovered under private placeholder agents;
  only truly empty generated shells are removed. Foreign-key integrity remains
  clean after migration and restart.
- **Reliable updates and automation.** SemVer precedence, signed DMG continuity,
  staged replacement/rollback, bounded downloads, finite scheduler settings,
  leases, watchdogs, and visible failure feedback replace silent or unsafe paths.
- **Chat and generated-app UX.** Empty-state guidance, attachment errors, drag
  feedback, copy confirmation, scroll handoff, IME-safe submission, steering,
  single-stop behavior, and generated-app routing now match the actual desktop
  bridge on light, dark, desktop, and compact layouts.
- **Build and borrow continuity.** Builder interviews survive cancel/failure,
  borrowed task-force memory stays scoped, generated apps remain callable from
  chat, and the mock bridge is checked against all 288 preload methods.
- **Hephaestus v1.1.12 embedded.** Desktop release jobs pin the digest-verified,
  rollback-safe Agent OS runtime used by Codex, Claude Code, Gemini, and other
  supported hosts.

## 0.7.27 — 2026-07-10

### Added

- **Current CLI model choices.** Adds friendly labels for Claude Fable 5,
  GPT-5.6 Sol/Terra/Luna previews, and Grok 4.5 when the corresponding runtime
  makes those models available.

### Fixed

- **Model pickers follow the signed-in CLI.** A non-empty discovered model list
  is now the source of truth; the built-in catalog supplies labels and tags, and
  is used as a fallback only when discovery is unavailable. This prevents a
  model such as Grok 4.5 from appearing before the installed CLI advertises it.
- **Codex model selection survives runtime refresh.** The saved Codex model is
  restored into runtime state and its choices remain available after detection.

## 0.7.22 — 2026-07-08

### Fixed

- **Stall watchdog for automations.** Runs that hang mid-way (process alive, no runner
  events) previously showed nothing until the 30-minute node timeout. Both the legacy and
  graph paths now auto-abort after 8 minutes of event silence (configurable via
  `AGENTLAS_AUTOMATION_STALL_MS`), which routes the run into the failure feedback +
  Runtime Doctor path immediately.
- **Teams actually appear in the agent picker.** 0.7.20 fixed the page-level filter but
  the picker component re-filtered teams out internally — team entries were still missing
  from the top-left picker and its search. The internal re-filter now keeps teams;
  callers decide inclusion.
- **Teams appear in the sidebar agent list.** The left sidebar filtered out team
  (multi-agent) entities entirely, leaving users who mostly install teams with an
  empty-looking agent list.

## 0.7.21 — 2026-07-08

### Fixed

- **Automations no longer fail silently or retry forever.** Every failed run now posts
  the failure reason into the automation's chat as a system message. Three consecutive
  failures auto-pause the automation (with an OS notification) instead of re-running the
  same prompt on every schedule tick.
- **Runtime Doctor: poisoned runtime plugin configs are auto-repaired.** A codex CLI
  update silently auto-enabled curated plugins (e.g. Notion) whose unauthenticated OAuth
  remote MCP servers made every codex run die with `AuthRequired` fatals / exit 1 —
  killing all automations for users who never touched those services. The new
  deterministic Runtime Doctor matches the failing host from stderr against the plugin
  cache and disables exactly that plugin (with a config backup), then the automation
  retries on its next slot.
- **System Optimizer second-tier diagnosis.** Repeated failures the Doctor cannot
  classify trigger a one-shot LLM diagnosis run (max once per 6h per automation) that
  audits runtime CLIs, MCP/plugin config, macOS permissions, and environment, and
  reports a structured repair plan into the same chat.
- **Codex engine model pinning.** The app-selected model/effort is now passed to the
  codex CLI explicitly (`--model` / `-c model_reasoning_effort=`). Previously it was
  never forwarded, so machine config — or a codex update's changed built-in default —
  silently decided which model ran.
- **Chat streaming.** Token-delta typewriter reveal (adaptive rAF, snap guard for large
  chunks), steering no longer wipes the in-flight assistant message, and aborted partial
  output is persisted to the chat instead of vanishing.
- **Outputs panel.** Generated files can be revealed in Finder/Explorer via a new
  show-in-folder action; hidden `.agentlas/outputs` artifacts surface correctly.

## 0.7.19 — 2026-07-07

### Changed

- **Terminal CLI surface split out of Desktop.** Removes the bundled desktop terminal
  CLI/runtime surface and its install/test hooks so the desktop app can ship without
  the old in-app terminal install button path.
- **Browser surface English localization.** The Browser page, site cards, add/edit
  modal, activity log labels, approval sheet, and browser-action error outputs now
  respect the active locale instead of leaking Korean into English sessions.
- **Release feed cleanup.** Keeps the macOS packaging path focused on app artifacts
  and update metadata after the terminal CLI removal.

## 0.7.17 — 2026-07-07

### Security

- **Enterprise upload content-safety gate.** Bundles the Hephaestus v1.1.6 engine
  (up from v1.1.1), which hardens `hep-upload` against malicious agent packages.
  The sanitizer now defeats modern prompt-injection obfuscation — homoglyphs,
  leetspeak, zero-width/bidi characters, Unicode Tag-block smuggling,
  separated-letter tricks, and injections split across lines — and detects
  injection/exfiltration in English, Korean, Chinese/Japanese, and major
  European languages, plus secret-exfiltration beacons and high-value credential
  access. It removes only high-confidence attacker directives line-by-line while
  keeping and flagging ambiguous, negated, quoted, or descriptive content, so
  legitimate agent quality is preserved and packages still publish. Verified
  against 139 adversarial vectors (100% stripped) with 0 false positives on 35
  realistic benign samples.

## 0.7.1 — 2026-07-03

### Added

- **Multimodal engine auto-resolve.** Image/video/audio generation now picks a connected
  engine automatically instead of making the agent reason about it at runtime. Default is
  **Auto**: keyless engines first (Codex CLI image_gen, Nano Banana via Antigravity CLI),
  then API-key providers. The chosen engine + readiness is resolved before the run and
  passed to the agent, so it uses it directly. If nothing is connected, the chat shows an
  **"Open multimodal settings"** button instead of the agent flailing with account signup.

### Changed

- **Accumulated fixes from parallel work streams** bundled into this release: automation
  supervisor/health audit, upload Cloud/Hub target selection, chat question sheet, i18n
  leaks, and related desktop UI polish.

## 0.5.9 — 2026-07-01

### Added

- **Automation workflow engine (P0–P2).** Automations are no longer just a prompt on a
  timer. Proper scheduling (full cron + presets + time picker + timezone/DST via croner),
  a **visual node-graph** for every automation (React Flow) that is **auto-generated from
  chat**, condition triggers (file-change, chain, schedule+gate), opt-in launchd
  persistence so schedules fire even when the app is closed, and per-run history. DB
  migrations v33–v35 (graph, schedule spec, timezone, triggers, run history, lease).
- **Parallel workflows.** A chat request can now fan out into **parallel branches**
  (e.g. keyword research → 3 parallel deep-dives → writing → publish). The graph
  generator builds a real DAG with fan-out/fan-in + a layered layout, and the graph
  runner **executes independent branches concurrently** (bounded by the concurrency
  slider), running dependent steps in order. Verified end-to-end in the app.

### Changed

- **Smarter agent import, chat toolbar consolidation, and accumulated fixes** from
  parallel work streams (Oberon motion, Trex studio, Hephaestus, i18n leaks, capture
  media) are bundled into this release.

### Fixed

- Automation review pass: event-driven triggers no longer get promoted onto a clock
  schedule; "Run now" / trigger fires no longer eat the next scheduled slot; condition
  branches persist correctly; per-node agent targets resolve; chat-generated cron parses;
  fs-watcher no longer drops modify events on rename collisions. Removed the confusing
  "completion evidence" runtime note.

## 0.5.8 — 2026-07-01

### Added

- **Autonomous swarm mode (🐝).** Turn one chat into an emergent multi-agent swarm:
  a seed task splits into sub-tasks, workers run in parallel and spawn more work as
  the graph grows, then a synthesizer merges everything into one answer. Safety caps
  (max tasks/rounds, deadlock and infinite-spawn guards) protect your machine and
  wallet; Stop skips the final synthesis to save cost.
- **Continuous live mode ("계속 라이브로").** Keeps the same chat streaming live
  across many execution passes instead of stopping at the 3-pass limit — long,
  uninterrupted autonomous work in one window. Each pass is saved immediately so a
  disconnect never loses progress.
- **Spec-aware concurrency slider (Settings).** How many agents run at once is no
  longer a hardcoded 4. The app reads your CPU/RAM and shows a recommended value;
  a slider (game-graphics-settings style) lets you scale up or down, with a warning
  when you go above the recommendation.

### Changed

- **Chat toolbar consolidated into the + menu.** The bottom bar no longer scatters
  buttons when the window is resized. `/` and `@` moved into the + menu as
  **명령어 (command)** and **에이전트 부르기 (agent call)**; Hephaestus modes
  (find-agent, Stormbreaker, network) moved in too. Active modes show as removable
  chips next to +. The non-functional "앱 생성" entry was removed.
- **Smarter agent import.** Selecting a folder now scans nearby directories for an
  actual agent (looks for `.agentlas/` and other agent markers) instead of blindly
  registering the exact path — and explains *why* when a folder isn't an agent,
  rather than silently showing "no members."

## 0.5.7 — 2026-07-01

### Added

- **Connect GLM, Kimi, and DeepSeek in one click.** New BYOK providers that speak
  the Anthropic Messages API — Settings shows each with a preset endpoint, so you
  paste only the key and the base URL is filled in automatically. GLM (Z.ai) and
  Kimi (Moonshot) coding subscriptions work through their keys; DeepSeek runs
  pay-as-you-go. Routed through the existing Anthropic runner with a per-provider
  preset (`ANTHROPIC_COMPAT_PROVIDERS`).
- **Studio apps (Trex) + Oberon motion.** New agent-built app surfaces bundled in.

### Changed

- **Antigravity CLI.** The Gemini runtime now prefers the Antigravity (`agy`) CLI.
- **Bundled Hephaestus engine → v1.0.5.** Named multi-agent borrow (borrow every
  specialist the operator names) + a temporary orchestrator directive for
  multi-specialist requests.

### Fixed / Performance

- **Big CPU/RAM cleanup for low-end machines (27 files).** Visibility-aware
  polling that pauses when the window is hidden (approval/notification polling
  stays live), runtime child-process listener-leak cleanup, bounded concurrency
  for firm-org and app-factory work, process-group kill + tracking for Oberon
  keyframe and App Factory browser spawns, updater timer `unref` + before-quit
  cleanup, and render hot-path memoization (Bubble/Sidebar/Markdown).

## 0.5.6 — 2026-07-01

### Changed

- **Calmer chat surface for simple runs.** A plain single-agent run now shows a
  one-line status instead of agent cards, the org tree, and internal Stormbreaker
  loop events (armed / scope-lock / route) — those internal events are filtered
  out of the inline status. The card / network view is reserved for runs that
  actually fan out (2+ agents, borrowed Hub task forces, saved agent groups). The
  stop control stays on both the inline status and the input box and still cancels.
- **Resizable chat sidebars.** The left navigation and the right output panel can
  be dragged to resize, with min/max bounds and the width remembered per side.
- Retired the orphaned `/apps/generated` page: visiting it now redirects to Apps,
  and the right-panel output list and `@`-mention no longer link into it.

### Security

- **Main-process hardening (from a Hermes Desktop infra comparison).** Added a
  `will-navigate` guard (the app window can only navigate within `agentlas://` or
  the dev server; external links open in the system browser), a deny-by-default
  permission handler for unused device/sensor capabilities (clipboard and
  notifications stay allowed), and validation of `config:setCustomBaseUrl` (https,
  or http only on localhost/LAN) so a compromised renderer can't redirect the BYOK
  base URL and exfiltrate the API key. Each change was adversarially reviewed for
  side effects before landing.

### Fixed

- The engine now classifies a missing-Python-dependency exit as an actionable
  error and invalidates its cached interpreter/root on structural spawn failures,
  and the renderer auto-recovers from a renderer crash (bounded reload budget).
- Routing plugin-exclusion is carried in the bundled engine for this build, so the
  earlier "make this not look AI-written → Shopify plugin" misroute no longer
  appears (it now surfaces the copywriter agent).

## 0.5.5 — 2026-06-30

### Security

- **Main-process hardening (from a Hermes Desktop infra comparison).** Added a
  `will-navigate` guard so the trusted app window can only navigate within
  `agentlas://` (prod) or the dev server — external links open in the system
  browser instead. Installed a deny-by-default permission handler for
  device/sensor capabilities (geolocation, media, USB/serial/HID, display
  capture) the app never uses, while leaving clipboard and notifications allowed.
  Validated `config:setCustomBaseUrl` (https, or http only on localhost/LAN) so a
  compromised renderer can't redirect the BYOK base URL and exfiltrate the API
  key. Each change was adversarially reviewed for side effects before landing.

### Changed

- **Chat input now grows with what you type.** The composer textarea auto-expands
  from a two-line minimum up to a bounded height (then scrolls internally), and
  collapses back after sending — instead of staying a fixed two rows.

### Fixed

- Routing plugin-exclusion fix now needs to ship in the bundled engine: the change
  lives in the Hephaestus source/runtime but the packaged app carries its own
  bundled engine, so it only takes effect on a rebuild (or once the fix lands in
  the canonical Hephaestus the build clones).
- Packaged builds now pin the embedded engine to Hephaestus `v1.0.4` instead of
  a moving `main` checkout, so the signed app, Windows/Linux builds, and CLI
  runtime release can be traced to the same engine tag.

## 0.5.4 — 2026-06-30

### Added

- **Code map (RECALL layer): the agent can now find code without scanning the
  tree.** On first attach to a project, a compact code-map is generated in the
  background (`<project>/.agentlas/code-map/`) indexing symbols, references,
  modules, entry points and docs. Its seed (modules / entry points /
  most-referenced symbols) is injected into the per-turn memory context, so the
  model orients in a large codebase instead of grepping blindly. Generation is
  best-effort and non-blocking; reading is fully guarded, so a missing or partial
  map never affects a run. The zero-dependency generator is bundled with the app
  (`electron/memory/code-map-gen.mjs`).
- Added a focused Electron QA harness for the chat agent-call surface, covering
  `@` autocomplete keyboard/mouse stability, explicit-agent routing, recommendation
  retry, plain execution payloads, and stop-button cancellation.
- Added an Agentlas Desktop UI/UX stabilization playbook documenting the design
  system and failure patterns that caused recent surface regressions.

### Changed

- `buildMemoryContext` now appends a `### Code map` section alongside project
  soul, sitemap and curated memory when a project map is present.
- **Smoother chat streaming.** Streamed agent text now reveals at a steady cadence
  instead of jumping in whenever a large token chunk arrives. A buffered reveal
  (`useSmoothReveal`) advances the visible text toward the received buffer each
  animation frame, so the answer flows out evenly; it snaps to the full text the
  moment the turn completes, and reading is unaffected when not streaming.
- Renamed the chat router chip from `에이전트 찾기` to `알아서 에이전트 부르기` and
  removed hardcoded tour-source labels from the live workspace.
- Chat and project page tours no longer auto-open over active work; they remain
  available through the help menu.
- Local image outputs and file paths now render as first-class media in the chat
  stream and can open in the right-side preview panel.

### Fixed

- **Chat no longer gets stuck on "working…" after a run finishes.** A fast or
  early-completing run could emit its `final` event (and the active-chats
  broadcast) before the renderer had set the run id and subscribed, so the live
  view never cleared `busy` and the elapsed timer climbed indefinitely — even
  though the answer was already persisted (visible after navigating away and
  back). Added a watchdog that, while a turn is in progress, periodically checks
  the main process's active-run list and reconciles from history the moment that
  run is gone, so a missed completion clears within ~1s instead of hanging.
- **Routing no longer recommends a plugin as an agent.** The local router pooled
  the cached plugin catalog (`type: plugin`, e.g. `plugin/shopify-dev`) together
  with real agent/team cards, so a generic-vocabulary lexical match (e.g. the word
  "AI" in a request) could confidently route to a plugin — "make this not look
  AI-written" was recommending the Shopify plugin at score 15.3. Plugins are tools
  an agent loads via `required_plugins`, not route targets, so they are now
  excluded from the agent route pool. Same request now correctly surfaces the
  `no-ai-slop-copywriter` agent that the plugin's spurious score had been hiding.
- **Agent-call autocomplete no longer jumps away from the hovered or keyboard-selected
  row.** Autocomplete active state now resets only when the actual trigger/query
  changes, not on every parent render.
- **Explicit `@agent` selection disables automatic routing.** Choosing an agent
  directly clears the recommendation mode so the selected agent is the one that
  runs.
- **Recommendation-sheet controls now keep the user in flow.** `다른 에이전트 찾기`
  reruns route preview without closing the sheet, and `추천 없이 실행` no longer
  forwards a hidden router agent or borrowed-agent payload.
- **Stop is visible and actually cancels.** The chat input and live working card
  expose a stop control, preserve the current run id across metadata refreshes,
  and send cancel even if the stop request races with run-id arrival.
- Gemini CLI launches with a real terminal/color environment and disables default
  extensions for prompt runs; Grok CLI can now load its API key from the local vault
  when the process environment is missing it.

## 0.5.3 — 2026-06-30

### Changed

- **Borrowed Hub task-force permissions now follow the chat permission.** Hub
  agents are no longer hard-forced to read-only in the planner, delegate, or
  synthesis sub-runs. If the user selects read-only, they stay read-only; if the
  user selects read-write or full access, the borrowed task force receives the
  matching runtime permission and MCP/tool bridge for that run while the host
  policy still blocks secret exfiltration and permission escalation.
- Reworded Marketplace docs and QA references around Hub-only catalog behavior:
  Desktop no longer presents an offline in-memory marketplace fallback, and
  offline Hub failures should remain visible as empty/error states.
- Localized the top navigation dropdowns and Library headers so the new Agent
  group path renders cleanly in both Korean and English.

### Added

- Added **Agent group** under the Agent menu: users can drag installed agents,
  org-chart nodes, and live Hub agents into a saved top-level orchestrator group.
  Groups re-resolve members from the latest local org chart and Hub catalog,
  surface route/missing-agent warnings, and allow removing one member without
  deleting the whole group. Saved groups can now start a chat directly; the
  chat stores `agent_group_id` and runs the resolved roster through the local
  task-force orchestrator instead of flattening it into one prompt.

## 0.5.2 — 2026-06-30

### Added

- **Live Hub borrowed task-force execution.** Selecting multiple Hub agents from
  the recommendation sheet now runs a real local orchestrator flow instead of
  flattening them into one prompt: plan per-agent input packets, run each
  borrowed Hub agent in an isolated local sub-session, then synthesize the final
  answer.
- Added visible coordination events for borrowed Hub TF runs:
  `plan → delegate → synthesize`, with per-agent `borrow:<slug>` completion
  markers so the right panel can show the actual handoff.
- Added regression and live smoke harnesses for the borrowed task-force path.

### Security

- Borrowed Hub sub-runs are forced to read-only permission and no longer inherit
  MCP auto-approval config, allowed-tool lists, Codex MCP config args, or vault
  environment variables from the orchestrator.
- Added host-policy prompts for untrusted borrowed directives, secret-file
  refusal guidance, and output redaction for common tokens/API keys/private keys
  across status, tool, partial, and final events.

### Changed

- Recommended pipeline stages now reach the main runtime as an execution
  contract, not only as a placeholder UI stepper.
- Desktop Build copy and README keep the pricing boundary explicit: Build itself
  is 0 Agentlas credits; model usage is the user's runtime/subscription/key;
  Hub Network calls remain separately quoted and credited.

## 0.5.0 — 2026-06-29

22개 UI/기능 항목 + 3차 병렬 검수 + 버그헌터 5스웜 수정.

### Fixed

- **Hub 에이전트를 다시 불러옵니다.** 검색이 존재하지 않는 REST 엔드포인트
  (`/api/marketplace/agents`, 404)를 호출해 항상 비어 있던 문제를, 동작하는 MCP
  `marketplace.search_agents` 경로로 전환하고 결과에 `source` 마커를 부여해
  마켓 화면의 live-hub 필터에 걸러지지 않도록 수정.
- **새 채팅이 무한 기록되던 문제** — 최근/프로젝트/회사 목록이 메시지가 있는
  채팅만 표시(빈 새 채팅은 첫 메시지 전에 기록되지 않음).
- 다크 모드: 베이스 accent/상태 토큰이 라이트 팔레트를 상속해 대비가 무너지던
  문제(올리브 버튼 + 흰 글자, 흐린 placeholder)를 전용 다크 토큰맵으로 교정.
- 멀티모달 fallback·영상 설정을 한 줄 리스트로 정리(활성 행 클리핑 수정).
- 조직도 글자 겹침 + 그룹 "전체 제거" 버튼, 우하단 도움말(?) 영구 숨김(×).
- 검수/버그헌터 후속: 캐시 히트 시 Hub 상태 배지 stale, 마켓 페이저 클램프,
  멀티모달 저장 오류 처리, 조직도 제거 실패 시 목록 새로고침, 대시보드 최근 대화
  폴링 갱신, 스튜디오 벤치 영상 poster/자동재생.

### Changed

- **워크스페이스 좌측 사이드바 병합** — 채팅/프로젝트에서 글로벌 네비(SideNav)가
  사라지던 문제를 해결: 아이콘 전용 SideNav를 채팅 Sidebar와 하나의 레일로 합침
  (에이전트 관리 등 글로벌 진입점 유지).
- **대시보드 전역 오케스트레이터 모델 설정**(엔진/모델/effort) + 최근 대화
  페이지네이션(5개). CLI 활성화 중복 정리.
- **Hub 메뉴 단순화** — 상단 카테고리 섹션 제거, 검색 + 에이전트 카드 + 페이지네이션만.
- **Agentlas Studio 리디자인** — 넷플릭스 그리드 폐기, 컨트롤룸 헤더 + 벤치 + 랙
  구조(라이트/다크 안전). **대시보드 Hub 빌려쓰기**·**다크 모드** 리디자인
  (no-slop-designer, 레퍼런스 그라운딩).
- **프로젝트 단순화** — Ontology UI 제거, 채팅 관리(메모리·활동 공유) 용도로 축소,
  새 채팅 시 프로젝트/일반 선택 팝업.
- 슬래시/앳 힌트 한·영 병기: `/` → 명령어(command), `@` → 에이전트 부르기(agent call).
- 퍼블리싱/Hub fetch 5분 TTL 캐싱.
- 생성물(만든 앱/도구/화면/자료) 라이브러리 라우트 제거. 페이지 투어 카피 재작성.

## 0.4.7 — 2026-06-29

### Fixed

- Restored the left sidebar navigation, which had disappeared after an
  incomplete navigation refactor left `AppShell` hiding `SideNav` on chat routes
  and moved a half-built menu section into the chat `Sidebar`.

### Changed

- Brought back the full grouped left navigation in `SideNav`, porting the 0.4.0
  menu structure onto the current shell: **Dashboard** and **Workspace** as
  top-level items, plus the **Agent Forge** (Build, Agent), **Studio** (Apps,
  Automations), **Hub** (Agent Hub, Publish), and **Environment** (Connection
  Keys, MCP Tools, Apps Library, Tool Library, Surfaces, Assets) groups. All
  labels reuse existing localized `nav.*` keys; all 14 menu routes were verified.
- Removed now-dead query-param branches from the `SideNav` active-state helper.

## 0.4.4 — 2026-06-29

### Changed

- Set Desktop Build pricing to match the BYOK/BYOC model: single-agent builds
  now show 5 credits and multi-agent team builds show 10 credits.
- Added visible Build mode credit badges and kept the desktop surface smoke test
  locked to the new 5/10 credit display.
- Removed public-source hygiene issues from the desktop repo: local absolute
  paths in Oberon tooling, a realistic-looking fake API key in a smoke test, and
  absolute Playwright proof paths are no longer committed.

## 0.4.3 — 2026-06-29

### Changed

- Re-released the desktop app with Hephaestus v1.0.0 as the embedded Agent OS
  engine baseline.
- Preserved the Router Agent runtime injection from 0.4.2 and paired it with the
  v1.0.0 routing engine release so low-confidence Agentlas Hub routing can keep
  its escalation context across the desktop runtime handoff.
- Refreshed the production update feed target for the 100K-agent routing rollout
  after the R2 marketplace index and Atlas vector search path were activated.

## 0.4.0 — 2026-06-28

### Added

- Redesigned the first-run onboarding into a 5-step, Duolingo-style learning path: pick a goal → connect your AI → ask a live guide → hire your first agent → graduate with a day-1 streak.
- Added a live guide step: the AI you just connected answers your real questions right inside onboarding — a real model response, with no demo or fallback answers.
- Added an always-available help button so you can replay the setup or take the menu tour again anytime.
- Added local streaks and milestone tracking that reflect what you actually did during onboarding (no fake rewards).
- Rewrote all onboarding copy in Korean and English for a warmer, clearer first run, keeping product terms (agent, skill, Hub, Stormbreaker) and dropping engineer jargon.
- Added the always-on Stormbreaker Loop as the default execution discipline for non-trivial chat and automation work.
- Added visible `Stormbreaker Loop` activity events to the chat working panel, including armed, scope-lock, route, and final-gate stages.
- Added automatic goal decomposition, work-packet/sub-agent architecture instructions, immediate continuation passes, and hidden `every-30m` long-run continuation automations for loop-worthy work such as app builds, game builds, automations, trading/ops runs, deployment, debugging, and data/report generation.
- Added bounded repair/retry for invalid Agentlas Surface manifests: the desktop now re-prompts for a corrected manifest and re-validates before accepting it.
- Added Hephaestus Network as a default MCP plugin and added request-aware MCP auto-selection for Claude Code/Codex runs.
- Added GPT-5.5 Codex/GPT-5.5 model options.

### Changed

- Scheduled automations now receive the same Stormbreaker Loop prompt as chat runs, so recurring jobs are prompted to resume from evidence, verify state where tools allow it, act, and record changes. This does not by itself verify external account actions such as Instagram posting.
- Scheduled automations now reuse one hidden durable chat session per automation instead of starting each run from an empty background chat.
- Removed the Settings Stormbreaker toggle; the compatibility IPC now reports/enforces enabled state.
- Corrected plugin wording so credentialless catalog entries can be auto-enabled, while credential-gated tools remain candidates until vault values exist.
- Removed the first-draft automation loop note from the automation page in favor of the broader Stormbreaker loop model.
