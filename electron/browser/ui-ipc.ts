import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { BrowserUiAPI } from "../../shared/browser-ui";
import {
  actOnBrowserDownload,
  browserDownloads,
  browserAllTabHistory,
  browserNativeSessionReadiness,
  browserTabHistory,
  changeBrowserDeviceEmulation,
  changeBrowserZoom,
  clearBrowserData,
  findBrowserText,
  printBrowserPage,
  saveBrowserScreenshot,
  setBrowserDevTools,
  stopBrowserFind,
} from "./ui-controls";

export interface BrowserUiIpcDependencies {
  ipc: Pick<IpcMain, "handle">;
  assertTrustedSender: (event: IpcMainInvokeEvent) => BrowserWindow;
}

/**
 * Register the renderer-facing browser controls. Every scoped handler first
 * verifies the Desktop renderer and then resolves an exact owner/task/view
 * guest; a guessed view ID in another window cannot cross that boundary.
 */
export function registerBrowserUiIpc({ ipc, assertTrustedSender }: BrowserUiIpcDependencies): void {
  const trusted = (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    return event.sender.id;
  };
  ipc.handle("browserUi:readiness", (event) => {
    trusted(event);
    return browserNativeSessionReadiness();
  });
  ipc.handle("browserUi:find", (event, input: Parameters<BrowserUiAPI["find"]>[0]) =>
    findBrowserText(trusted(event), input));
  ipc.handle("browserUi:stopFind", (event, input: Parameters<BrowserUiAPI["stopFind"]>[0]) =>
    stopBrowserFind(trusted(event), input));
  ipc.handle("browserUi:zoom", (event, input: Parameters<BrowserUiAPI["zoom"]>[0]) =>
    changeBrowserZoom(trusted(event), input));
  ipc.handle("browserUi:deviceEmulation", (event, input: Parameters<BrowserUiAPI["deviceEmulation"]>[0]) =>
    changeBrowserDeviceEmulation(trusted(event), input));
  ipc.handle("browserUi:devTools", (event, input: Parameters<BrowserUiAPI["devTools"]>[0]) =>
    setBrowserDevTools(trusted(event), input));
  ipc.handle("browserUi:print", (event, input: Parameters<BrowserUiAPI["print"]>[0]) =>
    printBrowserPage(trusted(event), input));
  ipc.handle("browserUi:saveScreenshot", (event, input: Parameters<BrowserUiAPI["saveScreenshot"]>[0]) =>
    saveBrowserScreenshot(trusted(event), input));
  ipc.handle("browserUi:history", (event, input: Parameters<BrowserUiAPI["history"]>[0]) =>
    browserTabHistory(trusted(event), input));
  ipc.handle("browserUi:historyAll", (event, input: Parameters<BrowserUiAPI["historyAll"]>[0]) =>
    browserAllTabHistory(trusted(event), input));
  ipc.handle("browserUi:downloads", (event, input: Parameters<BrowserUiAPI["downloads"]>[0]) =>
    browserDownloads(trusted(event), input));
  ipc.handle("browserUi:downloadAction", (event, input: Parameters<BrowserUiAPI["downloadAction"]>[0]) =>
    actOnBrowserDownload(trusted(event), input));
  ipc.handle("browserUi:clearData", (event, input: Parameters<BrowserUiAPI["clearData"]>[0]) =>
    clearBrowserData(trusted(event), input));
}
