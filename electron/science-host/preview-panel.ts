import type { FilePreviewEntryInfo, FilePreviewRefusal } from "../document/file-preview";
import type { SciencePreviewOfferResult, SciencePreviewPanelState } from "../../shared/science-preview-panel";

/*
 * Science's Preview (state side). It is the Universal File Viewer, the viewer Work's right rail uses for files, hosted
 * in a page-owned column beside the Science view. It is read-only and faithful: docx and pdf pages, a spreadsheet's
 * sheets and formats, hwpx, pptx.
 *
 * The Science view hands over bytes it already holds and has verified (a manuscript render output, a table as csv)
 * through `shell.previewFile`; Main keeps them in memory behind a token (document/file-preview.ts) and tells the owner
 * window which previews exist. The renderer never names a path and the view never learns a token.
 *
 * No electron import (the Main wiring is science-host/preview-panel-main.ts), so a plain Node gate runs all of it.
 */

export type { SciencePreviewOfferResult, SciencePreviewPanelState };

/** The part of FilePreviewRegistry this uses. */
export interface SciencePreviewRegistry {
  register(ownerKey: string, input: { name: unknown; bytes: unknown }): { ok: true; entry: FilePreviewEntryInfo } | { ok: false; reason: FilePreviewRefusal };
  list(ownerKey: string): FilePreviewEntryInfo[];
  revoke(ownerKey: string, token: unknown): boolean;
  releaseOwner(ownerKey: string): number;
}

export interface SciencePreviewPanelPorts {
  registry: SciencePreviewRegistry;
  /** Delivers a changed state to the owner window `ownerId`. */
  publish(ownerId: number, state: SciencePreviewPanelState): void;
}

const ownerKey = (ownerId: number): string => `science:${ownerId}`;
const EMPTY_STATE = JSON.stringify({ items: [] });

export class SciencePreviewPanel {
  private readonly published = new Map<number, string>();

  constructor(private readonly ports: SciencePreviewPanelPorts) {}

  /** What the owner window shows: its own previews, nothing of anyone else's. */
  state(ownerId: number): SciencePreviewPanelState {
    return {
      items: this.ports.registry.list(ownerKey(ownerId))
        .map(({ token, name, extension, kind, size }) => ({ token, name, extension, kind, size })),
    };
  }

  private publish(ownerId: number): void {
    const next = this.state(ownerId);
    const serialized = JSON.stringify(next);
    // A window that was never told anything shows nothing, which is the empty state.
    if (serialized === (this.published.get(ownerId) ?? EMPTY_STATE)) return;
    this.published.set(ownerId, serialized);
    this.ports.publish(ownerId, next);
  }

  /**
   * The Science view of `ownerId` asks to preview a file. Only `name` (display and extension) and `bytes` are read; any
   * other key the view sends, a path included, is ignored.
   */
  offer(ownerId: number, input: unknown): SciencePreviewOfferResult {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "preview_input_invalid" };
    const { name, bytes } = input as { name?: unknown; bytes?: unknown };
    const result = this.ports.registry.register(ownerKey(ownerId), { name, bytes });
    if (!result.ok) return { ok: false, reason: result.reason };
    this.publish(ownerId);
    return { ok: true, name: result.entry.name };
  }

  /** The owner closed one preview. */
  close(ownerId: number, token: unknown): boolean {
    const removed = this.ports.registry.revoke(ownerKey(ownerId), token);
    if (removed) this.publish(ownerId);
    return removed;
  }

  /** The owner window closed its Science view: nothing stays held. */
  releaseOwner(ownerId: number): void {
    this.ports.registry.releaseOwner(ownerKey(ownerId));
    // Publish whatever differs from what the window was last told (an entry may have expired earlier, silently).
    this.publish(ownerId);
    this.published.delete(ownerId);
  }
}
