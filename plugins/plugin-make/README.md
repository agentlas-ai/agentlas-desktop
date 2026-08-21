# Plugin Builder

Build a local Agentlas procedure plugin from a conversation, then verify and run it before reporting success.

## Workflows

| Skill | Purpose |
| --- | --- |
| interview | Resolve the request, workflow, host capability, permission, and state decisions. |
| draft | Turn the answers into a normal plugin package in staging. |
| verify | Run the canonical package gate and integrity checks. |
| install | Install or update the local package while preserving user state. |
| prove | Inject the router and invoke one workflow for an execution receipt. |

## Limitations

This builder creates local procedure plugins only. It does not publish to the Agentlas Hub, create tool providers, or edit built-in packages.
