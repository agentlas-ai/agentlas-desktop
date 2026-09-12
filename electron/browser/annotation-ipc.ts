import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { BrowserAnnotationAPI } from "../../shared/browser-annotation";
import { startBrowserAnnotation, stopBrowserAnnotation, browserAnnotationSelection, commentBrowserAnnotation } from "./annotation";
export function registerBrowserAnnotationIpc({ ipc, assertTrustedSender }: {
  ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => BrowserWindow;
}): void {
  const owner = (event: IpcMainInvokeEvent) => { assertTrustedSender(event); return event.sender.id; };
  ipc.handle("browserAnnotation:start", (event, input: Parameters<BrowserAnnotationAPI["start"]>[0]) => startBrowserAnnotation(owner(event), input));
  ipc.handle("browserAnnotation:stop", (event, input: Parameters<BrowserAnnotationAPI["stop"]>[0]) => stopBrowserAnnotation(owner(event), input));
  ipc.handle("browserAnnotation:selection", (event, input: Parameters<BrowserAnnotationAPI["selection"]>[0]) => browserAnnotationSelection(owner(event), input));
  ipc.handle("browserAnnotation:comment", (event, input: Parameters<BrowserAnnotationAPI["comment"]>[0]) => commentBrowserAnnotation(owner(event), input));
}
