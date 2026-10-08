"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconFileText, IconLayers } from "@/components/Icon";
import { diffLines, splitDiffRows, type LineDiffRow } from "./line-diff";
import styles from "./AgentWorkspace.module.css";

export type WorkspaceDiffFile = { path: string; beforeContent: string | null; afterContent: string | null; beforeHash?: string | null; afterHash?: string | null; binary?: boolean; beforeExecutable?: boolean; afterExecutable?: boolean; operation?: "create" | "modify" | "delete" };

function DiffCell({ row, side }: { row: LineDiffRow | null; side: "before" | "after" }) {
  return <div className={`${styles.diffCell} ${row ? styles[row.kind] : styles.diffBlank}`}>
    <span className={styles.lineNumber}>{side === "before" ? row?.beforeLine : row?.afterLine}</span>
    <span className={styles.lineSign}>{row?.kind === "remove" ? "−" : row?.kind === "add" ? "+" : ""}</span>
    <code>{row?.text || " "}</code>
  </div>;
}

export function AgentWorkspaceDiff({ files, locale, activePath, onPathChange, beforeLabel, afterLabel }: {
  files: WorkspaceDiffFile[]; locale: string; activePath?: string | null; onPathChange?: (path: string) => void;
  beforeLabel?: string; afterLabel?: string;
}) {
  const ko = locale === "ko";
  const [localPath, setLocalPath] = useState(files[0]?.path ?? "");
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [viewportWidth, setViewportWidth] = useState(620);
  const [compact, setCompact] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const path = activePath ?? localPath;
  const file = files.find((candidate) => candidate.path === path) ?? files[0];
  const rows = useMemo(() => file?.binary ? [] : diffLines(file?.beforeContent ?? "", file?.afterContent ?? ""), [file?.beforeContent, file?.afterContent, file?.binary]);
  const splitRows = useMemo(() => splitDiffRows(rows), [rows]);
  const totals = useMemo(() => ({
    add: rows.filter((line) => line.kind === "add").length,
    remove: rows.filter((line) => line.kind === "remove").length,
  }), [rows]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { setViewportHeight(element.clientHeight); setViewportWidth(element.clientWidth); setCompact(element.clientWidth < 620); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (viewport.current) viewport.current.scrollTop = 0; setScrollTop(0); }, [file?.path]);
  const split = mode === "split" && !compact;
  const beforeTerminated = (file?.beforeContent ?? "").endsWith("\n");
  const afterTerminated = (file?.afterContent ?? "").endsWith("\n");
  const count = split ? splitRows.length : rows.length;
  const longest = useMemo(() => rows.reduce((max, row) => Math.max(max, Array.from(row.text).reduce((columns, character) => columns + (character === "\t" ? 2 : (character.codePointAt(0) ?? 0) > 127 ? 2 : 1), 0)), 0), [rows]);
  const canvasWidth = Math.max(viewportWidth, (longest * 7.8 + 110) * (split ? 2 : 1));
  const start = Math.max(0, Math.floor(scrollTop / 22) - 20);
  const end = Math.min(count, start + Math.ceil(viewportHeight / 22) + 40);
  return <div className={styles.diff} data-testid="agent-workspace-diff">
    <div className={styles.diffToolbar}>
      <IconFileText size={15} />
      <select aria-label={ko ? "변경 파일" : "Changed file"} value={file?.path ?? ""} onChange={(event) => { setLocalPath(event.target.value); onPathChange?.(event.target.value); }}>
        {files.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
      </select>
      {file?.operation && <span className={styles.state}>{file.operation === "create" ? (ko ? "새 파일" : "Create") : file.operation === "delete" ? (ko ? "삭제" : "Delete") : (ko ? "수정" : "Modify")}</span>}
      <span className={styles.addCount} title={ko ? "현재 파일의 추가 줄" : "Added lines in this file"}>+{totals.add}</span><span className={styles.removeCount} title={ko ? "현재 파일의 삭제 줄" : "Removed lines in this file"}>−{totals.remove}</span>
      <button className={styles.iconButton} title={split ? (ko ? "통합 diff" : "Unified diff") : (ko ? "분할 diff" : "Split diff")} aria-label={split ? (ko ? "통합 diff" : "Unified diff") : (ko ? "분할 diff" : "Split diff")} onClick={() => setMode(split ? "unified" : "split")}><IconLayers size={16} /></button>
    </div>
    {file && file.beforeExecutable !== file.afterExecutable && <div className={styles.banner}>{ko ? "실행 권한" : "Executable permission"}: {file.beforeExecutable ? (ko ? "있음" : "yes") : (ko ? "없음" : "no")} → {file.afterExecutable ? (ko ? "있음" : "yes") : (ko ? "없음" : "no")}</div>}
    {file && !file.binary && beforeTerminated !== afterTerminated && <div className={styles.banner}>{ko ? "마지막 줄바꿈" : "Final newline"}: {beforeTerminated ? (ko ? "있음" : "present") : (ko ? "없음" : "absent")} → {afterTerminated ? (ko ? "있음" : "present") : (ko ? "없음" : "absent")}</div>}
    <div className={styles.diffHead}>{split ? <><span>{beforeLabel ?? (ko ? "현재 파일" : "Current file")}</span><span>{afterLabel ?? (ko ? "변경 후" : "Proposed file")}</span></> : <span>{beforeLabel ?? (ko ? "현재" : "Current")} → {afterLabel ?? (ko ? "변경 후" : "Proposed")}</span>}</div>
    <div ref={viewport} className={styles.diffViewport} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} role="table" aria-label={ko ? "파일 내용 차이" : "File content diff"} aria-rowcount={count}>
      {file?.binary ? <div className={styles.empty}><IconFileText size={30} /><strong>{ko ? "바이너리 파일 변경" : "Binary file change"}</strong><dl className={styles.definition}><dt>{ko ? "현재 해시" : "Current hash"}</dt><dd><code>{file.beforeHash ?? "—"}</code></dd><dt>{ko ? "변경 후 해시" : "Proposed hash"}</dt><dd><code>{file.afterHash ?? "—"}</code></dd></dl></div> : <div style={{ height: count * 22, position: "relative", width: canvasWidth }}>
        {Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          if (split) return <div className={styles.splitRow} style={{ top: index * 22 }} role="row" aria-rowindex={index + 1} key={index}><DiffCell row={splitRows[index].before} side="before" /><DiffCell row={splitRows[index].after} side="after" /></div>;
          const row = rows[index];
          return <div className={`${styles.unifiedRow} ${styles[row.kind]}`} style={{ top: index * 22 }} role="row" aria-rowindex={index + 1} key={index}><span className={styles.lineNumber}>{row.beforeLine}</span><span className={styles.lineNumber}>{row.afterLine}</span><span className={styles.lineSign}>{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}</span><code>{row.text || " "}</code></div>;
        })}
      </div>}
      {count === 0 && !file?.binary && <div className={styles.empty}>{ko ? "내용 변경 없음" : "No content changes"}</div>}
    </div>
  </div>;
}
