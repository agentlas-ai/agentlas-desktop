# Automation session continuity findings — 2026-07-15

## Scope

This report maps the 928-line automation transcript captured on another
computer to Desktop runtime behavior. The transcript does not prove that every
cycle created a new Codex task: several cycles clearly reference prior state.
It does prove that execution alternated between runtime-authority lanes with
different workspace and browser access.

## Root causes

1. The automation owned a hidden chat but did not own a runtime selection.
   Each run could re-read the global active runtime, moving the same automation
   between Codex and Claude and therefore between unrelated CLI session stores.
2. CLI resume failure was silently converted into session deletion plus CREATE.
   That made a backend/session fault look like a valid new conversation.
3. The Korean phrase `작업 루트는 /Users/...` was outside the English-only cwd
   inference grammar. The runner fell back to Agentlas `agent-cwd`, so a
   workspace-write sandbox correctly denied the requested Downloads path with
   `EPERM`. This was not a chmod or macOS ownership defect.
4. The output classifier did not recognize `EPERM`, `Operation not permitted`,
   generic halt/blocked statements, or a tool event carrying `isError=true`.
   A blocked run could be persisted as `ok`, preventing the three-failure pause.
5. Social-site heuristics could select Computer Use even when the prompt named
   the authenticated Agentlas Browser/CDP port. Browser mode also admitted a
   separate Playwright profile, losing the logged-in identity.
6. A Hub package version was stored and displayed but the ordinary single Hub
   borrow preamble did not pass it to `hepCall`; only Team/TF paths were pinned.

## Repairs in v0.8.38

- Persist an exact runtime selection on first execution and fail closed if it
  later becomes unavailable.
- Add lifecycle receipts and prohibit unattended resume-failure CREATE.
- Inject a bounded prior-outcome capsule independent of provider resume.
- Recognize Korean workspace-root language and persist the resulting hidden-chat
  cwd; validate it with a two-run automation-store contract.
- Classify terminal outcomes as `ok`, `skipped`, `blocked`, `needs_input`, or
  `error`, with stable reason codes and bounded evidence while preserving the
  existing run-history compatibility status.
- Treat failed tool events as execution failures and preserve the three-run
  automatic pause behavior.
- Give explicit Agentlas Browser/CDP/9222 intent priority and remove fresh
  Playwright-profile fallback from browser mode.
- Propagate per-slug Hub package hashes into the actual `hepCall --version`.

## Release acceptance

- Same automation id and hidden chat across two runs.
- Same pinned runtime selection after a global runtime change.
- Second run prompt includes the first durable outcome capsule.
- Korean workspace root becomes the runner cwd rather than `agent-cwd`.
- `EPERM`, missing input, halt, and tool errors cannot produce `ok`.
- Browser mode contains Agentlas Browser and excludes Playwright/CUA fallbacks.
- Resume failure in an unattended Codex or Claude run cannot create a new CLI
  session.
