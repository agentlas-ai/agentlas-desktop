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
  ipc.handle("browser:probeSession", async (event, site: string) => {
    trusted(event);
    const { probeBrowserSession } = await import("./session-probe");
    return probeBrowserSession(site);
  });
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
  // The fallback ladder's owner card has one button. Same trusted-sender check; the site is a bare domain.
  ipc.handle("browserUi:ladderAction", async (event, input: Parameters<BrowserUiAPI["ladderAction"]>[0]) => {
    const window = assertTrustedSender(event);
    const action = input?.action;
    if (action !== "retry" && action !== "open-browser" && action !== "fix") return { ok: false, code: "invalid-request" };
    const site = typeof input?.site === "string" && /^[a-z0-9.-]{1,253}$/i.test(input.site) ? input.site : null;
    const { browserLadderOwnerAction } = await import("./fallback-ladder-runtime");
    if (input?.ownerScopeId !== undefined && input.ownerScopeId !== null && typeof input.ownerScopeId !== "string") {
      return { ok: false, code: "invalid-request" };
    }
    const ownerScopeId = typeof input?.ownerScopeId === "string" ? input.ownerScopeId : null;
    const browserSurface = input?.browserSurface === "native" || input?.browserSurface === "dedicated" ? input.browserSurface : undefined;
    if (ownerScopeId && action === "open-browser" && browserSurface !== "dedicated") {
      const scope = (await import("./native-cdp-relay")).nativeBrowserRelayOwnerScopeForId(ownerScopeId);
      if (scope) {
        try {
          const { registerNativeBrowserTask } = await import("../work-live-view");
          registerNativeBrowserTask({ ownerId: event.sender.id, window, taskScopeId: scope.chatId,
            send: (status) => { if (!event.sender.isDestroyed()) event.sender.send("workLiveView:status", status); } });
        } catch { return { ok: false, code: "native-browser-owner-presentation-unavailable" }; }
      }
    }
    return browserLadderOwnerAction({ action, site, ownerScopeId, browserSurface });
  });
}
