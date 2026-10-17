import { webContents, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { FilePreviewRegistry } from "../document/file-preview";
import { onScienceViewClosed } from "../extensions/view-host";
import { SciencePreviewPanel, type SciencePreviewPanelState } from "./preview-panel";

/*
 * Main wiring of Science's Preview tab (preview-panel.ts holds the rules, document/file-preview.ts holds the bytes).
 * The owner window's Science screen reads the state and closes a preview through two trusted-sender channels; the
 * Science view reaches the panel only through `science:shell:previewFile`, which main.ts registers next to the other
 * `science:shell:*` handlers because it needs that file's Science sender check.
 */

let registry: FilePreviewRegistry | null = null;
let panel: SciencePreviewPanel | null = null;

/** One registry for the app: the agentlas://file-preview protocol branch serves what the panel registers. */
export function filePreviewRegistry(): FilePreviewRegistry {
  registry ??= new FilePreviewRegistry();
  return registry;
}

export function sciencePreviewPanel(): SciencePreviewPanel {
  panel ??= new SciencePreviewPanel({
    registry: filePreviewRegistry(),
    publish(ownerId: number, state: SciencePreviewPanelState) {
      const target = webContents.fromId(ownerId);
      if (target && !target.isDestroyed()) target.send("sciencePreview:changed", state);
    },
  });
  return panel;
}

export function registerSciencePreviewPanelIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  const { ipc, assertTrustedSender } = input;
  onScienceViewClosed(ownerId => sciencePreviewPanel().releaseOwner(ownerId));
  ipc.handle("sciencePreview:state", (event) => {
    assertTrustedSender(event);
    return sciencePreviewPanel().state(event.sender.id);
  });
  ipc.handle("sciencePreview:close", (event, token: unknown) => {
    assertTrustedSender(event);
    return sciencePreviewPanel().close(event.sender.id, token);
  });
}
