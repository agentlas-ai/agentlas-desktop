"use client";
import { useId, useMemo, useState } from "react";
import { IconArrowUp, IconChevronLeft, IconChevronRight } from "@/components/Icon";
import type { FinanceDataResult, FinanceWidget } from "@shared/finance";
import { useT } from "@/lib/i18n";
import { ChartBlock } from "@/components/ChartBlock";
import { financeCell, financeColumn } from "./FinanceMessage";
import styles from "./FinanceDataResultView.module.css";
import { financeDataVisual, financeDataChartSpec, financeMetricForColumns, financeTenorLabel } from "@shared/finance-data-visual";
export { financeDataVisual, financeMetricForColumns, financeTenorLabel, financeCompactTreasuryTitle } from "@shared/finance-data-visual";
export type { FinanceDataVisual } from "@shared/finance-data-visual";

export interface FinanceDataResultViewProps {
  result: FinanceDataResult;
  metric?: string;
  locale?: "ko" | "en";
  title?: string;
  compact?: boolean;
  showVisual?: boolean;
  chartType?: FinanceWidget["chartType"];
  selectedSeries?: string;
  onSeriesChange?: (series:string)=>void;
  /** Optional: shows a labeled "Retry" button in the error and empty states. */
  onRetry?: ()=>void;
}
const PAGE_SIZE=50;
export function FinanceDataResultView({result,metric:requestedMetric,locale,title,compact=false,showVisual=true,chartType,selectedSeries:controlledSeries,onSeriesChange,onRetry}:FinanceDataResultViewProps) {
  const metric=requestedMetric??financeMetricForColumns(result.columns);
  const i18n=useT();const ko=(locale??i18n.locale)==="ko";const t=(a:string,b:string)=>ko?a:b;
  const column=(value:string)=>ko?({"Observation date":"관측일","Close (raw)":"원종가","Maturity":"만기","Par curve yield":"액면 수익률","Unit":"단위","Fund":"펀드","NAV per share":"주당 NAV","NAV date":"NAV 기준일","Price basis":"가격 기준","Open":"시가","High":"고가","Low":"저가"} as Record<string,string>)[value]??financeColumn(value,true):value;
  const id=useId();const [selectedSeries,setSelectedSeries]=useState("");const [page,setPage]=useState(0);const [columnPage,setColumnPage]=useState(0);
  const visual=useMemo(()=>financeDataVisual(result,metric,controlledSeries??selectedSeries),[result,metric,selectedSeries,controlledSeries]);
  const pages=Math.max(1,Math.ceil(result.rows.length/PAGE_SIZE)),current=Math.min(page,pages-1);
  const columnPages=Math.max(1,Math.ceil(result.columns.length/50)),currentColumn=Math.min(columnPage,columnPages-1);
  const visibleColumns=result.columns.slice(currentColumn*50,(currentColumn+1)*50);
  const rows=result.rows.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
  const displayNumber=(value:number)=>new Intl.NumberFormat(ko?"ko-KR":"en-US",value!==0&&Math.abs(value)<.005?{maximumSignificantDigits:2}:{maximumFractionDigits:2}).format(value);
  const chartSpec=financeDataChartSpec(visual,chartType,ko);
  const displayVisual=showVisual&&chartType!=="table";
  const scalar=(value:number,unit:string,date:string,label:string)=><div className={styles.scalar}><span className={styles.scalarLabel} title={label}>{label}</span><strong title={String(value)}>{displayNumber(value)} <small>{unit}</small></strong><time dateTime={date}>{date}</time></div>;
  const financeVisual=displayVisual&&visual.nav?scalar(visual.nav.value,visual.nav.currency??t("통화 미확인","Currency unknown"),visual.nav.date,`${visual.nav.fund} · NAV`):displayVisual&&(visual.kind==="history"||visual.kind==="treasury"||visual.kind==="series")?<div className={styles.visual}>
    {visual.kind==="treasury"&&<div className={styles.toolbar}><label className={styles.label} htmlFor={`${id}-tenor`}><span className={styles.srOnly}>{t("만기","Maturity")}</span><select id={`${id}-tenor`} value={visual.label} onChange={event=>{setSelectedSeries(event.target.value);onSeriesChange?.(event.target.value);}}>{visual.series.map(series=><option key={series} value={series}>{financeTenorLabel(series)}</option>)}</select></label></div>}
    {visual.points.length===1?scalar(visual.points[0].value,visual.kind==="treasury"?t("% 연율","% p.a."):visual.unit??t("통화 미확인","Currency unknown"),visual.points[0].date,`${visual.kind==="treasury"?financeTenorLabel(visual.label):visual.label} · ${visual.kind==="treasury"?t("수익률","Yield"):visual.kind==="series"?t("값","Value"):t("종가","Close")}`):<div className={styles.chartViewport}><ChartBlock code={JSON.stringify(chartSpec)} presetSpec={chartSpec} blockId={`finance-data:${id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p className={styles.notice} role="status">{t("차트를 표시하지 못했습니다.","Chart unavailable.")}</p>}/></div>}
  </div>:null;
  const tableContent=<>
    {result.columns.length>0?<div className={styles.scroll} tabIndex={0} role="region" aria-label={compact?t("금융 자료","Financial data"):undefined} aria-labelledby={compact?undefined:`${id}-table`}><table><caption className={styles.srOnly}>{compact?t("금융 자료","Financial data"):t("조회 결과 원자료 · 페이지당 50행","Raw query result · 50 rows per page")}</caption><thead><tr>{visibleColumns.map((name,index)=><th key={index} scope="col">{column(name)}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={current*PAGE_SIZE+index}>{visibleColumns.map((column,index)=>{const columnIndex=currentColumn*50+index;const value=row[columnIndex];return <td key={columnIndex} className={typeof value==="number"?styles.number:undefined}>{typeof value==="string"&&/^https?:\/\//i.test(value)?<a href={value} target="_blank" rel="noopener noreferrer" title={t("열기","Open")} aria-label={t("열기","Open")}><span className={styles.extIcon}><IconArrowUp size={14}/></span></a>:typeof value==="number"?displayNumber(value):financeCell(value??null,column,ko)}</td>;})}</tr>)}</tbody></table></div>:<p className={styles.notice}>{t("표시할 열이 없습니다.","No columns are available.")}</p>}
    {columnPages>1&&<nav className={styles.paging} aria-label={compact?t("표 열 페이지","Table column pages"):t("원자료 열 페이지","Source column pages")}><button type="button" disabled={currentColumn===0} aria-label={t("이전 열","Previous columns")} title={t("이전 열","Previous columns")} onClick={()=>setColumnPage(currentColumn-1)}><IconChevronLeft size={14}/></button><span>{t("열","Columns")} {currentColumn*50+1}–{Math.min((currentColumn+1)*50,result.columns.length)} / {result.columns.length}</span><button type="button" disabled={currentColumn===columnPages-1} aria-label={t("다음 열","Next columns")} title={t("다음 열","Next columns")} onClick={()=>setColumnPage(currentColumn+1)}><IconChevronRight size={14}/></button></nav>}
    {!result.rows.length&&<p className={styles.muted}>{t("확인된 결과 행이 없습니다.","No verified result rows.")}</p>}
    {pages>1&&<nav className={styles.paging} aria-label={compact?t("표 페이지","Table pages"):t("원자료 페이지","Source data pages")}><button disabled={current===0} aria-label={t("이전","Previous")} title={t("이전","Previous")} onClick={()=>setPage(current-1)} type="button"><IconChevronLeft size={14}/></button><span aria-live="polite">{current+1} / {pages}</span><button disabled={current===pages-1} aria-label={t("다음","Next")} title={t("다음","Next")} onClick={()=>setPage(current+1)} type="button"><IconChevronRight size={14}/></button></nav>}
  </>;
  return <section className={`${styles.root} ${compact?styles.compact:""}`} aria-label={title??t("금융 자료","Financial data")}>
    {!compact&&title&&<header className={styles.header}><h3>{title}</h3></header>}
    {result.status==="error"||result.status==="unconnected"||!result.rows.length?<p className={styles.notice} role={result.status==="error"?"alert":"status"}>{result.status==="error"?t("자료를 표시하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.","Data could not be shown. Check your connection and try again."):t("표시할 자료가 없습니다. 종목이나 기간을 바꿔 다시 조회하세요.","No data to show. Change the asset or period and try again.")}{onRetry&&<button type="button" className={styles.retry} onClick={onRetry}>{t("다시 시도","Retry")}</button>}</p>:financeVisual??tableContent}
  </section>;
}
