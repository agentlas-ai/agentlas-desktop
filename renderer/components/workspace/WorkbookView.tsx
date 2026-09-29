"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChartBlock } from "@/components/ChartBlock";
import { IconClose } from "@/components/Icon";
import { readXlsxCharts, readXlsxTables, xlsxChartSpec, type XlsxChart } from "@/lib/table-data";
import { SheetDataView } from "./SheetDataView";
import styles from "./WorkbookView.module.css";

type Tab = "data" | "charts" | "table";

/**
 * Claude 급 xlsx 뷰어(레퍼런스 f011·f014·f016·f019):
 *  - "Data" = 이미 있는 격자 뷰어(@file-viewer: 시트 탭·셀 서식·병합·열 너비·fx 막대·셀 선택·작업 맥락 전달) 그대로.
 *  - "Charts N" = 통합문서 안의 네이티브 차트(xl/charts)를 시트 이름과 함께, 대화 차트와 같은 ChartBlock 으로.
 *  - "표 도구" = 정렬·필터·빠른 차트(SheetDataView).
 * 닫기(✕)는 이 파일 탭을 닫고 보던 곳(산출물 등)으로 돌아간다.
 */
export function WorkbookView({
  name,
  fileUrl,
  chatId,
  locale,
  data,
  onClose,
}: {
  name: string;
  fileUrl: string;
  chatId: string | null;
  locale: "ko" | "en";
  data: ReactNode;
  onClose?: () => void;
}) {
  const ko = locale === "ko";
  const [tab, setTab] = useState<Tab>("data");
  const [charts, setCharts] = useState<XlsxChart[] | null>(null);
  const [chartIndex, setChartIndex] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setCharts(null);
    setChartIndex(0);
    void (async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(String(response.status));
        const buffer = await response.arrayBuffer();
        const sheets = await readXlsxTables(buffer);
        const found = await readXlsxCharts(buffer, sheets);
        if (!cancelled) setCharts(found);
      } catch {
        if (!cancelled) setCharts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [fileUrl]);
  const selected = charts?.[chartIndex] ?? null;
  const spec = useMemo(() => (selected ? xlsxChartSpec(selected, ko) : null), [selected, ko]);

  return <section className={styles.workbook} data-workbook-view="true" aria-label={ko ? `${name} 통합문서` : `${name} workbook`}>
    <div className={styles.bar}>
      <div className={styles.tabs} role="tablist" aria-label={ko ? "통합문서 보기" : "Workbook views"}>
        <button type="button" role="tab" aria-selected={tab === "data"} data-active={tab === "data" ? "true" : "false"} onClick={() => setTab("data")} data-workbook-tab="data">
          <TableGlyph />Data
        </button>
        <button type="button" role="tab" aria-selected={tab === "charts"} data-active={tab === "charts" ? "true" : "false"} onClick={() => setTab("charts")} data-workbook-tab="charts">
          <ChartGlyph />Charts
          <span className={styles.count} data-workbook-chart-count={charts?.length ?? ""}>{charts === null ? "…" : charts.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "table"} data-active={tab === "table" ? "true" : "false"} onClick={() => setTab("table")} data-workbook-tab="table">
          {ko ? "표 도구" : "Table tools"}
        </button>
      </div>
      {onClose && <button type="button" className={styles.close} onClick={onClose} aria-label={ko ? "파일 닫기" : "Close file"} data-workbook-close="true">
        <IconClose size={15} />
      </button>}
    </div>
    <div className={styles.body} data-workbook-body={tab}>
      {/* Data 는 숨겨도 살려 둔다 — 셀 선택·확대 상태를 탭 전환 때 잃지 않게. */}
      <div className={styles.pane} hidden={tab !== "data"}>{data}</div>
      {tab === "charts" && <div className={styles.charts}>
        {charts === null && <div className={styles.loading} aria-busy="true" />}
        {charts && charts.length === 0 && <p className={styles.empty}>{ko ? "이 통합문서에는 차트가 없어요." : "This workbook has no charts."}</p>}
        {charts && charts.length > 0 && <>
          <div className={styles.chartTabs} role="tablist" aria-label={ko ? "통합문서 차트" : "Workbook charts"}>
            {charts.map((item, index) => (
              <button key={`${item.sheetName}:${index}`} type="button" role="tab" aria-selected={index === chartIndex}
                data-active={index === chartIndex ? "true" : "false"} onClick={() => setChartIndex(index)} data-workbook-chart={index}>
                <strong>{item.title}</strong>
                <span>{item.sheetName}</span>
              </button>
            ))}
          </div>
          {spec && selected && <div className={styles.chartStage}>
            <ChartBlock key={`${chartIndex}:${selected.title}`} code={JSON.stringify(spec)} presetSpec={spec} blockId={`workbook:${name}:${chartIndex}`} size="panel" fallback={null} />
          </div>}
        </>}
      </div>}
      {tab === "table" && <div className={styles.table}>
        <SheetDataView name={name} fileUrl={fileUrl} chatId={chatId} locale={locale} />
      </div>}
    </div>
  </section>;
}

function TableGlyph() {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11" />
  </svg>;
}

function ChartGlyph() {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M2.5 13.5h11" /><path d="M4.5 11V7.5" /><path d="M8 11V4" /><path d="M11.5 11V6" />
  </svg>;
}
