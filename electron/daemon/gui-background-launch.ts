// The background service starts the app in the background when One needs it and it is not running.
//
// After a login (or a restart, a logout) only the background service starts, so One answers from the phone but every app operation
// it calls goes through a window process that is not there (app-control/daemon-remote.ts): "tell the owner to open Agentlas", and the
// owner on the phone cannot. The service starts the app itself with GUI_BACKGROUND_START_ARG: the app runs in its tray (background
// hold), opens no window, and attaches as usual; an operation that needs the window opens it then (app-control/service.ts).
//
// No electron import: the service runs this without Electron. A development or QA instance never starts the owner's app, and a start
// happens at most once per RELAUNCH_BACKOFF_MS, so an app that cannot start (a sign-in screen, an update, a crash) is not started in a loop.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { isNonProductionInstance } from "./autostart-eligibility";

/** The flag the app reads at start (electron/main.ts): run in the tray, open no window. */
export const GUI_BACKGROUND_START_ARG = "--agentlas-background-start";
export const RELAUNCH_BACKOFF_MS = 10 * 60_000;
/** How long after a start the app counts as starting at most (a cold start measured 8-21 s on a real installation). */
export const GUI_STARTING_MS = 60_000;

let lastLaunchAt = 0;
/** Until when a start counts as on its way; cleared when the app attached, or when the started process failed or exited. */
let startingUntil = 0;

export interface GuiLaunchCommand { command: string; args: string[]; env?: NodeJS.ProcessEnv; target: string }

/**
 * How this installation's app is started in the background, or null when it cannot be. The app's own binary is run directly on every
 * platform (not `open` on macOS: LaunchServices sends a running app a reopen, which brings a window forward): an app already running
 * receives it as a second launch carrying GUI_BACKGROUND_START_ARG, which it ignores (electron/main.ts), so no window ever comes up.
 */
export function guiLaunchCommand(platform: NodeJS.Platform = process.platform, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = (file) => fs.existsSync(file)): GuiLaunchCommand | null {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return null;
  // A path that does not outlast its launch: an AppImage mount, a portable copy, a macOS translocated copy (autostart is off for them too).
  if (env.APPIMAGE || env.PORTABLE_EXECUTABLE_FILE || /[\\/]AppTranslocation[\\/]/.test(execPath)) return null;
  // The service runs the app's own binary as Node; anything else (a development Electron, a bare node) is not an installed app.
  if (platform === "darwin" && !execPath.includes(".app/Contents/MacOS/")) return null;
  // A Linux service started without a display (a login unit before the session's display is known) cannot show an app: it would die at once.
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  // The service's own environment (Node mode, its store and runtime metadata) is not the app's: the app starts as it does from its icon.
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ELECTRON_|AGENTLAS_)/i.test(key)));
  // A service run as a systemd user unit would keep the app in its own control group, so a restart of the service would kill the app:
  // the app gets a scope of its own.
  if (platform === "linux" && env.INVOCATION_ID && exists("/usr/bin/systemd-run")) {
    return { command: "/usr/bin/systemd-run", args: ["--user", "--scope", "--quiet", execPath, GUI_BACKGROUND_START_ARG], env: clean, target: execPath };
  }
  return { command: execPath, args: [GUI_BACKGROUND_START_ARG], env: clean, target: execPath };
}

/**
 * The installed app is the version this service runs (macOS: the bundle's Info.plist against the service's runtime metadata). An app
 * replaced by an update while the service ran would stop this very service at its start (version skew) and end the One turn that asked
 * for it; it is not started from here. Unknown on either side counts as the same.
 */
export function installedAppMatchesService(platform: NodeJS.Platform = process.platform, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== "darwin") return true;
  let serviceVersion: unknown;
  try { serviceVersion = (JSON.parse(env.AGENTLAS_RUNTIME_APP_METADATA ?? "null") as { version?: unknown } | null)?.version; } catch { return true; }
  if (typeof serviceVersion !== "string" || !serviceVersion) return true;
  const at = execPath.indexOf(".app/Contents/MacOS/");
  if (at < 0) return true;
  try {
    const plist = fs.readFileSync(`${execPath.slice(0, at + 4)}/Contents/Info.plist`, "utf8");
    const installed = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
    return !installed || installed === serviceVersion;
  } catch { return true; }
}

/** Starts the app in the background, once per backoff window. True only when a start was made now. */
export function launchGuiInBackground(now: number = Date.now()): boolean {
  if (now - lastLaunchAt < RELAUNCH_BACKOFF_MS) return false;
  if (isNonProductionInstance() || !installedAppMatchesService()) return false;
  const command = guiLaunchCommand();
  if (!command || !fs.existsSync(command.target)) return false;
  lastLaunchAt = now;
  startingUntil = now + GUI_STARTING_MS;
  try {
    // No windowsHide: on Windows it hides the started app's first window too (STARTUPINFO), so the window an operation opens never shows.
    const child = spawn(command.command, command.args, { detached: true, stdio: "ignore", ...(command.env ? { env: command.env } : {}) });
    // A start that could not run, or a process that ended (a second launch handed to a running app, a crash at start), is not on its way.
    const settle = () => { startingUntil = 0; };
    child.on("error", settle);
    child.on("exit", settle);
    child.unref();
    console.info("[app-launch] starting Agentlas in the background for an app operation");
    return true;
  } catch {
    startingUntil = 0;
    return false;
  }
}

/** A start on its way: made in the last GUI_STARTING_MS, not failed, not yet attached. */
export function guiStarting(now: number = Date.now()): boolean {
  return now < startingUntil;
}

/** The app attached: whatever started it is done. */
export function guiAttached(): void {
  startingUntil = 0;
}

/** Tests only. */
export function resetGuiBackgroundLaunchForTests(): void {
  lastLaunchAt = 0;
  startingUntil = 0;
}
