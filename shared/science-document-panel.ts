/*
 * Science's Document panel: what the owner window is told (electron/science-host/document-panel.ts decides it).
 * A token stands for a finished manuscript export; a path never reaches the renderer.
 */

export type ScienceExportFormat = "docx" | "hwpx";

export interface ScienceDocumentPanelState {
  /** The conversation the Science view shows; null while it shows none (the panel stays out of the way). */
  context: { conversationId: string; chatId: string; title: string } | null;
  /** Finished exports of that conversation the owner can open in the panel. */
  offers: Array<{ token: string; name: string; format: ScienceExportFormat }>;
}

export type ScienceExportOpenResult =
  | { ok: true; sessionId: string; chatId: string }
  | { ok: false; reason: string };

export interface ScienceDocumentBridge {
  state: () => Promise<ScienceDocumentPanelState>;
  openExport: (token: string) => Promise<ScienceExportOpenResult>;
  dismissExport: (token: string) => Promise<boolean>;
  onChanged: (handler: (state: ScienceDocumentPanelState) => void) => () => void;
}
