"use client";
import { useId, useMemo, useState } from "react";
import { IconArrowUp, IconChevronLeft, IconChevronRight } from "@/components/Icon";
import type { FinanceDataResult, FinanceWidget } from "@shared/finance";
import { useT } from "@/lib/i18n";
import { ChartBlock } from "@/components/ChartBlock";
import { financeCell, financeColumn } from "./FinanceMessage";
import styles from "./FinanceDataResultView.module.css";

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
}
type Observation = { date: string; value: number };
export interface FinanceDataVisual {
  kind: "history" | "treasury" | "nav" | "table";
  reason?: "shape" | "mixed" | "duplicates" | "missing" | "limit";
  series: string[];
  points: Observation[];
  unit: string | null;
  label: string;
  missing: number;
  nav?: { value: number; date: string; currency: string | null; fund: string; basis: string };
}
function day(value: unknown): value is string {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
/** Exact provider column contracts only. Multiple matches and duplicate names are ambiguous. */
export function financeMetricForColumns(columns:readonly string[]):"price_history"|"treasury_yields"|"nav"|undefined {
  if(new Set(columns).size!==columns.length)return undefined;
  const contracts={price_history:["Observation date","Symbol","Close (raw)"],treasury_yields:["Observation date","Maturity","Par curve yield","Unit"],nav:["Fund","NAV per share","Currency","NAV date","Price basis"]} as const;
  const matches=(Object.keys(contracts) as (keyof typeof contracts)[]).filter(metric=>contracts[metric].every(name=>columns.includes(name)));
  return matches.length===1?matches[0]:undefined;
}
export function financeTenorLabel(tenor:string):string {
  const match=/^(\d+(?:[._]\d+)?)(MONTH|YEAR)$/.exec(tenor);
  return match?`${match[1].replace("_",".")}${match[2]==="MONTH"?"M":"Y"}`:tenor;
}
export function financeCompactTreasuryTitle(title:string,projection:{columns:string[];rows:(string|number|null)[][]},selected?:string):string {
  const match=/^(미국채|US Treasury)$/.exec(title);
  if(!match||financeMetricForColumns(projection.columns)!=="treasury_yields")return title;
  const at=projection.columns.indexOf("Maturity"),series=[...new Set(projection.rows.map(row=>row[at]).filter((value):value is string=>typeof value==="string"))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const tenor=selected&&series.includes(selected)?selected:series[0];
  return tenor?`${match[1]} ${financeTenorLabel(tenor)}`:title;
}
/** Charts use named provider columns and literal observations only; no FX, return or gap inference. */
export function financeDataVisual(result:FinanceDataResult, metric?:string, selectedSeries?:string):FinanceDataVisual {
  const fallback=(reason?:FinanceDataVisual["reason"]):FinanceDataVisual=>({kind:"table",reason,series:[],points:[],unit:null,label:"",missing:0});
  if(result.status==="error"||result.status==="unconnected"||!result.rows.length)return fallback("missing");
  if(result.rows.length>20000)return fallback("limit");
  if(new Set(result.columns).size!==result.columns.length)return fallback("shape");
  const index=(name:string)=>result.columns.indexOf(name);
  if(metric==="nav"){
    const [fund,value,currency,date,basis]=["Fund","NAV per share","Currency","NAV date","Price basis"].map(index);
    if([fund,value,currency,date,basis].some(i=>i<0)||result.rows.length!==1)return fallback("shape");
    const row=result.rows[0];if(!finite(row[value])||row[value]<0||!day(row[date]))return fallback("missing");
    const code=row[currency];return {kind:"nav",series:[],points:[],unit:null,label:String(row[fund]??""),missing:0,nav:{value:row[value],date:row[date],currency:typeof code==="string"&&/^[A-Z]{3}$/.test(code)&&code!=="XXX"?code:null,fund:String(row[fund]??""),basis:String(row[basis]??"")}};
  }
  if(metric!=="price_history"&&metric!=="treasury_yields")return fallback();
  const treasury=metric==="treasury_yields";
  const [date,value,seriesIndex]=["Observation date",treasury?"Par curve yield":"Close (raw)",treasury?"Maturity":"Symbol"].map(index);
  if([date,value,seriesIndex].some(i=>i<0))return fallback("shape");
  const series=[...new Set(result.rows.map(row=>row[seriesIndex]).filter((v):v is string=>typeof v==="string"&&v.trim().length>0))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(series.length>50)return fallback("limit");
  if(!series.length||(!treasury&&series.length!==1))return fallback("mixed");
  if(result.rows.some(row=>typeof row[seriesIndex]!=="string"||!String(row[seriesIndex]).trim()))return fallback("missing");
  const label=treasury&&selectedSeries&&series.includes(selectedSeries)?selectedSeries:series[0];
  const rows=result.rows.filter(row=>row[seriesIndex]===label);
  let unit:string|null=null;
  if(treasury){const unitIndex=index("Unit");if(unitIndex<0)return fallback("shape");const units=new Set(rows.map(row=>row[unitIndex]));if(units.size!==1||!units.has("% per annum"))return fallback("mixed");unit="% per annum";}
  else {const currency=index("Currency");if(currency>=0){const currencies=new Set(rows.map(row=>row[currency]));if(currencies.size>1)return fallback("mixed");const code=rows[0]?.[currency];if(typeof code==="string"&&/^[A-Z]{3}$/.test(code)&&code!=="XXX")unit=code;}}
  const dates=new Set<string>(),points:Observation[]=[];let missing=0;
  for(const row of rows){if(!day(row[date])||!finite(row[value])){missing++;continue;}if(dates.has(row[date]))return fallback("duplicates");dates.add(row[date]);points.push({date:row[date],value:row[value]});}
  points.sort((a,b)=>a.date.localeCompare(b.date));
  if(!points.length)return fallback("missing");
  return {kind:treasury?"treasury":"history",series,points,unit,label,missing};
}
const PAGE_SIZE=50;
export function FinanceDataResultView({result,metric:requestedMetric,locale,title,compact=false,showVisual=true,chartType,selectedSeries:controlledSeries,onSeriesChange}:FinanceDataResultViewProps) {
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
  const chartPoints=visual.points.slice(0,2000);
  const chartSpec={data:{values:chartPoints},mark:{type:chartType==="line"||chartType==="bar"?chartType:"point",filled:chartType!=="line",...(chartType==="line"?{interpolate:"linear"}:{})},encoding:{...(chartType==="line"?{order:{field:"date",type:"ordinal",sort:"ascending"}}:{}),tooltip:[{field:"date",type:"ordinal",title:t("날짜","Date")},{field:"value",type:"quantitative",title:visual.unit??t("값","Value"),format:chartPoints.some(point=>point.value!==0&&Math.abs(point.value)<.01)?".3~g":",.2f"}],x:{field:"date",type:"ordinal",sort:"ascending",title:t("관측일","Observation date"),axis:{labelOverlap:true}},y:{field:"value",type:"quantitative",scale:{zero:false},title:visual.kind==="treasury"?t("연율 수익률 (%)","Yield (% per annum)"):`${t("종가","Close")} · ${visual.unit??t("통화 미확인","currency unverified")}`}}};
  const displayVisual=showVisual&&chartType!=="table";
  const financeVisual=displayVisual&&visual.nav?<div className={styles.nav}><strong>{displayNumber(visual.nav.value)} <small>{visual.nav.currency??t("통화 미확인","Currency unknown")}</small></strong></div>:displayVisual&&(visual.kind==="history"||visual.kind==="treasury")?<div className={styles.visual}>
    {visual.kind==="treasury"&&<div className={styles.toolbar}><label className={styles.label} htmlFor={`${id}-tenor`}><span className={styles.srOnly}>{t("만기","Maturity")}</span><select id={`${id}-tenor`} value={visual.label} onChange={event=>{setSelectedSeries(event.target.value);onSeriesChange?.(event.target.value);}}>{visual.series.map(series=><option key={series} value={series}>{financeTenorLabel(series)}</option>)}</select></label></div>}
    <div className={styles.chartViewport}><ChartBlock code={JSON.stringify(chartSpec)} presetSpec={chartSpec} blockId={`finance-data:${id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p className={styles.notice} role="status">{t("차트를 표시하지 못했습니다.","Chart unavailable.")}</p>}/></div>
  </div>:null;
  const tableContent=<>
    {result.columns.length>0?<div className={styles.scroll} tabIndex={0} role="region" aria-label={compact?t("금융 자료","Financial data"):undefined} aria-labelledby={compact?undefined:`${id}-table`}><table><caption className={styles.srOnly}>{compact?t("금융 자료","Financial data"):t("조회 결과 원자료 · 페이지당 50행","Raw query result · 50 rows per page")}</caption><thead><tr>{visibleColumns.map((name,index)=><th key={index} scope="col">{column(name)}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={current*PAGE_SIZE+index}>{visibleColumns.map((column,index)=>{const columnIndex=currentColumn*50+index;const value=row[columnIndex];return <td key={columnIndex} className={typeof value==="number"?styles.number:undefined}>{typeof value==="string"&&/^https?:\/\//i.test(value)?<a href={value} target="_blank" rel="noopener noreferrer" title={t("열기","Open")} aria-label={t("열기","Open")}><IconArrowUp size={14} style={{transform:"rotate(45deg)"}}/></a>:typeof value==="number"?displayNumber(value):financeCell(value??null,column,ko)}</td>;})}</tr>)}</tbody></table></div>:<p className={styles.notice}>{t("표시할 열이 없습니다.","No columns are available.")}</p>}
    {columnPages>1&&<nav className={styles.paging} aria-label={compact?t("표 열 페이지","Table column pages"):t("원자료 열 페이지","Source column pages")}><button type="button" disabled={currentColumn===0} aria-label={t("이전 열","Previous columns")} title={t("이전 열","Previous columns")} onClick={()=>setColumnPage(currentColumn-1)}><IconChevronLeft size={14}/></button><span>{t("열","Columns")} {currentColumn*50+1}–{Math.min((currentColumn+1)*50,result.columns.length)} / {result.columns.length}</span><button type="button" disabled={currentColumn===columnPages-1} aria-label={t("다음 열","Next columns")} title={t("다음 열","Next columns")} onClick={()=>setColumnPage(currentColumn+1)}><IconChevronRight size={14}/></button></nav>}
    {!result.rows.length&&<p className={styles.muted}>{t("확인된 결과 행이 없습니다.","No verified result rows.")}</p>}
    {pages>1&&<nav className={styles.paging} aria-label={compact?t("표 페이지","Table pages"):t("원자료 페이지","Source data pages")}><button disabled={current===0} aria-label={t("이전","Previous")} title={t("이전","Previous")} onClick={()=>setPage(current-1)} type="button"><IconChevronLeft size={14}/></button><span aria-live="polite">{current+1} / {pages}</span><button disabled={current===pages-1} aria-label={t("다음","Next")} title={t("다음","Next")} onClick={()=>setPage(current+1)} type="button"><IconChevronRight size={14}/></button></nav>}
  </>;
  return <section className={`${styles.root} ${compact?styles.compact:""}`} aria-label={title??t("금융 자료","Financial data")}>
    {!compact&&title&&<header className={styles.header}><h3>{title}</h3></header>}
    {result.status==="error"||result.status==="unconnected"||!result.rows.length?<p className={styles.notice} role={result.status==="error"?"alert":"status"}>{result.status==="error"?t("자료를 표시하지 못했습니다.","Data unavailable."):t("표시할 자료가 없습니다.","No data to display.")}</p>:financeVisual??tableContent}
  </section>;
}
