---
name: audit
description: "Captures and reviews product journeys, funnels, screens, and multi-step user experiences based on screenshot evidence, evaluating UX, visual design, and accessibility."
---

# Skill Purpose
Evaluates existing product interfaces and flows through direct step-by-step browser capture, producing an evidence-grounded UX, design, and accessibility audit report.

# Preconditions
- The target product URL or interface and the specific user journey (e.g., onboarding, checkout, signup, settings) must be identified.
- Browser capture capability (such as `@agentlas-browser` or `@playwright`) must be available.
- Adhere to `$critical-overrides` and `$design-audit-framework`.

# Steps
1. **Initialize & Navigate**: Open the target flow and wait until the initial screen is fully loaded and visually stable.
2. **Step-by-Step Capture & Inspection**:
   - Advance through the user journey one action at a time.
   - Capture a clean screenshot at each state and save it sequentially (e.g., `01-start.png`, `02-form-filled.png`).
   - Observe visual hierarchy, validation behaviors, loading states, empty states, keyboard focus, and contrast.
3. **Analyze Findings**: For each step, note observed strengths, UX friction points, accessibility risks, and limits of screenshot-only inspection.
4. **Compose Inline Report**:
   - Assemble an inline markdown report pairing numbered steps directly with their corresponding screenshots.
   - Include an executive summary, step-by-step breakdown, top-priority recommendations, and clear evidence limits.
5. **Optional Figma Board**: If explicitly requested by the user, plot the accepted screenshots and notes onto a Figma canvas.

# Outputs
- Sequentially saved flow screenshot files.
- Evidence-grounded inline UX and accessibility audit report.

# Verification
- Ensure every reported issue and strength is tied 1:1 to an actual captured screenshot.
- Verify that no speculative claims or ungrounded opinions are presented as audit facts.
- Confirm that accessibility assessments clearly state what was visually observed versus what requires automated/screen-reader testing.
