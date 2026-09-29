"use client";

import { useEffect, useRef, useState } from "react";
import { IconCopy, IconDownload, IconMoreHorizontal, IconPanelRight } from "./Icon";
import styles from "./VisualBlock.module.css";

export type VisualMenuItem = { key: string; label: string; run: () => Promise<boolean | void> | boolean | void };

/**
 * 차트·시각물 오른쪽 위 "⋯" — Claude 위젯과 같은 자리(레퍼런스 f003: Copy to clipboard / Download file).
 * 올려놓거나 초점이 오면 보이고, 누르면 작은 메뉴. 결과(복사됨·실패)는 단추 옆 한 줄로 알린다.
 */
export function VisualMenu({ items, ko, label }: { items: VisualMenuItem[]; ko: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => {
    if (!status) return undefined;
    const timer = window.setTimeout(() => setStatus(null), 1800);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <div ref={rootRef} className={styles.menuRoot} data-open={open ? "true" : "false"} data-visual-menu="true">
    {status && <span className={styles.menuStatus} role="status">{status}</span>}
    <button type="button" className={styles.menuButton} aria-haspopup="menu" aria-expanded={open} aria-label={label}
      onClick={() => setOpen((value) => !value)} data-visual-menu-button="true">
      <IconMoreHorizontal size={16} />
    </button>
    {open && <div className={styles.menu} role="menu">
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
