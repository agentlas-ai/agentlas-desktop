---
name: motion
description: "Injects high-craft UI motion, spring physics, tactile micro-interactions, page transitions, and staggered animations into components and prototypes."
---

# Skill Purpose
Elevates static prototypes into living, responsive interfaces by designing and implementing code-based UI motion, tactile micro-interactions, origin-aware popovers, and smooth choreography based on `$motion-system` principles.

# Preconditions
- An existing prototype or UI component codebase (HTML/CSS/JS or React/framework) must be present.
- Adhere to `$motion-system` and `$critical-overrides`.

# Steps
1. **Identify Motion Opportunities**:
   - **Tactile Micro-interactions**: Button active compressions (`scale(0.97)`), toggle switches, tab sliding indicators, and hover glows.
   - **Surface Transitions**: Modals, bottom sheets, dropdown menus, and toast notifications.
   - **Choreography & Stagger**: Sequential card entrances (20-40ms offset) and skeleton shimmer loading states.
   - **Scroll & Gestures**: Parallax header compressions, sticky element locks, and swipe-to-dismiss actions.
2. **Select Implementation Mechanism**:
   - For Vanilla CSS/JS projects: Inject CSS variables and custom properties from `$motion-system`.
   - For React/Next.js/Vite projects: Utilize Framer Motion (`motion.div`, spring physics, `AnimatePresence`) or Web Animations API.
3. **Apply 3-Tier Motion Tokens & Springs**:
   - Apply snappy springs (`stiffness: 400, damping: 30`) for quick interactive controls (<180ms).
   - Apply gentle springs (`stiffness: 200, damping: 25`) for major surface transitions (<300ms).
   - Ensure origin-aware transforms (`transform-origin`) for context menus and popovers.
4. **Enforce 60fps GPU Constraints**:
   - Restrict animations strictly to `transform` and `opacity`.
   - Eliminate layout thrashing by removing transitions on `width`, `height`, `top`, and `left`.
5. **Add Accessibility Fallbacks**:
   - Implement `@media (prefers-reduced-motion: reduce)` to disable motion or substitute instant opacity fades.

# Outputs
- Updated component stylesheets or motion component files containing interactive motion logic.
- Responsive, tactile micro-interactions and smooth transitions in the running prototype.

# Verification
- Confirm motion is optional and cancellable per the `motion` guideline: reduced-motion is
  honoured with a still fallback, nothing essential is communicated by animation alone, and
  frequent UI transitions stay brief. Route via `$hig-lookup` when a claim needs its citation.

- Verify that all animations run smoothly at 60fps without causing layout shifts or jank.
- Confirm that micro-interaction durations stay under `180ms` and surface transitions under `300ms`.
- Test that `@media (prefers-reduced-motion: reduce)` properly disables motion when activated.
