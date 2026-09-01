---
name: hig-review
description: "Reviews and improves any UI against Apple's Human Interface Guidelines — accessibility, platform conventions, layout, color and type, materials and Liquid Glass, interaction states, and writing — citing the specific guideline behind every finding and expressing every fix in the user's own stack (web, Electron, React Native, Flutter, native)."
---

# Skill Purpose
Produces a grounded design review: each finding names the guideline that backs it, carries a
severity that reflects consequence, and lands as a concrete change in the user's framework —
not Apple's. Also runs in improvement mode, where the review becomes a sequenced work plan.

# Preconditions
- The surface under review is identified: a URL, a running app, a screenshot, a mockup, or code.
- The target platform and stack are known or inferable. A wrong platform guess invalidates the review.
- Guideline text is reachable — either the local cache (`references/apple-hig/.cache/pages/`)
  or the network. `$hig-sources` explains the cache contract and how to refill it.
- Adhere to `$hig-review-protocol` and `$critical-overrides`.

# Steps
1. **Frame it.** Establish surface, platform/stack, product job, and what the user wants
   (full audit, one concern, or improvements). Ask only what cannot be inferred.
2. **Get evidence.** For a live URL or app, capture the screens with `@agentlas-browser` or
   `@playwright` — the flow, not one screen. For code, read the components that render it.
   Never review from a verbal description when the real thing is reachable.
3. **Route to guidelines.** Open `$hig-lookup` and pick 3–8 pages: `accessibility`, `color`,
   `layout`, and `typography` always, plus the pages matching what is actually on screen.
   Read the cached page; if absent, fetch its DocC JSON as the routing table describes.
4. **Audit.** Work `$hig-checklist` in order — accessibility, platform conventions, layout,
   visual system, interaction states, content, privacy. Measure what can be measured
   (contrast, target size, text scaling) instead of estimating it.
5. **Translate.** Convert every Apple noun into the user's stack with `$hig-platform-translation`,
   and drop the rules that do not bind their platform rather than reporting them as violations.
   For glass, blur, or vibrancy work, apply `$liquid-glass`.
6. **Grade and write.** Assign severity by consequence and produce the report shape defined in
   `$hig-review-protocol`, including what already works and the limits of the review.
7. **Improvement mode (when asked to fix, not just judge).** Rank findings by severity against
   effort, propose the concrete change for each, then sequence: accessibility first, platform
   conventions next, visual and polish last. Apply the changes only when the user asks for that.

# Specialized passes
- **Accessibility audit** → `accessibility`, `color`, `typography`, `motion`, `inclusion`.
- **Dark mode** → `dark-mode`, `color`, `materials`; check semantic tokens and both appearances.
- **Liquid Glass / glassmorphism** → `$liquid-glass` with `materials` and `color`.
- **App icon** → `app-icons`, `icons`; judge at the smallest rendered size.
- **AI features** → `machine-learning`, `generative-ai`; labelling, correction, and user control.
- **Onboarding and first run** → `onboarding`, `launching`, `privacy`, `managing-accounts`.

# Outputs
- A severity-ranked design review naming the guideline behind each finding, with fixes written
  in the user's framework.
- In improvement mode, a sequenced remediation plan, and the applied changes when requested.

# Verification
- Every rule-shaped claim names the guideline page it came from; anything unattributable is
  labelled as opinion, not as a violation.
- Measured values are labelled measured and estimated values are labelled estimated —
  contrast read off a compressed screenshot is an estimate.
- Findings that only bind Apple hardware or Apple distribution are excluded from a non-Apple
  target rather than reported as failures.
- The review states what it could not check (screen readers, real devices, unreached states).
- Severity reflects consequence: accessibility failures are Critical, polish is Low, and the
  list is ranked and cut rather than exhaustive.
