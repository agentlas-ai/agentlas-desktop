"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared Desktop popover contract.
 *
 * A layer stays open only while interaction remains inside one of its owned
 * roots. Pointer interaction elsewhere and an unmodified Escape dismiss it;
 * Escape restores focus to the trigger for keyboard continuity. A menu opts
 * into `dismissOnFocusLeave` so that Tab out of it closes it as well.
 */
export function useDismissibleLayer({
  open,
  roots,
  onDismiss,
  restoreFocusRef,
  dismissOnScroll = false,
  dismissOnWindowBlur = false,
  dismissOnFocusLeave = false,
}: {
  open: boolean;
  roots: Array<RefObject<HTMLElement | null>>;
  onDismiss: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  dismissOnScroll?: boolean;
  dismissOnWindowBlur?: boolean;
  /** Keyboard focus moving to anything outside the roots closes the layer (a menu left open over the page after Tab). */
  dismissOnFocusLeave?: boolean;
}) {
  const rootsRef = useRef(roots);
  const dismissRef = useRef(onDismiss);
  rootsRef.current = roots;
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const coveredByModal = () => {
      if (document.querySelector('[data-popup-host="true"]')) return true;
      const mountedRoots = rootsRef.current.flatMap(ref => ref.current ? [ref.current] : []);
      return mountedRoots.length > 0 && mountedRoots.every(root => root.closest("[inert]"));
    };
    const dismiss = () => { if (!coveredByModal()) dismissRef.current(); };
    const onPointerDown = (event: PointerEvent) => {
      if (coveredByModal()) return;
      const path = event.composedPath();
      if (rootsRef.current.some((ref) => ref.current && path.includes(ref.current))) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (coveredByModal()) return;
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      window.requestAnimationFrame(() => restoreFocusRef?.current?.focus());
    };

    const onFocusIn = (event: FocusEvent) => {
      if (coveredByModal()) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootsRef.current.some((ref) => ref.current?.contains(target))) return;
      dismiss();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    if (dismissOnFocusLeave) document.addEventListener("focusin", onFocusIn, true);
    if (dismissOnScroll) window.addEventListener("scroll", dismiss, true);
    if (dismissOnWindowBlur) window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      if (dismissOnFocusLeave) document.removeEventListener("focusin", onFocusIn, true);
      if (dismissOnScroll) window.removeEventListener("scroll", dismiss, true);
      if (dismissOnWindowBlur) window.removeEventListener("blur", dismiss);
    };
  }, [dismissOnFocusLeave, dismissOnScroll, dismissOnWindowBlur, open, restoreFocusRef]);
}
