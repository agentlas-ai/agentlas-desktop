"use client";
import { useId, useMemo, useState, type ReactNode } from "react";
import type { FinanceDataResult } from "@shared/finance";
import { useT } from "@/lib/i18n";
import { ChartBlock } from "@/components/ChartBlock";
import { FinanceMessage, financeCell, financeColumn, financeStatus } from "./FinanceMessage";
import styles from "./FinanceDataResultView.module.css";

export interface FinanceDataResultViewProps {
  result: FinanceDataResult;
  metric?: string;
  locale?: "ko" | "en";
  title?: string;
  compact?: boolean;
  showVisual?: boolean;
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
  for(const row of rows){if(!day(row[date])||!finite(row[value])||(!treasury&&row[value]<0)){missing++;continue;}if(dates.has(row[date]))return fallback("duplicates");dates.add(row[date]);points.push({date:row[date],value:row[value]});}
  points.sort((a,b)=>a.date.localeCompare(b.date));
  if(!points.length)return fallback("missing");
  return {kind:treasury?"treasury":"history",series,points,unit,label,missing};
}
const PAGE_SIZE=50;
export function FinanceDataResultView({result,metric:requestedMetric,locale,title,compact=false,showVisual=true,selectedSeries:controlledSeries,onSeriesChange}:FinanceDataResultViewProps) {
  const metric=requestedMetric??financeMetricForColumns(result.columns);
  const i18n=useT();const ko=(locale??i18n.locale)==="ko";const t=(a:string,b:string)=>ko?a:b;
  const metricTitle=metric==="price_history"?t("원종가 관측","Raw closing observations"):metric==="treasury_yields"?t("국채 만기별 수익률","Treasury yields by maturity"):metric==="nav"?t("공식 펀드 NAV","Official fund NAV"):financeStatus(metric??"",ko)||t("조회 자료","Retrieved data");
  const column=(value:string)=>ko?({"Observation date":"관측일","Close (raw)":"원종가","Maturity":"만기","Par curve yield":"액면 수익률","Unit":"단위","Fund":"펀드","NAV per share":"주당 NAV","NAV date":"NAV 기준일","Price basis":"가격 기준","Open":"시가","High":"고가","Low":"저가"} as Record<string,string>)[value]??financeColumn(value,true):value;
  const id=useId();const [selectedSeries,setSelectedSeries]=useState("");const [page,setPage]=useState(0);const [columnPage,setColumnPage]=useState(0);
  const visual=useMemo(()=>financeDataVisual(result,metric,controlledSeries??selectedSeries),[result,metric,selectedSeries,controlledSeries]);
  const pages=Math.max(1,Math.ceil(result.rows.length/PAGE_SIZE)),current=Math.min(page,pages-1);
  const columnPages=Math.max(1,Math.ceil(result.columns.length/50)),currentColumn=Math.min(columnPage,columnPages-1);
  const visibleColumns=result.columns.slice(currentColumn*50,(currentColumn+1)*50);
  const rows=result.rows.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
  const when=(value:string|null)=>!value?t("미확인","Unknown"):day(value)?`${value} · ${t("일 기준","day precision")}`:Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(ko?"ko-KR":"en-US"):value;
  const reasons={shape:t("시각화에 필요한 열 또는 단일 관측 구조를 확인할 수 없어 원자료로 표시합니다.","Required columns or single-observation structure are unavailable; inspect the source table."),mixed:t("여러 자산·통화 또는 단위가 섞여 있어 한 차트로 합치지 않습니다.","Mixed assets, currencies or units are not combined in one chart."),duplicates:t("같은 날짜의 관측이 중복됩니다. 어느 값을 택할지 추정하지 않습니다.","Duplicate dates exist. No observation was selected by inference."),missing:t("시각화에 필요한 유효한 관측이 없습니다. 빈 값은 0이 아닙니다.","No valid observations for this view. Missing values are not zero."),limit:t("차트 관측 한도(20,000행 또는 50개 계열)를 넘었습니다. 원자료 표의 모든 페이지를 확인하세요.","Chart input exceeds 20,000 rows or 50 series. All source rows remain available in the paginated table.")};
  const chartPoints=visual.points.slice(0,2000);
  const chartSpec={data:{values:chartPoints},mark:{type:"point",filled:true,tooltip:true},encoding:{x:{field:"date",type:"ordinal",sort:"ascending",title:t("관측일","Observation date"),axis:{labelOverlap:true}},y:{field:"value",type:"quantitative",scale:{zero:false},title:visual.kind==="treasury"?t("연율 수익률 (%)","Yield (% per annum)"):`${t("원종가","Raw close")} · ${visual.unit??t("통화 미확인","currency unverified")}`}}};
  const statusDetails=<>
    <dl className={styles.meta}><div><dt>{t("관측 기준","As of")}</dt><dd>{when(result.asOf)}</dd></div><div><dt>{t("가져온 시각","Retrieved at")}</dt><dd>{when(result.retrievedAt)}</dd></div></dl>
    {result.status!=="ok"&&<p className={styles.notice} role={result.status==="error"?"alert":"status"}>{result.status==="partial"?t("일부 범위만 확인된 자료입니다. 아래 원자료와 범위 안내를 함께 확인하세요.","Coverage is partial. Read the source rows and limitations below."):t("자료를 확인하지 못했습니다. 이전 값이나 0으로 대체하지 않습니다.","Data is unavailable. No previous value or zero is substituted.")}</p>}
  </>;
  const chartDetails=<>{(visual.kind==="history"||visual.kind==="treasury")&&<>
      <p className={styles.muted}>{visual.label} · {visual.unit??t("통화 미확인","Currency unverified")} · {visual.points[0]?.date} — {visual.points.at(-1)?.date} · {visual.points.length} {t("확인 관측","verified observations")}</p>
      <p className={styles.muted}>{t("점은 실제 관측만 나타내며 빈 날짜를 채우거나 연결하지 않습니다.","Points show literal observations; missing dates are neither filled nor connected.")} {visual.kind==="history"&&t("원종가는 배당·분할 조정 총수익이 아닙니다. 통화는 이 조회만으로 재검증하지 않습니다.","Raw closes are not dividend/split-adjusted total returns. This query does not independently reverify currency.")}</p>
      {visual.missing>0&&<p className={styles.notice}>{visual.missing} {t("개 불완전 관측은 차트에서 제외했습니다. 원자료 표에는 그대로 보존합니다.","incomplete observations are excluded from the chart and preserved in the source table.")}</p>}
      {visual.points.length>2000&&<p className={styles.notice}>{t("차트는 날짜순 처음 2,000개 관측만 표시합니다. 전체 행은 아래 표에서 확인하세요.","Chart shows the first 2,000 observations in date order. All rows remain in the table below.")}</p>}
</>}    {visual.reason&&<p className={styles.notice}>{reasons[visual.reason]}</p>}
  </>;
  const provenance=<>
    {!!result.warnings.length&&<details className={styles.evidence}><summary>{t("자료 범위와 한계","Coverage and limitations")} · {result.warnings.length}</summary>{<EvidencePages items={result.warnings} ko={ko} render={warning=><FinanceMessage value={warning} ko={ko}/>}/>}</details>}
    {!!result.providers?.length&&<EvidencePages items={result.providers} ko={ko} render={provider=><details key={provider.id} className={styles.evidence}><summary>{provider.label} · {financeStatus(provider.status,ko)}</summary><h4>{t("지원 범위","Coverage")}</h4><FinanceMessage value={provider.coverage} ko={ko}/><h4>{t("이용·재배포 조건","Usage and redistribution")}</h4><FinanceMessage value={provider.rights} ko={ko}/>{<EvidencePages items={provider.sourceUrls} ko={ko} render={url=><SourceLink url={url}/>}/>}</details>}/>}
    <details className={styles.evidence}><summary>{t("원문 출처","Original source URLs")} · {result.sourceUrls.length}</summary>{<EvidencePages items={result.sourceUrls} ko={ko} render={url=><SourceLink url={url}/>}/>}</details>
  </>;
  return <section className={`${styles.root} ${compact?styles.compact:""}`} aria-label={title??t("조회 자료와 근거","Retrieved data and evidence")}>
    {!compact&&<header className={styles.header}><h3>{title??metricTitle}</h3><span className={styles.badge}>{financeStatus(result.status,ko)} · {result.rows.length.toLocaleString()} {t("행","rows")}</span></header>}
    {!compact&&statusDetails}
    {showVisual&&visual.nav&&<div className={styles.nav}>{!compact&&<div>{visual.nav.fund}</div>}<strong>{String(visual.nav.value)} <small>{visual.nav.currency??t("통화 미확인","Currency unknown")}</small></strong>{!compact&&<><p>{visual.nav.date} · {visual.nav.basis}</p><p className={styles.muted}>{t("공식 펀드 순자산가치 1개 관측입니다. 거래가격·실시간 시세·수익률 또는 시계열로 해석하지 않습니다.","One official fund NAV observation. It is not a market quote, real-time price, return or historical series.")}</p></>}</div>}
    {showVisual&&(visual.kind==="history"||visual.kind==="treasury")&&<div className={styles.visual}>
      {visual.kind==="treasury"&&<label className={styles.label} htmlFor={`${id}-tenor`}><span className={compact?styles.srOnly:undefined}>{t("표시할 만기","Maturity to display")}</span><select id={`${id}-tenor`} value={visual.label} onChange={event=>{setSelectedSeries(event.target.value);onSeriesChange?.(event.target.value);}}>{visual.series.map(series=><option key={series} value={series}>{financeTenorLabel(series)}</option>)}</select></label>}
      <ChartBlock code={JSON.stringify(chartSpec)} presetSpec={chartSpec} blockId={`finance-data:${id}`} size="panel" fallback={<p className={styles.notice}>{t("차트를 표시하지 못했습니다. 아래 원자료 표를 확인하세요.","Chart unavailable. Use the source table below.")}</p>}/>
    </div>}
    {!compact&&chartDetails}
    <details open={!compact}><summary className={styles.muted}>{compact?t("원자료","Data"):t("전체 원자료 보기","View complete source data")}{!compact&&<> · {result.rows.length}</>}</summary>
    <div className={styles.tableHeader}><h4 id={`${id}-table`}>{t("전체 원자료","Complete source data")}</h4><span className={styles.muted}>{result.rows.length?current*PAGE_SIZE+1:0}–{Math.min((current+1)*PAGE_SIZE,result.rows.length)} / {result.rows.length}</span></div>
    {result.columns.length>0?<div className={styles.scroll} tabIndex={0} role="region" aria-labelledby={`${id}-table`}><table><caption className={styles.srOnly}>{t("조회 결과 원자료 · 페이지당 50행","Raw query result · 50 rows per page")}</caption><thead><tr>{visibleColumns.map((name,index)=><th key={index} scope="col">{column(name)}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={current*PAGE_SIZE+index}>{visibleColumns.map((column,index)=>{const columnIndex=currentColumn*50+index;const value=row[columnIndex];return <td key={columnIndex} className={typeof value==="number"?styles.number:undefined}>{typeof value==="string"&&/^https?:\/\//i.test(value)?<a href={value} target="_blank" rel="noopener noreferrer" title={value}>{t("원문 열기","Open source")}</a>:typeof value==="number"?String(value):financeCell(value??null,column,ko)}</td>;})}</tr>)}</tbody></table></div>:<p className={styles.notice}>{t("표시할 열이 없습니다.","No columns are available.")}</p>}
    {columnPages>1&&<nav className={styles.paging} aria-label={t("원자료 열 페이지","Source column pages")}><button type="button" disabled={currentColumn===0} onClick={()=>setColumnPage(currentColumn-1)}>{t("이전 열","Previous columns")}</button><span>{t("열","Columns")} {currentColumn*50+1}–{Math.min((currentColumn+1)*50,result.columns.length)} / {result.columns.length}</span><button type="button" disabled={currentColumn===columnPages-1} onClick={()=>setColumnPage(currentColumn+1)}>{t("다음 열","Next columns")}</button></nav>}
    {!result.rows.length&&<p className={styles.muted}>{t("확인된 결과 행이 없습니다.","No verified result rows.")}</p>}
    {pages>1&&<nav className={styles.paging} aria-label={t("원자료 페이지","Source data pages")}><button disabled={current===0} onClick={()=>setPage(current-1)} type="button">{t("이전","Previous")}</button><span aria-live="polite">{current+1} / {pages}</span><button disabled={current===pages-1} onClick={()=>setPage(current+1)} type="button">{t("다음","Next")}</button></nav>}
    </details>
    {compact?<details className={styles.evidence}><summary>{t("정보","Info")}</summary>{statusDetails}{chartDetails}{provenance}</details>:provenance}
  </section>;
}
function SourceLink({url}:{url:string}) {return /^https?:\/\//i.test(url)?<p><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>:<p>{url}</p>;}

/** Bounded metadata rendering; every original entry remains reachable without a data request. */
function EvidencePages<T>({items,render,ko}:{items:readonly T[];render:(item:T,index:number)=>ReactNode;ko:boolean}) {
  const [page,setPage]=useState(0);const pages=Math.max(1,Math.ceil(items.length/25));const current=Math.min(page,pages-1);
  return <>{items.slice(current*25,(current+1)*25).map((item,index)=><div key={current*25+index}>{render(item,current*25+index)}</div>)}{pages>1&&<nav className={styles.paging} aria-label={ko?"근거 항목 페이지":"Evidence item pages"}><button type="button" disabled={current===0} onClick={()=>setPage(current-1)}>{ko?"이전 항목":"Previous items"}</button><span>{current+1} / {pages} · {items.length}</span><button type="button" disabled={current===pages-1} onClick={()=>setPage(current+1)}>{ko?"다음 항목":"Next items"}</button></nav>}</>;
}
