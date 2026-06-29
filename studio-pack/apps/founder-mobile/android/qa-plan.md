# Android Emulator QA Plan

This is the first Android QA contract for the Startup Studio mobile shell.

There is no APK yet, so this plan is blocked at install time. Once a native
Android shell or WebView wrapper exists, Product Development HQ must run this
plan before marking Android complete.

## Target

- Package id: `ai.agentlas.startupfounder`
- Main flow: idea capture -> today's startup work -> market validation
- Evidence: screenshot, UI tree, launch result, logcat crash buffer

## Commands

```bash
adb devices
./gradlew :app:installDebug --console=plain --quiet
adb -s <serial> shell cmd package resolve-activity --brief ai.agentlas.startupfounder
adb -s <serial> shell am start -n ai.agentlas.startupfounder/.MainActivity
adb -s <serial> exec-out uiautomator dump /dev/tty > /tmp/startup-mobile-ui.xml
adb -s <serial> exec-out screencap -p > /tmp/startup-mobile-home.png
adb -s <serial> logcat -b crash -d > /tmp/startup-mobile-crash.txt
```

## Required Checks

- The app launches without crash.
- The first screen shows Startup Studio and 오늘의 창업 작업.
- The user can select 새 아이디어 만들기.
- The user can select 시장 검증 열기.
- No text overlaps at 390px wide viewport or equivalent emulator density.
- Crash buffer has no app process crash after launch and two taps.
