"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { IconRefresh, IconEdit, IconFileUp, IconPaperclip, IconArrowLeft, IconArrowUp } from "@/components/Icon";
import { IconSearch, IconClose, IconDownload, IconFileText, IconSparkles, IconCheck } from "@/components/Icon";
import { ChartBlock } from "@/components/ChartBlock";
import { useFinanceStore } from "@/lib/finance-store";
import { FINANCE_WORKSPACE_LIMITS, financeEvidenceMetric, parseFinanceEvidenceMetric, createFinanceDashboard, createFinanceReport, createFinanceWidget, exportFinanceCsv, importFinanceCsv, projectFinanceWidget, effectiveFinanceWidget, financeId, type FinanceArchiveRequest, type FinanceArchiveResult, type FinanceArchiveItem, type FinanceMonitorRunsResult, type FinanceAsset, type FinanceReport, type FinanceReportSection, type FinanceSource, type FinanceOperation, type FinanceWidget, type FinanceMonitor, type FinanceMonitorRun, type FinanceAIResult, type FinanceSearchResult, type FinanceDataRequest, type FinanceDataResult, type FinanceWidgetProjection, type FinanceWorkspace as Workspace, } from "@shared/finance";
import styles from "./FinanceWorkspace.module.css";
import { financeReportCompositionSpec, financeReportCompositionTitle } from "@shared/finance-report-presentation";
import { FinanceAssetResults, FinanceSelectedAsset } from "./FinanceAssetResults";
import { FinanceDataResultView, financeMetricForColumns, financeCompactTreasuryTitle } from "./FinanceDataResultView";
import { FinanceDataConnections } from "./FinanceDataConnections";
import { FinanceMonitorReceipts, FinanceBriefText } from "./FinanceMonitorReceipts";
import { FinanceSettingsDialog, FinanceUsageNotices, type FinanceSettingsCategory } from "./FinanceSettingsDialog";
import { FinanceArtifactGallery, FinanceArtifactChartViewer, financeArtifactTitle, type FinanceArtifactCard } from "./FinanceArtifactGallery";
import { FinanceComputeView, financeComputeKind, financeComputeMetrics } from "./FinanceComputeView";
import { FinanceReportView, financeReportExportHtml } from "./FinanceReportView";
import { FinanceDashboardFeed } from "./FinanceDashboardFeed";
import type { FinanceDashboardFeedsResult } from "@shared/finance-feeds";
import type { FinanceAnalyst, FinanceAnalystDraft, FinanceAnalystRef, FinanceAnalystRequest, FinanceAnalystResult } from "@shared/finance-analysts";
import { FinanceAnalysts, FinanceAnalystComposer, FinanceAnalystDraftEditor, financeAnalystPinsCurrent } from "./FinanceAnalysts";
import { FinancePortfolioImport } from "./FinancePortfolioImport";
import { FinancePortfolioPanel } from "./FinancePortfolioPanel";
import type { FinancePlanningRequest, FinancePlanningResult } from "@shared/finance-planning";
import type { FinancePortfolioRequest, FinancePortfolioResult } from "@shared/finance-portfolio";
import { FinanceMarketOverview } from "./FinanceMarketOverview";
import { FinanceWorldMap } from "./FinanceWorldMap";
import { FINANCE_NOTICE_VERSION, type FinanceExperienceRequest, type FinanceExperienceState, type FinanceWorldMarketsResult } from "@shared/finance-experience";
import { resolveFinanceDataSource } from "@shared/finance-data-routing";
import { FinanceMessage, financeMessage, financeStatus, financeColumn, financeCell } from "./FinanceMessage";
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
    const computation=financeComputeKind(section);
    const compactTitle=inferred==="treasury_yields"?"미국채":section.title;
    const widget={...createFinanceWidget(computation||inferred==="price_history"||inferred==="treasury_yields"?"chart":"comparison",compactTitle),metric,assetIds:[],periodMode:"pinned" as const,period:"all" as const,chartType:computation==="allocation"?"bar" as const:inferred||computation?"line" as const:"table" as const};
    const operations:FinanceOperation[]=[...(!active?[{type:"dashboard.add" as const,dashboard},{type:"dashboard.select" as const,dashboardId:dashboard.id}]:[]),{type:"widget.add",dashboardId:dashboard.id,widget}];
    return {dashboardId:dashboard.id,widgetId:widget.id,operations};
}
export function financeViewDataRequest(input: { metric: string; query: string; asset?: FinanceAsset; period: string; treasuryMonth: string }): FinanceDataRequest {
    const global = ["social", "social_search", "macro_news", "treasury_yields"].includes(input.metric);
    if (input.metric === "treasury_yields" && !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(input.treasuryMonth)) throw new Error("finance_period_invalid");
    return { query: input.query.trim() || (!global ? input.asset?.symbol ?? "" : ""), assetIds: !global && input.asset ? [input.asset.id] : [],
        metrics: [input.metric], period: input.metric === "price" ? "current" : input.metric === "treasury_yields" ? input.treasuryMonth.replace("-", "") : input.period };
}
export interface FinanceAIContext {
    selectedAssetIds?:string[];
    analystRefs?:FinanceAnalystRef[];
    analystAuthoring?:boolean;
    analystDraft?:FinanceAnalystDraft;
    dashboardId: string | null;
    reportId?: string | null;
    selectedSectionId?: string | null;
    selectedWidgetId: string | null;
    revision: number;
    workspace: Workspace;
    signal: AbortSignal;
    requestId: string;
    history?:Array<{role:"user"|"assistant";content:string}>;
}
export interface FinanceWorkspaceProps {
    onPortfolio?:(request:FinancePortfolioRequest,signal:AbortSignal)=>Promise<FinancePortfolioResult>;
    onPlanning?:(request:FinancePlanningRequest,signal:AbortSignal)=>Promise<FinancePlanningResult>;
    onAnalysts?:(request:FinanceAnalystRequest)=>Promise<FinanceAnalystResult>;
    /** Host revision events refresh preferences after canonical workspace reconciliation. */
    experienceRefreshVersion?: number;
    onExperience?: (request:FinanceExperienceRequest)=>Promise<FinanceExperienceState>;
    onWorldMarkets?: ()=>Promise<FinanceWorldMarketsResult>;
    onDashboardFeeds?: ()=>Promise<FinanceDashboardFeedsResult>;
    onSearch?: (query: string, signal: AbortSignal) => Promise<FinanceSearchResult>;
    onAIRequest?: (request: string, context: FinanceAIContext) => Promise<FinanceAIResult>;
    onExport?: (file: {
        name: string;
        mime: string;
        content: string;
        ownerScope: string | null;
    }) => Promise<{
        saved: boolean;
        path?: string;
    }>;
    onConnectData?: (key: string) => Promise<void>;
    onInspectData?: (request: import("@shared/finance").FinanceDataConnectionRequest) => Promise<import("@shared/finance").FinanceDataConnectionResult>;
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
    return <>{multiline?<textarea {...props} className={`${props.className} ${styles.textarea}`} maxLength={20000}/>:<input {...props} maxLength={200} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape"){reset();e.currentTarget.blur();}}}/>}{hasConflict&&<div className={styles.notice} role="alert"><p>{ko?"다른 작업이 이 내용을 변경했습니다. 작성 중인 초안은 보존했으며 자동으로 덮어쓰지 않습니다.":"Another task changed this content. Your draft is preserved and will not overwrite it automatically."}</p><button type="button" className={styles.button} onClick={reset}>{ko?"최신 값 가져오기":"Use latest value"}</button><details><summary>{ko?"작성 중인 초안":"Your unsaved draft"}</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{draft}</pre></details></div>}</>;
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
    const composition=widget.chartType!=="table"?financeReportCompositionSpec({id:widget.id,title:widget.title,kind:"widget",narrative:"",widget,projection},ko?"ko":"en"):null;
    const numeric = projection.columns.indexOf(widget.type === "allocation" ? "Market value" : "Price");
    const timeIndex = projection.columns.indexOf("Observed at");
    const symbolIndex = Math.max(0, projection.columns.indexOf("Symbol"));
    const currencyIndex = projection.columns.indexOf("Currency");
    const currencyCount = new Set(projection.rows.map(row => row[currencyIndex]).filter(Boolean)).size;
    const temporal = widget.type === "chart" && timeIndex === 0 && projection.rows.length > 1;
    const chartable = widget.chartType !== "table" && ["chart", "comparison", "allocation"].includes(widget.type) && numeric >= 0 && currencyCount === 1 && !projection.rows.some(row=>row[currencyIndex] === "XXX") && (temporal || widget.chartType === "bar");
    const spec = useMemo(() => ({
        data: { values: projection.rows.slice(0, 5000).filter(row => typeof row[numeric] === "number").map(row => ({ x: row[temporal ? timeIndex : symbolIndex], y: row[numeric], series: row[symbolIndex] })) },
        mark: { type: widget.chartType === "bar" || !temporal ? "bar" : "line", tooltip: true },
        encoding: { x: { field: "x", type: temporal ? "temporal" : "nominal", title: projection.columns[temporal ? timeIndex : symbolIndex] }, y: { field: "y", type: "quantitative", title: projection.columns[numeric] }, color: { field: "series", type: "nominal", title: projection.columns[symbolIndex] } },
    }), [projection, numeric, temporal, timeIndex, symbolIndex, widget.chartType, widget.type]);
    if (widget.type === "notes")
        return <p className={styles.narrative}>{widget.notes || (ko ? "블록 설정에서 조사 메모를 작성하세요." : "Add a research note in block settings.")}</p>;
    return <>
    {projection.status === "empty" || projection.status === "unsupported" ? <div className={styles.empty}>{compact?(ko?"자료 없음":"No data"):ko ? "이 블록에 표시할 확인된 자료가 없습니다." : "No verified data is available for this block."}</div> : composition ? <ChartBlock code={JSON.stringify(composition)} presetSpec={composition} blockId={`finance-composition:${widget.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<DataTable projection={projection} compact={compact}/>}/> : widget.type!=="allocation"&&chartable ? <ChartBlock code={JSON.stringify(spec)} presetSpec={spec} blockId={`finance:${widget.id}`} size="panel" fallback={<DataTable projection={projection} compact={compact}/>}/> : <DataTable projection={projection} compact={compact}/>}
    {!compact && projection.rows.length > 5000 && chartable && <p className={styles.muted}>{ko ? "처음 5,000개 관측 표시 · CSV로 전체 내보내기" : "First 5,000 observations shown · export all as CSV"}</p>}{!compact && projection.rows.length > 500 && !chartable && !composition && <p className={styles.muted}>{ko ? "처음 500개 행 표시 · CSV로 전체 내보내기" : "First 500 rows shown · export all rows as CSV"}</p>}
    {!compact && widget.chartType !== "table" && !chartable && !composition && projection.rows.length > 0 && <p className={styles.muted}>{ko ? "호환되는 단위·시계열을 확인할 수 없어 원자료 표로 표시합니다." : "Showing source data as a table: compatible units or history are unavailable."}</p>}{!compact&&inspect&&projection.warnings.length>0&&<details className={styles.cardDetails}><summary>{ko?"자료 정보":"Data information"}</summary>{projection.warnings.map((warning,i)=><FinanceMessage key={i} value={warning} ko={ko}/>)}</details>}
  </>;
}
export function FinanceWorkspace({ onSearch, onAIRequest, onExport, onOpenResearch, onRefreshData, onScheduleMonitor, onQueryData, onPauseMonitor, onConnectData, onInspectData, onRunMonitor, onMonitorRuns, onQueryAndSave, onArchives, onExperience, onWorldMarkets, onDashboardFeeds, onAnalysts, onPortfolio, onPlanning, experienceRefreshVersion=0 }: FinanceWorkspaceProps) {
    const { locale } = useT();
    const ko = locale === "ko";
    const l = (k: string, e: string) => ko ? k : e;
    const store = useFinanceStore();
    const { workspace, loading, saving, error, dispatch, undo, redo, canUndo, canRedo } = store;
    const [tab,setArtifactTab]=useState<Tab>("dashboard");
    const [artifactDetail,setArtifactDetail]=useState(false);
    const [chatArtifact,setChatArtifact]=useState<FinanceArtifactCard|null>(null);
    const [portfolioOpen,setPortfolioOpen]=useState(false);
    const [portfolioFiles,setPortfolioFiles]=useState<File[]>([]);
    const openPortfolio=(files:File[]=[])=>{setPortfolioFiles(files);setPortfolioOpen(true);};
    const [chatTool,setChatTool]=useState<"watchlist"|"sources"|null>(null);
    const [view,setView]=useState<"dashboard"|"chat"|"artifacts">("dashboard");
    useEffect(()=>{if(view!=="chat"||!chatTool)return;const id=requestAnimationFrame(()=>{const panel=document.getElementById("finance-chat-tool-panel");panel?.scrollIntoView({block:"nearest"});panel?.focus({preventScroll:true});});return()=>cancelAnimationFrame(id);},[view,chatTool]);
    const [settingsOpen,setSettingsOpen]=useState(false);
    const [settingsCategory,setSettingsCategory]=useState<FinanceSettingsCategory>("data");
    const [experience,setExperience]=useState<FinanceExperienceState|null>(null);
    const [experienceLoading,setExperienceLoading]=useState(true);
    const [experiencePending,setExperiencePending]=useState(false);
    const [experiencePreparing,setExperiencePreparing]=useState(false);
    const [experienceError,setExperienceError]=useState("");
    const [dataNotice,setDataNotice]=useState(false);const [aiNotice,setAiNotice]=useState(false);
    const [feeds,setFeeds]=useState<FinanceDashboardFeedsResult|null>(null);const [feedsLoading,setFeedsLoading]=useState(false);const feedEpoch=useRef(0),feedRequest=useRef<Promise<FinanceDashboardFeedsResult>|null>(null);
    const [markets,setMarkets]=useState<FinanceWorldMarketsResult|null>(null);const [marketsLoading,setMarketsLoading]=useState(false);const marketRequest=useRef<Promise<FinanceWorldMarketsResult>|null>(null);
    const [messages,setMessages]=useState<Array<{id:string;role:"user"|"assistant";text:string;status?:"pending"|"done"|"failed"|"cancelled";retryText?:string;artifactReportIds?:string[];assetSearches?:FinanceAIResult["assetSearches"];assetSearchOwner?:string|null;assetSearchRevision?:number;authoring?:boolean;authoringSession?:number}>>([]);
    const experienceEpoch=useRef(0),marketEpoch=useRef(0),chatPendingId=useRef<string|null>(null);
    const consentAccepted=experience?.consent?.version===FINANCE_NOTICE_VERSION;
    const builtinsReady=experience?.builtins?.ready===true&&experience.builtins.phase==="ready";
    const consentReady=consentAccepted&&builtinsReady;
    const dashboard = workspace.dashboards.find(d => d.id === workspace.activeDashboardId) ?? workspace.dashboards[0];
    // Saved modules are authoritative even while the host preference receipt is catching up.
    const dashboardCustomized=experience?.dashboardCustomized===true||!!dashboard?.widgets.length;
    const monitoringAllowed=experience?.access.status==="verified"&&experience.access.monitoringAllowed===true;
    const experienceRefreshSeen=useRef(experienceRefreshVersion);
    const setTab=(next:Tab)=>{setArtifactTab(next);if(next==="dashboard")setView("dashboard");else if(next==="monitors"){setSettingsCategory("monitoring");setSettingsOpen(true);}else if(next==="watchlist"||next==="sources"){setChatTool(next);setView("chat");}else{setArtifactDetail(true);setView("artifacts");}};
    const readExperience=async(background=false)=>{const epoch=++experienceEpoch.current;if(!background)setExperienceLoading(true);setExperienceError("");
        try{if(!onExperience)throw new Error("unavailable");const next=await onExperience({action:"read"});if(epoch===experienceEpoch.current)setExperience(next);}
        catch{if(epoch===experienceEpoch.current)setExperienceError(l("이용 설정을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.","Could not load usage settings. Check the connection and try again."));}
        finally{if(epoch===experienceEpoch.current)setExperienceLoading(false);}};
    useEffect(()=>{void readExperience();return()=>{experienceEpoch.current++;marketEpoch.current++;};},[onExperience]);
    const updateExperience=async(request:FinanceExperienceRequest)=>{if(!onExperience)return;const epoch=++experienceEpoch.current;setExperiencePending(true);setExperiencePreparing(request.action==="accept"||request.action==="plugins.prepare");setExperienceError("");
        try{const next=await onExperience(request);if(epoch===experienceEpoch.current)setExperience(previous=>request.action==="monitoring"&&!request.enabled&&next.builtins===undefined&&previous?.builtins?{...next,builtins:previous.builtins}:next);}
        catch{if(epoch===experienceEpoch.current)setExperienceError(l("설정을 저장하지 못했습니다. 계정·이용 권한과 연결을 확인하세요.","Could not save settings. Check account access and the connection."));}
        finally{if(epoch===experienceEpoch.current){setExperiencePending(false);setExperiencePreparing(false);}}};
    useEffect(()=>{
        if(experiencePending||experienceRefreshSeen.current===experienceRefreshVersion)return;
        experienceRefreshSeen.current=experienceRefreshVersion;
        void readExperience(true);
    },[experienceRefreshVersion,experiencePending,onExperience]);
    const markCustomized=async(operations:FinanceOperation[])=>{if(experience?.dashboardCustomized!==true&&operations.some(op=>op.type.startsWith("widget.")||op.type==="dashboard.add"&&op.dashboard.widgets.length>0))await updateExperience({action:"customize",customized:true});};
    const refreshMarkets=async()=>{if(!consentReady||!onWorldMarkets)return;const epoch=++marketEpoch.current;setMarketsLoading(true);
        try{
            if(marketRequest.current)await marketRequest.current.catch(()=>undefined);
            if(epoch!==marketEpoch.current)return;
            const pending=onWorldMarkets();marketRequest.current=pending;
            try{const next=await pending;if(epoch===marketEpoch.current)setMarkets(next);}
            finally{if(marketRequest.current===pending)marketRequest.current=null;}
        }
        catch{if(epoch===marketEpoch.current)setMarkets(null);}
        finally{if(epoch===marketEpoch.current)setMarketsLoading(false);}};
    const marketSourceId=experience?resolveFinanceDataSource(experience,'market'):undefined;
    useEffect(()=>{setMarkets(null);marketEpoch.current++;},[marketSourceId,workspace.ownerScope]);
    useEffect(()=>{if(consentReady&&view==="dashboard"&&onWorldMarkets)void refreshMarkets();else setMarketsLoading(false);return()=>{marketEpoch.current++;};},[consentReady,view,dashboardCustomized,onWorldMarkets,marketSourceId,workspace.ownerScope]);
    const feedSettingsKey=JSON.stringify([experience?.enabledFeedIds??[],experience?.sourceBindings??{}]);
    const refreshFeeds=async()=>{if(!consentReady||!onDashboardFeeds)return;const epoch=++feedEpoch.current;setFeedsLoading(true);
        try{
            // Finish the preceding host request before fetching the latest settings; stale replies never enter the view.
            if(feedRequest.current)await feedRequest.current.catch(()=>undefined);
            if(epoch!==feedEpoch.current)return;
            const pending=onDashboardFeeds();feedRequest.current=pending;
            try{const next=await pending;if(epoch===feedEpoch.current)setFeeds(next);}
            finally{if(feedRequest.current===pending)feedRequest.current=null;}
        }catch{if(epoch===feedEpoch.current)setFeeds(null);}
        finally{if(epoch===feedEpoch.current)setFeedsLoading(false);}};
    useEffect(()=>{setFeeds(null);feedEpoch.current++;},[experience?.sourceId,feedSettingsKey,workspace.ownerScope]);
    useEffect(()=>{if(consentReady&&view==="dashboard"&&onDashboardFeeds)void refreshFeeds();else setFeedsLoading(false);return()=>{feedEpoch.current++;};},[consentReady,view,onDashboardFeeds,experience?.sourceId,feedSettingsKey,workspace.ownerScope]);
    const finishChat=(id:string,text:string,status:"done"|"failed"|"cancelled")=>setMessages(previous=>previous.map(message=>message.id===id?{...message,text,status}:message));
    const [editing, setEditing] = useState(false);
    const [selected, setSelected] = useState("");
    const [savedSeries,setSavedSeries]=useState<Record<string,string>>({});
    const [notice, setNotice] = useState("");
    const [request, setRequest] = useState("");
    const [analysts,setAnalysts]=useState<FinanceAnalyst[]>([]),[selectedAnalysts,setSelectedAnalysts]=useState<FinanceAnalyst[]>([]);
    const [analystsLoading,setAnalystsLoading]=useState(false),[analystsPending,setAnalystsPending]=useState(false),[analystsError,setAnalystsError]=useState("");
    const [authoringSession,setAuthoringSession]=useState(0);
    const [analystAuthoring,setAnalystAuthoring]=useState(false),[analystDraft,setAnalystDraft]=useState<FinanceAnalystDraft|null>(null);
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
    useEffect(()=>{analystEpoch.current++;analystMutation.current=false;setAnalysts([]);setSelectedAnalysts([]);setAnalystsPending(false);setAnalystsLoading(false);setAnalystsError("");setAnalystAuthoring(false);setAnalystDraft(null);return()=>{analystEpoch.current++;};},[workspace.ownerScope,onAnalysts]);
    useEffect(()=>{if(consentReady&&onAnalysts)void refreshAnalysts();},[consentReady,onAnalysts,workspace.ownerScope]);
    useEffect(()=>{if(settingsOpen&&settingsCategory==="analysts"&&consentReady)void refreshAnalysts();},[settingsOpen,settingsCategory]);
    const selectAnalyst=(item:FinanceAnalyst)=>{if(analystAuthoring)return;setSelectedAnalysts(previous=>previous.some(ref=>ref.id===item.id)?previous.map(ref=>ref.id===item.id?item:ref):previous.length<3?[...previous,item]:previous);};
    const beginAnalystAuthoring=(draft?:FinanceAnalystDraft)=>{if(!onAnalysts){setAnalystsError(l("이 앱에서는 Analyst 만들기를 사용할 수 없습니다.","Analyst creation is unavailable in this app."));return;}if(busy||analystMutation.current)return;setAuthoringSession(previous=>previous+1);setAnalystAuthoring(true);setAnalystDraft(draft??null);setSelectedAnalysts([]);setRequest("");setSettingsOpen(false);setChatTool(null);setView("chat");};
    const exitAnalystAuthoring=()=>{aiAbort.current?.abort();aiAbort.current=null;if(chatPendingId.current)finishChat(chatPendingId.current,l("요청을 중지했습니다.","Request stopped."),"cancelled");chatPendingId.current=null;setBusy(false);setAnalystAuthoring(false);setAnalystDraft(null);setSelectedAnalysts([]);setRequest("");};

    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState("");
    const [searchEvidence, setSearchEvidence] = useState<FinanceSearchResult | null>(null);
    const [selectedCandidate,setSelectedCandidate]=useState<{asset:FinanceAsset;ownerScope:string|null;revision:number}|null>(null);
    const selectedAsset=selectedCandidate?.ownerScope===workspace.ownerScope&&selectedCandidate.revision===workspace.revision?selectedCandidate.asset:null;
    const watchlistIds=useMemo(()=>new Set(workspace.watchlist.map(asset=>asset.id)),[workspace.watchlist]);
    const [dataAssetId, setDataAssetId] = useState("");
    const [dataQueryText,setDataQueryText]=useState("");
    const [lastDataRequest,setLastDataRequest]=useState<FinanceDataRequest|null>(null);
    const [dataSaving,setDataSaving]=useState(false);
    const [aiReceipt,setAIReceipt]=useState<{message:string;runtime?:FinanceAIResult["runtime"];status?:FinanceAIResult["status"];operations:FinanceOperation[];savedRevision:number|null}|null>(null);
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
    const aiAbort = useRef<AbortController | null>(null);
    const aiApplying = useRef(false);
    const searchAbort = useRef<AbortController | null>(null);
    const latest = useRef(workspace);
    latest.current = workspace;
    useEffect(()=>{
        searchAbort.current?.abort();searchAbort.current=null;setSearching(false);setSearchEvidence(null);setSelectedCandidate(null);
    },[workspace.ownerScope,workspace.revision]);
    useEffect(()=>{setMessages([]);},[workspace.ownerScope]);
    useEffect(() => () => { aiAbort.current?.abort(); searchAbort.current?.abort(); queryAbort.current?.abort(); refreshAbort.current?.abort(); }, []);
    const widget = dashboard?.widgets.find(w => w.id === selected);
    const compositionWidget=!!widget&&(widget.type==="allocation"||(()=>{const ref=parseFinanceEvidenceMetric(widget.metric),section=ref?workspace.reports.find(report=>report.id===ref.reportId)?.sections.find(item=>item.id===ref.sectionId):undefined;return !!section&&!!financeReportCompositionTitle(section);})());
    const archivedReport=archiveOpen?archiveRead?.workspaceSnapshot.reports.find(r=>r.id===archiveReportId&&archiveRead.reportIds.includes(r.id)):undefined;
    const report = archivedReport ?? (archiveOpen?undefined:workspace.reports.find(r => r.id === reportId) ?? workspace.reports[0]);
    const reportEditing=editing&&!archivedReport;
    const archiveCounts=financeArchivePreview(workspace,archivePreview?.reportIds??archiveSelection);
    const imported = useMemo(() => csv.trim() ? importFinanceCsv(csv, { defaultCurrency }) : null, [csv, defaultCurrency]);
    const friendlyError = (value: string) => {
        const translated=financeMessage(value,ko); if(translated!==value)return translated;
        if (value.includes("revision_conflict"))
            return l("다른 작업에서 자료가 바뀌었습니다. 최신 상태를 다시 열어주세요.", "Another task changed the workspace. Reload the latest state.");
        if (value.includes("asset_has_holdings"))
            return l("보유 자료가 연결된 자산은 관심목록에서 제거할 수 없습니다.", "Assets with holdings cannot be removed from the watchlist.");
        if (value.includes("scheduler"))
            return l("모니터링 실행기를 확인할 수 없습니다. 초안은 유지됩니다.", "The monitoring executor is unavailable. The draft is preserved.");
        if (value.includes("finance_") || value.startsWith("["))
            return l("변경을 저장하지 못했습니다. 입력값과 저장 연결을 확인하세요.", "Could not save the change. Check the input and storage connection.");
        return value;
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
    const btn = (text: string, onClick: () => void, disabled = false, primary = false): ReactNode => <button type="button" className={`${styles.button} ${primary ? styles.primary : ""}`} onClick={onClick} disabled={disabled}>{text}</button>;
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
        catch {
            if (!controller.signal.aborted)
                setNotice(l("검색에 실패했습니다. 저장한 자산은 유지됩니다.", "Search failed. Saved assets are unchanged."));
        }
        finally {
            if (searchAbort.current === controller)
                setSearching(false);
        }
    };
    const ask = async () => {
        if(!consentReady)return;
        if(archivedReport){setNotice(l("보관 원본은 읽기 전용입니다. 편집하려면 보고서를 복원하세요.","Archived originals are read only. Restore the report to edit it."));return;}
        if (!request.trim() || !onAIRequest || busy || (!analystAuthoring&&selectedAnalysts.length>0&&(analystsLoading||!!analystsError||!financeAnalystPinsCurrent(selectedAnalysts,analysts))))
            return;
        if(view==="dashboard")setView("chat");
        const controller = new AbortController();
        aiAbort.current = controller;
        const base = workspace;
        const submittedAuthoring=analystAuthoring;
        const submitted=request.trim(),answerId=crypto.randomUUID();chatPendingId.current=answerId;
        setMessages(previous=>[...previous,{id:crypto.randomUUID(),role:"user",text:submitted,authoring:submittedAuthoring,authoringSession},{id:answerId,role:"assistant",text:"",status:"pending",retryText:submitted,authoring:submittedAuthoring,authoringSession}]);
        setRequest("");setBusy(true);
        setAIReceipt(null);
        try {
            const response = await onAIRequest(submitted, { analystAuthoring:submittedAuthoring,analystRefs:submittedAuthoring?[]:selectedAnalysts.map(({id,revision})=>({id,revision})),...(submittedAuthoring&&analystDraft?{analystDraft}:{}), selectedAssetIds:submittedAuthoring?[]:selectedAsset?[selectedAsset.id]:[], history:messages.filter(message=>!!message.authoring===submittedAuthoring&&(!submittedAuthoring||message.authoringSession===authoringSession)).filter(message=>message.status!=="pending"&&message.status!=="failed"&&message.status!=="cancelled").slice(-12).map(message=>({role:message.role,content:message.text})), workspace: base, dashboardId: tab === "reports" && artifactDetail ? null : dashboard?.id ?? null, selectedWidgetId: tab === "dashboard" ? selected || null : null, revision: base.revision, reportId: tab === "reports" && artifactDetail ? report?.id ?? null : null, selectedSectionId: tab === "reports" && artifactDetail ? selectedSection || null : null, signal: controller.signal, requestId: crypto.randomUUID() });
            if (controller.signal.aborted)
                return;
            if (latest.current.ownerScope!==base.ownerScope || !submittedAuthoring&&latest.current.revision !== response.baseRevision) {
                finishChat(answerId,l("화면이 변경되어 제안을 적용하지 않았습니다. 현재 화면으로 다시 요청하세요.","The screen changed, so the proposal was not applied. Retry with the current screen."),"failed");
                setNotice(l("화면이 먼저 변경되어 AI 제안을 적용하지 않았습니다. 현재 상태로 다시 요청하세요.", "The screen changed before the response arrived. Ask again using the current state."));
                return;
            }
            if(submittedAuthoring&&response.operations?.length)throw new Error("finance_analyst_authoring_operations_refused");
            if(response.analystDraft)setAnalystDraft(response.analystDraft);
            let savedRevision: number | null = null;
            if (response.operations?.length) {
                aiApplying.current = true;
                try { savedRevision = (await dispatch(response.operations, response.baseRevision)).revision;await markCustomized(response.operations); }
                finally { aiApplying.current = false; }
                if(controller.signal.aborted){
                    if(!aiAbort.current)setNotice(l("중지 전에 시작한 화면 변경이 저장되었습니다. 되돌리기로 취소할 수 있습니다.","A screen change already applying before Stop was saved. Use Undo to revert it."));
                    return;
                }
            }
            setNotice(savedRevision === null ? "" : l("변경을 저장했습니다.", "Changes saved."));
            if(!response.status||response.status==="ok"){const addedIds=savedRevision===null?[]:(response.operations??[]).filter((operation):operation is Extract<FinanceOperation,{type:"report.add"}>=>operation.type==="report.add").map(operation=>operation.report.id);const knownIds=new Set([...base.reports.map(report=>report.id),...addedIds]);const reportIds=[...new Set([...addedIds,...(response.artifacts??[]).filter(artifact=>knownIds.has(artifact.reportId)).map(artifact=>artifact.reportId)])];if(reportIds.length)setMessages(previous=>previous.map(message=>message.id===answerId?{...message,artifactReportIds:reportIds}:message));}
            if(!submittedAuthoring&&(!response.status||response.status==="ok")&&response.assetSearches?.length)setMessages(previous=>previous.map(message=>message.id===answerId?{...message,assetSearches:response.assetSearches,assetSearchOwner:base.ownerScope,assetSearchRevision:savedRevision??response.baseRevision}:message));
            finishChat(answerId,response.message,response.status&&!["ok"].includes(response.status)?"failed":"done");
            setAIReceipt({message:response.message,runtime:response.runtime,status:response.status,operations:response.operations??[],savedRevision});
        }
        catch {
            if (!controller.signal.aborted){
                finishChat(answerId,l("요청을 완료하지 못했습니다. 다시 시도할 수 있습니다.","The request did not complete. You can retry."),"failed");
                setNotice(l("AI 요청을 완료하지 못했습니다. 직접 편집은 계속할 수 있습니다.", "The AI request failed. You can continue editing directly."));}
        }
        finally {
            if (aiAbort.current === controller) {
                setBusy(false);
                aiAbort.current = null;chatPendingId.current=null;
            }
        }
    };
    const exportReport = async () => {
        if (!report)
            return;
        try {
        const current = await store.flush();
        const exported = archivedReport ?? current.reports.find(item => item.id === report.id);
        if (!exported) throw new Error("finance_report_not_found");
        await download(`finance-report-${exported.id.replace(/[^a-zA-Z0-9_-]/g, "")}.html`, await financeReportExportHtml(exported,locale), "text/html;charset=utf-8");
        } catch { setNotice(l("저장 결과를 확인한 뒤 다시 내보내세요. 파일을 만들지 않았습니다.", "Confirm the saved changes before exporting again. No file was created.")); }
    };
    const refreshData = async () => {
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
            setNotice(response.message);
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
            setNotice(receipt.message);
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
            setArchivePreview(null);setArchiveSelection([]);setEditing(false);setNotice(`${l("원본 보관 완료 · 활성 목록 회수","Original archived · removed from active lists")}: ${result.reclaimed.reports} ${l("보고서","reports")} / ${result.reclaimed.sources} ${l("출처","sources")}. ${result.warnings.map(w=>financeMessage(w,ko)).join(" ")}`);
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
            setArchiveOpen(false);if(sourcesOnly)setTab("sources");else setReportId(archiveRestoreIds[0]);setArchiveRestoreIds([]);setNotice(`${l("복원 완료","Restored")}: ${result.restored.reports} ${l("보고서","reports")} / ${result.restored.sources} ${l("출처","sources")}. ${result.warnings.map(w=>financeMessage(w,ko)).join(" ")}`);
        }catch(cause){archiveError(cause);}finally{setArchiveBusy(false);}
    };
    const openMonitorReport = async (id:string) => {
        try {const current=await store.flush();if(current.reports.some(item=>item.id===id)){setArchiveOpen(false);setReportId(id);setSelectedSection("");setTab("reports");setEditing(false);}
          else if(onArchives)await readArchive({action:"read",reportId:id},id);
          else throw new Error("finance_report_not_found");}
        catch {setNotice(l("브리핑을 열지 못했습니다. 실행 이력은 유지됩니다.","Could not open the briefing. The run ledger is preserved."));}
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
            setSelected(pin.widgetId);setTab("dashboard");setEditing(false);setNotice(l("저장 관측을 대시보드에 고정했습니다. 출처와 기준일을 유지하며, 화면에서 AI나 블록 설정으로 제목·표현·배치를 편집할 수 있습니다.","Pinned saved observations with their sources and dates. Edit the title, display and layout through AI or block settings."));
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
    const exportWidget = async (dashboardId: string, widgetId: string) => {
        try {
            const current = await store.flush();
            const selectedDashboard = current.dashboards.find(item => item.id === dashboardId);
            const selectedWidget = selectedDashboard?.widgets.find(item => item.id === widgetId);
            if (!selectedDashboard || !selectedWidget) throw new Error("finance_widget_not_found");
            const projection = projectFinanceWidget(current, effectiveFinanceWidget(selectedDashboard, selectedWidget));
            await download(`finance-${widgetId}.csv`, exportFinanceCsv(projection), "text/csv;charset=utf-8");
        } catch { setNotice(l("저장 결과를 확인한 뒤 다시 내보내세요.", "Confirm the saved changes before exporting again.")); }
    };
    const move = (id: string, index: number) => dashboard && void act({ type: "widget.move", dashboardId: dashboard.id, widgetId: id, index });
    const updateWidget = (patch: Partial<FinanceWidget>) => dashboard && widget && void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: widget.id, patch });
    if(experienceLoading)return <main className={styles.root}><h1 className={styles.title}>Agentlas Finance</h1><p role="status">{l("이용 설정을 여는 중…","Loading usage settings…")}</p></main>;
    if(!consentReady)return <main className={styles.root}><section className={styles.consent}><h1>Agentlas Finance</h1>
        {!consentAccepted&&<><p>{l("시작하기 전에 두 가지 안내를 확인해 주세요.","Please review these two notices before starting.")}</p><FinanceUsageNotices ko={ko}/><label><input type="checkbox" checked={dataNotice} onChange={event=>setDataNotice(event.target.checked)}/>{l("데이터 이용 안내를 확인했습니다.","I have reviewed the data use notice.")}</label><label><input type="checkbox" checked={aiNotice} onChange={event=>setAiNotice(event.target.checked)}/>{l("AI 전송 안내를 확인했습니다.","I have reviewed the AI transmission notice.")}</label></>}
        <p role="status" aria-live="polite" aria-busy={experiencePreparing}>{experiencePreparing&&<IconRefresh size={16}/>} {experiencePreparing?l("Finance 기본 도구를 준비하는 중…","Preparing Finance’s built-in tools…"):l("Finance 기본 도구를 함께 준비합니다.","We’ll prepare Finance’s built-in tools together.")}</p>
        {(experienceError||experience?.builtins?.phase==="error")&&<p role="alert" className={styles.notice}>{experienceError||l("기본 도구를 준비하지 못했습니다. 다시 시도해 주세요.","Could not prepare the built-in tools. Please try again.")}</p>}
        <div className={styles.actions}>{consentAccepted?btn(l("도구 준비","Prepare tools"),()=>{void updateExperience({action:"plugins.prepare"});},!onExperience||experiencePending):btn(l("시작하기","Get started"),()=>{void updateExperience({action:"accept",version:FINANCE_NOTICE_VERSION,dataNotice:true,aiNotice:true});},!onExperience||!dataNotice||!aiNotice||experiencePending)}{experienceError&&btn(l("다시 확인","Retry"),()=>{void readExperience();},experiencePending)}
        {experience?.monitoring.enabled&&btn(l("정기 브리핑 중지","Stop scheduled briefings"),()=>{void updateExperience({action:"monitoring",enabled:false});},!onExperience)}</div>
    </section></main>;
    if (loading)
        return <main className={styles.root}><p className={styles.skeleton} role="status">{l("Agentlas Finance를 여는 중…", "Opening Agentlas Finance…")}</p></main>;
    const archivePanel=onArchives&&<div className={styles.importPanel}>
      <div className={styles.actions}>{btn(archiveOpen?l("활성 보고서로","Active reports"):l("보관함 열기","Open archives"),()=>{setArchiveOpen(!archiveOpen);setEditing(false);if(!archiveOpen)void loadArchives();},archiveBusy)}
      {!archiveOpen&&btn(l("선택 보고서 보관 준비","Prepare selected reports for archive"),()=>setArchivePreview({revision:workspace.revision,reportIds:archiveSelection}),archiveBusy||!archiveSelection.length)}</div>
      {!archiveOpen&&<details><summary>{l("보관할 보고서 선택","Select reports to archive")} · {archiveSelection.length}</summary>{btn(workspace.reports.length>0&&workspace.reports.every(r=>archiveSelection.includes(r.id))?l("선택 해제","Clear selection"):l("전체 선택","Select all"),()=>setArchiveSelection(workspace.reports.length>0&&workspace.reports.every(r=>archiveSelection.includes(r.id))?[]:workspace.reports.map(r=>r.id)),archiveBusy||!workspace.reports.length)}<div className={styles.list}>{workspace.reports.map(r=><label key={r.id} className={styles.muted}><input type="checkbox" checked={archiveSelection.includes(r.id)} onChange={e=>setArchiveSelection(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title}</label>)}</div></details>}
      {archiveOpen&&<><p className={styles.muted}>{l("원본을 보존한 읽기 전용 보관함입니다. 열기·내보내기는 복원하지 않습니다.","Read-only originals. Opening or exporting an archive does not restore it.")}</p>
        {archiveItems.map(item=><div key={item.archiveId} className={styles.listItem}><strong>{item.reportTitles.join(" · ")||l("참조없는 출처 보관","Unreferenced sources")}</strong><p className={styles.muted}>{date(item.createdAt)} · {item.reportCount} {l("보고서","reports")} · {item.sourceCount} {l("스냅샷 출처","snapshot sources")}</p>{btn(l("원본 열기","Open original"),()=>{void readArchive({action:"read",archiveId:item.archiveId});},archiveBusy)}</div>)}
        {archiveCursor&&btn(l("보관 이력 더 보기","Load older archives"),()=>{void loadArchives(archiveCursor);},archiveBusy)}{!archiveItems.length&&!archiveBusy&&!archiveRead&&<p className={styles.muted}>{l("표시할 보관 목록이 없습니다.","No archives to display.")}</p>}{archiveRead&&!archiveItems.length&&btn(l("보관 목록 불러오기","Load archive list"),()=>{void loadArchives();},archiveBusy)}
        {archiveRead&&<div className={styles.receipt}><p className={styles.muted}>{l("보관 무결성 식별자","Archive integrity identifier")}: <span style={{overflowWrap:"anywhere"}}>{archiveRead.sha256}</span></p>{archiveRead.warnings.map((warning,index)=><FinanceMessage key={index} value={warning} ko={ko}/>)}
          <select className={styles.select} aria-label={l("보관 보고서 선택","Choose archived report")} value={archiveReportId} onChange={e=>setArchiveReportId(e.target.value)}>{!archiveRead.reportIds.length&&<option value="">{l("보관 보고서 없음 · 출처 원본만 보관","Sources-only archive")}</option>}{archiveRead.workspaceSnapshot.reports.filter(r=>archiveRead.reportIds.includes(r.id)).map(r=><option value={r.id} key={r.id}>{financeArtifactTitle(r.title)}</option>)}</select>
          {btn(l("보관판 전체 JSON 저장","Save complete archive as JSON"),()=>{void exportArchive();},archiveBusy)}<p className={styles.muted}>{l("전체 원본과 출처·이용 조건을 함께 저장합니다. 파일 내보내기는 활성 자료를 복원하지 않습니다.","Exports the complete original with its source records and usage notes. Exporting does not restore active data.")}</p>
          {archiveRead.reportIds.length>0&&<details><summary>{l("선택 보고서 복원","Restore selected reports")}</summary>{archiveRead.workspaceSnapshot.reports.filter(r=>archiveRead.reportIds.includes(r.id)).map(r=><label key={r.id} className={styles.label}><span><input type="checkbox" checked={archiveRestoreIds.includes(r.id)} onChange={e=>setArchiveRestoreIds(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title}</span></label>)}<p className={styles.muted}>{l("활성 보고서·출처 한도 또는 변경 충돌 시 복원을 중단합니다. 원본은 보관함에 남습니다.","Restoration stops on active report/source limits or revision conflicts. Archived originals remain available.")}</p>{btn(l("선택 항목 복원","Restore selection"),()=>{void restoreArchive();},archiveBusy||!archiveRestoreIds.length)}</details>}
          <details><summary>{l("보관 출처 원본 보기","View archived source records")} · {archiveRead.workspaceSnapshot.sources.length}</summary><DataTable projection={{columns:[l("이름","Name"),l("출처 ID","Source ID"),l("관측 기준","As of"),l("가져온 시각","Retrieved at"),l("원문 주소","Source URL"),l("이용 조건·메모","Usage notes")],rows:archiveRead.workspaceSnapshot.sources.map(source=>[source.name,source.id,source.asOf,source.retrievedAt,source.url,source.note]),status:"ready",warnings:[],asOf:null,sourceIds:[]}}/>{archiveRead.workspaceSnapshot.sources.length>500&&<p className={styles.muted}>{l("처음 500개 출처 표시 · 전체 원본은 JSON으로 저장하세요.","First 500 sources shown. Save JSON for the complete original.")}</p>}</details>
          {!archiveRead.reportIds.length&&<><p className={styles.muted}>{l("보관 당시 회수한 미참조 출처만 복원합니다. 보유 자산과 가격 자료는 복원하지 않습니다. 저장 한도·충돌이 있으면 원본을 유지하고 중단합니다.","Restores only the unreferenced sources reclaimed by this archive. Holdings and quotes are not restored. Capacity or conflict errors leave the archived original intact.")}</p>{btn(l("보관된 미참조 출처 복원","Restore archived unreferenced sources"),()=>{void restoreArchive(true);},archiveBusy)}</>}

        </div>}
      </>}{archiveBusy&&<p role="status">{l("보관 작업 중…","Archive operation in progress…")}</p>}
    </div>;
    const iconButton = (label: string, icon: ReactNode, action: () => void, disabled = false) => <button type="button" className={styles.iconButton} aria-label={label} title={label} onClick={action} disabled={disabled}>{icon}</button>;
    const monitorContent=<section><div className={styles.toolbar}><h2 className={styles.sectionHeading}>{l("모니터링", "Monitoring")}</h2><div className={styles.actions}>{btn(l("자동화 실행 이력", "Automation run history"), () => navigate("/automation"))}{btn(l("모니터 추가", "Add monitor"), () => { void act({ type: "monitor.upsert", monitor: { id: crypto.randomUUID(), name: l("새 점검 조건", "New check"), query: "", assetIds: [], status: "draft", lastCheckedAt: null, nextCheckAt: null, note: l("아직 실행하지 않은 점검 초안입니다.", "A draft check that has not been executed.") } }); })}</div></div><div className={styles.list}>{workspace.monitors.map(m => <article key={m.id} className={styles.listItem}><div className={styles.cardHead}><h3>{m.name}</h3><span className={styles.badge}>{financeStatus(m.status,ko)}</span></div><div className={styles.monitorOverview}><span>{m.query||l("조건을 입력하세요", "Set a condition")}</span>{m.nextCheckAt&&<span>{date(m.nextCheckAt)}</span>}</div><details className={styles.sectionDetails}><summary>{l("설정", "Settings")}</summary><label className={styles.label}>{l("이름", "Name")}<DraftField disabled={m.status === 'active'} value={m.name} label={l("모니터링 이름", "Monitor name")} onCommit={name => { if (name.trim())
        void act({ type: "monitor.upsert", monitor: { ...m, name } }); }}/></label><label className={styles.label}>{l("확인할 질문·조건", "Question or condition")}<DraftField disabled={m.status === 'active'} multiline value={m.query} label={l("모니터링 조건", "Monitoring condition")} onCommit={query => { void act({ type: "monitor.upsert", monitor: { ...m, query } }); }}/></label><dl className={styles.metaGrid}><div><dt>{l("마지막 확인", "Last checked")}</dt><dd>{date(m.lastCheckedAt)}</dd></div><div><dt>{l("다음 실행", "Next check")}</dt><dd>{date(m.nextCheckAt)}</dd></div></dl><p className={styles.muted}>{m.note}</p>{m.status === 'active' && <p className={styles.muted}>{l("조건을 편집하려면 실행을 먼저 일시정지하세요.", "Pause execution before editing its conditions.")}</p>}<label className={styles.label}>{l("점검할 자산", "Assets to check")}<select className={styles.select} value={m.assetIds[0] || ""} disabled={m.status === 'active'} onChange={e => { void act({ type: "monitor.upsert", monitor: { ...m, assetIds: e.target.value ? [e.target.value] : [] } }); }}><option value="">{l("자산 선택", "Choose asset")}</option>{workspace.watchlist.map(a => <option value={a.id} key={a.id}>{a.symbol} · {a.exchange}</option>)}</select></label><div className={styles.actions} style={{ marginTop: 12 }}>{onScheduleMonitor && <><label className={styles.label}>{l("실행 일정", "Schedule")}<select className={styles.select} value={financeMonitorScheduleValue(m,monitorSchedules)} disabled={!monitoringAllowed||m.status==='active'||scheduling===m.id} aria-label={l("실행 일정", "Execution schedule")} onChange={e=>setMonitorSchedules(current=>({...current,[m.id]:e.target.value}))}><option value="daily-09:00">{l("매일 오전 9시 · 현지 시간", "Daily at 09:00 · local time")}</option><option value="weekday-09:00">{l("평일 오전 9시 · 현지 시간", "Weekdays at 09:00 · local time")}</option><option value="hourly">{l("매시간", "Hourly")}</option><option value="every-5m">{l("5분마다 · 앱 실행 중", "Every 5 minutes · while app is running")}</option></select></label>{btn(scheduling === m.id ? l("등록 중…", "Registering…") : l("자동화로 등록", "Schedule automation"), () => { if(!monitoringAllowed)return; setScheduling(m.id); void onScheduleMonitor(m, financeMonitorScheduleValue(m,monitorSchedules)).then(() => { setMonitorSchedules(current=>{const next={...current};delete next[m.id];return next;});setNotice(l("실행 등록 결과를 확인했습니다. 자동화 화면에서 일정과 실행 이력을 확인하세요.", "Checked the scheduling result. Review the schedule and run history in Automations.")); void store.reload(); }).catch(() => setNotice(l("자동화를 등록하지 못했습니다. 초안은 유지됩니다.", "Could not schedule automation. The draft is preserved."))).finally(() => setScheduling("")); }, !monitoringAllowed || !!scheduling || m.status === 'active' || !m.query.trim() || !financeMonitorScheduleValue(m,monitorSchedules).trim())}</>}{btn(l("예약 일시정지", "Pause schedule"), () => { if (onPauseMonitor) {
        void onPauseMonitor(m).then(() => store.reload()).catch(() => setNotice(l("실행을 일시정지하지 못했습니다. 실제 상태를 다시 확인하세요.", "Could not pause execution. Check the actual run status.")));
    }
    else {
        void act({ type: "monitor.upsert", monitor: { ...m, status: "paused", nextCheckAt: null } });
    } }, m.status === 'paused' || m.status === 'draft' || (m.status === 'active' && !onPauseMonitor))}{onOpenResearch && m.assetIds[0] && workspace.watchlist.find(a => a.id === m.assetIds[0]) && btn(l("조사 작업으로 이어가기", "Continue as a research task"), () => { const asset = workspace.watchlist.find(a => a.id === m.assetIds[0]); if (asset)
        void onOpenResearch(asset); })}{btn(l("초안 제거", "Remove draft"), () => { void act({ type: "monitor.remove", monitorId: m.id }); }, m.status === 'active')}</div></details><FinanceMonitorReceipts monitor={m} ko={ko} onRun={onRunMonitor} onLoad={onMonitorRuns} onOpenReport={id=>{void openMonitorReport(id);}}/></article>)}</div>{!workspace.monitors.length && <div className={styles.empty}>{l("저장된 모니터링이 없습니다. 먼저 확인할 조건을 초안으로 남길 수 있습니다.", "No monitors saved. Start by drafting the condition you want to check.")}</div>}</section>;
    const chooseCandidate=(asset:FinanceAsset)=>{if(busy)return;setSelectedCandidate(current=>current?.asset.id===asset.id&&current.ownerScope===workspace.ownerScope&&current.revision===workspace.revision?null:{asset,ownerScope:workspace.ownerScope,revision:workspace.revision});};
    const draftAssetQuestion=(asset:FinanceAsset)=>{if(busy)return;setSelectedCandidate({asset,ownerScope:workspace.ownerScope,revision:workspace.revision});setRequest(l(`${asset.name} (${asset.symbol})의 최근 실적과 주요 위험을 정리해줘`, `Summarize recent financial results and key risks for ${asset.name} (${asset.symbol}).`));};
    const assetResults=(result:FinanceSearchResult,query?:string,disabled=false)=><FinanceAssetResults result={result} query={query} ko={ko} selectedAssetId={selectedAsset?.id} watchlistIds={watchlistIds} disabled={busy||disabled} onSelect={chooseCandidate} onWatchlist={asset=>{void act({type:"watchlist.add",asset});}} onResearch={draftAssetQuestion}/>;
    const visibleChatMessages=messages.filter(message=>!!message.authoring===analystAuthoring&&(!analystAuthoring||message.authoringSession===authoringSession));
    const aiComposer = <section className={styles.composer} aria-label={l("Agentlas Finance AI", "Agentlas Finance AI")}>{!analystAuthoring&&selectedAsset&&<FinanceSelectedAsset asset={selectedAsset} ko={ko} onRemove={()=>setSelectedCandidate(null)}/>} {busy&&<span className={styles.srOnly} role="status">{l("요청 처리 중", "Request running")}</span>}<form className={styles.composerForm} onPaste={event=>{if(!onPortfolio||analystAuthoring)return;const images=Array.from(event.clipboardData.files).filter(file=>file.type.startsWith("image/"));if(images.length){event.preventDefault();openPortfolio(images);}}} onSubmit={e => { e.preventDefault(); void ask(); }}><FinanceAnalystComposer value={request} onChange={setRequest} onSubmit={()=>void ask()} disabled={busy} ko={ko} items={analysts} selected={selectedAnalysts} loading={analystsLoading} error={onAnalysts?analystsError:l("이 앱에서는 Analyst를 사용할 수 없습니다.","Analysts are unavailable in this app.")} available={!!onAnalysts} onSelect={selectAnalyst} onRemove={id=>setSelectedAnalysts(previous=>previous.filter(item=>item.id!==id))} onCreate={()=>beginAnalystAuthoring()} authoring={analystAuthoring}/><div className={styles.composerTools}>{!analystAuthoring&&onPortfolio&&iconButton(l("보유자산 사진·직접 입력","Add holdings from image or manually"),<IconPaperclip size={18}/>,()=>openPortfolio())}{!analystAuthoring&&btn(l("Analyst","Analyst"),()=>{setSettingsCategory("analysts");setSettingsOpen(true);})}{!analystAuthoring&&btn(l("자산 찾기","Find assets"),()=>{setView("chat");setChatTool(current=>current==="watchlist"?null:"watchlist");})}{!analystAuthoring&&btn(l("자료 조회","Query data"),()=>{setView("chat");setChatTool(current=>current==="sources"?null:"sources");})}</div>{busy ? <button key="finance-stop" type="button" className={styles.button} onClick={event => { event.preventDefault(); event.stopPropagation(); aiAbort.current?.abort(); aiAbort.current = null; setSelectedCandidate(null); if(chatPendingId.current)finishChat(chatPendingId.current,l("요청을 중지했습니다.","Request stopped."),"cancelled");chatPendingId.current=null;setBusy(false); setNotice(aiApplying.current?l("요청을 중지했습니다. 이미 저장 중인 변경의 결과는 확인 후 되돌릴 수 있습니다.","Stopped the request. A change already being saved may finish; use Undo after checking the result."):l("요청을 중지했습니다. 새로 도착하는 AI 제안은 적용하지 않습니다.","Stopped the request. New AI proposals from it will not be applied.")); }}>{l("중지", "Stop")}</button> : <button key="finance-send" type="submit" className={`${styles.button} ${styles.primary}`} disabled={!onAIRequest || !request.trim() || !!archivedReport || (!analystAuthoring&&selectedAnalysts.length>0&&(analystsLoading||!!analystsError||!financeAnalystPinsCurrent(selectedAnalysts,analysts)))} aria-label={l("요청하기", "Send request")} title={l("요청하기", "Send request")}><IconArrowUp size={20}/></button>}</form>{editing&&widget&&<div className={styles.context}><span className={styles.badge}>{l("선택", "Selection")}: {widget.title}</span></div>}{!onAIRequest && <p className={styles.muted}>{l("AI 실행 경로가 연결되면 현재 화면 상태로 요청할 수 있습니다. 직접 편집과 CSV 가져오기는 지금 사용할 수 있습니다.", "Connect an AI runtime to ask using the current screen state. Direct editing and CSV import are available now.")}</p>}</section>;
    return <main className={styles.root} data-testid="finance-workspace">
    <header className={styles.header}><h1 className={styles.title}>Agentlas Finance</h1><form className={styles.topSearch} onSubmit={event=>{event.preventDefault();setView("chat");setChatTool("watchlist");void runSearch();}}><input aria-label={l("자산 검색","Search assets")} placeholder={l("자산 검색","Search assets")} value={search} onChange={event=>setSearch(event.target.value)}/><button type="submit" disabled={searching||!search.trim()} aria-label={l("검색","Search")} title={l("검색","Search")}><IconSearch size={16}/></button></form><div className={styles.actions}>{saving&&<span className={styles.badge} role="status">{l("저장 중", "Saving")}</span>}{iconButton(l("CSV 가져오기", "Import CSV"),<IconFileUp size={20}/>,()=>setImportOpen(v=>!v))}{iconButton(l("되돌리기", "Undo"),<IconArrowLeft size={20}/>,()=>{void undo();},!canUndo)}{iconButton(l("다시 적용", "Redo"),<span className={styles.flipIcon}><IconArrowLeft size={20}/></span>,()=>{void redo();},!canRedo)}</div></header>
    <nav className={styles.tabs} aria-label={l("Agentlas Finance 보기","Agentlas Finance views")}>
      {([['dashboard',l("대시보드","Dashboard")],['chat','Agentlas Finance'],['artifacts',l("아티팩트","Artifacts")]] as const).map(([id,label])=><button className={styles.tab} key={id} type="button" aria-current={view===id?"page":undefined} onClick={()=>{setView(id);if(id==="dashboard")setArtifactTab("dashboard");if(id==="artifacts"){setArtifactTab("reports");setArtifactDetail(false);setEditing(false);}}}>{label}</button>)}
      <button type="button" className={styles.tab} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={()=>{setSettingsCategory("data");setSettingsOpen(true);}}>{l("설정","Settings")}</button>
    </nav>
    {view==="artifacts"&&!artifactDetail&&<><FinanceArtifactGallery reports={workspace.reports} ko={ko} onOpen={(id,sectionId)=>{setReportId(id);setSelectedSection(sectionId??"");setArchiveOpen(false);setEditing(false);setArtifactTab("reports");setArtifactDetail(true);}}/><details className={styles.sectionDetails}><summary>{l("보관함","Archives")}</summary>{archivePanel}{archiveRead&&btn(l("선택한 보관 문서 열기","Open selected archived document"),()=>setArtifactDetail(true))}</details></>}
    {view==="chat"&&<section className={`${styles.chatView} ${visibleChatMessages.length?styles.chatWithMessages:""}`} aria-label="Agentlas Finance">{analystAuthoring&&<div className={styles.analystAuthoring} role="status"><span>{l("Analyst 함께 만들기","Create an Analyst together")}</span><button type="button" className={styles.iconButton} onClick={exitAnalystAuthoring} aria-label={l("Analyst 만들기 종료","Exit Analyst creation")} title={l("종료","Exit")}><IconClose size={16}/></button></div>}<div className={styles.chatMessages} role="log" aria-live="polite">{!visibleChatMessages.length?<div className={styles.chatWelcome}><h2>{analystAuthoring?l("어떤 기준으로 찾아볼까요?","What criteria should we use?"):l("무엇을 살펴볼까요?","What would you like to explore?")}</h2><div className={styles.chatExamples}>{(analystAuthoring?[l("가치주를 찾는 기준을 함께 정리하고 싶어","Help me define criteria for finding value stocks"),l("꾸준한 배당을 받으려면 어떤 기준을 볼까?","What criteria help assess sustainable dividends?")]:[l("관심 종목의 최근 뉴스를 정리해줘","Summarize recent news for my watchlist"),l("자산배분을 계산해줘","Calculate an asset allocation"),l("가격 시나리오 차트를 만들어줘","Create a price scenario chart"),l("대시보드 구성을 바꿔줘","Edit my dashboard layout")]).map(example=><button type="button" key={example} onClick={()=>setRequest(example)}>{example}</button>)}</div></div>:visibleChatMessages.map(message=><article key={message.id} className={`${styles.chatBubble} ${message.role==="user"?styles.userBubble:styles.assistantBubble}`} aria-label={message.role==="user"?l("내 메시지","Your message"):l("AI 답변","AI response")}> {message.assetSearches?.map((entry,index)=><div key={`${message.id}:assets:${index}`}>{assetResults(entry.result,entry.query,message.assetSearchOwner!==workspace.ownerScope||message.assetSearchRevision!==workspace.revision)}</div>)}{message.status==="pending"?<p role="status">{l("응답을 기다리는 중…","Waiting for a response…")}</p>:<FinanceBriefText value={message.text} ko={ko}/>} {message.artifactReportIds?.length?<div className={styles.chatArtifacts}>{message.artifactReportIds.map(id=>workspace.reports.find(report=>report.id===id)).filter((report):report is FinanceReport=>!!report).map(report=><button type="button" key={report.id} onClick={()=>{const main=report.sections.find(section=>!!financeComputeKind(section));if(main?.projection){setChatArtifact({id:`chat:${report.id}:${main.id}`,reportId:report.id,sectionId:main.id,title:financeArtifactTitle(main.title),kind:"chart",summary:"",projection:main.projection,section:main});return;}setReportId(report.id);setArtifactTab("reports");setArtifactDetail(true);setArchiveOpen(false);setSelectedSection("");setEditing(false);setView("artifacts");}}><span>{l("아티팩트","Artifact")}</span><strong>{financeArtifactTitle(report.title)}</strong></button>)}</div>:null} {(message.status==="failed"||message.status==="cancelled")&&<button type="button" className={styles.button} onClick={()=>setRequest(message.retryText??"")}>{l("다시 요청","Retry request")}</button>}</article>)}</div>{analystDraft&&<><FinanceAnalystDraftEditor draft={analystDraft} onChange={setAnalystDraft} pending={analystsPending} working={busy} available={!!onAnalysts} ko={ko} onClose={()=>setAnalystDraft(null)} onSave={()=>{const draft=analystDraft;void changeAnalyst({action:"save",draft}).then(saved=>{if(saved){setAnalystDraft(current=>current===draft?null:current);setAnalystAuthoring(false);setNotice(l("Analyst를 저장했습니다.","Analyst saved."));}});}}/>{analystsError&&<p role="alert" className={styles.notice}>{analystsError}</p>}</>}{aiComposer}</section>}


    {(workspace.reports.length >= FINANCE_WORKSPACE_LIMITS.reports * 0.8 || workspace.sources.length >= FINANCE_WORKSPACE_LIMITS.sources * 0.8) && <p className={styles.muted}>{l("저장된 보고서", "Saved reports")} {workspace.reports.length}/{FINANCE_WORKSPACE_LIMITS.reports} · {l("자료 출처", "Sources")} {workspace.sources.length}/{FINANCE_WORKSPACE_LIMITS.sources}{workspace.reports.length >= FINANCE_WORKSPACE_LIMITS.reports * 0.8 && ` · ${l("한도 전에 필요한 보고서를 내보내고 보관 자료를 정리하세요. 기존 자료는 자동 삭제하지 않습니다.", "Export needed reports and manage saved material before reaching capacity. Existing data is never automatically deleted.")}`}</p>}
    {experienceError&&!settingsOpen&&<p className={styles.notice} role="alert">{experienceError}</p>}
    {(notice || error) && <div className={`${styles.notice} ${error ? styles.error : ""}`} role="status">{error ? <FinanceMessage value={friendlyError(error)} ko={ko} error/> : notice}</div>}
    {archivePreview&&<section className={styles.importPanel} aria-label={l("보관 전 확인","Review before archiving")}><h2>{l("원본을 보존하고 활성 목록에서 회수","Preserve originals and reclaim active capacity")}</h2><p>{archiveCounts.reports} {l("보고서","reports")} · {archiveCounts.referenced} {l("선택 보고서의 참조 출처","sources referenced by selected reports")} · {archiveCounts.reclaimable.length} {l("회수 예상 출처","sources expected to be reclaimed")} · {archiveCounts.retained} {l("계속 참조 중인 출처 유지","referenced sources retained")}</p><p className={styles.muted}>{l("보관 원본에는 전체 스냅샷을 보존합니다. 활성 가격·보유 자산·남은 보고서가 참조하는 출처는 회수하지 않습니다. 자동 정리·삭제는 실행하지 않습니다. 최종 회수 수는 저장 결과으로 확인합니다.","A full original snapshot is preserved. Sources referenced by active quotes, holdings or remaining reports stay active. Nothing is automatically cleaned up or deleted. The save result confirms final reclaimed counts.")}</p><details><summary>{l("회수 예상 출처 목록","Sources expected to be reclaimed")}</summary><ul>{archiveCounts.reclaimable.map(source=><li key={source.id}>{source.name} · {source.id}</li>)}</ul></details>{archivePreview.revision!==workspace.revision&&<p role="alert">{l("작업 공간이 바뀌었습니다. 취소 후 최신 선택으로 다시 확인하세요.","The workspace changed. Cancel and review the latest selection.")}</p>}<div className={styles.actions}>{btn(l("원본 보관 실행","Archive originals now"),()=>{void createArchive();},archiveBusy||archivePreview.revision!==workspace.revision||(!archiveCounts.reports&&!archiveCounts.reclaimable.length))}{btn(l("취소","Cancel"),()=>setArchivePreview(null),archiveBusy)}</div></section>}
    {importOpen && <section className={styles.importPanel} aria-label={l("CSV 가져오기", "CSV import")}><div className={styles.cardHead}><h2 className={styles.sectionHeading}>{l("내 자료로 시작하기", "Start with your data")}</h2>{iconButton(l("닫기", "Close"),<IconClose size={18}/>, () => setImportOpen(false))}</div><p className={styles.muted}>{l("파일을 먼저 확인한 뒤 가져옵니다. 통화·수량·가격을 임의로 채우지 않습니다.", "Review your file before importing. Missing quantities and prices are not invented.")}</p><div className={styles.actions}><label className={styles.label}>{l("CSV 파일", "CSV file")}<input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; if (!file)
        return; if (file.size > 8 * 1024 * 1024) {
        setNotice(l("8MB 이하 CSV 파일을 선택하세요.", "Choose a CSV file up to 8MB."));
        return;
    } setCsvName(file.name); setCsv(await file.text()); }}/></label><label className={styles.label}>{l("통화가 없는 행의 통화", "Currency for rows without a currency")}<select className={styles.select} value={defaultCurrency} onChange={e => setDefaultCurrency(e.target.value)}><option value="">{l("파일에 명시된 통화만", "Only explicit file currencies")}</option>{["KRW", "USD", "EUR", "JPY", "GBP"].map(c => <option key={c}>{c}</option>)}</select></label></div><details><summary className={styles.muted}>{l("CSV 내용을 붙여넣기", "Paste CSV content")}</summary><textarea className={`${styles.input} ${styles.textarea}`} aria-label="CSV" value={csv} onChange={e => setCsv(e.target.value)} placeholder="symbol,name,quantity,averageCost,currency"/></details>{imported && <div className={styles.importPreview}><strong>{csvName || l("붙여넣은 자료", "Pasted data")} · {imported.rowCount} {l("행", "rows")}</strong><p className={styles.muted}>{imported.assets.length} {l("자산", "assets")} · {imported.holdings.length} {l("보유 항목", "holdings")} · {imported.quotes.length} {l("가격 관측", "price observations")}</p>{imported.assets.length > 0 && <DataTable projection={{ columns: [l("자산", "Asset"), l("이름", "Name"), l("통화", "Currency"), l("수량", "Quantity"), l("가격", "Price")], rows: imported.assets.slice(0, 20).map(a => [a.symbol, a.name, a.currency, imported.holdings.find(h => h.assetId === a.id)?.quantity ?? null, imported.quotes.find(q => q.assetId === a.id)?.price ?? null]), status: "partial", warnings: [], asOf: null, sourceIds: [] }}/>}{imported.assets.length > 20 && <p className={styles.muted}>{l("처음 20개 자산 미리보기", "Previewing the first 20 assets")}</p>}{imported.errors.map((v, i) => <FinanceMessage key={i} value={v} ko={ko} error/>)}{imported.warnings.map((v, i) => <FinanceMessage key={i} value={v} ko={ko}/>)}{btn(l("확인한 자료 가져오기", "Import reviewed data"), () => { void importCsv(); }, saving || imported.errors.length > 0 || imported.rowCount === 0, true)}</div>}</section>}

    {view === "dashboard" && <FinanceMarketOverview feeds={onDashboardFeeds?<FinanceDashboardFeed result={feeds} loading={feedsLoading} ko={ko} onRefresh={()=>{void refreshFeeds();}} onSettings={()=>{setSettingsCategory("data");setSettingsOpen(true);}}/>:null} result={markets} loading={marketsLoading} ko={ko} watchlist={workspace.watchlist} quotes={workspace.quotes} onFind={()=>{setView("chat");setChatTool("watchlist");}} onAsset={asset=>{setDataAssetId(asset.id);setView("chat");setChatTool("sources");}} worldMap={!dashboardCustomized&&!editing?<FinanceWorldMap result={markets} loading={marketsLoading} onRefresh={()=>{void refreshMarkets();}} ko={ko}/>:null} composer={null}><FinancePortfolioPanel workspace={workspace} ko={ko} onPlanning={onPlanning} onImport={onPortfolio?()=>openPortfolio():undefined} onPlan={text=>{setRequest(text);setView("chat");}}/><div className={styles.toolbar}><div className={styles.actions}>{iconButton(l("AI로 구성","Build with AI"),<IconSparkles size={18}/>,()=>{setRequest(l("대시보드를 내 자료에 맞게 구성해줘","Build a dashboard from my saved data"));setView("chat");})}{dashboard && (dashboardCustomized||editing) && <select className={styles.select} aria-label={l("대시보드 기간", "Dashboard period")} value={dashboard.period} onChange={e => { void act({ type: "dashboard.update", dashboardId: dashboard.id, patch: { period: e.target.value as FinanceWidget["period"] } }); }}>{periods.map(p => <option key={p}>{p}</option>)}</select>}{(dashboardCustomized||editing) && onRefreshData && iconButton(refreshing ? l("갱신 중…", "Refreshing…") : l("자료 갱신", "Refresh data"), <IconRefresh size={20}/>, () => { void refreshData(); }, refreshing)}{iconButton(editing ? l("편집 완료", "Done editing") : l("화면 편집", "Edit view"), <IconEdit size={20}/>, () => setEditing(v => !v), !dashboard)}{(dashboardCustomized||editing)&&iconButton(l("보고서 만들기", "Create report"),<IconFileText size={18}/>, makeReport, !dashboard)}</div></div>{dashboard && (dashboardCustomized||editing) && <div className={`${styles.workspace} ${editing && widget ? styles.withInspector : ""}`}><div className={styles.canvas}><div className={styles.grid}>{dashboard.widgets.map((w, index) => { const effective = effectiveFinanceWidget(dashboard, w); const projection = projectFinanceWidget(workspace, effective); const savedEvidence=parseFinanceEvidenceMetric(w.metric); const computeSection=savedEvidence?workspace.reports.find(item=>item.id===savedEvidence.reportId)?.sections.find(section=>section.id===savedEvidence.sectionId):undefined; const composition=computeSection&&w.chartType!=="table"?financeReportCompositionSpec({...computeSection,projection},locale):null; const displayTitle=(computeSection&&financeReportCompositionTitle(computeSection,locale))??(savedEvidence?financeCompactTreasuryTitle(w.title,projection,savedSeries[w.id]):w.title); if (w.hidden || w.type==="sources")
        return null; return <section className={`${styles.card} ${w.width === "full" ? styles.wide : ""} ${selected === w.id ? styles.selected : ""}`} key={w.id} aria-label={displayTitle}><div className={styles.cardHead}><button type="button" className={styles.cardTitle} onClick={() => { setSelected(w.id); setEditing(true); }}>{displayTitle}</button></div>{composition?<ChartBlock code={JSON.stringify(composition)} presetSpec={composition} blockId={`finance-pinned-composition:${w.id}`} size="panel" showMenu={false} showDiagnostics={false} fallback={<p>{l("차트를 표시하지 못했습니다.","Chart unavailable.")}</p>}/>:computeSection&&financeComputeKind(computeSection)?<FinanceComputeView section={{...computeSection,projection}} ko={ko} compact showVisual={w.chartType!=="table"}/>:savedEvidence?<FinanceDataResultView result={financeFrozenDataResult(projection,workspace.sources)} locale={ko?"ko":"en"} title={displayTitle} compact showVisual={w.chartType!=="table"} chartType={w.chartType} selectedSeries={savedSeries[w.id]} onSeriesChange={series=>setSavedSeries(current=>({...current,[w.id]:series}))}/>:<Projection widget={effective} projection={projection} ko={ko} compact/>}{editing && <div className={styles.cardControls}>{btn(l("위로", "Up"), () => move(w.id, index - 1), index === 0)}{btn(l("아래로", "Down"), () => move(w.id, index + 1), index === dashboard.widgets.length - 1)}{btn(w.width === "full" ? l("반 너비", "Half width") : l("전체 너비", "Full width"), () => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { width: w.width === "full" ? "half" : "full" } }); })}{btn(l("숨기기", "Hide"), () => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { hidden: true } }); })}</div>}</section>; })}</div>{editing && <div className={styles.actions} style={{ marginTop: 18 }}>{dashboard.widgets.filter(w => w.hidden&&w.type!=="sources").map(w => <button type="button" className={styles.button} key={w.id} onClick={() => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { hidden: false } }); }}>{l("복원", "Restore")}: {w.title}</button>)}{types.map(type => <button type="button" className={styles.button} key={type} onClick={() => addWidget(type)}>+ {labels[type][ko ? 0 : 1]}</button>)}</div>}{!dashboard.widgets.some(w => !w.hidden&&w.type!=="sources") && <div className={styles.empty}>{l("화면 편집에서 첫 블록을 추가하세요.", "Add your first block in Edit view.")}</div>}</div>{editing && widget && <aside className={styles.inspector}><div className={styles.cardHead}><h3>{l("블록 설정", "Block settings")}</h3>{btn(l("닫기", "Close"), () => setSelected(""))}</div><label className={styles.label}>{l("제목", "Title")}<DraftField value={widget.title} label={l("블록 제목", "Block title")} onCommit={title => updateWidget({ title })}/></label>{widget.type === 'chart' && !parseFinanceEvidenceMetric(widget.metric) && <><label className={styles.muted}><input type="checkbox" checked={widget.periodMode === "pinned"} onChange={e => updateWidget({ periodMode: e.target.checked ? "pinned" : "inherit", period: effectiveFinanceWidget(dashboard, widget).period })}/>{l(" 이 블록 기간 고정", " Pin this block period")}</label><label className={styles.label}>{l("기간 · 이 블록", "Period · this block")}<select className={styles.select} value={widget.period} onChange={e => updateWidget({ period: e.target.value as FinanceWidget["period"], periodMode: "pinned" })}>{periods.map(p => <option key={p}>{p}</option>)}</select></label></>}<label className={styles.label}>{l("표현", "Display")}<select className={styles.select} value={compositionWidget&&widget.chartType!=="table"?"bar":widget.chartType} onChange={e => updateWidget({ chartType: e.target.value as FinanceWidget["chartType"] })}>{(compositionWidget?["table","bar"]:["table","line","bar"]).map(p => <option key={p} value={p}>{compositionWidget?(p==="bar"?l("도넛","Donut"):l("표","Table")):p}</option>)}</select></label>{!parseFinanceEvidenceMetric(widget.metric) && !["sources", "notes", "events"].includes(widget.type) && <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className={styles.muted}>{l("자산 · 비워두면 전체", "Assets · empty means all")}</legend>{workspace.watchlist.map(a => <label key={a.id} className={styles.muted}><input type="checkbox" checked={widget.assetIds.includes(a.id)} onChange={e => updateWidget({ assetIds: e.target.checked ? [...widget.assetIds, a.id] : widget.assetIds.filter(id => id !== a.id) })}/> {a.symbol} · {a.exchange}</label>)}</fieldset>}<label className={styles.label}>{l("메모", "Notes")}<DraftField multiline value={widget.notes} label={l("블록 메모", "Block notes")} onCommit={notes => updateWidget({ notes })}/></label>{parseFinanceEvidenceMetric(widget.metric)&&<><p className={styles.muted}>{l("숨기기는 저장 자료 참조를 유지합니다. 고정 해제는 이 블록만 제거하며 원본 보고서는 보존합니다.","Hiding keeps the saved evidence reference. Unpinning removes this block and preserves the source report.")}</p>{btn(l("고정 해제","Unpin saved evidence"),()=>{void act({type:"widget.remove",dashboardId:dashboard.id,widgetId:widget.id}).then(saved=>{if(saved)setSelected("");});},saving)}</>}<p className={styles.muted}>{l("이 블록의 조건만 변경합니다. 다른 블록과 보고서의 고정 자료는 유지됩니다.", "Changes affect this block. Other blocks and frozen reports are preserved.")}</p></aside>}</div>}</FinanceMarketOverview>}
    {view==="chat" && chatTool === "watchlist" && <section id="finance-chat-tool-panel" tabIndex={-1} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setChatTool(null);}}} className={styles.toolsPanel} aria-label={l("자산 찾기 도구","Asset search tools")}><div className={styles.toolsHead}>{iconButton(l("닫기","Close"),<IconClose size={18}/>,()=>setChatTool(null))}</div><h2 className={styles.sectionHeading}>{l("자산 찾기", "Find assets")}</h2><form className={styles.search} onSubmit={e => { e.preventDefault(); void runSearch(); }}><input className={styles.input} aria-label={l("자산 이름 또는 티커", "Asset name or symbol")} placeholder={l("회사명 또는 티커 검색", "Search a name or symbol")} value={search} onChange={e => setSearch(e.target.value)}/><button className={`${styles.button} ${styles.primary}`} disabled={searching || !search.trim()}>{searching ? l("검색 중…", "Searching…") : l("찾기", "Search")}</button></form>{searchEvidence&&assetResults(searchEvidence)}{workspace.watchlist.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr>{[l("자산", "Asset"), l("거래소 · 통화", "Exchange · currency"), l("보유", "Holding"), l("작업", "Actions")].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{workspace.watchlist.map(a => <tr key={a.id}><td className={styles.assetIdentity}><strong>{a.symbol}</strong><span className={styles.cellName} title={a.name}>{a.name}</span></td><td>{a.exchange || "—"} · {a.currency === "XXX" ? l("통화 미확인", "Currency unknown") : a.currency}</td><td>{workspace.holdings.filter(h => h.assetId === a.id).reduce((sum, h) => sum + h.quantity, 0).toLocaleString()}</td><td><div className={styles.actions}>{onOpenResearch && btn(l("조사 이어가기", "Continue research"), () => { void Promise.resolve(onOpenResearch(a)).catch(() => setNotice(l("조사 작업을 열지 못했습니다.", "Could not open the research task."))); })}{btn(l("제거", "Remove"), () => { void act({ type: "watchlist.remove", assetId: a.id }); }, workspace.holdings.some(h => h.assetId === a.id))}</div></td></tr>)}</tbody></table></div> : <div className={styles.empty}>{l("검색하거나 CSV를 가져와 관심 자산을 추가하세요.", "Search or import a CSV to add your assets.")}</div>}</section>}
    {view==="artifacts" && artifactDetail && <section><div className={styles.toolbar}>{iconButton(l("아티팩트로 돌아가기","Back to artifacts"),<IconArrowLeft size={18}/>,()=>{setArtifactDetail(false);setEditing(false);})}<div className={styles.actions}><select className={`${styles.select} ${styles.reportPicker}`} aria-label={l("보고서 선택", "Choose report")} value={archiveOpen?"":report?.id || ""} disabled={archiveOpen} onChange={e => setReportId(e.target.value)}>{!workspace.reports.length && <option value="">{l("저장된 보고서 없음", "No saved reports")}</option>}{workspace.reports.map(r => <option value={r.id} key={r.id}>{financeArtifactTitle(r.title)}</option>)}</select>{!archiveOpen&&iconButton(l("새 보고서", "New report"),<IconFileText size={18}/>, makeReport, !dashboard)}</div>{report && <div className={styles.actions}>{!archivedReport&&iconButton(editing ? l("편집 완료", "Done editing") : l("문서 편집", "Edit document"),editing?<IconCheck size={18}/>:<IconEdit size={18}/>, () => setEditing(v => !v))}{iconButton(l("내보내기", "Export"),<IconDownload size={18}/>, exportReport)}</div>}</div><details className={styles.sectionDetails}><summary>{l("보관함", "Archives")}</summary>{archivePanel}</details>{report ? !reportEditing ? <FinanceReportView report={report} locale={locale}/> : <article className={styles.report}><div className={styles.eyebrow}>{archivedReport?l("보관 원본 · 읽기 전용","Archived original · read only"):l("보고서", "Report")}</div>{reportEditing ? <label className={styles.label}>{l("보고서 제목", "Report title")}<DraftField value={report.title} label={l("보고서 제목", "Report title")} onCommit={title => { if (title.trim())
        void act({ type: "report.update", reportId: report.id, patch: { title } }); }}/></label> : <h2 className={styles.reportTitle}>{financeArtifactTitle(report.title)}</h2>}{reportEditing&&<details className={styles.sectionDetails}><summary>{l("문서 정보", "Document information")}{report.reviewPending?` · ${l("검토 필요", "Review needed")}`:""}</summary><p className={styles.muted}>{date(report.createdAt)} · {l("자료 판본", "Data revision")} {report.sourceRevision} · {l("대시보드 변경과 독립된 고정 결과", "Frozen results, independent of dashboard edits")}</p>{report.reviewPending && <div className={styles.notice}>{l("서술 검토가 필요한 초안입니다. 숫자·조건·근거와 문장이 일치하는지 확인하세요.", "This draft needs narrative review. Check that its text matches the figures, conditions and evidence.")}{!archivedReport&&btn(l("문장 검토 완료 표시", "Mark narrative reviewed"), () => { void act({ type: "report.update", reportId: report.id, patch: { reviewPending: false } }, l("사용자 검토 표시를 저장했습니다. 자동 사실 검증 결과가 아닙니다.", "Saved your review mark. This is not an automated fact check.")); })}</div>}<div className={styles.actions}>{!archivedReport&&(report.dashboardSnapshot ? btn(l("새 자료로 별도 버전 만들기", "Create a refreshed version"), () => { void dispatch({ type: "report.refresh", reportId: report.id }).then(saved => { setReportId(saved.reports[saved.reports.length - 1].id); setNotice(l("기존 문장과 보고서를 보존하고 새 버전을 만들었습니다.", "Preserved the original report and text in a new version.")); }).catch(() => setNotice(l("보고서를 갱신하지 못했습니다.", "Could not refresh the report."))); }) : btn(l("원자료를 다시 조회", "Retrieve source data again"), () => { setDataResult(null); setTab("sources"); }))}</div></details>}{report.sections.map((section, index) => {if(!reportEditing&&(financeReportMetadataOnly(section)||(report.sections.some(item=>!!financeComputeKind(item))&&section.kind==="sources")))return null;const sectionContent=<section id={`finance-report-section-${section.id}`} className={`${styles.reportSection} ${selectedSection === section.id ? styles.selected : ""}`} key={section.id} onClick={() => setSelectedSection(section.id)}><div className={styles.cardHead}>{reportEditing ? <DraftField value={financeStatus(section.title,ko)} label={l("섹션 제목", "Section title")} onCommit={title => { if (title.trim())
        void act({ type: "report.section.update", reportId: report.id, sectionId: section.id, patch: { title } }); }}/> : <h3>{financeArtifactTitle(financeStatus(section.title,ko))}</h3>}{reportEditing&&<span className={styles.badge}>{section.projection ? l("고정 관측", "Frozen data") : l("서술", "Narrative")}</span>}</div>{reportEditing ? <DraftField multiline value={financeMessage(section.narrative,ko)} label={l("섹션 본문", "Section narrative")} onCommit={narrative => { void act({ type: "report.section.update", reportId: report.id, sectionId: section.id, patch: { narrative } }); }}/> : section.narrative ? <FinanceBriefText value={financeMessage(section.narrative,ko)} ko={ko}/> : section.kind === 'summary' ? <p className={styles.muted}>{l("문서 편집에서 핵심 판단과 확인할 가정을 작성하세요.", "Write your conclusions and assumptions in Edit document.")}</p> : null}{section.projection && <>{reportEditing&&btn(l("고정","Pin"),()=>{void pinReportSection(section);},saving)}{financeComputeKind(section)||financeComputeMetrics(section)?<FinanceComputeView section={section} ko={ko}/>:section.widget&&!parseFinanceEvidenceMetric(section.widget.metric)?<Projection widget={section.widget} projection={section.projection} ko={ko} inspect={reportEditing}/>:<FinanceDataResultView key={`${report.id}:${section.id}`} result={financeFrozenDataResult(section.projection, archivedReport ? archiveRead!.workspaceSnapshot.sources : workspace.sources)} locale={ko?"ko":"en"} compact showVisual={section.widget?.chartType!=="table"} chartType={section.widget?.chartType}/>}</>}{reportEditing && <div className={styles.cardControls}>{btn(l("위로", "Up"), () => { void act({ type: "report.section.move", reportId: report.id, sectionId: section.id, index: index - 1 }); }, index === 0)}{btn(l("아래로", "Down"), () => { void act({ type: "report.section.move", reportId: report.id, sectionId: section.id, index: index + 1 }); }, index === report.sections.length - 1)}{btn(l("섹션 숨기기", "Hide section"), () => { void act({ type: "report.section.remove", reportId: report.id, sectionId: section.id }); })}</div>}</section>;return sectionContent;})}</article> : <div className={styles.empty}>{l("대시보드의 조건과 자료를 고정한 보고서를 만드세요. 제목·서술·섹션 순서를 직접 편집할 수 있습니다.", "Create a frozen report from your dashboard. Edit the title, narrative and section order.")}</div>}</section>}
    {view==="chat" && chatTool === "sources" && <section id="finance-chat-tool-panel" tabIndex={-1} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setChatTool(null);}}} className={styles.toolsPanel} aria-label={l("자료 조회 도구","Data query tools")}><div className={`${styles.toolsHead} ${styles.queryHead}`}><h2 className={styles.sectionHeading}>{l("자료 조회","Query data")}</h2>{iconButton(l("닫기","Close"),<IconClose size={18}/>,()=>setChatTool(null))}</div><div className={styles.queryBody}>{globalDataMetric&&<label className={styles.label}>{l("검색어 · 계정","Query or author")}<input className={styles.input} value={dataQueryText} onChange={e=>setDataQueryText(e.target.value)} placeholder={l("예: @federalreserve.gov 또는 조사 키워드","e.g. @federalreserve.gov or research keyword")}/></label>}<form onSubmit={e => { e.preventDefault(); void queryData(); }}>{!globalDataMetric&&<label className={styles.label}>{l("자산", "Asset")}<select className={styles.select} value={dataAssetId || (workspace.watchlist.length === 1 ? workspace.watchlist[0].id : "")} onChange={e => { queryAbort.current?.abort(); setQuerying(false); setDataResult(null); setDataAssetId(e.target.value); }}><option value="">{l("관심 자산을 선택하세요", "Choose a saved asset")}</option>{workspace.watchlist.map(asset => <option key={asset.id} value={asset.id}>{asset.symbol} · {asset.name} · {asset.exchange}</option>)}</select></label>}{dataMetric==="treasury_yields"&&<label className={styles.label}>{l("조회 월","Month")}<input type="month" className={styles.input} min="2000-01" max="2099-12" value={treasuryMonth} onChange={e=>{queryAbort.current?.abort();setQuerying(false);setDataResult(null);setTreasuryMonth(e.target.value);}}/></label>}<div className={styles.actions} style={{ marginTop: 12 }}><select className={styles.select} value={dataMetric} onChange={e => { queryAbort.current?.abort(); setQuerying(false); setDataResult(null); setDataQueryText(""); setDataMetric(e.target.value); }} aria-label={l("자료 종류", "Data category")}>{[["price", l("가격", "Prices")], ["price_history", l("가격 이력", "Price history")], ["news", l("뉴스", "News")], ["filings", l("공시", "Filings")], ["social", l("공식 계정 글", "Author posts")], ["social_search",l("SNS 키워드 검색","Social keyword search")], ["company_facts",l("기업 재무","Company facts")], ["macro_news",l("거시 뉴스","Macro news")], ["treasury_yields",l("국채 수익률","Treasury yields")], ["etf_holdings", l("ETF 편입", "ETF holdings")],["nav",l("펀드 NAV","Fund NAV")]].map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select><button className={`${styles.button} ${styles.primary}`} disabled={!onQueryData || querying || dataSaving || (!dataQueryText.trim()&&!dataAssetId&&workspace.watchlist.length!==1&&!["social","macro_news","treasury_yields"].includes(dataMetric))}>{querying ? l("조회 중…", "Querying…") : l("자료 조회", "Retrieve data")}</button>{querying && btn(l("중지", "Stop"), () => { queryAbort.current?.abort(); setQuerying(false); })}</div></form>{dataResult && <div className={styles.importPreview}>{dataResult.rows.length>0&&btn(onQueryAndSave?l("다시 조회해 저장","Retrieve again and save"):l("저장","Save"),()=>{void (onQueryAndSave?persistDataResult("report"):saveDataReport());},dataSaving||querying)}<FinanceDataResultView key={`${lastDataRequest?.metrics[0]}:${dataResult.retrievedAt}`} result={dataResult} metric={lastDataRequest?.metrics[0]} locale={ko?"ko":"en"} compact/></div>}{!onQueryData && <p className={styles.muted}>{l("자료 조회 실행 경로가 연결되지 않았습니다.", "The data-query runtime is not connected.")}</p>}</div></section>}
    {view==="chat"&&aiReceipt&&<details className={styles.receipt} aria-label={l("AI 실행과 화면 변경 기록","AI execution and screen change record")}><summary>{l("변경 내역","Changes")}</summary><h3>{l("방금 요청한 작업","Your latest request")}</h3><span className={styles.badge}>{financeStatus(aiReceipt.status||"ok",ko)}</span><div className={styles.evidenceChips}><span className={styles.badge}>{aiReceipt.savedRevision===null?l("답변만 · 저장 변경 없음","Answer only · no saved changes"):`${l("저장됨","Saved")} v${aiReceipt.savedRevision}`}</span>{aiReceipt.runtime&&<span className={styles.badge}>{aiReceipt.runtime.kind} · {aiReceipt.runtime.model||l("모델 미확인","Model unspecified")}</span>}<span className={styles.badge}>{aiReceipt.operations.length} {l("개 변경 제안","proposed changes")}</span></div><FinanceMessage value={aiReceipt.message} ko={ko}/>{aiReceipt.operations.length>0&&<details><summary className={styles.muted}>{l("적용 요청 내역","Requested changes")}</summary><ul>{aiReceipt.operations.map((operation,index)=><li key={index} className={styles.muted}>{financeStatus(operation.type,ko)}</li>)}</ul></details>}<p className={styles.muted}>{l("AI가 작성한 문장과 실제 자료 조회·저장 결과를 구분해 확인하세요.","Distinguish generated text from actual data retrieval and saved results.")}</p></details>}
    {chatArtifact&&<FinanceArtifactChartViewer card={chatArtifact} ko={ko} onClose={()=>setChatArtifact(null)} onOpenDocument={()=>{const id=chatArtifact.reportId;setChatArtifact(null);if(!workspace.reports.some(report=>report.id===id)){setNotice(l("문서를 찾을 수 없습니다.","Document not found."));return;}setReportId(id);setArtifactTab("reports");setArtifactDetail(true);setArchiveOpen(false);setSelectedSection("");setEditing(false);setView("artifacts");}}/>}
    {portfolioOpen&&onPortfolio&&<FinancePortfolioImport key={workspace.ownerScope??"local"} ko={ko} locale={locale} revision={workspace.revision} initialFiles={portfolioFiles} onPortfolio={onPortfolio} onClose={()=>{setPortfolioOpen(false);setPortfolioFiles([]);}} onSaved={message=>setNotice(message)}/>}
    <FinanceSettingsDialog open={settingsOpen} ko={ko} state={experience} pending={experiencePending} preparing={experiencePreparing} error={experienceError} onClose={()=>setSettingsOpen(false)} onChange={updateExperience} initialCategory={settingsCategory} analystContent={<FinanceAnalysts items={analysts} loading={analystsLoading} pending={analystsPending||busy} error={onAnalysts?analystsError:l("이 앱에서는 Analyst를 사용할 수 없습니다.","Analysts are unavailable in this app.")} available={!!onAnalysts} ko={ko} onRefresh={()=>void refreshAnalysts()} onCoCreate={beginAnalystAuthoring} onSave={(draft,id,expectedRevision)=>changeAnalyst({action:"save",draft,...(id?{id,expectedRevision}:{})})} onRemove={item=>changeAnalyst({action:"remove",id:item.id,expectedRevision:item.revision})}/>} dataConnections={<FinanceDataConnections ko={ko} onConnect={onConnectData} onInspect={onInspectData}/>} monitorContent={monitorContent}/>
  </main>;
}
