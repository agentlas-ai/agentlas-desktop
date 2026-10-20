import { FinanceReportLanguageSchema, financeId, validateFinanceOperation, type FinanceReport, type FinanceReportSection, type FinanceWorkspace } from '../../shared/finance';
import { financeReportCompositionTitle, financeReportHasChart } from '../../shared/finance-report-presentation';
import type { FinanceArtifactDraft } from './artifacts';
import { financeSelectedSourceCurrent, type FinanceSelectedSourceContext } from './conversation-context';

/** Compile a host-selected snapshot without inventing a provider response or replacing its source. */
export function financeSelectedSourceArtifact(snapshot:FinanceSelectedSourceContext,workspace:FinanceWorkspace,rowIndices:number[],title?:string,narrative='',language?:string):FinanceArtifactDraft {
 const selection={...(snapshot.reference.widgetId?{dashboardId:snapshot.reference.dashboardId,selectedWidgetId:snapshot.reference.widgetId}:{reportId:snapshot.reference.reportId,selectedSectionId:snapshot.reference.sectionId}),...(snapshot.selectedSeries!==null?{selectedSeries:snapshot.selectedSeries}:{})};
 if(!financeSelectedSourceCurrent(snapshot,workspace,selection))throw new Error('finance_selected_source_stale');
 const parent=snapshot.reference.reportId?workspace.reports.find(report=>report.id===snapshot.reference.reportId):null;
 const original=parent?.sections.find(section=>section.id===snapshot.reference.sectionId);
 if(snapshot.reference.reportId&&(!parent||!original))throw new Error('finance_selected_source_stale');
 if(!Array.isArray(rowIndices)||rowIndices.length>10000||new Set(rowIndices).size!==rowIndices.length||rowIndices.some(index=>!Number.isInteger(index)||index<0||index>=snapshot.projection.rows.length))throw new Error('finance_dataset_row_not_found');
 const sourceWidget=snapshot.sourceWidget??snapshot.widget;
 const sourceTitle=sourceWidget?.title??original?.title;
 const reportTitle=title??sourceTitle;
 if(typeof reportTitle!=='string'||!reportTitle.trim()||reportTitle.length>300||typeof narrative!=='string'||narrative.length>20000)throw new Error('finance_artifact_presentation_invalid');
 const projection=structuredClone(snapshot.projection);
 if(projection.rows.some(row=>row.length!==projection.columns.length))throw new Error('finance_projection_shape');
 const widget=sourceWidget?{...structuredClone(sourceWidget),id:financeId('widget')}:null;
 const primary:FinanceReportSection={id:financeId('section'),title:reportTitle,kind:'widget',narrative:'',widget,projection:{...projection,rows:rowIndices.map(index=>[...projection.rows[index]])}};
 // A subset of an allocation must not be normalized into a purported full-portfolio composition.
 const partialComposition=!!financeReportCompositionTitle(primary)&&rowIndices.length!==projection.rows.length;
 // The portable yield chart chooses one series; retain multiple tenors as evidence instead.
 const maturity=projection.columns.indexOf('Maturity');
 const multipleTenors=projection.columns.includes('Par curve yield')&&maturity>=0&&new Set(primary.projection!.rows.map(row=>row[maturity])).size>1;
 const chart=!!widget&&widget.chartType!=='table'&&!partialComposition&&!multipleTenors&&financeReportHasChart(primary);
 if(!chart&&!narrative.trim())throw new Error('finance_artifact_visual_or_narrative_required');
 const sections:FinanceReportSection[]=[];
 if(narrative.trim())sections.push({id:financeId('section'),title:reportTitle,kind:'summary',presentation:'narrative',narrative,widget:null,projection:null});
 sections.push({...primary,kind:chart?'widget':'sources',presentation:chart?'chart':'supporting'});
 sections.push({id:financeId('section'),title:sourceTitle??reportTitle,kind:'sources',presentation:'supporting',narrative:'',widget:null,projection:structuredClone(snapshot.projection)});
 const report:FinanceReport={id:financeId('report'),...(language!==undefined?{language:FinanceReportLanguageSchema.parse(language)}:{}),title:reportTitle,createdAt:new Date().toISOString(),sourceRevision:workspace.revision,reviewPending:true,sections,dashboardSnapshot:null,parentReportId:parent?.id??null};
 const operation=validateFinanceOperation({type:'report.add',report});
 return{operations:[operation],reportId:report.id,title:report.title,kind:chart?'chart':'report'};
}
