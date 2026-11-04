/** Paired owner Finance access. Reuses the host service; never emulates renderer IPC or runs a second model loop. */
import { MobileBridgeRefusal, type MobileBridgeSpecificRefusalCode } from '../../shared/mobile-bridge-refusal';
import { createMobileAccountAdmission } from './mobile-account-admission';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FinanceCompanyFactsOptionsSchema, FinanceDataSaveRequestSchema, effectiveFinanceWidget, parseFinanceEvidenceMetric, projectFinanceWidget, type FinanceWorkspace } from '../../shared/finance';
import { financeMobileDashboardChart } from '../../shared/finance-dashboard-presentation';
import { FinanceAnalystRefSchema } from '../../shared/finance-analysts';
import { FinancePortfolioRequestSchema } from '../../shared/finance-portfolio';
import { FINANCE_NOTICE_VERSION, type FinanceExperienceRequest } from '../../shared/finance-experience';
import { FINANCE_DATA_CATEGORIES } from '../../shared/finance-data-routing';
import { financeNativeTranscriptContents } from '../../shared/finance-native-transcript';
import { MOBILE_FINANCE_CAPABILITY, validateMobileFinanceParams } from '../../shared/mobile-bridge';
import type { FinanceService } from './service';
import type { FinanceScope } from './store';
import type { Chat } from '../../shared/types';

type Method = 'finance.read' | 'finance.command';
const id = z.string().trim().min(1).max(200), revision = z.number().int().nonnegative();
const empty = z.object({}).strict();
const query = z.object({query:z.string().max(2000),assetIds:z.array(id).max(10),metrics:z.array(z.string().min(1).max(80)).min(1).max(10),period:z.string().min(1).max(80),facts:FinanceCompanyFactsOptionsSchema.optional()}).strict()
  .refine(input=>input.facts===undefined||input.metrics.length===1&&input.metrics[0]==='company_facts');
const schemas = {
  'dashboard.widget.read':z.object({dashboardId:z.string().min(1).max(200),widgetId:z.string().min(1).max(200),expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),rowOffset:z.number().int().min(0).max(20000).optional(),rowLimit:z.number().int().min(1).max(100).optional(),locale:z.enum(['ko','en']).optional(),series:z.string().min(1).max(200).optional()}).strict(),
  workspace:z.object({offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(200).optional(),widgetOffset:z.number().int().nonnegative().optional()}).strict(),analysts:empty,'analyst.read':FinanceAnalystRefSchema,'report.read':z.object({reportId:id,sectionOffset:z.number().int().nonnegative().optional(),sectionLimit:z.number().int().min(1).max(10).optional()}).strict(),
  search:z.object({query:z.string().trim().min(1).max(200)}).strict(),query,worldMarkets:empty,dashboardFeeds:empty,'workProject.chats':z.object({offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(20).optional()}).strict(),status:empty,workProject:empty,
  'asset.add':z.union([
    z.object({query:z.string().trim().min(1).max(200),assetId:id,symbol:z.string().trim().min(1).max(80),exchange:z.string().max(80),currency:z.string().regex(/^[A-Z]{3}$/)}).strict(),
    z.object({mode:z.literal('manual'),symbol:z.string().trim().toUpperCase().regex(/^[A-Z0-9.^=_-]{1,80}$/),name:z.string().trim().max(300).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),exchange:z.string().trim().toUpperCase().regex(/^[A-Z0-9 ._-]{0,80}$/),currency:z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),expectedRevision:revision.max(Number.MAX_SAFE_INTEGER)}).strict(),
  ]),
  'asset.remove':z.object({assetId:id,expectedRevision:revision}).strict(),
  'portfolio.save':FinancePortfolioRequestSchema.options[1].omit({action:true}).extend({reviewed:z.literal(true)}).strict(),
  'query.save':FinanceDataSaveRequestSchema,'quotes.refresh':empty,
};
/** No accepting a caller URL, executable, account id, credential, raw workspace or arbitrary operation list. */
const experience = z.discriminatedUnion('action',[
  z.object({action:z.literal('read'),includeUnconfirmedReview:z.literal(true).optional()}).strict(),z.object({action:z.literal('plugins.prepare')}).strict(),
  z.object({action:z.literal('accept'),version:z.literal(FINANCE_NOTICE_VERSION),dataNotice:z.literal(true),aiNotice:z.literal(true)}).strict(),
  z.object({action:z.literal('source'),sourceId:id}).strict(),
  z.object({action:z.literal('source.binding'),category:z.enum(FINANCE_DATA_CATEGORIES),sourceId:id.nullable()}).strict(),
  z.object({action:z.literal('feed'),feedId:z.enum(['finance-news','finance-sec','finance-economy','finance-earnings']),enabled:z.boolean()}).strict(),
  z.object({action:z.literal('monitoring'),enabled:z.boolean(),localTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()}).strict(),
]);
export interface MobileFinancePorts {
  captureScope():Promise<FinanceScope>;
  service:Pick<FinanceService,'load'|'analysts'|'readAnalyst'|'readReport'|'reportSources'|'search'|'query'|'addAsset'|'apply'|'queryAndSave'|'refreshQuotes'|'dashboardFeeds'>;
  experience(scope:FinanceScope,request:FinanceExperienceRequest):Promise<unknown>;
  consent(scope:FinanceScope):Promise<import('../../shared/finance-data-routing').FinanceDataSelection>;
  manualWatchlistAllowed?(scope:FinanceScope):boolean;
  workProject(scope:FinanceScope):{ownerScope:string;projectId:string};
  chats(projectId:string):Chat[];
  savePortfolio(scope:FinanceScope,input:unknown):Promise<unknown>;
  worldMarkets(scope:FinanceScope,selection:import('../../shared/finance-data-routing').FinanceDataSelection):Promise<unknown>;
}
async function defaultPorts():Promise<MobileFinancePorts>{
  const [service,preferences,projects,chats,portfolio,markets,routing,managed]=await Promise.all([
    import('./service'),import('./experience'),import('./work-project'),import('../store/chats'),
    import('./portfolio'),import('./world-markets'),import('../../shared/finance-data-routing'),import('../managed-one/auth'),
  ]);
  const finance=service.getFinanceService();
  return {captureScope:service.captureFinanceScope,service:finance,experience:preferences.financeExperience,consent:preferences.requireFinanceConsent,
    manualWatchlistAllowed:scope=>{scope.assertCurrent();const actor=managed.managedOneAuthentication();return managed.wasManagedOneConfigured()&&!!actor&&actor.userId===scope.userId&&actor.workspaceId===scope.workspaceId;},
    workProject:projects.financeWorkProject,chats:chats.listChatsByProject,
    savePortfolio:(scope,input)=>portfolio.saveFinancePortfolio(finance.store,scope,input as import('../../shared/finance-portfolio').FinancePortfolioRequest),
    worldMarkets:(scope,selection)=>markets.getFinanceWorldMarkets({scope,sourceId:routing.resolveFinanceDataSource(selection,'market')}),
  };
}
/** Landing payloads contain report headers; focused report reads carry the shared presentation. Never silently drop an array. */
export function projectMobileFinanceWorkspace(workspace:FinanceWorkspace,page:{offset?:number;limit?:number;widgetOffset?:number}={}){
  const offset=page.offset??0,limit=page.limit??200,widgetOffset=page.widgetOffset??0;
  const limits={watchlist:limit,holdings:limit,quotes:limit,sources:limit,monitors:limit,dashboardWidgets:20};
  const holdings=workspace.holdings.slice(offset,offset+limit),quotes=workspace.quotes.slice(offset,offset+limit);
  const selected=workspace.watchlist.slice(offset,offset+limit),assets=new Set([...selected.map(asset=>asset.id),...holdings.map(holding=>holding.assetId),...quotes.map(quote=>quote.assetId)]);
  const watchlist=workspace.watchlist.filter(asset=>assets.has(asset.id));
  const requiredSources=new Set([...holdings.map(holding=>holding.sourceId),...quotes.map(quote=>quote.sourceId),...workspace.sources.slice(offset,offset+limit).map(source=>source.id)]);
  const reports=workspace.reports.slice(offset,offset+limit).map(({sections,dashboardSnapshot,...report})=>({...report,sections:[],dashboardSnapshot:null}));
  const sources=workspace.sources.filter(source=>requiredSources.has(source.id)).map(source=>({...source,note:'',url:null}));
  const dashboards=workspace.dashboards.map(dashboard=>({...dashboard,widgets:dashboard.widgets.slice(widgetOffset,widgetOffset+20).map(widget=>({...widget,notes:widget.notes.slice(0,512),assetIds:widget.assetIds.slice(0,20)}))}));
  const monitors=workspace.monitors.slice(offset,offset+limits.monitors).map(monitor=>({...monitor,query:monitor.query.slice(0,512),note:monitor.note.slice(0,512),assetIds:monitor.assetIds.slice(0,20)}));
  const counts={watchlist:workspace.watchlist.length,holdings:workspace.holdings.length,quotes:workspace.quotes.length,reports:workspace.reports.length,sources:workspace.sources.length,monitors:workspace.monitors.length,dashboardWidgets:workspace.dashboards.reduce((count,dashboard)=>count+dashboard.widgets.length,0)};
  const maxTotal=Math.max(counts.watchlist,counts.holdings,counts.quotes,counts.sources,counts.monitors,counts.reports);
  const nextOffset=offset+limit<maxTotal?offset+limit:null;
  const maxWidgets=Math.max(0,...workspace.dashboards.map(dashboard=>dashboard.widgets.length));
  const nextWidgetOffset=widgetOffset+20<maxWidgets?widgetOffset+20:null;
  const truncated=offset>0||watchlist.length<counts.watchlist||holdings.length<counts.holdings||quotes.length<counts.quotes||sources.length<counts.sources||monitors.length<counts.monitors||reports.length<counts.reports;
  return {...workspace,watchlist,holdings,quotes,reports,sources,dashboards,monitors,mobileProjection:{reportBodiesOmitted:true,sourceDetailsOmitted:true,dashboardDetailsOmitted:true,truncated,counts,limits,page:{offset,limit,nextOffset,widgetOffset,nextWidgetOffset}}};
}
function projectResult(result:unknown,page?:{offset?:number;limit?:number;widgetOffset?:number}):unknown{
  if(!result||typeof result!=='object'||Array.isArray(result))return result;
  const value=result as Record<string,unknown>;
  if(value.schemaVersion===1&&Array.isArray(value.watchlist)&&Array.isArray(value.reports))return projectMobileFinanceWorkspace(value as unknown as FinanceWorkspace,page);
  if(value.workspace&&typeof value.workspace==='object'){const workspace=projectMobileFinanceWorkspace(value.workspace as FinanceWorkspace,page);return {...value,workspace,...('truncated' in value?{truncated:workspace.mobileProjection.truncated}:{})};}
  return result;
}
export interface MobileFinanceContext {
  /** Must fail closed on absent, unknown, revoked or different paired-account ownership. */
  assertAccount():void;
  admitAccount():Promise<{assertCurrent():void}>;
  projectChat(chat:Chat):unknown;
  projectProject?(projectId:string):Promise<unknown>;
}
export async function requestMobileFinance(method:Method,params:Record<string,unknown>,context:MobileFinanceContext,injected?:MobileFinancePorts):Promise<unknown>{
  const error=validateMobileFinanceParams(method,params);if(error)throw new Error(error);
  const operation=params.operation as string;
  const raw=params.args??{};
  // Parse before importing host code: malformed caller input cannot activate plugins or query a provider.
  const args=operation==='experience'?experience.parse(raw):schemas[operation as keyof typeof schemas].parse(raw);
  context.assertAccount();
  const admission=await context.admitAccount();context.assertAccount();admission.assertCurrent();
  const ports=injected??await defaultPorts();context.assertAccount();admission.assertCurrent();
  const captured=await ports.captureScope();context.assertAccount();admission.assertCurrent();captured.assertCurrent();
  if(!captured.workspaceId||!captured.userId)throw new Error('finance_sign_in_required');
  const scope:FinanceScope={...captured,readOnly:method==='finance.read',assertCurrent(){context.assertAccount();admission.assertCurrent();captured.assertCurrent();}};
  const finish=(result:unknown,page?:{offset?:number;limit?:number;widgetOffset?:number})=>{
    scope.assertCurrent();
    let projected=projectResult(result,page??(method==='finance.command'?{limit:10}:undefined)) as Record<string,unknown>;
    if(method==='finance.command'){
      const state=projected?.experience as Record<string,unknown>|undefined;
      const boundedState=(value:Record<string,unknown>)=>({...value,...(Array.isArray(value.sources)?{sources:value.sources.slice(0,20),sourcesTruncated:value.sources.length>20,totalSources:value.sources.length}:{})});
      if(state)projected={...projected,experience:boundedState(state)};
      if(Array.isArray(projected.sources)&&'consent' in projected)projected=boundedState(projected);
      // The replay ledger stores at most 256 KiB including its envelope. Never turn a completed save into an uncertain result.
      // Coverage is a small additive result field. Do not compact a response
      // that fit the legacy threshold solely because that field was added.
      const {quoteCoverage: _coverage, ...legacyProjection}=projected;
      const sizeProjection=operation==='quotes.refresh'?legacyProjection:projected;
      if(Buffer.byteLength(JSON.stringify(sizeProjection),'utf8')>128*1024){
        const original=(projected.workspace??(Array.isArray(projected.watchlist)?projected:undefined)) as Record<string,unknown>|undefined;
        const compact=original?{...original,watchlist:[],holdings:[],quotes:[],reports:[],sources:[],monitors:[],dashboards:[],mobileProjection:{...(original.mobileProjection as object),truncated:true,refreshRequired:true,page:{offset:0,limit:200,nextOffset:0,widgetOffset:0,nextWidgetOffset:0}}}:undefined;
        const known=['schemaVersion','noticeVersion','ownerScope','projectId','reportId','status','manualWatchlistV1'] as const;
        const ack:Record<string,unknown>={refreshRequired:true};for(const key of known)if(key in projected)ack[key]=projected[key];
        if(compact){if(Array.isArray(projected.watchlist))return {...compact,refreshRequired:true};ack.workspace=compact;}
        if(state)ack.experience=boundedState({...state,sources:[]});
        if(operation==='experience')return boundedState({...projected,sources:[]});
        if(operation==='workProject'){ack.chats=[];ack.chatsTruncated=true;ack.nextOffset=0;ack.chatCount=projected.chatCount;}
        if(operation==='asset.add'){ack.asset=projected.asset;ack.warnings=[];}
        if(typeof projected.message==='string')ack.message=projected.message.slice(0,4000);
        if(operation==='quotes.refresh'&&projected.quoteCoverage!==undefined)ack.quoteCoverage=projected.quoteCoverage;
        return ack;
      }
      return projected;
    }
    const wireBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');
    if(wireBytes(projected)>4*1024*1024){
      // A page that does not fit is made smaller until it does; the page block names where the next one starts. Only one row that alone exceeds the budget is refused.
      for(let limit=Math.floor((page?.limit??200)/2);limit>=1;limit=Math.floor(limit/2)){
        const smaller=projectResult(result,{...page,limit}) as Record<string,unknown>;
        if(wireBytes(smaller)<=4*1024*1024)return smaller;
        if(limit===1)break;
      }
      throw new Error('finance_mobile_payload_too_large');
    }
    return projected;
  };
  // Reconciliation can update monitoring settings. It is intentionally a replay-protected command, never finance.read.
  if(operation==='status'){
    const state=await ports.experience(scope,{action:'read'});scope.assertCurrent();
    const workspace=await ports.service.load(scope);scope.assertCurrent();return finish({schemaVersion:1,noticeVersion:FINANCE_NOTICE_VERSION,workspace,experience:state,truncated:false,...(ports.manualWatchlistAllowed?.(scope)?{manualWatchlistV1:true}:{})});
  }
  if(operation==='experience')return finish(await ports.experience(scope,args as FinanceExperienceRequest));
  const selection=await ports.consent(scope);scope.assertCurrent();
  if(operation==='workspace')return finish(await ports.service.load(scope),args as {offset?:number;limit?:number;widgetOffset?:number});
  switch(operation){
    case 'workProject':
    case 'workProject.chats':{
      const project=ports.workProject(scope);scope.assertCurrent();
      const rows=ports.chats(project.projectId).filter(chat=>chat.projectId===project.projectId&&chat.kind==='user'&&!chat.archivedAt)
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      const input=args as {offset?:number;limit?:number},offset=operation==='workProject'?0:input.offset??0,limit=operation==='workProject'?5:input.limit??20;
      const projected=operation==='workProject'&&context.projectProject?await context.projectProject(project.projectId):undefined;scope.assertCurrent();
      const page=rows.slice(offset,offset+limit),nextOffset=offset+page.length<rows.length?offset+page.length:null;
      return finish({...project,...(projected?{project:projected}:{}),chats:page.map(chat=>context.projectChat(chat)),chatsTruncated:offset>0||nextOffset!==null,chatCount:rows.length,nextOffset});
    }
    case 'dashboard.widget.read':{
      const input=args as z.infer<typeof schemas['dashboard.widget.read']>;
      const workspace=await ports.service.load(scope);scope.assertCurrent();
      const ownerScope=createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId])).digest('hex');
      if(workspace.ownerScope!==ownerScope)throw new Error('finance_owner_scope_mismatch');
      if(workspace.revision!==input.expectedRevision)throw new Error('finance_revision_conflict');
      const dashboard=workspace.dashboards.find(value=>value.id===input.dashboardId);
      const widget=dashboard?.widgets.find(value=>value.id===input.widgetId);
      if(!dashboard||!widget)throw new Error('finance_arguments_invalid');
      const effective=effectiveFinanceWidget(dashboard,widget),projection=projectFinanceWidget(workspace,effective);
      const ref=parseFinanceEvidenceMetric(widget.metric);
      const section=ref?workspace.reports.find(report=>report.id===ref.reportId)?.sections.find(item=>item.id===ref.sectionId):undefined;
      const chart=financeMobileDashboardChart(effective,projection,input.locale??'en',section,input.series);
      const rowOffset=input.rowOffset??0,rowLimit=input.rowLimit??50,totalRows=projection.rows.length;
      if(rowOffset>totalRows)throw new Error('finance_arguments_invalid');
      const rows:typeof projection.rows=[];
      const response={ownerScope,workspaceRevision:workspace.revision,dashboardId:dashboard.id,widgetId:widget.id,
        projection:{status:projection.status,columns:projection.columns,rows,warnings:projection.warnings,asOf:projection.asOf},
        page:{rowOffset,rowLimit,totalRows,nextRowOffset:totalRows as number|null},chart};
      // Keep each complete row intact and bound the serialized UTF-8 reply well below the global 4 MiB read cap.
      // A giant row or warnings cannot be clipped without changing the evidence; fail explicitly instead.
      const budget=3*1024*1024;
      let bytes=Buffer.byteLength(JSON.stringify(response),'utf8')+128;
      if(bytes>budget)throw new Error('finance_mobile_payload_too_large');
      for(const row of projection.rows.slice(rowOffset,rowOffset+rowLimit)){
        const size=Buffer.byteLength(JSON.stringify(row),'utf8')+1;
        if(bytes+size>budget){if(!rows.length)throw new Error('finance_mobile_payload_too_large');break;}
        rows.push(row);bytes+=size;
      }
      const next=rowOffset+rows.length;response.page.nextRowOffset=next<totalRows?next:null;
      return finish(response);
    }
    case 'analysts':return finish(await ports.service.analysts(scope,{action:'list'}));
    case 'analyst.read':return finish(await ports.service.readAnalyst(scope,args as z.infer<typeof FinanceAnalystRefSchema>));
    case 'report.read':{
      const input=args as {reportId:string;sectionOffset?:number;sectionLimit?:number};
      const result=await ports.service.readReport(scope,{reportId:input.reportId});scope.assertCurrent();
      const offset=input.sectionOffset??0,totalSections=result.report.sections.length;
      if(offset>totalSections)throw new Error('finance_report_page_invalid');
      const report={...result.report,sections:result.report.sections.slice(offset,offset+Math.min(input.sectionLimit??5,5)),dashboardSnapshot:null};
      const sources=await ports.service.reportSources(scope,result.report,result.archiveId);scope.assertCurrent();
      const ownerScope=createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId])).digest('hex');
      const presentation=financeNativeTranscriptContents({schemaVersion:'finance.native-result.v1',ownerScope,operationId:'finance.report.read',
        view:{kind:'report',report,workspaceRevision:result.workspaceRevision,sources:sources.slice(0,50)},operationResult:null});
      const next=offset+report.sections.length;
      const header={...report,sections:report.sections.map(({chart,...section})=>({...section,projection:null,widget:null}))};
      return finish({report:header,workspaceRevision:result.workspaceRevision,...(result.archiveId?{archiveId:result.archiveId}:{}),presentation,reportProjection:{sectionOffset:offset,totalSections,nextSectionOffset:next<totalSections?next:null,rawDataOmitted:true}});
    }
    case 'search':return finish(await ports.service.search(scope,args as {query:string}));
    case 'query':return finish(await ports.service.query(scope,args as z.infer<typeof query>));
    case 'worldMarkets':return finish(await ports.worldMarkets(scope,selection));
    case 'dashboardFeeds':{
      const result=await ports.service.dashboardFeeds(scope);scope.assertCurrent();
      return finish({...result,sections:result.sections.slice(0,4).map(section=>({...section,items:section.items.slice(0,100),sourceUrls:section.sourceUrls.slice(0,100),warnings:section.warnings.slice(0,100).map(warning=>warning.slice(0,500)),mobileProjection:{totalItems:section.items.length,truncated:section.items.length>100,totalSourceUrls:section.sourceUrls.length,totalWarnings:section.warnings.length}})),mobileProjection:{totalSections:result.sections.length,truncated:result.sections.length>4}});
    }
    case 'asset.add':{
      const input=args as z.infer<typeof schemas['asset.add']>;
      if('mode' in input){
        if(!ports.manualWatchlistAllowed?.(scope))throw new Error('finance_operation_invalid');
        const current=await ports.service.load(scope);scope.assertCurrent();
        if(current.revision!==input.expectedRevision)throw new Error('finance_revision_conflict');
        const asset={id:'manual:v1:'+createHash('sha256').update(JSON.stringify([input.symbol,input.exchange,input.currency])).digest('hex'),symbol:input.symbol,name:input.name||input.symbol,exchange:input.exchange,currency:input.currency,kind:'other' as const};
        const existing=current.watchlist.find(item=>item.id===asset.id);
        if(existing&&JSON.stringify(existing)!==JSON.stringify(asset))throw new Error('finance_revision_conflict');
        const workspace=existing?current:await ports.service.apply(scope,{expectedRevision:input.expectedRevision,operations:[{type:'watchlist.add',asset}]});
        scope.assertCurrent();return finish({workspace,asset,warnings:[]});
      }
      const found=await ports.service.search(scope,{query:input.query});scope.assertCurrent();
      const matches=found.assets.filter(asset=>asset.id===input.assetId&&asset.symbol===input.symbol&&asset.exchange===input.exchange&&asset.currency===input.currency);
      if(matches.length!==1)throw new Error('finance_asset_selection_required');
      const asset=matches[0],current=await ports.service.load(scope);scope.assertCurrent();
      const workspace=current.watchlist.some(item=>item.id===asset.id)?current:await ports.service.apply(scope,{expectedRevision:current.revision,operations:[{type:'watchlist.add',asset}]});
      return finish({workspace,asset,warnings:found.warnings});
    }
    case 'asset.remove':{
      const input=args as {assetId:string;expectedRevision:number};
      return finish(await ports.service.apply(scope,{expectedRevision:input.expectedRevision,operations:[{type:'watchlist.remove',assetId:input.assetId}]}));
    }
    case 'portfolio.save':{const {reviewed,...input}=args as z.infer<typeof schemas['portfolio.save']>;const result=await ports.savePortfolio(scope,{...input,action:'save'}) as {workspace?:FinanceWorkspace;message:string;warnings?:string[]};return finish({workspace:result.workspace,message:result.message,warnings:result.warnings});}
    case 'query.save':{const result=await ports.service.queryAndSave(scope,args as z.infer<typeof FinanceDataSaveRequestSchema>);return finish({workspace:result.workspace,reportId:result.reportId,sourceIds:result.sourceIds,message:result.message});}
    case 'quotes.refresh':{
      const result=await ports.service.refreshQuotes(scope);scope.assertCurrent();
      const hasOperations=!!result.operations?.length;
      // Quotes are added, not edited: if a save landed while they loaded (a scheduled briefing), they are added on top of it instead of failing the refresh.
      const addQuotes=async():Promise<FinanceWorkspace>=>{
        try{return await ports.service.apply(scope,{expectedRevision:result.baseRevision,operations:result.operations!});}
        catch(error){
          if(!(error instanceof Error)||error.message!=='finance_revision_conflict')throw error;
          const latest=await ports.service.load(scope);scope.assertCurrent();
          return ports.service.apply(scope,{expectedRevision:latest.revision,operations:result.operations!});
        }
      };
      const workspace=hasOperations?await addQuotes():await ports.service.load(scope);
      const expectedRevision=result.baseRevision+(hasOperations?1:0);
      const boundCoverage=result.quoteCoverage?{quoteCoverage:Number.isSafeInteger(expectedRevision)&&workspace.revision===expectedRevision?result.quoteCoverage:null}:{};
      return finish({workspace,status:result.status??'ok',message:result.message,...boundCoverage});
    }
  }
  throw new Error('finance_operation_invalid');
}

// The existing mobile domain projection entry point exports this catalog; common bridge code knows only the generic contract.
export { FINANCE_NATIVE_VIEW, FinanceNativeResultSchema } from '../../shared/finance-native-ui';
export { financeNativeTranscriptContents };
const EXPECTED_REFUSALS:Partial<Record<MobileBridgeSpecificRefusalCode,string>> = {
  "finance_consent_required": "Review the Finance notices before continuing.",
  "finance_plugin_activation_required": "Prepare the Finance tools before continuing.",
  "finance_revision_conflict": "Finance changed on Desktop. Refresh before saving again.",
  "finance_asset_has_holdings": "This asset has saved holdings and cannot be removed.",
  "finance_asset_is_referenced": "This asset is used by a dashboard or monitor and cannot be removed.",
  "finance_work_project_not_prepared": "Prepare the Finance conversation project before reading its conversations.",
  "finance_account_unproven": "The paired Finance owner could not be verified. Keep the pairing and retry when the account service is reachable.",
  "finance_account_changed": "The signed-in Desktop account changed. Reload Finance.",
  "finance_pairing_changed": "This phone pairing changed. Reconnect before accessing Finance.",
  "finance_mobile_payload_too_large": "This Finance page is too large. Request a smaller page.",
  "finance_report_not_found": "This Finance report is no longer available.",
  "finance_asset_selection_required": "Select one exact provider asset before adding it.",
  "finance_portfolio_review_required": "Review every required holding value before saving.",
  "finance_portfolio_identity_ambiguous": "The selected holding matches more than one saved asset. Review it on Desktop.",
  "finance_portfolio_position_ambiguous": "The selected holding matches more than one saved position. Review it on Desktop.",
  "finance_report_page_invalid": "This report page is no longer available. Reopen the report.",
  "finance_analyst_not_found": "This Analyst is no longer available. Refresh the Analyst list.",
  "finance_analyst_revision_conflict": "This Analyst changed. Refresh the Analyst list before selecting it.",
  "finance_arguments_invalid": "The Finance request was invalid. Refresh the screen and review the values.",
  "account_mismatch": "Desktop is signed in to a different owner than this phone was paired with.",
  "sign_in_required": "Sign in to Agentlas on the paired Desktop before continuing.",
  "finance_sign_in_required": "Sign in to Agentlas on the paired Desktop before continuing."
};
export const mobileDomainPorts = {
  createAccountAdmission:createMobileAccountAdmission,
  methods: ['finance.read','finance.command'] as readonly string[],
  handles(method:string):method is Method {return method==='finance.read'||method==='finance.command';},
  capabilities: { financeV1: { ...MOBILE_FINANCE_CAPABILITY, read:[...MOBILE_FINANCE_CAPABILITY.read], command:[...MOBILE_FINANCE_CAPABILITY.command] } },
  async request(method:string,params:Record<string,unknown>,context:MobileFinanceContext,injected?:MobileFinancePorts){
    try{
      if(method!=='finance.read'&&method!=='finance.command')throw new Error('finance_method_invalid');
      return await requestMobileFinance(method,params,context,injected);
    }catch(error){
      const code=error instanceof z.ZodError?'finance_arguments_invalid':error instanceof Error?error.message:'';
      const message=EXPECTED_REFUSALS[code as MobileBridgeSpecificRefusalCode];
      if(message)throw new MobileBridgeRefusal(code as MobileBridgeSpecificRefusalCode,message);
      throw error;
    }
  },
};
