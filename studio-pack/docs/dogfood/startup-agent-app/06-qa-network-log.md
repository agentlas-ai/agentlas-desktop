# 06 QA And Hephaestus Network Log

## Runtime Checks

| Check | Result | Notes |
|---|---|---|
| Hephaestus auth status | authenticated | Output was checked without opening auth popups |
| Hephaestus network status | initialized, auto routing enabled | Ready cards: 104; candidate cards: 27 |
| Hephaestus network bench | passed but weak evidence | The benchmark has 0 cases, so pass status is not meaningful yet |
| Hephaestus local route probe | passed | `startup founder studio` selected `private/agentlas-startup-founder-studio`; the check script emits the latest receipt each run |
| Latest route receipt | recorded | `322268a00f664767` from the Stitch v2 and pilot-status verification pass |
| Startup route benchmark | passed | 12/12 package-local route cases select `private/agentlas-startup-founder-studio` |
| Hephaestus Network GUI shortcut | passed | `hephaestus-network "startup founder studio"` opened the local GUI; Hub was skipped for the private shortcut |
| Stitch helper dry run | ready | `npx` is available and Stitch helper reports ready-to-run |
| Stitch handoff package | generated | `stitch-handoff-package.json` bundles PRD, prompt, commands, and output acceptance without credentials |
| Stitch actual design generation | passed with caveats | Stitch MCP created project `3890069885648704489`, screen `e47d5e29b5684f908d7891a65697e069`, and local `REF-GEN-STITCH-001-v2` screenshot/HTML evidence |
| App web artifact | present | `webapp/artifacts/app-preview.html` renders a componentized web app prototype in the right dock |
| Package selector | passed | Starter, Studio, and Concierge are visible in the webapp; selecting Concierge updates status, Founder Packet, and local project state |
| Paid pilot tracker | passed | Pilot 02, status `대화 기록`, objection `신뢰`, next action `지원사업 양식 비교`, and `2/3 대화 기록` update the UI, Founder Packet, and local project state |
| Mobile web shell | present | `apps/founder-mobile/app/index.html` remains a standalone preview surface |
| Native app lane | deferred | iOS App Intents and Android QA files remain as later-lane source contracts, but native builds are not a current gate |
| Android emulator QA preflight | blocked missing tools | `adb` and `gradle` are not available locally; Java is present |

## Bugs / Weirdness Found

| ID | Severity | Finding | Fix |
|---|---|---|---|
| DOG-001 | High | Startup GUI was still prompt-button oriented instead of lifecycle oriented | Rebuilt UI around seven lifecycle stages |
| DOG-002 | High | Right side did not show actual app/web artifacts | Added embedded app and web artifact previews |
| DOG-003 | Medium | Package verifier expected exactly four buttons | Updated verifier to require lifecycle stages and two iframes |
| DOG-004 | Medium | Initial network check only looked at status/bench and missed route/open-GUI behavior | Added route probe and recorded Hephaestus Network GUI shortcut evidence |
| DOG-005 | Medium | Google Stitch handoff did not name current account/API-key prerequisite | Added Stitch handoff brief and provider readiness notes |
| DOG-006 | Low | Mobile stage rail showed a distracting horizontal scrollbar | Hid scrollbar while preserving horizontal stage scrolling |
| DOG-007 | Low | Public-safety scan and Pitch Deck verifier scanned local `node_modules` cache and flagged Playwright internals | Excluded dependency caches from safety scans |
| DOG-008 | Low | Network check script did not include a Startup route probe | Added route probe for `startup founder studio` with `--no-hub` |
| DOG-009 | Low | Hephaestus route payload reports network command as `hephaests-network` | Added a dogfood check note so the upstream router typo stays visible |
| DOG-010 | Medium | Copied work bundle was too thin to act as a sellable founder handoff | Added persisted project memory and a full Founder Packet with PRD, Stitch, app, web, and Network QA lanes |
| DOG-011 | Medium | Right app/web previews did not reflect the active founder decision | Added live artifact sync from the main workflow into both preview frames |
| DOG-012 | High | Non-exact Startup routing requests crashed because cached card data had `locale_coverage` as a list | Changed routing card to the expected object shape and reindexed the local Network registry |
| DOG-013 | High | Startup route benchmark initially passed only 5/12 cases; English design/build and SaaS deck requests escaped the Startup orchestrator | Added route benchmark execution, expanded aliases, and verified 12/12 package-local cases |
| DOG-014 | Medium | Stitch provider readiness is not enough to generate designs: project/quota setup can still block API calls | Added a redacted Stitch handoff runner and recorded provider-config blockers separately from package readiness |
| DOG-015 | Medium | App build stage had preview UI but no mobile app skeleton to continue from | Added a runnable mobile shell plus iOS App Intents and Android emulator QA contracts |
| DOG-016 | Medium | iOS App Intents were present as a contract but could distract from the web-first proof | Kept the source contract as a later lane and removed native build checks from the current package gate |
| DOG-017 | Medium | Android QA plan could read as runnable even when local emulator tools were missing | Added Android QA preflight with explicit ready/blocked status |
| DOG-018 | Medium | iOS app build evidence stopped at App Intents and did not include a native screen model | Added a compile-checked SwiftUI founder workflow shell |
| DOG-019 | Low | First SwiftUI shell compile failed under Swift 6 because stage models were not `Sendable` and an iOS-only color was used in macOS tests | Made workflow models `Sendable` and used a platform-neutral background color |
| DOG-020 | High | App work drifted toward native iOS proof before the webapp showed a real app experience | Moved current gate back to a right-dock web app prototype and removed native build from package verification |
| DOG-021 | Medium | The right app artifact looked like a static phone card, not an app surface a founder could click | Rebuilt it as a componentized web prototype with home, tasks, proof, action buttons, synced state, and bottom tabs |
| DOG-022 | Low | Stitch handoff still allowed "app preview" to be interpreted as a static dock treatment | Updated the Stitch brief and generator to require an app web prototype before native builds |
| DOG-023 | High | The product was meant to be sold, but price/package choice only lived in planning docs | Added an in-app Starter/Studio/Concierge selector and carried purchase intent into the Founder Packet |
| DOG-024 | High | Sales validation still did not let the seller track first paid-pilot objections inside the product | Added an anonymous 3-pilot tracker with objection and next-action state in the UI and Founder Packet |
| DOG-025 | Medium | First Stitch generation kept English/action-label residue and did not visibly include all package choices | Generated a Stitch v2 variant and kept the local webapp contract stricter than generated output |
| DOG-026 | Low | Stitch `list_screens` returned `{}` immediately after generation even though `get_screen` succeeded with the screen ID | Recorded direct screen lookup as the reliable evidence path for this run |
| DOG-027 | Medium | Paid-pilot UI tracked objections but not conversation/revenue-validation status | Added pilot status, `2/3 대화 기록`, and a revenue-not-proven state to the UI and Founder Packet |

## QA Evidence

| Surface | Evidence |
|---|---|
| Desktop webapp | `startup-studio-desktop.png` |
| Mobile webapp | `startup-studio-mobile.png` |
| Package verifier | `bash scripts/verify-package.sh` passes |
| Console | Browser console has 0 errors after favicon fix |
| Mobile overflow | `scrollWidth <= innerWidth`, no horizontal overflow |
| Artifact dock | Two iframes exist: app and web |
| Founder packet | Browser output includes Google Stitch, app web prototype lane, later native lane, and `hephaestus-network-check.py` |
| Project memory | Browser stores current idea/stage/speed in `localStorage` and restores it on reload |
| Live artifact sync | App and web previews receive the current stage and selected founder answer |
| Startup route benchmark | 12 cases, 12 passed, top1 accuracy 1.0 |
| Stitch handoff package | `docs/dogfood/startup-agent-app/stitch/stitch-handoff-package.json` |
| Stitch generated design v1 | `docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001.png` and `.html`; superseded because it kept English/action-label residue and incomplete package visibility |
| Stitch generated design v2 | `docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001-v2.png` and `.html`; includes seven stages, Starter/Studio/Concierge, Pilot 01/02/03, `2/3`, `검증 전`, `신뢰`, and `지원사업 양식 비교` |
| App web prototype | `webapp/artifacts/app-preview.html` |
| Browser app-artifact click test | `http://127.0.0.1:8765/webapp/index.html?v=web-app-artifact` showed `startup-app-artifact-v2`; `오늘 할 일` changed `data-view` to `tasks`; `검증` changed it to `proof` |
| Mobile web overflow | 390x900 browser check reported no page overflow and no app iframe overflow |
| Sales package click test | `http://127.0.0.1:8765/webapp/index.html?v=sales-package` showed all three package choices; Concierge click changed `offerStatus`, Founder Packet, and `localStorage.planId` |
| Sales mobile overflow | 390x900 browser check reported no page overflow after adding the package selector |
| Paid pilot tracker click test | `http://127.0.0.1:8765/webapp/index.html?v=stitch-v2-pilot-status` changed Pilot 02, status `대화 기록`, objection `신뢰`, next action `지원사업 양식 비교`, Founder Packet, and `localStorage` |
| Paid pilot mobile overflow | 390x900 browser check reported no page overflow after adding the pilot tracker |
| Mobile/native source contracts | `apps/founder-mobile/app/index.html`, `ios/App/FounderMobileShell.swift`, `ios/AppIntents/FounderAppIntents.swift`, `android/qa-plan.md` |
| Android QA preflight | `scripts/android-qa-preflight.py` reports `blocked_missing_tools` until `adb` and `gradle` exist |

## Next Fixes

1. Generate the mobile and remaining state screens in Stitch after the desktop web proof is accepted.
2. Use the new pilot tracker to run 3 real paid founder pilots, then compare selected package, objection, and before/after artifact quality.
3. After the web app prototype is accepted, decide whether native iOS/Android should be app targets, wrappers, or later provider-specific builds.
4. Keep tracking why global Hephaestus `network bench` still reports 0 cases while package-local Startup benchmarks pass.
