const PPTX_FLOAT_CLEAR_STYLE = `
.pptx-viewer-shell > .pptx-render-surface {
  clear: both !important;
}
`;

/**
 * Some @file-viewer presentation renderers float their sticky slideshow button
 * without clearing the following slide surface. Keep the compatibility repair
 * inside the affected renderer's open shadow root so no application layout or
 * unrelated viewer is affected. If upstream clears the float, this is a no-op.
 */
export interface PresentationLayoutCompatibility {
  refresh: () => void;
  dispose: () => void;
}

export function installPresentationLayoutCompatibility(host: HTMLElement): PresentationLayoutCompatibility {
  let disposed = false;
  let discoveryTimer = 0;
  let discoveryStop = 0;

  const stopDiscovery = () => {
    window.clearInterval(discoveryTimer);
    window.clearTimeout(discoveryStop);
    discoveryTimer = 0;
    discoveryStop = 0;
  };

  const apply = (): boolean => {
    if (disposed) return true;
    // FileViewer attaches its owned open root to one direct React child. The
    // Agentlas toolbar is a sibling, so inspect only direct children rather
    // than walking the full document for large files.
    const viewerHost = Array.from(host.children).find((child) => child instanceof HTMLElement && child.shadowRoot);
    const root = viewerHost instanceof HTMLElement ? viewerHost.shadowRoot : null;
    const shell = root?.querySelector<HTMLElement>(".pptx-viewer-shell");
    const slideshowButton = shell?.querySelector<HTMLElement>(".pptx-slideshow-button");
    const slideSurface = shell?.querySelector<HTMLElement>(".pptx-render-surface");
    if (!root || !slideshowButton || !slideSurface) return false;
    if (root.querySelector("style[data-agentlas-pptx-float-fix]")) return true;
    if (getComputedStyle(slideshowButton).float === "none" || getComputedStyle(slideSurface).clear === "both") return true;

    const style = document.createElement("style");
    style.dataset.agentlasPptxFloatFix = "true";
    style.textContent = PPTX_FLOAT_CLEAR_STYLE;
    root.appendChild(style);
    return true;
  };

  const refresh = () => {
    if (apply()) stopDiscovery();
  };

  if (!apply()) {
    // Attaching a shadow root does not emit a mutation in its parent tree.
    discoveryTimer = window.setInterval(() => {
      refresh();
    }, 100);
    discoveryStop = window.setTimeout(stopDiscovery, 10_000);
  }
  return {
    refresh,
    dispose: () => {
      disposed = true;
      stopDiscovery();
    },
  };
}
