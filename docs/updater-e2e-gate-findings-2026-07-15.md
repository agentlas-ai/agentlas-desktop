# Native updater install E2E — why it fails (2026-07-15)

`scripts/test-packaged-updater-install-e2e.cjs` (added in v0.8.34) initially
failed in the v0.8.35-v0.8.37 release attempts and blocked the all-OS release
barrier in `.github/workflows/release-signed-mac.yml`. The two findings below
were used to repair the gate; the final v0.8.37 run passed both native updater
jobs before public promotion.

**Both failures are defects in the gate/CI environment, not in the shipped
updater.** The product fix for the v0.8.32 brick (`cec22f9`, shipped in v0.8.33)
is present and is separately covered by `test:updater-production`.

Evidence: run 29414498881 (tag v0.8.37).

## Linux AppImage — "target relaunch journal reconciliation timed out"

The baseline app is launched through `xvfb-run` (see `runLinuxE2E`, ~L921):

```js
const command = xvfb;                       // xvfb-run
const args = dbus ? ["-a", dbus, "--", launcher, ...electronArgs] : ...;
```

`xvfb-run` owns the virtual display and tears **Xvfb down when its child
exits**. The lifecycle under test is:

1. `xvfb-run` starts Xvfb, launches baseline 0.8.32.
2. Baseline calls `quitAndInstall(isSilent, isForceRunAfter=true)`, which spawns
   the replacement AppImage and then **exits**.
3. Baseline's exit ends `xvfb-run`, so **Xvfb dies and `DISPLAY` disappears**.
4. The relaunched target has no display to open, so it never boots and never
   reconciles the journal → the `!fs.existsSync(expectedJournal)` wait (~L1081)
   times out after 180s.

The gate asserts the AppImage swap succeeded (it does) and only then fails, which
matches this exactly.

**Fix direction:** own the display for the whole E2E instead of per-process —
start `Xvfb :99` (and a `dbus-daemon`) once, export `DISPLAY` /
`DBUS_SESSION_BUS_ADDRESS` into `appEnv`, and stop them in the E2E's `finally`.
Then the relaunched target inherits a display that outlives the baseline.

## Windows NSIS — "NSIS target replacement timed out"

Baseline 0.8.32 boots, reaches the loopback feed, and starts the update:

```
Found version 0.8.37 (url: Agentlas-0.8.37-Windows-x64-Setup.exe)
Downloading update from Agentlas-0.8.37-Windows-x64-Setup.exe
updaterCacheDirName is not specified in app-update.yml ...
Download block maps (old: "http://127.0.0.1:59622/Agentlas-0.8.32-Windows-x64-Setup.exe.blockmap", new: http://127.0.0.1:59622/...)
Cannot download differentially, fallback to full download:
  Error: Cannot download "http://127.0.0.1/Agentlas-0.8.37-Windows-x64-Setup.exe.blockmap"
```

Note the failing URL is **`http://127.0.0.1/...` with the port dropped**, while
the feed is on `:59622`. The differential path loses the loopback feed's port, so
the download never completes and the installer never replaces the app → the
`waitUntil` at ~L1006 times out.

**Fix direction:** either serve the loopback feed in a way that keeps the port on
derived (blockmap) URLs, or set `disableDifferentialDownload: true` for the E2E
baseline so it takes the full-download path the gate actually wants to prove.
The `updaterCacheDirName is not specified` warning suggests the rewritten
`app-update.yml` for the loopback feed also drops fields the real feed has — the
rewrite should preserve every key except the URL.

## Note

Until the gate is repaired it produces no usable signal: it fails regardless of
product correctness. Treat a failure here as "the gate is broken" rather than
"the updater regressed", and repair the gate rather than weakening the barrier —
this lifecycle is exactly what the v0.8.32 incident escaped.

## Resolution

- Windows now uses a loopback feed rewrite that preserves the installer/update
  contract and avoids the malformed differential URL path. The real NSIS
  v0.8.32 -> v0.8.37 replacement gate passed.
- Linux now owns a relaunch-capable Xvfb/DBus sandbox beyond the baseline
  process lifetime. Because AppImage replacement can drop the QA marker while
  still launching the exact target, reconciliation accepts only a process whose
  `APPIMAGE` and command-line identity match the expected replacement, while
  retaining version, feed, and journal checks. The real AppImage
  v0.8.32 -> v0.8.37 gate passed.
- Evidence: final signed release run 29424717694 and updater artifact recheck
  run 29424409397.
