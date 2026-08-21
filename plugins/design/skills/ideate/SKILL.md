---
name: ideate
description: "Generates exactly three distinct visual design options with independent layouts and interaction models, iterates on user feedback, and pins the confirmed option as the visual target."
---

# Skill Purpose
Explores product concepts by generating 3 distinct, production-quality visual design options, refines them based on user feedback, and persists the selected option as the pinned visual target (`target-design.png`) for faithful code implementation.

# Preconditions
- The minimum design brief (target product/screen and intended user outcome) must be resolved via `$get-context`.
- No code scaffolding or file modifications are permitted prior to visual concept selection.
- Strictly adhere to `$critical-overrides`.

# Steps
1. **Analyze Brief & Context**: Review the resolved design brief, existing design tokens, brand palettes, and any reference screenshots.
2. **Determine Target Dimensions**:
   - Mobile app: `390 x 844`
   - Tablet app: `834 x 1194`
   - Desktop app / Dashboard / SaaS: `1440 x 1024`
   - Landing / Marketing page: `1440` wide scrollable
3. **Generate 3 Distinct Visual Directions**:
   - Construct 3 separate prompt concepts with distinct information hierarchy, layout strategies, and interaction models.
   - Run generation for each concept independently using the built-in image generation tool (do not combine multiple ideas into one image).
   - For mobile apps, generate content-only views without device bezels, notches, status bars, or home indicators.
4. **Order and Present Selection**:
   - Number the results strictly in the order they appear in the chat context: Option 1, Option 2, Option 3.
   - Send the concise selection prompt: `"Which option should I build: 1, 2, or 3? Or tell me what you'd like to refine or personalize first."`
5. **Incorporate Feedback Loop**: If the user requests refinements or remixes between options, generate updated visual concepts before proceeding.
6. **Pin Target Design**:
   - Once the user confirms Option N, save that image file to `assets/target-design.png` as the persistent single source of truth.
   - Acknowledge the selection (e.g., `"Option 2 confirmed and pinned as target design! Building the interactive prototype now..."`).
7. **Handoff to Build**: Immediately transition to `$image-to-code` with `assets/target-design.png` bound as the active visual anchor.

# Outputs
- 3 independent, high-resolution visual design option images.
- Pinned visual target file `assets/target-design.png`.
- Seamless handoff to `$image-to-code`.

# Verification
- Confirm that exactly 3 distinct images were generated and successfully rendered.
- Verify that each concept demonstrates meaningful architectural and layout variation.
- Ensure the user's selected design is saved as `assets/target-design.png` before build begins.
- Ensure no code files or dev servers were started prior to user selection.
