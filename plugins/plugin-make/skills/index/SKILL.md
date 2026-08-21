---
name: index
description: Build a local Agentlas procedure plugin from a conversation, with a spec gate and execution proof.
---

# Routing

For an explicit `@plugin-make` request, route through the following workflow skills in order. Ask only for decisions the request did not already resolve.

- Interview and resolve the package identity, router description, workflows, required host capabilities, permissions, and state: $interview
- Write the normal package into staging: $draft
- Run the canonical package gate and integrity checks: $verify
- Install or update the local package without touching `.state/`: $install
- Inject the router and invoke one workflow: $prove

This builder is local-only. It does not publish to the Hub, provide tools, or edit built-in packages. If a required host capability is unavailable, report the limitation and keep the package installed-but-unproven.
