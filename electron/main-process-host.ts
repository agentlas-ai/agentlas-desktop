/*
 * Which process is this? Importing "electron" here is forbidden: this file is loaded by the background
 * service and every other plain-node host, where the module is missing in a packaged app.
 *
 * `process.versions.electron` is set in an Electron-as-node process too, so it cannot tell the window host
 * from the background service. `process.type === "browser"` is the Electron main process; the service and
 * helper hosts run with ELECTRON_RUN_AS_NODE=1, where `require("electron")` is a path string or throws.
 */
export function isElectronMainProcess(): boolean {
  return process.type === "browser" && process.env.ELECTRON_RUN_AS_NODE !== "1";
}
