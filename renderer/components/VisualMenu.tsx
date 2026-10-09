"use client";

import { useEffect, useRef, useState } from "react";
import { IconCopy, IconDownload, IconMoreHorizontal, IconPanelRight } from "./Icon";
import styles from "./VisualBlock.module.css";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";

export type VisualMenuItem = { key: string; label: string; run: () => Promise<boolean | void> | boolean | void };

/**
 * 차트·시각물 오른쪽 위 "⋯" — Claude 위젯과 같은 자리(레퍼런스 f003: Copy to clipboard / Download file).
 * 올려놓거나 초점이 오면 보이고, 누르면 작은 메뉴. 결과(복사됨·실패)는 단추 옆 한 줄로 알린다.
 */
export function VisualMenu({ items, ko, label }: { items: VisualMenuItem[]; ko: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({open, roots: [rootRef], onDismiss: () => setOpen(false), restoreFocusRef: triggerRef});
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  useEffect(() => {
    if (!status) return undefined;
    const timer = window.setTimeout(() => setStatus(null), 1800);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <div ref={rootRef} className={styles.menuRoot} data-open={open ? "true" : "false"} data-visual-menu="true">
    {status && <span className={styles.menuStatus} role="status">{status}</span>}
    <button ref={triggerRef} type="button" className={styles.menuButton} aria-haspopup="menu" aria-expanded={open} aria-label={label}
      onClick={() => setOpen((value) => !value)} data-visual-menu-button="true">
      <IconMoreHorizontal size={16} />
    </button>
    {open && <div ref={menuRef} className={styles.menu} role="menu" aria-label={label} onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % items.length
        : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
      if (next !== null) { event.preventDefault(); items[next]?.focus(); }
    }}>
      {items.map((item) => (
        <button key={item.key} type="button" role="menuitem" data-visual-menu-item={item.key}
          onClick={async () => {
            setOpen(false);
            const result = await item.run();
            if (item.key === "copy") setStatus(result === false ? (ko ? "복사하지 못했어요" : "Could not copy") : (ko ? "복사했어요" : "Copied"));
          }}>
          <span className={styles.menuIcon} aria-hidden="true">
            {item.key === "copy" ? <IconCopy size={14} /> : item.key.startsWith("download") ? <IconDownload size={14} /> : <IconPanelRight size={14} />}
          </span>
          {item.label}
        </button>
      ))}
    </div>}
  </div>;
}
