---
name: image-to-code
description: "Implements the pinned visual target design into a pixel-faithful, responsive, interactive frontend prototype by continuously referencing the pinned target."
---

# Skill Purpose
Translates the pinned visual target design (`assets/target-design.png`) into a fully interactive, responsive frontend prototype by continuously referencing the pinned image, extracting design tokens, and reproducing every layout detail identically.

# Preconditions
- A pinned visual target image (`assets/target-design.png` or equivalent screenshot/Figma node) must be available. Do not begin implementation from a text-only brief.
- Adhere to `$critical-overrides` and `$qa-rubric`.

# Steps
1. **Load & Inspect Pinned Target**:
   - Open and continuously reference `assets/target-design.png` throughout the entire implementation process.
   - Inspect exact typography scale (sizes, optical weights, letter-spacing), color tokens (backgrounds, accents, borders), and layout grid/spacing metrics directly from the image.
2. **Catalog & Produce Real Assets**:
   - Catalog all raster assets (hero imagery, avatars, product illustrations, badges) visible in the pinned design.
   - Generate high-resolution assets using Image Gen matching the exact art direction and aspect ratios.
   - Never replace image assets with handcrafted CSS shapes, div drawings, or emoji text glyphs. Use clean SVG icon libraries for standard icons.
3. **Scaffold & Build Frontend Code**:
   - Scaffold the prototype matching the intended form factor (mobile app 390x844 or desktop web).
   - Write clean, modular HTML/CSS/JS or framework code faithfully matching the typography, colors, and layout rhythm of the pinned image.
   - Implement functional interactive elements: navigation, tabs, inputs, filters, buttons, modal dialogs, and visible UI states (hover, focus, active, loading).
4. **Launch Local Preview Server**:
   - Start the local dev server to render the prototype in a real browser environment.
5. **Continuous 1:1 Side-by-Side QA (`$design-qa`)**:
   - Capture live browser screenshots of the rendered prototype (`implementation.png`).
   - Run side-by-side comparison against `assets/target-design.png` across the 5 required fidelity surfaces.
   - Remediate all visual discrepancies (P0, P1, P2) in code until `design-qa` produces `final result: passed`.
6. **Handoff**: Keep the local development server active and present the completed, verified prototype to the user.

# Outputs
- Runnable frontend prototype codebase matching `assets/target-design.png`.
- High-fidelity generated assets in the project's asset directory.
- Local preview runtime and `design-qa.md` verification report.

# Verification
- Confirm that `design-qa.md` exists in the project root with `final result: passed`.
- Verify that all visual elements, fonts, colors, and layouts match `assets/target-design.png` 1:1.
- Verify that the local development server is running without console errors.
- Ensure all primary interactive controls (tabs, links, inputs) function smoothly.
