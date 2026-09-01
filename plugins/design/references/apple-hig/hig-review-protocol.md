# Review protocol — how a HIG finding is made, graded, and written

## Step 1 — Establish what you are reviewing

Before opening a single guideline, pin down: the **surface** (which screens or flow), the
**platform and stack** (web, Electron desktop, iOS, React Native, Flutter…), the **audience and
job** the product does, and what the user actually wants — a full audit, one worry, or a fix.
Ask only what you cannot infer; a platform guess that turns out wrong invalidates the whole review.

Prefer evidence over description. If a URL or a running app is available, capture it
(`$audit` drives the browser). Reviewing from someone's prose account of their UI produces
findings about the prose.

## Step 2 — Pick your pages

Open `$hig-lookup`, choose **3–8 pages**, and read them. Never load the whole corpus.

Always relevant: `accessibility`, `color`, `layout`, `typography`.
Then add by what is on screen — navigation, forms, modality, loading and error states,
onboarding, search, charts, notifications, and whichever component pages the design uses.

Read the cached page (`references/apple-hig/.cache/pages/<slug>.md`); if the cache is absent,
fetch the DocC JSON named in the routing table. Do not review from memory of the HIG —
it is revised often, and the Liquid Glass revisions changed real guidance.

## Step 3 — Audit in priority order

Run `$hig-checklist` top to bottom. Accessibility first, platform conventions second,
layout and hierarchy third, then visual system, interaction states, content, privacy.

For each finding, hold yourself to three things: **what** is wrong, **why** it is wrong
(which guideline, in your own words), and **what to do instead** — concrete, in the user's stack.
"Improve the contrast" is not a finding. "Caption `#9AA0A6` on `#FFFFFF` is 2.8:1, below the
4.5:1 floor for 14 px text — `#5F6368` gives 4.6:1" is.

## Step 4 — Grade honestly

| Severity | Meaning |
|---|---|
| **Critical** | Locks someone out, or breaks the platform contract badly enough to confuse. Accessibility failures live here. |
| **High** | Real friction or a clear convention break. People get through, but worse off. |
| **Medium** | Suboptimal pattern, inconsistency, a system component ignored for no gain. |
| **Low** | Polish. Say it once, briefly. |

Grade the *consequence*, not your irritation. A designer who finds one Critical among your
five Criticals stops reading the rest.

## Step 5 — Write it

```
## Design review — <surface> (<platform/stack>)

### Verdict
2–3 sentences. Overall standing, and the single thing to fix first.

### Critical
- **<one-line problem>**
  Why: <guideline, in your own words> — HIG: <page slug>
  Fix: <concrete change in their stack, with values>
  Evidence: <screenshot / file:line / measured value>

### High / Medium / Low
Same shape, shorter as severity drops.

### What already works
Name it specifically. A review with no positives reads as unexamined.

### Limits of this review
What you could not check: screen-reader behaviour, real-device rendering, states you
never reached, contrast you estimated from a screenshot rather than computed.
```

## Rules that keep a review trustworthy

- **Cite or drop it.** Every rule-shaped claim names its page. Unattributable opinions are
  labelled as opinion.
- **Never invent measurements.** Say "measured" only when you measured. A contrast ratio read
  off a compressed screenshot is an estimate and must say so.
- **Guidelines can lose.** When a guideline collides with a real product constraint, present
  the tension and the cost; do not pretend the constraint away, and do not pretend the
  guideline away either.
- **Stop at enough.** Fifteen ranked findings beat forty unranked ones. If the design is good,
  say so and hand back a short list.
