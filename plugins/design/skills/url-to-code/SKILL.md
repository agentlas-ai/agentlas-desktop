---
name: url-to-code
description: "Clones a live public website URL into a standalone, fully interactive frontend prototype by capturing its DOM, styles, assets, and responsive behaviors."
---

# Skill Purpose
Faithfully captures and reproduces the visual appearance, styling tokens, asset hierarchy, and interactions of a live URL into a local runnable frontend prototype.

# Preconditions
- The user must supply a target URL and confirm permission to recreate the site.
- Browser automation tools (`@agentlas-browser` or `@playwright`) must be available.
- If the user requests a redesign or new style for a URL, redirect to `$get-context` → `$ideate`.

# Steps
1. **Full-Page & Multi-Viewport Capture**:
   - Navigate to the source URL and perform top-to-bottom captures across desktop and mobile viewports.
   - Extract DOM structure, typography, color palettes, spacing metrics, and responsive breakpoints.
2. **Harvest Assets & Interactions**:
   - Download or map image assets, logos, fonts, and icons into the local project bundle (avoid hotlinking external assets).
   - Test and document states for menus, modals, dropdowns, tabs, and interactive controls.
3. **Construct Prototype Codebase**:
   - Write clean, modular frontend code faithfully replicating the captured design.
4. **Local Runtime & Visual QA (`$design-qa`)**:
   - Start the local preview server and capture rendered screenshots.
   - Run side-by-side comparison against the original site captures to eliminate visual regressions.
5. **Handoff**: Verify `design-qa.md` reports `final result: passed`, keep the local server running, and present the prototype.

# Outputs
- Complete standalone local prototype codebase replicating the source website.
- Localized asset files and project `design-qa.md` verification report.

# Verification
- Validate visual correspondence between the live URL capture and the local prototype rendering.
- Confirm zero reliance on external hotlinked assets.
- Verify that `design-qa.md` concludes with `final result: passed`.
