import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyFinanceOperations, createFinanceReport, financeId, FINANCE_WORKSPACE_LIMITS, validateFinanceOperation, validateFinanceWorkspace, type FinanceAIResult, type FinanceDataRequest, type FinanceDataResult, type FinanceDataSaveRequest, type FinanceDataSaveResult, type FinanceMonitor, type FinanceMonitorRun, type FinanceOperation, type FinanceReport, type FinanceSource, type FinanceWorkspace } from "../../shared/finance";
import { userDataPath } from "../runtime-paths";
import { FinanceStore, type FinanceScope } from "./store";
import { queryFinanceData, refreshFinanceQuotes, searchFinanceAssets } from "./data";
import { interpretFinance } from "./model";
import { writeFinanceBriefing } from "./briefing";
import { pauseFinanceMonitor, readFinanceMonitor, rollbackFinanceMonitor, scheduleFinanceMonitor } from "./monitor";

const lockfile = require("proper-lockfile") as { lock(target: string, options: unknown): Promise<() => Promise<void>> };
const MONITOR_LOCK_OPTIONS = { realpath: false, stale: 240000, retries: 0 };
/** Scheduler receipts can advance during a run; only research identity participates in this guard. */
function monitorDefinition(monitor: FinanceMonitor, workspace: FinanceWorkspace): string {
  const selected = monitor.assetIds.length ? monitor.assetIds : workspace.watchlist.slice(0, 3).map(asset => asset.id);
  return JSON.stringify({ name: monitor.name, query: monitor.query, assetIds: monitor.assetIds,
    assets: selected.map(id => workspace.watchlist.find(asset => asset.id === id) ?? null) });
}
function writeMonitorRun(file: string, run: FinanceMonitorRun): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(run), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file);
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
  constructor(private readonly root: string) { this.store = new FinanceStore(path.join(root,"workspaces")); }
  async load(scope: FinanceScope): Promise<FinanceWorkspace> {
    const workspace = await this.store.load(scope); scope.assertCurrent();
    return { ...workspace, monitors: workspace.monitors.map(monitor => readFinanceMonitor({ scope, monitor })) };
  }
  async save(scope: FinanceScope, input: { workspace: FinanceWorkspace; expectedRevision: number }): Promise<FinanceWorkspace> {
    const proposed = validateFinanceWorkspace(input.workspace), current = await this.store.load(scope); scope.assertCurrent();
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
    return this.store.save(scope,input);
  }
  async apply(scope: FinanceScope, input: { operations: FinanceOperation[]; expectedRevision: number }): Promise<FinanceWorkspace> {
    const current = await this.store.load(scope); if(current.revision !== input.expectedRevision) throw new Error("finance_revision_conflict");
    assertWorkspaceCapacity(current,input.operations);
    return this.save(scope,{workspace:applyFinanceOperations(current,input.operations),expectedRevision:current.revision});
  }
  async search(scope: FinanceScope,input:{query:string}) { const result=await searchFinanceAssets(input.query);scope.assertCurrent();return result; }
  async query(scope: FinanceScope,input:FinanceDataRequest) { const workspace=await this.store.load(scope);const result=await queryFinanceData(input,workspace.watchlist);scope.assertCurrent();return result; }
  async queryAndSave(scope:FinanceScope,input:FinanceDataSaveRequest):Promise<FinanceDataSaveResult> {
    const before=await this.store.load(scope);if(input.expectedRevision!==undefined && before.revision!==input.expectedRevision)throw new Error("finance_revision_conflict");
    const result=await queryFinanceData(input,before.watchlist);scope.assertCurrent();
    const batch=dataOperations(result,before,input.title||input.query||"Finance 자료",input.mode==="report");
    const workspace=await this.apply(scope,{operations:batch.operations,expectedRevision:before.revision});
    return {workspace,sourceIds:batch.sourceIds,...(batch.reportId?{reportId:batch.reportId}:{}),message:`조회 자료와 출처를 판본 ${workspace.revision}에 저장했습니다.`};
  }
  async addAsset(scope:FinanceScope,input:{query:string;symbol?:string}) {
    const found=await this.search(scope,input);const matches=found.assets.filter(asset=>!input.symbol||asset.symbol.toLowerCase()===input.symbol.toLowerCase());
    if(matches.length!==1)throw new Error("finance_asset_selection_required");
    const current=await this.store.load(scope);const asset=matches[0];
    if(current.watchlist.some(item=>item.id===asset.id))return {workspace:current,asset,warnings:found.warnings};
    return {workspace:await this.apply(scope,{operations:[{type:"watchlist.add",asset}],expectedRevision:current.revision}),asset,warnings:found.warnings};
  }
  async createReport(scope:FinanceScope,input:{dashboardId?:string;title?:string}) {
    const workspace=await this.store.load(scope);const dashboard=workspace.dashboards.find(item=>item.id===(input.dashboardId??workspace.activeDashboardId));
    if(!dashboard)throw new Error("finance_dashboard_not_found");
    const report=createFinanceReport(workspace,dashboard,input.title||dashboard.name);
    return {workspace:await this.apply(scope,{operations:[{type:"report.add",report}],expectedRevision:workspace.revision}),reportId:report.id};
  }
  async ask(scope:FinanceScope,input:{request:string;screenContext:string;baseRevision:number;requestId?:string},signal:AbortSignal):Promise<FinanceAIResult> {
    const workspace=await this.store.load(scope);const result=await interpretFinance(input,workspace,signal);scope.assertCurrent();
    if((await this.store.load(scope)).revision!==input.baseRevision)return {baseRevision:input.baseRevision,status:"conflict",message:"화면이 변경되어 AI 결과를 적용하지 않았습니다."};
    return result;
  }
  async refreshQuotes(scope:FinanceScope) {const workspace=await this.store.load(scope);const result=await refreshFinanceQuotes(workspace);scope.assertCurrent();return result;}
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
  private readMonitorRuns(directory:string):FinanceMonitorRun[] {
    return fs.readdirSync(directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(name=>{
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1000000)throw new Error("finance_monitor_run_invalid");
      const run=JSON.parse(fs.readFileSync(file,"utf8")) as FinanceMonitorRun;
      if(!run||run.id!==name.slice(0,-5)||!["running","succeeded","partial","failed","cancelled"].includes(run.status))throw new Error("finance_monitor_run_invalid");
      return run;
    });
  }
  /** Caller must hold this monitor's exclusive lease. A timestamp alone never proves interruption. */
  private reconcileInterruptedRuns(scope:FinanceScope,directory:string):void {
    for(const run of this.readMonitorRuns(directory))if(run.status==="running"){
      scope.assertCurrent();
      if(!/^[a-f0-9-]{36}$/.test(run.id))throw new Error("finance_monitor_run_invalid");
      writeMonitorRun(path.join(directory,`${run.id}.json`),{...run,status:"failed",finishedAt:new Date().toISOString(),error:"finance_monitor_interrupted",
        summary:"이전 실행의 잠금이 유지되지 않아 완료 여부를 확인할 수 없습니다. 자료를 다시 조회하세요."});
    }
  }
  async monitorRuns(scope:FinanceScope,input:{monitorId:string}):Promise<{runs:FinanceMonitorRun[]}> {
    const workspace=await this.store.load(scope);if(!workspace.monitors.some(item=>item.id===input.monitorId))throw new Error("finance_monitor_not_found");
    const directory=this.runDirectory(scope,input.monitorId);
    if(this.readMonitorRuns(directory).some(run=>run.status==="running")){
      let release:(()=>Promise<void>)|undefined;
      try{release=await lockfile.lock(directory,MONITOR_LOCK_OPTIONS);this.reconcileInterruptedRuns(scope,directory);}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ELOCKED")throw error;}
      finally{await release?.();}
    }
    const runs=this.readMonitorRuns(directory);
    scope.assertCurrent();return {runs:runs.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,50)};
  }
  async runMonitor(scope:FinanceScope,input:{monitorId:string;callerRunId?:string;callerChatId?:string},signal=AbortSignal.timeout(180000)):Promise<FinanceMonitorRun> {
    const before=await this.store.load(scope);const monitor=before.monitors.find(item=>item.id===input.monitorId);if(!monitor||!monitor.query.trim())throw new Error("finance_monitor_not_found");
    if(input.callerRunId){
      const {getDb}=await import("../store/db");
      const row=getDb().prepare("SELECT automation_id FROM automation_runs WHERE id=?").get(input.callerRunId) as {automation_id:string}|undefined;
      if(row && readFinanceMonitor({scope,monitor}).automationId!==row.automation_id)throw new Error("finance_monitor_automation_binding_mismatch");
    }
    const definition=monitorDefinition(monitor,before);
    const directory=this.runDirectory(scope,monitor.id);const release=await lockfile.lock(directory,MONITOR_LOCK_OPTIONS);
    let run:FinanceMonitorRun={id:randomUUID(),monitorId:monitor.id,status:"running",startedAt:new Date().toISOString(),finishedAt:null,reportId:null,summary:"자료 조회 중",warnings:[],error:null,sourceRevision:before.revision};
    const file=path.join(directory,`${run.id}.json`);const write=()=>writeMonitorRun(file,run);
    try{
      this.reconcileInterruptedRuns(scope,directory);write();
      const results:FinanceDataResult[]=[];
      const assets=monitor.assetIds.length?monitor.assetIds:before.watchlist.slice(0,3).map(asset=>asset.id);
      const requests:FinanceDataRequest[]=[...assets.slice(0,3).flatMap(assetId=>["filings","company_facts"].map(metric=>({query:monitor.query,assetIds:[assetId],metrics:[metric],period:"1M"}))),
        ...["social","macro_news"].map(metric=>({query:monitor.query,assetIds:[],metrics:[metric],period:"1M"}))];
      for(const request of requests){signal.throwIfAborted();scope.assertCurrent();results.push(await queryFinanceData(request,before.watchlist));}
      const usable=results.filter(result=>["ok","partial"].includes(result.status)&&result.rows.length);
      if(!usable.length)throw new Error("finance_monitor_no_evidence");
      const briefing=await writeFinanceBriefing(monitor.query,usable,signal);scope.assertCurrent();signal.throwIfAborted();
      const warnings=[...new Set([...results.flatMap(result=>result.warnings),...briefing.warnings])];
      const operations:FinanceOperation[]=[];const sections:FinanceReport["sections"]=[{id:financeId("section"),title:"AI 브리핑 · 검토용 초안",kind:"summary",narrative:briefing.summary,widget:null,projection:null}];
      for(const result of usable){const batch=dataOperations(result,before,monitor.name,true);operations.push(...batch.operations.filter(op=>op.type!=="report.add"));const op=batch.operations.find(op=>op.type==="report.add");if(op?.type==="report.add")sections.push(...op.report.sections);}
      const report:FinanceReport={id:financeId("report"),title:`${monitor.name} · ${new Date().toLocaleDateString("ko-KR")}`,createdAt:new Date().toISOString(),sourceRevision:before.revision,reviewPending:true,sections,dashboardSnapshot:null,parentReportId:null};
      operations.push({type:"report.add",report});
      let saved=false;
      for(let attempt=0;attempt<4;attempt++){const current=await this.store.load(scope);const live=current.monitors.find(item=>item.id===monitor.id);if(!live)throw new Error("finance_monitor_removed");if(monitorDefinition(live,current)!==definition)throw new Error("finance_monitor_definition_changed");try{await this.apply(scope,{operations,expectedRevision:current.revision});saved=true;break;}catch(error){if(!(error instanceof Error)||error.message!=="finance_revision_conflict")throw error;}}
      if(!saved)throw new Error("finance_revision_conflict");
      run={...run,status:usable.length<results.length||warnings.length?"partial":"succeeded",reportId:report.id,summary:briefing.summary.slice(0,4000),warnings,finishedAt:new Date().toISOString()};
    }catch(error){run={...run,status:signal.aborted?"cancelled":"failed",finishedAt:new Date().toISOString(),error:error instanceof Error?error.message:"finance_monitor_failed",summary:"브리핑을 완료하지 못했습니다. 저장된 실행 오류와 자료 연결 상태를 확인하세요."};}
    finally{try{write();}finally{await release();}}
    scope.assertCurrent();return run;
  }
}
let singleton:FinanceService|undefined;
export function getFinanceService():FinanceService{return singleton??=new FinanceService(userDataPath("finance"));}
