# Changelog

## Unreleased

### Added

- Added the always-on Stormbreaker Loop as the default execution discipline for non-trivial chat and automation work.
- Added visible `Stormbreaker Loop` activity events to the chat working panel, including armed, scope-lock, route, and final-gate stages.
- Added automatic goal decomposition, work-packet/sub-agent architecture instructions, immediate continuation passes, and hidden `every-30m` long-run continuation automations for loop-worthy work such as app builds, game builds, automations, trading/ops runs, deployment, debugging, and data/report generation.
- Added bounded repair/retry for invalid Agentlas Surface manifests: the desktop now re-prompts for a corrected manifest and re-validates before accepting it.
- Added Hephaestus Network as a default MCP plugin and added request-aware MCP auto-selection for Claude Code/Codex runs.
- Added GPT-5.6 Codex/GPT-5.6 model options while keeping GPT-5.5 Codex/GPT-5.5 available as legacy options.

### Changed

- Scheduled automations now receive the same Stormbreaker Loop prompt as chat runs, so recurring jobs are prompted to resume from evidence, verify state where tools allow it, act, and record changes. This does not by itself verify external account actions such as Instagram posting.
- Scheduled automations now reuse one hidden durable chat session per automation instead of starting each run from an empty background chat.
- Removed the Settings Stormbreaker toggle; the compatibility IPC now reports/enforces enabled state.
- Corrected plugin wording so credentialless catalog entries can be auto-enabled, while credential-gated tools remain candidates until vault values exist.
- Removed the first-draft automation loop note from the automation page in favor of the broader Stormbreaker loop model.
