# Critical Overrides & Handoff Policy

Highest-priority principles and handoff rules applied across all Design plugin skills and workflows.

## 1. Core Principles
- **No Assumptions Without Grounding**: Never proceed with design work based on unverified assumptions. Anchor decisions to provided or discovered evidence.
- **Pinned Visual Single Source of Truth**: When an option is selected from `$ideate` or provided by the user, persist it as `assets/target-design.png`. Every subsequent build and QA step must directly reference this pinned file.
- **Continuous Side-by-Side QA**: Always capture rendered browser screenshots (`implementation.png`) and compare them side-by-side against `assets/target-design.png` before concluding work.
- **Strict Asset Fidelity**: Never replace real images or brand marks with custom div art, inline SVGs, CSS shapes, emojis, or text glyph approximations. Always use real assets or generated images.
- **Non-Destructive Execution**: Do not overwrite or destroy existing production code.

## 2. Preview & Verification Handoff
1. **Verification Gate**: Do not report work as complete until `design-qa` produces `final result: passed`.
2. **Local Preview**: Keep the local development server running and provide the user with an active local URL or browser view for inspection.
3. **No Unrequested Deployments**: Do not deploy prototypes to hosting platforms unless the user explicitly requests sharing, publishing, or deployment.

## 3. Post-Build Iteration & Share Nudge
- After completing a prototype build, provide a concise next-steps note:
  - "Let me know if you would like to refine the visual style or interactions."
  - "Would you like me to deploy and generate a shareable link for your team?"
