import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { LaunchdStatus } from "../../shared/types";
import { requireConfiguredInstallIdentity } from "../install-identity";
import { openedStorePath, STORE_SCHEMA_VERSION } from "../store/db";
import { readDaemonAutostartStoreReady, setDaemonAutostartEnabled } from "../store/daemon-autostart";
import { buildDaemonAutostartCommand, inspectDaemonAutostart, reconcileDaemonAutostart } from "../daemon/app-launcher";

/** Compatibility UI now controls the same identity-scoped agentlasd service,
 * never the old ai.agentlas.automations GUI launcher. */
function command() {
  const appVersion = app.getVersion();
  const storeBootstrapToken = readDaemonAutostartStoreReady({ appVersion, requiredSchemaVersion: STORE_SCHEMA_VERSION });
  if (!storeBootstrapToken) throw new Error("daemon_autostart_store_not_bootstrapped");
  const storePath = openedStorePath();
  if (!storePath) throw new Error("daemon_autostart_store_unavailable");
  return buildDaemonAutostartCommand({ userDataDir: app.getPath("userData"), storePath,
    installIdentity: requireConfiguredInstallIdentity(), appVersion, execPath: process.execPath,
    daemonEntry: path.join(__dirname, "..", "daemon", "main.js"), requiredSchemaVersion: STORE_SCHEMA_VERSION, storeBootstrapToken });
}
function status(action?: boolean): LaunchdStatus {
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false, plistPath: "" };
  try {
    const plan = command();
    const result = action === undefined ? inspectDaemonAutostart(plan) : reconcileDaemonAutostart(action, plan);
    if (action !== undefined) setDaemonAutostartEnabled(action);
    return { supported: true, installed: result.installed, loaded: result.loaded, plistPath: result.filePath };
  } catch (error) {
    return { supported: true, installed: false, loaded: false, plistPath: "",
      error: error instanceof Error ? error.message : "daemon_autostart_failed" };
  }
}
export function launchdStatus(): LaunchdStatus { return status(); }
export function enableLaunchd(): LaunchdStatus { return status(true); }
export function disableLaunchd(): LaunchdStatus { return status(false); }

/** Only for the obsolete --headless-automations entry. It can never disable the
 * identity-scoped agentlasd service. Unknown definitions are left untouched. */
export function disableLegacyAutomationLaunchd(): LaunchdStatus {
  const label = "ai.agentlas.automations";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const base: LaunchdStatus = { supported: process.platform === "darwin", installed: false, loaded: false, plistPath };
  if (!base.supported || !fs.existsSync(plistPath)) return base;
  try {
    const stat = fs.lstatSync(plistPath);
    const contents = fs.readFileSync(plistPath, "utf8");
    const escapedExec = process.execPath.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 64 * 1024
      || !contents.includes(`<string>${label}</string>`) || !contents.includes("<string>--headless-automations</string>")
      || !contents.includes(`<string>${escapedExec}</string>`)) throw new Error("legacy_automation_definition_unconfirmed");
    const target = `gui/${process.getuid!()}/${label}`;
    const run = (args: string[]) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 10_000 });
    const observation = run(["print", target]);
    if (observation.status !== 0 && observation.status !== 113) throw new Error("legacy_automation_status_unknown");
    if (run(["disable", target]).status !== 0) throw new Error("legacy_automation_disable_failed");
    // Recoverable archive, not another .plist that launchd will load next login.
    fs.renameSync(plistPath, `${plistPath}.${Date.now()}.disabled`);
    if (observation.status === 0 && run(["bootout", target]).status !== 0) throw new Error("legacy_automation_bootout_failed");
    return base;
  } catch (error) {
    return { ...base, installed: fs.existsSync(plistPath), error: error instanceof Error ? error.message : "legacy_automation_cleanup_failed" };
  }
}
