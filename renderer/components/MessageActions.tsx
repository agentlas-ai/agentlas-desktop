"use client";
import { cloneElement, useEffect, useRef, useState, type ReactElement, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { MessageReply } from "../lib/message-reply";
import { IconCopy, IconFileText, IconReply } from "./Icon";
import { PopupFrame, PopupAction } from "./Popup";
import styles from "./MessageActions.module.css";

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Electron or restricted clipboard: native document fallback. */ }
  const field = document.createElement("textarea");
  field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.appendChild(field); field.select();
  const copied = document.execCommand("copy"); field.remove();
  if (!copied) throw new Error("clipboard_unavailable");
}

export function MessageActions({ messageId, author, text, locale, onReply, children }: MessageReply & {
  locale: string; onReply?: (reply: MessageReply) => void;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const ko = locale === "ko";
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const longPressed = useRef(false);
  const cancelPress = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const open = (x: number, y: number) => { setStatus(null); setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 240)), y: Math.max(8, Math.min(y, window.innerHeight - 210)) }); };
  const dismiss = () => { setMenu(null); setSelecting(false); triggerRef.current?.focus(); };
  useEffect(() => () => cancelPress(), []);
  useEffect(() => {
    if (!menu && !selecting) return;
    if (selecting) selectionRef.current?.focus(); else menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
      if (event.key === "Tab" && menu) setMenu(null);
      if (event.key === "Tab" && selecting) {
        const buttons = selectionRef.current?.parentElement?.querySelectorAll<HTMLButtonElement>("button");
        const first = buttons?.[0], last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (menu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault(); const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    const outside = (event: Event) => { if (menu && !menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("keydown", key); document.addEventListener("pointerdown", outside);
    const scroll = () => setMenu(null); window.addEventListener("resize", scroll); window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", scroll); window.removeEventListener("scroll", scroll, true); };
  }, [menu, selecting]);
  if (!text.trim()) return children;
  const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest("button,a,input,textarea,select,[contenteditable='true']");
  const action = cloneElement(children, {
    className: [children.props.className, styles.source].filter(Boolean).join(" "),
    onContextMenu: event => { children.props.onContextMenu?.(event); if (interactive(event.target)) return; event.preventDefault(); open(event.clientX, event.clientY); },
    onPointerDown: event => { children.props.onPointerDown?.(event); cancelPress(); longPressed.current = false; if (event.button !== 0 || interactive(event.target)) return; origin.current = { x: event.clientX, y: event.clientY }; timer.current = setTimeout(() => { longPressed.current = true; open(event.clientX, event.clientY); }, 500); },
    onPointerMove: event => { children.props.onPointerMove?.(event); if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancelPress(); },
    onPointerUp: event => { children.props.onPointerUp?.(event); cancelPress(); },
    onPointerCancel: event => { children.props.onPointerCancel?.(event); cancelPress(); },
    onPointerLeave: event => { children.props.onPointerLeave?.(event); cancelPress(); },
    onClickCapture: event => { if (longPressed.current) { event.preventDefault(); event.stopPropagation(); longPressed.current = false; } else children.props.onClickCapture?.(event); },
  }, children.props.children, <button key="message-menu" ref={triggerRef} type="button" className={styles.trigger} aria-label={ko ? "메시지 메뉴" : "Message menu"} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); open(r.right, r.bottom); }} onKeyDown={event => { if (event.key === "F10" && event.shiftKey) { event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(); open(r.right, r.bottom); } }}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="13" cy="8" r="1" fill="currentColor"/></svg></button>);
  return <>{action}{menu && createPortal(<div ref={menuRef} className={styles.menu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label={ko ? "메시지 메뉴" : "Message menu"}>
    <button role="menuitem" onClick={() => void copyText(text).then(() => { setStatus(ko ? "복사했습니다" : "Copied"); }).catch(() => setStatus(ko ? "복사하지 못했습니다. 텍스트를 선택해 복사해 주세요." : "Copy failed. Select the text to copy it."))}><IconCopy size={16} />{ko ? "복사" : "Copy"}</button>
    <button role="menuitem" onClick={() => { setMenu(null); setStatus(null); setSelecting(true); }}><IconFileText size={16} />{ko ? "텍스트 선택" : "Select text"}</button>
    {onReply && <button role="menuitem" onClick={() => { onReply({ messageId, author, text }); setMenu(null); }}><IconReply size={16} />{ko ? "회신하기" : "Reply"}</button>}
    {status && <p className={styles.status} role="status">{status}</p>}
  </div>, document.body)}{selecting && <PopupFrame title={ko ? "텍스트 선택" : "Select text"} icon={<IconFileText size={18} />} closeLabel={ko ? "닫기" : "Close"} onClose={dismiss} size="wide"><div className={styles.selection}><textarea ref={selectionRef} readOnly value={text} aria-label={ko ? "선택할 메시지 텍스트" : "Message text to select"}/><PopupAction primary icon={<IconCopy size={16} />} onClick={() => void copyText(selectionRef.current?.value.substring(selectionRef.current.selectionStart, selectionRef.current.selectionEnd) || text).then(() => setStatus(ko ? "복사했습니다" : "Copied")).catch(() => setStatus(ko ? "복사하지 못했습니다" : "Copy failed"))}>{ko ? "선택한 텍스트 복사" : "Copy selected text"}</PopupAction>{status && <p role="status">{status}</p>}</div></PopupFrame>}</>;
}

export function MessageReplyPreview({ reply, locale, onDismiss }: { reply: MessageReply | null; locale: string; onDismiss: () => void }) {
  if (!reply) return null;
  return <aside className={styles.preview} aria-label={locale === "ko" ? "인용 답장" : "Quoted reply"}><div><strong>{locale === "ko" ? "회신: " : "Reply to: "}{reply.author}</strong><span>{reply.text}</span></div><button type="button" onClick={onDismiss} aria-label={locale === "ko" ? "인용 취소" : "Cancel reply"}>✕</button></aside>;
}
