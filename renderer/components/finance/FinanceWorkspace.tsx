"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { IconRefresh, IconEdit, IconFileUp, IconArrowLeft } from "@/components/Icon";
import { IconSearch, IconClose, IconDownload, IconFileText, IconSparkles, IconCheck, IconSettings, IconChevronLeft } from "@/components/Icon";
import { ChartBlock } from "@/components/ChartBlock";
import { useFinanceStore } from "@/lib/finance-store";
import { FINANCE_WORKSPACE_LIMITS, financeEvidenceMetric, parseFinanceEvidenceMetric, createFinanceDashboard, createFinanceReport, createFinanceWidget, importFinanceCsv, projectFinanceWidget, effectiveFinanceWidget, financeId, type FinanceArchiveRequest, type FinanceArchiveResult, type FinanceArchiveItem, type FinanceMonitorRunsResult, type FinanceAsset, type FinanceReport, type FinanceReportSection, type FinanceSource, type FinanceOperation, type FinanceWidget, type FinanceMonitor, type FinanceMonitorRun, type FinanceSearchResult, type FinanceDataRequest, type FinanceDataResult, type FinanceWidgetProjection, type FinanceWorkspace as Workspace, } from "@shared/finance";
import styles from "./FinanceWorkspace.module.css";
import { financeReportCompositionSpec, financeReportCompositionTitle } from "@shared/finance-report-presentation";
import { financeDashboardChartPresentation } from "@shared/finance-dashboard-presentation";
import { FinanceAssetResults } from "./FinanceAssetResults";
import { FinanceDataResultView, financeDataVisual, financeMetricForColumns, financeCompactTreasuryTitle } from "./FinanceDataResultView";
import { FinanceDataConnections } from "./FinanceDataConnections";
import { FinanceMonitorReceipts, FinanceBriefText } from "./FinanceMonitorReceipts";
import { FinanceSettingsDialog, FinanceUsageNotices, type FinanceSettingsCategory } from "./FinanceSettingsDialog";
import { FinanceArtifactGallery, financeArtifactTitle } from "./FinanceArtifactGallery";
import { FinanceComputeView, financeComputeKind, financeComputeMetrics } from "./FinanceComputeView";
import { FinanceReportView, financeReportExportHtml } from "./FinanceReportView";
import { FinanceDashboardFeed } from "./FinanceDashboardFeed";
import type { FinanceDashboardFeedsResult } from "@shared/finance-feeds";
import type { FinanceAnalyst, FinanceAnalystDraft, FinanceAnalystRequest, FinanceAnalystResult } from "@shared/finance-analysts";
import { FinanceAnalysts } from "./FinanceAnalysts";
import { FinancePortfolioImport } from "./FinancePortfolioImport";
import { FinancePortfolioPanel } from "./FinancePortfolioPanel";
import type { FinancePlanningRequest, FinancePlanningResult } from "@shared/finance-planning";
import type { FinancePortfolioRequest, FinancePortfolioResult } from "@shared/finance-portfolio";
import { FinanceMarketOverview } from "./FinanceMarketOverview";
import { FinanceWorldMap } from "./FinanceWorldMap";
import { FINANCE_NOTICE_VERSION, type FinanceExperienceRequest, type FinanceExperienceState, type FinanceWorldMarketsResult } from "@shared/finance-experience";
import { resolveFinanceDataSource } from "@shared/finance-data-routing";
import { FinanceMessage, financeMessage, financeStatus, financeColumn, financeCell, financeStoredText, financeMonitorNote } from "./FinanceMessage";
/** Re-render preserved rows only; no provider/model call or present-day substitution. */
export function financeFrozenDataResult(projection: FinanceWidgetProjection, sources: FinanceSource[]): FinanceDataResult {
    const related = sources.filter(source => projection.sourceIds.includes(source.id));
    const retrieved = [...new Set(related.map(source => source.retrievedAt))];
    return { status: projection.status === "ready" ? "ok" : projection.status === "partial" ? "partial" : "unconnected",
        columns: projection.columns, rows: projection.rows, warnings: projection.warnings,
        asOf: projection.asOf, retrievedAt: retrieved.length === 1 ? retrieved[0] : "",
        sourceUrls: [...new Set(related.flatMap(source => source.url ? [source.url] : []))],
        providers: related.map(source=>({id:source.id,label:`Saved source record · ${source.name}`,status:source.status==="error"?"error" as const:source.status==="connected"||source.status==="imported"?"ok" as const:"partial" as const,coverage:`Saved source record · ${source.id} · ${source.asOf??"unknown"} · ${source.retrievedAt}`,rights:source.note||"No usage terms were recorded with this source.",sourceUrls:source.url?[source.url]:[]})) };
}
/** Only source administration fields collapse; filings, news and financial rows stay in the document. */
export function financeReportMetadataOnly(section:FinanceReportSection):boolean {
 if(section.widget?.type==="sources")return true;
 if(section.kind!=="sources")return false;
 if(!section.projection)return true;
 const names=new Set(["url","sourceurl","source","sourceid","status","observedat","retrievedat","retrieved","asof","note","usagenotes"]);
 return section.projection.columns.length>0&&section.projection.columns.every(name=>names.has(name.toLowerCase().replace(/[^a-z]/g,"")));
}
/** Compose ordinary canonical operations; a saved observation reference has no price/period inference. */
export function financePinReportSection(workspace:Workspace,reportId:string,sectionId:string,dashboardName:string) {
    const report=workspace.reports.find(item=>item.id===reportId);
    const section=report?.sections.find(item=>item.id===sectionId);
    if(!section?.projection)throw new Error("finance_evidence_reference_invalid");
    const metric=financeEvidenceMetric(reportId,sectionId);
    const active=workspace.dashboards.find(item=>item.id===workspace.activeDashboardId);
    const dashboard=active??createFinanceDashboard(dashboardName);
    const existing=dashboard.widgets.find(item=>item.metric===metric);
    if(existing)return {dashboardId:dashboard.id,widgetId:existing.id,operations:[] as FinanceOperation[]};
    const inferred=financeMetricForColumns(section.projection.columns);
    const computation=financeComputeKind(section),composition=!!financeReportCompositionTitle(section);
    const compactTitle=inferred==="treasury_yields"?"미국채":section.title;
    const widget={...createFinanceWidget(composition||computation||inferred==="price_history"||inferred==="treasury_yields"?"chart":"comparison",compactTitle),metric,assetIds:[],periodMode:"pinned" as const,period:"all" as const,chartType:composition||computation==="allocation"?"bar" as const:inferred||computation?"line" as const:"table" as const};
    const operations:FinanceOperation[]=[...(!active?[{type:"dashboard.add" as const,dashboard},{type:"dashboard.select" as const,dashboardId:dashboard.id}]:[]),{type:"widget.add",dashboardId:dashboard.id,widget}];
    return {dashboardId:dashboard.id,widgetId:widget.id,operations};
}
export function financeViewDataRequest(input: { metric: string; query: string; asset?: FinanceAsset; period: string; treasuryMonth: string }): FinanceDataRequest {
    const global = ["social", "social_search", "macro_news", "treasury_yields"].includes(input.metric);
    if (input.metric === "treasury_yields" && !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(input.treasuryMonth)) throw new Error("finance_period_invalid");
    return { query: input.query.trim() || (!global ? input.asset?.symbol ?? "" : ""), assetIds: !global && input.asset ? [input.asset.id] : [],
        metrics: [input.metric], period: input.metric === "price" ? "current" : input.metric === "treasury_yields" ? input.treasuryMonth.replace("-", "") : input.period };
}
/** The exact saved-widget DataResultView branch owns this transient maturity choice. */
export function financeSelectedWidgetSeries(workspace:Workspace,dashboardId:string|null,widgetId:string|null,selectedSeries?:string):string|undefined {
    const dashboard=workspace.dashboards.find(item=>item.id===dashboardId),widget=dashboard?.widgets.find(item=>item.id===widgetId);
    if(!dashboard||!widget||widget.hidden||widget.type==="sources"||widget.chartType==="table")return;
    const ref=parseFinanceEvidenceMetric(widget.metric);if(!ref)return;
    const section=workspace.reports.find(item=>item.id===ref.reportId)?.sections.find(item=>item.id===ref.sectionId);
    if(!section)return;
    const projection=projectFinanceWidget(workspace,effectiveFinanceWidget(dashboard,widget));
    if(financeComputeKind(section)||financeReportCompositionSpec({...section,projection}))return;
    const result=financeFrozenDataResult(projection,workspace.sources);
    const visual=financeDataVisual(result,financeMetricForColumns(result.columns),selectedSeries);
    return visual.kind==="treasury"?visual.label:undefined;
}
export interface FinanceWorkspaceProps {
    /** Existing Work chat surface; production does not fall back to a separate Finance conversation. */
    workChat: ReactNode;
    /** Put a user-selected shortcut in the shared Work draft; execution still requires Send. */
    onWorkDraft: (text:string, capability?: import("@/lib/work-chat-draft").WorkChatCapabilityRequest) => void;
    onPortfolio?:(request:FinancePortfolioRequest,signal:AbortSignal)=>Promise<FinancePortfolioResult>;
    onPlanning?:(request:FinancePlanningRequest,signal:AbortSignal)=>Promise<FinancePlanningResult>;
    onAnalysts?:(request:FinanceAnalystRequest)=>Promise<FinanceAnalystResult>;
    /** Host revision events refresh preferences after canonical workspace reconciliation. */
    experienceRefreshVersion?: number;
    onExperience?: (request:FinanceExperienceRequest)=>Promise<FinanceExperienceState>;
    onWorldMarkets?: ()=>Promise<FinanceWorldMarketsResult>;
    onDashboardFeeds?: ()=>Promise<FinanceDashboardFeedsResult>;
    onSearch?: (query: string, signal: AbortSignal) => Promise<FinanceSearchResult>;
    onExport?: (file: {
        name: string;
        mime: string;
        content: string;
        ownerScope: string | null;
    }) => Promise<{
        saved: boolean;
        path?: string;
    }>;
    onRefreshData?: (signal: AbortSignal) => Promise<{
        message: string;
        operations?: FinanceOperation[];
        baseRevision: number;
    }>;
    onPauseMonitor?: (monitor: FinanceMonitor) => Promise<void>;
    onScheduleMonitor?: (monitor: FinanceMonitor, scheduleHuman: string) => Promise<void>;
    onQueryData?: (request: FinanceDataRequest, signal: AbortSignal) => Promise<FinanceDataResult>;
    onRunMonitor?: (monitor: FinanceMonitor) => Promise<FinanceMonitorRun>;
    onMonitorRuns?: (monitorId: string, page?:{cursor?:string;limit?:number}) => Promise<FinanceMonitorRunsResult>;
    onArchives?: (request:FinanceArchiveRequest)=>Promise<FinanceArchiveResult>;
    onQueryAndSave?: (request: FinanceDataRequest & {expectedRevision:number;mode:"sources"|"report";title?:string}, signal:AbortSignal) => Promise<{reportId?:string;sourceIds:string[];message:string}>;
    onOpenResearch?: (asset: FinanceAsset) => void | Promise<void>;
}
type Tab = "dashboard" | "watchlist" | "reports" | "sources" | "monitors";
const periods: FinanceWidget["period"][] = ["1M", "3M", "1Y", "5Y", "all"];
const types: FinanceWidget["type"][] = ["watchlist", "holdings", "comparison", "chart", "allocation", "notes", "events"];
const labels = {
    watchlist: ["관심 자산", "Watchlist"], holdings: ["보유 자산", "Holdings"], comparison: ["자산 비교", "Comparison"],
    chart: ["가격 흐름", "Price history"], allocation: ["자산 구성", "Allocation"], notes: ["리서치 메모", "Research notes"],
    sources: ["데이터 근거", "Data sources"], events: ["주요 사건", "Events"],
} as const;
export function financeMonitorScheduleValue(monitor: FinanceMonitor, drafts: Readonly<Record<string,string>>): string {
    if(monitor.status === "active") return monitor.scheduleHuman || "daily-09:00";
    return drafts[monitor.id] || monitor.scheduleHuman || "daily-09:00";
}
export function financeArchivePreview(workspace:Workspace,reportIds:readonly string[]) {
    const selected=new Set(reportIds);
    const reportSources=(report:FinanceReport)=>report.sections.flatMap(section=>section.projection?.sourceIds??[]);
    const referenced=new Set([...workspace.quotes.map(q=>q.sourceId),...workspace.holdings.map(h=>h.sourceId),...workspace.reports.filter(r=>!selected.has(r.id)).flatMap(reportSources)]);
    const selectedSources=new Set(workspace.reports.filter(r=>selected.has(r.id)).flatMap(reportSources));
    return {reports:workspace.reports.filter(r=>selected.has(r.id)).length,referenced:selectedSources.size,reclaimable:workspace.sources.filter(source=>!referenced.has(source.id)),retained:workspace.sources.filter(source=>referenced.has(source.id)).length};
}
function DraftField({ value, onCommit, label, multiline = false, className = "", disabled = false }: {
    value: string; onCommit: (value: string) => void; label: string; multiline?: boolean; className?: string; disabled?: boolean;
}) {
    const {locale}=useT();const ko=locale==="ko";
    const [draft,setDraft]=useState(value);
    const [conflict,setConflict]=useState(false);
    const base=useRef(value);const dirty=useRef(false);
    useEffect(()=>{
        if(dirty.current && value!==base.current && value!==draft){setConflict(true);return;}
        if(!dirty.current || value===draft){base.current=value;dirty.current=false;setDraft(value);setConflict(false);}
    },[value]);
    const hasConflict=conflict || (dirty.current && value!==base.current && value!==draft);
    const props={disabled,"aria-label":label,value:draft,className:`${styles.input} ${className}`,onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>{dirty.current=e.target.value!==base.current;setDraft(e.target.value);},onBlur:()=>{if(!hasConflict&&draft!==value)onCommit(draft);}};
    const reset=()=>{base.current=value;dirty.current=false;setConflict(false);setDraft(value);};
    return <>{multiline?<textarea {...props} className={`${props.className} ${styles.textarea}`} maxLength={20000}/>:<input {...props} maxLength={200} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape"){reset();e.currentTarget.blur();}}}/>}{hasConflict&&<div className={styles.notice} role="alert"><p>{ko?"다른 작업이 이 내용을 변경했습니다. 작성 중인 초안은 보존했으며 자동으로 덮어쓰지 않습니다.":"Another task changed this content. Your draft is preserved and will not overwrite it automatically."}</p><button type="button" className={styles.button} onClick={reset}>{ko?"최신 값 가져오기":"Use latest value"}</button><details><summary>{ko?"작성 중인 초안":"Your unsaved draft"}</summary><pre className={styles.preWrap}>{draft}</pre></details></div>}</>;
}

export function financeDashboardProjection(projection:FinanceWidgetProjection):FinanceWidgetProjection {
    const picked:number[]=[];
    const groups=[["Symbol","Asset","Fund","Name","Title","Entity","Maturity"],["Price","Close (raw)","NAV per share","Market value","Par curve yield","Value","Quantity"],["Change","Change (%)","Change percent","Unrealized P&L","Fund weight (%)","Weight","Quantity"],["Currency","Reporting currency","Market currency","Unit"]];
    for(const names of groups){const at=names.map(name=>projection.columns.indexOf(name)).find(index=>index>=0&&!picked.includes(index));if(at!==undefined)picked.push(at);}
    const omitted=new Set(["Source","Source ID","Retrieved at","Observed at","Observation date","Note","URL","Original filing","Original post"]);
    if(projection.columns.includes("Symbol"))omitted.add("Name");
    for(let i=0;i<projection.columns.length&&picked.length<4;i++)if(!picked.includes(i)&&!omitted.has(projection.columns[i]))picked.push(i);
    return {...projection,columns:picked.map(i=>projection.columns[i]),rows:projection.rows.map(row=>picked.map(i=>row[i]??null))};
}
function DataTable({ projection,compact=false }: {projection:FinanceWidgetProjection;compact?:boolean}) {
    const {locale}=useT();const [page,setPage]=useState(0);const data=compact?financeDashboardProjection(projection):projection;
    const pages=Math.max(1,Math.ceil(data.rows.length/50)),current=Math.min(page,pages-1),nameIndex=projection.columns.indexOf("Name");
    return <><div className={`${styles.scroll} ${compact?styles.compactTable:""}`} tabIndex={0} role="region" aria-label={locale==="ko"?"자료 표":"Data table"}><table className={styles.table}><thead><tr>{data.columns.map((column,index)=><th key={index} scope="col">{financeColumn(column,locale==="ko")}</th>)}</tr></thead><tbody>{data.rows.slice(current*50,(current+1)*50).map((row,index)=><tr key={current*50+index}>{data.columns.map((column,i)=>{const value=row[i]??null;const name=["Name","Company","Company name","Description"].includes(column);const company=compact&&column==="Symbol"&&nameIndex>=0?projection.rows[current*50+index]?.[nameIndex]??null:null;return <td key={i} className={typeof value==="number"?styles.number:undefined}>{company!==null?<span className={styles.assetIdentity}><strong>{financeCell(value,column,locale==="ko")}</strong><span className={styles.cellName} title={String(company)}>{String(company)}</span></span>:typeof value==="string"&&/^https?:\/\//i.test(value)?<a className={styles.link} href={value} title={value} target="_blank" rel="noopener noreferrer">{locale==="ko"?"원문 열기":"Open source"}</a>:name?<span className={styles.cellName} title={String(value)}>{financeCell(value,column,locale==="ko")}</span>:financeCell(value,column,locale==="ko")}</td>;})}</tr>)}</tbody></table></div>{pages>1&&<div className={styles.tablePages}><button type="button" className={styles.button} disabled={current===0} onClick={()=>setPage(current-1)}>{locale==="ko"?"이전":"Previous"}</button><button type="button" className={styles.button} disabled={current===pages-1} onClick={()=>setPage(current+1)}>{locale==="ko"?"다음":"Next"}</button></div>}</>;
}
function Projection({ widget, projection, ko, compact=false, inspect=false }: {
    widget: FinanceWidget;
    projection: FinanceWidgetProjection;
    ko: boolean;
    compact?: boolean;
    inspect?: boolean;
}) {
    const {composition,chartable,spec}=useMemo(
        ()=>financeDashboardChartPresentation(widget,projection,ko?"ko":"en"),[widget,projection,ko]);
    if (widget.type === "notes")
        return <p className={styles.narrative}>{widget.notes || (ko ? "블록 설정에서 조사 메모를 작성하세요." : "Add a research note in block settings.")}</p>;
    return <>
    {projection.status === "empty" || projection.status === "unsupported" ? <div className={styles.empty}>{compact?(ko?"자료 없음":"No data"):ko ? "이 블록에 표시할 확인된 자료가 없습니다." : "No verified data is available for this block."}</div> : composition ? <ChartBlock code={JSON.stringify(composition)} presetSpec={composition} blockId={`finance-composition:${widget.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<DataTable projection={projection} compact={compact}/>}/> : widget.type!=="allocation"&&chartable ? <ChartBlock code={JSON.stringify(spec)} presetSpec={spec} blockId={`finance:${widget.id}`} size="panel" fallback={<DataTable projection={projection} compact={compact}/>}/> : <DataTable projection={projection} compact={compact}/>}
    {!compact && projection.rows.length > 5000 && chartable && <p className={styles.muted}>{ko ? "처음 5,000개 관측 표시 · CSV로 전체 내보내기" : "First 5,000 observations shown · export all as CSV"}</p>}{!compact && projection.rows.length > 500 && !chartable && !composition && <p className={styles.muted}>{ko ? "처음 500개 행 표시 · CSV로 전체 내보내기" : "First 500 rows shown · export all rows as CSV"}</p>}
    {!compact && widget.chartType !== "table" && !chartable && !composition && projection.rows.length > 0 && <p className={styles.muted}>{ko ? "호환되는 단위·시계열을 확인할 수 없어 원자료 표로 표시합니다." : "Showing source data as a table: compatible units or history are unavailable."}</p>}{!compact&&inspect&&projection.warnings.length>0&&<details className={styles.cardDetails}><summary>{ko?"자료 정보":"Data information"}</summary>{projection.warnings.map((warning,i)=><FinanceMessage key={i} value={warning} ko={ko} note/>)}</details>}
  </>;
}
/** View changes reuse an in-flight request and unexpired observations within one owner/settings scope. */
export function useFinanceDashboardResource<T extends { expiresAt: string }>({ scopeKey, enabled, active, load }: {
    scopeKey: string; enabled: boolean; active: boolean; load?: () => Promise<T>;
}) {
    const scope = useMemo(() => ({ scopeKey, enabled, load }), [scopeKey, enabled, load]);
    const current = useRef(scope); current.current = scope;
    const mounted = useRef(false);
    const [snapshot, setSnapshot] = useState<{ scope: typeof scope; data: T | null; loading: boolean } | null>(null);
    const latest = useRef(snapshot); latest.current = snapshot;
    const request = useRef<{ scope: typeof scope; promise: Promise<void> } | null>(null);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const refresh = useCallback((): Promise<void> => {
        if (!scope.enabled || !scope.load || !mounted.current || current.current !== scope) return Promise.resolve();
        if (request.current?.scope === scope) return request.current.promise;
        setSnapshot(previous => ({ scope, data: previous?.scope === scope ? previous.data : null, loading: true }));
        const promise = Promise.resolve().then(scope.load).then(data => {
            if (mounted.current && current.current === scope) setSnapshot({ scope, data, loading: false });
        }, () => {
            // Keep the last observed result visible if a manual/background refresh fails.
            if (mounted.current && current.current === scope)
                setSnapshot(previous => ({ scope, data: previous?.scope === scope ? previous.data : null, loading: false }));
        }).finally(() => { if (request.current?.promise === promise) request.current = null; });
        request.current = { scope, promise };
        return promise;
    }, [scope]);
    useEffect(() => {
        if (!enabled || !active || !load) return;
        const saved = latest.current;
        if (saved?.scope === scope && saved.data && Date.parse(saved.data.expiresAt) > Date.now()) return;
        void refresh();
    }, [scope, enabled, active, load, refresh]);
    const visible = enabled && snapshot?.scope === scope ? snapshot : null;
    return { data: visible?.data ?? null, loading: visible?.loading ?? false, refresh };
}

export function FinanceWorkspace({ onSearch, onExport, onOpenResearch, onRefreshData, onScheduleMonitor, onQueryData, onPauseMonitor, onRunMonitor, onMonitorRuns, onQueryAndSave, onArchives, onExperience, onWorldMarkets, onDashboardFeeds, onAnalysts, onPortfolio, onPlanning, experienceRefreshVersion=0, workChat, onWorkDraft }: FinanceWorkspaceProps) {
    const { locale } = useT();
    const ko = locale === "ko";
    const l = (k: string, e: string) => ko ? k : e;
    const store = useFinanceStore();
    const { workspace, loading, saving, error, dispatch, undo, redo, canUndo, canRedo } = store;
    const [,setArtifactTab]=useState<Tab>("dashboard");
    const [artifactDetail,setArtifactDetail]=useState(false);
    const [portfolioOpen,setPortfolioOpen]=useState(false);
    const [portfolioFiles,setPortfolioFiles]=useState<File[]>([]);
    const openPortfolio=(files:File[]=[])=>{setPortfolioFiles(files);setPortfolioOpen(true);};
    const [chatTool,setChatTool]=useState<"watchlist"|"sources"|null>(null);
    const [lastRunAt,setLastRunAt]=useState<Record<string,string|null>>({});
    const [view,setView]=useState<"dashboard"|"chat"|"artifacts"|"monitoring">("dashboard");
    const [confirming,setConfirming]=useState("");
    const openChatDraft=(text:string,capability?:import("@/lib/work-chat-draft").WorkChatCapabilityRequest)=>{
        onWorkDraft(text,capability);
        setChatTool(null);setView("chat");
    };
    const [settingsOpen,setSettingsOpen]=useState(false);
    const [settingsCategory,setSettingsCategory]=useState<FinanceSettingsCategory>("data");
    const settingsReturnFocus=useRef<HTMLElement|null>(null);
    const openSettings=(category:FinanceSettingsCategory)=>{settingsReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setSettingsCategory(category);setSettingsOpen(true);};
    const closeSettings=()=>{setSettingsOpen(false);const target=settingsReturnFocus.current;requestAnimationFrame(()=>{if(target?.isConnected)target.focus({preventScroll:true});});};
    const toolDialog=useRef<HTMLDialogElement>(null);
    useEffect(()=>{
        const dialog=toolDialog.current;
        if(!chatTool||!dialog)return;
        const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
        if(!settingsOpen){dialog.showModal();dialog.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();}
        return()=>{dialog.close();searchAbort.current?.abort();queryAbort.current?.abort();if(chatTool==="watchlist")setSearch("");if(previous?.isConnected)previous.focus({preventScroll:true});};
    },[chatTool]);
    useEffect(()=>{const dialog=toolDialog.current;if(!dialog||!chatTool)return;if(settingsOpen&&dialog.open)dialog.close();else if(!settingsOpen&&!dialog.open)dialog.showModal();},[settingsOpen,chatTool]);
    const [experience,setExperience]=useState<FinanceExperienceState|null>(null);
    const [experienceLoading,setExperienceLoading]=useState(true);
    const [experiencePending,setExperiencePending]=useState(false);
    const [experiencePreparing,setExperiencePreparing]=useState(false);
    const [experienceError,setExperienceError]=useState("");
    const experienceEpoch=useRef(0);
    const consentAccepted=experience?.consent?.version===FINANCE_NOTICE_VERSION;
    const builtinsReady=experience?.builtins?.ready===true&&experience.builtins.phase==="ready";
    const consentReady=consentAccepted&&builtinsReady;
    const dashboard = workspace.dashboards.find(d => d.id === workspace.activeDashboardId) ?? workspace.dashboards[0];
    // Saved modules are authoritative even while the host preference receipt is catching up.
    const dashboardCustomized=experience?.dashboardCustomized===true||!!dashboard?.widgets.length;
    const monitoringAllowed=experience?.access.status==="verified"&&experience.access.monitoringAllowed===true;
    const experienceRefreshSeen=useRef(experienceRefreshVersion);
    const setTab=(next:Tab)=>{if(next!=="watchlist"&&next!=="sources")setArtifactTab(next);if(next==="dashboard")setView("dashboard");else if(next==="monitors"){setView("monitoring");}else if(next==="watchlist"||next==="sources"){setChatTool(next);}else{setArtifactDetail(true);setView("artifacts");}};
    const readExperience=async(background=false)=>{const epoch=++experienceEpoch.current;if(!background)setExperienceLoading(true);setExperienceError("");
        try{if(!onExperience)throw new Error("unavailable");const next=await onExperience({action:"read",includeUnconfirmedReview:true});if(epoch===experienceEpoch.current)setExperience(next);}
        catch{if(epoch===experienceEpoch.current)setExperienceError(l("이용 설정을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.","Could not load usage settings. Check the connection and try again."));}
        finally{if(epoch===experienceEpoch.current)setExperienceLoading(false);}};
    useEffect(()=>{void readExperience();return()=>{experienceEpoch.current++;};},[onExperience]);
    const updateExperience=async(request:FinanceExperienceRequest)=>{if(!onExperience)return;const epoch=++experienceEpoch.current;let refresh=false;setExperiencePending(true);setExperiencePreparing(request.action==="accept"||request.action==="plugins.prepare");setExperienceError("");
        try{const next=await onExperience(request);if(epoch===experienceEpoch.current){setExperience(previous=>request.action==="monitoring"&&!request.enabled&&next.builtins===undefined&&previous?.builtins?{...next,builtins:previous.builtins}:next);refresh=!(request.action==="monitoring"&&!request.enabled);}}
        catch{if(epoch===experienceEpoch.current)setExperienceError(l("설정을 저장하지 못했습니다. 계정·이용 권한과 연결을 확인하세요.","Could not save settings. Check account access and the connection."));}
        finally{if(epoch===experienceEpoch.current){setExperiencePending(false);setExperiencePreparing(false);}}if(refresh&&epoch===experienceEpoch.current)void readExperience(true);};
    // Consent given but the built-in tools not ready (an app update, an earlier failure): prepare them once without asking; a failure shows a plain Retry.
    const autoPrepared=useRef(false);
    useEffect(()=>{
        if(!consentAccepted||builtinsReady||experiencePending||experienceLoading||!onExperience||autoPrepared.current||experienceError)return;
        autoPrepared.current=true;void updateExperience({action:"plugins.prepare"});
    },[consentAccepted,builtinsReady,experiencePending,experienceLoading,experienceError,onExperience]);
    useEffect(()=>{
        if(experiencePending||experienceRefreshSeen.current===experienceRefreshVersion)return;
        experienceRefreshSeen.current=experienceRefreshVersion;
        void readExperience(true);
    },[experienceRefreshVersion,experiencePending,onExperience]);
    const markCustomized=async(operations:FinanceOperation[])=>{if(experience?.dashboardCustomized!==true&&operations.some(op=>op.type.startsWith("widget.")||op.type==="dashboard.add"&&op.dashboard.widgets.length>0))await updateExperience({action:"customize",customized:true});};
    const marketSourceId=experience?resolveFinanceDataSource(experience,'market'):undefined;
    const marketScopeKey=JSON.stringify([workspace.ownerScope,marketSourceId]);
    const {data:markets,loading:marketsLoading,refresh:refreshMarkets}=useFinanceDashboardResource({
        scopeKey:marketScopeKey,enabled:consentReady,active:view==="dashboard",load:onWorldMarkets,
    });
    const feedScopeKey=JSON.stringify([workspace.ownerScope,experience?.sourceId,experience?.enabledFeedIds??[],experience?.sourceBindings??{},workspace.watchlist.map(asset=>[asset.id,asset.symbol,asset.exchange])]);
    const {data:feeds,loading:feedsLoading,refresh:refreshFeeds}=useFinanceDashboardResource({
        scopeKey:feedScopeKey,enabled:consentReady,active:view==="dashboard",load:onDashboardFeeds,
    });
    const [editing, setEditing] = useState(false);
    const [selected, setSelected] = useState("");
    const [savedSeries,setSavedSeries]=useState<Record<string,string>>({});
    const [notice, setNotice] = useState("");
    // A one-line result (a schedule saved, a search note) belongs to the screen it came from: it does not follow the owner to another tab.
    useEffect(()=>{setNotice("");},[view]);
    const [analysts,setAnalysts]=useState<FinanceAnalyst[]>([]);
    const [analystsLoading,setAnalystsLoading]=useState(false),[analystsPending,setAnalystsPending]=useState(false),[analystsError,setAnalystsError]=useState("");
    const analystEpoch=useRef(0),analystMutation=useRef(false),analystOwner=useRef(workspace.ownerScope);analystOwner.current=workspace.ownerScope;
    const refreshAnalysts=async()=>{
        if(analystMutation.current)return;
        const epoch=++analystEpoch.current,owner=workspace.ownerScope;setAnalystsLoading(true);setAnalystsError("");
        try{if(!onAnalysts)throw new Error("unavailable");const result=await onAnalysts({action:"list"});if(epoch===analystEpoch.current&&owner===analystOwner.current)setAnalysts(result.items);}
        catch{if(epoch===analystEpoch.current&&owner===analystOwner.current)setAnalystsError(l("Analyst를 불러오지 못했습니다. 다시 시도하세요.","Could not load Analysts. Try again."));}
        finally{if(epoch===analystEpoch.current&&owner===analystOwner.current)setAnalystsLoading(false);}
    };
    const changeAnalyst=async(action:FinanceAnalystRequest):Promise<boolean>=>{
        if(!onAnalysts){setAnalystsError(l("이 앱에서는 Analyst 저장을 사용할 수 없습니다.","Analyst saving is unavailable in this app."));return false;}
        if(analystMutation.current)return false;
        const epoch=++analystEpoch.current,owner=workspace.ownerScope;analystMutation.current=true;setAnalystsPending(true);setAnalystsError("");setAnalystsLoading(false);
        try{const result=await onAnalysts(action);if(epoch!==analystEpoch.current||owner!==analystOwner.current)return false;setAnalysts(result.items);return true;}
        catch{if(epoch===analystEpoch.current&&owner===analystOwner.current)setAnalystsError(l("저장 상태가 변경되었거나 요청에 실패했습니다. 새로 고침 후 작성 내용을 확인하세요.","The saved version changed or the request failed. Refresh and review your draft."));return false;}
        finally{if(epoch===analystEpoch.current&&owner===analystOwner.current){analystMutation.current=false;setAnalystsPending(false);}}
    };
    useEffect(()=>{analystEpoch.current++;analystMutation.current=false;setAnalysts([]);setAnalystsPending(false);setAnalystsLoading(false);setAnalystsError("");return()=>{analystEpoch.current++;};},[workspace.ownerScope,onAnalysts]);
    useEffect(()=>{if(consentReady&&onAnalysts)void refreshAnalysts();},[consentReady,onAnalysts,workspace.ownerScope]);
    useEffect(()=>{if(settingsOpen&&settingsCategory==="analysts"&&consentReady)void refreshAnalysts();},[settingsOpen,settingsCategory]);
    const analystPrompt=(draft?:FinanceAnalystDraft):string=>draft
        ?l(`Analyst를 함께 만들어줘.\n이름: ${draft.name}\n설명: ${draft.description}\n지침:\n${draft.instructions}`,`Help me build an Analyst.\nName: ${draft.name}\nDescription: ${draft.description}\nInstructions:\n${draft.instructions}`)
        :l("Analyst 함께 만들기","Create an Analyst together");
    const beginAnalystAuthoring=(draft?:FinanceAnalystDraft)=>{if(!onAnalysts){setAnalystsError(l("이 앱에서는 Analyst 만들기를 사용할 수 없습니다.","Analyst creation is unavailable in this app."));return;}if(analystMutation.current)return;setSettingsOpen(false);openChatDraft(analystPrompt(draft),{plugin:"finance",workflow:"analyst"});};

    const [search, setSearch] = useState("");
    const [searchEvidence, setSearchEvidence] = useState<FinanceSearchResult | null>(null);
    const [selectedCandidate,setSelectedCandidate]=useState<{asset:FinanceAsset;ownerScope:string|null;revision:number}|null>(null);
    const selectedAsset=selectedCandidate?.ownerScope===workspace.ownerScope&&selectedCandidate.revision===workspace.revision?selectedCandidate.asset:null;
    const watchlistIds=useMemo(()=>new Set(workspace.watchlist.map(asset=>asset.id)),[workspace.watchlist]);
    const [dataAssetId, setDataAssetId] = useState("");
    const [dataQueryText,setDataQueryText]=useState("");
    const [lastDataRequest,setLastDataRequest]=useState<FinanceDataRequest|null>(null);
    const [dataSaving,setDataSaving]=useState(false);
    const [dataMetric, setDataMetric] = useState("price");
    const [treasuryMonth, setTreasuryMonth] = useState(() => new Date().toISOString().slice(0, 7));
    const globalDataMetric = ["social", "social_search", "macro_news", "treasury_yields"].includes(dataMetric);
    const [dataResult, setDataResult] = useState<FinanceDataResult | null>(null);
    const [querying, setQuerying] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [scheduling, setScheduling] = useState("");
    const [monitorSchedules, setMonitorSchedules] = useState<Record<string,string>>({});
    const [selectedSection, setSelectedSection] = useState("");
    const queryAbort = useRef<AbortController | null>(null);
    const refreshAbort = useRef<AbortController | null>(null);
    const [searching, setSearching] = useState(false);
    const [reportId, setReportId] = useState("");
    const [archiveOpen,setArchiveOpen]=useState(false);
    const [archiveItems,setArchiveItems]=useState<FinanceArchiveItem[]>([]);
    const [archiveCursor,setArchiveCursor]=useState<string|null>(null);
    const [archiveBusy,setArchiveBusy]=useState(false);
    const [archiveRead,setArchiveRead]=useState<Extract<FinanceArchiveResult,{action:"read"}>|null>(null);
    const [archiveReportId,setArchiveReportId]=useState("");
    const [archiveRestoreIds,setArchiveRestoreIds]=useState<string[]>([]);
    const [archiveSelection,setArchiveSelection]=useState<string[]>([]);
    const [archivePreview,setArchivePreview]=useState<{revision:number;reportIds:string[]}|null>(null);
    const archiveEpoch=useRef(0);
    useEffect(()=>()=>{archiveEpoch.current++;},[]);
    const [importOpen, setImportOpen] = useState(false);
    const [csv, setCsv] = useState("");
    const [csvName, setCsvName] = useState("");
    const [defaultCurrency, setDefaultCurrency] = useState("");
    const searchAbort = useRef<AbortController | null>(null);
    const latest = useRef(workspace);
    latest.current = workspace;
    useEffect(()=>{
        searchAbort.current?.abort();searchAbort.current=null;setSearching(false);setSearchEvidence(null);setSelectedCandidate(null);
    },[workspace.ownerScope,workspace.revision]);
    useEffect(() => () => { searchAbort.current?.abort(); queryAbort.current?.abort(); refreshAbort.current?.abort(); }, []);
    const widget = dashboard?.widgets.find(w => w.id === selected);
    const compositionWidget=!!widget&&(widget.type==="allocation"||(()=>{const ref=parseFinanceEvidenceMetric(widget.metric),section=ref?workspace.reports.find(report=>report.id===ref.reportId)?.sections.find(item=>item.id===ref.sectionId):undefined;return !!section&&!!financeReportCompositionTitle(section);})());
    const archivedReport=archiveOpen?archiveRead?.workspaceSnapshot.reports.find(r=>r.id===archiveReportId&&archiveRead.reportIds.includes(r.id)):undefined;
    const report = archivedReport ?? (archiveOpen?undefined:workspace.reports.find(r => r.id === reportId) ?? workspace.reports[0]);
    const reportEditing=editing&&!archivedReport;
    const archiveCounts=useMemo(()=>financeArchivePreview(workspace,archivePreview?.reportIds??archiveSelection),[workspace,archivePreview,archiveSelection]);
    const imported = useMemo(() => csv.trim() ? importFinanceCsv(csv, { defaultCurrency }) : null, [csv, defaultCurrency]);
    const friendlyError = (value: string) => {
        const translated=financeMessage(value,ko); if(translated!==value)return translated;
        if (value.includes("revision_conflict"))
            return l("다른 작업에서 자료가 바뀌었습니다. 최신 상태를 다시 열어주세요.", "Another task changed the workspace. Reload the latest state.");
        if (value.includes("asset_has_holdings"))
            return l("보유 자료가 연결된 자산은 관심목록에서 제거할 수 없습니다.", "Assets with holdings cannot be removed from the watchlist.");
        if (value.includes("scheduler"))
            return l("자동 점검을 사용할 수 없습니다. 초안은 유지됩니다.", "Automatic checks are unavailable. The draft is preserved.");
        if (value.includes("finance_") || value.startsWith("["))
            return l("변경을 저장하지 못했습니다. 입력값을 확인하고 다시 시도하세요.", "Could not save the change. Check your input and try again.");
        return l("작업을 완료하지 못했습니다. 잠시 후 다시 시도하세요.", "Couldn't finish that. Try again in a moment.");
    };
    const act = async (operation: FinanceOperation | FinanceOperation[], message?: string) => {
        try {
            const saved = await dispatch(operation);
            await markCustomized(Array.isArray(operation)?operation:[operation]);
            if (message)
                setNotice(message);
            return saved;
        }
        catch (cause) {
            setNotice(cause instanceof Error ? friendlyError(cause.message) : l("변경을 저장하지 못했습니다. 다시 시도하세요.", "The change could not be saved. Please retry."));
            return null;
        }
    };
    const date = (value: string | null | undefined) => value ? /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value} · ${l("일 기준", "day precision")}` : new Date(value).toLocaleString(ko ? "ko-KR" : "en-US") : l("미확인", "Unknown");
    const btn = (text: string, onClick: () => void, disabled = false, primary = false, reason?: string): ReactNode => <><button type="button" className={`${styles.button} ${primary ? styles.primary : ""}`} onClick={onClick} disabled={disabled} title={disabled && reason ? reason : undefined}>{text}</button>{disabled && reason && <span className={styles.hint}>{reason}</span>}</>;
    const confirmBtn = (key: string, text: string, onConfirm: () => void, disabled = false, reason?: string, question?: string): ReactNode => confirming === key
        ? <span className={styles.confirmInline} role="group" aria-label={text}><span>{question ?? l("정말 삭제할까요?", "Delete this?")}</span><button type="button" className={styles.button} onClick={() => { setConfirming(""); onConfirm(); }}>{l("확인", "Confirm")}</button><button type="button" className={styles.button} onClick={() => setConfirming("")}>{l("취소", "Cancel")}</button></span>
        : btn(text, () => setConfirming(key), disabled, false, reason);
    const labelButton = (label: string, icon: ReactNode, action: () => void, disabled = false, reason?: string, extra?: { "aria-haspopup"?: "dialog"; "aria-expanded"?: boolean; "aria-controls"?: string }): ReactNode => <button type="button" className={`${styles.iconButton} ${styles.labelButton}`} title={disabled && reason ? reason : label} onClick={action} disabled={disabled} {...extra}>{icon}<span>{label}</span></button>;
    const download = async (name: string, content: string, mime: string) => {
        try {
            if (onExport) {
                const receipt = await onExport({ name, content, mime, ownerScope: workspace.ownerScope });
                setNotice(receipt.saved ? l("파일을 저장했습니다.", "File saved.") : l("파일 저장을 취소했습니다.", "File save canceled."));
                return;
            }
            const url = URL.createObjectURL(new Blob([content], { type: mime }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setNotice(l("브라우저에 다운로드를 요청했습니다.", "Download requested in the browser."));
        }
        catch {
            setNotice(l("파일을 저장하지 못했습니다. 문서는 그대로 유지됩니다.", "Could not save the file. Your document is unchanged."));
        }
    };
    const runSearch = async () => {
        if(!consentReady)return;
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        setSearching(true);
        setSearchEvidence(null);
        const base=workspace;
        try {
            const local = workspace.watchlist.filter(a => `${a.symbol} ${a.name} ${a.exchange}`.toLowerCase().includes(search.toLowerCase()));
            const evidence = onSearch ? await onSearch(search, controller.signal) : { assets: local, provider: "local", asOf: null, warnings: [] };
            if (!controller.signal.aborted && searchAbort.current===controller && latest.current.ownerScope===base.ownerScope && latest.current.revision===base.revision) {
                setSearchEvidence(evidence);
                setNotice(onSearch ? "" : l("저장한 관심 자산에서 검색했습니다. 외부 검색은 연결되지 않았습니다.", "Searched saved assets. External search is not connected."));
            }
        }
        catch (cause) {
            if (!controller.signal.aborted) {
                const reason = cause instanceof Error && /finance_[a-z0-9_]+/.test(cause.message) ? financeMessage(cause.message, ko) : l("인터넷 연결을 확인한 뒤 다시 검색하세요.", "Check your internet connection, then search again.");
                setNotice(`${l("검색하지 못했습니다.", "Couldn't search.")} ${reason} ${l("저장한 자산은 그대로입니다.", "Your saved assets are unchanged.")}`);
            }
        }
        finally {
            if (searchAbort.current === controller)
                setSearching(false);
        }
    };
    const exportReport = async () => {
        if (!report)
            return;
        try {
        const current = await store.flush();
        const exported = archivedReport ?? current.reports.find(item => item.id === report.id);
        if (!exported) throw new Error("finance_report_not_found");
        await download(`finance-report-${exported.id.replace(/[^a-zA-Z0-9_-]/g, "")}.html`, await financeReportExportHtml(exported,locale,[]), "text/html;charset=utf-8");
        } catch { setNotice(l("저장 결과를 확인한 뒤 다시 내보내세요. 파일을 만들지 않았습니다.", "Confirm the saved changes before exporting again. No file was created.")); }
    };
    const refreshData = async (auto = false) => {
        if(!consentReady)return;
        if (!onRefreshData || refreshing)
            return;
        const controller = new AbortController();
        refreshAbort.current = controller;
        setRefreshing(true);
        try {
            const response = await onRefreshData(controller.signal);
            if (controller.signal.aborted)
                return;
            if (latest.current.revision !== response.baseRevision) {
                setNotice(l("작업 상태가 바뀌어 자료 갱신을 적용하지 않았습니다. 다시 조회하세요.", "The workspace changed. Refresh again to apply data safely."));
                return;
            }
            if (response.operations?.length)
                await dispatch(response.operations, response.baseRevision);
            if (!auto) setNotice(response.message);
        }
        catch {
            if (!controller.signal.aborted)
                setNotice(l("자료를 갱신하지 못했습니다. 기존 자료는 유지됩니다.", "Could not refresh data. Existing observations are preserved."));
        }
        finally {
            if (refreshAbort.current === controller) {
                setRefreshing(false);
                refreshAbort.current = null;
            }
        }
    };
    // Prices refresh by themselves when Finance opens and when the window comes back, at most once a minute; the button stays.
    const autoRefreshedAt = useRef(0), refreshLatest = useRef(refreshData);
    refreshLatest.current = refreshData;
    useEffect(() => {
        if (!consentReady || !onRefreshData) return;
        const tick = () => { if (Date.now() - autoRefreshedAt.current < 60_000) return; autoRefreshedAt.current = Date.now(); void refreshLatest.current(true); };
        tick();
        const onFocus = () => { if (document.visibilityState === "visible") tick(); };
        window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onFocus);
        return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
    // The latest refreshData is read through a ref; re-binding the listeners on every render would refresh in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [consentReady, onRefreshData]);
    const queryData = async () => {
        if(!consentReady)return;
        const selectedAsset = workspace.watchlist.find(asset => asset.id === dataAssetId) ?? (workspace.watchlist.length === 1 ? workspace.watchlist[0] : undefined);
        if (!onQueryData || (!selectedAsset && !dataQueryText.trim() && !["social","macro_news","treasury_yields"].includes(dataMetric)))
            return;
        queryAbort.current?.abort();
        const controller = new AbortController();
        queryAbort.current = controller;
        setQuerying(true);
        setNotice('');
        try {
            const queryRequest = financeViewDataRequest({ metric: dataMetric, query: dataQueryText, asset: selectedAsset, period: dashboard?.period || "1Y", treasuryMonth });
            const result = await onQueryData(queryRequest, controller.signal);
            if (!controller.signal.aborted) {setDataResult(result);setLastDataRequest(queryRequest);}
        }
        catch {
            if (!controller.signal.aborted)
                setNotice(l("자료 조회에 실패했습니다. 저장된 자료는 변경하지 않았습니다.", "Data query failed. Saved data is unchanged."));
        }
        finally {
            if (queryAbort.current === controller)
                setQuerying(false);
        }
    };
    const persistDataResult = async (mode:"sources"|"report") => {
        if(!onQueryAndSave || !lastDataRequest || dataSaving)return;
        setDataSaving(true);
        const controller=new AbortController();
        try {
            const current=await store.flush();
            const receipt=await onQueryAndSave({...lastDataRequest,mode,expectedRevision:current.revision,title:`${lastDataRequest.query || financeStatus(lastDataRequest.metrics[0],ko)} · ${l("자료 검토","Source review")}`},controller.signal);
            setNotice(receipt.reportId?(receipt.message.includes("기존 보고서")?l("조회 자료와 출처를 기존 보고서에 추가했습니다. 본문은 그대로이며 새 근거 검토가 필요합니다.","Added the data and sources to the existing report. Its text is unchanged and needs a new review."):l("조회 자료와 출처를 보고서 초안에 저장했습니다. 요약은 아직 작성되지 않았습니다.","Saved the data and sources as a report draft. The summary has not been written yet.")):l("조회 자료와 출처를 저장했습니다.","Saved the data and sources."));
            if(receipt.reportId){setReportId(receipt.reportId);setSelectedSection("");setTab("reports");}
        }catch(cause){setNotice(cause instanceof Error?friendlyError(cause.message):l("자료를 저장하지 못했습니다. 조회 결과는 유지됩니다.","Could not save data. The query result is preserved."));}
        finally {setDataSaving(false);}
    };
    const archiveError=(cause:unknown)=>setNotice(cause instanceof Error?friendlyError(cause.message):l("보관 작업을 완료하지 못했습니다. 원본과 최신 상태를 확인하세요.","Archive operation failed. Review the original and latest state."));
    const loadArchives=async(cursor?:string)=>{
        if(!onArchives||archiveBusy)return;const epoch=archiveEpoch.current;setArchiveBusy(true);
        try{const result=await onArchives({action:"list",limit:20,...(cursor?{cursor}:{})});
            if(epoch!==archiveEpoch.current)return;
            if(result.action!=="list")throw new Error("finance_archive_response_invalid");
            setArchiveItems(previous=>cursor?[...previous,...result.items.filter(item=>!previous.some(old=>old.archiveId===item.archiveId))]:result.items);setArchiveCursor(result.nextCursor);
        }catch(cause){if(epoch===archiveEpoch.current)archiveError(cause);}finally{if(epoch===archiveEpoch.current)setArchiveBusy(false);}
    };
    const readArchive=async(request:Extract<FinanceArchiveRequest,{action:"read"}>,targetId?:string)=>{
        if(!onArchives||archiveBusy)return;const epoch=archiveEpoch.current;setArchiveBusy(true);
        try{const result=await onArchives(request);if(epoch!==archiveEpoch.current)return;
            if(result.action!=="read")throw new Error("finance_archive_response_invalid");
            setArchiveRead(result);setArchiveReportId(targetId??result.reportIds[0]??"");setArchiveRestoreIds([]);setArchiveOpen(true);setEditing(false);setSelectedSection("");setTab("reports");
        }catch(cause){if(epoch===archiveEpoch.current)archiveError(cause);}finally{if(epoch===archiveEpoch.current)setArchiveBusy(false);}
    };
    const createArchive=async()=>{
        if(!onArchives||!archivePreview||archiveBusy)return;setArchiveBusy(true);
        try{await store.flush();const result=await onArchives({action:"create",expectedRevision:archivePreview.revision,reportIds:archivePreview.reportIds});
            if(result.action!=="create")throw new Error("finance_archive_response_invalid");
            setArchivePreview(null);setArchiveSelection([]);setEditing(false);setNotice(`${l(`보고서 ${result.reclaimed.reports}개를 보관했습니다. 보관함에서 다시 열 수 있습니다.`,`Archived ${result.reclaimed.reports} report(s). You can reopen them from Archives.`)} ${result.warnings.map(w=>financeMessage(w,ko)).join(" ")}`);
        }catch(cause){archiveError(cause);}finally{setArchiveBusy(false);}
    };
    const archiveOne=async(id:string)=>{
        if(!onArchives||archiveBusy)return;setArchiveBusy(true);
        try{const current=await store.flush();const result=await onArchives({action:"create",expectedRevision:current.revision,reportIds:[id]});
            if(result.action!=="create")throw new Error("finance_archive_response_invalid");
            setReportId("");setSelectedSection("");setEditing(false);setArtifactDetail(false);setArchiveSelection(ids=>ids.filter(item=>item!==id));
            setNotice(`${l(`보고서 ${result.reclaimed.reports}개를 보관했습니다. 보관함에서 다시 열 수 있습니다.`,`Archived ${result.reclaimed.reports} report(s). You can reopen them from Archives.`)} ${result.warnings.map(w=>financeMessage(w,ko)).join(" ")}`);
        }catch(cause){archiveError(cause);}finally{setArchiveBusy(false);}
    };
    const exportArchive=async()=>{
        if(!archiveRead||archiveBusy)return;
        try{const current=await store.flush();
            if(current.ownerScope!==archiveRead.workspaceSnapshot.ownerScope)throw new Error("finance_scope_changed");
            await download(`finance-archive-${archiveRead.archiveId.replace(/[^a-zA-Z0-9_-]/g,"")}.json`,JSON.stringify({archiveId:archiveRead.archiveId,sha256:archiveRead.sha256,reportIds:archiveRead.reportIds,workspaceSnapshot:archiveRead.workspaceSnapshot},null,2),"application/json;charset=utf-8");
        }catch(cause){archiveError(cause);}
    };
    const restoreArchive=async(sourcesOnly=false)=>{
        if(!onArchives||!archiveRead||archiveBusy||(!sourcesOnly&&!archiveRestoreIds.length)||(sourcesOnly&&archiveRead.reportIds.length>0))return;setArchiveBusy(true);
        const expectedRevision=workspace.revision;
        try{await store.flush();const result=await onArchives({action:"restore",archiveId:archiveRead.archiveId,...(sourcesOnly?{}:{reportIds:archiveRestoreIds}),expectedRevision});
            if(result.action!=="restore")throw new Error("finance_archive_response_invalid");
            setArchiveOpen(false);if(sourcesOnly)setTab("sources");else setReportId(archiveRestoreIds[0]);setArchiveRestoreIds([]);setNotice(`${l(`복원했습니다: 보고서 ${result.restored.reports}개 · 자료 ${result.restored.sources}개.`,`Restored ${result.restored.reports} report(s) and ${result.restored.sources} source(s).`)} ${result.warnings.map(w=>financeMessage(w,ko)).join(" ")}`);
        }catch(cause){archiveError(cause);}finally{setArchiveBusy(false);}
    };
    const openMonitorReport = async (id:string) => {
        try {const current=await store.flush();if(current.reports.some(item=>item.id===id)){setArchiveOpen(false);setReportId(id);setSelectedSection("");setTab("reports");setEditing(false);}
          else if(onArchives)await readArchive({action:"read",reportId:id},id);
          else throw new Error("finance_report_not_found");}
        catch {setNotice(l("브리핑을 열지 못했습니다. 실행 기록은 그대로 남아 있습니다.","Could not open the briefing. Run history is unchanged."));}
    };
    const saveDataReport = async () => {
        if (!dataResult?.rows.length) return;
        const result = dataResult;
        const asset = workspace.watchlist.find(item => item.id === dataAssetId) ?? (workspace.watchlist.length === 1 ? workspace.watchlist[0] : undefined);
        if (!asset) return;
        const sources: FinanceSource[] = result.sourceUrls.map(url => ({ id: financeId("source"), name: new URL(url).hostname, kind: "provider", status: "imported", asOf: result.asOf, retrievedAt: result.retrievedAt, url, note: `${asset.symbol} · ${dataMetric}. ${result.warnings.join(" ")}` }));
        const title = `${asset.symbol} · ${l("자료 검토", "Source review")}`;
        const report: FinanceReport = { id: financeId("report"), title, createdAt: new Date().toISOString(), sourceRevision: workspace.revision, reviewPending: true, dashboardSnapshot: null, parentReportId: null, sections: [
            { id: financeId("section"), title: l("요약", "Summary"), kind: "summary", narrative: "", widget: null, projection: null },
            { id: financeId("section"), title: `${asset.symbol} · ${dataMetric}`, kind: "widget", narrative: "", widget: null, projection: { columns: result.columns, rows: result.rows, status: result.status === "ok" ? "ready" : "partial", warnings: result.warnings, asOf: result.asOf, sourceIds: sources.map(source => source.id) } },
            { id: financeId("section"), title: l("자료와 기준 시각", "Sources and timestamps"), kind: "sources", narrative: "", widget: null, projection: { columns: ["Source", "Retrieved at"], rows: result.sourceUrls.map(url => [url, result.retrievedAt]), status: "ready", warnings: [], asOf: result.asOf, sourceIds: sources.map(source => source.id) } },
        ] };
        try { await dispatch([...sources.map(source => ({ type: "source.upsert" as const, source })), { type: "report.add", report }], workspace.revision); setReportId(report.id); setTab("reports"); setNotice(l("조회한 원자료와 출처를 고정 보고서로 저장했습니다.", "Saved the retrieved data and sources as a frozen report.")); }
        catch { setNotice(l("보고서로 저장하지 못했습니다. 조회 결과는 유지됩니다.", "Could not save the report. The query result is preserved.")); }
    };
    const pinReportSection=async(section:FinanceReportSection)=>{
        if(!report||archivedReport||!section.projection)return;
        try{const base=await store.flush();const pin=financePinReportSection(base,report.id,section.id,l("대시보드","Dashboard"));
            if(pin.operations.length){await dispatch(pin.operations,base.revision);await markCustomized(pin.operations);}
            setSelected(pin.widgetId);setTab("dashboard");setEditing(false);setNotice(l("대시보드에 고정했습니다. 고정한 사본은 보고서를 고쳐도 바뀌지 않습니다.","Pinned to the dashboard. The pinned copy does not change when the report is edited."));
        }catch(cause){setNotice(cause instanceof Error?friendlyError(cause.message):l("자료를 고정하지 못했습니다.","Could not pin the observations."));}
    };
    const addWidget = (type: FinanceWidget["type"]) => { if (!dashboard)
        return; const next = createFinanceWidget(type, labels[type][ko ? 0 : 1]); void act({ type: "widget.add", dashboardId: dashboard.id, widget: next }); setSelected(next.id); };
    const importCsv = async () => {
        if (!imported || imported.errors.length)
            return;
        const saved = await act({ type: "holdings.import", assets: imported.assets, holdings: imported.holdings, quotes: imported.quotes, sources: imported.sources }, l("확인한 CSV 자료를 가져왔습니다.", "Imported the reviewed CSV data."));
        if (saved) {
            setImportOpen(false);
            setCsv("");
        }
    };
    const makeReport = async () => {
        if (!dashboard) return;
        try {
            const current = await store.flush();
            const selectedDashboard = current.dashboards.find(item => item.id === dashboard.id);
            if (!selectedDashboard) throw new Error("finance_dashboard_not_found");
            const next = createFinanceReport(current, selectedDashboard, l("포트폴리오 점검", "Portfolio review"));
            await dispatch({ type: "report.add", report: next }, current.revision);
            setReportId(next.id); setSelected(""); setSelectedSection(""); setTab("reports");
        } catch { setNotice(l("화면 변경이 저장된 뒤 보고서를 다시 만드세요.", "Create the report after the screen changes have been saved.")); }
    };
    const createDashboard = () => { const created = createFinanceDashboard(l("대시보드", "Dashboard")); void act([{ type: "dashboard.add", dashboard: created }, { type: "dashboard.select", dashboardId: created.id }]); };
    const move = (id: string, index: number) => dashboard && void act({ type: "widget.move", dashboardId: dashboard.id, widgetId: id, index });
    const updateWidget = (patch: Partial<FinanceWidget>) => dashboard && widget && void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: widget.id, patch });
    if(experienceLoading)return <main className={styles.root}><h1 className={styles.title}>Agentlas Finance</h1><p role="status">{l("이용 설정을 여는 중…","Loading usage settings…")}</p></main>;
    if(!consentReady){
        // One sentence and one button record both notices; the built-in tools start by themselves (accept prepares them, and a finished consent without them is prepared by the effect above).
        const startFailed=!!experienceError||experience?.builtins?.phase==="error";
        const acceptNotices=()=>{void updateExperience({action:"accept",version:FINANCE_NOTICE_VERSION,dataNotice:true,aiNotice:true});};
        const retryStart=()=>{if(!experience)void readExperience();else if(consentAccepted)void updateExperience({action:"plugins.prepare"});else acceptNotices();};
        return <main className={styles.root}><section className={styles.consent}><h1>Agentlas Finance</h1>
        {!consentAccepted&&<><p>{l("시세는 지연될 수 있고 AI는 틀릴 수 있으며 투자 조언이 아닙니다. 계속하면 이에 동의하고 질문이 AI에 전달되는 것을 허용합니다.","Prices may be delayed, AI can be wrong, and nothing here is investment advice; by continuing you agree and allow your questions to be sent to the AI.")}</p><FinanceUsageNotices ko={ko}/></>}
        {!startFailed&&(experiencePreparing||consentAccepted)&&<p role="status" aria-live="polite" aria-busy="true"><IconRefresh size={16}/> {l("Finance를 여는 중…","Getting Finance ready…")}</p>}
        {startFailed&&<p role="alert" className={styles.notice}>{l("Finance를 시작하지 못했습니다. 다시 시도하세요.","Couldn't start Finance. Try again.")}</p>}
        <div className={styles.actions}>{!consentAccepted&&!startFailed&&btn(l("계속","Continue"),acceptNotices,!onExperience||experiencePending)}{startFailed&&btn(l("다시 시도","Retry"),retryStart,experiencePending)}
        {experience?.monitoring.enabled&&btn(l("정기 브리핑 중지","Stop scheduled briefings"),()=>{void updateExperience({action:"monitoring",enabled:false});},!onExperience)}</div>
    </section></main>;
    }
    if (loading)
        return <main className={styles.root}><p className={styles.skeleton} role="status">{l("Agentlas Finance를 여는 중…", "Opening Agentlas Finance…")}</p></main>;
    const archivePanel=onArchives&&<div className={styles.importPanel}>
      <div className={styles.actions}>{btn(archiveOpen?l("현재 보고서로","Back to reports"):l("보관함 열기","Open archives"),()=>{setArchiveOpen(!archiveOpen);setEditing(false);if(!archiveOpen)void loadArchives();},archiveBusy)}</div>
      {!archiveOpen&&<details className={styles.sectionDetails}><summary>{l("여러 보고서 한꺼번에 보관","Archive several reports")} · {archiveSelection.length}</summary>{btn(workspace.reports.length>0&&workspace.reports.every(r=>archiveSelection.includes(r.id))?l("선택 해제","Clear selection"):l("전체 선택","Select all"),()=>setArchiveSelection(workspace.reports.length>0&&workspace.reports.every(r=>archiveSelection.includes(r.id))?[]:workspace.reports.map(r=>r.id)),archiveBusy||!workspace.reports.length)}<div className={styles.list}>{workspace.reports.map(r=><label key={r.id} className={styles.muted}><input type="checkbox" checked={archiveSelection.includes(r.id)} onChange={e=>setArchiveSelection(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title}</label>)}</div>{btn(l("선택한 보고서 보관 확인","Review selected reports"),()=>setArchivePreview({revision:workspace.revision,reportIds:archiveSelection}),archiveBusy||!archiveSelection.length,false,l("먼저 보관할 보고서를 선택하세요.","Select reports to archive first."))}</details>}
      {archiveOpen&&<><p className={styles.muted}>{l("보관한 원본은 읽기 전용입니다. 열어 봐도 되돌려지지 않습니다.","Archived originals are read-only. Opening one does not restore it.")}</p>
        {archiveItems.map(item=><div key={item.archiveId} className={styles.listItem}><strong>{item.reportTitles.join(" · ")||l("자료만 보관","Saved sources only")}</strong><p className={styles.muted}>{date(item.createdAt)} · {l("보고서","Reports")} {item.reportCount} · {l("자료","Sources")} {item.sourceCount}</p>{btn(l("원본 열기","Open original"),()=>{void readArchive({action:"read",archiveId:item.archiveId});},archiveBusy)}</div>)}
        {archiveCursor&&btn(l("이전 보관 더 보기","Load older archives"),()=>{void loadArchives(archiveCursor);},archiveBusy)}{!archiveItems.length&&!archiveBusy&&!archiveRead&&<p className={styles.muted}>{l("보관한 항목이 없습니다.","Nothing archived yet.")}</p>}{archiveRead&&!archiveItems.length&&btn(l("보관 목록 불러오기","Load archive list"),()=>{void loadArchives();},archiveBusy)}
        {archiveRead&&<div className={styles.receipt}>{archiveRead.warnings.map((warning,index)=><FinanceMessage key={index} value={warning} ko={ko} note/>)}
          <select className={styles.select} aria-label={l("보관 보고서 선택","Choose archived report")} value={archiveReportId} onChange={e=>setArchiveReportId(e.target.value)}>{!archiveRead.reportIds.length&&<option value="">{l("보고서 없음 · 자료만 보관","No report · sources only")}</option>}{archiveRead.workspaceSnapshot.reports.filter(r=>archiveRead.reportIds.includes(r.id)).map(r=><option value={r.id} key={r.id}>{financeArtifactTitle(r.title)}</option>)}</select>
          {btn(l("파일로 저장","Save as file"),()=>{void exportArchive();},archiveBusy)}
          {archiveRead.reportIds.length>0&&<details><summary>{l("보고서 복원","Restore reports")}</summary>{archiveRead.workspaceSnapshot.reports.filter(r=>archiveRead.reportIds.includes(r.id)).map(r=><label key={r.id} className={styles.label}><span><input type="checkbox" checked={archiveRestoreIds.includes(r.id)} onChange={e=>setArchiveRestoreIds(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title}</span></label>)}<p className={styles.muted}>{l("공간이 부족하거나 내용이 바뀌었으면 복원을 멈추고 원본은 그대로 둡니다.","If there is no room or the content changed, restoring stops and the original stays.")}</p>{btn(l("선택 항목 복원","Restore selection"),()=>{void restoreArchive();},archiveBusy||!archiveRestoreIds.length,false,l("복원할 보고서를 선택하세요.","Select reports to restore."))}</details>}
          <details><summary>{l("보관된 자료 보기","View archived sources")} · {archiveRead.workspaceSnapshot.sources.length}</summary><DataTable projection={{columns:[l("이름","Name"),l("관측 기준","As of"),l("가져온 시각","Retrieved at"),l("원문 주소","Source URL"),l("이용 조건·메모","Usage notes")],rows:archiveRead.workspaceSnapshot.sources.map(source=>[source.name,source.asOf,source.retrievedAt,source.url,source.note]),status:"ready",warnings:[],asOf:null,sourceIds:[]}}/>{archiveRead.workspaceSnapshot.sources.length>500&&<p className={styles.muted}>{l("처음 500개만 보입니다. 전체는 파일로 저장하세요.","Only the first 500 are shown. Save the file for all.")}</p>}</details>
          {!archiveRead.reportIds.length&&<>{btn(l("보관된 자료 복원","Restore archived sources"),()=>{void restoreArchive(true);},archiveBusy)}</>}
        </div>}
      </>}{archiveBusy&&<p role="status">{l("보관 작업 중…","Working on archives…")}</p>}
    </div>;
    const iconButton = (label: string, icon: ReactNode, action: () => void, disabled = false) => <button type="button" className={styles.iconButton} aria-label={label} title={label} onClick={action} disabled={disabled}>{icon}</button>;
    const briefingStatus=<div className={styles.briefingStatus} role="status"><strong>{l("정기 브리핑", "Scheduled briefing")}: {experience?.monitoring.enabled ? l(`켜짐 · 매일 ${experience.monitoring.localTime}`, `On · daily at ${experience.monitoring.localTime}`) : l("꺼짐", "Off")}</strong><span className={styles.muted}>{l("모니터는 각자의 일정으로 실행되고, 정기 브리핑은 하루 한 번 전체 요약을 보냅니다.", "Each monitor runs on its own schedule. The briefing sends one daily summary.")}</span>{btn(l("브리핑 설정", "Briefing settings"), () => { setSettingsCategory("monitoring"); setSettingsOpen(true); })}</div>;
    const monitorContent=<section><div className={styles.toolbar} style={{marginBottom:16}}><h2 className={styles.sectionHeading}>{l("모니터링", "Monitoring")}</h2><div className={styles.actions}>{btn(l("자동화 실행 이력", "Automation run history"), () => navigate("/automation"))}{btn(l("모니터 추가", "Add monitor"), () => { void act({ type: "monitor.upsert", monitor: { id: crypto.randomUUID(), name: l("새 점검 조건", "New check"), query: "", assetIds: [], status: "draft", lastCheckedAt: null, nextCheckAt: null, note: l("점검 초안입니다. 지금 실행하거나, 일정을 정해 자동으로 실행하세요.", "A draft check. Run it now, or schedule it to run automatically.") } }); })}</div></div><div className={styles.list}>{workspace.monitors.map(m => <article key={m.id} className={styles.listItem}><div className={styles.cardHead}><h3>{m.name}</h3><span className={styles.badge}>{financeStatus(m.status,ko)}</span></div><div className={styles.monitorOverview}><span>{m.query||l("확인할 질문을 입력하세요 (아래 설정에서)", "Add the question to check (in Settings below)")}</span>{m.nextCheckAt&&<span>{date(m.nextCheckAt)}</span>}</div><details className={styles.sectionDetails}><summary>{l("설정", "Settings")}</summary><label className={styles.label}>{l("이름", "Name")}<DraftField disabled={m.status === 'active'} value={m.name} label={l("모니터링 이름", "Monitor name")} onCommit={name => { if (name.trim())
        void act({ type: "monitor.upsert", monitor: { ...m, name } }); }}/></label><label className={styles.label}>{l("확인할 질문·조건", "Question or condition")}<DraftField disabled={m.status === 'active'} multiline value={m.query} label={l("모니터링 조건", "Monitoring condition")} onCommit={query => { void act({ type: "monitor.upsert", monitor: { ...m, query } }); }}/></label><dl className={styles.metaGrid}><div><dt>{l("마지막 확인", "Last checked")}</dt><dd>{date(m.lastCheckedAt??lastRunAt[m.id]??null)}</dd></div><div><dt>{l("다음 실행", "Next check")}</dt><dd>{date(m.nextCheckAt)}</dd></div></dl><p className={styles.muted}>{financeMonitorNote(m.note,ko)}</p>{m.status === 'active' && <p className={styles.muted}>{l("조건을 편집하려면 실행을 먼저 일시정지하세요.", "Pause execution before editing its conditions.")}</p>}<label className={styles.label}>{l("점검할 자산", "Assets to check")}<select className={styles.select} value={m.assetIds[0] || ""} disabled={m.status === 'active'} onChange={e => { void act({ type: "monitor.upsert", monitor: { ...m, assetIds: e.target.value ? [e.target.value] : [] } }); }}><option value="">{l("자산 선택", "Choose asset")}</option>{workspace.watchlist.map(a => <option value={a.id} key={a.id}>{a.symbol} · {a.exchange}</option>)}</select></label>{onScheduleMonitor && <label className={`${styles.label} ${styles.scheduleLine}`}>{l("실행 일정", "Schedule")}<select className={styles.select} value={financeMonitorScheduleValue(m,monitorSchedules)} disabled={!monitoringAllowed||m.status==='active'||scheduling===m.id} aria-label={l("실행 일정", "Execution schedule")} onChange={e=>setMonitorSchedules(current=>({...current,[m.id]:e.target.value}))}><option value="daily-09:00">{l("매일 오전 9시 · 현지 시간", "Daily at 09:00 · local time")}</option><option value="weekday-09:00">{l("평일 오전 9시 · 현지 시간", "Weekdays at 09:00 · local time")}</option><option value="hourly">{l("매시간", "Hourly")}</option><option value="every-5m">{l("5분마다 · 앱 실행 중", "Every 5 minutes · while app is running")}</option></select></label>}<div className={`${styles.actions} ${styles.mt12}`}>{onScheduleMonitor && btn(scheduling === m.id ? l("등록 중…", "Registering…") : m.status === "paused" ? l("일정 다시 시작", "Resume schedule") : l("자동화로 등록", "Schedule automation"), () => { if(!monitoringAllowed)return; setScheduling(m.id); void onScheduleMonitor(m, financeMonitorScheduleValue(m,monitorSchedules)).then(() => { setMonitorSchedules(current=>{const next={...current};delete next[m.id];return next;});setNotice(l("실행 등록 결과를 확인했습니다. 자동화 화면에서 일정과 실행 이력을 확인하세요.", "Checked the scheduling result. Review the schedule and run history in Automations.")); void store.reload(); }).catch(() => setNotice(l("자동화를 등록하지 못했습니다. 초안은 유지됩니다.", "Could not schedule automation. The draft is preserved."))).finally(() => setScheduling("")); }, !monitoringAllowed || !!scheduling || m.status === 'active' || !m.query.trim() || !financeMonitorScheduleValue(m,monitorSchedules).trim(), true, !monitoringAllowed ? l("정기 실행은 Pro 이상에서 쓸 수 있습니다. 설정에서 이용 권한을 확인하세요.", "Scheduling needs Pro or higher. Check access in Settings.") : m.status === 'active' ? l("이미 예약되어 있습니다.", "Already scheduled.") : !m.query.trim() ? l("먼저 확인할 조건을 입력하세요.", "Enter a condition first.") : undefined)}{btn(l("예약 일시정지", "Pause schedule"), () => { if (onPauseMonitor) {
        void onPauseMonitor(m).then(() => store.reload()).catch(() => setNotice(l("실행을 일시정지하지 못했습니다. 실제 상태를 다시 확인하세요.", "Could not pause execution. Check the actual run status.")));
    }
    else {
        void act({ type: "monitor.upsert", monitor: { ...m, status: "paused", nextCheckAt: null } });
    } }, m.status === 'paused' || m.status === 'draft' || (m.status === 'active' && !onPauseMonitor), false, m.status === 'active' ? l("이 앱에서는 일시정지할 수 없습니다.", "Pausing isn't available in this app.") : l("예약된 일정이 없습니다.", "No schedule to pause."))}{onOpenResearch && m.assetIds[0] && workspace.watchlist.find(a => a.id === m.assetIds[0]) && btn(l("조사 작업으로 이어가기", "Continue as a research task"), () => { const asset = workspace.watchlist.find(a => a.id === m.assetIds[0]); if (asset)
        void onOpenResearch(asset); })}<details className={styles.moreMenu}><summary>{l("더보기", "More")}</summary>{confirmBtn(`monitor:${m.id}`, l("초안 제거", "Remove draft"), () => { void act({ type: "monitor.remove", monitorId: m.id }); }, m.status === 'active', l("실행 중에는 제거할 수 없습니다. 먼저 일시정지하세요.", "An active monitor can't be removed. Pause it first."))}</details></div></details><FinanceMonitorReceipts monitor={m} ko={ko} onRun={onRunMonitor} onLoad={onMonitorRuns} onLatestRun={at=>setLastRunAt(previous=>previous[m.id]===at?previous:{...previous,[m.id]:at})} needsAsset={!m.assetIds.some(id=>workspace.watchlist.some(asset=>asset.id===id))&&workspace.watchlist.length===0} onFindAssets={()=>setChatTool("watchlist")} onOpenReport={id=>{void openMonitorReport(id);}}/></article>)}</div>{!workspace.monitors.length && <div className={styles.empty}>{l("저장된 모니터링이 없습니다. 먼저 확인할 조건을 초안으로 남길 수 있습니다.", "No monitors saved. Start by drafting the condition you want to check.")}</div>}</section>;
    const chooseCandidate=(asset:FinanceAsset)=>{setSelectedCandidate(current=>current?.asset.id===asset.id&&current.ownerScope===workspace.ownerScope&&current.revision===workspace.revision?null:{asset,ownerScope:workspace.ownerScope,revision:workspace.revision});};
    const draftAssetQuestion=(asset:FinanceAsset)=>{setSelectedCandidate({asset,ownerScope:workspace.ownerScope,revision:workspace.revision});openChatDraft(l(`${asset.name} (${asset.symbol})의 최근 실적과 주요 위험을 정리해줘`, `Summarize recent financial results and key risks for ${asset.name} (${asset.symbol}).`));};
    const assetResults=(result:FinanceSearchResult,query?:string,disabled=false)=><FinanceAssetResults result={result} query={query} ko={ko} selectedAssetId={selectedAsset?.id} watchlistIds={watchlistIds} disabled={disabled} onSelect={chooseCandidate} onWatchlist={asset=>{void act({type:"watchlist.add",asset});setSearch("");}} onResearch={draftAssetQuestion}/>;
    const dashboardHint = !dashboard ? l("먼저 대시보드를 만드세요.", "Create a dashboard first.") : !(dashboardCustomized || editing) ? l("먼저 대시보드에 블록을 추가하세요.", "Add a block to the dashboard first.") : "";
    const queryInputMissing = !dataQueryText.trim() && !dataAssetId && workspace.watchlist.length !== 1 && !["social", "macro_news", "treasury_yields"].includes(dataMetric);
    const queryReason = !onQueryData ? l("자료 조회를 지금 사용할 수 없습니다.", "Data lookup isn't available right now.") : queryInputMissing ? (globalDataMetric ? l("검색어를 입력하세요.", "Enter a search term.") : l("조회할 자산을 선택하세요.", "Choose an asset first.")) : undefined;
    return <main className={styles.root} data-testid="finance-workspace">
    <div hidden={settingsOpen}>
    <header className={styles.header}><h1 className={styles.title}>Agentlas Finance</h1><form className={styles.topSearch} onSubmit={event=>{event.preventDefault();setChatTool("watchlist");void runSearch();}}><input aria-label={l("자산 찾기","Find assets")} placeholder={l("자산 찾기 (이름 또는 티커)","Find assets (name or symbol)")} value={search} onChange={event=>setSearch(event.target.value)}/><button type="submit" disabled={searching||!search.trim()} aria-label={l("찾기","Find")} title={l("찾기","Find")}><IconSearch size={16}/></button></form><div className={styles.actions}>{saving&&<span className={styles.badge} role="status">{l("저장 중", "Saving")}</span>}{labelButton(l("CSV 가져오기", "Import CSV"),<IconFileUp size={16}/>,()=>setImportOpen(v=>!v))}{labelButton(l("실행 취소", "Undo"),<IconArrowLeft size={16}/>,()=>{void undo();},!canUndo,l("되돌릴 변경이 없습니다.","Nothing to undo."))}{labelButton(l("다시 실행", "Redo"),<span className={styles.flipIcon}><IconArrowLeft size={16}/></span>,()=>{void redo();},!canRedo,l("다시 실행할 변경이 없습니다.","Nothing to redo."))}{labelButton(l("설정","Settings"),<IconSettings size={16}/>,()=>openSettings("data"),false,undefined,{"aria-expanded":settingsOpen,"aria-controls":"finance-settings-page"})}</div></header>
    <nav className={styles.tabs} aria-label={l("Agentlas Finance 보기","Agentlas Finance views")}>
      {([['dashboard',l("대시보드","Dashboard")],['chat',l("대화","Chat")],['artifacts',l("자료함","Library")],['monitoring',l("모니터링","Monitoring")]] as const).map(([id,label])=><button className={styles.tab} key={id} type="button" aria-current={view===id?"page":undefined} onClick={()=>{setView(id);if(id==="dashboard")setArtifactTab("dashboard");if(id==="artifacts"){setArtifactTab("reports");setArtifactDetail(false);setEditing(false);}}}>{label}</button>)}
    </nav>
    {view==="artifacts"&&!artifactDetail&&<FinanceArtifactGallery reports={workspace.reports} ko={ko} onStart={()=>setView("chat")} onOpen={(id,sectionId)=>{setReportId(id);setSelectedSection(sectionId??"");setArchiveOpen(false);setEditing(false);setArtifactTab("reports");setArtifactDetail(true);}}/>}
    {view==="chat"&&workChat}
    {view==="monitoring"&&<>{briefingStatus}{monitorContent}</>}


    {(workspace.reports.length >= FINANCE_WORKSPACE_LIMITS.reports * 0.8 || workspace.sources.length >= FINANCE_WORKSPACE_LIMITS.sources * 0.8) && <div className={styles.capacityBanner} role="status"><span>{l(`저장 공간이 거의 찼습니다 (보고서 ${workspace.reports.length}/${FINANCE_WORKSPACE_LIMITS.reports} · 자료 ${workspace.sources.length}/${FINANCE_WORKSPACE_LIMITS.sources}).`,`Storage is almost full (reports ${workspace.reports.length}/${FINANCE_WORKSPACE_LIMITS.reports} · sources ${workspace.sources.length}/${FINANCE_WORKSPACE_LIMITS.sources}).`)}</span>{btn(l("보관함 열기","Open archives"),()=>{setView("artifacts");setArtifactDetail(false);setEditing(false);})}<details className={styles.cardDetails}><summary>{l("자세히","Details")}</summary><p className={styles.muted}>{l("기존 자료는 자동으로 지우지 않습니다. 필요한 보고서는 내보낸 뒤 보관하세요.","Nothing is deleted automatically. Export what you need, then archive the rest.")}</p></details></div>}
    {experienceError&&!settingsOpen&&<p className={styles.notice} role="alert">{experienceError}</p>}
    {(notice || error) && <div className={`${styles.notice} ${error ? styles.error : ""}`} role="status">{error ? <FinanceMessage value={friendlyError(error)} ko={ko} error/> : notice}</div>}
    {archivePreview&&<section className={styles.importPanel} aria-label={l("보관 전 확인","Review before archiving")}><h2>{l("선택한 보고서를 보관할까요?","Archive the selected reports?")}</h2><p>{l(`보고서 ${archiveCounts.reports}개를 보관합니다. 원본은 보관함에 남고 목록에서는 사라집니다.`,`${archiveCounts.reports} report(s) will be archived. The originals stay in Archives and leave your lists.`)}</p>{archiveCounts.reclaimable.length>0&&<details><summary>{l(`함께 정리되는 자료 ${archiveCounts.reclaimable.length}개`,`${archiveCounts.reclaimable.length} source(s) cleaned up too`)}</summary><ul>{archiveCounts.reclaimable.map(source=><li key={source.id}>{source.name}</li>)}</ul></details>}{archivePreview.revision!==workspace.revision&&<p role="alert">{l("작업 공간이 바뀌었습니다. 취소한 뒤 다시 선택하세요.","The workspace changed. Cancel and select again.")}</p>}<div className={styles.actions}>{btn(l("보관하기","Archive"),()=>{void createArchive();},archiveBusy||archivePreview.revision!==workspace.revision||(!archiveCounts.reports&&!archiveCounts.reclaimable.length))}{btn(l("취소","Cancel"),()=>setArchivePreview(null),archiveBusy)}</div></section>}
    {importOpen && <section className={styles.importPanel} aria-label={l("CSV 가져오기", "CSV import")}><div className={styles.cardHead}><h2 className={styles.sectionHeading}>{l("내 자료로 시작하기", "Start with your data")}</h2>{iconButton(l("닫기", "Close"),<IconClose size={18}/>, () => setImportOpen(false))}</div><p className={styles.muted}>{l("가져오기 전에 내용을 먼저 확인합니다.", "You review the data before it is imported.")}</p><details className={styles.cardDetails}><summary>{l("자세히", "Details")}</summary><p className={styles.muted}>{l("빠진 통화·수량·가격은 임의로 채우지 않습니다.", "Missing currencies, quantities and prices are never filled in.")}</p></details><div className={styles.actions}><label className={styles.label}>{l("CSV 파일", "CSV file")}<input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; if (!file)
        return; if (file.size > 8 * 1024 * 1024) {
        setNotice(l("8MB 이하 CSV 파일을 선택하세요.", "Choose a CSV file up to 8MB."));
        return;
    } setCsvName(file.name); setCsv(await file.text()); }}/></label><label className={styles.label}>{l("통화가 없는 행의 통화", "Currency for rows without a currency")}<select className={styles.select} value={defaultCurrency} onChange={e => setDefaultCurrency(e.target.value)}><option value="">{l("파일에 명시된 통화만", "Only explicit file currencies")}</option>{["KRW", "USD", "EUR", "JPY", "GBP"].map(c => <option key={c}>{c}</option>)}</select></label></div><details><summary className={styles.muted}>{l("CSV 내용을 붙여넣기", "Paste CSV content")}</summary><textarea className={`${styles.input} ${styles.textarea}`} aria-label="CSV" value={csv} onChange={e => setCsv(e.target.value)} placeholder="symbol,name,quantity,averageCost,currency"/></details>{imported && <div className={styles.importPreview}><strong>{csvName || l("붙여넣은 자료", "Pasted data")} · {imported.rowCount} {l("행", "rows")}</strong><p className={styles.muted}>{imported.assets.length} {l("자산", "assets")} · {imported.holdings.length} {l("보유 항목", "holdings")} · {imported.quotes.length} {l("가격 관측", "price observations")}</p>{imported.assets.length > 0 && <DataTable projection={{ columns: [l("자산", "Asset"), l("이름", "Name"), l("통화", "Currency"), l("수량", "Quantity"), l("가격", "Price")], rows: imported.assets.slice(0, 20).map(a => [a.symbol, a.name, a.currency, imported.holdings.find(h => h.assetId === a.id)?.quantity ?? null, imported.quotes.find(q => q.assetId === a.id)?.price ?? null]), status: "partial", warnings: [], asOf: null, sourceIds: [] }}/>}{imported.assets.length > 20 && <p className={styles.muted}>{l("처음 20개 자산 미리보기", "Previewing the first 20 assets")}</p>}{imported.errors.map((v, i) => <FinanceMessage key={i} value={v} ko={ko} error/>)}{imported.warnings.map((v, i) => <FinanceMessage key={i} value={v} ko={ko} note/>)}{btn(l("확인한 자료 가져오기", "Import reviewed data"), () => { void importCsv(); }, saving || imported.errors.length > 0 || imported.rowCount === 0, true)}</div>}</section>}

    {view === "dashboard" && <FinanceMarketOverview feeds={onDashboardFeeds?<FinanceDashboardFeed result={feeds} loading={feedsLoading} ko={ko} onRefresh={()=>{void refreshFeeds();}} onSettings={()=>openSettings("data")}/>:null} result={markets} loading={marketsLoading} ko={ko} watchlist={workspace.watchlist} quotes={workspace.quotes} sources={workspace.sources} onFind={()=>{setChatTool("watchlist");}} onRetry={()=>{void refreshMarkets();}} onAsset={asset=>{setDataAssetId(asset.id);setChatTool("sources");}} worldMap={!dashboardCustomized&&!editing?<FinanceWorldMap result={markets} loading={marketsLoading} onRefresh={()=>{void refreshMarkets();}} ko={ko}/>:null} composer={null}><FinancePortfolioPanel workspace={workspace} ko={ko} onPlanning={onPlanning} onImport={onPortfolio?()=>openPortfolio():undefined} onPlan={openChatDraft}/><div className={styles.toolbar}><div className={styles.actions}>{labelButton(l("AI로 구성","Build with AI"),<IconSparkles size={16}/>,()=>{openChatDraft(l("대시보드를 내 자료에 맞게 구성해줘","Build a dashboard from my saved data"));})}{(dashboardCustomized||editing)&&<select className={styles.select} aria-label={l("대시보드 기간", "Dashboard period")} title={dashboardHint||undefined} value={dashboard?.period??"1Y"} disabled={!dashboard||!(dashboardCustomized||editing)} onChange={e => { if (dashboard) void act({ type: "dashboard.update", dashboardId: dashboard.id, patch: { period: e.target.value as FinanceWidget["period"] } }); }}>{periods.map(p => <option key={p}>{p}</option>)}</select>}{(dashboardCustomized||editing)&&onRefreshData && labelButton(refreshing ? l("갱신 중…", "Refreshing…") : l("자료 갱신", "Refresh data"), <IconRefresh size={16}/>, () => { void refreshData(); }, refreshing||!dashboard||!(dashboardCustomized||editing), dashboardHint)}{labelButton(editing ? l("편집 완료", "Done editing") : l("화면 편집", "Edit view"), <IconEdit size={16}/>, () => setEditing(v => !v), !dashboard, dashboardHint)}{(dashboardCustomized||editing)&&labelButton(l("보고서 만들기", "Create report"),<IconFileText size={16}/>, makeReport, !dashboard||!(dashboardCustomized||editing), dashboardHint)}</div>{dashboardHint&&(dashboardCustomized||editing)&&<p className={styles.hint} role="status">{dashboardHint}</p>}</div>{!(dashboardCustomized||editing)&&workspace.holdings.length===0&&<section className={styles.firstStep} aria-label={l("시작하기","Get started")}><h2 className={styles.sectionHeading}>{dashboard?l("먼저 보유 자산을 추가하세요","Start by adding your holdings"):l("먼저 대시보드를 만드세요","Start by creating a dashboard")}</h2><p className={styles.muted}>{l("자산을 추가하면 대시보드가 채워집니다.","Your dashboard fills in once you add assets.")}</p><div className={styles.actions}>{dashboard?btn(l("보유 자산 추가","Add holdings"),()=>{if(onPortfolio)openPortfolio();else setImportOpen(true);},false,true):btn(l("대시보드 만들기","Create a dashboard"),createDashboard,saving,true)}<button type="button" className={`${styles.button} ${styles.quiet}`} onClick={()=>setChatTool("watchlist")}>{l("자산 찾기","Find assets")}</button><button type="button" className={`${styles.button} ${styles.quiet}`} onClick={()=>setImportOpen(true)}>{l("CSV로 가져오기","Import CSV")}</button></div></section>}{dashboard && (dashboardCustomized||editing) && <div className={`${styles.workspace} ${editing && widget ? styles.withInspector : ""}`}><div className={styles.canvas}><div className={styles.grid}>{dashboard.widgets.map((w, index) => { const effective = effectiveFinanceWidget(dashboard, w); const projection = projectFinanceWidget(workspace, effective); const savedEvidence=parseFinanceEvidenceMetric(w.metric); const computeSection=savedEvidence?workspace.reports.find(item=>item.id===savedEvidence.reportId)?.sections.find(section=>section.id===savedEvidence.sectionId):undefined; const composition=computeSection&&w.chartType!=="table"?financeReportCompositionSpec({...computeSection,projection},locale):null; const displayTitle=(computeSection&&financeReportCompositionTitle(computeSection,locale))??(savedEvidence?financeCompactTreasuryTitle(w.title,projection,savedSeries[w.id]):w.title); if (w.hidden || w.type==="sources")
        return null; return <section className={`${styles.card} ${w.width === "full" ? styles.wide : ""} ${selected === w.id ? styles.selected : ""}`} key={w.id} aria-label={displayTitle}><div className={styles.cardHead}><button type="button" className={styles.cardTitle} onClick={() => { setSelected(w.id); setEditing(true); }}>{displayTitle}</button></div>{composition?<ChartBlock code={JSON.stringify(composition)} presetSpec={composition} blockId={`finance-pinned-composition:${w.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p>{l("차트를 표시하지 못했습니다.","Chart unavailable.")}</p>}/>:computeSection&&financeComputeKind(computeSection)?<FinanceComputeView section={{...computeSection,projection}} ko={ko} compact showVisual={w.chartType!=="table"}/>:savedEvidence?<FinanceDataResultView result={financeFrozenDataResult(projection,workspace.sources)} locale={ko?"ko":"en"} title={displayTitle} compact showVisual={w.chartType!=="table"} chartType={w.chartType} selectedSeries={savedSeries[w.id]} onSeriesChange={series=>setSavedSeries(current=>({...current,[w.id]:series}))}/>:<Projection widget={effective} projection={projection} ko={ko} compact/>}{editing && <div className={styles.cardControls}>{btn(l("위로", "Up"), () => move(w.id, index - 1), index === 0)}{btn(l("아래로", "Down"), () => move(w.id, index + 1), index === dashboard.widgets.length - 1)}{btn(w.width === "full" ? l("반 너비", "Half width") : l("전체 너비", "Full width"), () => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { width: w.width === "full" ? "half" : "full" } }); })}{btn(l("숨기기", "Hide"), () => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { hidden: true } }); })}</div>}</section>; })}</div>{editing && <div className={`${styles.actions} ${styles.mt18}`}>{dashboard.widgets.filter(w => w.hidden&&w.type!=="sources").map(w => <button type="button" className={styles.button} key={w.id} onClick={() => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { hidden: false } }); }}>{l("복원", "Restore")}: {w.title}</button>)}{types.map(type => <button type="button" className={styles.button} key={type} onClick={() => addWidget(type)}>+ {labels[type][ko ? 0 : 1]}</button>)}</div>}{!dashboard.widgets.some(w => !w.hidden&&w.type!=="sources") && <div className={styles.empty}>{l("화면 편집에서 첫 블록을 추가하세요.", "Add your first block in Edit view.")}</div>}</div>{editing && widget && <aside className={styles.inspector}><div className={styles.cardHead}><h3>{l("블록 설정", "Block settings")}</h3>{btn(l("닫기", "Close"), () => setSelected(""))}</div><label className={styles.label}>{l("제목", "Title")}<DraftField value={widget.title} label={l("블록 제목", "Block title")} onCommit={title => updateWidget({ title })}/></label>{widget.type === 'chart' && !parseFinanceEvidenceMetric(widget.metric) && <><label className={styles.muted}><input type="checkbox" checked={widget.periodMode === "pinned"} onChange={e => updateWidget({ periodMode: e.target.checked ? "pinned" : "inherit", period: effectiveFinanceWidget(dashboard, widget).period })}/>{l(" 이 블록 기간 고정", " Pin this block period")}</label><label className={styles.label}>{l("기간 · 이 블록", "Period · this block")}<select className={styles.select} value={widget.period} onChange={e => updateWidget({ period: e.target.value as FinanceWidget["period"], periodMode: "pinned" })}>{periods.map(p => <option key={p}>{p}</option>)}</select></label></>}{["chart", "comparison", "allocation"].includes(widget.type) && <label className={styles.label}>{l("표현", "Display")}<select className={styles.select} value={compositionWidget&&widget.chartType!=="table"?"bar":widget.chartType} onChange={e => updateWidget({ chartType: e.target.value as FinanceWidget["chartType"] })}>{(compositionWidget?["table","bar"]:["table","line","bar"]).map(p => <option key={p} value={p}>{compositionWidget?(p==="bar"?l("도넛","Donut"):l("표","Table")):p}</option>)}</select></label>}{!parseFinanceEvidenceMetric(widget.metric) && !["sources", "notes", "events"].includes(widget.type) && <fieldset className={styles.plainFieldset}><legend className={styles.muted}>{l("자산 · 비워두면 전체", "Assets · empty means all")}</legend>{workspace.watchlist.map(a => <label key={a.id} className={styles.muted}><input type="checkbox" checked={widget.assetIds.includes(a.id)} onChange={e => updateWidget({ assetIds: e.target.checked ? [...widget.assetIds, a.id] : widget.assetIds.filter(id => id !== a.id) })}/> {a.symbol} · {a.exchange}</label>)}</fieldset>}<label className={styles.label}>{l("메모", "Notes")}<DraftField multiline value={widget.notes} label={l("블록 메모", "Block notes")} onCommit={notes => updateWidget({ notes })}/></label>{parseFinanceEvidenceMetric(widget.metric)&&<><p className={styles.muted}>{l("고정한 사본은 보고서를 고쳐도 바뀌지 않습니다. 고정 해제는 이 블록만 지우고 원본 보고서는 그대로 둡니다.","The pinned copy does not change when the report is edited. Unpinning removes only this block; the report stays.")}</p>{confirmBtn(`unpin:${widget.id}`,l("고정 해제","Unpin"),()=>{void act({type:"widget.remove",dashboardId:dashboard.id,widgetId:widget.id}).then(saved=>{if(saved)setSelected("");});},saving,undefined,l("이 블록을 고정 해제할까요?","Unpin this block?"))}</>}<p className={styles.muted}>{l("이 블록의 조건만 변경합니다. 다른 블록과 보고서의 고정 자료는 유지됩니다.", "Changes affect this block. Other blocks and frozen reports are preserved.")}</p></aside>}</div>}</FinanceMarketOverview>}
    {chatTool === "watchlist" && <dialog key="watchlist" ref={toolDialog} className={`${styles.toolsPanel} ${styles.toolsDialog}`} aria-label={l("자산 찾기","Find assets")} onCancel={event=>{event.preventDefault();setChatTool(null);}} onClick={event=>{if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)setChatTool(null);}}><div className={styles.toolsHead}>{iconButton(l("닫기","Close"),<IconClose size={18}/>,()=>setChatTool(null))}</div><h2 className={styles.sectionHeading}>{l("자산 찾기", "Find assets")}</h2><form className={styles.search} onSubmit={e => { e.preventDefault(); void runSearch(); }}><input className={styles.input} aria-label={l("자산 이름 또는 티커", "Asset name or symbol")} placeholder={l("회사명 또는 티커 검색", "Search a name or symbol")} value={search} onChange={e => setSearch(e.target.value)}/><button className={`${styles.button} ${styles.primary}`} disabled={searching || !search.trim()}>{searching ? l("검색 중…", "Searching…") : l("찾기", "Search")}</button></form>{searchEvidence&&assetResults(searchEvidence)}{workspace.watchlist.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr>{[l("자산", "Asset"), l("거래소 · 통화", "Exchange · currency"), l("보유", "Holding"), l("작업", "Actions")].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{workspace.watchlist.map(a => <tr key={a.id}><td className={styles.assetIdentity}><strong>{a.symbol}</strong><span className={styles.cellName} title={a.name}>{a.name}</span></td><td>{a.exchange || "—"} · {a.currency === "XXX" ? l("통화 미확인", "Currency unknown") : a.currency}</td><td>{workspace.holdings.filter(h => h.assetId === a.id).reduce((sum, h) => sum + h.quantity, 0).toLocaleString()}</td><td><div className={styles.actions}>{onOpenResearch && btn(l("조사 이어가기", "Continue research"), () => { void Promise.resolve(onOpenResearch(a)).catch(() => setNotice(l("조사 작업을 열지 못했습니다.", "Could not open the research task."))); })}{confirmBtn(`watch:${a.id}`, l("제거", "Remove"), () => { void act({ type: "watchlist.remove", assetId: a.id }); }, workspace.holdings.some(h => h.assetId === a.id), l("보유 자산이 있어 제거할 수 없습니다.", "It has holdings, so it can't be removed."))}</div></td></tr>)}</tbody></table></div> : !searchEvidence?.assets?.length && <div className={styles.empty}>{l("검색하거나 CSV를 가져와 관심 자산을 추가하세요.", "Search or import a CSV to add your assets.")}</div>}</dialog>}
    {view==="artifacts" && artifactDetail && <section><div className={styles.toolbar}>{labelButton(l("자료함으로 돌아가기","Back to library"),<IconChevronLeft size={16}/>,()=>{setArtifactDetail(false);setEditing(false);})}<div className={styles.actions}><select className={`${styles.select} ${styles.reportPicker}`} aria-label={l("보고서 선택", "Choose report")} value={archiveOpen?"":report?.id || ""} disabled={archiveOpen} onChange={e => setReportId(e.target.value)}>{!workspace.reports.length && <option value="">{l("저장된 보고서 없음", "No saved reports")}</option>}{workspace.reports.map(r => <option value={r.id} key={r.id}>{financeArtifactTitle(r.title)}</option>)}</select>{!archiveOpen&&labelButton(l("새 보고서", "New report"),<IconFileText size={16}/>, makeReport, !dashboard, l("먼저 대시보드를 만드세요.", "Create a dashboard first."))}</div>{report && <div className={styles.actions}>{!archivedReport&&labelButton(editing ? l("편집 완료", "Done editing") : l("보고서 편집", "Edit report"),editing?<IconCheck size={16}/>:<IconEdit size={16}/>, () => setEditing(v => !v))}{labelButton(l("내보내기", "Export"),<IconDownload size={16}/>, exportReport)}{!archivedReport&&onArchives&&confirmBtn(`archive:${report.id}`, l("보관", "Archive"), () => { void archiveOne(report.id); }, archiveBusy, undefined, l("이 보고서를 보관할까요?", "Archive this report?"))}</div>}</div>{report ? !reportEditing ? <FinanceReportView report={report} locale={locale}/> : <article className={styles.report}><div className={styles.eyebrow}>{archivedReport?l("보관 원본 · 읽기 전용","Archived original · read only"):l("보고서", "Report")}</div>{reportEditing ? <label className={styles.label}>{l("보고서 제목", "Report title")}<DraftField value={report.title} label={l("보고서 제목", "Report title")} onCommit={title => { if (title.trim())
        void act({ type: "report.update", reportId: report.id, patch: { title } }); }}/></label> : <h2 className={styles.reportTitle}>{financeArtifactTitle(report.title)}</h2>}{reportEditing&&<details className={styles.sectionDetails}><summary>{l("보고서 정보", "Report information")}{report.reviewPending?` · ${l("검토 필요", "Review needed")}`:""}</summary><p className={styles.muted}>{date(report.createdAt)} · {l("대시보드를 바꿔도 이 보고서는 바뀌지 않습니다", "Dashboard edits do not change this report")}</p>{report.reviewPending && <div className={styles.notice}>{l("서술 검토가 필요한 초안입니다. 숫자·조건·근거와 문장이 일치하는지 확인하세요.", "This draft needs narrative review. Check that its text matches the figures, conditions and evidence.")}{!archivedReport&&btn(l("문장 검토 완료 표시", "Mark narrative reviewed"), () => { void act({ type: "report.update", reportId: report.id, patch: { reviewPending: false } }, l("사용자 검토 표시를 저장했습니다. 자동 사실 검증 결과가 아닙니다.", "Saved your review mark. This is not an automated fact check.")); })}</div>}<div className={styles.actions}>{!archivedReport&&(report.dashboardSnapshot ? btn(l("새 자료로 별도 버전 만들기", "Create a refreshed version"), () => { void dispatch({ type: "report.refresh", reportId: report.id }).then(saved => { setReportId(saved.reports[saved.reports.length - 1].id); setNotice(l("기존 문장과 보고서를 보존하고 새 버전을 만들었습니다.", "Preserved the original report and text in a new version.")); }).catch(() => setNotice(l("보고서를 갱신하지 못했습니다.", "Could not refresh the report."))); }) : btn(l("원자료를 다시 조회", "Retrieve source data again"), () => { setDataResult(null); setTab("sources"); }))}</div></details>}{report.sections.map((section, index) => {if(!reportEditing&&(financeReportMetadataOnly(section)||(report.sections.some(item=>!!financeComputeKind(item))&&section.kind==="sources")))return null;const sectionContent=<section id={`finance-report-section-${section.id}`} className={`${styles.reportSection} ${selectedSection === section.id ? styles.selected : ""}`} key={section.id} onClick={() => setSelectedSection(section.id)}><div className={styles.cardHead}>{reportEditing ? <DraftField value={financeStatus(section.title,ko)} label={l("섹션 제목", "Section title")} onCommit={title => { if (title.trim())
        void act({ type: "report.section.update", reportId: report.id, sectionId: section.id, patch: { title } }); }}/> : <h3>{financeArtifactTitle(financeStoredText(financeStatus(section.title,ko),ko))}</h3>}{reportEditing&&<span className={styles.badge}>{section.projection ? l("고정 관측", "Frozen data") : l("서술", "Narrative")}</span>}</div>{reportEditing ? <DraftField multiline value={financeStoredText(section.narrative,ko)} label={l("섹션 본문", "Section narrative")} onCommit={narrative => { void act({ type: "report.section.update", reportId: report.id, sectionId: section.id, patch: { narrative } }); }}/> : section.narrative ? <FinanceBriefText value={financeStoredText(section.narrative,ko)} ko={ko}/> : section.kind === 'summary' ? <p className={styles.muted}>{l("문서 편집에서 핵심 판단과 확인할 가정을 작성하세요.", "Write your conclusions and assumptions in Edit document.")}</p> : null}{section.projection && <>{reportEditing&&<>{btn(l("대시보드에 고정","Pin to dashboard"),()=>{void pinReportSection(section);},saving)}<span className={styles.hint}>{l("고정한 사본은 보고서를 고쳐도 바뀌지 않습니다.","The pinned copy does not change when this report is edited.")}</span></>}{financeComputeKind(section)||financeComputeMetrics(section)?<FinanceComputeView section={section} ko={ko}/>:section.widget&&!parseFinanceEvidenceMetric(section.widget.metric)?<Projection widget={section.widget} projection={section.projection} ko={ko} inspect={reportEditing}/>:<FinanceDataResultView key={`${report.id}:${section.id}`} result={financeFrozenDataResult(section.projection, archivedReport ? archiveRead!.workspaceSnapshot.sources : workspace.sources)} locale={ko?"ko":"en"} compact showVisual={section.widget?.chartType!=="table"} chartType={section.widget?.chartType}/>}</>}{reportEditing && <div className={styles.cardControls}>{btn(l("위로", "Up"), () => { void act({ type: "report.section.move", reportId: report.id, sectionId: section.id, index: index - 1 }); }, index === 0)}{btn(l("아래로", "Down"), () => { void act({ type: "report.section.move", reportId: report.id, sectionId: section.id, index: index + 1 }); }, index === report.sections.length - 1)}{confirmBtn(`section:${section.id}`, l("섹션 삭제", "Delete section"), () => { void act({ type: "report.section.remove", reportId: report.id, sectionId: section.id }); })}</div>}</section>;return sectionContent;})}</article> : <div className={styles.empty}>{l("대시보드로 보고서를 만들어 보세요.", "Create a report from your dashboard.")}</div>}</section>}
    {view==="artifacts"&&onArchives&&<details className={styles.sectionDetails} open={archiveOpen||undefined}><summary>{l("보관함","Archives")}</summary>{archivePanel}{!artifactDetail&&archiveRead&&btn(l("선택한 보관 문서 열기","Open selected archived report"),()=>setArtifactDetail(true))}</details>}
    {chatTool === "sources" && <dialog key="sources" ref={toolDialog} className={`${styles.toolsPanel} ${styles.toolsDialog}`} aria-label={l("자료 조회","Query data")} onCancel={event=>{event.preventDefault();setChatTool(null);}} onClick={event=>{if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)setChatTool(null);}}><div className={`${styles.toolsHead} ${styles.queryHead}`}><h2 className={styles.sectionHeading}>{l("자료 조회","Query data")}</h2>{iconButton(l("닫기","Close"),<IconClose size={18}/>,()=>setChatTool(null))}</div><div className={styles.queryBody}>{globalDataMetric&&<label className={styles.label}>{l("검색어 · 계정","Query or author")}<input className={styles.input} value={dataQueryText} onChange={e=>setDataQueryText(e.target.value)} placeholder={l("예: @federalreserve.gov 또는 조사 키워드","e.g. @federalreserve.gov or research keyword")}/></label>}<form onSubmit={e => { e.preventDefault(); void queryData(); }}>{!globalDataMetric&&<label className={styles.label}>{l("자산", "Asset")}<select className={styles.select} value={dataAssetId || (workspace.watchlist.length === 1 ? workspace.watchlist[0].id : "")} onChange={e => { queryAbort.current?.abort(); setQuerying(false); setDataResult(null); setDataAssetId(e.target.value); }}><option value="">{l("관심 자산을 선택하세요", "Choose a saved asset")}</option>{workspace.watchlist.map(asset => <option key={asset.id} value={asset.id}>{asset.symbol} · {asset.name} · {asset.exchange}</option>)}</select></label>}{dataMetric==="treasury_yields"&&<label className={styles.label}>{l("조회 월","Month")}<input type="month" className={styles.input} min="2000-01" max="2099-12" value={treasuryMonth} onChange={e=>{queryAbort.current?.abort();setQuerying(false);setDataResult(null);setTreasuryMonth(e.target.value);}}/></label>}<div className={`${styles.actions} ${styles.mt12}`}><select className={styles.select} value={dataMetric} onChange={e => { queryAbort.current?.abort(); setQuerying(false); setDataResult(null); setDataQueryText(""); setDataMetric(e.target.value); }} aria-label={l("자료 종류", "Data category")}>{[["price", l("가격", "Prices")], ["price_history", l("가격 이력", "Price history")], ["news", l("뉴스", "News")], ["filings", l("공시", "Filings")], ["social", l("공식 계정 글", "Author posts")], ["social_search",l("SNS 키워드 검색","Social keyword search")], ["company_facts",l("기업 재무","Company facts")], ["macro_news",l("거시 뉴스","Macro news")], ["treasury_yields",l("국채 수익률","Treasury yields")], ["etf_holdings", l("ETF 편입", "ETF holdings")],["nav",l("펀드 NAV","Fund NAV")]].map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select><button type="submit" className={`${styles.button} ${styles.primary}`} title={queryReason} disabled={!!queryReason || querying || dataSaving}>{querying ? l("조회 중…", "Querying…") : l("자료 조회", "Retrieve data")}</button>{queryReason&&!querying&&<span className={styles.hint}>{queryReason}</span>}{querying && btn(l("중지", "Stop"), () => { queryAbort.current?.abort(); setQuerying(false); })}</div></form>{dataResult && <div className={styles.importPreview}>{dataResult.rows.length>0&&btn(onQueryAndSave?l("다시 조회해 저장","Retrieve again and save"):l("저장","Save"),()=>{void (onQueryAndSave?persistDataResult("report"):saveDataReport());},dataSaving||querying)}<FinanceDataResultView key={`${lastDataRequest?.metrics[0]}:${dataResult.retrievedAt}`} result={dataResult} metric={lastDataRequest?.metrics[0]} locale={ko?"ko":"en"} compact onRetry={()=>{void queryData();}}/></div>}</div></dialog>}
    {portfolioOpen&&onPortfolio&&<FinancePortfolioImport key={workspace.ownerScope??"local"} ko={ko} locale={locale} revision={workspace.revision} initialFiles={portfolioFiles} onPortfolio={onPortfolio} onClose={()=>{setPortfolioOpen(false);setPortfolioFiles([]);}} onSaved={message=>setNotice(message)}/>}
    </div>
    <FinanceSettingsDialog open={settingsOpen} ko={ko} state={experience} pending={experiencePending} error={experienceError} onClose={closeSettings} onChange={updateExperience} onOpenMonitoring={()=>{setSettingsOpen(false);setView("monitoring");}} initialCategory={settingsCategory} onCategoryChange={setSettingsCategory} analystContent={<FinanceAnalysts key={JSON.stringify(workspace.ownerScope)} items={analysts} loading={analystsLoading} pending={analystsPending} error={onAnalysts?analystsError:l("이 앱에서는 Analyst를 사용할 수 없습니다.","Analysts are unavailable in this app.")} available={!!onAnalysts} ko={ko} onRefresh={()=>void refreshAnalysts()} onCoCreate={beginAnalystAuthoring} onSave={(draft,id,expectedRevision)=>changeAnalyst({action:"save",draft,...(id?{id,expectedRevision}:{})})} onRemove={item=>changeAnalyst({action:"remove",id:item.id,expectedRevision:item.revision})}/>} dataConnections={<FinanceDataConnections ko={ko}/>}/>
  </main>;
}
