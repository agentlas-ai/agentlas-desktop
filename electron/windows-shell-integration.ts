// Windows shell integration: the app's identity in the taskbar/notification system, sign-out and
// shutdown, and the executable the shell should start again (installed vs portable).
//
// Windows audit 2026-10-24 (UI findings #2, #3, #7; file-system finding #12):
//   #2 No app.setAppUserModelId: the NSIS shortcuts carry AUMID = appId (com.agentlas.desktop) and the
//      process had Electron's default, so toasts could not show and taskbar pins did not merge.
//   #3 powerMonitor "shutdown" does not exist on Windows and nothing listened to the window
//      query-session-end / session-end events. Sign-out ran the ordinary quit: the quit prompt held
//      sign-out ("Agentlas is preventing you from signing out"), and a downloaded update could start
//      installing during log-off.
//   #7 The Portable exe runs from a %TEMP% extraction that is deleted after exit. Protocol
//      registration, relaunch and login autostart all pointed at that temporary Agentlas.exe.
//
// Pure, no Electron import: scripts/test-windows-shell-integration.cjs drives every branch.

import { LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY, OFFICIAL_BUILD_INSTALL_IDENTITY, type InstallChannel } from "./install-identity";

/**
 * The AUMID to set on Windows: the appId electron-builder stamped on this build's shortcuts (the packaged
 * install marker for the channel). Unpackaged/dev runs have no installed shortcut: null, Electron's default.
 */
export function windowsAppUserModelId(platform: NodeJS.Platform, channel: InstallChannel | string): string | null {
  if (platform !== "win32") return null;
  if (channel === OFFICIAL_BUILD_INSTALL_IDENTITY.channel) return OFFICIAL_BUILD_INSTALL_IDENTITY.appId;
  if (channel === LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY.channel) return LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY.appId;
  return null;
}

/** The persistent portable launcher, when this process was started by electron-builder's Portable exe. */
export function portableExecutableFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (platform !== "win32") return null;
  const file = env.PORTABLE_EXECUTABLE_FILE;
  return typeof file === "string" && file.trim() ? file : null;
}

/**
 * The executable the shell should start for Agentlas: the portable launcher file on a portable run
 * (process.execPath is the deleted-at-exit %TEMP% copy), otherwise process.execPath.
 */
export function launcherExecPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, execPath: string): string {
  return portableExecutableFile(platform, env) ?? execPath;
}

export interface ProtocolRegistrationApp {
  getApplicationNameForProtocol(url: string): string;
  isDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
}

/**
 * What protocol registration does. A portable run registers its launcher file, never the %TEMP% copy,
 * and never takes agentlas:// from an installed Agentlas that already owns it (running the portable
 * and installed builds side by side kept overwriting HKCU\Software\Classes\agentlas).
 */
export function protocolRegistrationPlan(input: {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; defaultApp: boolean; argv: readonly string[];
  app: ProtocolRegistrationApp; resolve: (value: string) => string;
}): { kind: "register"; execPath?: string; args?: string[] } | { kind: "skip"; reason: "portable-installed-owner" } {
  if (input.defaultApp && input.argv.length >= 2) {
    return { kind: "register", execPath: undefined, args: [input.resolve(String(input.argv[1]))] };
  }
  const portable = portableExecutableFile(input.platform, input.env);
  if (!portable) return { kind: "register" };
  let owner = "";
  try { owner = input.app.getApplicationNameForProtocol("agentlas://") || ""; } catch { owner = ""; }
  let ours = false;
  try { ours = input.app.isDefaultProtocolClient("agentlas", portable, []); } catch { ours = false; }
  if (owner && !ours) return { kind: "skip", reason: "portable-installed-owner" };
  return { kind: "register", execPath: portable, args: [] };
}

/** The part of a BrowserWindow the session-end watcher reads. */
export interface SessionEndWindow {
  on(event: "query-session-end" | "session-end", listener: (event?: { reasons?: string[] }) => void): unknown;
}

export interface SessionEndHost {
  /**
   * Windows is ending the session. `final` is false for query-session-end (another app may still
   * veto the sign-out), true for session-end (the process is about to be terminated).
   */
  sessionEnding(final: boolean, reasons: readonly string[]): void;
}

/**
 * Watch one window for Windows sign-out / restart / shutdown. Windows sends the messages to every
 * top-level window, so every BrowserWindow is watched and the host handler must be idempotent.
 * Never calls preventDefault: Agentlas never blocks a sign-out.
 */
export function wireWindowsSessionEnd(window: SessionEndWindow, platform: NodeJS.Platform, host: SessionEndHost): boolean {
  if (platform !== "win32") return false;
  const reasonsOf = (event?: { reasons?: string[] }) => Array.isArray(event?.reasons) ? event!.reasons!.filter((r) => typeof r === "string") : [];
  window.on("query-session-end", (event) => host.sessionEnding(false, reasonsOf(event)));
  window.on("session-end", (event) => host.sessionEnding(true, reasonsOf(event)));
  return true;
}

export interface SessionEndingState {
  /** Raise or clear the "the OS is ending the session" facts (main.ts systemShutdownInProgress + quit-reason). */
  setSystemShutdown(active: boolean): void;
  systemShutdown(): boolean;
  /** The quit reason for the final notice (noteQuitIntent("os-shutdown")). */
  noteOsShutdownIntent(detail: Record<string, unknown>): void;
  quit(): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log?(line: string): void;
}

/** A vetoable sign-out keeps the flags up this long; then a later ordinary quit prompts and installs again. */
export const SESSION_END_VETO_RESET_MS = 120_000;

/**
 * The host side of wireWindowsSessionEnd. query-session-end raises the shutdown facts for two minutes (another app
 * may still veto the sign-out); session-end is final: quit reason os-shutdown and quit now. With the facts raised
 * the quit policy never prompts (quit-policy.ts planGuiQuit systemShutdown) and no update installs
 * (main.ts shouldInstallOnQuit) — the same rule as macOS powerMonitor "shutdown".
 */
export function createSessionEndingHandler(state: SessionEndingState): (final: boolean, reasons: readonly string[]) => void {
  let reset: unknown = null;
  return (final, reasons) => {
    const firstNotice = !state.systemShutdown();
    state.setSystemShutdown(true);
    if (reset !== null) state.clearTimer(reset);
    reset = null;
    if (firstNotice || final) state.log?.(`[quit] windows session ending ${JSON.stringify({ final, reasons })}`);
    if (!final) {
      reset = state.setTimer(() => { reset = null; state.setSystemShutdown(false); }, SESSION_END_VETO_RESET_MS);
      return;
    }
    state.noteOsShutdownIntent({ platform: "win32", reasons: [...reasons] });
    state.quit();
  };
}
