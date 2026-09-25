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
} else {
  require("./main");
}
