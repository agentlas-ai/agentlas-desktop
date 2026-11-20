"use client";

/**
 * The line of files under an answer (Agentlas 2.0 AK; pictures desktop-impl-gaps-8). Chips of the first three files and "N more" that opens the whole list in place.
 * A press opens the file in the right panel's preview through the caller's own open function (the one a link in the answer uses); the right-click menu is
 * Preview / Show in folder / Copy path through the existing bridge (`fs.showItemInFolder`) and the clipboard. A file is checked for being gone once, when its
 * chip or row is drawn (no timer, no watcher); only the file system's own "missing" marks it deleted, never a failed or refused read. Draws nothing for no file.
 * The answer text, its start marker and what the phone reads are not touched: this is a separate element under the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconCopy, IconFolder } from "@/components/Icon";
import { fileUrlForLinkedFile, type LinkedFileArtifact } from "@/components/Markdown";
import { ipc } from "@/lib/ipc";
import {
  TURN_FILES_CHIP_LIMIT,
  TURN_FILES_LIST_ROWS,
  turnFilesCounts,
  turnFileWords,
  type TurnFile,
  type TurnFileKind,
} from "@/lib/turn-files";
import s from "./OneTurnFiles.module.css";

const sv = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const sheet = <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />;
export function FileGlyph({ kind, deleted = false }: { kind: TurnFileKind; deleted?: boolean }) {
  if (deleted) return <svg {...sv}>{sheet}<path d="M4 4l16 16" /></svg>;
  if (kind === "table") return <svg {...sv}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M4 15h16M10 4v16" /></svg>;
  if (kind === "image") return <svg {...sv}><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9.5" r="1.5" /><path d="M5 18l5-5 4 4 2-2 3 3" /></svg>;
  if (kind === "code") return <svg {...sv}>{sheet}<path d="M10.5 12.5L9 14l1.5 1.5M13.5 12.5L15 14l-1.5 1.5" /></svg>;
  if (kind === "text") return <svg {...sv}>{sheet}<path d="M9 11h6M9 14h6M9 17h4" /></svg>;
  if (kind === "pdf") return <svg {...sv}>{sheet}<text x="8.2" y="17" fontSize="5.2" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">PDF</text></svg>;
  return <svg {...sv}>{sheet}</svg>;
}

/** The file as the caller's open-linked-file function takes it (a chip, a list row and an Outputs row open the same way). */
export function linkedFileOfTurnFile(file: TurnFile): LinkedFileArtifact {
  return { id: `file:${file.path}`, name: file.name, href: file.path, path: file.absolute ? file.path : undefined, paths: file.absolute ? [file.path] : [], fileUrl: file.absolute ? fileUrlForLinkedFile(file.path) : file.path };
}

type Menu = { file: TurnFile; x: number; y: number };

export function OneTurnFiles({ files, chatId, locale, onPreview, inset = 0 }: {
  files: readonly TurnFile[];
  /** The conversation whose work folder the read scope is (the existence check); without it no file is marked deleted. */
  chatId?: string | null;
  locale: "ko" | "en";
  /** Opens the file in the right panel's preview (the caller's open-linked-file function). */
  onPreview?: (file: LinkedFileArtifact) => void;
  /** Left space in px, for an answer that sits beside an avatar column. */
  inset?: number;
}) {
  const w = turnFileWords(locale);
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const checked = useRef(new Set<string>());
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [footGone, setFootGone] = useState(false);
  const shown = useMemo(() => (open ? files : files.slice(0, TURN_FILES_CHIP_LIMIT)), [open, files]);
  const key = useMemo(() => shown.map((f) => f.path).join("\u0000"), [shown]);

  // Once per drawn file: the file system's own answer for "not there". A refused or failed read says nothing (the file stays pressable).
  useEffect(() => {
    const api = ipc();
    if (!api?.fs?.readTextFile || !chatId) return;
    let cancelled = false;
    const todo = shown.filter((f) => f.absolute && !checked.current.has(f.path));
    for (const f of todo) checked.current.add(f.path);
    if (!todo.length) return;
    // "Missing" is asked twice, 1.5 s apart: a chip is drawn while the turn is still writing, and an edit that replaces the file (delete then write)
    // is missing for an instant. One "missing" there struck the name through for good while the file was there (
    // "notes.md — Deleted" next to a live notes.md). Only the second answer marks it gone.
    const isMissing = async (path: string): Promise<boolean> => {
      try {
        const r = await api.fs.readTextFile(path, { kind: "chat-workspace", chatId });
        return r?.reason === "missing";
      } catch { return false; }
    };
    void Promise.all(todo.map(async (f) => {
      if (!(await isMissing(f.path))) return null;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
      return cancelled ? null : (await isMissing(f.path)) ? f.path : null;
    })).then((missing) => {
      const list = missing.filter((p): p is string => Boolean(p));
      if (!cancelled && list.length) setGone((prev) => new Set([...prev, ...list]));
    });
    return () => { cancelled = true; };
  }, [key, chatId, shown]);

  const preview = useCallback((f: TurnFile) => { if (!gone.has(f.path)) onPreview?.(linkedFileOfTurnFile(f)); }, [gone, onPreview]);
  const reveal = useCallback((f: TurnFile) => { if (f.absolute) void ipc()?.fs?.showItemInFolder?.(f.path); }, []);
  const copy = useCallback((f: TurnFile) => { try { void navigator.clipboard.writeText(f.path); } catch { /* the clipboard is the OS's to refuse */ } }, []);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const away = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setMenu(null); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    window.addEventListener("resize", close); window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);

  if (files.length === 0) return null;
  const counts = turnFilesCounts(files);
  const extra = files.length - TURN_FILES_CHIP_LIMIT;
  const onMenu = (f: TurnFile) => (e: ReactMouseEvent) => {
    e.preventDefault();
    setMenu({ file: f, x: Math.max(8, Math.min(e.clientX, window.innerWidth - 220)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 160)) });
  };
  const wrapStyle: CSSProperties | undefined = inset ? { paddingLeft: inset } : undefined;
  const opWord = (f: TurnFile) => (gone.has(f.path) ? w.deleted : f.op === "created" ? w.created : w.edited);
  const press = (f: TurnFile) => (e: ReactKeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); preview(f); } };

  return (
    <div className={s.wrap} style={wrapStyle} data-turn-files={files.length}>
      {!open && (
        <div className={s.chips}>
          {files.slice(0, TURN_FILES_CHIP_LIMIT).map((f) => {
            const deleted = gone.has(f.path);
            return (
              <button key={f.path} type="button" className={s.chip} data-deleted={deleted || undefined} data-turn-file-chip={f.kind} aria-disabled={deleted || undefined}
                title={f.path} onClick={() => preview(f)} onContextMenu={onMenu(f)}>
                <span className={s.glyph}><FileGlyph kind={f.kind} deleted={deleted} /></span>
                <span className={s.name}>{f.name}</span>
                <span className={s.op}>{opWord(f)}</span>
              </button>
            );
          })}
          {extra > 0 && (
            <button type="button" className={`${s.chip} ${s.moreChip}`} aria-expanded={false} data-turn-files-more="true" onClick={() => setOpen(true)}>
              {w.more(extra)}<span className={s.chev} aria-hidden="true"><IconChevronDown size={14} /></span>
            </button>
          )}
        </div>
      )}
      {open && (
        <div className={s.list} data-turn-files-list="true">
          <div className={s.head}>
            <span className={s.headTitle}>{w.head(files.length)}</span>
            <span className={s.headCount}>{w.headCount(counts.created, counts.edited)}</span>
            <button type="button" className={s.collapse} aria-label={w.collapse} title={w.collapse} onClick={() => { setOpen(false); setFootGone(false); }}>
              <span style={{ display: "grid", transform: "rotate(180deg)" }}><IconChevronDown size={16} /></span>
            </button>
          </div>
          <div className={s.rows} ref={rowsRef}>
            {files.map((f) => {
              const deleted = gone.has(f.path);
              return (
                <div key={f.path} role="button" tabIndex={deleted ? -1 : 0} className={s.row} data-deleted={deleted || undefined} aria-disabled={deleted || undefined}
                  title={f.path} onClick={() => preview(f)} onKeyDown={press(f)} onContextMenu={onMenu(f)}>
                  <span className={s.glyph}><FileGlyph kind={f.kind} deleted={deleted} /></span>
                  <span className={s.rowName}>{f.name}</span>
                  <span className={s.rowDir}>{f.dir}</span>
                  {f.absolute && !deleted
                    ? <button type="button" className={s.reveal} aria-label={w.folder} title={w.folder} onClick={(e) => { e.stopPropagation(); reveal(f); }}><IconFolder size={15} /></button>
                    : <span />}
                  <span className={s.rowOp}>{opWord(f)}</span>
                </div>
              );
            })}
          </div>
          {files.length > TURN_FILES_LIST_ROWS && !footGone && (
            <button type="button" className={s.foot} onClick={() => { rowsRef.current?.scrollTo({ top: rowsRef.current.scrollHeight }); setFootGone(true); }}>{w.moreRows(files.length - TURN_FILES_LIST_ROWS)}</button>
          )}
        </div>
      )}
      {menu && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} className={s.menu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label={menu.file.name}>
          <button type="button" role="menuitem" className={s.menuItem} disabled={gone.has(menu.file.path)} onClick={() => { preview(menu.file); setMenu(null); }}>
            <svg {...sv}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></svg>{w.preview}
          </button>
          <button type="button" role="menuitem" className={s.menuItem} disabled={!menu.file.absolute || gone.has(menu.file.path)} onClick={() => { reveal(menu.file); setMenu(null); }}><IconFolder size={16} />{w.folder}</button>
          <button type="button" role="menuitem" className={s.menuItem} onClick={() => { copy(menu.file); setMenu(null); }}><IconCopy size={16} />{w.copy}</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
