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
  mechanism: "launchd" | "windows-run-key" | "systemd-user";
  /** launchd/systemd: the definition file. windows-run-key: a display locator (HKCU\...\Run\<label>), never a file. */
  filePath: string; contents: string; label: string;
  manifestPath?: string; manifestContents?: string;
  /** windows-run-key: the value written under HKCU\Software\Microsoft\Windows\CurrentVersion\Run. */
  windowsRun?: WindowsRunDefinition;
  /** Windows: the Startup-folder .cmd that releases before 2026-10-24 wrote (retired; removed when owned). */
  legacyStartupCmd?: string;
}
/** A Run value as Windows stores it: `"<executable>" <args>`, args already split (no quoting). */
export interface WindowsRunDefinition { name: string; executable: string; args: string[] }
export interface WindowsRunItem { executable: string; args: string[]; enabled: boolean }
/**
 * HKCU Run access. Main passes Electron's app.get/setLoginItemSettings (Unicode registry API, no code page,
 * no console); private tests pass a fake. The daemon never manages its own login entry.
 */
export interface WindowsRunKey {
  read(name: string, executable: string): WindowsRunItem | null;
  write(definition: WindowsRunDefinition): void;
  remove(definition: WindowsRunDefinition): void;
}
export interface AutostartRuntime {
  platform?: NodeJS.Platform; home?: string; uid?: number;
  /** Private tests inject this; never redirect the real user's HOME. */
  run?: (executable: string, args: string[]) => { code: number; stdout: string; stderr: string };
  /** Windows login entry store; defaults to Electron's login item settings in Main. */
  windowsRunKey?: WindowsRunKey;
}
export interface AutostartReconciliation { installed: boolean; loaded: boolean; changed: boolean; filePath: string; label: string }
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
function safePath(value: string, platform: NodeJS.Platform = process.platform) {
  // A Windows plan is judged by Windows path rules wherever it is computed (C:\... is absolute only there).
  const absolute = platform === "win32" ? path.win32.isAbsolute(value) : path.isAbsolute(value);
  if (!absolute || /[\r\n\0]/.test(value)) fail("daemon_autostart_path_invalid");
}

/** argv flag the Run value starts Agentlas.exe with (entry.ts turns it into the node-mode daemon). */
export const WINDOWS_AUTOSTART_FLAG = "--agentlas-daemon-autostart";
const LEGACY_WINDOWS_CMD_PREFIX = "@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nstart \"\" /b ";
/** How a Run value reads, from its parts. Both sides of every comparison use this one function. */
export function windowsRunCommandLine(executable: string, args: readonly string[]): string {
  return [`"${executable}"`, ...args.map(arg => arg.startsWith("--") ? arg : `"${arg}"`)].join(" ");
}
/**
 * Electron 43 quotes each login-item arg itself (CommandLineToArgvW rules) and reads the value back the same way.
 * Pre-quoting made a double-quoted value: measured on Windows 11 (2026-10-24 VM) the Run value became
 * `--manifest "\"C:\...\autostart-manifest.json\""`, so the login start received the path with literal quotes
 * (windowsAutostartChild refused it: no daemon at login) and the read-back check failed with
 * daemon_autostart_windows_run_key_write_unverified while the broken value stayed in the registry.
 * Hand Electron the raw args.
 */
export function windowsRunWriteArgs(args: readonly string[]): string[] {
  return [...args];
}
/**
 * Windows login autostart (Windows audit 2026-10-24, engine.md E3, ui.md #5, fs.md #9). Releases before this wrote
 * `Startup\<label>.cmd` with absolute UTF-8 paths: cmd.exe reads batch files in the OEM code page (949 on Korean
 * Windows), so a profile like C:\Users\홍길동 broke every path and the daemon never started; a console flashed at
 * every login; usernames with & % ! were refused; the uninstaller never removed it. A Run value is stored as
 * UTF-16 and started without cmd.exe: no code page, no console, any username. Agentlas.exe (GUI mode) receives
 * WINDOWS_AUTOSTART_FLAG and starts its own node-mode daemon child (entry.ts → windowsAutostartChild).
 */
function windowsPlan(command: AutostartCommand, home: string, label: string, args: string[]) {
  if (args.some(arg => /"/.test(arg))) fail("daemon_autostart_windows_path_unsupported");
  if (!command.manifestPath) fail("daemon_autostart_manifest_required");
  const windowsRun: WindowsRunDefinition = { name: label, executable: command.executable, args: [WINDOWS_AUTOSTART_FLAG, "--manifest", command.manifestPath] };
  return {
    mechanism: "windows-run-key" as const,
    filePath: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\${label}`,
    contents: windowsRunCommandLine(windowsRun.executable, windowsRun.args),
    windowsRun,
    legacyStartupCmd: path.win32.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${label}.cmd`),
  };
}
/**
 * What Agentlas.exe does when the Run value starts it: the node-mode autostart entry next to dist/electron/daemon,
 * with the manifest. Anything else (missing/relative manifest) is refused, so the flag cannot run another script.
 */
export function windowsAutostartChild(argv: readonly string[], electronDir: string): { entry: string; args: string[] } | null {
  const at = argv.indexOf(WINDOWS_AUTOSTART_FLAG);
  if (at < 0) return null;
  const manifest = argv[at + 1] === "--manifest" ? argv[at + 2] : undefined;
  if (typeof manifest !== "string" || !path.win32.isAbsolute(manifest) && !path.posix.isAbsolute(manifest)) return null;
  const entry = path.join(electronDir, "daemon", "autostart-entry.js");
  return { entry, args: [entry, "--manifest", manifest] };
}

/** Complete login plan, isolated by installation. Explicit home never falls
 * through to ambient APPDATA/XDG paths outside the private test fixture. */
export function planAutostart(command: AutostartCommand, platform: NodeJS.Platform = process.platform, home = os.homedir()): AutostartPlan {
  safePath(home, platform); safePath(command.executable, platform); safePath(command.entry, platform);
  const manifest = command.manifest;
  if (manifest) { if (!command.manifestPath) fail("daemon_autostart_manifest_required"); safePath(command.manifestPath, platform); }
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
  if (platform === "win32") return { ...common, ...windowsPlan(command, home, label, args) };
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
function electronRunKey(): WindowsRunKey {
  // Main only: the daemon (ELECTRON_RUN_AS_NODE) has no Electron app and never manages its own login entry.
  let app: typeof import("electron").app | undefined;
  try { app = (require("electron") as typeof import("electron")).app; } catch { app = undefined; }
  if (!app || typeof app.setLoginItemSettings !== "function") fail("daemon_autostart_windows_run_key_unavailable");
  const electronApp = app;
  return {
    read(name, executable) {
      const settings = electronApp.getLoginItemSettings({ path: executable, args: [] });
      const item = (settings.launchItems ?? []).find(candidate => candidate.name === name && candidate.scope !== "machine");
      return item ? { executable: item.path, args: [...item.args], enabled: item.enabled !== false } : null;
    },
    write(definition) {
      electronApp.setLoginItemSettings({ openAtLogin: true, enabled: true, name: definition.name,
        path: definition.executable, args: windowsRunWriteArgs(definition.args) });
    },
    remove(definition) {
      electronApp.setLoginItemSettings({ openAtLogin: false, name: definition.name,
        path: definition.executable, args: windowsRunWriteArgs(definition.args) });
    },
  };
}
function runKey(runtime: AutostartRuntime): WindowsRunKey { return runtime.windowsRunKey ?? electronRunKey(); }
/**
 * What Electron's getLoginItemSettings reports for a Run value: it parses the stored command line as a Chromium
 * CommandLine, so switches (--agentlas-daemon-autostart, --manifest) are dropped and only the loose args come back
 * (measured on Windows 11, 2026-10-24: args ["C:\...\autostart-manifest.json"]). Comparing the full definition with
 * that projection never matched: every enable said daemon_autostart_windows_run_key_write_unverified and every start
 * said daemon_autostart_definition_changed. Compare the projection; a mangled value (e.g. a path with literal
 * quotes) still differs.
 */
export function windowsRunLooseArgs(args: readonly string[]): string[] {
  return args.filter(arg => !arg.startsWith("--"));
}
function readRunValue(plan: AutostartPlan, runtime: AutostartRuntime, executable = plan.windowsRun!.executable): { line: string; enabled: boolean } | null {
  const expected = plan.windowsRun!;
  const item = runKey(runtime).read(expected.name, executable);
  if (!item) return null;
  const ours = item.executable.toLowerCase() === expected.executable.toLowerCase()
    && JSON.stringify(windowsRunLooseArgs(item.args)) === JSON.stringify(windowsRunLooseArgs(expected.args));
  return { line: ours ? plan.contents! : windowsRunCommandLine(item.executable, item.args), enabled: item.enabled };
}
/** The installed definition (file text or Run value), or null. */
function readDefinition(plan: AutostartPlan, runtime: AutostartRuntime): string | null {
  return plan.mechanism === "windows-run-key" ? readRunValue(plan, runtime)?.line ?? null : readOwned(plan.filePath);
}
/** Retire the Startup .cmd that older releases wrote — only our own exact format, never a person's file. */
export function removeLegacyWindowsStartupCmd(plan: AutostartPlan): number {
  if (!plan.legacyStartupCmd) return 0;
  let removed = 0;
  for (const file of [plan.legacyStartupCmd, `${plan.legacyStartupCmd}.suspended`]) {
    let text: string | null = null;
    try { text = readOwned(file); } catch { text = null; }
    if (text === null || !text.startsWith(LEGACY_WINDOWS_CMD_PREFIX) || !text.includes("autostart-entry.js")) continue;
    try { fs.unlinkSync(file); removed += 1; } catch { /* next reconcile retries */ }
  }
  return removed;
}
export function isAutostartInstalled(plan: AutostartPlan, runtime: AutostartRuntime = {}): boolean {
  return readDefinition(plan, runtime) === plan.contents && (!plan.manifestPath || readOwned(plan.manifestPath) === plan.manifestContents);
}
export function installAutostart(plan: AutostartPlan, runtime: AutostartRuntime = {}): void {
  if (!plan.manifestPath || !plan.manifestContents) fail("daemon_autostart_manifest_required");
  validateDaemonAutostartManifest(JSON.parse(plan.manifestContents));
  writeAtomic(plan.manifestPath, plan.manifestContents);
  // A refusal recorded for the previous definition says nothing about this one.
  try { fs.unlinkSync(`${plan.manifestPath}.failure.json`); } catch { /* none recorded */ }
  if (plan.mechanism === "windows-run-key") {
    runKey(runtime).write(plan.windowsRun!);
    if (readRunValue(plan, runtime)?.line !== plan.contents) fail("daemon_autostart_windows_run_key_write_unverified");
    return;
  }
  writeAtomic(plan.filePath, plan.contents);
}
export function removeAutostart(plan: AutostartPlan, runtime: AutostartRuntime = {}): void {
  const current = readDefinition(plan, runtime);
  if (current === null) return;
  if (current !== plan.contents) fail("daemon_autostart_definition_changed");
  if (plan.mechanism === "windows-run-key") {
    runKey(runtime).remove(plan.windowsRun!);
    if (readRunValue(plan, runtime) !== null) fail("daemon_autostart_windows_run_key_remove_unverified");
    return;
  }
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
  // Windows: "loaded" = this exact Run value exists and is not turned off in Task Manager ▸ Startup apps.
  if (plan.mechanism === "windows-run-key") {
    const value = readRunValue(plan, runtime);
    return value !== null && value.line === plan.contents && value.enabled;
  }
  const result = plan.mechanism === "launchd"
    ? command(runtime, "/bin/launchctl", ["print", launchTarget(plan, runtime).target])
    : command(runtime, "systemctl", ["--user", "is-active", `${plan.label}.service`]);
  if (result.code === 0) return true;
  if (plan.mechanism === "launchd" ? result.code === 113 : [3, 4].includes(result.code)) return false;
  fail("daemon_autostart_supervisor_status_unknown");
}
export function suspendAutostart(plan: AutostartPlan, runtime: AutostartRuntime = {}): void {
  if (plan.mechanism === "windows-run-key") {
    // Suspension = no Run value. A failed update restores it with reconcileAutostart(true) (app-launcher.ts).
    removeLegacyWindowsStartupCmd(plan);
    removeAutostart(plan, runtime);
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
/** The plan an earlier launch or version of this same installation published, when the installed definition is exactly it. */
function previousOwnedPlan(plan: AutostartPlan, runtime: AutostartRuntime): AutostartPlan | null {
  if (!plan.manifestPath) return null;
  try {
    const previous = JSON.parse(readOwned(plan.manifestPath) ?? "null") as DaemonAutostartManifest;
    if (previous?.schema !== "agentlas.daemon-autostart.v1" || daemonAutostartLabel(previous) !== plan.label) return null;
    // Stale artifacts are namespace evidence only. Never validate by launching
    // the old binary, opening its DB, or trusting file existence alone.
    const oldPlan = planAutostart({ executable: previous.executable,
      entry: path.join(path.dirname(previous.entry), "autostart-entry.js"),
      manifest: previous, manifestPath: plan.manifestPath }, runtime.platform, runtime.home);
    if (plan.mechanism === "windows-run-key") {
      return oldPlan.filePath === plan.filePath && readRunValue(oldPlan, runtime, previous.executable)?.line === oldPlan.contents ? oldPlan : null;
    }
    return oldPlan.filePath === plan.filePath && readOwned(plan.filePath) === oldPlan.contents ? oldPlan : null;
  } catch { return null; }
}
function isPreviousOwnedDefinition(plan: AutostartPlan, runtime: AutostartRuntime): boolean {
  return previousOwnedPlan(plan, runtime) !== null;
}
export function reconcileAutostart(enabled: boolean, input: AutostartCommand, runtime: AutostartRuntime = {}): AutostartReconciliation {
  const plan = planAutostart(input, runtime.platform, runtime.home);
  if (!input.manifest) fail("daemon_autostart_manifest_required");
  // Windows: the retired Startup .cmd is removed whether the switch is on or off (it is never the live definition).
  removeLegacyWindowsStartupCmd(plan);
  const exact = isAutostartInstalled(plan, runtime);
  let loaded = autostartLoaded(plan, runtime);
  if (!enabled) {
    const present = plan.mechanism === "windows-run-key" ? readDefinition(plan, runtime) !== null : fs.existsSync(plan.filePath);
    // An entry an earlier launch or version installed names another executable (a Windows Portable temp copy, an AppImage mount
    // that no longer exists): this launch's plan never equals it (a Run value is looked up by executable, so it does not even see
    // it), so retire it by the plan its own stored manifest proves.
    const earlier = exact ? null : previousOwnedPlan(plan, runtime);
    if (!exact && !loaded && !present && !earlier) return { installed: false, loaded: false, changed: false, filePath: plan.filePath, label: plan.label };
    const installedPlan = earlier ?? plan;
    suspendAutostart(installedPlan, runtime); removeAutostart(installedPlan, runtime);
    return { installed: false, loaded: false, changed: exact || loaded || earlier !== null, filePath: plan.filePath, label: plan.label };
  }
  validateDaemonAutostartManifest(input.manifest);
  // The new GUI has passed its store-migration quiescence barrier. Retire only
  // an exact old definition proven to belong to this same installation/store.
  if (loaded && !exact) {
    if (!isPreviousOwnedDefinition(plan, runtime)) fail("daemon_autostart_requires_quiescence");
    suspendAutostart(plan, runtime); loaded = false;
  }
  if (!exact) installAutostart(plan, runtime);
  if (plan.mechanism === "launchd") {
    const { target, domain } = launchTarget(plan, runtime);
    if (command(runtime, "/bin/launchctl", ["enable", target]).code !== 0) fail("daemon_autostart_enable_failed");
    if (!loaded && command(runtime, "/bin/launchctl", ["bootstrap", domain, plan.filePath]).code !== 0) fail("daemon_autostart_bootstrap_failed");
  } else if (plan.mechanism === "systemd-user") {
    if (command(runtime, "systemctl", ["--user", "daemon-reload"]).code !== 0
      || command(runtime, "systemctl", ["--user", "enable", "--now", `${plan.label}.service`]).code !== 0) fail("daemon_autostart_enable_failed");
  }
  const nowLoaded = autostartLoaded(plan, runtime);
  // Windows: an exact value the person turned off in Task Manager ▸ Startup apps stays off (loaded:false); it is
  // their choice, so reconcile reports it instead of re-enabling it at every launch.
  if (plan.mechanism !== "windows-run-key" && !nowLoaded) fail("daemon_autostart_not_loaded");
  return { installed: isAutostartInstalled(plan, runtime), loaded: nowLoaded, changed: !exact || !loaded, filePath: plan.filePath, label: plan.label };
}
