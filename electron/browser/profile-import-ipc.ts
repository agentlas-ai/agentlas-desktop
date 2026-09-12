import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { BrowserProfileImportAPI } from "../../shared/browser-profile-import";
import { importBrowserProfileData, scanBrowserProfileData } from "./profile-import";

export interface BrowserProfileImportIpcDependencies {
  ipc: Pick<IpcMain, "handle">;
  assertTrustedSender: (event: IpcMainInvokeEvent) => BrowserWindow;
}

export function registerBrowserProfileImportIpc({ ipc, assertTrustedSender }: BrowserProfileImportIpcDependencies): void {
  ipc.handle("browserProfileImport:scan", (event, input: Parameters<BrowserProfileImportAPI["scan"]>[0]) => {
    assertTrustedSender(event);
    return scanBrowserProfileData(input);
  });
  ipc.handle("browserProfileImport:import", (event, input: Parameters<BrowserProfileImportAPI["import"]>[0]) => {
    assertTrustedSender(event);
    return importBrowserProfileData(input);
  });
}
