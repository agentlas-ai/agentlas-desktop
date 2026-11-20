"use client";

import { useEffect, useRef, type RefObject } from "react";

export interface WorkspaceDialogOptions {
  /** Move focus to the first control when the dialog opens with focus outside it. Default true. */
  autoFocus?: boolean;
  /** Where focus goes on close when the control that opened the dialog is gone (a menu item that closed with its menu). */
  returnFocus?: () => HTMLElement | null;
}

/** One rule for every dialog that is not built on the shared modal sheet: Tab stays inside, Esc closes, focus goes back where it came from. */
export function useWorkspaceDialog(open: boolean, root: RefObject<HTMLElement>, onClose: () => void, options?: WorkspaceDialogOptions) {
  const close = useRef(onClose);
  close.current = onClose;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!open) return;
    const dialog = root.current?.matches('[role="dialog"]') ? root.current : root.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const active = document.activeElement;
    const previous = active instanceof HTMLElement && active !== document.body ? active : null;
    const targets = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],textarea:not([disabled]),summary,[tabindex="0"]')].filter((element) => element.offsetParent !== null);
    if (optionsRef.current?.autoFocus !== false && !dialog.contains(document.activeElement)) targets()[0]?.focus();
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
    return () => {
      document.removeEventListener("keydown", key);
      // Only a focus the close left nowhere (or still inside the dialog) goes back; one the person already moved to a link or a field stays.
      const now = document.activeElement;
      if (now instanceof HTMLElement && now !== document.body && !dialog.contains(now)) return;
      const back = previous?.isConnected ? previous : optionsRef.current?.returnFocus?.() ?? null;
      if (back?.isConnected && !dialog.contains(back)) back.focus();
    };
  }, [open, root]);
}
