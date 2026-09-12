"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserAnnotationReceipt, BrowserAnnotationSelection, BrowserAnnotationSession, BrowserAnnotationTarget } from "@shared/browser-annotation";
import menu from "@/components/PanelPopover.module.css";
import styles from "./BrowserAnnotation.module.css";

type Bounds = { x: number; y: number; width: number; height: number };
export function BrowserAnnotation({ target, ko, onPrepareOverlay, onOverlayClosed, onComment, getViewportBounds }: {
  target: BrowserAnnotationTarget | null;
  ko: boolean;
  onPrepareOverlay: () => Promise<void>;
  onOverlayClosed: () => void;
  onComment: (receipt: BrowserAnnotationReceipt) => boolean | Promise<boolean>;
  getViewportBounds?: () => Bounds | null;
}) {
  const [session, setSession] = useState<BrowserAnnotationSession | null>(null);
  const [selection, setSelection] = useState<BrowserAnnotationSelection | null>(null);
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 24, top: 80 });
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const active = useRef<BrowserAnnotationSession | null>(null);
  const epoch = useRef(0);
  const opening = useRef(false);
  const commentRef = useRef(comment); commentRef.current = comment;
  const draftScope = useRef<string | null>(null);
  const drafts = useRef(new Map<string, string>());
  const callbacks = useRef({ onPrepareOverlay, onOverlayClosed, onComment, getViewportBounds });
  callbacks.current = { onPrepareOverlay, onOverlayClosed, onComment, getViewportBounds };
  const stop = useCallback(() => {
    const previous = active.current;
    epoch.current++; active.current = null; opening.current = false;
    setSession(null); setSelection(null); setOpen(false); setBusy(false);
    callbacks.current.onOverlayClosed();
    if (previous) void window.agentlas?.browserAnnotation.stop(previous).catch(() => {});
  }, []);
  useEffect(() => {
    const key = target ? `${target.taskScopeId}:${target.viewId}` : null;
    if (draftScope.current !== key) {
      if (draftScope.current) drafts.current.set(draftScope.current, commentRef.current);
      if (drafts.current.size > 32) drafts.current.delete(drafts.current.keys().next().value!);
      setComment(key ? drafts.current.get(key) ?? "" : "");
      draftScope.current = key;
    }
    stop();
  }, [target?.taskScopeId, target?.viewId, stop]);
  useEffect(() => () => { const previous = active.current; epoch.current++; active.current = null; if (previous) void window.agentlas?.browserAnnotation.stop(previous).catch(() => {}); callbacks.current.onOverlayClosed(); }, []);
  useEffect(() => {
    if (!session || open) return;
    let disposed = false, pending = false;
    const poll = async () => {
      if (pending || opening.current) return;
      pending = true;
      try {
        const result = await window.agentlas.browserAnnotation.selection(session);
        if (disposed || active.current?.sessionId !== session.sessionId) return;
        if (!result.ok) {
          stop();
          setNotice(result.reason === "annotation_cross_frame_unsupported" || result.reason === "annotation_shadow_frame_unsupported"
            ? ko ? "이 프레임의 요소 선택은 아직 지원하지 않습니다." : "Element selection in this frame is not supported."
            : ko ? "페이지가 바뀌었거나 선택이 끝났습니다. 다시 선택해 주세요." : "The page or selection changed. Select an element again.");
          return;
        }
        if (!result.selection) return;
        opening.current = true;
        const generation = epoch.current;
        const bounds = callbacks.current.getViewportBounds?.();
        const anchor = button.current?.getBoundingClientRect();
        const scale = result.selection.viewportScale ?? 1;
        const x = bounds ? bounds.x + result.selection.element.rect.x * scale : anchor?.left ?? 24;
        const y = bounds ? bounds.y + (result.selection.element.rect.y + result.selection.element.rect.height) * scale + 8 : (anchor?.bottom ?? 72) + 8;
        setPosition({ left: Math.max(12, Math.min(x, window.innerWidth - 286)), top: Math.max(12, Math.min(y, window.innerHeight - 188)) });
        await callbacks.current.onPrepareOverlay();
        if (disposed || epoch.current !== generation || active.current?.sessionId !== session.sessionId) { if (!active.current) callbacks.current.onOverlayClosed(); return; }
        setSelection(result.selection); setOpen(true);
      } catch { if (!disposed) { stop(); setNotice(ko ? "요소 선택에 연결하지 못했습니다." : "Could not connect element selection."); } }
      finally { pending = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 160);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [session, open, ko, stop]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    let waiting = false;
    const finish = () => { if (!waiting) return; waiting = false; stop(); button.current?.focus(); };
    const outside = (event: PointerEvent) => {
      if (popover.current?.contains(event.target as Node) || button.current?.contains(event.target as Node)) return;
      // Keep the native guest hidden until the pointer is released, so dismissal
      // cannot activate the page beneath the frozen screenshot.
      event.preventDefault(); event.stopPropagation(); waiting = true;
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("pointerup", finish, true); document.removeEventListener("pointercancel", finish, true); };
  }, [open, stop]);
  const start = async () => {
    if (active.current) { stop(); return; }
    if (!target || busy) return;
    const generation = ++epoch.current; setBusy(true); setNotice(null);
    try {
      const result = await window.agentlas.browserAnnotation.start(target);
      if (epoch.current !== generation) { if (result.ok) void window.agentlas.browserAnnotation.stop(result.session); return; }
      if (!result.ok) { setNotice(ko ? "페이지를 연 뒤 요소를 선택해 주세요." : "Open the page before selecting an element."); return; }
      active.current = result.session; setSession(result.session);
    } catch { setNotice(ko ? "요소 선택에 연결하지 못했습니다." : "Could not connect element selection."); }
    finally { if (epoch.current === generation) setBusy(false); }
  };
  const submit = async () => {
    if (!selection || !comment.trim() || busy) return;
    const generation = epoch.current; setBusy(true); setNotice(null);
    try {
      const result = await window.agentlas.browserAnnotation.comment({ ...selection, comment });
      if (generation !== epoch.current) return;
      if (!result.ok) { setNotice(ko ? "선택이 바뀌었습니다. 내용을 보관한 채 다시 선택해 주세요." : "The selection changed. Your comment is preserved; select again."); return; }
      const accepted = await callbacks.current.onComment(result.receipt);
      if (generation !== epoch.current) return;
      if (!accepted) { setNotice(ko ? "원래 대화의 입력창에 추가하지 못했습니다. 다시 시도해 주세요." : "Could not add this to the original conversation. Try again."); return; }
      setComment(""); stop(); button.current?.focus();
    } catch { if (generation === epoch.current) setNotice(ko ? "추가하지 못했습니다. 입력 내용은 보관했습니다." : "Could not add the comment. Your text is preserved."); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  return <span className={styles.root}>
    <button ref={button} type="button" className={styles.button} disabled={!target || busy} aria-pressed={!!session}
      aria-label={ko ? "페이지 요소에 주석 달기" : "Annotate a page element"} title={ko ? "페이지 요소에 주석 달기" : "Annotate a page element"} onClick={() => void start()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 3v16l4.5-4.5 3 6 3-1.5-3-6H18L4 3Z"/><path d="M17 3v6M14 6h6"/></svg>
    </button>
    {!open && notice && <span className={styles.notice} role="status">{notice}</span>}
    {open && selection && createPortal(<div ref={popover} role="dialog" aria-label={ko ? "선택한 요소에 주석 달기" : "Comment on selected element"}
      className={`${menu.panelPopover} ${styles.popover}`} style={position} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); stop(); button.current?.focus(); }
        if (event.key === "Tab") {
          const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("textarea,button:not(:disabled)"));
          const first = fields[0], last = fields.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <textarea ref={input} value={comment} onChange={event => setComment(event.target.value)} maxLength={4000}
        aria-label={ko ? "선택한 요소에 대한 요청" : "Comment about the selected element"} placeholder={ko ? "이 부분에 대해 무엇을 할까요?" : "What should we do with this element?"} />
      {notice && <p role="status" className={styles.message}>{notice}</p>}
      <div className={styles.actions}><button type="button" className={menu.panelMenuRow} onClick={() => { stop(); button.current?.focus(); }}>{ko ? "닫기" : "Close"}</button>
        <button type="button" className={menu.panelMenuRow} disabled={busy || !comment.trim()} onClick={() => void submit()}>{ko ? "입력창에 추가" : "Add to message"}</button></div>
    </div>, document.body)}
  </span>;
}
