"use client";
import { Fragment, type ReactNode } from "react";
import type { FinanceDataResult, FinanceReport, FinanceReportSection } from "@shared/finance";
import { financeComputeMetrics, financeComputeMetricDisplay, financeComputeSpec } from "./FinanceComputeView";
import { FinanceDataResultView, financeDataVisual, financeMetricForColumns } from "./FinanceDataResultView";
import { financeReportLocale, financeReportDirection, financeReportSectionTitle, financeReportTitle, selectFinanceReportSections, financeReportHtml } from "@shared/finance-report-presentation";
import { sanitizeChartSpec } from "@/lib/chart-spec";
import { ChartBlock } from "@/components/ChartBlock";
import styles from "./FinanceReportView.module.css";

/** Report prose is text, never executable model-authored HTML. */
export function financeReportLink(value:string):string|null {
 try {const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
function inline(value:string):ReactNode[] {
 value=value.replace(/\s*\[row\s+\d+\]/gi,"");
 const result:ReactNode[]=[];const tokens=/\[([^\]\n]{1,1000})\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`/g;let cursor=0,match:RegExpExecArray|null;
 while((match=tokens.exec(value))){if(match.index>cursor)result.push(value.slice(cursor,match.index));const key=match.index;if(match[1]){const href=financeReportLink(match[2]);result.push(href?<a key={key} href={href} target="_blank" rel="noopener noreferrer">{match[1]}</a>:<Fragment key={key}>{match[1]}</Fragment>);}else if(match[3]||match[4])result.push(<strong key={key}>{match[3]??match[4]}</strong>);else result.push(<span key={key}>{match[5]}</span>);cursor=tokens.lastIndex;}
 if(cursor<value.length)result.push(value.slice(cursor));return result;
}
/** Preserve requested-language text; remove list syntax and evidence dumps, without creating numeric outlines. */
export function FinanceReportProse({value}:{value:string}) {
 const blocks:ReactNode[]=[];let paragraph:string[]=[],fenced=false;
 const flush=()=>{if(paragraph.length){blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);paragraph=[];}};
 for(const line of value.split(/\r?\n/)){
  if(/^\s*```/.test(line)){flush();fenced=!fenced;continue;}if(fenced)continue;
  if(/^\s*\[row\s+\d+\]/i.test(line)){flush();break;}
  if(/^\s*\|.*\|\s*$/.test(line)||/^\s*(?:input sha256:|sourceRevision:|retrievedAt:)/i.test(line))continue;
  const heading=/^\s{0,3}#{1,6}\s+(.+)$/.exec(line);if(heading){flush();blocks.push(<h3 key={blocks.length}>{inline(heading[1])}</h3>);continue;}
  if(!line.trim()){flush();continue;}
  const item=/^\s*(?:[-*•]\s+|\d+[.)]\s+)(.+)$/.exec(line);if(item){flush();blocks.push(<p key={blocks.length}>{inline(item[1])}</p>);}else paragraph.push(line.trim().replace(/^>\s?/,""));
 }
 flush();return <div className={styles.prose}>{blocks}</div>;
}
function data(section:FinanceReportSection):FinanceDataResult|null {const p=section.projection;return p?{status:p.status==="ready"?"ok":p.status==="partial"?"partial":"unconnected",columns:p.columns,rows:p.rows,warnings:p.warnings,asOf:p.asOf,retrievedAt:"",sourceUrls:[]}:null;}
export function financeReportChartSpec(section:FinanceReportSection):Record<string,unknown>|null {
 const computed=financeComputeSpec(section,false);if(computed)return computed;
 const result=data(section),metric=result?financeMetricForColumns(result.columns):undefined,visual=result&&metric?financeDataVisual(result,metric):null;
 if(visual&&(visual.kind==="history"||visual.kind==="treasury")&&visual.points.length){const unit=visual.kind==="treasury"?"%":visual.unit;return {data:{values:visual.points},mark:{type:"point",filled:true,tooltip:true},encoding:{x:{field:"date",type:"ordinal",sort:null,title:null},y:{field:"value",type:"quantitative",title:unit,scale:{zero:false}},tooltip:[{field:"date",type:"ordinal",title:null},{field:"value",type:"quantitative",title:unit,format:".2f"}]}};}
 const p=section.projection,w=section.widget;if(!p||!w||w.chartType==="table"||!["chart","comparison"].includes(w.type)||!p.rows.length||p.rows.length>5000||!['ready','partial'].includes(p.status)||!["Observed at","Symbol","Currency","Price"].every(name=>p.columns.includes(name)))return null;
 const at=(name:string)=>p.columns.indexOf(name),currencies=new Set(p.rows.map(row=>row[at("Currency")]));if(currencies.size!==1)return null;const currency=p.rows[0][at("Currency")];if(typeof currency!=="string"||!(/^[A-Z]{3}$/).test(currency)||currency==="XXX")return null;
 const seen=new Set<string>();const values=p.rows.map(row=>({date:row[at("Observed at")],symbol:row[at("Symbol")],value:row[at("Price")]}));if(values.some(row=>{const key=`${row.date}:${row.symbol}`;if(typeof row.date!=="string"||!Number.isFinite(Date.parse(row.date))||typeof row.symbol!=="string"||typeof row.value!=="number"||!Number.isFinite(row.value)||seen.has(key))return true;seen.add(key);return false;}))return null;
 if(w.chartType==="line"&&new Set(values.map(row=>row.date)).size<2)return null;
 return {data:{values},mark:{type:w.chartType,tooltip:true},encoding:{x:{field:w.chartType==="bar"?"symbol":"date",type:w.chartType==="bar"?"nominal":"temporal",title:null},y:{field:"value",type:"quantitative",title:currency,scale:{zero:false}},color:{field:"symbol",type:"nominal",title:null},tooltip:[{field:"symbol",type:"nominal",title:null},{field:"date",type:"nominal",title:null},{field:"value",type:"quantitative",title:currency,format:".2f"}]}};
}
const genericTitle=/^(Summary|Sources and limitations|Sources|요약|계산 요약|가정과 방법)$/i;
const labels:Record<string,[string,string,string,string]>={
 "Median":["중앙값","Median","中央値","中位数"],
 "Chart unavailable":["차트를 표시하지 못했습니다.","Chart unavailable.","チャートを表示できません。","图表不可用。"],
 "정규화 공분산 연율 변동성":["정규화 공분산 연율 변동성","Annualized volatility (regularized)","年率ボラティリティ（正則化）","年化波动率（正则化）"],"표본 공분산 연율 변동성":["표본 공분산 연율 변동성","Annualized sample volatility","標本年率ボラティリティ","样本年化波动率"],"과거 일평균 수익률의 연율 환산":["과거 일평균 수익률의 연율 환산","Annualized historical mean","過去平均リターン（年率）","历史平均收益（年化）"],"최대 제약 위반":["최대 제약 위반","Maximum constraint violation","最大制約違反","最大约束偏差"],"시작값":["시작값","Initial value","初期値","初始值"],"마지막 단계 중앙값":["마지막 단계 중앙값","Terminal median","最終ステップの中央値","最终步中位数"],"마지막 단계 5분위":["마지막 단계 5분위","Terminal 5th percentile","最終ステップの5パーセンタイル","最终步第5百分位"],"마지막 단계 95분위":["마지막 단계 95분위","Terminal 95th percentile","最終ステップの95パーセンタイル","最终步第95百分位"],"이론 가격":["이론 가격","Theoretical price","理論価格","理论价格"],"Vega · 변동성 1%p":["Vega · 변동성 1%p","Vega · 1pp volatility","Vega · ボラティリティ1ポイント","Vega · 波动率1个百分点"],"Theta · 달력 1일":["Theta · 달력 1일","Theta · calendar day","Theta · 暦日","Theta · 日历日"],"Rho · 금리 1%p":["Rho · 금리 1%p","Rho · 1pp rate","Rho · 金利1ポイント","Rho · 利率1个百分点"],
 "Step":["단계","Step","ステップ","步数"],"Weight":["배분","Weight","配分","权重"],"Asset":["종목","Asset","資産","资产"],"Simulated value":["시뮬레이션 값","Simulated value","シミュレーション値","模拟值"],"Underlying price at expiry":["만기 기초자산 가격","Underlying price at expiry","満期の原資産価格","到期标的价格"],"Expiry payoff / P&L":["만기 지급액 · 손익","Expiry payoff / P&L","満期ペイオフ・損益","到期收益与损益"],"Expiry payoff":["만기 지급액","Expiry payoff","満期ペイオフ","到期收益"],"Payoff less premium":["프리미엄 차감 손익","Payoff less premium","プレミアム控除後損益","扣除权利金后损益"],"Payoff / P&L":["지급액 · 손익","Payoff / P&L","ペイオフ・損益","收益与损益"]
};
export function financeReportLabel(label:string,language:string):string {const index:number=/^ko(?:-|$)/i.test(language)?0:/^en(?:-|$)/i.test(language)?1:/^ja(?:-|$)/i.test(language)?2:/^zh(?:-|$)/i.test(language)?3:-1;return index<0?(labels[label]?"":label):labels[label]?.[index]??label;}
function localizedSpec(value:unknown,language:string,key=""):unknown {if(Array.isArray(value))return value.map(item=>localizedSpec(item,language,key));if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,localizedSpec(item,language,name)]));if(typeof value==="string"&&(key==="title"||key==="series"))return financeReportLabel(value,language);return value;}
export function financeLocalizedReportChartSpec(section:FinanceReportSection,language:string):Record<string,unknown>|null {const spec=financeReportChartSpec(section);return spec?localizedSpec(spec,language) as Record<string,unknown>:null;}
export function FinanceReportView({report,locale="en",explicitTableSectionIds=[]}:{report:FinanceReport;locale?:string;explicitTableSectionIds?:readonly string[]}) {
 const language=financeReportLocale(report,locale),ko=language.startsWith("ko"),tables=new Set([...explicitTableSectionIds,...report.sections.filter(section=>section.presentation==="comparison").map(section=>section.id)]);
 const sections=selectFinanceReportSections(report).flatMap(section=>{
  const result=data(section),metric=result?financeMetricForColumns(result.columns):undefined;
  const spec=financeReportChartSpec(section),computation=!!spec,metrics=!tables.has(section.id)||section.presentation==="narrative"?undefined:financeComputeMetrics(section)?.filter(metric=>!!financeReportLabel(metric.label,language)&&!["최대 제약 위반","표본 공분산 연율 변동성","Maximum constraint violation","Annualized sample volatility"].includes(metric.label));
  const visual=result&&metric?financeDataVisual(result,metric):null;
  const chart=section.presentation!=="narrative"&&(computation||!!visual&&visual.kind!=="table");
  if(section.presentation==="supporting")return [];
  if(section.kind==="sources"&&!chart&&!tables.has(section.id))return [];
  if(!section.narrative.trim()&&!chart&&!metrics?.length&&!tables.has(section.id))return [];
  return [{section,result,chart,spec,metrics,table:tables.has(section.id)&&!chart}];
 });
 const lead=sections.filter(item=>!item.chart&&item.section.kind==="summary");
 const ordered=[...lead,...sections.filter(item=>item.chart),...sections.filter(item=>!item.chart&&item.section.kind!=="summary")];
 return <article className={styles.report} lang={language} dir={financeReportDirection(report,locale)} aria-labelledby={`finance-reader-${report.id}`}><header className={styles.header}><h1 id={`finance-reader-${report.id}`}>{financeReportTitle(report,locale)}</h1></header><div className={styles.body}>{ordered.map(({section,result,chart,spec,metrics,table})=><section key={section.id} className={chart?styles.chartSection:styles.section} id={`finance-report-section-${section.id}`}>
  {!genericTitle.test(section.title)&&section.title!==report.title&&<h2>{financeReportSectionTitle(section,language)}</h2>}
  {section.narrative.trim()&&<FinanceReportProse value={section.narrative}/>}
  {chart&&spec?<><ChartBlock code={JSON.stringify(localizedSpec(spec,language))} blockId={`finance-report-chart-${section.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p>{financeReportLabel("Chart unavailable",language)||"Chart unavailable."}</p>}/>{section.widget?.metric==="compute:forecast:fan"&&<div className={styles.fanLegend}><span>5–95%</span><span>25–75%</span><span>{financeReportLabel("Median",language)||"Median"}</span></div>}</>:metrics?.length?<div className={styles.metrics}>{metrics.slice(0,8).map((metric,index)=>{const display=financeComputeMetricDisplay(metric.value,metric.unit,ko,metric.label);return <div key={index}><span>{financeReportLabel(metric.label,language)}</span><strong>{display.value} <small>{display.unit}</small></strong></div>;})}</div>:result&&(chart||table)?<FinanceDataResultView result={result} locale={ko?"ko":"en"} compact showVisual={!table}/>:null}
 </section>)}</div></article>;
}

/** Standalone local chart export: deny every loader route and always release each Vega view. */
export async function financeReportExportHtml(report:FinanceReport,locale?:string):Promise<string> {
 const language=financeReportLocale(report,locale),charts:Record<string,string>={};
 const candidates=selectFinanceReportSections(report).filter(section=>section.presentation!=="narrative"&&section.presentation!=="comparison").map(section=>({section,spec:financeReportChartSpec(section)})).filter(item=>!!item.spec);
 if(candidates.length){const [vl,vega,interpreter]=await Promise.all([import("vega-lite"),import("vega"),import("vega-interpreter")]);
 const deny=()=>Promise.reject(new Error("network disabled")),loader={load:deny,sanitize:deny,http:deny,file:deny};
 for(const {section,spec} of candidates){const checked=sanitizeChartSpec(localizedSpec(spec,language));if(!checked.ok)continue;
 let view:{runAsync:()=>Promise<unknown>;toSVG:()=>Promise<string>;finalize:()=>void}|undefined;
 try {const compiled=vl.compile({...checked.spec,width:860,height:300,autosize:{type:"fit-x",contains:"padding"}} as never).spec;
 view=new vega.View(vega.parse(compiled as never,undefined,{ast:true}),{renderer:"none",expr:interpreter.expressionInterpreter,loader:loader as never}) as unknown as typeof view;
 await view!.runAsync();const svg=await view!.toSVG();const bytes=new TextEncoder().encode(svg);if(bytes.length>4*1024*1024)continue;
 let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));charts[section.id]=`data:image/svg+xml;base64,${btoa(binary)}`;
 }finally {view?.finalize();}
 }}return financeReportHtml({report,locale:language,charts});
}
