const fs = require("node:fs");

function closeFixtureStore() {
  try {
    require("../../dist/electron/store/db.js").getDb().close();
  } catch {
    // The fixture may not use the store, or an earlier assertion may have
    // failed before initStore completed.
  }
}

function cleanupElectronFixture(root, label) {
  closeFixtureStore();
  try {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 2,
      retryDelay: 125,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (process.platform === "win32" && ["EBUSY", "EPERM"].includes(code)) {
      // Electron can retain an OS-owned userData handle until app.exit(). The
      // SQLite fixture is already closed; Windows temp cleanup can finish it.
      console.warn(`[${label}] fixture cleanup deferred to Windows temp cleanup: ${code}`);
      return;
    }
    throw error;
  }
}

module.exports = { cleanupElectronFixture };
