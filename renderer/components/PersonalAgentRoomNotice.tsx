"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevronRight, IconLock, IconMoreHorizontal } from "./Icon";
import { PopupAction, PopupFrame } from "./Popup";
import { personalAgentRoomCopy, releasePersonalAgentRoom } from "@/lib/personal-agent-room";

/**
 * Stands where the composer would be in a room the personal agent runs (owner 2026-10-27): the owner reads the room and
 * talks to the personal agent. Approval and question cards above it still answer here.
 */
export function PersonalAgentRoomNotice({ locale, onOpenPersonalAgent, width }: {
  locale: "ko" | "en";
  onOpenPersonalAgent: () => void;
  /** The composer's own width, so the notice sits exactly where it was. */
  width?: string;
}) {
  const copy = personalAgentRoomCopy(locale);
  return <div role="region" aria-label={copy.title} data-personal-agent-room-notice="true"
    style={{
      width: width ?? "min(calc(100% - 32px), 740px)", margin: "8px auto 14px", padding: "10px 12px", borderRadius: 12,
      boxSizing: "border-box", border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft, var(--ink))",
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0,
    }}>
    <span aria-hidden="true" style={{ display: "inline-flex", color: "var(--muted-deep)", flexShrink: 0 }}><IconLock size={16} /></span>
    <span style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere", fontSize: 12.5, lineHeight: 1.45 }}>
      <strong style={{ display: "block", fontWeight: 600, color: "var(--ink)" }}>{copy.title}</strong>
      <span style={{ color: "var(--muted-deep)" }}>{copy.body}</span>
    </span>
    <button type="button" data-personal-agent-room-open="true" onClick={onOpenPersonalAgent}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, maxWidth: "100%", whiteSpace: "normal", textAlign: "left",
        padding: "7px 12px", border: 0, borderRadius: 8, background: "var(--ink)", color: "var(--paper)", font: "inherit",
        fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, cursor: "pointer" }}>
      {copy.openPersonalAgent}<IconChevronRight size={14} />
    </button>
  </div>;
}

/**
 * The room's ⋯ menu, shown only in a personal agent's room: "내가 직접 이어가기" with a confirmation. The escape for when
 * the personal agent cannot carry the room on; afterwards the room is an ordinary Work room.
 */
export function PersonalAgentRoomMenu({ chatId, locale, onReleased, className }: {
  chatId: string;
  locale: "ko" | "en";
  onReleased: () => void;
  className?: string;
}) {
  const copy = personalAgentRoomCopy(locale);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const release = async () => {
    setBusy(true); setError(false);
    try {
      await releasePersonalAgentRoom(chatId);
      setConfirming(false);
      onReleased();
    } catch {
      setError(true);
    } finally { setBusy(false); }
  };
  return <div ref={root} style={{ position: "relative", display: "inline-flex" }}>
    <button type="button" className={className} data-personal-agent-room-menu="true" aria-label={copy.menu} title={copy.menu}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <IconMoreHorizontal size={16} />
    </button>
    {open && <div role="menu" aria-label={copy.menu} data-personal-agent-room-menu-list="true"
      style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 30, minWidth: 180, maxWidth: "min(280px, calc(100vw - 24px))",
        padding: 4, borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper)", boxShadow: "var(--shadow-2)" }}>
      <button type="button" role="menuitem" data-personal-agent-room-take-over="true"
        onClick={() => { setOpen(false); setError(false); setConfirming(true); }}
        style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", border: 0, borderRadius: 7, background: "transparent",
          color: "var(--ink)", font: "inherit", fontSize: 13, cursor: "pointer", whiteSpace: "normal" }}>
        {copy.takeOver}
      </button>
    </div>}
    {confirming && <PopupFrame title={copy.confirmTitle} closeLabel={copy.cancel} onClose={() => { if (!busy) setConfirming(false); }} busy={busy}
      role="alertdialog" dataAttributes={{ "data-personal-agent-room-confirm": "true" }}
      footer={<>
        <PopupAction data-personal-agent-room-confirm-action="cancel" disabled={busy} onClick={() => setConfirming(false)}>{copy.cancel}</PopupAction>
        <PopupAction primary data-personal-agent-room-confirm-action="release" disabled={busy} onClick={() => void release()}>{copy.confirm}</PopupAction>
      </>}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, overflowWrap: "anywhere" }}>{copy.confirmBody}</p>
      {error && <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted-deep)" }}>{copy.failed}</p>}
    </PopupFrame>}
  </div>;
}
