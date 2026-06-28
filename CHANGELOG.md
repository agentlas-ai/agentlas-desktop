# Changelog

## Unreleased

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
