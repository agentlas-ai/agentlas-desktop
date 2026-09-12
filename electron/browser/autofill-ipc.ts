import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { BrowserAutofillAPI } from "../../shared/browser-autofill";
import { fillBrowserContact, fillBrowserCredential } from "./autofill-controls";
import {
  browserAutofillSnapshot,
  removeBrowserContact,
  removeBrowserCredential,
  saveBrowserContact,
  saveBrowserCredential,
} from "./autofill-vault";

export interface BrowserAutofillIpcDependencies {
  ipc: Pick<IpcMain, "handle">;
  assertTrustedSender: (event: IpcMainInvokeEvent) => BrowserWindow;
}

export function registerBrowserAutofillIpc({ ipc, assertTrustedSender }: BrowserAutofillIpcDependencies): void {
  const trusted = (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    return event.sender.id;
  };
  ipc.handle("browserAutofill:snapshot", (event) => { trusted(event); return browserAutofillSnapshot(); });
  ipc.handle("browserAutofill:saveCredential", (event, input: Parameters<BrowserAutofillAPI["saveCredential"]>[0]) => {
    trusted(event); return saveBrowserCredential(input);
  });
  ipc.handle("browserAutofill:removeCredential", (event, input: Parameters<BrowserAutofillAPI["removeCredential"]>[0]) => {
    trusted(event); return removeBrowserCredential(input);
  });
  ipc.handle("browserAutofill:saveContact", (event, input: Parameters<BrowserAutofillAPI["saveContact"]>[0]) => {
    trusted(event); return saveBrowserContact(input);
  });
  ipc.handle("browserAutofill:removeContact", (event, input: Parameters<BrowserAutofillAPI["removeContact"]>[0]) => {
    trusted(event); return removeBrowserContact(input);
  });
  ipc.handle("browserAutofill:fillCredential", (event, input: Parameters<BrowserAutofillAPI["fillCredential"]>[0]) =>
    fillBrowserCredential(trusted(event), input));
  ipc.handle("browserAutofill:fillContact", (event, input: Parameters<BrowserAutofillAPI["fillContact"]>[0]) =>
    fillBrowserContact(trusted(event), input));
}
