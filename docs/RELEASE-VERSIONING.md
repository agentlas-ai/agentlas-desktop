# Release versioning — DO NOT roll the version backwards

`package.json` version must be **monotonically increasing**. v0.6.8 is already
published to `agentlas-desktop-releases` (assets + latest-mac.yml). Auto-update
compares versions: re-releasing an equal/lower version (e.g. "restoring" 0.6.6)
means installed apps NEVER receive the fix, and overwrites published assets.

If you (human or agent) believe the current version is wrong, bump FORWARD and
release again — never "correct" it downwards. 2026-07-03: two agent sessions
fought over 0.6.6↔0.6.8 and cancelled each other's release CI; this note exists
so it doesn't happen again.
