# PRD: Agentlas Apps Document Studio

Date: 2026-06-02
Owner: Agentlas Desktop
Status: active

## Problem

The current Apps work only proves that Agentlas can label marketplace/library
surfaces as Apps and pass an `appsGenerateMode` flag into the runner. It does not
prove that a user can open a real App inside Agentlas Desktop or create a
AI document generator and editable report workspace from the desktop surface.

## Decision

Ship a concrete first-party App surface:

- `/apps`: an installed Apps launcher with App Store, Vault, and Engines as
  sub-surfaces.
- `/apps/document-studio`: a local Document Studio App that opens inside the
  Electron/Next renderer with browser-like tabs, a prompt, generated document
  output, editable sections, figures, references, and an "open in Apps" proof CTA.
- Chat slash commands `/apps` and `/docstudio` so any active AI chat can open the
  App surface.
- Apps Generate responses append a stable Apps CTA when the model does not
  already provide one.

## Scope

In scope:

- Renderer-only App runtime proof using React/Next and local component state.
- Deterministic document generation for verification without requiring a live LLM.
- Navigation and copy updates proving Apps are top-level and vault/assets/MCP are
  support devices.
- Typecheck and browser smoke verification.

Out of scope for this pass:

- Persistent SQLite app registry.
- Remote publishing pipeline.
- Real LLM-generated files from `apps-generator`.
- Multi-window native Electron child windows.

## Acceptance Criteria

- The Desktop sidebar has a first-class Apps entry that opens `/apps`.
- `/apps` renders an app-store-like icon tile for Document Studio and links to
  Store, Vault, and Engines.
- `/apps/document-studio` renders a functional document generator App.
- The Document Studio App can generate a report-like document from a prompt and
  the text remains editable.
- Chat slash commands include and route `/apps` and `/docstudio`.
- `McpInvocationRequest.appsGenerateMode` still reaches the main runner.
- Apps Generate post-processing appends `/apps/document-studio` for document/text
  generator prompts.
- `npm run typecheck` passes.
- Browser verification confirms visible Apps launcher and Document Studio output.

## Change Log

- 2026-06-02: PRD created for the concrete Apps runtime proof.
