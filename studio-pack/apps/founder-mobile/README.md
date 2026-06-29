# Founder Mobile Shell

This folder is the first mobile/web app skeleton for Startup Studio.

It is not marked as a store-ready native app. The current product proof is the
web app artifact embedded in `webapp/artifacts/app-preview.html`. This folder
keeps a standalone mobile web preview plus later-lane native source contracts.

## Surfaces

- `app/index.html` - runnable mobile shell for the founder workflow.
- `../../webapp/artifacts/app-preview.html` - current right-dock app web
  prototype in the main Startup webapp.
- `ios/App/FounderMobileShell.swift` - compile-checked SwiftUI shell for the
  later native iOS screen.
- `ios/AppIntents/FounderAppIntents.swift` - iOS App Intents for the first
  startup actions, kept for a future native lane.
- `ios/Package.swift` - SwiftPM package that compiles the native shell and
  app intents together.
- `android/qa-plan.md` - Android emulator QA checklist and adb commands.

## First App Actions

1. Create a new startup idea.
2. Open today's startup work.
3. Open market validation.

These are intentionally narrow. They map to the app build stage in the main
Startup webapp and should be validated first in the right-side web artifact.

## Current Status

- App web prototype: embedded in the main Startup webapp right dock.
- Mobile shell: runnable local HTML.
- iOS native source: SwiftUI + App Intents are present as a future lane.
- Android QA: command plan and readiness preflight exist, no APK yet.
- Store release: blocked until native project, signing, privacy metadata, and
  real device/emulator validation exist.
