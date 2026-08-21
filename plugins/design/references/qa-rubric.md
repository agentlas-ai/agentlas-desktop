# Design QA Rubric

Systematic evaluation criteria for comparing coded prototype implementations against visual source designs.

## 5 Required Fidelity Surfaces
1. **Fonts & Typography**: Font family, optical weight, size, line-height, letter-spacing, text wrapping, and visual hierarchy.
2. **Spacing & Layout Rhythm**: Margins, padding, grid alignment, section gaps, component spacing, border radii, and elevation/shadows.
3. **Colors & Visual Tokens**: Color palette, gradients, opacity, contrast ratios, and semantic state styling (hover, focus, active, error).
4. **Image Quality & Asset Fidelity**: Asset resolution, aspect ratio, cropping, and art-direction alignment. (Never substitute custom inline SVGs, CSS shapes, or text glyphs for real assets.)
5. **Copy & Content**: Accurate reproduction of labels, values, headings, and placeholder copy from the source design.

## Severity Levels
- **P0 (Critical)**: Blocks core usage, severe accessibility failures, broken layouts, or impossible user tasks.
- **P1 (Major)**: Major visual mismatch or usability regression likely to be noticed immediately by users.
- **P2 (Moderate)**: Moderate visual drift, state inconsistency, or responsive layout issues.
- **P3 (Minor)**: Minor polish differences that do not block acceptance.
