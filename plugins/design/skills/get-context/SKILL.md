---
name: get-context
description: "Resolves and confirms the minimum required design brief (design target and intended user outcome) without unnecessary friction before transitioning to build workflows."
---

# Skill Purpose
Establishes the fundamental requirements for a new design, prototype, or UI exploration task quickly by confirming the target surface and user outcome without long surveys.

# Preconditions
- A design or build request is initiated where the specific design target (component, screen, app, website) or intended user goal is missing or ambiguous.
- Consult `$user-context` for saved product background or user preferences when available.

# Steps
1. **Analyze Requirements**: Check if (1) design target, (2) intended user outcome, and (3) target platform (mobile/desktop/web) are clearly identified in the request.
2. **Targeted Clarification**: If any critical piece is missing, ask exactly one focused question. Do not re-ask details that are already obvious or answered.
3. **Playback Brief**: Once the brief is clear, play back the core target and sensible defaults in a single concise note.
4. **Handoff Immediately**: Transition directly to the next focused workflow (`$ideate`, `$url-to-code`, or `$image-to-code`) in the same turn without pausing for explicit confirmation.

# Outputs
- Confirmed design brief summary (target surface, user goal, form factor).
- Execution trigger for the subsequent workflow.

# Verification
- Ensure the design target and user outcome are concretely specified.
- Verify that the workflow proceeded directly to execution without blocking on redundant questions.
