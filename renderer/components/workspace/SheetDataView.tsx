"use client";

import { useEffect, useMemo, useState } from "react";
import { ChartBlock } from "@/components/ChartBlock";
import {
  cellText,
  isFormulaCell,
  isNumericColumn,
  parseDelimited,
  quickChartSpec,
  readXlsxTables,
  sortAndFilter,
  splitHeader,
  uncachedFormulaLabel,
  type SortState,
  type TableSheet,
} from "@/lib/table-data";
import { announceVisual, fillComposer, type VisualArtifact } from "@/lib/visual-artifacts";
import styles from "./SheetDataView.module.css";

const SHOWN_ROWS = 500;
const MAX_BYTES = 32 * 1024 * 1024;

export function isSheetDataFile(name: string): boolean {
  return /\.(xlsx|xlsm|csv|tsv)$/i.test(name);
}

/** 표 파일을 읽어 시트 목록으로. xlsx 는 계산값 없는 수식 칸을 { formula } 로 남긴다. */
export async function loadSheets(name: string, fileUrl: string): Promise<TableSheet[]> {
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`read failed ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw new Error("too large");
  if (/\.(xlsx|xlsm)$/i.test(name)) return readXlsxTables(buffer);
  const text = new TextDecoder().decode(buffer);
  return [{ name: name.replace(/^.*[\\/]/, ""), rows: parseDelimited(text, /\.tsv$/i.test(name) ? "\t" : ",") }];
}

/**
 * 산출물 패널의 "데이터 보기" — 머리 고정 표, 열 머리 눌러 정렬(오름→내림→원래), 글자 필터, 숫자 열을 골라
 * 빠른 차트. 차트는 대화의 ```chart 와 같은 ChartBlock(같은 관문·같은 디자인)으로 그려지고 산출물 목록에 올라가며,
 * "대화창에 넣기" 는 그 ```chart 를 작성창에 채운다(보내지 않음). 원본 모양(서식·병합)은 "원본 보기"(기존 격자 뷰어).
 */
export function SheetDataView({
  name,
  fileUrl,
  chatId,
  locale,
  onOpenOriginal,
}: {
  name: string;
  fileUrl: string;
  chatId: string | null;
  locale: "ko" | "en";
  onOpenOriginal?: () => void;
}) {
  const ko = locale === "ko";
  const [sheets, setSheets] = useState<TableSheet[] | null>(null);
  const [error, setError] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [sort, setSort] = useState<SortState>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [category, setCategory] = useState(0);
  const [chart, setChart] = useState<{ id: string; spec: Record<string, unknown> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setError(false);
    void loadSheets(name, fileUrl).then((next) => { if (!cancelled) setSheets(next); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [name, fileUrl]);

  const sheet = sheets?.[sheetIndex] ?? null;
  const { columns, body } = useMemo(() => splitHeader(sheet?.rows ?? []), [sheet]);
  const numeric = useMemo(() => columns.map((_, index) => isNumericColumn(body, index)), [columns, body]);
  useEffect(() => {
    setSort(null);
    setPicked([]);
    setChart(null);
    const firstText = numeric.findIndex((value) => !value);
    setCategory(firstText >= 0 ? firstText : 0);
  }, [sheetIndex, numeric]);
  const rows = useMemo(() => sortAndFilter(body, sort, query, ko), [body, sort, query, ko]);
  const formulaCount = useMemo(() => body.reduce((sum, row) => sum + row.filter(isFormulaCell).length, 0), [body]);

  if (error) return <p className={styles.note} data-sheet-view="error">{ko ? "이 파일을 표로 읽지 못했어요. 원본 보기로 열어 주세요." : "This file could not be read as a table. Open the original instead."}</p>;
  if (!sheets) return <div className={styles.loading} data-sheet-view="loading" aria-busy="true" />;

  const cycleSort = (column: number) => {
    setSort((current) => (!current || current.column !== column ? { column, direction: "asc" }
      : current.direction === "asc" ? { column, direction: "desc" } : null));
  };
  const togglePick = (column: number) => setPicked((current) => (current.includes(column) ? current.filter((value) => value !== column) : [...current, column].slice(-6)));
  const makeChart = () => {
    const spec = quickChartSpec({ title: `${sheet?.name ?? name}`, columns, body: rows, category, values: picked, ko });
    const id = `quick:${name}:${sheetIndex}:${picked.join(",")}:${category}:${rows.length}`;
    setChart({ id, spec });
    if (chatId) {
      const visual: VisualArtifact = { id, chatId, kind: "chart", title: `${sheet?.name ?? name} · ${picked.map((index) => columns[index]).join(", ")}`, spec };
      announceVisual(visual);
    }
  };

  return <section className={styles.view} data-sheet-view="ready" aria-label={ko ? `${name} 데이터 보기` : `${name} data view`}>
    <div className={styles.toolbar}>
      {sheets.length > 1 && <div className={styles.tabs} role="tablist" aria-label={ko ? "시트" : "Sheets"}>
        {sheets.map((item, index) => (
          <button key={item.name} type="button" role="tab" aria-selected={index === sheetIndex} data-active={index === sheetIndex ? "true" : "false"}
            onClick={() => setSheetIndex(index)}>{item.name}</button>
        ))}
      </div>}
      <input className={styles.filter} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={ko ? "필터 — 모든 열에서 찾기" : "Filter — search all columns"} aria-label={ko ? "행 필터" : "Filter rows"} data-sheet-filter="true" />
      <span className={styles.count} data-sheet-count={rows.length}>
        {query ? (ko ? `${body.length}행 중 ${rows.length}행` : `${rows.length} of ${body.length} rows`) : (ko ? `${body.length}행` : `${body.length} rows`)}
      </span>
      {onOpenOriginal && <button type="button" className={styles.ghost} onClick={onOpenOriginal}>{ko ? "원본 보기" : "Original"}</button>}
    </div>
    {formulaCount > 0 && <p className={styles.note} data-sheet-formula-note={formulaCount}>
      {ko ? `수식 칸 ${formulaCount}개에 저장된 계산값이 없어 수식을 그대로 보여 줍니다(0 이 아닙니다). 엑셀에서 한 번 열어 저장하면 값이 채워집니다.`
        : `${formulaCount} formula cells have no saved value, so the formula is shown (not 0). Opening and saving in Excel fills the values.`}
    </p>}
    <div className={styles.chartBar}>
      <label>
        <span>{ko ? "범주" : "Category"}</span>
        <select value={category} onChange={(event) => setCategory(Number(event.target.value))} data-sheet-category="true">
          {columns.map((column, index) => <option key={column} value={index}>{column}</option>)}
        </select>
      </label>
      <span className={styles.hint}>{picked.length === 0
        ? (ko ? "숫자 열 머리의 □ 로 값을 고르세요" : "Pick value columns with □ in numeric headers")
        : picked.map((index) => columns[index]).join(", ")}</span>
      <button type="button" className={styles.primary} disabled={picked.length === 0} onClick={makeChart} data-sheet-quick-chart="true">
        {ko ? "빠른 차트" : "Quick chart"}
      </button>
    </div>
    {chart && <div className={styles.chart} data-sheet-chart="true">
      <ChartBlock key={chart.id} code={JSON.stringify(chart.spec)} presetSpec={chart.spec} blockId={chart.id} size="panel" fallback={null} />
      <div className={styles.chartActions}>
        <button type="button" className={styles.ghost} data-sheet-chart-to-composer="true"
          onClick={() => fillComposer(`\`\`\`chart\n${JSON.stringify(chart.spec)}\n\`\`\``, null, 20_000)}>
          {ko ? "대화창에 넣기" : "Put in composer"}
        </button>
      </div>
    </div>}
    <div className={styles.tableWrap}>
      <table className={styles.table} data-sheet-table="true">
        <thead>
          <tr>
            {columns.map((column, index) => {
              const active = sort?.column === index ? sort.direction : null;
              return <th key={column} className={numeric[index] ? styles.num : undefined} aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : "none"}>
                <span className={styles.head}>
                  {numeric[index] && <input type="checkbox" checked={picked.includes(index)} onChange={() => togglePick(index)}
                    aria-label={ko ? `${column} 을 차트에` : `Chart ${column}`} data-sheet-pick={index} />}
                  <button type="button" onClick={() => cycleSort(index)} data-sheet-sort={index} title={ko ? "눌러서 정렬" : "Click to sort"}>
                    {column}<span className={styles.sortMark} aria-hidden="true">{active === "asc" ? "↑" : active === "desc" ? "↓" : ""}</span>
                  </button>
                </span>
              </th>;
            })}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, SHOWN_ROWS).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => {
                const formula = isFormulaCell(cell);
                return <td key={index} className={`${numeric[index] ? styles.num : ""} ${formula ? styles.formula : ""}`}
                  title={formula ? uncachedFormulaLabel(ko) : undefined} data-formula-cell={formula ? "true" : undefined}>
                  {cellText(cell, ko)}
                </td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > SHOWN_ROWS && <p className={styles.note}>{ko ? `처음 ${SHOWN_ROWS}행만 보여 줍니다.` : `Showing the first ${SHOWN_ROWS} rows.`}</p>}
    </div>
  </section>;
}
