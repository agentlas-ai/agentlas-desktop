# PRD: Built-in Agentlas App Builder Agent

## Problem

Apps Generate previously behaved like a prompt wrapper around whichever chat agent was active. A later embedded-runner design put generated user-app UI inside Agentlas Desktop, but that broke the terminal path and made generated apps depend on Desktop-specific React screens.

## Goal

Ship a built-in `agentlas-app-builder` agent that owns Apps Generate and turns app-worthy user goals into local web app packages registered in Agentlas Desktop Apps.

## Scope

- Add Agentlas App Builder to the built-in architecture manifest with a stable slug and visible installed-agent row.
- Route Apps Generate to App Builder even when the current chat uses another domain agent.
- Auto-route plain requests like "generate app", "app builder", "내장 앱", and "앱 만들어줘" to App Builder.
- Require App Factory actions, Apps registry CTA behavior, and a `launchUrl`/dev command for the generated local web app.
- Include design-reference pattern extraction while blocking third-party service names from deployed product copy.
- Update architecture docs, sitemap, and validation evidence.

## Non-goals

- No new DB schema.
- No external hosted builder service.
- No App Store publishing automation.
- No provider credentials, checkout, cookies, OTPs, or raw tokens.

## Acceptance Criteria

- `BUILTIN_AGENTS` contains `agentlas-app-builder`, `ARCHITECTURE_VERSION` is bumped, and `cli/architecture.data.json` regenerates with the new built-in.
- Apps Generate auto-routes to `agentlas-app-builder` regardless of the previously selected chat agent.
- Auto-router tests prove Korean and English app-generation prompts select App Builder.
- `npm run typecheck`, `npm run build`, and the App Builder routing smoke test pass.
- Product docs state that generated Apps stay listed in Agentlas Desktop but execute as localhost/browser-based web apps.
