/** Route dedicated renderer helpers before importing the product composition
 * root, so printing cannot open stores, recover work, or acquire GUI leases. */
if (process.argv.includes("--agentlas-science-print-helper")) {
  if (process.env.AGENTLAS_DEV_NO_EXTERNAL_EFFECTS === "1") {
    // Helpers bypass Main's identity/bootstrap gate and can write exports or
    // start renderer processes. A suppressed launch cannot enter this route.
    throw new Error("development_effect_policy_refused: print helper");
  }
  void import("./science-host/chromium-print-helper").then(module => module.runChromiumPrintHelper()).catch(() => {
    // No manuscript text or private paths in bootstrap diagnostics.
    process.stderr.write("science_chromium_helper_bootstrap_failed\n");
    process.exit(1);
  });
} else if (process.platform === "win32" && process.argv.includes("--agentlas-daemon-autostart")) {
  // Windows login autostart (daemon/autostart.ts windows-run-key): HKCU\...\Run starts Agentlas.exe in GUI mode,
  // which cannot carry ELECTRON_RUN_AS_NODE. Start the node-mode daemon entry as a hidden detached child and leave
  // without opening a window, a store, or the single-instance lock.
  const { windowsAutostartChild } = require("./daemon/autostart") as typeof import("./daemon/autostart");
  const child = windowsAutostartChild(process.argv, __dirname);
  if (child) {
    try {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      spawn(process.execPath, child.args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {
      process.stderr.write("daemon_autostart_spawn_failed\n");
    }
  }
  process.exit(0);
} else {
  require("./main");
}
