"use client";

import { useState, type ReactNode } from "react";
import type { LiveDocumentModel, LiveFormat } from "@shared/live-document";
import { IconPlus, IconTrash } from "@/components/Icon";
import styles from "./LiveDocumentRibbon.module.css";

/*
 * Office-style ribbon for the Document tab: 홈 (undo/redo, paragraph style, size, bold/italic/underline, colour,
 * alignment) and 삽입 (paragraph, table, slide, sheet). Every button turns into the same typed op the AI sends
 * (set_format, insert_*), applied to the selected paragraph, table cell, slide shape or sheet cell.
 */

export type RibbonKind = LiveDocumentModel["kind"];

export interface RibbonProps {
  locale: "ko" | "en";
  kind: RibbonKind;
  /** Selected target and its current format; null when nothing is selected. */
  target: string | null;
  format: LiveFormat;
  heading: number | undefined;
  supports: (op: string) => boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onFormat: (format: LiveFormat) => void;
  onHeading: (level: number) => void;
  onInsertParagraph: () => void;
  onInsertTable: (rows: number, cols: number) => void;
  onDeleteBlock?: () => void;
  onAddSlide?: () => void;
  onAddSheet?: () => void;
}

const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 60, 72];
const COLORS = ["#000000", "#404040", "#7f7f7f", "#c00000", "#e36c09", "#d4a017", "#2f9e44", "#1c7ed6", "#1f3a93", "#7048e8"];
const DEFAULT_SIZE: Record<RibbonKind, number> = { flow: 10.5, sheet: 11, slides: 18 };

export function LiveDocumentRibbon(props: RibbonProps) {
  const ko = props.locale === "ko";
  const [tab, setTab] = useState<"home" | "insert">("home");
  const [palette, setPalette] = useState(false);
  const disabled = !props.target || !props.supports("set_format");
  const size = props.format.size ?? DEFAULT_SIZE[props.kind];
  const step = (direction: 1 | -1) => {
    const index = SIZES.findIndex((value) => value >= size);
    const next = direction > 0 ? SIZES[Math.min(SIZES.length - 1, (SIZES[index] === size ? index : index - 1) + 1)] : SIZES[Math.max(0, (index < 0 ? SIZES.length : index) - 1)];
    props.onFormat({ size: next });
  };
  return (
    <div className={styles.ribbon} data-live-ribbon="true">
      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === "home"} data-active={tab === "home"} onClick={() => setTab("home")}>{ko ? "홈" : "Home"}</button>
        <button type="button" role="tab" aria-selected={tab === "insert"} data-active={tab === "insert"} onClick={() => setTab("insert")}>{ko ? "삽입" : "Insert"}</button>
      </div>
      {tab === "home" ? (
        <div className={styles.groups}>
          <Group>
            <Btn label={ko ? "실행 취소" : "Undo"} disabled={!props.canUndo} onClick={props.onUndo}><Glyph d="M5 7h7a4 4 0 0 1 0 8H8M5 7l3-3M5 7l3 3" /></Btn>
            <Btn label={ko ? "다시 실행" : "Redo"} disabled={!props.canRedo} onClick={props.onRedo}><Glyph d="M15 7H8a4 4 0 0 0 0 8h4M15 7l-3-3M15 7l-3 3" /></Btn>
          </Group>
          {props.kind === "flow" && props.supports("set_format") && (
            <Group>
              <select className={styles.select} aria-label={ko ? "문단 스타일" : "Paragraph style"} disabled={disabled || props.target?.includes(".") === true}
                value={String(props.heading ?? 0)} onChange={(event) => props.onHeading(Number(event.target.value))}>
                <option value="0">{ko ? "본문" : "Body"}</option>
                <option value="1">{ko ? "제목 1" : "Heading 1"}</option>
                <option value="2">{ko ? "제목 2" : "Heading 2"}</option>
                <option value="3">{ko ? "제목 3" : "Heading 3"}</option>
              </select>
            </Group>
          )}
          <Group>
            <select className={`${styles.select} ${styles.size}`} aria-label={ko ? "글자 크기" : "Font size"} disabled={disabled}
              value={String(size)} onChange={(event) => props.onFormat({ size: Number(event.target.value) })}>
              {[...new Set([...SIZES, size])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <Btn label={ko ? "글자 크게" : "Grow font"} disabled={disabled} onClick={() => step(1)}><span className={styles.textGlyph}>A<sup>+</sup></span></Btn>
            <Btn label={ko ? "글자 작게" : "Shrink font"} disabled={disabled} onClick={() => step(-1)}><span className={styles.textGlyph}>A<sup>−</sup></span></Btn>
          </Group>
          <Group>
            <Btn label={ko ? "굵게" : "Bold"} active={props.format.bold} disabled={disabled} onClick={() => props.onFormat({ bold: !props.format.bold })}><b className={styles.textGlyph}>B</b></Btn>
            <Btn label={ko ? "기울임" : "Italic"} active={props.format.italic} disabled={disabled} onClick={() => props.onFormat({ italic: !props.format.italic })}><i className={styles.textGlyph}>I</i></Btn>
            <Btn label={ko ? "밑줄" : "Underline"} active={props.format.underline} disabled={disabled} onClick={() => props.onFormat({ underline: !props.format.underline })}><u className={styles.textGlyph}>U</u></Btn>
            <span className={styles.colorWrap}>
              <Btn label={ko ? "글자 색" : "Font color"} disabled={disabled} onClick={() => setPalette((open) => !open)}>
                <span className={styles.textGlyph}>A</span><span className={styles.colorBar} style={{ background: props.format.color ?? "#000000" }} />
              </Btn>
              {palette && !disabled && <span className={styles.palette} role="menu">
                {COLORS.map((color) => <button key={color} type="button" role="menuitem" aria-label={color} style={{ background: color }} onClick={() => { setPalette(false); props.onFormat({ color }); }} />)}
              </span>}
            </span>
          </Group>
          <Group>
            {(["left", "center", "right", "justify"] as const).map((align) => (
              <Btn key={align} label={ko ? { left: "왼쪽 정렬", center: "가운데 정렬", right: "오른쪽 정렬", justify: "양쪽 정렬" }[align] : `Align ${align}`}
                active={props.format.align === align} disabled={disabled} onClick={() => props.onFormat({ align })}>
                <AlignGlyph align={align} />
              </Btn>
            ))}
          </Group>
          {!props.target && <span className={styles.hint}>{ko ? "서식을 바꿀 문단·셀·도형을 먼저 누르세요" : "Select a paragraph, cell or shape to format it"}</span>}
        </div>
      ) : (
        <div className={styles.groups}>
          {props.kind === "flow" && props.supports("insert_paragraph") && <Group><Wide label={ko ? "문단" : "Paragraph"} onClick={props.onInsertParagraph}><IconPlus size={14} /></Wide></Group>}
          {props.kind === "flow" && props.supports("insert_table") && <Group><TablePicker ko={ko} onPick={props.onInsertTable} /></Group>}
          {props.kind === "flow" && props.onDeleteBlock && <Group><Wide label={ko ? "블록 삭제" : "Delete block"} onClick={props.onDeleteBlock}><IconTrash size={14} /></Wide></Group>}
          {props.kind === "slides" && props.onAddSlide && <Group><Wide label={ko ? "새 슬라이드" : "New slide"} onClick={props.onAddSlide}><IconPlus size={14} /></Wide></Group>}
          {props.kind === "sheet" && props.onAddSheet && <Group><Wide label={ko ? "새 시트" : "New sheet"} onClick={props.onAddSheet}><IconPlus size={14} /></Wide></Group>}
          {props.kind === "flow" && !props.supports("insert_table") && <span className={styles.hint}>{ko ? "이 형식은 표 삽입을 아직 지원하지 않습니다" : "This format cannot insert tables yet"}</span>}
        </div>
      )}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className={styles.group}>{children}</div>;
}

function Btn({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return <button type="button" className={styles.btn} aria-label={label} title={label} aria-pressed={active ? true : undefined}
    data-active={active ? "true" : "false"} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}

function Wide({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={styles.wide} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}<span>{label}</span></button>;
}

function Glyph({ d }: { d: string }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function AlignGlyph({ align }: { align: "left" | "center" | "right" | "justify" }) {
  const rows = [[3, 17], align === "justify" ? [3, 17] : align === "left" ? [3, 12] : align === "right" ? [8, 17] : [5.5, 14.5], [3, 17], align === "justify" ? [3, 17] : align === "left" ? [3, 10] : align === "right" ? [10, 17] : [6.5, 13.5]];
  return <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">{rows.map(([x1, x2], i) => <line key={i} x1={x1} x2={x2} y1={4.5 + i * 3.7} y2={4.5 + i * 3.7} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />)}</svg>;
}

function TablePicker({ ko, onPick }: { ko: boolean; onPick: (rows: number, cols: number) => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  return <span className={styles.colorWrap}>
    <button type="button" className={styles.wide} onClick={() => setOpen((value) => !value)}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M1.5 6.5h13M1.5 10h13M6 2.5v11M10.5 2.5v11" stroke="currentColor" strokeWidth="1.1" /></svg>
      <span>{ko ? "표" : "Table"}</span>
    </button>
    {open && <span className={styles.tableGrid} role="grid" onMouseLeave={() => setHover([0, 0])}>
      <span className={styles.tableLabel}>{hover[0] ? `${hover[0]} × ${hover[1]}` : (ko ? "크기 선택" : "Pick a size")}</span>
      {Array.from({ length: 6 }, (_, r) => Array.from({ length: 8 }, (_, c) => (
        <button key={`${r}-${c}`} type="button" aria-label={`${r + 1} × ${c + 1}`} data-on={r < hover[0] && c < hover[1] ? "true" : "false"}
          onMouseEnter={() => setHover([r + 1, c + 1])} onClick={() => { setOpen(false); onPick(r + 1, c + 1); }} />
      )))}
    </span>}
  </span>;
}
