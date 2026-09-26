"use client";

// Small dropdown for the mailbox, built from the One composer popover parts
// (same classes, same tokens) so it looks like the One (+) and model menus.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck } from "@/components/Icon";
import shell from "../OneShell.module.css";

export interface OneMailMenuItem {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function OneMailMenu({
  anchor,
  items,
  label,
  onClose,
  width = 240,
}: {
  anchor: HTMLElement | null;
  items: OneMailMenuItem[];
  label: string;
  onClose: () => void;
  width?: number;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const menuWidth = Math.min(width, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
      const top = rect.bottom + 6;
      setPosition({ left, top, maxHeight: Math.max(120, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, width]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchor?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchor?.contains(target))) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    if (!position) return;
    const first = panelRef.current?.querySelector<HTMLButtonElement>('button[data-selected="true"]:not([disabled])')
      ?? panelRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();
  }, [position]);

  if (!anchor || !position || typeof document === "undefined") return null;
  return createPortal(
    <section
      ref={panelRef}
      className={shell.composerPopover}
      role="menu"
      aria-label={label}
      data-one-mail-menu
      style={{ left: position.left, top: position.top, bottom: "auto", width: Math.min(width, window.innerWidth - 16), maxHeight: position.maxHeight, padding: 6 }}
    >
      <div className={shell.composerPopoverList}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={shell.composerPopoverRow}
            data-selected={item.selected ? "true" : undefined}
            data-danger={item.danger ? "true" : undefined}
            disabled={item.disabled}
            onClick={() => { item.onSelect(); onClose(); }}
          >
            <span className={shell.composerPopoverIcon} aria-hidden="true">{item.icon ?? null}</span>
            <span className={shell.composerPopoverCopy}>
              <strong style={item.danger ? { color: "var(--danger)" } : undefined}>{item.label}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </span>
            <span className={shell.composerPopoverIcon} aria-hidden="true">{item.selected ? <IconCheck size={13} /> : null}</span>
          </button>
        ))}
      </div>
    </section>,
    document.body,
  );
}
