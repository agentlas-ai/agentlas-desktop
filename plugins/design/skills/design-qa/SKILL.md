---
name: design-qa
description: "Compares rendered prototype screenshots side-by-side against the pinned target design, iteratively eliminating visual discrepancies across 5 fidelity surfaces."
---

# Skill Purpose
Acts as the mandatory quality gate before prototype delivery by conducting a 1:1 side-by-side visual comparison between the pinned visual target (`assets/target-design.png`) and the live browser rendering (`implementation.png`), iterating until pixel-faithful alignment is achieved.

# Preconditions
- The pinned visual target (`assets/target-design.png` or equivalent source mockup) must exist.
- A rendered prototype view (`implementation.png` captured from the local browser runtime) must be available.
- If either artifact cannot be retrieved or rendered, mark `final result: blocked` and halt handoff.
- Adhere to `$qa-rubric` and `$critical-overrides`.

# Steps
1. **Normalize Viewport & Pixel Density**:
   - Align the implementation capture (`implementation.png`) and `assets/target-design.png` to the exact same CSS pixel dimensions, aspect ratio, and device scale factor.
   - For mobile apps, evaluate the inner screen content at 1:1 CSS pixels rather than container bezels.
2. **Side-by-Side Comparison & Inspection**:
   - Place `assets/target-design.png` and `implementation.png` together in a side-by-side comparison view.
   - Systematically inspect the 5 required fidelity surfaces:
     - **Typography**: Font family, optical weights, sizes, line heights, letter spacing, and wrapping.
     - **Spacing & Rhythm**: Margins, padding, grid alignment, section gaps, border radii, and elevation.
     - **Colors & Tokens**: Color palette accuracy, background/foreground contrast, and semantic state styling.
     - **Image Quality & Assets**: Asset fidelity, resolution, sharpness, and absence of makeshift CSS/SVG approximations.
     - **Copy & Content**: Accurate matching of headings, labels, metrics, and visible body copy.
3. **Iterative Remediation Loop**:
   - Classify observed differences into P0 (blocker), P1 (major), P2 (moderate), and P3 (minor polish).
   - For any P0/P1/P2 findings:
     1. Apply targeted code/CSS fixes to the prototype.
     2. Re-capture the browser screenshot at the identical viewport and state.
     3. Re-compare against `assets/target-design.png`.
   - Repeat until no actionable P0/P1/P2 differences remain.
4. **Generate QA Report**: Document findings, remediation history, and evidence paths in `design-qa.md` at the project root with `final result: passed`.

# Outputs
- `design-qa.md` verification report in the project root.
- Side-by-side comparison visual evidence.

# Verification
- Run the accessibility floors from `$hig-checklist` as part of the gate — contrast, hit
  target size, text scaling, and both appearances. A pixel-faithful match that fails a floor
  is recorded as a P1 finding, not passed through on fidelity grounds.

- Confirm that `design-qa.md` concludes with an explicit verdict of `final result: passed`.
- Verify that every P0, P1, and P2 visual discrepancy identified during iteration has been resolved.
- Ensure the rendered prototype matches `assets/target-design.png` with pixel-faithful fidelity.
