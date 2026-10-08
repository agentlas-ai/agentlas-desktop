"use client";

import { useEffect, useRef, type RefObject } from "react";

export function useWorkspaceDialog(open: boolean, root: RefObject<HTMLElement>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const dialog = root.current?.matches('[role="dialog"]') ? root.current : root.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const targets = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],textarea:not([disabled]),[tabindex="0"]')].filter((element) => element.offsetParent !== null);
    if (!dialog.contains(document.activeElement)) targets()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab") return;
      const controls = targets();
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) return;
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected && !dialog.contains(previous)) previous.focus(); };
  }, [open, root]);
}
