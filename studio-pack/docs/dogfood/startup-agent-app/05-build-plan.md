# 05 Build Plan

## Route

Web-first: control surface + right-side app artifact prototype + design-provider handoff.

## App Lane

| Item | Plan |
|---|---|
| App web prototype | `webapp/artifacts/app-preview.html` is the current primary app artifact inside the right dock |
| Interaction model | React-style component functions render home, tasks, proof, action buttons, and bottom tabs without a build step |
| Mobile web shell | `apps/founder-mobile/app/index.html` remains available as a standalone preview |
| Native app lane | `apps/founder-mobile/ios/` and `apps/founder-mobile/android/` stay as later-lane source contracts; they do not gate this web proof |
| Current gate | Web proof and Stitch-generated desktop direction come before native install/emulator checks |

## Web Lane

| Item | Plan |
|---|---|
| Web preview | `webapp/index.html` and `webapp/artifacts/web-preview.html` |
| Desktop QA | 1440x1000 browser check |
| Mobile QA | 390x900 browser check |
| Primary risk | Stage UI can become too dense; mobile must avoid horizontal overflow |

## Sales Lane

| Item | Plan |
|---|---|
| Package selector | Starter, Studio, and Concierge choices inside the working webapp |
| Purchase signal | Selection updates visible status and Founder Packet |
| Pilot tracker | Three anonymous pilot candidates with objection and next action |
| Payment boundary | No real payment in dogfood proof; record purchase intent and pilot follow-up |
| Pilot target | 3 paid founder runs before treating conversion as proven |

## Stitch Lane

| Item | Plan |
|---|---|
| Provider | Google Stitch |
| Auth | One-button helper is ready; actual account/API key stays outside repo |
| Handoff | `stitch/stitch-brief.md` and `stitch/stitch-handoff-package.json` |
| Generated source | `REF-GEN-STITCH-001-v2` in `stitch/generated/` is the current desktop visual source |
| Next output | Generate mobile and remaining state screens after the desktop web proof is accepted |

## Engineering Tasks

1. Keep lifecycle stage UI as the primary UX.
2. Make app and web artifact previews inspectable.
3. Add Hephaestus Network check script.
4. Add dogfood QA/network log.
5. Make package verification cover lifecycle and artifact dock.
6. Generate Stitch handoff package without storing credentials.
7. Make the right app artifact a working web prototype before returning to native app builds.
8. Add an in-app package selector so the product can be sold as Starter, Studio, or Concierge.
9. Add a paid-pilot tracker so objections and next actions are captured before real revenue validation.
10. Use Stitch v2 as the visual source while keeping the local webapp contract stricter than any incomplete generated screen.
