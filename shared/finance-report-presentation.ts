import type { FinanceReport, FinanceReportSection } from './finance';
import { COMPOSITION_CALLOUT_GEOMETRY, compositionCalloutLayout } from './finance-composition-callouts';

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
export function selectFinanceReportSections(report:FinanceReport):FinanceReportSection[] {
 const hasComputeMain=report.sections.some(section=>section.kind!=='sources'&&section.presentation!=='supporting'&&/^compute:(allocation:weights|forecast:fan|option:value)$/.test(section.widget?.metric??'')&&financeReportHasChart(section));
 return report.sections.filter(raw=>{const section=raw as PresentedSection;if(section.presentation==='supporting')return false;if(section.presentation==='narrative')return !!section.narrative.trim();if(section.presentation)return ['chart','comparison'].includes(section.presentation)&&(section.kind!=='sources'||section.presentation==='chart'&&financeReportHasChart(section));if(hasComputeMain&&section.kind==='sources')return false;if(section.kind==='sources'&&['계산 입력','원출처와 조회 시각','가정과 방법','Calculation inputs','Source URLs and retrieval time','Assumptions and method'].includes(section.title))return false;if(financeReportHasChart(section)||financeReportComputeMetrics(section).length)return true;if(section.kind==='sources')return false;return !!section.narrative.trim();});}
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
export function financeReportHtml({report,locale,charts={},mobileCharts={},fixedCharts=[]}:{report:FinanceReport;locale?:string;charts?:Record<string,string>;mobileCharts?:Record<string,string>;fixedCharts?:readonly string[]}):string {
 const language=reportLanguage(report,locale),direction=financeReportDirection(report,locale),title=financeReportTitle(report,locale);
 const isChartSection=(section:FinanceReportSection)=>section.presentation==='chart'||!section.presentation&&financeReportHasChart(section);
 const rank=(section:FinanceReportSection)=>isChartSection(section)?1:section.kind==='summary'?0:2;
 const sections=selectFinanceReportSections(report).sort((a,b)=>rank(a)-rank(b)).map(raw=>{const section=raw as PresentedSection,chart=financeReportChartImage(Object.prototype.hasOwnProperty.call(charts,section.id)?charts[section.id]:undefined),mobileChart=financeReportChartImage(Object.prototype.hasOwnProperty.call(mobileCharts,section.id)?mobileCharts[section.id]:undefined),isChart=isChartSection(section);
  const caption=section.widget?.metric==='compute:forecast:fan'&&financeReportHasChart(section)?'<figcaption class="fan-legend"><span><i class="band outer" aria-hidden="true"></i>5–95%</span><span><i class="band inner" aria-hidden="true"></i>25–75%</span><span><i class="median" aria-hidden="true"></i>'+escape(copy('median',language))+'</span></figcaption>':'';
  const metrics=section.presentation==='comparison'?[]:financeReportComputeMetrics(section,language),cards=metrics.length?'<dl class="metric-cards">'+metrics.map(metric=>'<div><dt>'+escape(metric.label)+'</dt><dd>'+escape(metric.display)+(metric.unit?' <small>'+escape(metric.unit)+'</small>':'')+'</dd></div>').join('')+'</dl>':'';
  const visual=cards|| (section.presentation==='comparison'?comparison(section,language):isChart?(chart?'<figure>'+(mobileChart&&!fixedCharts.includes(section.id)?'<picture><source media="(max-width:600px)" srcset="'+escape(mobileChart)+'"/>':'')+'<img'+(fixedCharts.includes(section.id)?' class="fixed"':'')+' src="'+escape(chart)+'" alt="'+escape(financeReportSectionTitle(section,language))+'"/>'+(mobileChart&&!fixedCharts.includes(section.id)?'</picture>':'')+caption+'</figure>':section.narrative.trim()?'':'<p class="muted">'+escape(copy('unavailable',language))+'</p>'):'');
  const prose=financeReportProseHtml(section.narrative);if(!prose&&!visual)return '';const heading=financeReportSectionHeading(section,report,language);return '<section class="report-section'+(!isChart&&section.presentation!=='comparison'&&section.kind==='summary'?' lead':'')+'">'+(heading?'<h2>'+escape(heading)+'</h2>':'')+(isChart||cards?visual+'<div class="prose">'+prose+'</div>':'<div class="prose">'+prose+'</div>'+visual)+'</section>';
 }).join('');
 return '<!doctype html><html lang="'+escape(language)+'" dir="'+direction+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>'+escape(title)+'</title><style>html{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#28343e;font:16px/1.85 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}main{max-width:960px;margin:32px auto;padding:56px 56px 64px;background:#fff;border:1px solid #e4e8ed;border-radius:12px}header{border-top:3px solid #3f6589;border-bottom:1px solid #e4e8ed;padding:28px 0;margin-bottom:32px}h1,h2,h3{color:#182e3e;line-height:1.35;font-weight:600;overflow-wrap:break-word;text-wrap:balance}h1{font-size:clamp(28px,3.5vw,40px);letter-spacing:-.035em;margin:0;max-width:100%;word-break:auto-phrase}h2{font-size:20px;letter-spacing:-.015em;margin:0 0 18px}h3{font-size:17px;margin:26px 0 12px}section{margin:0 0 36px;min-width:0}section:last-child{margin-bottom:0}.prose{max-width:72ch;overflow-wrap:anywhere;word-break:normal;text-wrap:pretty}.prose p{margin:0 0 18px}.prose p:last-child{margin-bottom:0}.lead .prose>p:first-of-type{font-size:19px;line-height:1.85;color:#253c4c}.prose strong{font-weight:600;color:#182e3e}.prose blockquote{margin:22px 0;padding:14px 20px;border-inline-start:3px solid #9cb2c7;background:#f5f8fb;color:#455563;font-size:.95em}a{color:#285f89;text-underline-offset:3px}a:focus-visible,.table-scroll:focus-visible{outline:2px solid #3f6589;outline-offset:4px}.metric-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:12px;margin:0 0 24px}.metric-cards>div{min-width:0;padding:14px 16px;border:1px solid #e4e8ed;border-radius:12px;break-inside:avoid}.metric-cards dt{font-size:12px;line-height:1.5;color:#66717b;overflow-wrap:anywhere;margin-bottom:8px}.metric-cards dd{font-size:22px;line-height:1.4;font-weight:500;font-variant-numeric:tabular-nums;margin:0;overflow-wrap:anywhere}.metric-cards small{font-size:12px;font-weight:400;color:#66717b}figure+.prose{margin-top:24px}figure{margin:0;max-width:100%;break-inside:avoid}picture{display:block;max-width:100%}img{display:block;width:100%;height:auto;max-width:100%;border:0}img.fixed{width:auto;margin-inline:auto}.fan-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;margin-top:12px;font-size:12px;line-height:1.6;color:#66717b}.fan-legend span{display:inline-flex;align-items:center;gap:7px}.fan-legend i{display:inline-block;width:22px;height:10px;background:#3965cb}.fan-legend .outer{background:rgba(57,101,203,.12)}.fan-legend .inner{background:rgba(57,101,203,.25)}.fan-legend .median{height:2px}.table-scroll{overflow-x:auto;max-width:100%;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}th,td{padding:11px 12px;border-bottom:1px solid #e4e8eb;text-align:start;white-space:nowrap}th{font-weight:600;background:#f4f6f7}th.numeric,td.numeric{text-align:end}.muted{color:#66717b;font-size:14px}:lang(ko) .prose{word-break:keep-all;overflow-wrap:anywhere}@media(max-width:600px){body{background:#fff}main{margin:0;padding:28px 22px 40px;border:0;border-radius:0}header{padding:22px 0;margin-bottom:26px}h1{font-size:29px}h2{font-size:19px}.lead .prose>p:first-of-type{font-size:17px}section{margin-bottom:30px}.prose{font-size:15px;line-height:1.9}.prose blockquote{padding:12px 16px}}@media print{body{background:#fff;font-size:11pt}main{max-width:none;margin:0;padding:8mm 4mm;border:0;border-radius:0}header{padding-top:6mm}h1{font-size:27pt}h2,h3{break-after:avoid}p,blockquote{orphans:3;widows:3}figure,tr{break-inside:avoid}a{color:inherit}}</style></head><body><main><header><h1>'+escape(title)+'</h1></header>'+sections+'</main></body></html>';
}
