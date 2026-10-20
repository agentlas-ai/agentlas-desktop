import { effectiveFinanceWidget, parseFinanceEvidenceMetric, projectFinanceWidget, type FinanceQuote, type FinanceSource, type FinanceWidget, type FinanceWidgetProjection, type FinanceWorkspace } from '../../shared/finance';

export interface FinanceContextSelection {
 dashboardId?:string|null; selectedWidgetId?:string|null; reportId?:string|null; selectedSectionId?:string|null; selectedSeries?:string;
}
export interface FinanceSelectedSourceContext {
 datasetId:'context-1'; origin:'saved_projection'|'workspace_projection'; ownerScope:string|null; revision:number;
 reference:{dashboardId:string|null;widgetId:string|null;reportId:string|null;sectionId:string|null};
 widget:FinanceWidget|null; sourceWidget:FinanceWidget|null; projection:FinanceWidgetProjection; viewRowIndices:number[]; selectedSeries:string|null;
 quoteSnapshots:FinanceQuote[]; quoteCount:number; sources:FinanceSource[];
}
/** Resolve only the host-owned selection. Saved values remain observations, never a new provider response. */
export function financeSelectedSourceContext(workspace:FinanceWorkspace,selection:FinanceContextSelection):FinanceSelectedSourceContext|null {
 let widget:FinanceWidget|null=null,sourceWidget:FinanceWidget|null=null,projection:FinanceWidgetProjection|null=null;
 const reference:FinanceSelectedSourceContext['reference']={dashboardId:null,widgetId:null,reportId:null,sectionId:null};
 if(selection.reportId){
  const report=workspace.reports.find(item=>item.id===selection.reportId);
  if(!report)throw new Error('finance_selection_stale');
  // A report overview is not an implicit selection of its first data section.
  if(!selection.selectedSectionId)return null;
  const section=report.sections.find(item=>item.id===selection.selectedSectionId);
  if(!section)throw new Error('finance_selection_stale');
  reference.reportId=report.id;reference.sectionId=section.id;widget=section.widget;sourceWidget=section.widget;projection=section.projection;
 }else if(selection.selectedWidgetId){
  const dashboard=workspace.dashboards.find(item=>item.id===(selection.dashboardId??workspace.activeDashboardId));
  const selected=dashboard?.widgets.find(item=>item.id===selection.selectedWidgetId);
  if(!dashboard||!selected)throw new Error('finance_selection_stale');
  widget=effectiveFinanceWidget(dashboard,selected);projection=projectFinanceWidget(workspace,widget);
  reference.dashboardId=dashboard.id;reference.widgetId=selected.id;
  const saved=parseFinanceEvidenceMetric(selected.metric);
  if(saved){reference.reportId=saved.reportId;reference.sectionId=saved.sectionId;sourceWidget=workspace.reports.find(item=>item.id===saved.reportId)?.sections.find(item=>item.id===saved.sectionId)?.widget??null;}
  else sourceWidget=widget;
 }
 if(!projection){if(selection.selectedSeries!==undefined)throw new Error('finance_selected_series_invalid');return null;}
 let viewRowIndices=projection.rows.map((_,index)=>index);
 if(selection.selectedSeries!==undefined){
  const columns=['Observation date','Maturity','Par curve yield','Unit'];
  if(new Set(projection.columns).size!==projection.columns.length||!columns.every(column=>projection!.columns.includes(column)))throw new Error('finance_selected_series_invalid');
  const at=projection.columns.indexOf('Maturity');viewRowIndices=viewRowIndices.filter(index=>projection!.rows[index][at]===selection.selectedSeries);
  if(!viewRowIndices.length)throw new Error('finance_selected_series_invalid');
 }
 const assetIds=new Set(widget?.assetIds??[]);
 const quotes=workspace.quotes.filter(quote=>assetIds.has(quote.assetId)).sort((a,b)=>Date.parse(b.asOf)-Date.parse(a.asOf)||a.assetId.localeCompare(b.assetId)||a.sourceId.localeCompare(b.sourceId));
 const sourceIds=new Set([...projection.sourceIds,...quotes.slice(0,100).map(quote=>quote.sourceId)]);
 return structuredClone({datasetId:'context-1',origin:reference.reportId?'saved_projection':'workspace_projection',ownerScope:workspace.ownerScope,revision:workspace.revision,reference,widget,sourceWidget,projection,viewRowIndices,selectedSeries:selection.selectedSeries??null,quoteSnapshots:quotes.slice(0,100),quoteCount:quotes.length,sources:workspace.sources.filter(source=>sourceIds.has(source.id))});
}
/** Rebinding or changing a staged source never silently reuses the old row numbers. Text-only edits may continue. */
export function financeSelectedSourceCurrent(snapshot:FinanceSelectedSourceContext,workspace:FinanceWorkspace,selection:FinanceContextSelection):boolean {
 try{
  const current=financeSelectedSourceContext(workspace,selection);
  const identity=(value:FinanceSelectedSourceContext)=>({ownerScope:value.ownerScope,revision:value.revision,reference:value.reference,projection:value.projection,sourceWidget:value.sourceWidget,quoteSnapshots:value.quoteSnapshots,sources:value.sources,selectedSeries:value.selectedSeries,controls:value.widget?{assetIds:value.widget.assetIds,metric:value.widget.metric,period:value.widget.period,priceBasis:value.widget.priceBasis,cashFlowMethod:value.widget.cashFlowMethod}:null});
  return !!current&&JSON.stringify(identity(snapshot))===JSON.stringify(identity(current));
 }catch{return false;}
}
/** Every preview/page keeps literal source indices and declares text truncation. Column arrays are not silently sliced. */
export function financeContextRows(snapshot:FinanceSelectedSourceContext,request:{offset:number;limit:number;where?:{column:string;contains:string}},previewIndices?:number[]){
 if(!Number.isInteger(request.offset)||request.offset<0||request.offset>10000||!Number.isInteger(request.limit)||request.limit<1||request.limit>60)throw new Error('finance_dataset_page_invalid');
 const {projection}=snapshot,column=request.where?projection.columns.indexOf(request.where.column):-1;
 if(request.where&&column<0)throw new Error('finance_dataset_column_not_found');
 if(request.where&&projection.columns.lastIndexOf(request.where.column)!==column)throw new Error('finance_dataset_column_ambiguous');
 const indices=previewIndices??projection.rows.flatMap((row,index)=>!request.where||String(row[column]??'').toLocaleLowerCase().includes(request.where.contains.toLocaleLowerCase())?[index]:[]);
 const rowIndices=indices.slice(request.offset,request.offset+request.limit),truncatedCells:{rowIndex:number;columnIndex:number;characters:number}[]=[];
 const rows=rowIndices.map(rowIndex=>projection.rows[rowIndex].map((value,columnIndex)=>{
  if(typeof value==='string'&&value.length>2400){truncatedCells.push({rowIndex,columnIndex,characters:value.length});return value.slice(0,2400);}return value;
 }));
 return{datasetId:snapshot.datasetId,origin:snapshot.origin,reference:snapshot.reference,rowScope:previewIndices&&snapshot.selectedSeries?'selected_series':request.where?'filtered_full_projection':'full_projection',columns:projection.columns,rowIndices,rows,matchingRowCount:indices.length,totalRowCount:projection.rows.length,nextOffset:request.offset+request.limit<indices.length?request.offset+request.limit:null,truncatedCells};
}
export function financeSelectedSourcePreview(snapshot:FinanceSelectedSourceContext){
 return{...financeContextRows(snapshot,{offset:0,limit:60},snapshot.viewRowIndices),pagingScope:'full_projection',...(snapshot.selectedSeries?{nextOffset:null,hasMorePreviewRows:snapshot.viewRowIndices.length>60,selectedSeriesPage:{datasetId:snapshot.datasetId,offset:60,limit:60,where:{column:'Maturity',contains:snapshot.selectedSeries}}}:{}),revision:snapshot.revision,selectedSeries:snapshot.selectedSeries,viewRowCount:snapshot.viewRowIndices.length,status:snapshot.projection.status,asOf:snapshot.projection.asOf,warnings:snapshot.projection.warnings,sourceIds:snapshot.projection.sourceIds,sources:snapshot.sources.slice(0,20),sourceCount:snapshot.sources.length,quoteSnapshots:snapshot.quoteSnapshots,quoteCount:snapshot.quoteCount,widget:snapshot.widget,sourceWidget:snapshot.sourceWidget};
}
