"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronLeft, IconChevronRight, IconClose } from "../Icon";
import type { MediaStripItem } from "./MediaStrip";
import styles from "./MediaStrip.module.css";

/**
 * One picture or video at a time over the app: ←/→ keys, the arrow buttons, a horizontal swipe or
 * trackpad swipe move between the items, Esc or × closes, focus returns to the tile that opened it.
 */
export function MediaViewer({ items, start, locale, onClose }: {
  items: readonly MediaStripItem[];
  start: number;
  locale: "ko" | "en";
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(items.length - 1, start)));
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const wheel = useRef({ dx: 0, at: 0 });
  const item = items[index];
  const go = useCallback((delta: number) => {
    setIndex((current) => Math.max(0, Math.min(items.length - 1, current + delta)));
  }, [items.length]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); go(-1); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); go(1); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); opener?.focus?.({ preventScroll: true }); };
  }, [go, onClose]);

  useEffect(() => { if (index >= items.length) setIndex(Math.max(0, items.length - 1)); }, [index, items.length]);

  if (!item) return null;
  const ko = locale === "ko";
  return createPortal(
    <div
      className={styles.viewer}
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      data-media-viewer="true"
      data-media-viewer-index={index}
      onPointerDown={(event) => { swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId }; }}
      onPointerUp={(event) => {
        const begun = swipe.current;
        swipe.current = null;
        if (!begun || begun.id !== event.pointerId) return;
        const dx = event.clientX - begun.x, dy = event.clientY - begun.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
      }}
      onWheel={(event) => {
        if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
        const now = Date.now();
        if (now - wheel.current.at > 400) wheel.current.dx = 0;
        wheel.current.at = now;
        wheel.current.dx += event.deltaX;
        if (Math.abs(wheel.current.dx) > 90) { go(wheel.current.dx > 0 ? 1 : -1); wheel.current.dx = 0; wheel.current.at = now + 350; }
      }}
    >
      <div className={styles.viewerBar}>
        <span className={styles.viewerTitle}>{item.name}</span>
        <span className={styles.viewerCount}>{index + 1} / {items.length}</span>
        <button ref={closeRef} type="button" className={styles.viewerClose} aria-label={ko ? "닫기" : "Close"} onClick={onClose}>
          <IconClose size={20} />
        </button>
      </div>
      <div className={styles.viewerStage} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        {item.kind === "video" && item.src ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video key={item.key} className={styles.viewerVideo} src={item.src} poster={item.thumbSrc} controls autoPlay playsInline preload="metadata" />
        ) : item.kind === "image" && item.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={item.key} className={styles.viewerImage} src={item.src} alt={item.name} draggable={false} />
        ) : (
          <div className={styles.viewerFile}>
            <span>{item.name}</span>
            {item.meta && <span style={{ opacity: .7 }}>{item.meta}</span>}
            {item.onOpenFile && <button type="button" onClick={item.onOpenFile}>{ko ? "열기" : "Open"}</button>}
          </div>
        )}
        <button type="button" className={styles.viewerNav} data-dir="prev" aria-label={ko ? "이전" : "Previous"} disabled={index === 0} onClick={() => go(-1)}>
          <IconChevronLeft size={22} />
        </button>
        <button type="button" className={styles.viewerNav} data-dir="next" aria-label={ko ? "다음" : "Next"} disabled={index >= items.length - 1} onClick={() => go(1)}>
          <IconChevronRight size={22} />
        </button>
      </div>
      <div className={styles.viewerDots} aria-hidden="true">
        {items.length <= 30 && items.map((entry, position) => <span key={entry.key} className={styles.viewerDot} data-active={position === index ? "true" : "false"} />)}
      </div>
    </div>,
    document.body,
  );
}
