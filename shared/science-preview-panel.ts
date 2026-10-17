import type { FilePreviewKind } from "./file-preview";

/*
 * Science's Preview tab: what the owner window is told (electron/science-host/preview-panel.ts decides it). A token
 * stands for bytes Main holds; the renderer builds the viewer's URL from it and never sees a path.
 */

export interface SciencePreviewItem {
  token: string;
  name: string;
  extension: string;
  kind: FilePreviewKind;
  size: number;
}

export interface SciencePreviewPanelState {
  /** The owner's open previews, oldest first; the newest is the one just offered. */
  items: SciencePreviewItem[];
}

/** What the Science view hands to `shell.previewFile`: a display name (its extension picks the format) and the bytes. */
export interface SciencePreviewFileInput {
  name: string;
  bytes: Uint8Array;
}

/** What the Science view's `shell.previewFile` returns. Nothing in it is a token or a path. */
export type SciencePreviewOfferResult =
  | { ok: true; name: string }
  | { ok: false; reason: string };

export interface SciencePreviewBridge {
  state: () => Promise<SciencePreviewPanelState>;
  close: (token: string) => Promise<boolean>;
  onChanged: (handler: (state: SciencePreviewPanelState) => void) => () => void;
}
