import { randomUUID } from "node:crypto";
import { webContents, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { scienceStore } from "agentlas-science";
import { openLiveDocument } from "../live-document/store";
import { stableScienceRuntimeChatId } from "../store/chats";
import { scienceViewHooks } from "../extensions/view-host";
import { ScienceDocumentPanel, type ScienceDocumentPanelState } from "./document-panel";

/*
 * Main wiring of the Science Document panel (document-panel.ts holds the rules). The owner window's Science screen
 * reads its state and opens an offered export through three trusted-sender channels; Science's view reaches the panel
 * only through the hooks view-host.ts and daemon-ipc.ts call, so nothing the view sends names a path or a chat.
 */

let panel: ScienceDocumentPanel | null = null;

export function scienceDocumentPanel(): ScienceDocumentPanel {
  panel ??= new ScienceDocumentPanel({
    conversationTitle(projectId, conversationId) {
      try {
        const row = scienceStore().listConversations(projectId).find(item => item.id === conversationId);
        return row ? row.title : null;
      } catch { return null; }
    },
    chatIdFor: stableScienceRuntimeChatId,
    openDocument: input => openLiveDocument(input),
    publish(ownerId: number, state: ScienceDocumentPanelState) {
      const target = webContents.fromId(ownerId);
      if (target && !target.isDestroyed()) target.send("scienceDocument:changed", state);
    },
    now: () => Date.now(),
    token: () => randomUUID(),
  });
  return panel;
}

export function registerScienceDocumentPanelIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  const { ipc, assertTrustedSender } = input;
  scienceViewHooks.closed = ownerId => scienceDocumentPanel().releaseOwner(ownerId);
  scienceViewHooks.download = (ownerId, item) => scienceDocumentPanel().captureDownload(ownerId, item);
  ipc.handle("scienceDocument:state", (event) => {
    assertTrustedSender(event);
    return scienceDocumentPanel().state(event.sender.id);
  });
  ipc.handle("scienceDocument:openExport", (event, token: unknown) => {
    assertTrustedSender(event);
    return scienceDocumentPanel().openExport(event.sender.id, token);
  });
  ipc.handle("scienceDocument:dismissExport", (event, token: unknown) => {
    assertTrustedSender(event);
    scienceDocumentPanel().dismissExport(event.sender.id, token);
    return true;
  });
}
