import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { daemonAutostartLabel, validateDaemonAutostartManifest, type DaemonAutostartManifest } from "./autostart-manifest";

/** Pre-identity definitions are never adopted as this service. */
export const DAEMON_LABEL = "cloud.agentlas.daemon";
export interface AutostartCommand {
  executable: string; entry: string;
  manifest?: DaemonAutostartManifest;
  manifestPath?: string;
}
export interface AutostartPlan {
  mechanism: "launchd" | "windows-startup" | "systemd-user";
  filePath: string; contents: string; label: string;
  manifestPath?: string; manifestContents?: string;
}
export interface AutostartRuntime {
  platform?: NodeJS.Platform; home?: string; uid?: number;
  /** Private tests inject this; never redirect the real user's HOME. */
  run?: (executable: string, args: string[]) => { code: number; stdout: string; stderr: string };
}
export interface AutostartReconciliation { installed: boolean; loaded: boolean; changed: boolean; filePath: string; label: string }
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
function safePath(value: string) { if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) fail("daemon_autostart_path_invalid"); }

/** Complete login plan, isolated by installation. Explicit home never falls
 * through to ambient APPDATA/XDG paths outside the private test fixture. */
export function planAutostart(command: AutostartCommand, platform: NodeJS.Platform = process.platform, home = os.homedir()): AutostartPlan {
  safePath(home); safePath(command.executable); safePath(command.entry);
  const manifest = command.manifest;
  if (manifest) { if (!command.manifestPath) fail("daemon_autostart_manifest_required"); safePath(command.manifestPath); }
  const label = manifest ? daemonAutostartLabel(manifest) : DAEMON_LABEL;
  const args = [command.executable, command.entry, ...(command.manifestPath ? ["--manifest", command.manifestPath] : [])];
  const common = { label, ...(manifest ? { manifestPath: command.manifestPath, manifestContents: `${JSON.stringify(manifest)}\n` } : {}) };
  if (platform === "darwin") return { ...common, mechanism: "launchd", filePath: path.join(home, "Library", "LaunchAgents", `${label}.plist`), contents: [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>', `<key>Label</key><string>${label}</string>`,
    `<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>`,
    '<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>',
    '<key>RunAtLoad</key><true/>', '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '<key>ThrottleInterval</key><integer>60</integer>', '<key>ExitTimeOut</key><integer>45</integer>', '</dict></plist>', '',
  ].join("\n") };
  if (platform === "win32") {
    // cmd expands % even inside quotes; reject unsupported paths explicitly.
    if (args.some(arg => /[%!"^&|<>]/.test(arg))) fail("daemon_autostart_windows_path_unsupported");
    return { ...common, mechanism: "windows-startup", filePath: path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${label}.cmd`),
      contents: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nstart "" /b ${args.map(arg => `"${arg}"`).join(" ")}\r\n` };
  }
  if (platform !== "linux") fail("daemon_autostart_platform_unsupported");
  return { ...common, mechanism: "systemd-user", filePath: path.join(home, ".config", "systemd", "user", `${label}.service`),
    contents: `[Unit]\nDescription=Agentlas daemon\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nEnvironment=ELECTRON_RUN_AS_NODE=1\nExecStart=${args.map(quote).join(" ")}\nRestart=on-failure\nRestartSec=60\nTimeoutStopSec=45\n\n[Install]\nWantedBy=default.target\n` };
}
function readOwned(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024
      || (process.platform !== "win32" && stat.uid !== process.getuid?.())) fail("daemon_autostart_file_owner_invalid");
    return fs.readFileSync(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function writeAtomic(file: string, contents: string) {
  readOwned(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
export function isAutostartInstalled(plan: AutostartPlan): boolean {
  return readOwned(plan.filePath) === plan.contents && (!plan.manifestPath || readOwned(plan.manifestPath) === plan.manifestContents);
}
export function installAutostart(plan: AutostartPlan): void {
  if (!plan.manifestPath || !plan.manifestContents) fail("daemon_autostart_manifest_required");
  validateDaemonAutostartManifest(JSON.parse(plan.manifestContents));
  writeAtomic(plan.manifestPath, plan.manifestContents); writeAtomic(plan.filePath, plan.contents);
}
export function removeAutostart(plan: AutostartPlan): void {
  const current = readOwned(plan.filePath);
  if (current === null) return;
  if (current !== plan.contents) fail("daemon_autostart_definition_changed");
  fs.unlinkSync(plan.filePath);
}
function command(runtime: AutostartRuntime, executable: string, args: string[]) {
  if (runtime.run) return runtime.run(executable, args);
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function launchTarget(plan: AutostartPlan, runtime: AutostartRuntime) {
  const uid = runtime.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) fail("daemon_autostart_uid_unavailable");
  return { domain: `gui/${uid}`, target: `gui/${uid}/${plan.label}` };
}
export function autostartLoaded(plan: AutostartPlan, runtime: AutostartRuntime = {}): boolean {
  if (plan.mechanism === "windows-startup") return false;
  const result = plan.mechanism === "launchd"
    ? command(runtime, "/bin/launchctl", ["print", launchTarget(plan, runtime).target])
    : command(runtime, "systemctl", ["--user", "is-active", `${plan.label}.service`]);
  if (result.code === 0) return true;
  if (plan.mechanism === "launchd" ? result.code === 113 : [3, 4].includes(result.code)) return false;
  fail("daemon_autostart_supervisor_status_unknown");
}
export function suspendAutostart(plan: AutostartPlan, runtime: AutostartRuntime = {}): void {
  if (plan.mechanism === "windows-startup") {
    const current = readOwned(plan.filePath);
    if (current === null) return;
    if (current !== plan.contents) fail("daemon_autostart_definition_changed");
    fs.renameSync(plan.filePath, `${plan.filePath}.suspended`);
    return;
  }
  const loaded = autostartLoaded(plan, runtime);
  if (plan.mechanism === "launchd") {
    const { target } = launchTarget(plan, runtime);
    if (command(runtime, "/bin/launchctl", ["disable", target]).code !== 0) fail("daemon_autostart_suspend_failed");
    if (loaded && command(runtime, "/bin/launchctl", ["bootout", target]).code !== 0) fail("daemon_autostart_bootout_failed");
  } else if (command(runtime, "systemctl", ["--user", "disable", "--now", `${plan.label}.service`]).code !== 0) fail("daemon_autostart_suspend_failed");
  if (autostartLoaded(plan, runtime)) fail("daemon_autostart_still_loaded");
}
function isPreviousOwnedDefinition(plan: AutostartPlan, runtime: AutostartRuntime): boolean {
  if (!plan.manifestPath) return false;
  try {
    const previous = JSON.parse(readOwned(plan.manifestPath) ?? "null") as DaemonAutostartManifest;
    if (previous?.schema !== "agentlas.daemon-autostart.v1" || daemonAutostartLabel(previous) !== plan.label) return false;
    // Stale artifacts are namespace evidence only. Never validate by launching
    // the old binary, opening its DB, or trusting file existence alone.
    const oldPlan = planAutostart({ executable: previous.executable,
      entry: path.join(path.dirname(previous.entry), "autostart-entry.js"),
      manifest: previous, manifestPath: plan.manifestPath }, runtime.platform, runtime.home);
    return oldPlan.filePath === plan.filePath && readOwned(plan.filePath) === oldPlan.contents;
  } catch { return false; }
}
export function reconcileAutostart(enabled: boolean, input: AutostartCommand, runtime: AutostartRuntime = {}): AutostartReconciliation {
  const plan = planAutostart(input, runtime.platform, runtime.home);
  if (!input.manifest) fail("daemon_autostart_manifest_required");
  const exact = isAutostartInstalled(plan);
  let loaded = autostartLoaded(plan, runtime);
  if (!enabled) {
    if (!exact && !loaded && !fs.existsSync(plan.filePath)) return { installed: false, loaded: false, changed: false, filePath: plan.filePath, label: plan.label };
    suspendAutostart(plan, runtime); removeAutostart(plan);
    return { installed: false, loaded: false, changed: exact || loaded, filePath: plan.filePath, label: plan.label };
  }
  validateDaemonAutostartManifest(input.manifest);
  // The new GUI has passed its store-migration quiescence barrier. Retire only
  // an exact old definition proven to belong to this same installation/store.
  if (loaded && !exact) {
    if (!isPreviousOwnedDefinition(plan, runtime)) fail("daemon_autostart_requires_quiescence");
    suspendAutostart(plan, runtime); loaded = false;
  }
  if (!exact) installAutostart(plan);
  if (plan.mechanism === "launchd") {
    const { target, domain } = launchTarget(plan, runtime);
    if (command(runtime, "/bin/launchctl", ["enable", target]).code !== 0) fail("daemon_autostart_enable_failed");
    if (!loaded && command(runtime, "/bin/launchctl", ["bootstrap", domain, plan.filePath]).code !== 0) fail("daemon_autostart_bootstrap_failed");
  } else if (plan.mechanism === "systemd-user") {
    if (command(runtime, "systemctl", ["--user", "daemon-reload"]).code !== 0
      || command(runtime, "systemctl", ["--user", "enable", "--now", `${plan.label}.service`]).code !== 0) fail("daemon_autostart_enable_failed");
  }
  const nowLoaded = autostartLoaded(plan, runtime);
  if (plan.mechanism !== "windows-startup" && !nowLoaded) fail("daemon_autostart_not_loaded");
  return { installed: isAutostartInstalled(plan), loaded: nowLoaded, changed: !exact || !loaded, filePath: plan.filePath, label: plan.label };
}
