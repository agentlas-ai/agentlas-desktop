"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  cellAddress, findFormatHolder, findLiveTextTarget, LIVE_DOCUMENT_OPS_BY_FORMAT, parseCellAddress,
  type LiveDocumentMeta, type LiveDocumentModel, type LiveDocumentOp, type LiveDocumentOpName, type LiveFlowBlock, type LiveFormat, type LiveFormatPatch, type LiveSheet, type LiveSlide,
} from "@shared/live-document";
import { IconCheck, IconClose, IconFileText, IconFolder, IconPlus, IconSparkles, IconTrash } from "@/components/Icon";
import { LiveDocumentRibbon } from "./LiveDocumentRibbon";
import { ipc } from "@/lib/ipc";
import { useLiveDocumentSession, type LiveCursor, type LiveTyping } from "@/lib/live-document-player";
import styles from "./LiveDocumentRailPanel.module.css";

type Locale = "ko" | "en";

/** Sessions open in this conversation; refreshes when any process changes one. */
export function useLiveDocuments(chatId: string | null): { sessions: LiveDocumentMeta[]; lastChanged: string | null; refresh: () => void } {
  const [sessions, setSessions] = useState<LiveDocumentMeta[]>([]);
  const [lastChanged, setLastChanged] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!chatId) { setSessions([]); return; }
    void ipc()?.liveDocument?.list(chatId).then((list) => setSessions(list ?? [])).catch(() => undefined);
  }, [chatId]);
  useEffect(() => {
    refresh();
    const off = ipc()?.liveDocument?.onChanged((event) => {
      if (event.chatId !== chatId) return;
      setLastChanged(event.sessionId);
      refresh();
    });
    return () => off?.();
  }, [chatId, refresh]);
  return { sessions, lastChanged, refresh };
}

const REASONS: Record<string, [string, string]> = {
  file_changed_on_disk: ["파일이 이 세션 밖에서 바뀌어 저장하지 않았습니다. 닫고 다시 여세요.", "The file changed outside this session; nothing was saved. Close and reopen it."],
  save_verification_failed: ["저장 결과를 다시 읽어 확인하지 못해 파일을 그대로 두었습니다.", "The written file did not read back as the edited document, so the file was left unchanged."],
  save_failed: ["이 형식으로 저장하지 못했습니다.", "Could not write this format."],
  file_locked: ["다른 앱(엑셀·워드·한글)이 파일을 열고 있어 저장하지 못했습니다. 그 앱에서 닫고 다시 저장하세요.", "Another app (Excel, Word, Hancom) has the file open; close it there and save again."],
  revision_conflict: ["AI가 같은 곳을 먼저 고쳐 최신 내용으로 다시 불러왔습니다.", "The AI changed the same place first; reloaded the latest version."],
  block_protected: ["구역 설정이 들어 있는 첫 문단은 지울 수 없습니다.", "The paragraph holding the section settings cannot be deleted."],
  last_block: ["마지막 남은 문단은 지울 수 없습니다.", "The last paragraph cannot be deleted."],
  last_slide: ["마지막 슬라이드는 지울 수 없습니다.", "The last slide cannot be deleted."],
  op_unsupported_for_format: ["이 형식에서는 지원하지 않는 편집입니다.", "This format does not support that edit."],
  file_unreadable: ["이 파일을 읽지 못했습니다(암호·배포용 문서 포함).", "Could not read this file (password or distribution documents included)."],
  format_unsupported: ["xlsx, docx, pptx, hwpx, hwp 파일만 열 수 있습니다.", "Only xlsx, docx, pptx, hwpx and hwp files open here."],
  file_too_large: ["파일이 너무 큽니다(60MB 이하).", "The file is too large (60 MB max)."],
  unsaved_session_exists: ["저장하지 않은 편집이 있는데 파일이 바뀌었습니다. 기존 탭에서 정리하세요.", "This file changed while an unsaved session is open; resolve that tab first."],
  session_closed: ["닫힌 문서입니다.", "This document is closed."],
};

function reasonText(reason: string | undefined, locale: Locale): string {
  const pair = reason ? REASONS[reason] : undefined;
  return pair ? pair[locale === "ko" ? 0 : 1] : (locale === "ko" ? `처리하지 못했습니다 (${reason ?? "unknown"})` : `Could not complete (${reason ?? "unknown"})`);
}

const FORMAT_LABEL: Record<string, string> = { xlsx: "XLSX", docx: "DOCX", pptx: "PPTX", hwpx: "HWPX", hwp: "HWP" };

/** CSS for a LiveFormat; `pt` converts points to pixels for paper and sheet views (slides pass their own size). */
function formatCss(format: LiveFormat | undefined, pt = true): CSSProperties {
  if (!format) return {};
  return {
    ...(format.bold !== undefined ? { fontWeight: format.bold ? 700 : 400 } : {}),
    ...(format.italic ? { fontStyle: "italic" } : {}),
    ...(format.underline ? { textDecoration: "underline" } : {}),
    ...(format.color ? { color: format.color } : {}),
    ...(format.align ? { textAlign: format.align } : {}),
    ...(pt && format.size ? { fontSize: `${format.size}pt` } : {}),
    ...(format.fill ? { backgroundColor: format.fill } : {}),
  };
}

const MM = 96 / 25.4;
const A4: NonNullable<Extract<LiveDocumentModel, { kind: "flow" }>["page"]> = { width: 210, height: 297, margin: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } };

/** Splits blocks into sheets at explicit page breaks (a sheet still grows when its content overflows the paper). */
function sheetsOf(blocks: LiveFlowBlock[]): LiveFlowBlock[][] {
  const sheets: LiveFlowBlock[][] = [[]];
  for (const block of blocks) {
    if (block.type === "paragraph" && block.pageBreak === "before" && sheets[sheets.length - 1].length) sheets.push([]);
    sheets[sheets.length - 1].push(block);
    if (block.type === "paragraph" && block.pageBreak === "after") sheets.push([]);
  }
  if (sheets.length > 1 && !sheets[sheets.length - 1].length) sheets.pop();
  return sheets;
}

/** Scales its child (a sheet of real paper size) down to the panel width, like a word processor's fit-width zoom. */
function FitWidth({ width, children }: { width: number; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setZoom(Math.min(1.25, Math.max(0.3, (el.clientWidth - 32) / width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  return <div ref={host} className={styles.fitHost}><div style={{ zoom } as CSSProperties}>{children}</div></div>;
}

interface HistoryStep { forward: LiveDocumentOp[]; inverse: LiveDocumentOp[] }

/** The ops that undo `ops` against the model they are about to change; null when one of them cannot be undone. */
function inverseOps(model: LiveDocumentModel, ops: LiveDocumentOp[]): LiveDocumentOp[] | null {
  const out: LiveDocumentOp[] = [];
  for (const op of ops) {
    if (op.op === "set_text" || op.op === "insert_text") {
      const target = findLiveTextTarget(model, op.target);
      if (!target) return null;
      out.unshift({ op: "set_text", target: op.target, text: target.get() });
    } else if (op.op === "set_cell") {
      if (model.kind !== "sheet") return null;
      const sheet = model.sheets.find((item) => item.id === op.sheet || item.name === op.sheet);
      const cell = sheet?.cells[op.cell];
      out.unshift({ op: "set_cell", sheet: op.sheet, cell: op.cell, value: cell ? (cell.f !== undefined ? `=${cell.f}` : cell.v) : "" });
    } else if (op.op === "set_format") {
      const holder = findFormatHolder(model, op.target);
      if (!holder) return null;
      const before = holder.get();
      // null = "had no explicit value": undo removes what the edit set, so an inherited look comes back.
      const back: LiveFormatPatch = {};
      for (const key of Object.keys(op.format) as Array<keyof LiveFormat>) (back as Record<string, unknown>)[key] = before[key] ?? null;
      const heading = op.heading !== undefined && model.kind === "flow"
        ? (model.blocks.find((block) => block.id === op.target && block.type === "paragraph") as { heading?: number } | undefined)?.heading ?? 0 : undefined;
      out.unshift({ op: "set_format", target: op.target, format: back, ...(heading !== undefined ? { heading } : {}) });
    } else return null; // structural ops are undone through their created ids (see run)
  }
  return out;
}

export function LiveDocumentRailPanel({ chatId, locale, focusSessionId }: { chatId: string | null; locale: Locale; focusSessionId?: string | null }) {
  const ko = locale === "ko";
  const { sessions, refresh } = useLiveDocuments(chatId);
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (focusSessionId && sessions.some((session) => session.sessionId === focusSessionId)) setActive(focusSessionId);
  }, [focusSessionId, sessions]);
  useEffect(() => {
    if (!sessions.length) { setActive(null); return; }
    if (!active || !sessions.some((session) => session.sessionId === active)) setActive(sessions[sessions.length - 1].sessionId);
  }, [sessions, active]);

  const openFile = async () => {
    if (!chatId) return;
    const result = await ipc()?.liveDocument?.pickAndOpen(chatId);
    if (!result) return;
    if (result.ok) { refresh(); setActive(result.sessionId); setNotice(null); }
    else if (result.reason !== "cancelled") setNotice(reasonText(result.reason, locale));
  };

  if (!chatId) return <p className={styles.empty}>{ko ? "대화가 연결되면 문서를 열 수 있습니다." : "Documents open once this conversation is bound to a task."}</p>;

  return (
    <div className={styles.panel} data-live-document-panel="true">
      <div className={styles.sessionBar} role="tablist" aria-label={ko ? "열린 문서" : "Open documents"}>
        {sessions.map((session) => (
          <button key={session.sessionId} type="button" role="tab" aria-selected={session.sessionId === active}
            className={styles.sessionTab} data-active={session.sessionId === active ? "true" : "false"}
            onClick={() => setActive(session.sessionId)} title={session.path}>
            <span className={styles.formatBadge} data-format={session.format}>{FORMAT_LABEL[session.format]}</span>
            <span className={styles.sessionName}>{session.name}</span>
          </button>
        ))}
        <button type="button" className={styles.openButton} onClick={() => void openFile()} aria-label={ko ? "문서 열기" : "Open document"} title={ko ? "문서 열기" : "Open document"}>
          <IconPlus size={14} />{sessions.length === 0 && <span>{ko ? "문서 열기" : "Open document"}</span>}
        </button>
      </div>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {active
        ? <LiveDocumentEditor key={active} sessionId={active} locale={locale} onClosed={() => { refresh(); setActive(null); }} />
        : <div className={styles.emptyState}>
          <IconFileText size={28} />
          <strong>{ko ? "AI와 함께 문서를 실시간으로 편집합니다" : "Edit documents live with the AI"}</strong>
          <p>{ko
            ? "엑셀·워드·파워포인트·한글(HWP/HWPX) 파일을 열면 AI가 커서로 직접 고치는 모습을 이 탭에서 보고, 직접 고칠 수도 있습니다. 저장하면 원래 형식 그대로 파일에 반영됩니다."
            : "Open an Excel, Word, PowerPoint or Hangul (HWP/HWPX) file to watch the AI edit it with its own cursor, or edit it yourself. Saving writes it back in its original format."}</p>
          <button type="button" className={styles.primaryButton} onClick={() => void openFile()}>{ko ? "문서 열기" : "Open document"}</button>
        </div>}
    </div>
  );
}

function LiveDocumentEditor({ sessionId, locale, onClosed }: { sessionId: string; locale: Locale; onClosed: () => void }) {
  const ko = locale === "ko";
  const session = useLiveDocumentSession(sessionId);
  const { meta, display, revision, cursor, typing, focus, apply } = session;
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const supports = useCallback((op: LiveDocumentOpName) => !!meta && (LIVE_DOCUMENT_OPS_BY_FORMAT[meta.format] as readonly string[]).includes(op), [meta]);

  const history = useRef<{ undo: HistoryStep[]; redo: HistoryStep[] }>({ undo: [], redo: [] });
  const [, setHistoryTick] = useState(0);
  const [activeSlide, setActiveSlide] = useState<string | null>(null);
  const run = useCallback(async (ops: LiveDocumentOp[], mode: "record" | "undo" | "redo" = "record"): Promise<boolean> => {
    const model = session.displayRef.current;
    const textual = model ? inverseOps(model, ops.filter((op) => !["insert_paragraph", "insert_table", "add_slide", "add_sheet", "delete_block", "delete_slide"].includes(op.op))) : null;
    const result = await apply(ops);
    if (!result.ok) { setStatus({ tone: "error", text: reasonText(result.reason, locale) }); return false; }
    setStatus(null);
    // Undo: text/cell/format edits restore their previous values; inserts are undone by deleting what they created.
    const deletes: LiveDocumentOp[] = [];
    let undoable = textual !== null && !ops.some((op) => op.op === "delete_block" || op.op === "delete_slide" || op.op === "add_sheet");
    const created = [...(result.created ?? [])];
    for (const op of ops) {
      if (op.op === "insert_paragraph" || op.op === "insert_table") { const id = created.shift(); if (id) deletes.unshift({ op: "delete_block", target: id }); else undoable = false; }
      if (op.op === "add_slide") { const id = created.shift(); if (id) deletes.unshift({ op: "delete_slide", target: id }); else undoable = false; }
    }
    const step: HistoryStep = { forward: ops, inverse: [...deletes, ...(textual ?? [])] };
    // An undo is not itself recorded: the caller moves the original step to the redo stack.
    if (mode === "undo") { /* nothing */ }
    else if (undoable && step.inverse.length) {
      history.current.undo.push(step);
      if (history.current.undo.length > 100) history.current.undo.shift();
      if (mode === "record") history.current.redo = [];
    } else if (mode === "record") history.current = { undo: [], redo: [] };
    setHistoryTick((tick) => tick + 1);
    return true;
  }, [apply, locale, session.displayRef]);
  const undo = useCallback(async () => {
    const step = history.current.undo.pop();
    if (!step) return;
    if (await run(step.inverse, "undo")) history.current.redo.push(step);
    else history.current = { undo: [], redo: [] };
    setHistoryTick((tick) => tick + 1);
  }, [run]);
  const redo = useCallback(() => {
    const step = history.current.redo.pop();
    if (step) void run(step.forward, "redo");
  }, [run]);

  const selectedFormat = display && selected ? findFormatHolder(display, selected)?.get() ?? {} : {};
  const selectedHeading = display?.kind === "flow" && selected ? (display.blocks.find((block) => block.id === selected && block.type === "paragraph") as { heading?: number } | undefined)?.heading : undefined;
  const selectedBlock = display?.kind === "flow" && selected ? selected.split(".")[0] : null;
  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Escape belongs to the document (cancel a cell or paragraph edit), never to the rail around it.
    if (event.key === "Escape") { event.stopPropagation(); return; }
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else void undo(); }
    else if (key === "y") { event.preventDefault(); redo(); }
    else if (selected && supports("set_format") && (key === "b" || key === "i" || key === "u")) {
      event.preventDefault();
      const field = key === "b" ? "bold" : key === "i" ? "italic" : "underline";
      void run([{ op: "set_format", target: selected, format: { [field]: !selectedFormat[field] } }]);
    }
  };

  const save = async () => {
    setSaving(true);
    const result = await ipc()?.liveDocument?.save(sessionId);
    setSaving(false);
    if (result?.ok) setStatus({ tone: "ok", text: ko ? "원래 형식으로 저장했습니다." : "Saved in its original format." });
    else setStatus({ tone: "error", text: reasonText(result && !result.ok ? result.reason : undefined, locale) });
  };

  if (!meta || !display) return <p className={styles.empty}>{session.error ? reasonText(session.error, locale) : (ko ? "문서를 불러오는 중…" : "Loading document…")}</p>;
  const unsaved = revision - meta.savedRevision;

  return (
    <div className={styles.editor} data-live-document-session={sessionId} data-revision={revision} data-ai-active={cursor ? "true" : "false"} onKeyDown={onKeyDown} tabIndex={-1}>
      <header className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <span className={styles.fileName} title={meta.path}>{meta.name}</span>
          <span className={styles.saveState} data-unsaved={unsaved > 0 ? "true" : "false"}>
            {unsaved > 0 ? (ko ? `저장 안 됨 · 변경 ${unsaved}건` : `Unsaved · ${unsaved} change${unsaved > 1 ? "s" : ""}`) : (ko ? "저장됨" : "Saved")}
          </span>
          {cursor && <span className={styles.aiActive} style={{ "--live-color": cursor.color } as CSSProperties}>
            <IconSparkles size={11} />{ko ? `${cursor.label} 작업 중` : `${cursor.label} editing`}
          </span>}
        </div>
        <div className={styles.actions}>
          <ToolButton label={ko ? "폴더에서 보기" : "Show in folder"} onClick={() => void ipc()?.liveDocument?.reveal(sessionId)}><IconFolder size={13} /></ToolButton>
          <button type="button" className={styles.primaryButton} disabled={saving || unsaved === 0} onClick={() => void save()}>
            {saving ? (ko ? "저장 중…" : "Saving…") : unsaved === 0 ? <><IconCheck size={12} />{ko ? "저장됨" : "Saved"}</> : (ko ? "저장" : "Save")}
          </button>
          <ToolButton label={ko ? "문서 닫기" : "Close document"} onClick={() => {
            if (unsaved > 0 && !window.confirm(ko ? "저장하지 않은 변경이 있습니다. 닫을까요? (원본 파일은 그대로입니다)" : "There are unsaved changes. Close anyway? (the file stays as it was)")) return;
            void ipc()?.liveDocument?.close(sessionId).then(onClosed);
          }}><IconClose size={13} /></ToolButton>
        </div>
      </header>
      <LiveDocumentRibbon locale={locale} kind={display.kind} target={selected} format={selectedFormat} heading={selectedHeading} supports={(op) => supports(op as LiveDocumentOpName)}
        canUndo={history.current.undo.length > 0} canRedo={history.current.redo.length > 0} onUndo={() => void undo()} onRedo={redo}
        onFormat={(format) => { if (selected) void run([{ op: "set_format", target: selected, format }]); }}
        onHeading={(level) => { if (selected) void run([{ op: "set_format", target: selected, format: {}, heading: level }]); }}
        onInsertParagraph={() => void run([{ op: "insert_paragraph", ...(selectedBlock ? { after: selectedBlock } : {}), text: "" }])}
        onInsertTable={(rows, cols) => void run([{ op: "insert_table", ...(selectedBlock ? { after: selectedBlock } : {}), rows: Array.from({ length: rows }, () => Array(cols).fill("")) }])}
        onDeleteBlock={supports("delete_block") && selectedBlock ? () => { void run([{ op: "delete_block", target: selectedBlock }]); setSelected(null); } : undefined}
        onAddSlide={display.kind === "slides" ? () => void run([{ op: "add_slide", after: activeSlide ?? display.slides[display.slides.length - 1]?.id, title: "", body: "" }]) : undefined}
        onAddSheet={display.kind === "sheet" && supports("add_sheet") ? () => {
          let n = display.sheets.length + 1;
          while (display.sheets.some((item) => item.name === `Sheet${n}`)) n++;
          void run([{ op: "add_sheet", name: `Sheet${n}` }]);
        } : undefined} />
      {status && <p className={styles.status} data-tone={status.tone} role="status">{status.text}</p>}
      <div ref={scrollRef} className={styles.canvas} data-kind={display.kind}>
        {display.kind === "flow" && <FlowView model={display} cursor={cursor} typing={typing} locale={locale} selected={selected} onSelect={setSelected}
          editable={supports("set_text")} onCommit={(target, text) => void run([{ op: "set_text", target, text }])} />}
        {display.kind === "sheet" && <SheetView model={display} cursor={cursor} typing={typing} locale={locale} focusSheet={focus?.sheet} focusSeq={focus?.seq} onSelectTarget={setSelected}
          onCommit={(sheet, cell, value) => void run([{ op: "set_cell", sheet, cell, value }])}
          onAddSheet={supports("add_sheet") ? (name) => void run([{ op: "add_sheet", name }]) : undefined} />}
        {display.kind === "slides" && <SlidesView model={display} cursor={cursor} typing={typing} locale={locale} focusSlide={focus?.slide} focusSeq={focus?.seq} selected={selected} onSelectTarget={setSelected} onActiveSlide={setActiveSlide}
          onCommit={(target, text) => void run([{ op: "set_text", target, text }])}
          onAddSlide={(after) => void run([{ op: "add_slide", after, title: "", body: "" }])}
          onDeleteSlide={(target) => void run([{ op: "delete_slide", target }])} />}
        <CursorOverlay container={scrollRef} cursor={cursor} typing={typing} />
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={styles.toolButton} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

// ── shared text pieces ───────────────────────────────────────────────────────────────────────────────────────────

function activeAttrs(id: string, cursor: LiveCursor | null): Record<string, string> {
  return cursor?.target === id ? { "data-live-active": cursor.phase } : {};
}

function cursorStyle(id: string, cursor: LiveCursor | null): CSSProperties | undefined {
  return cursor?.target === id ? ({ "--live-color": cursor.color } as CSSProperties) : undefined;
}

/** Text of a target, or the text being typed into it followed by the AI caret. */
function LiveText({ id, text, typing, cursor, placeholder }: { id: string; text: string; typing: LiveTyping | null; cursor: LiveCursor | null; placeholder?: string }) {
  if (typing?.target === id) return <>{typing.text}<span className={styles.caret} data-live-caret="true" style={{ "--live-color": cursor?.color ?? "#d97757" } as CSSProperties} /></>;
  if (!text && placeholder) return <span className={styles.placeholder}>{placeholder}</span>;
  return <>{text}</>;
}

/** Click to edit in place; Esc cancels, blur or Cmd/Ctrl+Enter commits. Enter inserts a line break. */
function EditableText({ id, text, typing, cursor, editable, className, style, placeholder, onCommit, onSelect }: {
  id: string; text: string; typing: LiveTyping | null; cursor: LiveCursor | null; editable: boolean; className?: string; style?: CSSProperties;
  placeholder?: string; onCommit: (text: string) => void; onSelect?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = cursor?.target === id;
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  useEffect(() => { if (draft !== null) area.current?.focus(); }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = (commit: boolean) => {
    if (draft !== null && commit && draft !== text) onCommit(draft);
    setDraft(null);
  };
  if (draft !== null) {
    return <textarea ref={area} className={`${styles.inlineEditor} ${className ?? ""}`} style={style} value={draft} rows={1}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(true); }
      }} />;
  }
  return <div className={className} style={{ ...style, ...cursorStyle(id, cursor) }} data-live-id={id} {...activeAttrs(id, cursor)}
    onClick={() => { onSelect?.(); if (editable && !busy) setDraft(text); }}>
    <LiveText id={id} text={text} typing={typing} cursor={cursor} placeholder={placeholder} />
  </div>;
}

// ── flow (docx, hwpx, hwp) ──────────────────────────────────────────────────────────────────────────────────────

function FlowView({ model, cursor, typing, locale, selected, onSelect, editable, onCommit }: {
  model: Extract<LiveDocumentModel, { kind: "flow" }>; cursor: LiveCursor | null; typing: LiveTyping | null; locale: Locale;
  selected: string | null; onSelect: (id: string | null) => void; editable: boolean; onCommit: (target: string, text: string) => void;
}) {
  const ko = locale === "ko";
  const page = model.page ?? A4;
  const width = page.width * MM;
  const height = page.height * MM;
  const sheet: CSSProperties = {
    width, minHeight: height, padding: `${page.margin.top * MM}px ${page.margin.right * MM}px ${page.margin.bottom * MM}px ${page.margin.left * MM}px`,
    fontSize: `${model.defaultSize ?? 10.5}pt`,
    // A sheet whose content runs past the paper shows where each further page would start.
    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${height - 1}px, #c9c9c9 ${height - 1}px, #c9c9c9 ${height}px)`,
  };
  return <FitWidth width={width}>
    {sheetsOf(model.blocks).map((blocks, index) => <div key={index} className={styles.page} style={sheet} data-page={index + 1}>
      {blocks.map((block) => <FlowBlock key={block.id} block={block} cursor={cursor} typing={typing} ko={ko} selected={selected === block.id} selectedId={selected}
        onSelect={(id) => onSelect(id ?? block.id)} editable={editable} onCommit={onCommit} />)}
    </div>)}
  </FitWidth>;
}

function FlowBlock({ block, cursor, typing, ko, selected, selectedId, onSelect, editable, onCommit }: {
  block: LiveFlowBlock; cursor: LiveCursor | null; typing: LiveTyping | null; ko: boolean; selected: boolean; selectedId: string | null; onSelect: (id?: string) => void;
  editable: boolean; onCommit: (target: string, text: string) => void;
}) {
  if (block.type === "object") {
    return <div className={styles.objectChip} data-live-id={block.id} data-selected={selected ? "true" : "false"} {...activeAttrs(block.id, cursor)} style={cursorStyle(block.id, cursor)} onClick={() => onSelect()}>
      {block.label === "image" ? (ko ? "그림" : "Image") : block.label === "equation" ? (ko ? "수식" : "Equation") : block.label}
    </div>;
  }
  if (block.type === "table") {
    return <div className={styles.tableWrap} data-live-id={block.id} data-selected={selected ? "true" : "false"} {...activeAttrs(block.id, cursor)} style={cursorStyle(block.id, cursor)}>
      <table className={styles.docTable} style={block.colWidths ? { tableLayout: "fixed" } : undefined}>
        {block.colWidths && <colgroup>{block.colWidths.map((w, i) => <col key={i} style={{ width: `${w * 100}%` }} />)}</colgroup>}
        <tbody>
        {block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => cell
          ? <td key={c} colSpan={cell.colSpan} rowSpan={cell.rowSpan} data-selected={selectedId === cell.id ? "true" : "false"} style={cell.format?.fill ? { backgroundColor: cell.format.fill } : undefined}>
            <EditableText id={cell.id} text={cell.text} typing={typing} cursor={cursor} editable={editable} className={styles.cellText} style={formatCss(cell.format)}
              onSelect={() => onSelect(cell.id)} onCommit={(text) => onCommit(cell.id, text)} />
          </td>
          : null)}</tr>)}
      </tbody></table>
    </div>;
  }
  const level = block.heading;
  return <EditableText id={block.id} text={block.text} typing={typing} cursor={cursor} editable={editable}
    className={`${styles.paragraph} ${level ? styles[`h${Math.min(level, 3)}`] : ""}`}
    style={{ ...formatCss(block.format), ...(selected ? { boxShadow: "inset 2px 0 0 var(--attention)" } : {}) }}
    onSelect={() => onSelect(block.id)} onCommit={(text) => onCommit(block.id, text)} />;
}

// ── sheet (xlsx) ────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_ROWS = 1000;
const MAX_COLS = 60;

function SheetView({ model, cursor, typing, locale, focusSheet, focusSeq, onSelectTarget, onCommit, onAddSheet }: {
  model: Extract<LiveDocumentModel, { kind: "sheet" }>; cursor: LiveCursor | null; typing: LiveTyping | null; locale: Locale; focusSheet?: string; focusSeq?: number;
  onSelectTarget: (target: string) => void;
  onCommit: (sheet: string, cell: string, value: string) => void; onAddSheet?: (name: string) => void;
}) {
  const ko = locale === "ko";
  const [sheetId, setSheetId] = useState(model.sheets[0]?.id ?? "");
  const [sel, setSel] = useState("A1");
  const [editing, setEditing] = useState<string | null>(null);
  const [bar, setBar] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusSheet && model.sheets.some((sheet) => sheet.id === focusSheet)) setSheetId(focusSheet); }, [focusSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  const sheet: LiveSheet | undefined = model.sheets.find((item) => item.id === sheetId) ?? model.sheets[0];
  const bounds = useMemo(() => {
    let rows = 0, cols = 0;
    for (const address of Object.keys(sheet?.cells ?? {})) { const p = parseCellAddress(address); if (p) { rows = Math.max(rows, p.row); cols = Math.max(cols, p.col); } }
    return { rows: Math.min(MAX_ROWS, Math.max(30, rows + 8)), cols: Math.min(MAX_COLS, Math.max(12, cols + 3)), truncated: rows > MAX_ROWS || cols > MAX_COLS };
  }, [sheet]);
  const raw = (address: string) => { const cell = sheet?.cells[address]; return cell ? (cell.f !== undefined ? `=${cell.f}` : cell.v) : ""; };
  useEffect(() => { setBar(raw(sel)); }, [sel, sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sheet) onSelectTarget(`${sheet.id}!${sel}`); }, [sel, sheet?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sheet) return null;

  const move = (dCol: number, dRow: number) => {
    const p = parseCellAddress(sel)!;
    setSel(cellAddress(Math.max(1, Math.min(bounds.cols, p.col + dCol)), Math.max(1, Math.min(bounds.rows, p.row + dRow))));
  };
  const commit = (address: string, value: string) => {
    if (value !== raw(address)) onCommit(sheet.id, address, value);
    setEditing(null);
  };
  const onGridKey = (event: ReactKeyboardEvent) => {
    if (editing) return;
    const keys: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Tab: [1, 0], Enter: [0, 1] };
    if (keys[event.key]) { event.preventDefault(); move(...keys[event.key]); return; }
    if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); if (raw(sel)) onCommit(sheet.id, sel, ""); return; }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setBar(event.key); setEditing(sel); }
  };

  const cols = Array.from({ length: bounds.cols }, (_, i) => i + 1);
  const rows = Array.from({ length: bounds.rows }, (_, i) => i + 1);
  return <div className={styles.sheet}>
    <div className={styles.formulaBar}>
      <span className={styles.nameBox}>{sel}</span>
      <span className={styles.fx}>fx</span>
      <input value={bar} aria-label={ko ? "수식 입력줄" : "Formula bar"} onChange={(event) => setBar(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(sel, bar); move(0, 1); gridRef.current?.focus(); } if (event.key === "Escape") { setBar(raw(sel)); gridRef.current?.focus(); } }} />
    </div>
    <div ref={gridRef} className={styles.gridScroll} tabIndex={0} onKeyDown={onGridKey}>
      <table className={styles.grid}>
        <thead><tr><th className={styles.corner} />{cols.map((col) => <th key={col}>{cellAddress(col, 1).replace(/\d+$/, "")}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row}><th>{row}</th>{cols.map((col) => {
          const address = cellAddress(col, row);
          const id = `${sheet.id}!${address}`;
          const cell = sheet.cells[address];
          const isSel = sel === address;
          if (editing === address) {
            return <td key={col} className={styles.gridCell} data-selected="true">
              <input className={styles.cellInput} autoFocus value={bar} onChange={(event) => setBar(event.target.value)}
                onBlur={() => commit(address, bar)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); commit(address, bar); move(event.key === "Tab" ? 1 : 0, event.key === "Enter" ? 1 : 0); gridRef.current?.focus(); }
                  if (event.key === "Escape") { event.preventDefault(); setEditing(null); setBar(raw(address)); gridRef.current?.focus(); }
                }} />
            </td>;
          }
          const numeric = cell && cell.f === undefined && /^[-+]?[\d,.]+%?$/.test(cell.v.trim());
          return <td key={col} className={styles.gridCell} data-live-id={id} data-selected={isSel ? "true" : "false"} data-numeric={numeric ? "true" : "false"}
            {...activeAttrs(id, cursor)} style={{ ...formatCss(cell?.format), ...cursorStyle(id, cursor) }}
            onClick={() => setSel(address)} onDoubleClick={() => { setSel(address); setBar(raw(address)); setEditing(address); }}>
            {typing?.target === id
              ? <LiveText id={id} text="" typing={typing} cursor={cursor} />
              : cell ? (cell.f !== undefined && cell.v === "" ? <span className={styles.formulaPending}>={cell.f}</span> : cell.v) : null}
          </td>;
        })}</tr>)}</tbody>
      </table>
      {bounds.truncated && <p className={styles.truncated}>{ko ? `처음 ${MAX_ROWS}행 · ${MAX_COLS}열만 표시합니다.` : `Showing the first ${MAX_ROWS} rows and ${MAX_COLS} columns.`}</p>}
    </div>
    <div className={styles.sheetTabs}>
      {model.sheets.map((item) => <button key={item.id} type="button" data-active={item.id === sheet.id ? "true" : "false"} onClick={() => setSheetId(item.id)}>{item.name}</button>)}
      {onAddSheet && <button type="button" aria-label={ko ? "시트 추가" : "Add sheet"} onClick={() => {
        let n = model.sheets.length + 1;
        while (model.sheets.some((item) => item.name === `Sheet${n}`)) n++;
        onAddSheet(`Sheet${n}`);
      }}><IconPlus size={12} /></button>}
    </div>
  </div>;
}

// ── slides (pptx) ───────────────────────────────────────────────────────────────────────────────────────────────

function isDark(hex: string | undefined): boolean {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

function SlideCanvas({ slide, aspect, cursor, typing, interactive, ko, selected, onSelectTarget, onCommit }: {
  slide: LiveSlide; aspect: number; ko: boolean; cursor: LiveCursor | null; typing: LiveTyping | null; interactive: boolean;
  selected?: string | null; onSelectTarget?: (target: string) => void; onCommit?: (target: string, text: string) => void;
}) {
  const widthPt = aspect >= 1.5 ? 960 : 720;
  const dark = isDark(slide.background);
  return <div className={styles.slide} style={{ aspectRatio: String(aspect), background: slide.background ?? "#ffffff" }} {...(interactive ? { "data-live-id": slide.id, ...activeAttrs(slide.id, cursor) } : {})}>
    {slide.shapes.map((shape) => {
      const background = shape.format?.fill ?? shape.fill;
      const box: CSSProperties = { left: `${shape.x * 100}%`, top: `${shape.y * 100}%`, width: `${shape.w * 100}%`, height: `${shape.h * 100}%`, background };
      if (shape.role === "object") return <div key={shape.id} className={styles.slideObject} style={box}>{shape.label ? <span>{shape.label}</span> : null}</div>;
      const size = shape.format?.size ?? (shape.role === "title" ? 40 : shape.role === "body" ? 24 : 18);
      const color = shape.format?.color ?? (dark || isDark(background) ? "#ffffff" : "#1b1b1b");
      const text: CSSProperties = {
        ...box, ...formatCss(shape.format, false), color, fontSize: `calc(${(size / widthPt).toFixed(5)} * 100cqw)`,
        fontWeight: shape.format?.bold ?? shape.role === "title" ? 700 : 400,
        ...(selected === shape.id ? { outline: "2px solid #d24726", outlineOffset: "1px" } : {}),
      };
      // Thumbnails show the text (and live typing) but carry no data-live-id: the AI cursor and clicks target the stage.
      if (!interactive) return <div key={shape.id} className={styles.slideText} style={text}><LiveText id={shape.id} text={shape.text} typing={typing} cursor={null} /></div>;
      return <EditableText key={shape.id} id={shape.id} text={shape.text} typing={typing} cursor={cursor} editable={interactive}
        className={`${styles.slideText} ${shape.role === "body" ? styles.slideBody : ""}`} style={text}
        placeholder={interactive ? (shape.role === "title" ? (ko ? "제목을 입력하세요" : "Title") : (ko ? "내용을 입력하세요" : "Text")) : undefined}
        onSelect={() => onSelectTarget?.(shape.id)} onCommit={(value) => onCommit?.(shape.id, value)} />;
    })}
  </div>;
}

function SlidesView({ model, cursor, typing, locale, focusSlide, focusSeq, selected, onSelectTarget, onActiveSlide, onCommit, onAddSlide, onDeleteSlide }: {
  model: Extract<LiveDocumentModel, { kind: "slides" }>; cursor: LiveCursor | null; typing: LiveTyping | null; locale: Locale; focusSlide?: string; focusSeq?: number;
  selected: string | null; onSelectTarget: (target: string) => void; onActiveSlide: (id: string) => void;
  onCommit: (target: string, text: string) => void; onAddSlide: (after: string) => void; onDeleteSlide: (target: string) => void;
}) {
  const ko = locale === "ko";
  const [active, setActive] = useState(model.slides[0]?.id ?? "");
  useEffect(() => { if (focusSlide && model.slides.some((slide) => slide.id === focusSlide)) setActive(focusSlide); }, [focusSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  const slide = model.slides.find((item) => item.id === active) ?? model.slides[0];
  useEffect(() => { if (slide) onActiveSlide(slide.id); }, [slide?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!slide) return null;
  const index = model.slides.indexOf(slide);
  return <div className={styles.slides}>
    <ol className={styles.thumbs}>
      {model.slides.map((item, i) => <li key={item.id} data-active={item.id === slide.id ? "true" : "false"}>
        <span className={styles.thumbIndex}>{i + 1}</span>
        <button type="button" className={styles.thumb} onClick={() => setActive(item.id)} aria-label={`${ko ? "슬라이드" : "Slide"} ${i + 1}`}>
          <SlideCanvas slide={item} aspect={model.aspect} cursor={null} typing={typing} interactive={false} ko={ko} />
        </button>
      </li>)}
    </ol>
    <div className={styles.stage}>
      <div className={styles.stageActions}>
        <span>{ko ? `슬라이드 ${index + 1}/${model.slides.length}` : `Slide ${index + 1}/${model.slides.length}`}</span>
        <button type="button" onClick={() => onAddSlide(slide.id)}><IconPlus size={12} />{ko ? "새 슬라이드" : "New slide"}</button>
        {model.slides.length > 1 && <button type="button" onClick={() => onDeleteSlide(slide.id)}><IconTrash size={12} />{ko ? "삭제" : "Delete"}</button>}
      </div>
      <SlideCanvas slide={slide} aspect={model.aspect} cursor={cursor} typing={typing} interactive ko={ko} selected={selected} onSelectTarget={onSelectTarget} onCommit={onCommit} />
    </div>
  </div>;
}

// ── AI cursor ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A pointer with the AI's name that follows its edits, like a collaborator's cursor in a shared document. */
function CursorOverlay({ container, cursor, typing }: { container: RefObject<HTMLDivElement | null>; cursor: LiveCursor | null; typing: LiveTyping | null }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const lastTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root || !cursor) { setPos(null); lastTarget.current = null; return; }
    const target = root.querySelector<HTMLElement>(`[data-live-id="${CSS.escape(cursor.target)}"]`);
    if (!target) { setPos(null); return; }
    if (lastTarget.current !== cursor.target) {
      lastTarget.current = cursor.target;
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
    // Like a collaborator's cursor in a shared document: a name flag sits just above the caret (or the target's
    // top-left corner before typing starts), so it never covers the line being written or the next one.
    const caret = target.querySelector<HTMLElement>("[data-live-caret]");
    const base = root.getBoundingClientRect();
    const rect = (caret ?? target).getBoundingClientRect();
    const x = (caret ? rect.left : rect.left + 2) - base.left + root.scrollLeft;
    const y = rect.top - base.top + root.scrollTop;
    setPos({ x, y });
  }, [container, cursor, typing]);
  if (!cursor || !pos) return null;
  return <div className={styles.aiCursor} style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, "--live-color": cursor.color } as CSSProperties} aria-hidden="true">
    <span>{cursor.label}</span>
  </div>;
}
