# Founder Mobile Shell

This folder contains the standalone mobile web shell for Startup Studio and
the source for a future native app.

## Surfaces

- `app/index.html` - runnable mobile shell for the founder workflow.
- `ios/App/FounderMobileShell.swift` - compile-checked SwiftUI shell for the
  later native iOS screen.
- `ios/AppIntents/FounderAppIntents.swift` - iOS App Intents for the first
  startup actions, kept for a future native lane.
- `ios/Package.swift` - SwiftPM package that compiles the native shell and
  app intents together.

## First App Actions

1. Create a new startup idea.
2. Open today's startup work.
3. Open market validation.

These are intentionally narrow and map to the app build stage in the founder
workflow.

## Current Status

- Mobile shell: runnable local HTML.
- iOS native source: SwiftUI + App Intents are present as a future lane.
- Android app: no APK is included in this package.
- Store release: blocked until native project, signing, privacy metadata, and
  real device/emulator validation exist.
