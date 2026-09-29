"use client";

import { useEffect, useRef, useState } from "react";
import { cellText, readDocxLines, splitHeader } from "@/lib/table-data";
import { loadSheets } from "./SheetDataView";
import styles from "./ArtifactsRailPanel.module.css";

const THUMB_MAX_BYTES = 12 * 1024 * 1024;

function fileViewerAsset(path: string): string {
  const current = new URL(window.location.href);
  const root = current.protocol === "file:" ? new URL("./file-viewer/", document.baseURI) : new URL("/file-viewer/", current.origin);
  return new URL(path, root).href;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > THUMB_MAX_BYTES) throw new Error("too large");
  return buffer;
}

/** PDF 첫 쪽 — 이미 앱에 묶여 있는 pdf.js(파일 뷰어가 쓰는 같은 판)와 같은 워커 자산. */
async function drawPdfFirstPage(url: string, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = fileViewerAsset("vendor/pdf/pdf.worker.mjs");
  const data = new Uint8Array(await fetchBytes(url));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = (width * 2) / base.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
  } finally {
    void doc.destroy();
  }
}

type Thumb =
  | { kind: "sheet"; columns: string[]; rows: string[][] }
  | { kind: "lines"; lines: string[] }
  | { kind: "pdf" }
  | { kind: "image" }
  | { kind: "none" };

/**
 * 산출물 "콘텐츠" 격자의 파일 미리보기 — 표는 첫 행 몇 줄, docx 는 첫 글줄, PDF 는 첫 쪽, 그림은 그림.
 * 못 읽으면 조용히 이름·종류 칩만(목록은 그대로 쓸 수 있다).
 */
export function FileThumb({ name, fileUrl, kind, ko }: { name: string; fileUrl: string | null; kind: string; ko: boolean }) {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    setThumb(null);
    if (!fileUrl) { setThumb({ kind: "none" }); return undefined; }
    void (async () => {
      try {
        if (kind === "spreadsheet" && /\.(xlsx|xlsm|csv|tsv)$/i.test(name)) {
          const sheets = await loadSheets(name, fileUrl);
          const { columns, body } = splitHeader(sheets[0]?.rows ?? []);
          if (!cancelled) setThumb({ kind: "sheet", columns: columns.slice(0, 4), rows: body.slice(0, 6).map((row) => row.slice(0, 4).map((cell) => cellText(cell, ko))) });
        } else if (kind === "document" && /\.docx$/i.test(name)) {
          const lines = await readDocxLines(await fetchBytes(fileUrl), 10);
          if (!cancelled) setThumb({ kind: "lines", lines });
        } else if (kind === "pdf") {
          if (!cancelled) setThumb({ kind: "pdf" });
        } else if (kind === "image") {
          if (!cancelled) setThumb({ kind: "image" });
        } else if (!cancelled) setThumb({ kind: "none" });
      } catch {
        if (!cancelled) setThumb({ kind: "none" });
      }
    })();
    return () => { cancelled = true; };
  }, [name, fileUrl, kind, ko]);
  useEffect(() => {
    if (thumb?.kind !== "pdf" || !fileUrl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    void drawPdfFirstPage(fileUrl, canvas, 160).then(() => canvas.setAttribute("data-pdf-drawn", "true")).catch(() => setThumb({ kind: "none" }));
  }, [thumb, fileUrl]);

  if (!thumb) return <span className={styles.thumbLoading} aria-hidden="true" />;
  if (thumb.kind === "sheet") {
    return <span className={styles.thumbSheet} data-file-thumb="sheet" aria-hidden="true">
      <span className={styles.thumbSheetRow} data-head="true">{thumb.columns.map((column, index) => <span key={index}>{column}</span>)}</span>
      {thumb.rows.map((row, rowIndex) => <span key={rowIndex} className={styles.thumbSheetRow}>{row.map((cell, index) => <span key={index}>{cell}</span>)}</span>)}
    </span>;
  }
  if (thumb.kind === "lines") {
    return <span className={styles.thumbPage} data-file-thumb="docx" aria-hidden="true">
      {thumb.lines.map((line, index) => <span key={index} data-first={index === 0 ? "true" : undefined}>{line}</span>)}
    </span>;
  }
  if (thumb.kind === "pdf") return <canvas ref={canvasRef} className={styles.thumbCanvas} data-file-thumb="pdf" aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  if (thumb.kind === "image" && fileUrl) return <img className={styles.thumbImage} src={fileUrl} alt="" data-file-thumb="image" />;
  return <span className={styles.thumbName} data-file-thumb="none">{name}</span>;
}
