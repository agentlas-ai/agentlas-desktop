// Renderers measure native-view slots with getBoundingClientRect(), which is in
// CSS pixels of a page that may be zoomed (View > Zoom, Cmd +/-). A native
// WebContentsView is placed in window DIPs. Every native view host converts
// through here; without it a zoomed window places the view at rect / zoom
// (shifted up-left and shrunk, or down-right and grown when zoomed out).
import { webContents as allWebContents } from "electron";
import type { WebContents } from "electron";

type Box = { x: number; y: number; width: number; height: number };

/** Zoom factor of the page that measured the rect; 1 when it is unknown or gone. */
export function measuringZoomFactor(owner: number | WebContents | null | undefined): number {
  try {
    const contents = typeof owner === "number" ? allWebContents.fromId(owner) : owner;
    const factor = contents && !contents.isDestroyed() ? contents.getZoomFactor() : 1;
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch { return 1; }
}

/** CSS-pixel rect from a zoomed page -> window DIPs. Non-numeric entries stay NaN for the caller's own validation. */
export function ownerCssBoundsToWindow<T extends Box>(bounds: T, zoomFactor: number): T {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const value = (entry: unknown) => (typeof entry === "number" ? entry : Number(entry)) * scale;
  return { ...bounds, x: value(bounds?.x), y: value(bounds?.y), width: value(bounds?.width), height: value(bounds?.height) };
}
