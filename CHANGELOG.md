# Changelog

## 0.5.5 — Unreleased

### Changed

- **Chat input now grows with what you type.** The composer textarea auto-expands
  from a two-line minimum up to a bounded height (then scrolls internally), and
  collapses back after sending — instead of staying a fixed two rows.

### Fixed

- Routing plugin-exclusion fix now needs to ship in the bundled engine: the change
  lives in the Hephaestus source/runtime but the packaged app carries its own
  bundled engine, so it only takes effect on a rebuild (or once the fix lands in
  the canonical Hephaestus the build clones).

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
