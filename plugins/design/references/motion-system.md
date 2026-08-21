# Motion System & Interaction Engineering Guidelines

Core principles, design tokens, and physics models for high-craft UI motion based on Emil Kowalski (*Animations on the Web*), Rauno Freiberg (*Craft UI*), and W3C Motion Tokens standards.

---

## 1. Core Principles

### 1.1 Restraint & Speed
- Motion must be purposeful and fast. It should feel like an immediate physical reaction rather than an animation to be watched.
- **Micro-interactions (buttons, switches, tabs)**: `100ms - 180ms`.
- **UI Transitions (modals, drawers, popovers)**: `200ms - 300ms`.
- **Stagger Offsets (list items, card grids)**: `20ms - 40ms` per item.
- Never exceed `400ms` for standard interactive workflows.

### 1.2 Spring Physics & Tactile Feel
- Use natural spring dynamics rather than linear or overly exaggerated cubic-bezier curves.
- **Snappy Spring** (`stiffness: 400, damping: 30`): Tactile feedback for buttons, switches, and tabs.
- **Gentle Spring** (`stiffness: 200, damping: 25`): Smooth deceleration for sheets, dialogs, and navigation drawers.
- **Bouncy Spring** (`stiffness: 300, damping: 20`): Subtle overshoot for celebratory badges, toasts, and icons.
- **Active Press State**: Subtle scale compression (`scale(0.97)` to `scale(0.98)`) with instant response.

### 1.3 Origin Awareness
- Popovers, context menus, and tooltips must expand from their triggering source (`transform-origin: top left`, etc.) rather than floating in from arbitrary coordinates.

### 1.4 Performance & GPU Acceleration
- **Animate ONLY `transform` (scale, translate, rotate) and `opacity`**.
- **NEVER animate layout-triggering properties** (`width`, `height`, `top`, `left`, `margin`, `padding`).
- Use `will-change: transform, opacity` judiciously on complex animating elements.

### 1.5 Mandatory Accessibility
- Always provide `@media (prefers-reduced-motion: reduce)` fallbacks that disable motion or convert transitions into simple, instant opacity crossfades.

---

## 2. 3-Tier Motion Design Tokens

```css
:root {
  /* 1. Primitive Duration Tokens */
  --motion-duration-instant: 100ms;
  --motion-duration-fast: 180ms;
  --motion-duration-moderate: 250ms;
  --motion-duration-slow: 350ms;

  /* 2. Primitive Easing Tokens (Natural Deceleration & Acceleration) */
  --motion-ease-out-quad: cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --motion-ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --motion-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --motion-spring-snappy: cubic-bezier(0.175, 0.885, 0.32, 1.15);

  /* 3. Semantic Interaction Tokens */
  --motion-button-press: var(--motion-duration-instant) var(--motion-ease-out-expo);
  --motion-hover-transition: var(--motion-duration-fast) var(--motion-ease-out-quad);
  --motion-modal-entrance: var(--motion-duration-moderate) var(--motion-ease-out-expo);
  --motion-drawer-slide: var(--motion-duration-moderate) var(--motion-ease-out-expo);
  --motion-stagger-delay: 30ms;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-duration-instant: 0ms;
    --motion-duration-fast: 0ms;
    --motion-duration-moderate: 0ms;
    --motion-duration-slow: 0ms;
  }
}
```

---

## 3. Implementation Cheat Sheet

### Vanilla CSS Micro-Interaction
```css
.btn-primary {
  transition: transform var(--motion-button-press), background-color var(--motion-hover-transition), box-shadow var(--motion-hover-transition);
  will-change: transform;
}
.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(255, 102, 173, 0.25);
}
.btn-primary:active {
  transform: scale(0.97);
}
```

### Framer Motion / Motion.dev Spring Preset
```jsx
import { motion, AnimatePresence } from "framer-motion";

const snappySpring = { type: "spring", stiffness: 400, damping: 30 };
const gentleSpring = { type: "spring", stiffness: 200, damping: 25 };

// Modal Dialog Entrance
<motion.div
  initial={{ opacity: 0, scale: 0.95, y: 10 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  exit={{ opacity: 0, scale: 0.95, y: 10 }}
  transition={gentleSpring}
/>
```
