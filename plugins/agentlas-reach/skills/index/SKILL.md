---
name: index
description: Use apps installed on this computer: see what an app can do, then do it, instead of saying the app cannot be controlled.
---

# Routing

- Do something in an installed app (create, change, export, print, read a value) → `$operate` (`../operate/SKILL.md`)
- An app is partly known or unmapped, or the owner asks you to look at an app → `$explore` (`../explore/SKILL.md`)

# Rule

Before you say an app cannot be controlled, look: `harness_call {"operation":"reach.map","args":{"query":"<app name>"}}` lists the installed apps and how far each is usable (`scriptable`, `partial`, `unmapped`) with its `key`. `reach.app` lists one app's capabilities, `reach.describe` shows one capability's parameters, `reach.invoke` carries it out.

Reach never opens an app on its own, never reads what is inside an app's windows, and keeps passwords, banking, messages and system settings off limits. The owner decides in Settings whether apps are explored; mapping runs in the background either way.
If `reach.*` answers `refused` or `unavailable`, report its `reason` and `next`, and stop.
