"use client";
import { Fragment, type ReactNode } from "react";
import type { FinanceDataResult, FinanceReport, FinanceReportSection } from "@shared/finance";
import { financeComputeSpec } from "./FinanceComputeView";
import { financeDataVisual, financeMetricForColumns } from "./FinanceDataResultView";
import { financeReportFinancialData, financeReportLocale, financeReportDirection, financeReportSectionTitle, financeReportTitle, selectFinanceReportSections, financeReportHtml, financeReportNumber, financeReportProseBlocks, financeReportSectionHeading, financeReportComputeMetrics, financeReportCompositionSpec, financeReportCompositionTitle, financeReportWarnings } from "@shared/finance-report-presentation";
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
export function FinanceReportProse({value,language="en"}:{value:string;language?:string}) {
 return <div className={styles.prose}>{financeReportProseBlocks(value).map((block,index)=>block.kind==="table"?<div key={index} className={styles.tableScroll} tabIndex={0} role="region" aria-label={financeReportLabel("Table",language)}><table className={styles.proseTable}><thead><tr>{block.columns.map((name,column)=><th key={column} scope="col" className={block.align[column]==="end"?styles.numeric:undefined}>{inline(name)}</th>)}</tr></thead><tbody>{block.rows.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,column)=><td key={column} className={block.align[column]==="end"?styles.numeric:undefined}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>:block.kind==="heading"?<h3 key={index}>{inline(block.text)}</h3>:block.kind==="quote"?<blockquote key={index}>{inline(block.text)}</blockquote>:<p key={index}>{inline(block.text)}</p>)}</div>;
}
/** A warning the host itself raised for this report (a value left out of a total, a price that did not match, currencies never added): one visible line each. Where a value came from is not drawn. */
export function FinanceReportWarnings({lines,dir}:{lines:readonly string[];dir:"ltr"|"rtl"}) {
 return lines.length?<ul className={styles.warnings} role="status" dir={dir}>{lines.map(line=><li key={line} dir="auto">{line}</li>)}</ul>:null;
}
function data(section:FinanceReportSection):FinanceDataResult|null {const p=section.projection;return p?{status:p.status==="ready"?"ok":p.status==="partial"?"partial":"unconnected",columns:p.columns,rows:p.rows,warnings:p.warnings,asOf:p.asOf,retrievedAt:"",sourceUrls:[]}:null;}
export function financeReportChartSpec(section:FinanceReportSection):Record<string,unknown>|null {
 if(financeReportCompositionTitle(section))return financeReportCompositionSpec(section);
 const plan=financeReportFinancialData(section);if(plan)return {data:{values:plan.rows},mark:plan.kind==='cashflow'?{type:'line',filled:false,interpolate:'linear'}:{type:'bar'},encoding:{x:{field:'period',type:plan.kind==='cashflow'?'quantitative':'nominal',title:null,axis:{labelOverlap:true}},y:{field:'value',type:'quantitative',title:plan.currency,axis:{format:',.2~f'},scale:{zero:plan.kind!=='cashflow'}},tooltip:[{field:'period',title:null},{field:'value',type:'quantitative',title:plan.currency,format:',.2~f'}]}};
 const computed=financeComputeSpec(section,false);if(computed)return computed;
 if(section.widget?.chartType==="table")return null;
 const result=data(section),metric=result?financeMetricForColumns(result.columns):undefined,visual=result&&metric?financeDataVisual(result,metric):null;
 if(visual&&(visual.kind==="history"||visual.kind==="treasury")&&visual.points.length){const unit=visual.kind==="treasury"?"%":visual.unit,dates=visual.points.map(point=>point.date),ticks=[...new Set([dates[0],dates[Math.floor((dates.length-1)/2)],dates[dates.length-1]])];return {data:{values:visual.points},mark:{type:section.widget?.chartType==="line"||section.widget?.chartType==="bar"?section.widget.chartType:"point",filled:section.widget?.chartType!=="line",...(section.widget?.chartType==="line"?{interpolate:"linear"}:{}),tooltip:true},encoding:{...(section.widget?.chartType==="line"?{order:{field:"date",type:"ordinal",sort:"ascending"}}:{}),x:{field:"date",type:"ordinal",sort:"ascending",title:null,axis:{labelAngle:0,labelOverlap:true,labelFontSize:11,values:ticks}},y:{field:"value",type:"quantitative",title:unit,scale:{zero:false}},tooltip:[{field:"date",type:"ordinal",title:null},{field:"value",type:"quantitative",title:unit,format:".2f"}]}};}
 const p=section.projection,w=section.widget;if(!p||!w||w.chartType==="table"||!["chart","comparison"].includes(w.type)||!p.rows.length||p.rows.length>5000||!['ready','partial'].includes(p.status)||!["Observed at","Symbol","Currency","Price"].every(name=>p.columns.includes(name)))return null;
 const at=(name:string)=>p.columns.indexOf(name),currencies=new Set(p.rows.map(row=>row[at("Currency")]));if(currencies.size!==1)return null;const currency=p.rows[0][at("Currency")];if(typeof currency!=="string"||!(/^[A-Z]{3}$/).test(currency)||currency==="XXX")return null;
 const seen=new Set<string>();const values=p.rows.map(row=>({date:row[at("Observed at")],symbol:row[at("Symbol")],value:row[at("Price")]}));if(values.some(row=>{const key=`${row.date}:${row.symbol}`;if(typeof row.date!=="string"||!Number.isFinite(Date.parse(row.date))||typeof row.symbol!=="string"||typeof row.value!=="number"||!Number.isFinite(row.value)||seen.has(key))return true;seen.add(key);return false;}))return null;
 if(w.chartType==="line"&&new Set(values.map(row=>row.date)).size<2)return null;
 return {data:{values},mark:{type:w.chartType,tooltip:true},encoding:{x:{field:w.chartType==="bar"?"symbol":"date",type:w.chartType==="bar"?"nominal":"temporal",title:null},y:{field:"value",type:"quantitative",title:currency,axis:{format:',.2~f'},scale:{zero:false}},color:{field:"symbol",type:"nominal",title:null},tooltip:[{field:"symbol",type:"nominal",title:null},{field:"date",type:"nominal",title:null},{field:"value",type:"quantitative",title:currency,format:',.2~f'}]}};
}
const labels:Record<string,[string,string,string,string]>={
 "Median":["중앙값","Median","中央値","中位数"],"Table":["표","Table","表","表格"],
 "Chart unavailable":["차트를 표시하지 못했습니다.","Chart unavailable.","チャートを表示できません。","图表不可用。"],
 "정규화 공분산 연율 변동성":["정규화 공분산 연율 변동성","Annualized volatility (regularized)","年率ボラティリティ（正則化）","年化波动率（正则化）"],"표본 공분산 연율 변동성":["표본 공분산 연율 변동성","Annualized sample volatility","標本年率ボラティリティ","样本年化波动率"],"과거 일평균 수익률의 연율 환산":["과거 일평균 수익률의 연율 환산","Annualized historical mean","過去平均リターン（年率）","历史平均收益（年化）"],"최대 제약 위반":["최대 제약 위반","Maximum constraint violation","最大制約違反","最大约束偏差"],"시작값":["시작값","Initial value","初期値","初始值"],"마지막 단계 중앙값":["마지막 단계 중앙값","Terminal median","最終ステップの中央値","最终步中位数"],"마지막 단계 5분위":["마지막 단계 5분위","Terminal 5th percentile","最終ステップの5パーセンタイル","最终步第5百分位"],"마지막 단계 95분위":["마지막 단계 95분위","Terminal 95th percentile","最終ステップの95パーセンタイル","最终步第95百分位"],"이론 가격":["이론 가격","Theoretical price","理論価格","理论价格"],"Vega · 변동성 1%p":["Vega · 변동성 1%p","Vega · 1pp volatility","Vega · ボラティリティ1ポイント","Vega · 波动率1个百分点"],"Theta · 달력 1일":["Theta · 달력 1일","Theta · calendar day","Theta · 暦日","Theta · 日历日"],"Rho · 금리 1%p":["Rho · 금리 1%p","Rho · 1pp rate","Rho · 金利1ポイント","Rho · 利率1个百分点"],
 "Step":["단계","Step","ステップ","步数"],"Weight":["배분","Weight","配分","权重"],"Asset":["종목","Asset","資産","资产"],"Simulated value":["시뮬레이션 값","Simulated value","シミュレーション値","模拟值"],"Underlying price at expiry":["만기 기초자산 가격","Underlying price at expiry","満期の原資産価格","到期标的价格"],"Expiry payoff / P&L":["만기 지급액 · 손익","Expiry payoff / P&L","満期ペイオフ・損益","到期收益与损益"],"Expiry payoff":["만기 지급액","Expiry payoff","満期ペイオフ","到期收益"],"Payoff less premium":["프리미엄 차감 손익","Payoff less premium","プレミアム控除後損益","扣除权利金后损益"],"Payoff / P&L":["지급액 · 손익","Payoff / P&L","ペイオフ・損益","收益与损益"]
};
const arabicLabels:Record<string,string>={
 "Table":"جدول","Median":"الوسيط","Chart unavailable":"الرسم البياني غير متاح","Step":"الخطوة","Weight":"التخصيص","Asset":"الأصل","Simulated value":"القيمة المحاكاة","Underlying price at expiry":"سعر الأصل عند الاستحقاق","Expiry payoff / P&L":"العائد والربح أو الخسارة عند الاستحقاق","Expiry payoff":"العائد عند الاستحقاق","Payoff less premium":"العائد بعد خصم العلاوة","Payoff / P&L":"العائد والربح أو الخسارة",
 "정규화 공분산 연율 변동성":"التقلب السنوي بعد الانتظام","표본 공분산 연율 변동성":"التقلب السنوي للعينة","과거 일평균 수익률의 연율 환산":"متوسط العائد التاريخي السنوي","최대 제약 위반":"أقصى تجاوز للقيود","시작값":"القيمة الابتدائية","마지막 단계 중앙값":"الوسيط النهائي","마지막 단계 5분위":"المئين الخامس النهائي","마지막 단계 95분위":"المئين الخامس والتسعون النهائي","이론 가격":"السعر النظري","Vega · 변동성 1%p":"Vega · نقطة مئوية من التقلب","Theta · 달력 1일":"Theta · يوم تقويمي","Rho · 금리 1%p":"Rho · نقطة مئوية من الفائدة"
};
const comparisonLabels:Record<string,readonly string[]>={
 symbol:["자산","Asset","資産","资产","الأصل"],weight:["배분","Allocation","配分","配置","التخصيص"],riskShare:["위험 기여","Risk contribution","リスク寄与","风险贡献","مساهمة المخاطر"],annualizedVolatility:["연율 변동성","Annualized volatility","年率ボラティリティ","年化波动率","التقلب السنوي"],metric:["지표","Metric","指標","指标","المقياس"],value:["값","Value","値","值","القيمة"],unit:["단위","Unit","単位","单位","الوحدة"],
 "Observation date":["관측일","Observation date","観測日","观测日","تاريخ الرصد"],"Maturity":["만기","Maturity","満期","期限","الاستحقاق"],"Par curve yield":["액면 수익률","Par curve yield","パー利回り","平价收益率","عائد المنحنى الاسمي"],"Unit":["단위","Unit","単位","单位","الوحدة"],"Symbol":["종목","Symbol","銘柄","代码","الرمز"],"Currency":["통화","Currency","通貨","币种","العملة"],"Close (raw)":["원종가","Close (raw)","終値（元データ）","原始收盘价","سعر الإغلاق الأصلي"],
 "Showing the first 200 rows and 20 columns.":["처음 200행과 20열을 표시합니다.","Showing the first 200 rows and 20 columns.","最初の200行と20列を表示しています。","显示前200行和20列。","يتم عرض أول ٢٠٠ صف و٢٠ عمودًا."]
};
export function financeReportLabel(label:string,language:string):string {const index=/^ko(?:-|$)/i.test(language)?0:/^ja(?:-|$)/i.test(language)?2:/^zh(?:-|$)/i.test(language)?3:/^ar(?:-|$)/i.test(language)?4:1;return comparisonLabels[label]?.[index]??(index===4?arabicLabels[label]??labels[label]?.[1]:labels[label]?.[index])??label;}
function FinanceReportComparison({section,language}:{section:FinanceReportSection;language:string}) {
 const p=section.projection;if(!p?.rows.length)return null;
 const columns=p.columns.slice(0,20),rows=p.rows.slice(0,200),allocation=section.widget?.metric.startsWith("compute:allocation:");
 const cell=(value:string|number|null|undefined,column:string)=>typeof value==="number"?allocation&&["weight","riskShare","annualizedVolatility"].includes(column)?new Intl.NumberFormat(language,{style:"percent",maximumFractionDigits:2}).format(value):financeReportNumber(value,language):value??"—";
 const style={padding:"11px 12px",borderBottom:"1px solid var(--paper-edge)",whiteSpace:"nowrap" as const};
 return <><div tabIndex={0} role="region" aria-label={financeReportSectionTitle(section,language)} style={{overflowX:"auto",maxWidth:"100%"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14,fontVariantNumeric:"tabular-nums"}}><thead><tr>{columns.map((column,i)=><th key={i} scope="col" style={{...style,textAlign:"start"}}>{financeReportLabel(column,language)}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{columns.map((column,j)=><td key={j} style={{...style,textAlign:typeof row[j]==="number"?"end":"start"}}>{cell(row[j],column)}</td>)}</tr>)}</tbody></table></div>{(p.rows.length>200||p.columns.length>20)&&<p>{financeReportLabel("Showing the first 200 rows and 20 columns.",language)}</p>}</>;
}
function localizedSpec(value:unknown,language:string,key=""):unknown {if(Array.isArray(value))return value.map(item=>localizedSpec(item,language,key));if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,localizedSpec(item,language,name)]));if(typeof value==="string"&&(key==="title"||key==="series"))return financeReportLabel(value,language);return value;}
export function financeLocalizedReportChartSpec(section:FinanceReportSection,language:string):Record<string,unknown>|null {const spec=financeReportCompositionTitle(section)?financeReportCompositionSpec(section,language):financeReportChartSpec(section);return spec?localizedSpec(spec,language) as Record<string,unknown>:null;}
export function FinanceReportView({report,locale="en",explicitTableSectionIds=[]}:{report:FinanceReport;locale?:string;explicitTableSectionIds?:readonly string[]}) {
 const language=financeReportLocale(report,locale),warnings=financeReportWarnings(report,language),tables=new Set([...explicitTableSectionIds,...report.sections.filter(section=>section.presentation==="comparison").map(section=>section.id)]);
 const sections=selectFinanceReportSections(report).flatMap(section=>{
  const result=data(section),metric=result?financeMetricForColumns(result.columns):undefined;
  const spec=financeLocalizedReportChartSpec(section,language),computation=!!spec,metrics=tables.has(section.id)?[]:financeReportComputeMetrics(section,language);
  const visual=result&&metric?financeDataVisual(result,metric):null;
  const chart=!tables.has(section.id)&&section.presentation!=="narrative"&&section.widget?.chartType!=="table"&&(computation||!!visual&&visual.kind!=="table");
  if(section.presentation==="supporting")return [];
  if(section.kind==="sources"&&section.presentation!=="narrative"&&!chart&&!tables.has(section.id))return [];
  if(!section.narrative.trim()&&!chart&&!metrics.length&&!tables.has(section.id))return [];
  return [{section,result,chart,spec,metrics,table:tables.has(section.id)&&section.presentation!=="narrative"}];
 });
 const lead=sections.filter(item=>!item.chart&&item.section.kind==="summary");
 const ordered=[...lead,...sections.filter(item=>item.chart),...sections.filter(item=>!item.chart&&item.section.kind!=="summary")];
 return <article className={styles.report} lang={language} dir={financeReportDirection(report,locale)} aria-labelledby={`finance-reader-${report.id}`}><header className={styles.header}><h1 id={`finance-reader-${report.id}`}>{financeReportTitle(report,locale)}</h1></header><div className={styles.body}>{ordered.map(({section,chart,spec,metrics,table})=><section key={section.id} className={[chart?styles.chartSection:styles.section,...(!chart&&!table&&section.kind==="summary"?[styles.lead]:[])].join(" ")} id={`finance-report-section-${section.id}`}>
  {financeReportSectionHeading(section,report,language)&&<h2>{financeReportSectionHeading(section,report,language)}</h2>}
  {!chart&&!metrics.length&&section.narrative.trim()&&<FinanceReportProse value={section.narrative} language={language}/>}
  {metrics.length?<dl style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,170px),1fr))",gap:12,margin:"0 0 24px"}}>{metrics.map((metric,index)=><div key={index} style={{minWidth:0,padding:"14px 16px",border:"1px solid var(--paper-edge)",borderRadius:12}}><dt style={{fontSize:12,lineHeight:1.5,color:"var(--ink-soft)",overflowWrap:"anywhere",marginBottom:8}}>{metric.label}</dt><dd style={{fontSize:22,lineHeight:1.4,fontWeight:500,fontVariantNumeric:"tabular-nums",margin:0,overflowWrap:"anywhere"}}>{metric.display}{metric.unit&&<> <small style={{fontSize:12,fontWeight:400,color:"var(--ink-soft)"}}>{metric.unit}</small></>}</dd></div>)}</dl>:chart&&spec?<><ChartBlock code={JSON.stringify(localizedSpec(spec,language))} blockId={`finance-report-chart-${section.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p>{financeReportLabel("Chart unavailable",language)||"Chart unavailable."}</p>}/>{section.widget?.metric==="compute:forecast:fan"&&<div className={styles.fanLegend}><span>5–95%</span><span>25–75%</span><span>{financeReportLabel("Median",language)||"Median"}</span></div>}</>:table?<FinanceReportComparison section={section} language={language}/>:null}
  {(chart||metrics.length>0)&&section.narrative.trim()&&<div style={chart?{marginTop:24}:undefined}><FinanceReportProse value={section.narrative} language={language}/></div>}
 </section>)}</div><FinanceReportWarnings lines={warnings} dir={financeReportDirection(report,locale)}/></article>;
}

/** Standalone local chart export: deny every loader route and always release each Vega view. */
export async function financeReportExportHtml(report:FinanceReport,locale?:string,explicitTableSectionIds:readonly string[]=[]):Promise<string> {
 if(explicitTableSectionIds.length){const tables=new Set(explicitTableSectionIds);report={...report,sections:report.sections.map(section=>tables.has(section.id)&&section.presentation!=="supporting"&&section.presentation!=="narrative"?{...section,presentation:"comparison"}:section)};}
 const language=financeReportLocale(report,locale),charts:Record<string,string>={},mobileCharts:Record<string,string>={},fixedCharts:string[]=[];
 const candidates=selectFinanceReportSections(report).filter(section=>section.presentation!=="narrative"&&section.presentation!=="comparison").map(section=>({section,spec:financeLocalizedReportChartSpec(section,language)})).filter(item=>!!item.spec);
 if(candidates.length){const [vl,vega,interpreter]=await Promise.all([import("vega-lite"),import("vega"),import("vega-interpreter")]);
 const deny=()=>Promise.reject(new Error("network disabled")),loader={load:deny,sanitize:deny,http:deny,file:deny};
 for(const {section,spec} of candidates){const checked=sanitizeChartSpec(localizedSpec(spec,language));if(!checked.ok)continue;
 // A chart that carries its own plot size (leader-line donut) is drawn once at that size; the others get a wide and a narrow variant.
 const fixed=typeof checked.spec.width==="number"&&typeof checked.spec.height==="number";if(fixed)fixedCharts.push(section.id);
 for(const variant of fixed?[{width:checked.spec.width as number,height:checked.spec.height as number,target:charts}]:[{width:860,height:300,target:charts},{width:340,height:240,target:mobileCharts}]){
 let view:{runAsync:()=>Promise<unknown>;toSVG:()=>Promise<string>;finalize:()=>void}|undefined;
 try {const originalConfig=(checked.spec.config??{}) as Record<string,unknown>,axis=(originalConfig.axis??{}) as Record<string,unknown>,axisX=(originalConfig.axisX??{}) as Record<string,unknown>,axisY=(originalConfig.axisY??{}) as Record<string,unknown>;
 const compiled=vl.compile({...checked.spec,width:variant.width,height:variant.height,autosize:{type:"fit-x",contains:"padding"},config:{...originalConfig,axis:{...axis,labelFontSize:11,titleFontSize:11},axisX:{...axisX,labelAngle:0,labelOverlap:true,tickCount:variant.width<600?3:6},axisY:{...axisY,tickCount:variant.width<600?4:6}}} as never).spec;
 view=new vega.View(vega.parse(compiled as never,undefined,{ast:true}),{renderer:"none",expr:interpreter.expressionInterpreter,loader:loader as never}) as unknown as typeof view;
 await view!.runAsync();const svg=await view!.toSVG();const bytes=new TextEncoder().encode(svg);if(bytes.length>4*1024*1024)continue;
 let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));variant.target[section.id]=`data:image/svg+xml;base64,${btoa(binary)}`;
 }finally {view?.finalize();}
 }}}return financeReportHtml({report,locale:language,charts,mobileCharts,fixedCharts});
}
