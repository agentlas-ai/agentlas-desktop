"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared Desktop popover contract.
 *
 * A layer stays open only while interaction remains inside one of its owned
 * roots. Pointer interaction elsewhere and an unmodified Escape dismiss it;
 * Escape restores focus to the trigger for keyboard continuity.
 */
export function useDismissibleLayer({
  open,
  roots,
  onDismiss,
  restoreFocusRef,
  dismissOnScroll = false,
  dismissOnWindowBlur = false,
}: {
  open: boolean;
  roots: Array<RefObject<HTMLElement | null>>;
  onDismiss: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  dismissOnScroll?: boolean;
  dismissOnWindowBlur?: boolean;
}) {
  const rootsRef = useRef(roots);
  const dismissRef = useRef(onDismiss);
  rootsRef.current = roots;
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const dismiss = () => dismissRef.current();
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (rootsRef.current.some((ref) => ref.current && path.includes(ref.current))) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      window.requestAnimationFrame(() => restoreFocusRef?.current?.focus());
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    if (dismissOnScroll) window.addEventListener("scroll", dismiss, true);
    if (dismissOnWindowBlur) window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      if (dismissOnScroll) window.removeEventListener("scroll", dismiss, true);
      if (dismissOnWindowBlur) window.removeEventListener("blur", dismiss);
    };
  }, [dismissOnScroll, dismissOnWindowBlur, open, restoreFocusRef]);
}
