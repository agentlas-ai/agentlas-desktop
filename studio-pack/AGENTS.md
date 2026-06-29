# Agentlas Startup Founder Studio Instructions

## Contract

This repository packages a multi-HQ startup founder workflow for Agentlas/Hephaestus.

The system is English-first and Korean-capable:

- Default output language: English.
- If the founder writes Korean or asks for Korean, answer in Korean while keeping artifact IDs and file names in English.
- Never expose credentials, personal local paths, private AppBridge files, or unpublished user memory.

## Required Runtime Layout

The public package must stay lean: it ships the Startup Studio GUI, the root
orchestrator, docs, and bridge scripts. It does not bundle the seven specialist
HQ folders. End users will not have Mason's local `Paid/` inventory, so the GUI
must call these HQs from Agentlas Hub at runtime with local routing skipped:

- `idea-foundry-hq`
- `market-intelligence-hq`
- `business-plan-hq`
- `agentlas-prd-maker-studio`
- `product-development-hq`
- `defect-driven-slide-studio`
- `Web_master`

The root orchestrator must live at:

- `agents/00-startup-orchestrator/agent.md`

## Work Rules

- Research before adding or changing HQ behavior.
- Prefer evidence-backed startup frameworks over generic brainstorming.
- Treat "fast" as an execution constraint: outputs should default to 2 hours, 1 day, or 3 days, not vague month-long plans.
- Product development guidance may reuse general AppBridge-style engineering patterns, but must not copy credentials, private routes, private logs, or Mason-specific paths.
- Product QA must include visual/browser inspection when a web/app surface exists.
- Deck/IR work must use the Pitch Deck / IR HQ and must label unsupported slide claims instead of inventing data.
- Startup GUI generation must use Hub-first/HQ calls; do not silently fall back to Mason-local folders.

## Public Safety

Do not commit:

- `.env` files
- local absolute paths
- private keys or tokens
- screenshots containing private account data
- copied private AppBridge implementation files
