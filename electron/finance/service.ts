import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyFinanceOperations, FinanceDataSaveRequestSchema, createFinanceReport, financeId, FINANCE_WORKSPACE_LIMITS, validateFinanceOperation, validateFinanceWorkspace, type FinanceAIResult, type FinanceDataRequest, type FinanceDataResult, type FinanceDataSaveRequest, type FinanceDataSaveResult, type FinanceMonitor, type FinanceMonitorRun, type FinanceOperation, type FinanceReport, type FinanceSource, type FinanceWorkspace, type FinanceArchiveRequest, type FinanceArchiveResult, type FinanceArchiveItem, type FinanceMonitorRunsRequest, type FinanceMonitorRunsResult } from "../../shared/finance";
import { userDataPath } from "../runtime-paths";
import { FinanceStore, type FinanceScope } from "./store";
import { queryFinanceData, refreshFinanceQuotes, searchFinanceAssets } from "./data";
import { FinanceExperience, requireFinanceMonitoringAccess } from './experience';
import type { FinanceDataSelection } from '../../shared/finance-data-routing';
import { findIsharesFund } from "./providers/ishares-catalog";
import { FINANCE_MONITOR_RUN_TIMEOUT_MS } from "../../shared/finance";
import { financeReportSourceRecords, type FinanceReportSourceRecord } from "../../shared/finance-report-presentation";
import { FinanceArchives, FinanceArchiveRequestSchema, financeArchivePlan } from './archive';
import { FinanceRunHistory } from './run-history';
import { financeReportDashboardActions } from './evidence-actions';
import { FinanceSearchCatalog, financeSearchResult, financeSearchRouteKey } from './search-catalog';
import { financeBuiltinPlugin } from './builtin-plugin';
import { FINANCE_NOTICE_VERSION } from '../../shared/finance-experience';
import type { FinancePortfolioValuation, FinancePortfolioValuationPresentation } from './portfolio-valuation';
import type { FinanceAsset } from '../../shared/finance';
import type { FinanceAnalystRequest, FinanceAnalystRef } from '../../shared/finance-analysts';
import { FinanceAnalystLibrary } from './analysts';
import { calculateFromFinanceSources } from './calculation-service';
import type { FinanceArtifactPresentation } from './artifacts';
import { writeFinanceBriefing } from "./briefing";
import { pauseFinanceMonitor, readFinanceMonitor, rollbackFinanceMonitor, scheduleFinanceMonitor } from "./monitor";
/** The most positions one valuation prices: a reviewed holdings draft carries up to 100, and a currency group is valued only when every position in it is priced. */
const PORTFOLIO_REFRESH_LIMIT = 100;

const lockfile = require("proper-lockfile") as { lock(target: string, options: unknown): Promise<() => Promise<void>> };
const MONITOR_LOCK_OPTIONS = { realpath: false, stale: 240000, retries: 0 };
/** Scheduler receipts can advance during a run; only research identity participates in this guard. */
function monitorDefinition(monitor: FinanceMonitor, workspace: FinanceWorkspace): string {
  const selected = monitor.assetIds.length ? monitor.assetIds : workspace.watchlist.slice(0, 3).map(asset => asset.id);
  return JSON.stringify({ name: monitor.name, query: monitor.query, assetIds: monitor.assetIds,
    assets: selected.map(id => workspace.watchlist.find(asset => asset.id === id) ?? null) });
}
function assertWorkspaceCapacity(workspace:FinanceWorkspace,operations:FinanceOperation[]):void {
  const reports=new Map(workspace.reports.map(report=>[report.id,report]));
  const sources=new Set(workspace.sources.map(source=>source.id));let refreshed=0;
  for(const raw of operations){const op=validateFinanceOperation(raw);
    if(op.type==="report.add")reports.set(op.report.id,op.report);
    else if(op.type==="report.remove")reports.delete(op.reportId);
    else if(op.type==="report.refresh"&&reports.get(op.reportId)?.dashboardSnapshot)refreshed++;
    else if(op.type==="source.upsert")sources.add(op.source.id);
    else if(op.type==="holdings.import")op.sources?.forEach(source=>sources.add(source.id));
  }
  if(reports.size+refreshed>FINANCE_WORKSPACE_LIMITS.reports||sources.size>FINANCE_WORKSPACE_LIMITS.sources)throw new Error("finance_workspace_capacity_reached");
}
export interface FinanceAccountBinding { workspaceId: string; userId: string; sessionId: string; expiresAt: number | null }
/** Captured in the host capability, never accepted from a model or renderer argument. */
export async function captureFinanceScope(expected?: FinanceAccountBinding | null): Promise<FinanceScope> {
  const auth = await import("../auth");
  const captured = auth.getAuthenticatedSessionBinding();
  if (!captured || expected === null) throw new Error("finance_sign_in_required");
  const same = (binding: FinanceAccountBinding | null) => binding && binding.sessionId === captured.sessionId && binding.workspaceId === captured.workspaceId && binding.userId === captured.userId;
  if (expected && !same(expected)) throw new Error("finance_account_changed");
  return { workspaceId: captured.workspaceId, userId: captured.userId, assertCurrent() { if (!same(auth.getAuthenticatedSessionBinding())) throw new Error("finance_account_changed"); } };
}
function partition(scope: FinanceScope): string { return createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.userId])).digest("hex"); }
function dataOperations(result: FinanceDataResult, workspace: FinanceWorkspace, title: string, report: boolean): { operations: FinanceOperation[]; sourceIds: string[]; reportId?: string } {
  if (!["ok", "partial"].includes(result.status) || !result.rows.length) throw new Error("finance_data_not_available");
  const now = new Date().toISOString();
  const urls = [...new Set(result.sourceUrls)].slice(0, 100);
  if (!urls.length) throw new Error("finance_data_source_required");
  for (const url of urls) {
    const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("finance_source_url_invalid");
  }
  // One immutable dataset receipt, with every original URL retained in the frozen report below.
  const sources: FinanceSource[] = [{ id: financeId("source"), name: result.providers?.map(provider=>provider.label).join(" / ").slice(0,300)||new URL(urls[0]).hostname,
    kind:"provider",status:"connected",asOf:result.asOf,retrievedAt:result.retrievedAt,url:urls[0],
    note:[...result.warnings,...(result.providers??[]).map(provider=>`${provider.label}: ${provider.coverage}; ${provider.rights}`),...urls].join("\n").slice(0,20000) }];
  const sourceIds = sources.map(source => source.id);
  const operations: FinanceOperation[] = sources.map(source => ({ type: "source.upsert", source }));
  let reportId: string | undefined;
  if (report) {
    reportId = financeId("report");
    const value: FinanceReport = { id: reportId, title: title.slice(0,300), createdAt: now, sourceRevision: workspace.revision, reviewPending: true, dashboardSnapshot: null, parentReportId: null,
      sections: [{ id: financeId("section"), title: "조회 자료", kind: "sources", narrative: "조회 시점의 고정 자료입니다. 출처의 보도·게시·거래 기준과 커버리지 한계를 확인하세요.", widget: null,
        projection: { columns: result.columns, rows: result.rows, status: result.status === "ok" ? "ready" : "partial", warnings: result.warnings, asOf: result.asOf, sourceIds } },
        {id:financeId("section"),title:"원출처와 조회 시각",kind:"sources",narrative:sources[0].note,widget:null,
          projection:{columns:["url","retrievedAt"],rows:urls.map(url=>[url,result.retrievedAt]),status:"ready",warnings:[],asOf:result.asOf,sourceIds}}] };
    operations.push({ type: "report.add", report: value });
  }
  return { operations, sourceIds, reportId };
}
export class FinanceService {
  readonly store: FinanceStore;
  private readonly experience:FinanceExperience;
  private readonly archiveStore:FinanceArchives;
  private readonly histories=new Map<string,FinanceRunHistory>();
  private readonly searchCatalog=new FinanceSearchCatalog();
  private readonly analystLibrary: FinanceAnalystLibrary;
  constructor(private readonly root: string) { this.experience=new FinanceExperience(path.join(root,"experience"));this.store = new FinanceStore(path.join(root,"workspaces"));this.archiveStore=new FinanceArchives(path.join(root,"archives"));this.analystLibrary=new FinanceAnalystLibrary(path.join(root,"analysts")); }
  async analysts(scope:FinanceScope,request:FinanceAnalystRequest) {
    return this.analystLibrary.handle(scope,request);
  }
  async readAnalyst(scope:FinanceScope,ref:FinanceAnalystRef) {
    const [analyst]=await this.analystLibrary.resolve(scope,[ref]);scope.assertCurrent();return analyst;
  }
  async archives(scope:FinanceScope,raw:FinanceArchiveRequest):Promise<FinanceArchiveResult>{
    const input=FinanceArchiveRequestSchema.parse(raw);
    if(input.action==='list')return {action:'list',...await this.archiveStore.list(scope,input)};
    if(input.action==='read')return {action:'read',...await this.archiveStore.read(scope,input)};
    if(input.action==='create'){
      let item:FinanceArchiveItem|undefined,reclaimed={reports:0,sources:0};
      const workspace=await this.store.transaction(scope,input.expectedRevision,async current=>{
        const plan=financeArchivePlan(current,input.reportIds);reclaimed=plan.reclaimed;
        if(!reclaimed.reports&&!reclaimed.sources)throw new Error('finance_archive_nothing_to_reclaim');
        item=await this.archiveStore.create(scope,current,input.reportIds);return plan.workspace;
      });
      if(!item)throw new Error('finance_archive_not_found');
      return {action:'create',archiveId:item.archiveId,sha256:item.sha256,workspace,reclaimed,warnings:reclaimed.sources?[]:['finance_archive_sources_still_referenced']};
    }
    const archived=await this.archiveStore.read(scope,{archiveId:input.archiveId});let restored={reports:0,sources:0};
    const workspace=await this.store.transaction(scope,input.expectedRevision,current=>{
      const selected=input.reportIds??archived.reportIds;
      const remaining=new Set(financeArchivePlan(archived.workspaceSnapshot,archived.reportIds).workspace.sources.map(source=>source.id));
      const additional=input.reportIds===undefined?archived.workspaceSnapshot.sources.filter(source=>!remaining.has(source.id)).map(source=>source.id):[];
      const plan=this.archiveStore.restore(current,archived.workspaceSnapshot,selected,additional);restored=plan.restored;
      if(!restored.reports&&!restored.sources)throw new Error('finance_archive_nothing_to_restore');return plan.workspace;
    });
    return {action:'restore',archiveId:input.archiveId,workspace,restored,warnings:[]};
  }
  async readReport(scope:FinanceScope,input:{reportId:string}):Promise<{dashboardActions?:FinanceDataSaveResult['dashboardActions'];report:FinanceReport;workspaceRevision:number;archiveId?:string}>{
    const workspace=await this.store.load(scope),active=workspace.reports.find(report=>report.id===input.reportId);scope.assertCurrent();
    if(active)return {dashboardActions:financeReportDashboardActions(workspace,active.id),report:active,workspaceRevision:workspace.revision};
    const archived=await this.archiveStore.read(scope,input),report=archived.workspaceSnapshot.reports.find(item=>item.id===input.reportId);
    if(!report)throw new Error('finance_report_not_found');return {report,workspaceRevision:workspace.revision,archiveId:archived.archiveId};
  }
  /** The provider records a report names, from the active workspace or, for a report read from an archive, from that archive's snapshot. Only a result card reads this; the model's result is unchanged. */
  async reportSources(scope:FinanceScope,report:FinanceReport,archiveId?:string):Promise<FinanceReportSourceRecord[]>{
    const sources=archiveId?(await this.archiveStore.read(scope,{archiveId})).workspaceSnapshot.sources:(await this.store.load(scope)).sources;scope.assertCurrent();
    return financeReportSourceRecords(report,sources);
  }
  async load(scope: FinanceScope): Promise<FinanceWorkspace> {
    const workspace = await this.store.load(scope); scope.assertCurrent();
    return { ...workspace, monitors: workspace.monitors.map(monitor => readFinanceMonitor({ scope, monitor })) };
  }
  async save(scope: FinanceScope, input: { workspace: FinanceWorkspace; expectedRevision: number }): Promise<FinanceWorkspace> {
    const proposed = validateFinanceWorkspace(input.workspace), expectedRevision=input.expectedRevision, current = await this.store.load(scope); scope.assertCurrent();
    for (const monitor of proposed.monitors) {
      const previous = current.monitors.find(item => item.id === monitor.id);
      if (previous?.automationId) {
        const live = readFinanceMonitor({ scope, monitor: previous });
        const keys = ["automationId","executionAvailability","scheduleHuman","status","lastCheckedAt","nextCheckAt","note"] as const;
        if (![previous,live].some(snapshot => keys.every(key => JSON.stringify(monitor[key]) === JSON.stringify(snapshot[key])))) throw new Error("finance_monitor_host_owned");
        if (live.status !== "paused" && JSON.stringify(monitor) !== JSON.stringify(previous) && JSON.stringify(monitor) !== JSON.stringify(live)) throw new Error("finance_monitor_pause_before_edit");
        if (live.status === "paused" && monitor.status !== "paused") throw new Error("finance_monitor_host_owned");
      } else if (monitor.automationId || monitor.executionAvailability || monitor.status === "active" || monitor.lastCheckedAt || monitor.nextCheckAt) throw new Error("finance_monitor_host_owned");
    }
    for (const previous of current.monitors) if (previous.automationId && !proposed.monitors.some(item => item.id === previous.id) && readFinanceMonitor({ scope, monitor: previous }).status !== "paused") throw new Error("finance_monitor_pause_before_remove");
    const workspace=await this.store.save(scope,{workspace:proposed,expectedRevision});
    const layoutChanged=(current.dashboards.some(d=>d.widgets.length>0)||workspace.dashboards.some(d=>d.widgets.length>0))&&JSON.stringify(current.dashboards.map(({id,widgets})=>({id,widgets})))!==JSON.stringify(workspace.dashboards.map(({id,widgets})=>({id,widgets})));
    if(layoutChanged){
      try{await this.experience.markDashboardCustomized(scope);}
      catch{scope.assertCurrent();console.warn("finance_dashboard_preference_pending");}
    }
    return workspace;
  }
  async apply(scope: FinanceScope, input: { operations: FinanceOperation[]; expectedRevision: number }): Promise<FinanceWorkspace> {
    const current = await this.store.load(scope); if(current.revision !== input.expectedRevision) throw new Error("finance_revision_conflict");
    assertWorkspaceCapacity(current,input.operations);
    return this.save(scope,{workspace:applyFinanceOperations(current,input.operations),expectedRevision:current.revision});
  }
  async search(scope: FinanceScope,input:{query:string}) {
    const route={...await this.experience.consent(scope),assertCurrent:()=>scope.assertCurrent()};scope.assertCurrent();
    const lease=this.searchCatalog.begin(scope,route),result=financeSearchResult(await searchFinanceAssets(input.query,route));scope.assertCurrent();
    const current=await this.experience.consent(scope);scope.assertCurrent();this.searchCatalog.begin(scope,current);
    if(financeSearchRouteKey(current)!==lease.route)throw new Error('finance_search_selection_stale');
    this.searchCatalog.register(scope,lease,result);return result;
  }
  /** Saved assets and this owner's live search results (host memory, 15 minutes): looking an asset up never has to save it. */
  private queryAssets(scope:FinanceScope,route:FinanceDataSelection,watchlist:FinanceAsset[],ids:readonly string[]):FinanceAsset[]{
    return [...watchlist,...this.searchCatalog.liveAssets(scope,this.searchCatalog.begin(scope,route),ids,watchlist)];
  }
  async query(scope: FinanceScope,input:FinanceDataRequest) { const workspace=await this.store.load(scope);const route={...await this.experience.consent(scope),assertCurrent:()=>scope.assertCurrent()};scope.assertCurrent();const result=await queryFinanceData(input,this.queryAssets(scope,route,workspace.watchlist,input.assetIds),route);scope.assertCurrent();return result; }
  async queryAndSave(scope:FinanceScope,input:FinanceDataSaveRequest,signal?:AbortSignal):Promise<FinanceDataSaveResult> {
    const parsed=FinanceDataSaveRequestSchema.safeParse(input);if(!parsed.success)throw new Error("finance_arguments_invalid");input=parsed.data;
    const savingScope:FinanceScope={...scope,assertCurrent(){scope.assertCurrent();if(signal?.aborted)throw new Error("finance_query_cancelled");}};
    savingScope.assertCurrent();const before=await this.store.load(savingScope);savingScope.assertCurrent();
    if(input.expectedRevision!==undefined&&before.revision!==input.expectedRevision)throw new Error("finance_revision_conflict");
    const target=input.reportId===undefined?undefined:before.reports.find(report=>report.id===input.reportId);
    if(input.reportId!==undefined&&!target)throw new Error("finance_report_not_found");
    const route={...await this.experience.consent(savingScope),signal,assertCurrent:()=>savingScope.assertCurrent()};savingScope.assertCurrent();
    const request:FinanceDataRequest={query:input.query,assetIds:input.assetIds,metrics:input.metrics,period:input.period,...(input.facts?{facts:input.facts}:{})};
    const result=await queryFinanceData(request,this.queryAssets(savingScope,route,before.watchlist,request.assetIds),route);savingScope.assertCurrent();
    const batch=dataOperations(result,before,target?.title||input.title||input.query||"Finance 자료",input.mode==="report");
    if(target){
      const observed=batch.operations.find(operation=>operation.type==="report.add");if(observed?.type!=="report.add")throw new Error("finance_data_not_available");
      const sections=structuredClone(observed.report.sections).map(section=>({...section,presentation:"supporting" as const}));
      const operations=batch.operations.filter(operation=>operation.type!=="report.add");
      const workspace=await this.store.transaction(savingScope,before.revision,current=>{
        savingScope.assertCurrent();const report=current.reports.find(item=>item.id===target.id);if(!report)throw new Error("finance_report_not_found");
        assertWorkspaceCapacity(current,operations);
        const next=applyFinanceOperations(current,operations),updated=next.reports.find(item=>item.id===target.id)!;
        updated.sections.push(...sections);updated.reviewPending=true;
        return validateFinanceWorkspace(next);
      });
      // The evidence is committed; a subsequent abort must not invite a duplicate append.
      scope.assertCurrent();return {dashboardActions:financeReportDashboardActions(workspace,target.id),workspace,sourceIds:batch.sourceIds,reportId:target.id,message:`조회 자료와 출처를 기존 보고서의 판본 ${workspace.revision}에 추가했습니다. 본문은 유지되며 새 근거 검토가 필요합니다.`};
    }
    if(batch.reportId){const added=batch.operations.find(operation=>operation.type==="report.add");if(added?.type==="report.add")added.report.sections.unshift({id:financeId("section"),title:added.report.title,kind:"summary",presentation:"narrative",narrative:"",widget:null,projection:null});}
    const workspace=await this.apply(savingScope,{operations:batch.operations,expectedRevision:before.revision});
    scope.assertCurrent();
    return {...(batch.reportId?{dashboardActions:financeReportDashboardActions(workspace,batch.reportId)}:{}),workspace,sourceIds:batch.sourceIds,...(batch.reportId?{reportId:batch.reportId}:{}),message:batch.reportId?`조회 자료와 출처를 판본 ${workspace.revision}의 보고서 초안에 저장했습니다. 요약은 아직 작성되지 않았습니다.`:`조회 자료와 출처를 판본 ${workspace.revision}에 저장했습니다.`};
  }
  async addAsset(scope:FinanceScope,input:{query:string;symbol?:string}) {
    const found=await this.search(scope,input);const matches=found.assets.filter(asset=>!input.symbol||asset.symbol.toLowerCase()===input.symbol.toLowerCase());
    if(matches.length!==1)throw new Error("finance_asset_selection_required");
    const current=await this.store.load(scope);const asset=matches[0];
    if(current.watchlist.some(item=>item.id===asset.id))return {workspace:current,asset,warnings:found.warnings};
    return {workspace:await this.apply(scope,{operations:[{type:"watchlist.add",asset}],expectedRevision:current.revision}),asset,warnings:found.warnings};
  }
  async createReport(scope:FinanceScope,input:{dashboardId?:string;title?:string;language?:string}) {
    const workspace=await this.store.load(scope);const dashboard=workspace.dashboards.find(item=>item.id===(input.dashboardId??workspace.activeDashboardId));
    if(!dashboard)throw new Error("finance_dashboard_not_found");
    const report=createFinanceReport(workspace,dashboard,input.title||dashboard.name);
    if(input.language!==undefined)report.language=input.language;
    return {workspace:await this.apply(scope,{operations:[{type:"report.add",report}],expectedRevision:workspace.revision}),reportId:report.id};
  }
  async calculate(scope:FinanceScope,input:{request:import('../../shared/finance-compute').FinanceComputeRequest;period?:string;title?:string} & FinanceArtifactPresentation,signal:AbortSignal=AbortSignal.timeout(180000)){
    const route={...await this.experience.consent(scope),signal,assertCurrent:()=>scope.assertCurrent()};scope.assertCurrent();
    const before=await this.store.load(scope);scope.assertCurrent();
    const period=input.period??'1Y';if(!['1M','3M','1Y','5Y','all'].includes(period))throw new Error('finance_compute_period_invalid');
    const plugin=await financeBuiltinPlugin().runtime(scope,FINANCE_NOTICE_VERSION);scope.assertCurrent();
    const artifact=await calculateFromFinanceSources(input.request,before.watchlist,asset=>queryFinanceData({query:asset.symbol,assetIds:[asset.id],metrics:['price_history'],period},before.watchlist,route),signal,(request,input)=>plugin.callPureTool('compute',{request,input}) as import('../../shared/finance-compute').FinanceComputeArtifact);scope.assertCurrent();signal.throwIfAborted();
    const draft=plugin.callPureTool('compute.artifact',{result:artifact,workspace:before,title:input.title,presentation:Object.fromEntries(Object.entries(input).filter(([key])=>!['request','period','title'].includes(key)))}) as import('./artifacts').FinanceArtifactDraft;
    const workspace=await this.apply({...scope,assertCurrent(){scope.assertCurrent();signal.throwIfAborted();}},{operations:draft.operations,expectedRevision:before.revision});
    return {workspace,reportId:draft.reportId,artifact};
  }
  private async observedPortfolio(scope:FinanceScope,workspace:FinanceWorkspace,route:FinanceDataSelection & {signal?:AbortSignal;assertCurrent:()=>void},signal:AbortSignal,value:(payload:{workspace:FinanceWorkspace;refreshResult:FinanceAIResult})=>FinancePortfolioValuation):Promise<FinancePortfolioValuation>{
    scope.assertCurrent();signal.throwIfAborted();
    const owned=new Set(workspace.holdings.map(holding=>holding.assetId));
    // A currency group is valued only when every position in it is priced, so a valuation reads every held asset (a dashboard refresh keeps its five).
    const refreshed=await refreshFinanceQuotes({...workspace,watchlist:workspace.watchlist.filter(asset=>owned.has(asset.id))},route,{limit:PORTFOLIO_REFRESH_LIMIT});
    scope.assertCurrent();signal.throwIfAborted();return value({workspace,refreshResult:refreshed});
  }
  /** Refresh observed holding prices once, then freeze only complete positive currency groups with CAS. */
  async valuePortfolio(scope:FinanceScope,input:FinancePortfolioValuationPresentation & {expectedRevision?:number},signal:AbortSignal=AbortSignal.timeout(180000)){
    const guarded:FinanceScope={...scope,assertCurrent(){scope.assertCurrent();signal.throwIfAborted();}};
    guarded.assertCurrent();const before=await this.store.load(guarded);guarded.assertCurrent();
    if(input.expectedRevision!==undefined&&input.expectedRevision!==before.revision)throw new Error('finance_revision_conflict');
    const route={...await this.experience.consent(guarded),signal,assertCurrent:()=>guarded.assertCurrent()};guarded.assertCurrent();
    const plugin=await financeBuiltinPlugin().runtime(guarded,FINANCE_NOTICE_VERSION);guarded.assertCurrent();
    const computed=await this.observedPortfolio(guarded,before,route,signal,payload=>plugin.callPureTool('valuation',payload) as FinancePortfolioValuation);
    if(!computed.groups.some(group=>group.complete&&group.totalValue!==null&&group.totalValue>0))return {computed,workspace:before};
    const {expectedRevision:_,...presentation}=input;
    const draft=plugin.callPureTool('portfolio.artifact',{result:computed,workspace:before,presentation}) as import('./artifacts').FinanceArtifactDraft;
    guarded.assertCurrent();const workspace=await this.apply(guarded,{operations:draft.operations,expectedRevision:before.revision});guarded.assertCurrent();
    return {computed,workspace,reportId:draft.reportId};
  }
  /** Check holdings the assistant read for the owner's review against the saved portfolio. Reads only; the owner's Save is the single write. */
  async proposePortfolio(scope:FinanceScope,input:unknown):Promise<import('./portfolio-proposal').FinancePortfolioProposal>{
    const workspace=await this.store.load(scope);scope.assertCurrent();
    const {financePortfolioProposal}=await import('./portfolio-proposal');
    const proposal=financePortfolioProposal(workspace,input);scope.assertCurrent();return proposal;
  }
  async dashboardFeeds(scope:FinanceScope,signal?:AbortSignal):Promise<import('../../shared/finance-feeds').FinanceDashboardFeedsResult>{
    const selection=await this.experience.consent(scope);scope.assertCurrent();
    return this.feedsForSelection(scope,selection,signal);
  }
  private async feedsForSelection(scope:FinanceScope,selection:FinanceDataSelection,signal?:AbortSignal):Promise<import('../../shared/finance-feeds').FinanceDashboardFeedsResult>{
    const workspace=await this.store.load(scope);scope.assertCurrent();
    const {getFinanceDashboardFeeds}=await import('./dashboard-feeds');
    return getFinanceDashboardFeeds({scope,watchlist:workspace.watchlist,...selection,signal});
  }
  async refreshQuotes(scope:FinanceScope) {const workspace=await this.store.load(scope);const route={...await this.experience.consent(scope),assertCurrent:()=>scope.assertCurrent()};scope.assertCurrent();const result=await refreshFinanceQuotes(workspace,route);scope.assertCurrent();return result;}
  /** Definition edits share the execution lease; history and scheduler metadata are never model patches. */
  async updateMonitor(scope:FinanceScope,input:{monitorId:string;expectedRevision:number;patch:{name?:string;query?:string;assetIds?:string[]}},signal?:AbortSignal):Promise<FinanceWorkspace> {
    const invalid=()=>{throw new Error("finance_arguments_invalid");};
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["monitorId","expectedRevision","patch"].includes(key)))invalid();
    if(typeof input.monitorId!=="string"||!input.monitorId.trim()||input.monitorId.length>200||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)invalid();
    let patch=input.patch;
    if(!patch||typeof patch!=="object"||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!["name","query","assetIds"].includes(key)))invalid();
    for(const key of ["name","query"] as const)if(key in patch&&(typeof patch[key]!=="string"||!patch[key]!.trim()||patch[key]!.length>(key==="name"?300:2000)))invalid();
    if("assetIds" in patch&&(!Array.isArray(patch.assetIds)||!patch.assetIds.length||patch.assetIds.length>10||patch.assetIds.some(id=>typeof id!=="string"||!id.trim()||id.length>200)||new Set(patch.assetIds).size!==patch.assetIds.length))invalid();
    patch={...patch,...(patch.assetIds?{assetIds:[...patch.assetIds]}:{})};input={...input,patch};
    const savingScope:FinanceScope={...scope,assertCurrent(){scope.assertCurrent();if(signal?.aborted)throw new Error("finance_monitor_cancelled");}};
    savingScope.assertCurrent();const before=await this.store.load(savingScope);savingScope.assertCurrent();
    if(before.revision!==input.expectedRevision)throw new Error("finance_revision_conflict");
    if(!before.monitors.some(monitor=>monitor.id===input.monitorId))throw new Error("finance_monitor_not_found");
    let release:()=>Promise<void>;
    try{release=await lockfile.lock(this.runDirectory(savingScope,input.monitorId),MONITOR_LOCK_OPTIONS);}
    catch(error){savingScope.assertCurrent();if((error as NodeJS.ErrnoException).code==="ELOCKED")throw new Error("finance_monitor_running");throw error;}
    try{
      savingScope.assertCurrent();
      const workspace=await this.store.transaction(savingScope,input.expectedRevision,current=>{
        savingScope.assertCurrent();const previous=current.monitors.find(monitor=>monitor.id===input.monitorId);if(!previous)throw new Error("finance_monitor_not_found");
        if(previous.status==="active"||(previous.automationId&&readFinanceMonitor({scope:savingScope,monitor:previous}).status!=="paused"))throw new Error("finance_monitor_pause_before_edit");
        const assetIds=patch.assetIds??previous.assetIds;
        const selected=assetIds.length?assetIds:current.watchlist.slice(0,3).map(asset=>asset.id);
        if(!selected.length||selected.some(id=>!current.watchlist.some(asset=>asset.id===id)))throw new Error("finance_monitor_asset_not_found");
        return applyFinanceOperations(current,[{type:"monitor.upsert",monitor:{...previous,...patch,assetIds:[...assetIds]}}]);
      });
      // An abort after atomic persistence does not undo the saved definition.
      scope.assertCurrent();return workspace;
    }finally{await release();scope.assertCurrent();}
  }
  async schedule(scope:FinanceScope,input:{monitorId:string;scheduleHuman:string}) {
    const workspace=await this.store.load(scope);const monitor=workspace.monitors.find(item=>item.id===input.monitorId);if(!monitor)throw new Error("finance_monitor_not_found");
    const updated=await scheduleFinanceMonitor({scope,monitor,assets:workspace.watchlist,scheduleHuman:input.scheduleHuman});
    try {await this.store.save(scope,{workspace:{...workspace,monitors:workspace.monitors.map(item=>item.id===updated.id?updated:item)},expectedRevision:workspace.revision});}
    catch(error){await rollbackFinanceMonitor({scope,monitor:updated});throw error;}
    return {automationId:updated.automationId!,executionAvailability:"app-running" as const,status:updated.status as "active"|"paused"};
  }
  async pause(scope:FinanceScope,input:{monitorId:string}) {
    const workspace=await this.store.load(scope);const monitor=workspace.monitors.find(item=>item.id===input.monitorId);if(!monitor)throw new Error("finance_monitor_not_found");
    const updated=await pauseFinanceMonitor({scope,monitor});
    try{await this.store.save(scope,{workspace:{...workspace,monitors:workspace.monitors.map(item=>item.id===updated.id?updated:item)},expectedRevision:workspace.revision});}catch(error){if(!(error instanceof Error)||error.message!=="finance_revision_conflict")throw error;}
    scope.assertCurrent();return {automationId:updated.automationId!,executionAvailability:"app-running" as const,status:updated.status as "active"|"paused"};
  }
  private runDirectory(scope:FinanceScope,monitorId:string):string {
    scope.assertCurrent();const directory=path.join(this.root,"runs",partition(scope),createHash("sha256").update(monitorId).digest("hex"));
    fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.lstatSync(directory).isSymbolicLink())throw new Error("finance_monitor_store_invalid");return directory;
  }
  private history(scope:FinanceScope,monitorId:string):FinanceRunHistory {
    const directory=this.runDirectory(scope,monitorId);let history=this.histories.get(directory);
    if(!history){history=new FinanceRunHistory(directory,monitorId);this.histories.set(directory,history);}return history;
  }
  async monitorRuns(scope:FinanceScope,input:FinanceMonitorRunsRequest):Promise<FinanceMonitorRunsResult> {
    const workspace=await this.store.load(scope);if(!workspace.monitors.some(item=>item.id===input.monitorId))throw new Error("finance_monitor_not_found");
    const history=this.history(scope,input.monitorId),prepared=await history.prepare(scope);
    if(!prepared.ready)return {runs:[],nextCursor:null,indexStatus:'building',indexedCount:prepared.indexedCount};
    if(await history.hasRunning()){
      let release:(()=>Promise<void>)|undefined;
      try{release=await lockfile.lock(this.runDirectory(scope,input.monitorId),MONITOR_LOCK_OPTIONS);if(!await history.recover(scope))return {runs:[],nextCursor:null,indexStatus:'building',indexedCount:prepared.indexedCount};}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ELOCKED")throw error;}
      finally{await release?.();}
    }
    return history.page(scope,input);
  }
  async runMonitor(scope:FinanceScope,input:{monitorId:string;callerRunId?:string;callerChatId?:string},signal=AbortSignal.timeout(FINANCE_MONITOR_RUN_TIMEOUT_MS)):Promise<FinanceMonitorRun> {
    signal.throwIfAborted();scope.assertCurrent();
    const before=await this.store.load(scope);const monitor=before.monitors.find(item=>item.id===input.monitorId);if(!monitor||!monitor.query.trim())throw new Error("finance_monitor_not_found");
    if(input.callerRunId){
      const {getDb}=await import("../store/db");
      const row=getDb().prepare("SELECT automation_id FROM automation_runs WHERE id=?").get(input.callerRunId) as {automation_id:string}|undefined;
      if(row && readFinanceMonitor({scope,monitor}).automationId!==row.automation_id)throw new Error("finance_monitor_automation_binding_mismatch");
      if(row){
        try{await requireFinanceMonitoringAccess(scope);}
        catch(error){
          // Billing that cannot be reached right now is "cannot tell", not "not allowed": this run ends, the schedule stays.
          if(error instanceof Error&&error.message==="finance_monitoring_access_unavailable")throw error;
          try{await this.pause(scope,{monitorId:monitor.id});}
          catch{scope.assertCurrent();console.warn("finance_monitor_pause_pending");}
          throw error;
        }
        scope.assertCurrent();signal.throwIfAborted();
      }
    }
    const definition=monitorDefinition(monitor,before);
    const history=this.history(scope,monitor.id),prepared=await history.prepare(scope);
    if(!prepared.ready)throw new Error('finance_history_index_building');
    const directory=this.runDirectory(scope,monitor.id);const release=await lockfile.lock(directory,MONITOR_LOCK_OPTIONS);
    let run:FinanceMonitorRun={id:randomUUID(),monitorId:monitor.id,status:"running",startedAt:new Date().toISOString(),finishedAt:null,reportId:null,summary:"자료 조회 중",warnings:[],error:null,sourceRevision:before.revision};
    const write=()=>history.write(run);
    let reportSaved=false;
    try{
      if(!await history.recover(scope))throw new Error('finance_history_recovery_required');await write();
      const results:FinanceDataResult[]=[];
      const assets=monitor.assetIds.length?monitor.assetIds:before.watchlist.slice(0,3).map(asset=>asset.id);
      const requests:FinanceDataRequest[]=[...assets.slice(0,3).flatMap(assetId=>{
        const asset=before.watchlist.find(item=>item.id===assetId),fund=findIsharesFund(assetId);
        const verified=fund&&asset&&asset.symbol===fund.asset.symbol&&asset.currency===fund.asset.currency&&asset.kind===fund.asset.kind&&asset.exchange===fund.asset.exchange;
        const metrics=[...(verified?["nav",...(fund.holdingsUrl?["etf_holdings"]:[])]:["filings","company_facts"]),"news","price"];
        return [...metrics.map(metric=>({query:monitor.query,assetIds:[assetId],metrics:[metric],period:"1M"})),
          {query:asset?asset.symbol:monitor.query,assetIds:[],metrics:["social_search"],period:"1M"}];
      }),
        {query:monitor.query,assetIds:[],metrics:["macro_news"],period:"1M"}];
      const route={...await this.experience.consent(scope),signal,assertCurrent:()=>scope.assertCurrent()};
      // At most 16 queries. Topic searches use two community providers, so
      // reserve both HTTP slots rather than racing another source alongside them.
      // A failed source is a coverage gap;
      // cancellation or a changed owner always aborts the whole run before saving.
      for(let offset=0;offset<requests.length;){
        const pending:FinanceDataRequest[]=[];let slots=0;
        while(offset<requests.length){const request=requests[offset],weight=request.metrics.some(metric=>metric==="social"||metric==="social_search")?2:1;if(slots+weight>2)break;pending.push(request);slots+=weight;offset++;}
        const batch=await Promise.all(pending.map(async request=>{
          signal.throwIfAborted();scope.assertCurrent();
          try{const result=await queryFinanceData(request,before.watchlist,route);scope.assertCurrent();signal.throwIfAborted();return result;}
          catch{scope.assertCurrent();signal.throwIfAborted();return {status:"error" as const,sourceUrls:[],asOf:null,retrievedAt:new Date().toISOString(),columns:[],rows:[],warnings:[`finance_monitor_source_failed:${request.assetIds[0]??"context"}:${request.metrics[0]}`]};}
        }));
        scope.assertCurrent();signal.throwIfAborted();results.push(...batch);
      }
      const usable=results.filter(result=>["ok","partial"].includes(result.status)&&result.rows.length);
      if(!usable.length)throw new Error("finance_monitor_no_evidence");
      const briefing=await writeFinanceBriefing(monitor.query,results,signal);scope.assertCurrent();signal.throwIfAborted();
      const warnings=[...new Set([...results.flatMap(result=>result.warnings),...briefing.warnings])];
      const operations:FinanceOperation[]=[];const sections:FinanceReport["sections"]=[{id:financeId("section"),title:briefing.title??monitor.name,kind:"summary",narrative:briefing.summary,widget:null,projection:null}];
      const sourceByDataset=new Map<number,string[]>();
      for(const [dataset,result] of results.entries()){if(!usable.includes(result))continue;const batch=dataOperations(result,before,monitor.name,true);sourceByDataset.set(dataset,batch.sourceIds);operations.push(...batch.operations.filter(op=>op.type!=="report.add"));const op=batch.operations.find(op=>op.type==="report.add");if(op?.type==="report.add")sections.push(...op.report.sections.map(section=>({...section,presentation:"supporting" as const})));}
      if(briefing.citations?.length)sections.push({id:financeId("section"),title:"Evidence references",kind:"sources",presentation:"supporting",narrative:"Citation row and frozen dataset row indexes are zero-based.",widget:null,projection:{columns:["Citation","Source ID","Dataset row"],rows:briefing.citations.map(citation=>[citation.index,sourceByDataset.get(citation.dataset)?.[0]??null,citation.rowIndex]),status:"ready",warnings:[],asOf:null,sourceIds:[...sourceByDataset.values()].flat()}});
      const report:FinanceReport={id:financeId("report"),...(briefing.language?{language:briefing.language}:{}),title:briefing.title??monitor.name,createdAt:new Date().toISOString(),sourceRevision:before.revision,reviewPending:true,sections,dashboardSnapshot:null,parentReportId:null};
      operations.push({type:"report.add",report});
      // The store checks this scope again immediately before its atomic rename. Once
      // that commit succeeds, a later cancellation cannot undo or misreport it.
      const savingScope:FinanceScope={...scope,assertCurrent(){scope.assertCurrent();signal.throwIfAborted();}};
      for(let attempt=0;attempt<4;attempt++){savingScope.assertCurrent();const current=await this.store.load(savingScope);savingScope.assertCurrent();const live=current.monitors.find(item=>item.id===monitor.id);if(!live)throw new Error("finance_monitor_removed");if(monitorDefinition(live,current)!==definition)throw new Error("finance_monitor_definition_changed");try{await this.apply(savingScope,{operations,expectedRevision:current.revision});reportSaved=true;break;}catch(error){if(!(error instanceof Error)||error.message!=="finance_revision_conflict")throw error;}}
      if(!reportSaved)throw new Error("finance_revision_conflict");
      run={...run,status:results.some(result=>result.status!=="ok")||warnings.length?"partial":"succeeded",reportId:report.id,summary:briefing.summary.slice(0,4000),warnings,finishedAt:new Date().toISOString()};
    }catch(error){run={...run,status:signal.aborted?"cancelled":"failed",finishedAt:new Date().toISOString(),error:error instanceof Error?error.message:"finance_monitor_failed",summary:"브리핑을 완료하지 못했습니다. 저장된 실행 오류와 자료 연결 상태를 확인하세요."};}
    finally{
      try{await write();}
      catch(error){
        if(!reportSaved)throw error;
        // The report is already durable. Preserve its identity so callers can read
        // it without repeating the provider/model work after a ledger failure.
        const fallback:FinanceMonitorRun={...run,status:"partial",warnings:[...new Set([...run.warnings,"finance_monitor_run_index_pending"])]};
        try{await history.writeTerminalFallback(scope,fallback);run=fallback;}
        catch{run={...run,status:"partial",warnings:[...new Set([...run.warnings,"finance_monitor_run_receipt_not_recorded"])]};}
      }finally{await release();}
    }
    scope.assertCurrent();return run;
  }
}
let singleton:FinanceService|undefined;
export function getFinanceService():FinanceService{return singleton??=new FinanceService(userDataPath("finance"));}
