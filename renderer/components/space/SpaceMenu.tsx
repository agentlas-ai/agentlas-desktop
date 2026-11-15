"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Space.module.css";

export interface SpaceMenuItem { id: string; label: string; onSelect: () => void; disabled?: boolean; /** A thin line above the item (groups of the list menu). */ dividerBefore?: boolean; /** The item takes the danger colour (Delete). */ danger?: boolean; /** A 15px line icon before the label (workspace-v2-pop-sidebar). */ icon?: ReactNode; /** A small mark at the right end of the row (the room lead's "lead"). */ badge?: string }

/**
 * A small menu at a point: the keyboard / right-click way to do what a drag does. Arrow keys move, Enter picks,
 * Escape closes and hands the focus back to where it came from. It is drawn on the body so a scrolling list cannot clip it.
 */
export function SpaceMenu({ x, y, label, items, onClose, returnFocus }: {
  x: number; y: number; label: string; items: readonly SpaceMenuItem[]; onClose: () => void; returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setAt({ left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", onClose);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("blur", onClose); };
  }, [onClose]);
  const close = () => { onClose(); returnFocus?.focus?.(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); buttons[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); buttons.at(-1)?.focus(); }
  };
  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} className={styles.menu} role="menu" aria-label={label} style={{ left: at.left, top: at.top }} onKeyDown={onKeyDown} data-space-menu="true">
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" disabled={item.disabled} data-space-menu-item={item.id}
          data-divider={item.dividerBefore ? "true" : undefined} data-danger={item.danger ? "true" : undefined}
          onClick={() => { onClose(); item.onSelect(); }}>{item.icon ? <span className={styles.menuIcon} aria-hidden="true">{item.icon}</span> : null}{item.label}{item.badge ? <span aria-hidden="true" style={{ marginLeft: "auto", paddingLeft: 12, flex: "none" }}><span style={{ border: "1px solid var(--rd-hair-2, #ccc)", borderRadius: 99, padding: "1px 8px", fontSize: 11, color: "var(--rd-ink-2, #555)" }}>{item.badge}</span></span> : null}</button>
      ))}
    </div>,
    document.body,
  );
}
