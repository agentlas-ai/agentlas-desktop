import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { isAppControlEvent } from "./app-control/ipc-registry";
import { dismissSystemPermissionIssue, subscribeSystemPermissionIssues, systemPermissionSnapshot } from "./os-permission-guidance";
import { isSystemPermissionKey, systemPermissionSettingsTarget, type SystemPermissionKey } from "../shared/os-permissions";

// The background service reaches this module through automation repair and runs without Electron, so Electron is
// loaded on use (scripts/test-daemon-loads-without-electron.cjs). Without it, settings open through the OS opener.
function electronModule(): typeof import("electron") | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as typeof import("electron") | string;
    return typeof electron === "object" && electron !== null ? electron : null;
  } catch { return null; }
}
function openWithSystem(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => execFile(command, args, { timeout: 10_000 }, error => error ? reject(error) : resolve()));
}

/** Opens a known destination only; never enables permissions or retries a failed task. */
export async function openSystemPermissionSettings(permission: SystemPermissionKey): Promise<{ ok: boolean; error?: string }> {
  if (!isSystemPermissionKey(permission)) return { ok: false, error: "system-permission-invalid-target" };
  const target = systemPermissionSettingsTarget(process.platform, permission);
  if (!target) return { ok: false, error: "system-permission-settings-unavailable" };
  try {
    const shell = electronModule()?.shell;
    if (target === "keychain-access") await openWithSystem("/usr/bin/open", ["-a", "Keychain Access"]);
    else if (shell) await shell.openExternal(target);
    else if (process.platform === "darwin") await openWithSystem("/usr/bin/open", [target]);
    else if (process.platform === "win32") await openWithSystem("explorer.exe", [target]);
    else await openWithSystem("xdg-open", [target]);
    return { ok: true };
  } catch { return { ok: false, error: "system-permission-settings-open-failed" }; }
}
export function systemPermissionStatus(permission: SystemPermissionKey): boolean {
  const systemPreferences = electronModule()?.systemPreferences;
  if (!systemPreferences) return false;
  try {
    if (permission === "accessibility") return process.platform === "darwin" && systemPreferences.isTrustedAccessibilityClient(false);
    // Electron always reports screen=granted on Windows; that is not evidence
    // that the Windows graphics-capture privacy setting permits this operation.
    if (permission === "screen" && process.platform === "win32") return false;
    const media = permission === "screen" ? "screen" : permission === "camera" ? "camera" : permission === "microphone" ? "microphone" : null;
    return media !== null && (process.platform === "darwin" || process.platform === "win32")
      && systemPreferences.getMediaAccessStatus(media) === "granted";
  } catch { return false; }
}
export function registerSystemPermissionIpc(input: {
  ipc: Pick<IpcMain, "handle">;
  assertTrustedSender(event: IpcMainInvokeEvent): unknown;
}): void {
  const authorize = (event: IpcMainInvokeEvent) => {
    input.assertTrustedSender(event);
    if (isAppControlEvent(event)) throw new Error("system-permission-owner-interaction-required");
  };
  const notice = (id: unknown) => {
    if (typeof id !== "string" || !/^os-permission-\d+$/.test(id)) throw new Error("system-permission-invalid-id");
    return systemPermissionSnapshot().notices.find(value => value.id === id);
  };
  input.ipc.handle("systemPermission:snapshot", event => { authorize(event); return systemPermissionSnapshot(); });
  input.ipc.handle("systemPermission:open", (event, id: unknown) => {
    authorize(event);
    const value = notice(id);
    return value ? openSystemPermissionSettings(value.permission) : { ok: false, error: "system-permission-notice-stale" };
  });
  input.ipc.handle("systemPermission:dismiss", (event, id: unknown) => {
    authorize(event); if (notice(id)) dismissSystemPermissionIssue(id as string);
  });
  input.ipc.handle("systemPermission:recheck", (event, id: unknown) => {
    authorize(event);
    const value = notice(id);
    const resolved = value !== undefined && systemPermissionStatus(value.permission);
    if (resolved) dismissSystemPermissionIssue(value!.id);
    return { resolved };
  });
  subscribeSystemPermissionIssues(snapshot => {
    for (const window of electronModule()?.BrowserWindow.getAllWindows() ?? []) {
      try { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("systemPermission:changed", snapshot); }
      catch { /* A closed renderer can hydrate the snapshot after reopening. */ }
    }
  });
}
