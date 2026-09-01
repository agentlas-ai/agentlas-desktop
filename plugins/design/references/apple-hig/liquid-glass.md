# Liquid Glass, and how to not get it wrong off-platform

Apple's current material system (revised through 2025) puts controls and navigation on a
translucent **functional layer** that floats over the **content layer**. On Apple platforms the
system components do this for you. Everywhere else — web, Electron, React Native, Flutter —
people rebuild it by hand with blur, and that is where it goes wrong.

Source: `materials`, plus the "Liquid Glass color" section of `color`. Read those pages before
making a call on a real design.

## The rules that matter

**Glass belongs to the control layer.** Tab bars, toolbars, sidebars, floating action controls.
Never the content layer — app backgrounds, cards, and content surfaces use *standard* materials
(plain blur/opacity) instead. The one exception Apple carves out is a control living inside
content that turns glassy only while it is being touched, like a slider or toggle.

**Sparingly.** The material exists to draw attention *to the content underneath*. A screen where
five custom controls are all glass is a screen with no hierarchy. Limit it to the most important
functional elements.

**Two variants, chosen by what is behind them.**
- *Regular* — blurs and adjusts the luminosity of what is behind so foreground text stays legible.
  This is the default and the right pick for anything text-heavy: sidebars, popovers, alerts.
- *Clear* — highly translucent, for controls floating over photos or video where the media should
  stay prominent.

**Clear glass over bright content needs dimming.** If the underlying content is bright, put a
dark dimming layer of about **35% opacity** behind the control. Over already-dark content, or
with standard media controls that dim on their own, skip it.

**Color is the exception, not the finish.** Glass takes its color from what is behind it. Tint
only what genuinely needs emphasis — a primary action, a status indicator — and put the color in
the background of the control rather than in its label. Over colorful content, prefer a
monochrome treatment for toolbars and tab bars.

**It has to survive the accessibility settings.** Reduce Transparency and Increase Contrast both
change how the material renders. A design that is only legible while the blur is on is broken.

## Building it off-platform

Web and Electron:

```css
.control-layer {
  /* regular: blur enough to kill background detail, then restore luminance */
  backdrop-filter: blur(24px) saturate(180%);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--separator) 40%, transparent);
}
.control-layer--clear {           /* over photos/video */
  backdrop-filter: blur(8px) saturate(140%);
  background: color-mix(in srgb, var(--surface) 20%, transparent);
}
.control-layer--clear::before {   /* the 35% dimming layer, only over bright media */
  content: ""; position: absolute; inset: 0;
  background: rgb(0 0 0 / 0.35);
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .control-layer, .control-layer--clear {
    backdrop-filter: none;
    background: var(--surface);   /* opaque fallback — legibility wins */
  }
}
```

- **React Native:** `@react-native-community/blur` (`BlurView`) with `blurType` mapped to the
  two variants; check `AccessibilityInfo.isReduceTransparencyEnabled()` for the fallback.
- **Flutter:** `BackdropFilter` + `ImageFilter.blur`, gated on
  `MediaQuery.of(context).highContrast` / `disableAnimations`.
- **Electron:** the CSS above works in the renderer; for real window-level material on macOS use
  `vibrancy` / `backgroundMaterial` in `BrowserWindow` rather than faking it inside the page.

## What reviewers keep finding

- Glass on cards, lists, and page backgrounds — content-layer misuse, the single most common error.
- Glass stacked on glass. Blur does not compose; two layers read as fog.
- Static screenshots pass, scrolling fails: text crosses a high-contrast region and disappears.
  Check legibility at the *resting* state — the top of a scroll — and mid-scroll.
- No opaque fallback, so Reduce Transparency users get unreadable controls.
- `backdrop-filter` on a large always-visible surface, repainting every frame — measure it
  before shipping; on low-end hardware this is the animation cost, not the animation itself.
- Borders and shadows tuned only for light mode; glass edges need separate values per appearance.
