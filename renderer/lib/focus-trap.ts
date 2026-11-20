/** Focusable, visible, enabled descendants of `root` in DOM order (a `tabindex="-1"` element is not a Tab stop). */
export function tabStops(root: HTMLElement): HTMLElement[] {
  const selector = 'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (element.matches(":disabled") || element.getAttribute("tabindex") === "-1") return false;
    if (element.closest("[inert]") || element.getAttribute("aria-hidden") === "true") return false;
    return element.getClientRects().length > 0;
  });
}

/**
 * keep Tab / Shift+Tab inside a dialog root. Returns true when it handled the key (the caller returns).
 * The root itself (tabindex -1, where focus lands when nothing else was focused) counts as "before the first stop".
 */
export function trapTabWithin(event: { key: string; shiftKey: boolean; preventDefault: () => void }, root: HTMLElement): boolean {
  if (event.key !== "Tab") return false;
  const stops = tabStops(root);
  if (stops.length === 0) { event.preventDefault(); root.focus({ preventScroll: true }); return true; }
  const first = stops[0], last = stops[stops.length - 1], active = document.activeElement;
  if (!active || !root.contains(active) || active === root) { event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true }); return true; }
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus({ preventScroll: true }); return true; }
  if (!event.shiftKey && active === last) { event.preventDefault(); first.focus({ preventScroll: true }); return true; }
  return false;
}

/** Where focus was before a dialog took it; `restore()` puts it back only if focus is still inside the dialog (or lost to the body). */
export function rememberFocus(root: HTMLElement | null): { restore: () => void } {
  const prior = document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !(root?.contains(document.activeElement)) ? document.activeElement : null;
  return {
    restore: () => {
      if (!prior || !document.contains(prior)) return;
      const active = document.activeElement;
      if (!active || active === document.body || (root !== null && root.contains(active))) prior.focus({ preventScroll: true });
    },
  };
}
