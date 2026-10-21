import type { FinanceReport, FinanceReportSection, FinanceWidgetProjection } from './finance';
import { COMPOSITION_CALLOUT_GEOMETRY, compositionCalloutLayout } from './finance-composition-callouts';
import { financePortfolioLineText } from './finance-portfolio';

type PresentedSection = FinanceReportSection & {presentation?:'narrative'|'chart'|'comparison'|'supporting'};
type LocalizedReport = FinanceReport & {language?:string};
const LANGUAGES=['en','ko','ja','zh','ar'] as const;
const COPY:Record<string,readonly string[]>={
 treasury:['US Treasury yields','미국 국채 수익률','米国債利回り','美国国债收益率','عوائد سندات الخزانة الأمريكية'],
 median:['Median','중앙값','中央値','中位数','الوسيط'],
 summary:['Summary','요약','要約','摘要','ملخص'],calculation:['Calculation summary','계산 요약','計算の要約','计算摘要','ملخص الحساب'],
 results:['Calculation results','계산 결과','計算結果','计算结果','نتائج الحساب'],allocation:['Asset allocation','자산배분','資産配分','资产配置','توزيع الأصول'],
 forecast:['Price scenarios','가격 시나리오','価格シナリオ','价格情景','سيناريوهات الأسعار'],option:['Option expiry payoff','옵션 만기 손익','満期時のオプション損益','期权到期损益','عائد الخيار عند الاستحقاق'],
 unavailable:['Chart unavailable','차트를 표시하지 못했습니다','チャートを表示できません','图表不可用','الرسم البياني غير متاح'],
 limited:['Showing the first 200 rows and 20 columns.','처음 200행과 20열을 표시합니다.','最初の200行と20列を表示しています。','显示前200行和20列。','يتم عرض أول ٢٠٠ صف و٢٠ عمودًا.'],
 symbol:['Asset','자산','資産','资产','الأصل'],weight:['Allocation','배분','配分','配置','التخصيص'],riskShare:['Risk contribution','위험 기여','リスク寄与','风险贡献','مساهمة المخاطر'],
 annualizedVolatility:['Annualized volatility','연율 변동성','年率ボラティリティ','年化波动率','التقلب السنوي'],metric:['Metric','지표','指標','指标','المقياس'],value:['Value','값','値','值','القيمة'],unit:['Unit','단위','単位','单位','الوحدة'],
};
function canonical(value:unknown):string|null {if(typeof value!=='string'||!value||value.length>100)return null;try{return Intl.getCanonicalLocales(value)[0]??null;}catch{return null;}}
/** Stored report language wins; a caller locale only supplies the legacy/default language. */
export function reportLanguage(report:FinanceReport,fallback?:string):string {return canonical((report as LocalizedReport).language)??canonical(fallback)??'en';}
export const financeReportLocale=reportLanguage;
export function financeReportDirection(report:FinanceReport,fallback?:string):'ltr'|'rtl' {const locale=new Intl.Locale(reportLanguage(report,fallback)).maximize();return ['Arab','Hebr','Thaa','Nkoo','Adlm','Rohg','Syrc'].includes(locale.script??'')?'rtl':'ltr';}
function copy(key:string,locale:string):string {const language=new Intl.Locale(canonical(locale)??'en').language,index=LANGUAGES.indexOf(language as typeof LANGUAGES[number]);return COPY[key]?.[index<0?0:index]??key;}
const LEGACY_TITLES:Record<string,string>={'요약':'summary','Summary':'summary','계산 요약':'calculation','Calculation summary':'calculation','Key figures':'calculation','계산 결과':'results','Calculation results':'results','자산배분':'allocation','자산배분 결과':'allocation','Asset allocation':'allocation','가격 시나리오':'forecast','Price scenarios':'forecast','옵션 만기 손익':'option','Option expiry payoff':'option','미국 국채 관측 데스크':'treasury','미국 국채 관측 데스크 · 자료 검토':'treasury','Work에서 저장한 미국 국채 관측 데스크':'treasury','Work에서 저장한 미국 국채 관측 데스크 · 자료 검토':'treasury'};
/** Only known application scaffolding is localized. User-authored prose is never machine-translated here. */
export function financeReportSectionTitle(section:Pick<FinanceReportSection,'title'>,locale:string):string {const key=Object.prototype.hasOwnProperty.call(LEGACY_TITLES,section.title)?LEGACY_TITLES[section.title]:undefined;return key?copy(key,locale):section.title;}
export function financeReportTitle(report:FinanceReport,locale?:string):string {return financeReportSectionTitle(report,reportLanguage(report,locale));}
function matches(section:FinanceReportSection,names:readonly string[]):boolean {const p=section.projection;return !!p&&['ready','partial'].includes(p.status)&&p.rows.length>0&&new Set(p.columns).size===p.columns.length&&names.every(name=>p.columns.includes(name));}
/** Exact engine-owned financial projections; no metric or unit inference. */
export function financeReportFinancialData(section:FinanceReportSection):{kind:'cashflow'|'income_goal'|'rebalance'|'portfolio_values';currency:string;rows:Array<{period:string|number;value:number}>}|null {
 const metric=section.widget?.metric,planning=/^planning:(cashflow|income_goal|rebalance)$/.exec(metric??''),kind=metric==='portfolio:values'?'portfolio_values':planning?.[1] as 'cashflow'|'income_goal'|'rebalance'|undefined,p=section.projection,currency=section.widget?.notes;
 if(!kind||!p||!(kind==='portfolio_values'?p.status==='ready':['ready','partial'].includes(p.status))||p.columns.length!==2||p.columns[0]!=='period'||p.columns[1]!=='value'||!p.rows.length||p.rows.length>(kind==='portfolio_values'?500:1201)||!currency||!/^[A-Z]{3}$/.test(currency)||currency==='XXX'||section.widget?.chartType==='table')return null;
 let previous=-1,total=0;const seen=new Set<string|number>();
 for(const row of p.rows){if(row.length!==2||typeof row[1]!=='number'||!Number.isFinite(row[1])||seen.has(row[0] as string|number))return null;
 if((kind==='portfolio_values'||kind==='rebalance')&&row[1]<0)return null;total+=row[1];
 if(kind==='cashflow'){if(typeof row[0]!=='number'||!Number.isInteger(row[0])||row[0]<0||row[0]>1200||row[0]<=previous)return null;previous=row[0];}
 else if(typeof row[0]!=='string'||!row[0].trim()||row[0].length>200)return null;seen.add(row[0] as string|number);}
 if((kind==='portfolio_values'||kind==='rebalance')&&(!Number.isFinite(total)||total<=0))return null;
 return {kind,currency,rows:p.rows.map(row=>({period:row[0] as string|number,value:row[1] as number}))};
}
/** Compatibility export for planning-only callers. */
export function financeReportPlanningData(section:FinanceReportSection){const data=financeReportFinancialData(section);return data?.kind==='portfolio_values'?null:data;}
const COMPOSITION_COPY:Record<string,readonly string[]>={
 portfolio:['Portfolio allocation','포트폴리오 비중','ポートフォリオ配分','投资组合占比','توزيع المحفظة'],
 targets:['Target invested-asset allocation','목표 투자자산 비중','目標投資資産配分','目标投资资产占比','توزيع الأصول المستثمرة المستهدف'],
 allocation:['Asset allocation','자산배분','資産配分','资产配置','توزيع الأصول'],
 asset:['Asset','종목','資産','资产','الأصل'],share:['Allocation','비중','配分','占比','التخصيص'],other:['Other assets','기타 자산','その他の資産','其他资产','أصول أخرى'],
};
function compositionCopy(key:string,locale:string):string {const language=new Intl.Locale(canonical(locale)??'en').language,index=LANGUAGES.indexOf(language as typeof LANGUAGES[number]);return COMPOSITION_COPY[key][index<0?0:index];}
/** 'callout' draws leader-line labels beside the donut; 'legend' keeps the legend underneath for hosts that cannot show a fixed-size chart. */
export type FinanceCompositionVariant='callout'|'legend';
const COMPOSITION_PALETTE=['#3965cb','#df6738','#2f8f7f','#c08a1e','#7d5fb8','#8c8b85','#a83e67','#387c9c','#638c39','#ab6030','#6b5d96','#408c96'];
type CompositionValue={asset:string;value:number;share:number;valueDisplay:string;shareDisplay:string;legendLabel:string;description:string};
function compositionTooltip(locale:string,currency?:string){return [{field:'asset',type:'nominal',title:compositionCopy('asset',locale)},...(currency?[{field:'valueDisplay',type:'nominal',title:currency}]:[]),{field:'shareDisplay',type:'nominal',title:compositionCopy('share',locale)}];}
function compositionLegendSpec(values:readonly CompositionValue[],locale:string,currency?:string):Record<string,unknown>{
 return {data:{values},config:{legend:{layout:{bottom:{anchor:'middle',center:true}}}},mark:{type:'arc',innerRadius:64,tooltip:true},encoding:{description:{field:'description',type:'nominal'},theta:{field:'value',type:'quantitative',stack:true,title:currency??compositionCopy('share',locale)},color:{field:'legendLabel',type:'nominal',sort:null,title:null,scale:{range:COMPOSITION_PALETTE},legend:{orient:'bottom',direction:'horizontal',columns:1,labelLimit:200,title:null}},tooltip:compositionTooltip(locale,currency)}};
}
/** Finished pixel coordinates (`scale:null`): the plot has a fixed size, so no expression is needed and every host draws the same picture. */
function compositionCalloutSpec(values:readonly CompositionValue[],locale:string,currency?:string):Record<string,unknown>{
 // Slices follow the row order clockwise from twelve o'clock (the legend variant leaves the order to the library's stack, which sorts by label text).
 const g=COMPOSITION_CALLOUT_GEOMETRY,plan=compositionCalloutLayout(values.map(row=>row.share));
 const slices=values.map((row,index)=>({...row,start:plan[index].start,end:plan[index].end}));
 const labels=(side:'left'|'right')=>plan.flatMap((callout,index)=>callout.side===side?[{x:callout.label.x,y:callout.label.y,text:values[index].legendLabel}]:[]);
 const pixel={type:'quantitative',scale:null};
 const text=(side:'left'|'right')=>({data:{values:labels(side)},mark:{type:'text',align:side==='right'?'left':'right',baseline:'middle',fontSize:12,limit:g.labelLimit},encoding:{x:{field:'x',...pixel},y:{field:'y',...pixel},text:{field:'text',type:'nominal'}}});
 return {width:g.width,height:g.height,padding:{left:0,right:0,top:g.padding,bottom:g.padding},config:{view:{stroke:null},rule:{color:'#8c8b85',strokeWidth:1}},layer:[
  {data:{values:slices},mark:{type:'arc',innerRadius:g.inner,outerRadius:g.outer,tooltip:true},encoding:{description:{field:'description',type:'nominal'},theta:{field:'start',...pixel},theta2:{field:'end'},color:{field:'legendLabel',type:'nominal',sort:null,title:null,scale:{range:COMPOSITION_PALETTE},legend:null},tooltip:compositionTooltip(locale,currency)}},
  {data:{values:plan.flatMap(callout=>callout.lines)},mark:{type:'rule'},encoding:{x:{field:'x1',...pixel},x2:{field:'x2'},y:{field:'y1',...pixel},y2:{field:'y2'}}},
  ...(['right','left'] as const).filter(side=>labels(side).length).map(text)]};
}
/** The denominator is exactly the displayed same-currency assets, never inferred cash or FX. */
export function financeCompositionSpec(rows:readonly {asset:string;value:number}[],locale='en',currency?:string,variant:FinanceCompositionVariant='callout'):Record<string,unknown>|null {
 if(!rows.length||rows.length>500||currency!==undefined&&(!/^[A-Z]{3}$/.test(currency)||currency==='XXX'))return null;
 const seen=new Set<string>();let total=0;
 for(const row of rows){if(typeof row.asset!=='string'||!row.asset.trim()||row.asset.length>300||seen.has(row.asset)||typeof row.value!=='number'||!Number.isFinite(row.value)||row.value<0||row.value>1e15)return null;seen.add(row.asset);total+=row.value;}
 if(!Number.isFinite(total)||total<=0||currency===undefined&&(rows.some(row=>row.value>1)||Math.abs(total-1)>1e-6))return null;
 let display=rows.map(row=>({...row}));
 if(display.length>12){display.sort((a,b)=>b.value-a.value);const remaining=display.slice(11);let asset=`${compositionCopy('other',locale)} (${remaining.length})`;while(seen.has(asset))asset+=' ·';display=[...display.slice(0,11),{asset,value:remaining.reduce((sum,row)=>sum+row.value,0)}];}
 const number=new Intl.NumberFormat(canonical(locale)??'en',{maximumFractionDigits:2}),percent=new Intl.NumberFormat(canonical(locale)??'en',{style:'percent',maximumFractionDigits:2});
 const values=display.map(row=>{const share=row.value/total,valueDisplay=row.value>0&&row.value<.01?`<${number.format(.01)}`:number.format(row.value),shareDisplay=share>0&&share<.0001?`<${percent.format(.0001)}`:percent.format(share);return {...row,share,valueDisplay,shareDisplay,legendLabel:`${shareDisplay} ${row.asset}`,description:`${row.asset} · ${currency?`${valueDisplay} ${currency} · `:''}${shareDisplay}`};});
 return variant==='legend'?compositionLegendSpec(values,locale,currency):compositionCalloutSpec(values,locale,currency);
}
export function financeReportCompositionTitle(section:FinanceReportSection,locale='en'):string|null {
 const metric=section.widget?.metric,key=metric==='compute:allocation:weights'?'allocation':metric==='planning:rebalance'?'targets':metric==='portfolio:values'||section.widget?.type==='allocation'?'portfolio':null;
 if(!key)return null;const currency=section.widget?.notes,p=section.projection,at=p?.columns.indexOf('Currency')??-1,codes=at>=0?new Set(p!.rows.map(row=>row[at])):new Set([currency]),unit=key==='allocation'?null:codes.size===1?[...codes][0]:null;
 return compositionCopy(key,locale)+(typeof unit==='string'&&/^[A-Z]{3}$/.test(unit)&&unit!=='XXX'?` · ${unit}`:'');
}
/** Typed projections select composition; price, income and time series never enter this branch. */
export function financeReportCompositionSpec(section:FinanceReportSection,locale='en',variant:FinanceCompositionVariant='callout'):Record<string,unknown>|null {
 const p=section.projection,w=section.widget;if(!p||!w||w.chartType==='table'||!['ready','partial'].includes(p.status))return null;
 if(w.metric==='compute:allocation:weights'){
 const names=['assetId','symbol','weight','riskShare','annualizedVolatility'];if(p.columns.length!==names.length||!names.every((name,i)=>p.columns[i]===name))return null;
 const ids=new Set<string>();for(const row of p.rows){if(typeof row[0]!=='string'||!row[0].trim()||row[0].length>200||ids.has(row[0]))return null;ids.add(row[0]);}
 return financeCompositionSpec(p.rows.map(row=>({asset:row[1] as string,value:row[2] as number})),locale,undefined,variant);
 }
 const financial=financeReportFinancialData(section);
 if(financial&&(financial.kind==='portfolio_values'||financial.kind==='rebalance'))return financeCompositionSpec(financial.rows.map(row=>({asset:row.period as string,value:row.value})),locale,financial.currency,variant);
 if(w.type!=='allocation'||new Set(p.columns).size!==p.columns.length||!['Asset','Market value','Currency'].every(name=>p.columns.includes(name)))return null;
 const at=(name:string)=>p.columns.indexOf(name),codes=new Set(p.rows.map(row=>row[at('Currency')]));if(codes.size!==1)return null;const currency=[...codes][0];if(typeof currency!=='string')return null;
 return financeCompositionSpec(p.rows.map(row=>({asset:row[at('Asset')] as string,value:row[at('Market value')] as number})),locale,currency,variant);
}
const COMPUTE_METRIC_LABELS:readonly (readonly string[])[]=[
 ['Annualized volatility (regularized)','정규화 공분산 연율 변동성','年率ボラティリティ（正則化）','年化波动率（正则化）','التقلب السنوي بعد الانتظام'],
 ['Annualized sample volatility','표본 공분산 연율 변동성','標本年率ボラティリティ','年化波动率（样本）','التقلب السنوي للعينة'],
 ['Annualized historical mean','과거 일평균 수익률의 연율 환산','過去平均リターン（年率）','历史平均收益（年化）','متوسط العائد التاريخي السنوي'],
 ['Maximum constraint violation','최대 제약 위반','最大制約違反','最大约束偏差','أقصى تجاوز للقيود'],
 ['Initial value','시작값','初期値','初始值','القيمة الابتدائية'],
 ['Terminal median','마지막 단계 중앙값','最終ステップの中央値','最终步中位数','الوسيط النهائي'],
 ['Terminal 5th percentile','마지막 단계 5분위','最終ステップの5パーセンタイル','最终步第5百分位','المئين الخامس النهائي'],
 ['Terminal 95th percentile','마지막 단계 95분위','最終ステップの95パーセンタイル','最终步第95百分位','المئين الخامس والتسعون النهائي'],
 ['Theoretical price','이론 가격','理論価格','理论价格','السعر النظري'],
 ['Vega · 1pp volatility','Vega · 변동성 1%p','Vega · ボラティリティ1ポイント','Vega · 波动率1个百分点','Vega · نقطة مئوية من التقلب'],
 ['Theta · calendar day','Theta · 달력 1일','Theta · 暦日','Theta · 日历日','Theta · يوم تقويمي'],
 ['Rho · 1pp rate','Rho · 금리 1%p','Rho · 金利1ポイント','Rho · 利率1个百分点','Rho · نقطة مئوية من الفائدة'],
];
export interface FinanceReportMetricCard {label:string;value:number;display:string;unit:string}
/** Only the host's typed metric projection supplies figures; empty legacy rows stay empty. */
export function financeReportComputeMetrics(section:FinanceReportSection,locale='en'):FinanceReportMetricCard[] {
 const p=section.projection;if(section.presentation==='narrative'||section.presentation==='supporting'||!/^compute:(allocation|forecast|option):metrics$/.test(section.widget?.metric??'')||!p||!['ready','partial'].includes(p.status)||!p.rows.length||p.rows.length>1000||new Set(p.columns).size!==p.columns.length||!['metric','value','unit'].every(name=>p.columns.includes(name)))return [];
 const at=(name:string)=>p.columns.indexOf(name),language=new Intl.Locale(canonical(locale)??'en').language,index=LANGUAGES.indexOf(language as typeof LANGUAGES[number]);
 const rows=p.rows.map(row=>({label:row[at('metric')],value:row[at('value')],unit:row[at('unit')]}));
 if(rows.some(row=>typeof row.label!=='string'||!row.label.trim()||row.label.length>300||typeof row.value!=='number'||!Number.isFinite(row.value)||Math.abs(row.value)>1e15||typeof row.unit!=='string'||row.unit.length>120))return [];
 return rows.slice(0,8).map(row=>{const value=row.value as number,label=row.label as string,unit=row.unit as string,percent=unit==='fraction'||unit==='weight',amount=percent?value*100:value,tiny=amount!==0&&Math.abs(amount)<.01;
 const translated=COMPUTE_METRIC_LABELS.find(labels=>labels.includes(label));
 return {label:translated?.[index<0?0:index]??label,value,display:new Intl.NumberFormat(canonical(locale)??'en',tiny?{maximumSignificantDigits:3,...(Math.abs(amount)<.0001?{notation:'scientific' as const}:{})}:{maximumFractionDigits:2}).format(amount),unit:percent?'%':unit==='per spot unit'?'Δ':unit==='per spot unit squared'?'Γ':unit};});
}
/** Conservative legacy recognition: never infer a chart from arbitrary numeric evidence columns. */
export function financeReportHasChart(section:FinanceReportSection):boolean {
 if(financeReportCompositionTitle(section))return !!financeReportCompositionSpec(section);
 if(financeReportFinancialData(section))return true;
 const metric=section.widget?.metric;
 if(metric==='compute:allocation:weights')return matches(section,['assetId','symbol','weight','riskShare','annualizedVolatility']);
 if(metric==='compute:forecast:fan')return matches(section,['step','p05','p25','p50','p75','p95']);
 if(metric==='compute:option:value')return matches(section,['terminalSpot','payoff','payoffLessPremium']);
 if(matches(section,['Observation date','Symbol','Close (raw)'])||matches(section,['Observation date','Maturity','Par curve yield','Unit']))return true;
 const p=section.projection,w=section.widget;
 if(!w||!['chart','comparison'].includes(w.type)||w.chartType==='table'||!matches(section,['Observed at','Symbol','Currency','Price']))return false;
 const currency=p!.columns.indexOf('Currency'),date=p!.columns.indexOf('Observed at'),price=p!.columns.indexOf('Price');
 const codes=new Set(p!.rows.map(row=>row[currency]));return codes.size===1&&[...codes].every(code=>typeof code==='string'&&/^[A-Z]{3}$/.test(code)&&code!=='XXX')&&p!.rows.every(row=>typeof row[date]==='string'&&Number.isFinite(Date.parse(row[date] as string))&&typeof row[price]==='number'&&Number.isFinite(row[price]));
}
/** Titles of the application's own "where this came from" sections: a plain list of URLs and times that repeats the data section before it. */
const SCAFFOLD_TITLES:readonly string[]=['계산 입력','원출처와 조회 시각','가정과 방법','Calculation inputs','Source URLs and retrieval time','Assumptions and method'];
export function selectFinanceReportSections(report:FinanceReport):FinanceReportSection[] {
 const hasComputeMain=report.sections.some(section=>section.kind!=='sources'&&section.presentation!=='supporting'&&/^compute:(allocation:weights|forecast:fan|option:value)$/.test(section.widget?.metric??'')&&financeReportHasChart(section));
 return report.sections.filter(raw=>{const section=raw as PresentedSection;if(section.presentation==='supporting')return false;if(section.presentation==='narrative')return !!section.narrative.trim();if(section.presentation)return ['chart','comparison'].includes(section.presentation)&&(section.kind!=='sources'||section.presentation==='chart'&&financeReportHasChart(section));if(hasComputeMain&&section.kind==='sources')return false;if(section.kind==='sources'&&SCAFFOLD_TITLES.includes(section.title))return false;if(financeReportHasChart(section)||financeReportComputeMetrics(section).length)return true;if(section.kind==='sources')return false;return !!section.narrative.trim();});}
export function financeReportNumber(value:number,locale='en'):string {if(!Number.isFinite(value))return '—';return new Intl.NumberFormat(canonical(locale)??'en',Math.abs(value)>=10000?{notation:'compact',maximumFractionDigits:2}:value!==0&&Math.abs(value)<.01?{maximumSignificantDigits:2}:{maximumFractionDigits:2}).format(value);}
function escape(value:unknown):string {return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));}
function link(value:string):string|null {try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&value.length<=2000?url.href:null;}catch{return null;}}
function inline(value:string):string {
 value=value.replace(/\[row\s+\d+\]/gi,'');
 let html='',last=0;const tokens=/\[([^\]\n]{1,1000})\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`/g;
 for(const match of value.matchAll(tokens)){html+=escape(value.slice(last,match.index));if(match[1]){const url=link(match[2]);html+=url?'<a href="'+escape(url)+'" rel="noopener noreferrer" target="_blank">'+escape(match[1])+'</a>':escape(match[1]);}else if(match[3]||match[4])html+='<strong>'+escape(match[3]??match[4])+'</strong>';else html+=escape(match[5]);last=match.index!+match[0].length;}
 return html+escape(value.slice(last));
}
/** Small non-HTML Markdown subset. Escaping always happens before emitting any trusted tags. */
export function financeReportIsMetadataLine(value:string):boolean {
 const match=/^\s*(input sha256|sourceRevision|retrievedAt):\s*(.*?)\s*$/.exec(value);if(!match)return false;
 if(match[1]==='input sha256')return /^[a-f0-9]{64}$/i.test(match[2]);
 if(match[1]==='sourceRevision')return /^\d+$/.test(match[2]);
 return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(match[2])&&Number.isFinite(Date.parse(match[2]));
}
/** Reading copy only: the exact app document wrapper and empty comments carry no prose. */
export function financeReportReadingProse(value:string):string {
 return value.replace(/<!--\s*-->/g,'').replace(/^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*---[ \t]*\r?\n[ \t]*document:[ \t]*([^\r\n]+)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/,(wrapper,title:string)=>title.trim()?'':wrapper);
}
export type FinanceReportProseTable={kind:'table';text:string;columns:string[];rows:string[][];align:Array<'start'|'center'|'end'>};
export type FinanceReportProseBlock={kind:'paragraph'|'heading'|'quote';text:string}|FinanceReportProseTable;
const TABLE_ROW=/^\s*\|.*\|\s*$/,TABLE_DELIMITER=/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// The most a reading surface (and the phone's document contract) takes in one table; a larger or ragged one is not drawn.
const TABLE_LIMITS={columns:12,rows:100,cell:240};
function tableCells(line:string):string[] {
 let value=line.trim();if(value.startsWith('|'))value=value.slice(1);if(value.endsWith('|')&&!value.endsWith('\\|'))value=value.slice(0,-1);
 const cells:string[]=[];let cell='';
 for(let i=0;i<value.length;i++){const char=value[i];if(char==='\\'&&value[i+1]==='|'){cell+='|';i++;}else if(char==='|'){cells.push(cell);cell='';}else cell+=char;}
 cells.push(cell);return cells.map(item=>item.replace(/\s*\[row\s+\d+\]/gi,'').trim());
}
/** A GitHub-style table: a header row, a delimiter row, then body rows. Anything else made of pipes stays out of the reading copy. */
function proseTable(lines:string[]):FinanceReportProseTable|null {
 if(lines.length<3||!TABLE_DELIMITER.test(lines[1]))return null;
 const columns=tableCells(lines[0]),delimiter=tableCells(lines[1]);
 if(columns.length>TABLE_LIMITS.columns||delimiter.length!==columns.length||columns.some(name=>!name))return null;
 const rows=lines.slice(2).map(line=>{const cells=tableCells(line);return columns.map((_,index)=>cells[index]??'');});
 if(!rows.length||rows.length>TABLE_LIMITS.rows||[...columns,...rows.flat()].some(cell=>cell.length>TABLE_LIMITS.cell))return null;
 return {kind:'table',text:lines.join('\n'),columns,rows,align:delimiter.map(cell=>cell.startsWith(':')?cell.endsWith(':')?'center':'start':cell.endsWith(':')?'end':'start')};
}
/** One reading structure for the native reader and standalone HTML; evidence stays in the saved projection. */
export function financeReportProseBlocks(value:string):FinanceReportProseBlock[] {
 const blocks:FinanceReportProseBlock[]=[];
 let paragraph:string[]=[],kind:'paragraph'|'quote'='paragraph',fenced=false;
 const flush=()=>{if(paragraph.length){blocks.push({kind,text:paragraph.join(' ')});paragraph=[];}};
 const lines=financeReportReadingProse(value).slice(0,20000).replace(/\r\n?/g,'\n').split('\n');
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  if(/^\s*```/.test(line)){flush();fenced=!fenced;continue;}
  if(fenced)continue;
  if(TABLE_ROW.test(line)){flush();const run=[line];while(index+1<lines.length&&TABLE_ROW.test(lines[index+1]))run.push(lines[++index]);const table=proseTable(run);if(table)blocks.push(table);continue;}
  if(!line.trim()||/^\s*(?:\[row\s+\d+\]\s*)+$/i.test(line)||financeReportIsMetadataLine(line)){flush();continue;}
  const heading=/^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
  if(heading){flush();blocks.push({kind:'heading',text:heading[1]});continue;}
  const item=/^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)(.+)$/.exec(line);
  if(item){flush();blocks.push({kind:'paragraph',text:item[1]});continue;}
  const quote=/^\s*>\s?(.*)$/.exec(line),next=quote?'quote':'paragraph';
  if(kind!==next)flush();kind=next;paragraph.push((quote?.[1]??line).trim());
 }
 flush();return blocks;
}
function proseTableHtml(block:FinanceReportProseTable):string {
 const cell=(tag:'th'|'td',text:string,index:number)=>'<'+tag+(tag==='th'?' scope="col"':'')+(block.align[index]==='end'?' class="numeric"':'')+'>'+inline(text)+'</'+tag+'>';
 return '<div class="table-scroll" tabindex="0"><table><thead><tr>'+block.columns.map((name,index)=>cell('th',name,index)).join('')+'</tr></thead><tbody>'+block.rows.map(row=>'<tr>'+row.map((text,index)=>cell('td',text,index)).join('')+'</tr>').join('')+'</tbody></table></div>';
}
export function financeReportProseHtml(value:string):string {
 return financeReportProseBlocks(value).map(block=>{if(block.kind==='table')return proseTableHtml(block);const tag=block.kind==='heading'?'h3':block.kind==='quote'?'blockquote':'p';return '<'+tag+'>'+inline(block.text)+'</'+tag+'>';}).join('');
}
/** Suppress only the application's generic scaffolding, in both reading surfaces. */
export function financeReportSectionHeading(section:FinanceReportSection,report:FinanceReport,locale:string):string|null {
 const composition=financeReportCompositionTitle(section,locale);if(composition)return composition;
 if(section.title===report.title||/^(Summary|Sources and limitations|Sources|요약|계산 요약|가정과 방법|要約|概要|摘要|总结|總結|ملخص)$/i.test(section.title.trim()))return null;
 return financeReportSectionTitle(section,locale);
}
// ── Sources and as-of dates ──────────────────────────────────────────────────────────────────────────────────────────────────────
// A saved report keeps, per section, the provider records it was built from, the as-of date and the provider's own limits. The reading surfaces draw
// narrative and typed charts only, so this block is the one place the owner sees where a value came from and how old it is. It is built from those
// stored fields alone: no model sentence, no guess, and a date the provider did not record stays "not recorded".
/** What the block reads of a saved source record. A result card carries exactly these (it has no workspace); `note` is the first line of the provider's own statement of its limits. */
export interface FinanceReportSourceRecord {id:string;name:string;asOf:string|null;retrievedAt:string;note:string}
export interface FinanceReportSourceFact {label:string;values:string[]}
/** `hidden`: rows the record held beyond the limit, counted so a surface can say so. */
export interface FinanceReportSourceTable {columns:string[];rows:string[][];numeric:number[];hidden:number}
export interface FinanceReportSourceEntry {sectionId:string;title:string;facts:FinanceReportSourceFact[];table:FinanceReportSourceTable|null}
/** `hidden`: sections past the limit, counted. `language` is the one the labels are in, for `financeReportSourceMore`; `direction` is the report's, for a surface that cannot set it per value. */
export interface FinanceReportSourceBlock {title:string;language:string;direction:'ltr'|'rtl';entries:FinanceReportSourceEntry[];hidden:number}
/** The most any surface is given: the phone's document takes 100 table rows, 240 characters in a cell and 160 in a title. */
export const FINANCE_REPORT_SOURCE_LIMITS={records:50,entries:40,providers:3,limitLines:3,rows:100,title:160,line:240,name:120,note:400} as const;
const SOURCE_COPY:Record<string,readonly string[]>={
 title:['Sources and as-of dates','출처·기준일','出典・基準日','来源与基准日','المصادر وتواريخ الاعتماد'],
 provider:['Provider','제공처','提供元','数据提供方','المزوّد'],
 asOf:['Data as of','기준일','基準日','数据基准日','تاريخ البيانات'],
 retrieved:['Retrieved','조회 시각','取得日時','获取时间','وقت الجلب'],
 limits:['Limits','한계','制約','局限','القيود'],
 noAsOf:['No as-of date recorded','기록된 기준일 없음','基準日の記録なし','未记录基准日','لا يوجد تاريخ اعتماد مسجّل'],
 differs:['differs by provider','제공처마다 다름','提供元ごとに異なる','因数据提供方而异','يختلف حسب المزوّد'],
 noRecord:['No saved source record','저장된 출처 기록 없음','保存された出典記録なし','无已保存的来源记录','لا يوجد سجل مصدر محفوظ'],
 snapshot:['Observed portfolio snapshot','관측 시점 포트폴리오 스냅숏','観測時点のポートフォリオ','观测时点投资组合快照','لقطة المحفظة المرصودة'],
 asset:['Asset','종목','資産','资产','الأصل'],price:['Price','가격','価格','价格','السعر'],
};
/** The host's own machine codes in a saved projection's warnings, said in the report's language; any other warning is the provider's sentence and is shown as stored. */
const SOURCE_CODES:Record<string,readonly string[]>={
 finance_portfolio_mixed_observation_dates:['Holdings were priced on different observation dates; see each row.','보유 종목마다 가격 관측일이 다릅니다. 종목별 표를 확인하세요.','保有銘柄ごとに価格の観測日が異なります。銘柄別の表をご確認ください。','各持仓的价格观测日期不同，请查看逐项表格。','تختلف تواريخ رصد أسعار الأصول المملوكة؛ راجع الجدول لكل أصل.'],
 finance_portfolio_currencies_not_aggregated:['Values in different currencies are neither converted nor added together.','통화가 다른 금액은 환산하거나 합산하지 않았습니다.','通貨が異なる金額は換算も合算もしていません。','不同币种的金额未换算，也未合计。','لم يتم تحويل المبالغ بعملات مختلفة ولا جمعها معًا.'],
 finance_portfolio_refresh_coverage_partial:['Some holdings have no verified price, so they are left out of the values.','일부 보유 종목은 확인된 가격이 없어 평가에서 제외했습니다.','一部の保有銘柄は確認済みの価格がないため、評価から除外しました。','部分持仓没有已核实的价格，已从估值中排除。','لا يوجد سعر مؤكد لبعض الأصول المملوكة، لذلك استُبعدت من التقييم.'],
 finance_portfolio_incomplete_currency_group:['A currency group is missing prices, so its total is not shown.','일부 통화 묶음은 가격이 빠져 있어 합계를 표시하지 않았습니다.','価格が欠けている通貨グループは、合計を表示していません。','部分币种组缺少价格，因此未显示其合计。','تفتقر مجموعة عملة إلى الأسعار، لذلك لم يُعرض إجماليها.'],
 finance_portfolio_quote_conflict:['Conflicting prices were returned for a holding, so it is left out.','한 보유 종목에 서로 다른 가격이 와서 그 종목은 제외했습니다.','同じ銘柄に異なる価格が返されたため、その銘柄は除外しました。','同一持仓返回了相互冲突的价格，已将其排除。','وصلت أسعار متعارضة لأحد الأصول، لذلك استُبعد.'],
 finance_portfolio_quote_incompatible:['A returned price did not match the holding (currency, basis or date), so it is left out.','받은 가격이 보유 종목과 맞지 않아(통화·기준·날짜) 제외했습니다.','受け取った価格が保有銘柄と一致しないため（通貨・基準・日付）、除外しました。','收到的价格与持仓不匹配（币种、口径或日期），已排除。','لم يتطابق السعر الوارد مع الأصل (العملة أو الأساس أو التاريخ)، لذلك استُبعد.'],
 finance_portfolio_value_out_of_range:['A computed value was outside the supported range, so it is left out.','계산된 금액이 지원 범위를 벗어나 제외했습니다.','計算結果が対応範囲外のため、除外しました。','计算出的金额超出支持范围，已排除。','كانت القيمة المحسوبة خارج النطاق المدعوم، لذلك استُبعدت.'],
 finance_portfolio_zero_total_weights_undefined:['The total is zero, so weights are not defined.','합계가 0이라 비중을 정의할 수 없습니다.','合計が0のため、比率は定義できません。','合计为 0，无法定义占比。','الإجمالي صفر، لذلك لا يمكن تحديد النسب.'],
};
const SOURCE_MORE:Record<string,(count:number)=>string>={en:count=>`+${count} more`,ko:count=>`외 ${count}건`,ja:count=>`ほか${count}件`,zh:count=>`另有 ${count} 项`,ar:count=>`+${count} أخرى`};
function sourceLanguage(locale:string):typeof LANGUAGES[number] {const language=new Intl.Locale(canonical(locale)??'en').language as typeof LANGUAGES[number];return LANGUAGES.includes(language)?language:'en';}
function sourceCopy(key:string,locale:string):string {return SOURCE_COPY[key]?.[LANGUAGES.indexOf(sourceLanguage(locale))]??key;}
function sourceMore(count:number,locale:string):string {return SOURCE_MORE[sourceLanguage(locale)](count);}
/** "N more" in the block's language, for the rows or sections it counted but did not keep. */
export function financeReportSourceMore(count:number,locale:string):string {return sourceMore(count,locale);}
/** One clean line of at most `limit` characters, never cut through a surrogate pair (the phone's table widget cannot draw half of one). */
function sourceLine(value:string,limit:number):string {const line=financePortfolioLineText(value);if(line.length<=limit)return line;const end=limit-1;return line.slice(0,/[\uD800-\uDBFF]/.test(line[end-1]??'')?end-1:end)+'…';}
/** A calendar date stays as it is; a moment is shown in UTC, so the same report reads the same on every surface and in every time zone. */
function sourceTime(value:string|null|undefined):string|null {
 if(!value)return null;if(/^\d{4}-\d{2}-\d{2}$/.test(value))return Number.isFinite(Date.parse(value))?value:null;
 const at=Date.parse(value);return Number.isFinite(at)?new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC':null;
}
function sourceRange(values:readonly (string|null|undefined)[]):{first:string;last:string}|null {
 const known=values.filter((value):value is string=>sourceTime(value)!==null).sort((a,b)=>Date.parse(a)-Date.parse(b));
 return known.length?{first:sourceTime(known[0])!,last:sourceTime(known[known.length-1])!}:null;
}
function sourceSpan(values:readonly (string|null|undefined)[]):string|null {const range=sourceRange(values);return range?range.first===range.last?range.first:`${range.first} – ${range.last}`:null;}
/** The section's own as-of date; with none, what its providers recorded; with none of that, the plain statement that nothing was recorded. */
function sourceAsOf(p:FinanceWidgetProjection,providers:readonly FinanceReportSourceRecord[],locale:string):string {
 const own=sourceTime(p.asOf);if(own)return own;
 const range=sourceRange(providers.map(source=>source.asOf));if(!range)return sourceCopy('noAsOf',locale);
 return range.first===range.last?range.first:`${range.first} – ${range.last} (${sourceCopy('differs',locale)})`;
}
/** A saved note is several lines (limits, rights, then URLs); the block reads the first, whether it is handed the workspace's record or the card's compact one. */
function sourceFirstLine(note:string|undefined):string {return (note??'').split(/\r?\n/)[0];}
/** The provider's first limit sentence per distinct provider note (when the section's warnings do not already say it), then the section's own warnings. */
function sourceLimits(p:FinanceWidgetProjection,providers:readonly FinanceReportSourceRecord[],locale:string):string[] {
 const warnings=p.warnings.map(raw=>({raw:financePortfolioLineText(raw),text:Object.prototype.hasOwnProperty.call(SOURCE_CODES,raw.trim())?SOURCE_CODES[raw.trim()][LANGUAGES.indexOf(sourceLanguage(locale))]:raw})).filter(item=>item.raw);
 const notes=[...new Set(providers.map(source=>financePortfolioLineText(sourceFirstLine(source.note))).filter(Boolean))].filter(note=>!warnings.some(item=>item.raw.startsWith(note)||note.startsWith(item.raw)));
 return [...new Set([...notes,...warnings.map(item=>item.text)].map(line=>sourceLine(line,FINANCE_REPORT_SOURCE_LIMITS.line)).filter(Boolean))];
}
function jsonObject(value:unknown):Record<string,unknown>|null {return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
/** The host freezes a portfolio valuation as JSON split into numbered parts. Its prices, dates and providers are read back into a table; text that is not that record is never shown. */
function portfolioSnapshot(p:FinanceWidgetProjection,locale:string):{retrieved:string|null;table:FinanceReportSourceTable}|null {
 if(p.columns.length!==2||p.columns[0]!=='Part'||p.columns[1]!=='Observed record'||!p.rows.length||p.rows.some(row=>typeof row[0]!=='number'||typeof row[1]!=='string'))return null;
 const parts=[...p.rows].sort((a,b)=>(a[0] as number)-(b[0] as number));if(parts.some((row,index)=>row[0]!==index+1))return null;
 const json=parts.map(row=>row[1] as string).join('');if(json.length>2_000_000)return null;
 let doc:unknown;try{doc=JSON.parse(json);}catch{return null;}
 const root=jsonObject(doc),groups=root&&Array.isArray(root.groups)?root.groups:null,listed=root&&Array.isArray(root.sources)?root.sources:null;if(!root||!groups||!listed)return null;
 const names=new Map<string,string>();for(const raw of listed){const source=jsonObject(raw);if(source&&typeof source.id==='string'&&typeof source.name==='string')names.set(source.id,source.name);}
 const number=new Intl.NumberFormat(canonical(locale)??'en',{maximumFractionDigits:6}),rows:string[][]=[];
 for(const rawGroup of groups){const group=jsonObject(rawGroup),items=group&&Array.isArray(group.items)?group.items:null;if(!group||!items||typeof group.currency!=='string')return null;
  const currency=/^[A-Z]{3}$/.test(group.currency)?` ${group.currency}`:'';
  for(const rawItem of items){const item=jsonObject(rawItem);if(!item||typeof item.symbol!=='string')return null;
   const price=typeof item.price==='number'&&Number.isFinite(item.price)?number.format(item.price)+currency:'—',asOf=typeof item.asOf==='string'?sourceTime(item.asOf):null,provider=typeof item.sourceId==='string'?names.get(item.sourceId):undefined;
   rows.push([sourceLine(item.symbol,80),price,asOf??'—',provider?sourceLine(provider,FINANCE_REPORT_SOURCE_LIMITS.name):'—']);}}
 if(!rows.length)return null;const shown=FINANCE_REPORT_SOURCE_LIMITS.rows;
 return {retrieved:sourceTime(typeof root.retrievedAt==='string'?root.retrievedAt:null),table:{columns:[sourceCopy('asset',locale),sourceCopy('price',locale),sourceCopy('asOf',locale),sourceCopy('provider',locale)],rows:rows.slice(0,shown),numeric:[1],hidden:Math.max(0,rows.length-shown)}};
}
function sourceEntry(section:FinanceReportSection,p:FinanceWidgetProjection,locale:string,byId:ReadonlyMap<string,FinanceReportSourceRecord>):FinanceReportSourceEntry {
 const L=FINANCE_REPORT_SOURCE_LIMITS,facts:FinanceReportSourceFact[]=[],snapshot=portfolioSnapshot(p,locale),ids=[...new Set(p.sourceIds)],providers=snapshot?[]:ids.flatMap(id=>byId.get(id)??[]);
 if(!snapshot&&ids.length){
  const names=[...new Set(providers.map(source=>sourceLine(source.name,L.name)).filter(Boolean))],missing=ids.length-providers.length;
  facts.push({label:sourceCopy('provider',locale),values:[...(names.length?[names.slice(0,L.providers).join(' / ')+(names.length>L.providers?' '+sourceMore(names.length-L.providers,locale):'')]:[]),...(missing?[`${sourceCopy('noRecord',locale)} (${missing})`]:[])]});
 }
 if(!snapshot)facts.push({label:sourceCopy('asOf',locale),values:[sourceAsOf(p,providers,locale)]});
 const retrieved=snapshot?snapshot.retrieved:sourceSpan(providers.map(source=>source.retrievedAt));if(retrieved)facts.push({label:sourceCopy('retrieved',locale),values:[retrieved]});
 const limits=sourceLimits(p,providers,locale);
 if(limits.length){const shown=limits.slice(0,L.limitLines);if(limits.length>shown.length)shown.push(sourceMore(limits.length-shown.length,locale));facts.push({label:sourceCopy('limits',locale),values:shown});}
 return {sectionId:section.id,title:snapshot?sourceCopy('snapshot',locale):sourceLine(financeReportSectionTitle(section,locale),L.title),facts,table:snapshot?snapshot.table:null};
}
/** The saved source records a report points at, in the order its sections first name them: the compact form a result card carries (a card has no workspace). */
export function financeReportSourceRecords(report:FinanceReport,sources:readonly FinanceReportSourceRecord[]|undefined):FinanceReportSourceRecord[] {
 if(!sources?.length)return [];
 const byId=new Map(sources.map(source=>[source.id,source] as const)),seen=new Set<string>(),records:FinanceReportSourceRecord[]=[];
 for(const section of report.sections)for(const id of section.projection?.sourceIds??[]){
  if(seen.has(id)||records.length>=FINANCE_REPORT_SOURCE_LIMITS.records)continue;seen.add(id);
  const source=byId.get(id);if(source)records.push({id,name:source.name,asOf:source.asOf,retrievedAt:source.retrievedAt,note:sourceLine(sourceFirstLine(source.note),FINANCE_REPORT_SOURCE_LIMITS.note)});
 }
 return records;
}
/** The host's own listing of a provider's URLs and retrieval time (columns `url`, `retrievedAt`): the model retitles it ("price sources and limits") but never changes its shape. */
function urlTimeListing(p:FinanceWidgetProjection|null):boolean {return !!p&&p.columns.length===2&&p.columns[0]==='url'&&p.columns[1]==='retrievedAt';}
/** The "sources and as-of dates" block of a report, or null when no section names a provider record or an as-of date. A section that only lists a provider's URLs and retrieval time (the host's scaffold, under whatever title the model gave it) is not repeated when every record it names is already listed by another section. */
export function financeReportSourceBlock(report:FinanceReport,sources:readonly FinanceReportSourceRecord[]|undefined,locale?:string):FinanceReportSourceBlock|null {
 const language=reportLanguage(report,locale),byId=new Map((sources??[]).map(source=>[source.id,source] as const));
 const scaffold=(section:FinanceReportSection)=>section.kind==='sources'&&(SCAFFOLD_TITLES.includes(section.title)||urlTimeListing(section.projection));
 const named=new Set(report.sections.filter(section=>!scaffold(section)).flatMap(section=>section.projection?.sourceIds??[]));
 const entries:FinanceReportSourceEntry[]=[];
 for(const section of report.sections){const p=section.projection;
  if(!p||!p.sourceIds.length&&!p.asOf||scaffold(section)&&p.sourceIds.length>0&&p.sourceIds.every(id=>named.has(id)))continue;
  entries.push(sourceEntry(section,p,language,byId));}
 if(!entries.length)return null;
 return {title:sourceCopy('title',language),language,direction:financeReportDirection(report,locale),entries:entries.slice(0,FINANCE_REPORT_SOURCE_LIMITS.entries),hidden:Math.max(0,entries.length-FINANCE_REPORT_SOURCE_LIMITS.entries)};
}
function sourcesHtml(block:FinanceReportSourceBlock):string {
 const table=(item:FinanceReportSourceTable)=>'<div class="table-scroll" tabindex="0"><table><thead><tr>'+item.columns.map((name,index)=>'<th scope="col"'+(item.numeric.includes(index)?' class="numeric"':'')+'>'+escape(name)+'</th>').join('')+'</tr></thead><tbody>'+item.rows.map(row=>'<tr>'+row.map((text,index)=>'<td dir="auto"'+(item.numeric.includes(index)?' class="numeric"':'')+'>'+escape(text)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+(item.hidden?'<p class="muted">'+escape(sourceMore(item.hidden,block.language))+'</p>':'');
 return '<details class="sources"><summary>'+escape(block.title)+'</summary>'+block.entries.map(entry=>'<section class="source-entry"><h3>'+escape(entry.title)+'</h3>'+(entry.facts.length?'<dl>'+entry.facts.map(fact=>'<div><dt>'+escape(fact.label)+'</dt><dd>'+fact.values.map(value=>'<span dir="auto">'+escape(value)+'</span>').join('')+'</dd></div>').join('')+'</dl>':'')+(entry.table?table(entry.table):'')+'</section>').join('')+(block.hidden?'<p class="muted">'+escape(sourceMore(block.hidden,block.language))+'</p>':'')+'</details>';
}
/** Image-only SVG context plus defense-in-depth rejection of active/external XML features. */
export function financeReportChartImage(value:unknown):string|null {
 if(typeof value!=='string'||value.length>Math.ceil(4*1024*1024/3)*4+40)return null;
 const match=/^data:image\/(png|svg\+xml);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);if(!match||!match[2]||match[2].length%4)return null;
 let decoded:string;try{decoded=atob(match[2]);}catch{return null;}if(decoded.length>4*1024*1024)return null;
 if(match[1]==='png'){if(!decoded.startsWith('\x89PNG\r\n\x1a\n')||decoded.slice(12,16)!=='IHDR'||decoded.length<24)return null;const read=(start:number)=>Array.from(decoded.slice(start,start+4)).reduce((n,c)=>n*256+c.charCodeAt(0),0),width=read(16),height=read(20);if(!width||!height||width>12000||height>12000||width*height>32000000)return null;}
 else{if(!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(decoded)||!/<\/svg>\s*$/i.test(decoded)||/<!DOCTYPE|<!ENTITY|<\?|<\s*(?:script|foreignObject|iframe|object|embed|image|style|animate\w*|set|a)\b|\bon[a-z]+\s*=|javascript\s*:|xml:base\s*=|\\[a-z0-9]|@import|url\(\s*['"]?(?!#)/i.test(decoded)||/(?:href|src)\s*=\s*(['"])(?!#)[\s\S]*?\1/i.test(decoded))return null;}
 return value;
}
function comparison(section:FinanceReportSection,locale:string):string {const p=section.projection;if(!p?.rows.length)return '';const columns=p.columns.slice(0,20),rows=p.rows.slice(0,200),compute=section.widget?.metric.startsWith('compute:allocation:');
 const cell=(value:unknown,name:string)=>typeof value==='number'?escape(compute&&['weight','riskShare','annualizedVolatility'].includes(name)?new Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:2}).format(value):financeReportNumber(value,locale)):escape(value===null||value===undefined?'—':value);
 return '<div class="table-scroll" tabindex="0" role="region" aria-label="'+escape(financeReportSectionTitle(section,locale))+'"><table><thead><tr>'+columns.map(name=>'<th scope="col">'+escape(Object.prototype.hasOwnProperty.call(COPY,name)?copy(name,locale):name)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map((name,i)=>'<td'+(typeof row[i]==='number'?' class="numeric"':'')+'>'+cell(row[i],name)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+((p.rows.length>200||p.columns.length>20)?'<p class="muted">'+escape(copy('limited',locale))+'</p>':'');}
/** `fixedCharts` names the sections whose chart has a drawn size of its own: it is shown at that size, centered, never stretched to the page. */
export function financeReportHtml({report,locale,charts={},mobileCharts={},fixedCharts=[],sources}:{report:FinanceReport;locale?:string;charts?:Record<string,string>;mobileCharts?:Record<string,string>;fixedCharts?:readonly string[];sources?:readonly FinanceReportSourceRecord[]}):string {
 const language=reportLanguage(report,locale),direction=financeReportDirection(report,locale),title=financeReportTitle(report,locale),sourceBlock=financeReportSourceBlock(report,sources,language);
 const isChartSection=(section:FinanceReportSection)=>section.presentation==='chart'||!section.presentation&&financeReportHasChart(section);
 const rank=(section:FinanceReportSection)=>isChartSection(section)?1:section.kind==='summary'?0:2;
 const sections=selectFinanceReportSections(report).sort((a,b)=>rank(a)-rank(b)).map(raw=>{const section=raw as PresentedSection,chart=financeReportChartImage(Object.prototype.hasOwnProperty.call(charts,section.id)?charts[section.id]:undefined),mobileChart=financeReportChartImage(Object.prototype.hasOwnProperty.call(mobileCharts,section.id)?mobileCharts[section.id]:undefined),isChart=isChartSection(section);
  const caption=section.widget?.metric==='compute:forecast:fan'&&financeReportHasChart(section)?'<figcaption class="fan-legend"><span><i class="band outer" aria-hidden="true"></i>5–95%</span><span><i class="band inner" aria-hidden="true"></i>25–75%</span><span><i class="median" aria-hidden="true"></i>'+escape(copy('median',language))+'</span></figcaption>':'';
  const metrics=section.presentation==='comparison'?[]:financeReportComputeMetrics(section,language),cards=metrics.length?'<dl class="metric-cards">'+metrics.map(metric=>'<div><dt>'+escape(metric.label)+'</dt><dd>'+escape(metric.display)+(metric.unit?' <small>'+escape(metric.unit)+'</small>':'')+'</dd></div>').join('')+'</dl>':'';
  const visual=cards|| (section.presentation==='comparison'?comparison(section,language):isChart?(chart?'<figure>'+(mobileChart&&!fixedCharts.includes(section.id)?'<picture><source media="(max-width:600px)" srcset="'+escape(mobileChart)+'"/>':'')+'<img'+(fixedCharts.includes(section.id)?' class="fixed"':'')+' src="'+escape(chart)+'" alt="'+escape(financeReportSectionTitle(section,language))+'"/>'+(mobileChart&&!fixedCharts.includes(section.id)?'</picture>':'')+caption+'</figure>':section.narrative.trim()?'':'<p class="muted">'+escape(copy('unavailable',language))+'</p>'):'');
  const prose=financeReportProseHtml(section.narrative);if(!prose&&!visual)return '';const heading=financeReportSectionHeading(section,report,language);return '<section class="report-section'+(!isChart&&section.presentation!=='comparison'&&section.kind==='summary'?' lead':'')+'">'+(heading?'<h2>'+escape(heading)+'</h2>':'')+(isChart||cards?visual+'<div class="prose">'+prose+'</div>':'<div class="prose">'+prose+'</div>'+visual)+'</section>';
 }).join('');
 return '<!doctype html><html lang="'+escape(language)+'" dir="'+direction+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>'+escape(title)+'</title><style>html{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#28343e;font:16px/1.85 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}main{max-width:960px;margin:32px auto;padding:56px 56px 64px;background:#fff;border:1px solid #e4e8ed;border-radius:12px}header{border-top:3px solid #3f6589;border-bottom:1px solid #e4e8ed;padding:28px 0;margin-bottom:32px}h1,h2,h3{color:#182e3e;line-height:1.35;font-weight:600;overflow-wrap:break-word;text-wrap:balance}h1{font-size:clamp(28px,3.5vw,40px);letter-spacing:-.035em;margin:0;max-width:100%;word-break:auto-phrase}h2{font-size:20px;letter-spacing:-.015em;margin:0 0 18px}h3{font-size:17px;margin:26px 0 12px}section{margin:0 0 36px;min-width:0}section:last-child{margin-bottom:0}.prose{max-width:72ch;overflow-wrap:anywhere;word-break:normal;text-wrap:pretty}.prose p{margin:0 0 18px}.prose p:last-child{margin-bottom:0}.lead .prose>p:first-of-type{font-size:19px;line-height:1.85;color:#253c4c}.prose strong{font-weight:600;color:#182e3e}.prose blockquote{margin:22px 0;padding:14px 20px;border-inline-start:3px solid #9cb2c7;background:#f5f8fb;color:#455563;font-size:.95em}a{color:#285f89;text-underline-offset:3px}a:focus-visible,.table-scroll:focus-visible{outline:2px solid #3f6589;outline-offset:4px}.metric-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:12px;margin:0 0 24px}.metric-cards>div{min-width:0;padding:14px 16px;border:1px solid #e4e8ed;border-radius:12px;break-inside:avoid}.metric-cards dt{font-size:12px;line-height:1.5;color:#66717b;overflow-wrap:anywhere;margin-bottom:8px}.metric-cards dd{font-size:22px;line-height:1.4;font-weight:500;font-variant-numeric:tabular-nums;margin:0;overflow-wrap:anywhere}.metric-cards small{font-size:12px;font-weight:400;color:#66717b}figure+.prose{margin-top:24px}figure{margin:0;max-width:100%;break-inside:avoid}picture{display:block;max-width:100%}img{display:block;width:100%;height:auto;max-width:100%;border:0}img.fixed{width:auto;margin-inline:auto}.fan-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;margin-top:12px;font-size:12px;line-height:1.6;color:#66717b}.fan-legend span{display:inline-flex;align-items:center;gap:7px}.fan-legend i{display:inline-block;width:22px;height:10px;background:#3965cb}.fan-legend .outer{background:rgba(57,101,203,.12)}.fan-legend .inner{background:rgba(57,101,203,.25)}.fan-legend .median{height:2px}.table-scroll{overflow-x:auto;max-width:100%;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}th,td{padding:11px 12px;border-bottom:1px solid #e4e8eb;text-align:start;white-space:nowrap}th{font-weight:600;background:#f4f6f7}th.numeric,td.numeric{text-align:end}.muted{color:#66717b;font-size:14px}:lang(ko) .prose{word-break:keep-all;overflow-wrap:anywhere}.sources{margin-top:40px;padding-top:8px;border-top:1px solid #e4e8ed;font-size:14px;line-height:1.7}.sources>summary{cursor:pointer;font-weight:600;color:#182e3e;padding:8px 0}.sources section{margin:18px 0 0}.sources h3{font-size:15px;margin:0 0 6px}.sources dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 16px;margin:0}.sources dl>div{display:contents}.sources dt{color:#66717b}.sources dd{margin:0;min-width:0;overflow-wrap:anywhere}.sources dd span{display:block}@media(max-width:600px){.sources dl{grid-template-columns:minmax(0,1fr);gap:0}.sources dt{margin-top:6px}}@media(max-width:600px){body{background:#fff}main{margin:0;padding:28px 22px 40px;border:0;border-radius:0}header{padding:22px 0;margin-bottom:26px}h1{font-size:29px}h2{font-size:19px}.lead .prose>p:first-of-type{font-size:17px}section{margin-bottom:30px}.prose{font-size:15px;line-height:1.9}.prose blockquote{padding:12px 16px}}@media print{body{background:#fff;font-size:11pt}main{max-width:none;margin:0;padding:8mm 4mm;border:0;border-radius:0}header{padding-top:6mm}h1{font-size:27pt}h2,h3{break-after:avoid}p,blockquote{orphans:3;widows:3}figure,tr{break-inside:avoid}a{color:inherit}}</style></head><body><main><header><h1>'+escape(title)+'</h1></header>'+sections+(sourceBlock?sourcesHtml(sourceBlock):'')+'</main></body></html>';
}
