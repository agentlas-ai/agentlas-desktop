---
name: user-context
description: "Manages plugin onboarding, inspects or updates saved product and design sources, and maintains user preferences."
---

# Skill Purpose
Handles user-specific preferences, saved design tokens, brand assets, product repositories, and onboarding context across sessions.

# Preconditions
- The user requests to set up, inspect, or update saved preferences, brand guidelines, product URLs, or design assets.
- Initial setup context is required before running design workflows.

# Steps
1. **Inspect Stored State**: Check for the existence of `.state/user-context.md` or saved configuration files.
2. **Classify Intent**: Identify whether the request is initial onboarding, viewing saved context, or updating specific design parameters (e.g., brand colors, default browsers, token paths).
3. **Update or Retrieve Context**: Record or output product URLs, Figma tokens, typography preferences, and share endpoints.
4. **Respond Succinctly**: Summarize the updated or recalled preferences and signal readiness for design tasks.

# Outputs
- Maintained and updated `.state/user-context.md` state file.
- Concise summary message displayed to the user.

# Verification
- Validate that all stored paths, URLs, and token configurations are well-formed.
- Ensure that setup-only requests do not trigger premature prototype builds or file scaffolding.
