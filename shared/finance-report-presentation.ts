import type { FinanceReport, FinanceReportSection } from './finance';

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
const LEGACY_TITLES:Record<string,string>={'요약':'summary','Summary':'summary','계산 요약':'calculation','Calculation summary':'calculation','계산 결과':'results','Calculation results':'results','자산배분':'allocation','자산배분 결과':'allocation','Asset allocation':'allocation','가격 시나리오':'forecast','Price scenarios':'forecast','옵션 만기 손익':'option','Option expiry payoff':'option','미국 국채 관측 데스크':'treasury','미국 국채 관측 데스크 · 자료 검토':'treasury','Work에서 저장한 미국 국채 관측 데스크':'treasury','Work에서 저장한 미국 국채 관측 데스크 · 자료 검토':'treasury'};
/** Only known application scaffolding is localized. User-authored prose is never machine-translated here. */
export function financeReportSectionTitle(section:Pick<FinanceReportSection,'title'>,locale:string):string {const key=Object.prototype.hasOwnProperty.call(LEGACY_TITLES,section.title)?LEGACY_TITLES[section.title]:undefined;return key?copy(key,locale):section.title;}
export function financeReportTitle(report:FinanceReport,locale?:string):string {return financeReportSectionTitle(report,reportLanguage(report,locale));}
function matches(section:FinanceReportSection,names:readonly string[]):boolean {const p=section.projection;return !!p&&['ready','partial'].includes(p.status)&&p.rows.length>0&&new Set(p.columns).size===p.columns.length&&names.every(name=>p.columns.includes(name));}
/** Conservative legacy recognition: never infer a chart from arbitrary numeric evidence columns. */
export function financeReportHasChart(section:FinanceReportSection):boolean {
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
 return report.sections.filter(raw=>{const section=raw as PresentedSection;if(section.presentation==='supporting')return false;if(section.presentation==='narrative')return !!section.narrative.trim();if(section.presentation)return section.kind!=='sources'&&['chart','comparison'].includes(section.presentation);if(hasComputeMain&&section.kind==='sources')return false;if(section.kind==='sources'&&['계산 입력','원출처와 조회 시각','가정과 방법','Calculation inputs','Source URLs and retrieval time','Assumptions and method'].includes(section.title))return false;if(financeReportHasChart(section))return true;if(section.kind==='sources')return false;return !!section.narrative.trim();});}
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
export interface FinanceReportProseBlock {kind:'paragraph'|'heading'|'quote';text:string}
/** One reading structure for the native reader and standalone HTML; evidence stays in the saved projection. */
export function financeReportProseBlocks(value:string):FinanceReportProseBlock[] {
 const blocks:FinanceReportProseBlock[]=[];
 let paragraph:string[]=[],kind:'paragraph'|'quote'='paragraph',fenced=false;
 const flush=()=>{if(paragraph.length){blocks.push({kind,text:paragraph.join(' ')});paragraph=[];}};
 for(const line of financeReportReadingProse(value).slice(0,20000).replace(/\r\n?/g,'\n').split('\n')){
  if(/^\s*```/.test(line)){flush();fenced=!fenced;continue;}
  if(fenced)continue;
  if(!line.trim()||/^\s*(?:\[row\s+\d+\]\s*)+$/i.test(line)||/^\s*\|.*\|\s*$/.test(line)||financeReportIsMetadataLine(line)){flush();continue;}
  const heading=/^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
  if(heading){flush();blocks.push({kind:'heading',text:heading[1]});continue;}
  const item=/^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)(.+)$/.exec(line);
  if(item){flush();blocks.push({kind:'paragraph',text:item[1]});continue;}
  const quote=/^\s*>\s?(.*)$/.exec(line),next=quote?'quote':'paragraph';
  if(kind!==next)flush();kind=next;paragraph.push((quote?.[1]??line).trim());
 }
 flush();return blocks;
}
export function financeReportProseHtml(value:string):string {
 return financeReportProseBlocks(value).map(block=>{const tag=block.kind==='heading'?'h3':block.kind==='quote'?'blockquote':'p';return '<'+tag+'>'+inline(block.text)+'</'+tag+'>';}).join('');
}
/** Suppress only the application's generic scaffolding, in both reading surfaces. */
export function financeReportSectionHeading(section:FinanceReportSection,report:FinanceReport,locale:string):string|null {
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
export function financeReportHtml({report,locale,charts={},mobileCharts={}}:{report:FinanceReport;locale?:string;charts?:Record<string,string>;mobileCharts?:Record<string,string>}):string {
 const language=reportLanguage(report,locale),direction=financeReportDirection(report,locale),title=financeReportTitle(report,locale);
 const isChartSection=(section:FinanceReportSection)=>section.presentation==='chart'||!section.presentation&&financeReportHasChart(section);
 const rank=(section:FinanceReportSection)=>isChartSection(section)?1:section.kind==='summary'?0:2;
 const sections=selectFinanceReportSections(report).sort((a,b)=>rank(a)-rank(b)).map(raw=>{const section=raw as PresentedSection,chart=financeReportChartImage(Object.prototype.hasOwnProperty.call(charts,section.id)?charts[section.id]:undefined),mobileChart=financeReportChartImage(Object.prototype.hasOwnProperty.call(mobileCharts,section.id)?mobileCharts[section.id]:undefined),isChart=isChartSection(section);
  const caption=section.widget?.metric==='compute:forecast:fan'&&financeReportHasChart(section)?'<figcaption class="fan-legend"><span><i class="band outer" aria-hidden="true"></i>5–95%</span><span><i class="band inner" aria-hidden="true"></i>25–75%</span><span><i class="median" aria-hidden="true"></i>'+escape(copy('median',language))+'</span></figcaption>':'';
  const visual=section.presentation==='comparison'?comparison(section,language):isChart?(chart?'<figure>'+(mobileChart?'<picture><source media="(max-width:600px)" srcset="'+escape(mobileChart)+'"/>':'')+'<img src="'+escape(chart)+'" alt="'+escape(financeReportSectionTitle(section,language))+'"/>'+(mobileChart?'</picture>':'')+caption+'</figure>':section.narrative.trim()?'':'<p class="muted">'+escape(copy('unavailable',language))+'</p>'):'';
  const prose=financeReportProseHtml(section.narrative);if(!prose&&!visual)return '';const heading=financeReportSectionHeading(section,report,language);return '<section class="report-section'+(!isChart&&section.presentation!=='comparison'&&section.kind==='summary'?' lead':'')+'">'+(heading?'<h2>'+escape(heading)+'</h2>':'')+'<div class="prose">'+prose+'</div>'+visual+'</section>';
 }).join('');
 return '<!doctype html><html lang="'+escape(language)+'" dir="'+direction+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>'+escape(title)+'</title><style>html{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#28343e;font:16px/1.85 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}main{max-width:960px;margin:32px auto;padding:56px 56px 64px;background:#fff;border:1px solid #e4e8ed;border-radius:12px}header{border-top:3px solid #3f6589;border-bottom:1px solid #e4e8ed;padding:28px 0;margin-bottom:32px}h1,h2,h3{color:#182e3e;line-height:1.35;font-weight:600;overflow-wrap:break-word;text-wrap:balance}h1{font-size:clamp(28px,3.5vw,40px);letter-spacing:-.035em;margin:0;max-width:100%}h2{font-size:20px;letter-spacing:-.015em;margin:0 0 18px}h3{font-size:17px;margin:26px 0 12px}section{margin:0 0 36px;min-width:0}section:last-child{margin-bottom:0}.prose{max-width:72ch;overflow-wrap:anywhere;word-break:normal;text-wrap:pretty}.prose p{margin:0 0 18px}.prose p:last-child{margin-bottom:0}.lead .prose>p:first-of-type{font-size:19px;line-height:1.85;color:#253c4c}.prose strong{font-weight:600;color:#182e3e}.prose blockquote{margin:22px 0;padding:14px 20px;border-inline-start:3px solid #9cb2c7;background:#f5f8fb;color:#455563;font-size:.95em}a{color:#285f89;text-underline-offset:3px}a:focus-visible,.table-scroll:focus-visible{outline:2px solid #3f6589;outline-offset:4px}figure{margin:24px 0 0;max-width:100%;break-inside:avoid}picture{display:block;max-width:100%}img{display:block;width:100%;height:auto;max-width:100%;border:0}.fan-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;margin-top:12px;font-size:12px;line-height:1.6;color:#66717b}.fan-legend span{display:inline-flex;align-items:center;gap:7px}.fan-legend i{display:inline-block;width:22px;height:10px;background:#3965cb}.fan-legend .outer{background:rgba(57,101,203,.12)}.fan-legend .inner{background:rgba(57,101,203,.25)}.fan-legend .median{height:2px}.table-scroll{overflow-x:auto;max-width:100%;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}th,td{padding:11px 12px;border-bottom:1px solid #e4e8eb;text-align:start;white-space:nowrap}th{font-weight:600;background:#f4f6f7}td.numeric{text-align:end}.muted{color:#66717b;font-size:14px}:lang(ko) .prose{word-break:keep-all;overflow-wrap:anywhere}@media(max-width:600px){body{background:#fff}main{margin:0;padding:28px 22px 40px;border:0;border-radius:0}header{padding:22px 0;margin-bottom:26px}h1{font-size:29px}h2{font-size:19px}.lead .prose>p:first-of-type{font-size:17px}section{margin-bottom:30px}.prose{font-size:15px;line-height:1.9}.prose blockquote{padding:12px 16px}}@media print{body{background:#fff;font-size:11pt}main{max-width:none;margin:0;padding:8mm 4mm;border:0;border-radius:0}header{padding-top:6mm}h1{font-size:27pt}h2,h3{break-after:avoid}p,blockquote{orphans:3;widows:3}figure,tr{break-inside:avoid}a{color:inherit}}</style></head><body><main><header><h1>'+escape(title)+'</h1></header>'+sections+'</main></body></html>';
}
