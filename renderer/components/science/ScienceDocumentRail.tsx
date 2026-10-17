"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ScienceDocumentBridge, ScienceDocumentPanelState } from "@shared/science-document-panel";
import type { SciencePreviewBridge, SciencePreviewPanelState } from "@shared/science-preview-panel";
import { IconClose, IconFileText, IconLayers } from "@/components/Icon";
import { LiveDocumentRailPanel, useLiveDocuments } from "@/components/live-document/LiveDocumentRailPanel";
import { SciencePreviewPane } from "./SciencePreviewPane";
import styles from "./ScienceDocumentRail.module.css";

declare global {
  interface Window {
    agentlasScienceDocument?: ScienceDocumentBridge;
    agentlasSciencePreview?: SciencePreviewBridge;
  }
}

/*
 * The Document tab of the Science screen. Science itself is a native view that fills the page's surface; this is the
 * page-owned column to its right (the surface shrinks when it opens, the same way the approval sheet reserves room),
 * so it can be the very same panel Work's right rail shows: the AI's document_* edits in a Science turn and the
 * owner's edits meet in one journal, owned by the Science runtime chat of the conversation Science is showing.
 *
 * Edits here change the office file only. A Science manuscript's source of truth is its Markdown and bindings; the
 * exported docx/hwpx is derived from it, so nothing typed here flows back, and the panel says so.
 *
 * The column has a second tab, Preview: the Universal File Viewer (read-only, faithful docx/pdf/spreadsheet pages) for
 * bytes the Science view hands to Main with `shell.previewFile` (electron/science-host/preview-panel.ts). It exists
 * only while something is open there, and it does not need a conversation, so it works where the Document tab is idle.
 */

const OPEN_KEY = "agentlas.science.documentRail.open.v1";
const WIDTH_KEY = "agentlas.science.documentRail.width.v1";
const MIN_WIDTH = 340;
const MAX_WIDTH = 820;
const DEFAULT_WIDTH = 480;
/** Science keeps at least this much of the screen, whatever the panel's remembered width. */
const SCIENCE_MIN_WIDTH = 560;
const TAB_WIDTH = 36;

const OPEN_REASONS: Record<string, [string, string]> = {
  export_unknown: ["이 내보내기는 더 이상 열 수 없습니다. 다시 내보내 주세요.", "This export can no longer be opened. Export it again."],
  file_missing: ["내보낸 파일을 찾지 못했습니다. 옮기거나 지웠다면 다시 내보내 주세요.", "The exported file is gone. If you moved or deleted it, export it again."],
  unsaved_session_exists: ["저장하지 않은 편집이 있는 같은 파일이 이미 열려 있습니다. 그 문서에서 먼저 정리하세요.", "The same file is already open with unsaved edits. Resolve that document first."],
  file_unreadable: ["이 파일을 읽지 못했습니다.", "This file could not be read."],
  format_unsupported: ["docx, hwpx 파일만 열 수 있습니다.", "Only docx and hwpx files open here."],
  file_too_large: ["파일이 너무 큽니다(60MB 이하).", "The file is too large (60 MB max)."],
};

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

export function ScienceDocumentRail({ locale }: { locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [state, setState] = useState<ScienceDocumentPanelState>({ context: null, offers: [] });
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<SciencePreviewPanelState>({ items: [] });
  const [tab, setTab] = useState<"document" | "preview">("document");
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const chatId = state.context?.chatId ?? null;
  const { sessions, refresh } = useLiveDocuments(chatId);

  useEffect(() => {
    setOpen(readStored(OPEN_KEY) === "1");
    const stored = Number(readStored(WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) setWidth(clampWidth(stored));
  }, []);

  useEffect(() => {
    const bridge = window.agentlasScienceDocument;
    if (!bridge) return;
    let alive = true;
    void bridge.state().then((next) => { if (alive && next) setState(next); }).catch(() => undefined);
    const off = bridge.onChanged((next) => { if (alive) setState(next); });
    return () => { alive = false; off(); };
  }, []);

  // A preview the Science view just handed over opens the column on the Preview tab, like a session the AI just opened
  // opens the Document tab; previews already there when this page mounts are listed but do not steal the screen.
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
    if (fresh.length) { setTab("preview"); setOpen(true); writeStored(OPEN_KEY, "1"); }
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

  // A session that appears while this conversation is shown (the AI opened a file, an export was opened) opens the tab
  // and focuses it, like Work's rail; sessions already there when the conversation is shown do not.
  const seen = useRef<{ chatId: string | null; ids: Set<string> | null }>({ chatId: null, ids: null });
  useEffect(() => {
    if (seen.current.chatId !== chatId) seen.current = { chatId, ids: null };
    const ids = sessions.map((session) => session.sessionId);
    if (seen.current.ids === null) { seen.current.ids = new Set(ids); return; }
    const fresh = ids.filter((id) => !seen.current.ids!.has(id));
    for (const id of ids) seen.current.ids.add(id);
    if (fresh.length) { setFocusSessionId(fresh[fresh.length - 1]); setOpenStored(true); }
  }, [chatId, sessions, setOpenStored]);

  const openOffer = async (token: string) => {
    const bridge = window.agentlasScienceDocument;
    if (!bridge || busyToken) return;
    setBusyToken(token);
    setNotice(null);
    try {
      const result = await bridge.openExport(token);
      if (result.ok) { setFocusSessionId(result.sessionId); setOpenStored(true); refresh(); }
      else {
        const pair = OPEN_REASONS[result.reason];
        setNotice(pair ? pair[ko ? 0 : 1] : (ko ? `열지 못했습니다 (${result.reason})` : `Could not open it (${result.reason})`));
        setOpenStored(true);
      }
    } finally { setBusyToken(null); }
  };

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

  const documentAvailable = Boolean(state.context && chatId);
  const previewAvailable = preview.items.length > 0;
  if (!documentAvailable && !previewAvailable) return null;
  const shownTab = tab === "preview" ? (previewAvailable ? "preview" : "document") : (documentAvailable ? "document" : "preview");
  const waiting = state.offers.length;
  const label = ko ? "문서" : "Document";
  const previewLabel = ko ? "미리보기" : "Preview";
  const count = (documentAvailable ? sessions.length + waiting : 0) + preview.items.length;

  if (!open) {
    const openLabel = documentAvailable ? (ko ? "문서 탭 열기" : "Open the Document tab") : (ko ? "미리보기 탭 열기" : "Open the Preview tab");
    return (
      <aside className={styles.tabRail} style={{ width: TAB_WIDTH }} data-science-document-rail="closed">
        <button type="button" className={styles.tabButton} onClick={() => { setTab(documentAvailable ? "document" : "preview"); setOpenStored(true); }}
          aria-label={openLabel} title={openLabel}>
          <IconFileText size={15} />
          <span className={styles.tabLabel}>{documentAvailable ? label : previewLabel}</span>
          {count > 0 && <span className={styles.badge} data-offer={documentAvailable && waiting > 0 ? "true" : "false"}>{count}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.rail} style={{ width: clampWidth(width) }} data-science-document-rail="open">
      <div className={styles.resizer} role="separator" aria-orientation="vertical" tabIndex={0}
        aria-label={ko ? "문서 탭 너비 조절" : "Resize the Document tab"} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={clampWidth(width)}
        onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} onKeyDown={onResizeKey} />
      <header className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label={ko ? "Science 오른쪽 패널" : "Science right panel"}>
          {documentAvailable && (
            <button type="button" role="tab" className={styles.tab} aria-selected={shownTab === "document"} data-active={shownTab === "document" ? "true" : "false"}
              data-science-rail-tab="document" onClick={() => setTab("document")}><IconFileText size={13} />{label}</button>
          )}
          {previewAvailable && (
            <button type="button" role="tab" className={styles.tab} aria-selected={shownTab === "preview"} data-active={shownTab === "preview" ? "true" : "false"}
              data-science-rail-tab="preview" onClick={() => setTab("preview")}><IconLayers size={13} />{previewLabel}</button>
          )}
        </div>
        <button type="button" className={styles.close} onClick={() => setOpenStored(false)} aria-label={ko ? "패널 닫기" : "Close the panel"} title={ko ? "닫기" : "Close"}><IconClose size={13} /></button>
      </header>
      {/* Both bodies stay mounted: switching tabs must not drop an open document's cursor, history or a preview's page. */}
      {documentAvailable && (
        <div className={styles.pane} hidden={shownTab !== "document"} data-science-rail-pane="document">
          <p className={styles.note} data-science-document-note="true">
            {ko
              ? "여기서 고친 내용은 이 파일에만 반영됩니다. Science의 원고(마크다운 원본)는 바뀌지 않으며, 다시 내보내면 파일이 새로 만들어집니다."
              : "Edits here change this file only. The manuscript in Science (its Markdown source) is not updated; exporting again builds a new file."}
          </p>
          {state.offers.map((offer) => (
            <div key={offer.token} className={styles.offer} data-science-document-offer="true">
              <span className={styles.offerText}><strong>{offer.name}</strong>{ko ? " 내보내기를 마쳤습니다" : " was exported"}</span>
              <button type="button" className={styles.offerOpen} disabled={busyToken !== null} onClick={() => void openOffer(offer.token)}>
                {ko ? "문서 탭에서 열기" : "Open in the Document tab"}
              </button>
              <button type="button" className={styles.offerDismiss} onClick={() => void window.agentlasScienceDocument?.dismissExport(offer.token)}
                aria-label={ko ? "닫기" : "Dismiss"} title={ko ? "닫기" : "Dismiss"}><IconClose size={11} /></button>
            </div>
          ))}
          {notice && <p className={styles.notice} role="status">{notice}</p>}
          <div className={styles.body}>
            <LiveDocumentRailPanel chatId={chatId} locale={locale} focusSessionId={focusSessionId} />
          </div>
        </div>
      )}
      {previewAvailable && (
        <div className={styles.pane} hidden={shownTab !== "preview"} data-science-rail-pane="preview">
          <SciencePreviewPane items={preview.items} activeToken={previewToken} locale={locale}
            onSelect={setPreviewToken} onClose={(token) => void window.agentlasSciencePreview?.close(token)} />
        </div>
      )}
    </aside>
  );
}
