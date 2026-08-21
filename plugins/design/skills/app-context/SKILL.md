---
name: app-context
description: "Executes creative production board workflows to generate, organize, and explore visual concepts and multi-mode design assets on an interactive canvas."
---

# Skill Purpose
Turns briefs, source assets, and selected items into reviewable multi-asset visual productions on an interactive board surface.

# Preconditions
- A creative production board request or multi-direction visual asset task is specified.
- Adhere to `$board-runtime`.

# Steps
1. **Initialize Canvas Session**: Mount or open the target production board container with the initial brief.
2. **Load Mode References**: Load relevant mode guidelines such as `$ads`, `$scenes`, `$logos`, or `$styles` based on the asset requirements.
3. **Generate Visual Directions**: Produce 4-6 distinct visual variations adhering to brand guidelines and mode rules.
4. **Synchronize Board State**: Register generated image paths and item IDs to the active canvas session.

# Outputs
- Generated visual asset image files.
- Mounted creative production board session.

# Verification
- Confirm that all generated image files exist locally and are valid, non-empty files.
- Verify that item IDs in the board session map accurately to the corresponding assets.
