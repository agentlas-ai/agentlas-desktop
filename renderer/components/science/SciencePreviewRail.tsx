"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { SciencePreviewBridge, SciencePreviewPanelState } from "@shared/science-preview-panel";
import { IconClose, IconLayers } from "@/components/Icon";
import { SciencePreviewPane } from "./SciencePreviewPane";
import styles from "./SciencePreviewRail.module.css";

declare global {
  interface Window {
    agentlasSciencePreview?: SciencePreviewBridge;
  }
}

/*
 * Science's right panel. Science itself is a native view that fills the page's surface, so the panel is the page-owned
 * column to its right (the surface shrinks when it opens, the same way the approval sheet reserves room). It holds the
 * Preview: the Universal File Viewer (read-only, faithful docx/pdf/spreadsheet pages) for bytes the Science view hands to
 * Main with `shell.previewFile` (electron/science-host/preview-panel.ts). The column exists only while something is open
 * in it and needs no conversation. A host without that method never shows it.
 */

const OPEN_KEY = "agentlas.science.previewRail.open.v1";
const WIDTH_KEY = "agentlas.science.previewRail.width.v1";
const MIN_WIDTH = 340;
const MAX_WIDTH = 820;
const DEFAULT_WIDTH = 480;
/** Science keeps at least this much of the screen, whatever the panel's remembered width. */
const SCIENCE_MIN_WIDTH = 560;
const TAB_WIDTH = 36;

function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* a private profile may refuse storage */ }
}
function clampWidth(value: number): number {
  const room = typeof window === "undefined" ? MAX_WIDTH : Math.max(MIN_WIDTH, window.innerWidth - SCIENCE_MIN_WIDTH);
  return Math.round(Math.min(MAX_WIDTH, room, Math.max(MIN_WIDTH, value)));
}

export function SciencePreviewRail({ locale }: { locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [preview, setPreview] = useState<SciencePreviewPanelState>({ items: [] });
  const [previewToken, setPreviewToken] = useState<string | null>(null);

  useEffect(() => {
    setOpen(readStored(OPEN_KEY) === "1");
    const stored = Number(readStored(WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) setWidth(clampWidth(stored));
  }, []);

  // A preview the Science view just handed over opens the column; previews already there when this page mounts are
  // listed but do not steal the screen.
  const previewSeen = useRef<Set<string> | null>(null);
  const applyPreview = useCallback((next: SciencePreviewPanelState, announce: boolean) => {
    setPreview(next);
    const tokens = next.items.map((item) => item.token);
    const known = previewSeen.current;
    const fresh = known === null || !announce ? [] : tokens.filter((token) => !known.has(token));
    previewSeen.current = new Set(tokens);
    setPreviewToken((current) => {
      if (fresh.length) return fresh[fresh.length - 1];
      if (current && tokens.includes(current)) return current;
      return tokens[tokens.length - 1] ?? null;
    });
    if (fresh.length) { setOpen(true); writeStored(OPEN_KEY, "1"); }
  }, []);
  useEffect(() => {
    const bridge = window.agentlasSciencePreview;
    if (!bridge) return;
    let alive = true;
    void bridge.state().then((next) => { if (alive && next) applyPreview(next, false); }).catch(() => undefined);
    const off = bridge.onChanged((next) => { if (alive) applyPreview(next, true); });
    return () => { alive = false; off(); };
  }, [applyPreview]);

  const setOpenStored = useCallback((next: boolean) => {
    setOpen(next);
    writeStored(OPEN_KEY, next ? "1" : "0");
  }, []);

  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clampWidth(drag.current.startWidth + (drag.current.startX - event.clientX)));
  };
  const onResizeUp = () => {
    if (!drag.current) return;
    drag.current = null;
    writeStored(WIDTH_KEY, String(width));
  };
  const onResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 80 : 24;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = clampWidth(width + (event.key === "ArrowLeft" ? step : -step));
    setWidth(next);
    writeStored(WIDTH_KEY, String(next));
  };

  if (preview.items.length === 0) return null;
  const label = ko ? "미리보기" : "Preview";

  if (!open) {
    const openLabel = ko ? "미리보기 열기" : "Open the Preview";
    return (
      <aside className={styles.tabRail} style={{ width: TAB_WIDTH }} data-science-preview-rail="closed">
        <button type="button" className={styles.tabButton} onClick={() => setOpenStored(true)} aria-label={openLabel} title={openLabel}>
          <IconLayers size={15} />
          <span className={styles.tabLabel}>{label}</span>
          <span className={styles.badge}>{preview.items.length}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.rail} style={{ width: clampWidth(width) }} data-science-preview-rail="open">
      <div className={styles.resizer} role="separator" aria-orientation="vertical" tabIndex={0}
        aria-label={ko ? "미리보기 너비 조절" : "Resize the Preview"} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={clampWidth(width)}
        onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} onKeyDown={onResizeKey} />
      <header className={styles.header}>
        <span className={styles.tab} role="tab" aria-selected="true"><IconLayers size={13} />{label}</span>
        <button type="button" className={styles.close} onClick={() => setOpenStored(false)} aria-label={ko ? "미리보기 닫기" : "Close the Preview"} title={ko ? "닫기" : "Close"}><IconClose size={13} /></button>
      </header>
      <div className={styles.body} data-science-preview-rail-body="true">
        <SciencePreviewPane items={preview.items} activeToken={previewToken} locale={locale}
          onSelect={setPreviewToken} onClose={(token) => void window.agentlasSciencePreview?.close(token)} />
      </div>
    </aside>
  );
}
