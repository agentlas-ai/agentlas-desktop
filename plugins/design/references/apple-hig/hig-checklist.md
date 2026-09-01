# HIG review checklist

The pass a design has to survive before anyone calls it done. Written in our words from the
Apple Human Interface Guidelines; every group names the page that backs it so you can open the
full text when a finding needs a citation (routing: `$hig-lookup`).

Work top to bottom. The order is the order things break in.

---

## 1. Accessibility — a failure here is never "minor"
Source pages: `accessibility`, `color`, `typography`, `inclusion`, `motion`

- [ ] **Contrast clears the bar.** Apple's own inspector judges against WCAG AA:
      text up to 17 pt needs **4.5:1**, text at 18 pt needs **3:1**, bold text needs **3:1**.
      Check in light *and* dark; a palette that passes in one often fails in the other.
- [ ] **Text scales.** Layout survives the system text-size setting all the way up —
      aim for **200%** enlargement (watchOS 140%). Nothing clips, nothing overlaps,
      nothing scrolls sideways. Fixed `px` type and fixed-height rows are the usual culprits.
- [ ] **Nothing is signalled by color alone.** Status, errors, selection, and chart series
      each carry a second cue: shape, icon, label, or pattern.
- [ ] **Hit targets are reachable.** At least **44×44 pt** per control (visionOS 60×60),
      and adjacent button centers at least **60 pt** apart.
- [ ] **Assistive tech has something to read.** Every control has a name that says what it does;
      icon-only buttons carry a label; images that mean something have a description;
      decorative images are marked as such.
- [ ] **Motion is optional.** Honour reduced-motion. Anything that slides, parallaxes, zooms,
      or autoplays has a still fallback and can be cancelled.
- [ ] **Focus is visible and ordered.** Keyboard traversal reaches every control in the order
      the layout implies, and the focused element is unmistakable.
- [ ] **Language is inclusive.** No jargon left undefined, no idioms that don't travel,
      no phrasing that assumes ability, gender, or geography.

## 2. Platform conventions — where "custom" turns into "wrong"
Source pages: `designing-for-ios`, `designing-for-macos`, `patterns`, `components`, `layout`

- [ ] **Primary navigation matches the platform.** Phone: tab bar for peer sections.
      Desktop: sidebar plus the app menu — not a hamburger hiding the whole app.
- [ ] **System components are used where a system component exists.** A hand-rolled
      picker, alert, or scroll view is a bug factory; reach for the built-in one first,
      customize it second.
- [ ] **Safe areas and window chrome are respected.** Content clears notches, home indicators,
      status bars, and title bars — including in landscape and at small window sizes.
- [ ] **Standard gestures keep their standard meaning.** Swipe-back, pull-to-refresh, pinch,
      right-click, and Escape all do what the platform trained people to expect.
- [ ] **Both appearances ship.** Light and dark are both designed, not one auto-inverted.
      No app-specific appearance toggle unless the app's purpose demands it.
- [ ] **Keyboard shortcuts exist on desktop** for the actions people repeat, using the
      platform's standard bindings.

## 3. Layout and hierarchy
Source pages: `layout`, `typography`, `spatial-layout`

- [ ] **One thing is clearly the most important thing** on every screen.
- [ ] **Related items are grouped; unrelated items are separated** by real space,
      not by a hairline rule doing the work spacing should do.
- [ ] **Alignment is consistent.** Edges line up on a shared grid; optical alignment is fixed
      where mathematical alignment looks wrong.
- [ ] **Spacing comes from a scale**, not from whatever number looked fine that afternoon.
- [ ] **The layout adapts.** Test at the smallest and largest supported size, at both
      orientations, and with a resized window — content reflows rather than clipping.
- [ ] **Controls read as controls** and content reads as content; the two layers stay distinct.

## 4. Color, type, and material
Source pages: `color`, `dark-mode`, `typography`, `materials`, `sf-symbols`, `icons`

- [ ] **Color is semantic, not decorative-by-accident.** One color means one thing throughout.
- [ ] **Semantic tokens over hard-coded values.** Reference system/theme colors so the UI
      follows appearance, vibrancy, and increased-contrast settings.
- [ ] **The type scale is small and deliberate.** Few typefaces, few sizes, weights that
      carry hierarchy. Avoid ultra-light weights at body size.
- [ ] **Glass and blur stay in the control layer**, never in the content layer, and never
      stacked glass-on-glass. See `$liquid-glass`.
- [ ] **Icons are one family, one weight relationship to adjacent text**, and legible at their
      smallest rendered size.
- [ ] **The app icon works small.** Simple silhouette, no text, no screenshot-in-a-square,
      recognizable at list size.

## 5. Interaction, state, and feedback
Source pages: `feedback`, `loading`, `modality`, `entering-data`, `undo-and-redo`, `launching`, `onboarding`, `searching`

- [ ] **Every state is designed:** empty, loading, partial, error, offline, success.
      A screen that only exists in its happy state is unfinished.
- [ ] **Loading tells the truth.** Show progress where duration is knowable; keep the UI
      responsive; never block the whole window for a background task.
- [ ] **Errors say what happened and what to do next** — in the user's terms, with a path out.
      An error with no next step is a dead end.
- [ ] **Modality is rationed.** A sheet or dialog is for something that genuinely must be
      finished or dismissed; everything else stays inline.
- [ ] **Destructive actions are confirmed or undoable** — preferably undoable.
- [ ] **Forms respect the input method:** right keyboard type, autofill, sane tab order,
      validation that appears when it can help rather than while someone is still typing.
- [ ] **First run earns its keep.** Get people to the value fast; teach in context;
      make onboarding skippable and permissions requested at the moment they make sense.

## 6. Content and writing
Source pages: `writing`, `inclusion`, `offering-help`

- [ ] **Labels say what happens.** "Save draft" beats "OK".
- [ ] **Sentence case for UI text.** No ALL CAPS shouting, no Title Case On Everything.
- [ ] **Short beats clever.** Cut the sentence that only reassures the author.
- [ ] **Terminology is consistent** across screens, notifications, emails, and errors.
- [ ] **Help is where the confusion is**, not filed away in a separate manual.

## 7. Privacy and trust
Source pages: `privacy`, `managing-accounts`, `generative-ai` (via `machine-learning`)

- [ ] **Permission is asked for at the point of use**, with a reason people can act on —
      never a wall of prompts at launch.
- [ ] **Only the data the feature needs** is requested, and the app still works, degraded,
      when access is refused.
- [ ] **Sign-in is deferrable.** Let people see value before an account wall, unless the
      product genuinely cannot show any.
- [ ] **AI output is labelled as AI output**, editable, correctable, and never presented as
      fact it cannot support.

---

## Using this list

- A review that returns 30 findings is a review nobody acts on. Rank, then cut to what matters.
- Cite the page when you assert a rule: readers should be able to check you.
- Section 1 findings are **Critical** by default. Sections 2–3 are usually **High**.
  Sections 4–6 land at **Medium**, and pure polish is **Low**. Grading is defined in
  `$hig-review-protocol`.
- Apple's vocabulary is not the user's vocabulary. Translate before you speak: `$hig-platform-translation`.
