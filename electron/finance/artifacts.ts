import { FinanceReportLanguageSchema, createFinanceWidget, financeId, type FinanceOperation, type FinanceReport, type FinanceReportSection, type FinanceDataResult, type FinanceWorkspace } from '../../shared/finance';
import type { FinanceComputeArtifact } from '../../shared/finance-compute';
import type { FinanceComputeRequest } from '../../shared/finance-compute';

export interface FinanceArtifactPresentation { language?:string; narrative?:string; chartTitle?:string; metricsTitle?:string; metricLabels?:Record<string,string>; highlightMetricIds?:string[]; comparisonIndexes?:number[] }
export interface FinanceArtifactDraft {operations:FinanceOperation[];reportId:string;title:string;kind:'chart'|'report'|'newsletter'}
/** Compile host-computed numbers into the existing portable report/table contract. */
export function financeCalculationArtifact(artifact:FinanceComputeArtifact & {inputEvidence?:FinanceDataResult[];requestSnapshot?:FinanceComputeRequest},workspace:FinanceWorkspace,title=artifact.title,presentation:FinanceArtifactPresentation={}):FinanceArtifactDraft{
 const language=presentation.language?FinanceReportLanguageSchema.parse(presentation.language):undefined;
 if([...title].length>80)title=`${artifact.input.symbols.slice(0,3).join(' · ')} · ${artifact.title}`;
 const now=new Date().toISOString(),sourceId=financeId('source'),sourceUrls=artifact.provenance.kind==='observed'?artifact.provenance.sourceUrls:artifact.citations.map(c=>c.url);
 const operations:FinanceOperation[]=[{type:'source.upsert',source:{id:sourceId,name:artifact.provenance.kind==='observed'?'계산에 사용한 가격':'가정 시나리오',kind:artifact.provenance.kind==='observed'?'provider':'manual',status:artifact.provenance.kind==='observed'?'connected':'imported',asOf:artifact.input.endDate,retrievedAt:artifact.provenance.kind==='observed'?artifact.provenance.retrievedAt:now,url:sourceUrls[0]??null,note:JSON.stringify({method:artifact.method,parameters:artifact.requestSnapshot,input:artifact.input,provenance:artifact.provenance,diagnostics:artifact.diagnostics,citations:artifact.citations}).slice(0,20000)}}];
 const sections:FinanceReportSection[]=artifact.tables.map(table=>{
  const main=artifact.kind==='allocation'?table.id==='allocation':artifact.kind==='forecast'?table.id==='fan':table.id==='payoff';
  const widget=createFinanceWidget('chart',table.title);widget.chartType=main?(artifact.kind==='allocation'?'bar':'line'):'table';widget.width='full';widget.notes=artifact.input.currency;widget.metric=`compute:${artifact.kind}:${main?(artifact.kind==='allocation'?'weights':artifact.kind==='forecast'?'fan':'value'):table.id}`;
  return{id:financeId('section'),title:main?(presentation.chartTitle??table.title):table.title,kind:main?'widget':'sources',presentation:main?'chart':'supporting',narrative:'',widget:main?widget:null,projection:{columns:table.columns,rows:table.rows,status:'ready',warnings:artifact.warnings,asOf:artifact.input.endDate,sourceIds:[sourceId]}};
 });
 sections.sort((a,b)=>(a.kind==='widget'?0:1)-(b.kind==='widget'?0:1));
 const metricsTitle=presentation.metricsTitle??(language&&!language.startsWith('ko')?'Key figures':'계산 요약');
 const metricsWidget=createFinanceWidget('chart',metricsTitle);metricsWidget.metric=`compute:${artifact.kind}:metrics`;
 const selectedMetrics=presentation.highlightMetricIds?.length?artifact.metrics.filter(metric=>presentation.highlightMetricIds!.includes(metric.id)):artifact.metrics.filter(metric=>!["constraint_violation","sample_volatility"].includes(metric.id)).slice(0,4);
 sections.splice(1,0,{id:financeId('section'),title:metricsTitle,kind:'widget',narrative:'',widget:metricsWidget,projection:{columns:['metric','value','unit'],rows:selectedMetrics.map(metric=>[presentation.metricLabels?.[metric.id]??metric.label,metric.value,metric.unit]),status:'ready',warnings:[],asOf:artifact.input.endDate,sourceIds:[sourceId]}});
 sections.push({id:financeId('section'),title:'가정과 방법',kind:'sources',narrative:[artifact.method,...artifact.assumptions,...artifact.warnings,...artifact.citations.map(c=>`${c.title}\n${c.url}`),`input sha256: ${artifact.input.inputSha256}`].join('\n\n').slice(0,20000),widget:null,projection:null});
 for(const input of artifact.inputEvidence??[])sections.push({id:financeId('section'),title:'계산 입력',kind:'sources',narrative:input.sourceUrls.join('\n'),widget:null,projection:{columns:input.columns,rows:input.rows,status:input.status==='ok'?'ready':'partial',warnings:input.warnings,asOf:input.asOf,sourceIds:[sourceId]}});
 if(presentation.highlightMetricIds?.some(id=>!artifact.metrics.some(metric=>metric.id===id)))throw new Error('finance_artifact_metric_not_found');
 if(presentation.narrative?.trim())sections.unshift({id:financeId('section'),title:title.slice(0,300),kind:'summary',presentation:'narrative',narrative:presentation.narrative.slice(0,20000),widget:null,projection:null});
 const report:FinanceReport={id:financeId('report'),...(language?{language}:{}),title:title.slice(0,300),createdAt:now,sourceRevision:workspace.revision,reviewPending:true,sections,dashboardSnapshot:null,parentReportId:null};
 operations.push({type:'report.add',report});return{operations,reportId:report.id,title:report.title,kind:'chart'};
}
export function financeConversationArtifact(results:FinanceDataResult[],workspace:FinanceWorkspace,title:string,kind:'chart'|'report'|'newsletter',narrative:string,presentation:FinanceArtifactPresentation={}):FinanceArtifactDraft{
 const language=presentation.language?FinanceReportLanguageSchema.parse(presentation.language):undefined;
 const narrativeOnly=results.length===0&&kind==='report'&&!!narrative.trim();
 const now=new Date().toISOString(),operations:FinanceOperation[]=[],sections:FinanceReportSection[]=[];
 if(narrative.trim())sections.push({id:financeId('section'),title:title.slice(0,300),kind:'summary',presentation:'narrative',narrative:narrative.slice(0,20000),widget:null,projection:null});
 for(const [resultIndex,result] of results.entries()){
  if(!['ok','partial'].includes(result.status)||!result.rows.length)continue;
  const url=result.sourceUrls.find(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}});if(!url)throw new Error('finance_artifact_source_required');
  const sourceId=financeId('source');operations.push({type:'source.upsert',source:{id:sourceId,name:new URL(url).hostname,kind:'provider',status:'connected',asOf:result.asOf,retrievedAt:result.retrievedAt,url,note:[...result.sourceUrls,...result.warnings].join('\n').slice(0,20000)}});
  const widget=createFinanceWidget('chart',title);widget.width='full';widget.chartType=result.columns.includes('Close (raw)')||result.columns.includes('Par curve yield')?'line':'table';
  const chart=widget.chartType!=='table',comparison=presentation.comparisonIndexes?.includes(resultIndex)??false;
  sections.push({id:financeId('section'),title,kind:chart||comparison?'widget':'sources',presentation:chart?'chart':comparison?'comparison':'supporting',narrative:'',widget,projection:{columns:result.columns,rows:result.rows,status:result.status==='ok'?'ready':'partial',warnings:result.warnings,asOf:result.asOf,sourceIds:[sourceId]}});
 }
 if(!narrativeOnly&&!sections.some(section=>section.projection?.rows.length))throw new Error('finance_artifact_evidence_required');
 if(!sections.some(section=>section.presentation!=='supporting'))throw new Error('finance_artifact_visual_or_narrative_required');
 const report:FinanceReport={id:financeId('report'),...(language?{language}:{}),title:title.slice(0,300),createdAt:now,sourceRevision:workspace.revision,reviewPending:true,sections,dashboardSnapshot:null,parentReportId:null};
 operations.push({type:'report.add',report});return{operations,reportId:report.id,title:report.title,kind};
}
