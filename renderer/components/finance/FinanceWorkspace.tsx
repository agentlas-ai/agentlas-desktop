"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { ChartBlock } from "@/components/ChartBlock";
import { useFinanceStore } from "@/lib/finance-store";
import { FINANCE_WORKSPACE_LIMITS, createFinanceDashboard, createFinanceReport, createFinanceWidget, exportFinanceCsv, importFinanceCsv, projectFinanceWidget, effectiveFinanceWidget, financeId, type FinanceArchiveRequest, type FinanceArchiveResult, type FinanceArchiveItem, type FinanceMonitorRunsResult, type FinanceAsset, type FinanceReport, type FinanceSource, type FinanceOperation, type FinanceWidget, type FinanceMonitor, type FinanceMonitorRun, type FinanceAIResult, type FinanceSearchResult, type FinanceDataRequest, type FinanceDataResult, type FinanceWidgetProjection, type FinanceWorkspace as Workspace, } from "@shared/finance";
import styles from "./FinanceWorkspace.module.css";
import { FinanceMonitorReceipts, FinanceBriefText } from "./FinanceMonitorReceipts";
import { FinanceMessage, financeMessage, financeStatus, financeColumn, financeCell } from "./FinanceMessage";
export interface FinanceAIContext {
    dashboardId: string | null;
    reportId?: string | null;
    selectedSectionId?: string | null;
    selectedWidgetId: string | null;
    revision: number;
    workspace: Workspace;
    signal: AbortSignal;
    requestId: string;
}
export interface FinanceWorkspaceProps {
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
const types: FinanceWidget["type"][] = ["watchlist", "holdings", "comparison", "chart", "allocation", "notes", "sources", "events"];
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

function DataTable({ projection }: {
    projection: FinanceWidgetProjection;
}) {
    const { locale } = useT();

    return <div className={styles.scroll}><table className={styles.table}><thead><tr>{projection.columns.map((column, index) => <th key={index} scope="col">{financeColumn(column,locale === "ko")}</th>)}</tr></thead><tbody>{projection.rows.slice(0, 500).map((row, index) => <tr key={index}>{row.map((value, i) => <td key={i} className={typeof value === "number" ? styles.number : undefined}>{typeof value === "string" && /^https:\/\//i.test(value) ? <a className={styles.link} href={value} title={value} target="_blank" rel="noopener noreferrer">{locale === "ko" ? "원문 열기" : "Open source"}</a> : financeCell(value,projection.columns[i],locale === "ko")}</td>)}</tr>)}</tbody></table></div>;
}
function Projection({ widget, projection, ko }: {
    widget: FinanceWidget;
    projection: FinanceWidgetProjection;
    ko: boolean;
}) {
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
    {projection.status === "empty" || projection.status === "unsupported" ? <div className={styles.empty}>{ko ? "이 블록에 표시할 확인된 자료가 없습니다." : "No verified data is available for this block."}</div> : chartable ? <ChartBlock code={JSON.stringify(spec)} presetSpec={spec} blockId={`finance:${widget.id}`} size="panel" fallback={<DataTable projection={projection}/>}/> : <DataTable projection={projection}/>}
    {projection.rows.length > 5000 && chartable && <p className={styles.muted}>{ko ? "처음 5,000개 관측 표시 · CSV로 전체 내보내기" : "First 5,000 observations shown · export all as CSV"}</p>}{projection.rows.length > 500 && !chartable && <p className={styles.muted}>{ko ? "처음 500개 행 표시 · CSV로 전체 내보내기" : "First 500 rows shown · export all rows as CSV"}</p>}
    {widget.chartType !== "table" && !chartable && projection.rows.length > 0 && <p className={styles.muted}>{ko ? "호환되는 단위·시계열을 확인할 수 없어 원자료 표로 표시합니다." : "Showing source data as a table: compatible units or history are unavailable."}</p>}{projection.warnings.map((warning, i) => <FinanceMessage key={i} value={warning} ko={ko}/>)}
  </>;
}
export function FinanceWorkspace({ onSearch, onAIRequest, onExport, onOpenResearch, onRefreshData, onScheduleMonitor, onQueryData, onPauseMonitor, onConnectData, onRunMonitor, onMonitorRuns, onQueryAndSave, onArchives }: FinanceWorkspaceProps) {
    const { locale } = useT();
    const ko = locale === "ko";
    const l = (k: string, e: string) => ko ? k : e;
    const store = useFinanceStore();
    const { workspace, loading, saving, error, dispatch, undo, redo, canUndo, canRedo } = store;
    const [tab, setTab] = useState<Tab>("dashboard");
    const [editing, setEditing] = useState(false);
    const [selected, setSelected] = useState("");
    const [notice, setNotice] = useState("");
    const [request, setRequest] = useState("");
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<FinanceAsset[]>([]);
    const [searchEvidence, setSearchEvidence] = useState<FinanceSearchResult | null>(null);
    const [dataAssetId, setDataAssetId] = useState("");
    const [dataQueryText,setDataQueryText]=useState("");
    const [lastDataRequest,setLastDataRequest]=useState<FinanceDataRequest|null>(null);
    const [dataSaving,setDataSaving]=useState(false);
    const [aiReceipt,setAIReceipt]=useState<{message:string;runtime?:FinanceAIResult["runtime"];status?:FinanceAIResult["status"];operations:FinanceOperation[];savedRevision:number|null}|null>(null);
    const [providerKey,setProviderKey]=useState("");
    const [connecting,setConnecting]=useState(false);
    const [dataMetric, setDataMetric] = useState("price");
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
    useEffect(() => () => { aiAbort.current?.abort(); searchAbort.current?.abort(); queryAbort.current?.abort(); refreshAbort.current?.abort(); }, []);
    const dashboard = workspace.dashboards.find(d => d.id === workspace.activeDashboardId) ?? workspace.dashboards[0];
    const widget = dashboard?.widgets.find(w => w.id === selected);
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
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        setSearching(true);
        setResults([]);
        try {
            const local = workspace.watchlist.filter(a => `${a.symbol} ${a.name} ${a.exchange}`.toLowerCase().includes(search.toLowerCase()));
            const evidence = onSearch ? await onSearch(search, controller.signal) : { assets: local, provider: "local", asOf: null, warnings: [] };
            const found = evidence.assets;
            if (!controller.signal.aborted) {
                setResults(found);
                setSearchEvidence(evidence);
                setNotice(onSearch ? l("검색 결과입니다. 거래소·통화를 확인해 추가하세요.", "Check the exchange and currency before adding a result.") : l("저장한 관심 자산에서 검색했습니다. 외부 검색은 연결되지 않았습니다.", "Searched saved assets. External search is not connected."));
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
        if(archivedReport){setNotice(l("보관 원본은 읽기 전용입니다. 편집하려면 보고서를 복원하세요.","Archived originals are read only. Restore the report to edit it."));return;}
        if (!request.trim() || !onAIRequest || busy)
            return;
        const controller = new AbortController();
        aiAbort.current = controller;
        const base = workspace;
        setBusy(true);
        setAIReceipt(null);
        try {
            const response = await onAIRequest(request.trim(), { workspace: base, dashboardId: tab === "reports" ? null : dashboard?.id ?? null, selectedWidgetId: tab === "dashboard" ? selected || null : null, revision: base.revision, reportId: tab === "reports" ? report?.id ?? null : null, selectedSectionId: tab === "reports" ? selectedSection || null : null, signal: controller.signal, requestId: crypto.randomUUID() });
            if (controller.signal.aborted)
                return;
            if (latest.current.revision !== response.baseRevision) {
                setNotice(l("화면이 먼저 변경되어 AI 제안을 적용하지 않았습니다. 현재 상태로 다시 요청하세요.", "The screen changed before the response arrived. Ask again using the current state."));
                return;
            }
            let savedRevision: number | null = null;
            if (response.operations?.length) {
                aiApplying.current = true;
                try { savedRevision = (await dispatch(response.operations, response.baseRevision)).revision; }
                finally { aiApplying.current = false; }
                if(controller.signal.aborted){
                    if(!aiAbort.current)setNotice(l("중지 전에 시작한 화면 변경이 저장되었습니다. 되돌리기로 취소할 수 있습니다.","A screen change already applying before Stop was saved. Use Undo to revert it."));
                    return;
                }
            }
            setNotice(savedRevision === null
                ? `${l("AI 답변", "AI response")}: ${response.message}`
                : `${l("화면 변경을 저장했습니다", "Screen changes saved")} · v${savedRevision}. ${response.message}`);
            setAIReceipt({message:response.message,runtime:response.runtime,status:response.status,operations:response.operations??[],savedRevision});
            setRequest("");
        }
        catch {
            if (!controller.signal.aborted)
                setNotice(l("AI 요청을 완료하지 못했습니다. 직접 편집은 계속할 수 있습니다.", "The AI request failed. You can continue editing directly."));
        }
        finally {
            if (aiAbort.current === controller) {
                setBusy(false);
                aiAbort.current = null;
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
        const lines = [`# ${exported.title}`, "", `> ${l("고정 스냅샷", "Frozen snapshot")} · ${date(exported.createdAt)} · ${l("자료 판본", "Data revision")} ${exported.sourceRevision}${exported.reviewPending ? ` · ${l("서술 검토 필요", "Narrative review needed")}` : ""}`, ""];
        for (const section of exported.sections) {
            lines.push(`## ${financeStatus(section.title,ko)}`, "");
            if (section.narrative)
                lines.push(financeMessage(section.narrative,ko), "");
            const projection = section.projection;
            if (projection) {
                const safe = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
                lines.push(`| ${projection.columns.map(column=>safe(financeColumn(column,ko))).join(" | ")} |`, `| ${projection.columns.map(() => "---").join(" | ")} |`, ...projection.rows.map(row => `| ${row.map((value,i)=>safe(financeCell(value,projection.columns[i],ko))).join(" | ")} |`), "", ...projection.warnings.map(w => `> ${financeMessage(w,ko)}`), "", `${l("관측 기준", "As of")}: ${date(projection.asOf)} · ${l("출처", "Sources")}: ${projection.sourceIds.length}`, "");
            }
        }
        await download(`finance-report-${exported.id.replace(/[^a-zA-Z0-9_-]/g, "")}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
        } catch { setNotice(l("저장 결과를 확인한 뒤 다시 내보내세요. 파일을 만들지 않았습니다.", "Confirm the saved changes before exporting again. No file was created.")); }
    };
    const refreshData = async () => {
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
        const selectedAsset = workspace.watchlist.find(asset => asset.id === dataAssetId) ?? (workspace.watchlist.length === 1 ? workspace.watchlist[0] : undefined);
        if (!onQueryData || (!selectedAsset && !dataQueryText.trim() && !["social","macro_news","treasury_yields"].includes(dataMetric)))
            return;
        queryAbort.current?.abort();
        const controller = new AbortController();
        queryAbort.current = controller;
        setQuerying(true);
        try {
            const queryRequest:FinanceDataRequest={query:dataQueryText.trim() || selectedAsset?.symbol || "",assetIds:selectedAsset?[selectedAsset.id]:[],metrics:[dataMetric],period:dashboard?.period || "1Y"};
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
            const receipt=await onQueryAndSave({...lastDataRequest,mode,expectedRevision:current.revision,title:`${lastDataRequest.query} · ${l("자료 검토","Source review")}`},controller.signal);
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
    if (loading)
        return <main className={styles.root}><p className={styles.skeleton} role="status">{l("Finance 작업 공간을 여는 중…", "Opening Finance…")}</p></main>;
    const archivePanel=onArchives&&<div className={styles.importPanel}>
      <div className={styles.actions}>{btn(archiveOpen?l("활성 보고서로","Active reports"):l("보관함 열기","Open archives"),()=>{setArchiveOpen(!archiveOpen);setEditing(false);if(!archiveOpen)void loadArchives();},archiveBusy)}
      {!archiveOpen&&btn(l("선택 보고서 보관 준비","Prepare selected reports for archive"),()=>setArchivePreview({revision:workspace.revision,reportIds:archiveSelection}),archiveBusy||!archiveSelection.length)}</div>
      {!archiveOpen&&<details><summary>{l("보관할 보고서 선택","Select reports to archive")} · {archiveSelection.length}</summary>{btn(workspace.reports.length>0&&workspace.reports.every(r=>archiveSelection.includes(r.id))?l("선택 해제","Clear selection"):l("전체 선택","Select all"),()=>setArchiveSelection(workspace.reports.length>0&&workspace.reports.every(r=>archiveSelection.includes(r.id))?[]:workspace.reports.map(r=>r.id)),archiveBusy||!workspace.reports.length)}<div className={styles.list}>{workspace.reports.map(r=><label key={r.id} className={styles.muted}><input type="checkbox" checked={archiveSelection.includes(r.id)} onChange={e=>setArchiveSelection(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title}</label>)}</div></details>}
      {archiveOpen&&<><p className={styles.muted}>{l("원본을 보존한 읽기 전용 보관함입니다. 열기·내보내기는 복원하지 않습니다.","Read-only originals. Opening or exporting an archive does not restore it.")}</p>
        {archiveItems.map(item=><div key={item.archiveId} className={styles.listItem}><strong>{item.reportTitles.join(" · ")||l("참조없는 출처 보관","Unreferenced sources")}</strong><p className={styles.muted}>{date(item.createdAt)} · {item.reportCount} {l("보고서","reports")} · {item.sourceCount} {l("스냅샷 출처","snapshot sources")}</p>{btn(l("원본 열기","Open original"),()=>{void readArchive({action:"read",archiveId:item.archiveId});},archiveBusy)}</div>)}
        {archiveCursor&&btn(l("보관 이력 더 보기","Load older archives"),()=>{void loadArchives(archiveCursor);},archiveBusy)}{!archiveItems.length&&!archiveBusy&&!archiveRead&&<p className={styles.muted}>{l("표시할 보관 목록이 없습니다.","No archives to display.")}</p>}{archiveRead&&!archiveItems.length&&btn(l("보관 목록 불러오기","Load archive list"),()=>{void loadArchives();},archiveBusy)}
        {archiveRead&&<div className={styles.receipt}><p className={styles.muted}>{l("보관 무결성 식별자","Archive integrity identifier")}: <span style={{overflowWrap:"anywhere"}}>{archiveRead.sha256}</span></p>{archiveRead.warnings.map((warning,index)=><FinanceMessage key={index} value={warning} ko={ko}/>)}
          <select className={styles.select} aria-label={l("보관 보고서 선택","Choose archived report")} value={archiveReportId} onChange={e=>setArchiveReportId(e.target.value)}>{!archiveRead.reportIds.length&&<option value="">{l("보관 보고서 없음 · 출처 원본만 보관","Sources-only archive")}</option>}{archiveRead.workspaceSnapshot.reports.filter(r=>archiveRead.reportIds.includes(r.id)).map(r=><option value={r.id} key={r.id}>{r.title}</option>)}</select>
          {btn(l("보관판 전체 JSON 저장","Save complete archive as JSON"),()=>{void exportArchive();},archiveBusy)}<p className={styles.muted}>{l("전체 원본과 출처·이용 조건을 함께 저장합니다. 파일 내보내기는 활성 자료를 복원하지 않습니다.","Exports the complete original with its source records and usage notes. Exporting does not restore active data.")}</p>
          {archiveRead.reportIds.length>0&&<details><summary>{l("선택 보고서 복원","Restore selected reports")}</summary>{archiveRead.workspaceSnapshot.reports.filter(r=>archiveRead.reportIds.includes(r.id)).map(r=><label key={r.id} className={styles.label}><span><input type="checkbox" checked={archiveRestoreIds.includes(r.id)} onChange={e=>setArchiveRestoreIds(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title}</span></label>)}<p className={styles.muted}>{l("활성 보고서·출처 한도 또는 변경 충돌 시 복원을 중단합니다. 원본은 보관함에 남습니다.","Restoration stops on active report/source limits or revision conflicts. Archived originals remain available.")}</p>{btn(l("선택 항목 복원","Restore selection"),()=>{void restoreArchive();},archiveBusy||!archiveRestoreIds.length)}</details>}
          <details><summary>{l("보관 출처 원본 보기","View archived source records")} · {archiveRead.workspaceSnapshot.sources.length}</summary><DataTable projection={{columns:[l("이름","Name"),l("출처 ID","Source ID"),l("관측 기준","As of"),l("가져온 시각","Retrieved at"),l("원문 주소","Source URL"),l("이용 조건·메모","Usage notes")],rows:archiveRead.workspaceSnapshot.sources.map(source=>[source.name,source.id,source.asOf,source.retrievedAt,source.url,source.note]),status:"ready",warnings:[],asOf:null,sourceIds:[]}}/>{archiveRead.workspaceSnapshot.sources.length>500&&<p className={styles.muted}>{l("처음 500개 출처 표시 · 전체 원본은 JSON으로 저장하세요.","First 500 sources shown. Save JSON for the complete original.")}</p>}</details>
          {!archiveRead.reportIds.length&&<><p className={styles.muted}>{l("보관 당시 회수한 미참조 출처만 복원합니다. 보유 자산과 가격 자료는 복원하지 않습니다. 저장 한도·충돌이 있으면 원본을 유지하고 중단합니다.","Restores only the unreferenced sources reclaimed by this archive. Holdings and quotes are not restored. Capacity or conflict errors leave the archived original intact.")}</p>{btn(l("보관된 미참조 출처 복원","Restore archived unreferenced sources"),()=>{void restoreArchive(true);},archiveBusy)}</>}

        </div>}
      </>}{archiveBusy&&<p role="status">{l("보관 작업 중…","Archive operation in progress…")}</p>}
    </div>;
    const hasData = workspace.watchlist.length > 0 || workspace.holdings.length > 0 || workspace.quotes.length > 0;
    return <main className={styles.root} data-testid="finance-workspace">
    <header className={styles.header}><div><div className={styles.eyebrow}>Agentlas / Finance</div><h1 className={styles.title}>{l("나의 투자 데스크", "Your investment desk")}</h1><p className={styles.subtitle}>{l("관심 자산과 보유 자료를 모으고, 근거를 확인하며 분석과 보고서를 이어가세요.", "Bring your assets, evidence, analysis and reports together.")}</p></div><div className={styles.actions}><span className={styles.badge}>{saving ? l("저장 중", "Saving") : store.persistence === "memory" ? l("저장 연결 없음", "Storage unavailable") : store.savedAt ? `${l("저장", "Saved")} ${date(store.savedAt)}` : l("로컬 작업 공간", "Local workspace")}</span>{btn(l("CSV 가져오기", "Import CSV"), () => setImportOpen(v => !v))}{btn(l("되돌리기", "Undo"), () => { void undo(); }, !canUndo)}{btn(l("다시 적용", "Redo"), () => { void redo(); }, !canRedo)}</div></header>
    <nav role="tablist" className={styles.tabs} aria-label={l("Finance 보기", "Finance views")}>{([['dashboard', l("대시보드", "Dashboard")], ['watchlist', l("자산 찾기", "Find assets")], ['reports', l("보고서", "Reports")], ['sources', l("자료와 근거", "Sources")], ['monitors', l("모니터링", "Monitoring")]] as [
        Tab,
        string
    ][]).map(([id, title]) => <button role="tab" type="button" className={styles.tab} key={id} aria-selected={tab === id} onClick={() => { setTab(id); setSelected(""); setEditing(false); }}>{title}</button>)}</nav>
    {(tab === "reports" || workspace.reports.length >= FINANCE_WORKSPACE_LIMITS.reports * 0.8 || workspace.sources.length >= FINANCE_WORKSPACE_LIMITS.sources * 0.8) && <p className={styles.muted}>{l("저장된 보고서", "Saved reports")} {workspace.reports.length}/{FINANCE_WORKSPACE_LIMITS.reports} · {l("자료 출처", "Sources")} {workspace.sources.length}/{FINANCE_WORKSPACE_LIMITS.sources}{workspace.reports.length >= FINANCE_WORKSPACE_LIMITS.reports * 0.8 && ` · ${l("한도 전에 필요한 보고서를 내보내고 보관 자료를 정리하세요. 기존 자료는 자동 삭제하지 않습니다.", "Export needed reports and manage saved material before reaching capacity. Existing data is never automatically deleted.")}`}</p>}
    {(notice || error) && <div className={`${styles.notice} ${error ? styles.error : ""}`} role="status">{error ? <FinanceMessage value={friendlyError(error)} ko={ko} error/> : notice}</div>}
    {archivePreview&&<section className={styles.importPanel} aria-label={l("보관 전 확인","Review before archiving")}><h2>{l("원본을 보존하고 활성 목록에서 회수","Preserve originals and reclaim active capacity")}</h2><p>{archiveCounts.reports} {l("보고서","reports")} · {archiveCounts.referenced} {l("선택 보고서의 참조 출처","sources referenced by selected reports")} · {archiveCounts.reclaimable.length} {l("회수 예상 출처","sources expected to be reclaimed")} · {archiveCounts.retained} {l("계속 참조 중인 출처 유지","referenced sources retained")}</p><p className={styles.muted}>{l("보관 원본에는 전체 스냅샷을 보존합니다. 활성 가격·보유 자산·남은 보고서가 참조하는 출처는 회수하지 않습니다. 자동 정리·삭제는 실행하지 않습니다. 최종 회수 수는 저장 영수증으로 확인합니다.","A full original snapshot is preserved. Sources referenced by active quotes, holdings or remaining reports stay active. Nothing is automatically cleaned up or deleted. The save receipt confirms final reclaimed counts.")}</p><details><summary>{l("회수 예상 출처 목록","Sources expected to be reclaimed")}</summary><ul>{archiveCounts.reclaimable.map(source=><li key={source.id}>{source.name} · {source.id}</li>)}</ul></details>{archivePreview.revision!==workspace.revision&&<p role="alert">{l("작업 공간이 바뀌었습니다. 취소 후 최신 선택으로 다시 확인하세요.","The workspace changed. Cancel and review the latest selection.")}</p>}<div className={styles.actions}>{btn(l("원본 보관 실행","Archive originals now"),()=>{void createArchive();},archiveBusy||archivePreview.revision!==workspace.revision||(!archiveCounts.reports&&!archiveCounts.reclaimable.length))}{btn(l("취소","Cancel"),()=>setArchivePreview(null),archiveBusy)}</div></section>}
    {importOpen && <section className={styles.importPanel} aria-label={l("CSV 가져오기", "CSV import")}><div className={styles.cardHead}><h2 className={styles.sectionHeading}>{l("내 자료로 시작하기", "Start with your data")}</h2>{btn(l("닫기", "Close"), () => setImportOpen(false))}</div><p className={styles.muted}>{l("파일을 먼저 확인한 뒤 가져옵니다. 통화·수량·가격을 임의로 채우지 않습니다.", "Review your file before importing. Missing quantities and prices are not invented.")}</p><div className={styles.actions}><label className={styles.label}>{l("CSV 파일", "CSV file")}<input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; if (!file)
        return; if (file.size > 8 * 1024 * 1024) {
        setNotice(l("8MB 이하 CSV 파일을 선택하세요.", "Choose a CSV file up to 8MB."));
        return;
    } setCsvName(file.name); setCsv(await file.text()); }}/></label><label className={styles.label}>{l("통화가 없는 행의 통화", "Currency for rows without a currency")}<select className={styles.select} value={defaultCurrency} onChange={e => setDefaultCurrency(e.target.value)}><option value="">{l("파일에 명시된 통화만", "Only explicit file currencies")}</option>{["KRW", "USD", "EUR", "JPY", "GBP"].map(c => <option key={c}>{c}</option>)}</select></label></div><details><summary className={styles.muted}>{l("CSV 내용을 붙여넣기", "Paste CSV content")}</summary><textarea className={`${styles.input} ${styles.textarea}`} aria-label="CSV" value={csv} onChange={e => setCsv(e.target.value)} placeholder="symbol,name,quantity,averageCost,currency"/></details>{imported && <div className={styles.importPreview}><strong>{csvName || l("붙여넣은 자료", "Pasted data")} · {imported.rowCount} {l("행", "rows")}</strong><p className={styles.muted}>{imported.assets.length} {l("자산", "assets")} · {imported.holdings.length} {l("보유 항목", "holdings")} · {imported.quotes.length} {l("가격 관측", "price observations")}</p>{imported.assets.length > 0 && <DataTable projection={{ columns: [l("자산", "Asset"), l("이름", "Name"), l("통화", "Currency"), l("수량", "Quantity"), l("가격", "Price")], rows: imported.assets.slice(0, 20).map(a => [a.symbol, a.name, a.currency, imported.holdings.find(h => h.assetId === a.id)?.quantity ?? null, imported.quotes.find(q => q.assetId === a.id)?.price ?? null]), status: "partial", warnings: [], asOf: null, sourceIds: [] }}/>}{imported.assets.length > 20 && <p className={styles.muted}>{l("처음 20개 자산 미리보기", "Previewing the first 20 assets")}</p>}{imported.errors.map((v, i) => <FinanceMessage key={i} value={v} ko={ko} error/>)}{imported.warnings.map((v, i) => <FinanceMessage key={i} value={v} ko={ko}/>)}{btn(l("확인한 자료 가져오기", "Import reviewed data"), () => { void importCsv(); }, saving || imported.errors.length > 0 || imported.rowCount === 0, true)}</div>}</section>}
    {!hasData && tab === "dashboard" && <section className={styles.onboarding}><span className={styles.eyebrow}>{l("첫 번째 작업 공간", "Your first workspace")}</span><h2>{l("내 자산과 질문에서 시작하세요.", "Start with your assets and questions.")}</h2><p className={styles.subtitle}>{l("연결되거나 가져온 자료만 표시합니다. 데이터가 없는 칸은 빈 상태와 필요한 자료를 안내합니다.", "Only connected or imported data is shown. Empty blocks explain what is needed.")}</p><div className={styles.steps}>{[[l("관심 자산 찾기", "Find your assets"), l("이름과 티커로 검색하고 거래소·통화를 확인하세요.", "Search names and symbols, then verify the exchange and currency.")], [l("CSV 자료 가져오기", "Import a CSV"), l("보유 수량·원가·가격 자료를 검토한 뒤 추가하세요.", "Review holdings, cost and price data before adding them.")], [l("내 화면 만들기", "Build your view"), l("비교표·차트·메모를 배치하고 고정 보고서로 남기세요.", "Arrange tables, charts and notes, then create a frozen report.")]].map(([title, body], i) => <div className={styles.step} key={title}><span className={styles.stepNumber}>0{i + 1}</span><strong>{title}</strong><p>{body}</p></div>)}</div><div className={styles.actions}>{btn(l("자산 찾기", "Find assets"), () => setTab("watchlist"), false, true)}{btn(l("CSV 가져오기", "Import CSV"), () => setImportOpen(true))}</div></section>}
    {tab === "dashboard" && <><div className={styles.toolbar}><div className={styles.actions}>{workspace.dashboards.length > 0 && <select aria-label={l("대시보드 선택", "Choose dashboard")} className={styles.select} value={dashboard?.id || ""} onChange={e => { void act({ type: "dashboard.select", dashboardId: e.target.value }); setSelected(""); }}>{workspace.dashboards.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select>}{btn(l("새 대시보드", "New dashboard"), () => { const next = createFinanceDashboard(l("나의 대시보드", "My dashboard"), [createFinanceWidget("watchlist", labels.watchlist[ko ? 0 : 1]), createFinanceWidget("holdings", labels.holdings[ko ? 0 : 1]), createFinanceWidget("notes", labels.notes[ko ? 0 : 1])]); void act([{ type: "dashboard.add", dashboard: next }, { type: "dashboard.select", dashboardId: next.id }]); })}</div><div className={styles.actions}>{dashboard && <select className={styles.select} aria-label={l("대시보드 기간", "Dashboard period")} value={dashboard.period} onChange={e => { void act({ type: "dashboard.update", dashboardId: dashboard.id, patch: { period: e.target.value as FinanceWidget["period"] } }); }}>{periods.map(p => <option key={p}>{p}</option>)}</select>}{onRefreshData && btn(refreshing ? l("갱신 중…", "Refreshing…") : l("자료 갱신", "Refresh data"), () => { void refreshData(); }, refreshing)}{btn(editing ? l("편집 완료", "Done editing") : l("화면 편집", "Edit view"), () => setEditing(v => !v), !dashboard)}{btn(l("보고서 만들기", "Create report"), makeReport, !dashboard, true)}</div></div>{dashboard && <div className={`${styles.workspace} ${editing && widget ? styles.withInspector : ""}`}><div className={styles.canvas}><div className={styles.grid}>{dashboard.widgets.map((w, index) => { const effective = effectiveFinanceWidget(dashboard, w); const projection = projectFinanceWidget(workspace, effective); if (w.hidden)
        return null; return <section className={`${styles.card} ${w.width === "full" ? styles.wide : ""} ${selected === w.id ? styles.selected : ""}`} key={w.id} aria-label={w.title}><div className={styles.cardHead}><button type="button" className={styles.cardTitle} onClick={() => { setSelected(w.id); setEditing(true); }}>{w.title}</button><span className={styles.badge}>{({ ready: l("자료 있음", "Data ready"), partial: l("일부 자료", "Partial data"), empty: l("자료 없음", "No data"), unsupported: l("자료 연결 필요", "Connection needed") })[projection.status]}</span></div><div className={styles.cardMeta}>{w.type === "chart" ? <>{w.periodMode === "pinned" ? l("기간 고정", "Period pinned") : l("전체 기간 연결", "Follows view")} · {effective.period} · </> : <>{l("최신 관측 · 기간 필터 미적용", "Latest observations · period filter not applied")} · </>}{w.priceBasis === "price" ? l("가격 기준", "Price basis") : l("총수익 기준", "Total return")} · {l("관측", "As of")} {date(projection.asOf)}</div><Projection widget={effective} projection={projection} ko={ko}/><div className={styles.cardFoot}><span>{l("출처", "Sources")} {projection.sourceIds.length}</span><button className={`${styles.button} ${styles.quiet}`} type="button" onClick={() => { void exportWidget(dashboard.id, w.id); }}>CSV</button></div>{editing && <div className={styles.cardControls}>{btn(l("위로", "Up"), () => move(w.id, index - 1), index === 0)}{btn(l("아래로", "Down"), () => move(w.id, index + 1), index === dashboard.widgets.length - 1)}{btn(w.width === "full" ? l("반 너비", "Half width") : l("전체 너비", "Full width"), () => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { width: w.width === "full" ? "half" : "full" } }); })}{btn(l("숨기기", "Hide"), () => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { hidden: true } }); })}</div>}</section>; })}</div>{editing && <div className={styles.actions} style={{ marginTop: 18 }}>{dashboard.widgets.filter(w => w.hidden).map(w => <button type="button" className={styles.button} key={w.id} onClick={() => { void act({ type: "widget.update", dashboardId: dashboard.id, widgetId: w.id, patch: { hidden: false } }); }}>{l("복원", "Restore")}: {w.title}</button>)}{types.map(type => <button type="button" className={styles.button} key={type} onClick={() => addWidget(type)}>+ {labels[type][ko ? 0 : 1]}</button>)}</div>}{!dashboard.widgets.some(w => !w.hidden) && <div className={styles.empty}>{l("화면 편집에서 첫 블록을 추가하세요.", "Add your first block in Edit view.")}</div>}</div>{editing && widget && <aside className={styles.inspector}><div className={styles.cardHead}><h3>{l("블록 설정", "Block settings")}</h3>{btn(l("닫기", "Close"), () => setSelected(""))}</div><label className={styles.label}>{l("제목", "Title")}<DraftField value={widget.title} label={l("블록 제목", "Block title")} onCommit={title => updateWidget({ title })}/></label>{widget.type === 'chart' && <><label className={styles.muted}><input type="checkbox" checked={widget.periodMode === "pinned"} onChange={e => updateWidget({ periodMode: e.target.checked ? "pinned" : "inherit", period: effectiveFinanceWidget(dashboard, widget).period })}/>{l(" 이 블록 기간 고정", " Pin this block period")}</label><label className={styles.label}>{l("기간 · 이 블록", "Period · this block")}<select className={styles.select} value={widget.period} onChange={e => updateWidget({ period: e.target.value as FinanceWidget["period"], periodMode: "pinned" })}>{periods.map(p => <option key={p}>{p}</option>)}</select></label></>}<label className={styles.label}>{l("표현", "Display")}<select className={styles.select} value={widget.chartType} onChange={e => updateWidget({ chartType: e.target.value as FinanceWidget["chartType"] })}>{["table", "line", "bar"].map(p => <option key={p}>{p}</option>)}</select></label>{!["sources", "notes", "events"].includes(widget.type) && <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className={styles.muted}>{l("자산 · 비워두면 전체", "Assets · empty means all")}</legend>{workspace.watchlist.map(a => <label key={a.id} className={styles.muted}><input type="checkbox" checked={widget.assetIds.includes(a.id)} onChange={e => updateWidget({ assetIds: e.target.checked ? [...widget.assetIds, a.id] : widget.assetIds.filter(id => id !== a.id) })}/> {a.symbol} · {a.exchange}</label>)}</fieldset>}<label className={styles.label}>{l("메모", "Notes")}<DraftField multiline value={widget.notes} label={l("블록 메모", "Block notes")} onCommit={notes => updateWidget({ notes })}/></label><p className={styles.muted}>{l("이 블록의 조건만 변경합니다. 다른 블록과 보고서의 고정 자료는 유지됩니다.", "Changes affect this block. Other blocks and frozen reports are preserved.")}</p></aside>}</div>}</>}
    {tab === "watchlist" && <section><h2 className={styles.sectionHeading}>{l("관심 자산을 한곳에", "Keep your assets together")}</h2><form className={styles.search} onSubmit={e => { e.preventDefault(); void runSearch(); }}><input className={styles.input} aria-label={l("자산 이름 또는 티커", "Asset name or symbol")} placeholder={l("회사명 또는 티커 검색", "Search a name or symbol")} value={search} onChange={e => setSearch(e.target.value)}/><button className={`${styles.button} ${styles.primary}`} disabled={searching || !search.trim()}>{searching ? l("검색 중…", "Searching…") : l("찾기", "Search")}</button></form>{searchEvidence && <div className={styles.muted}>{searchEvidence.provider} · {date(searchEvidence.asOf)}{searchEvidence.warnings.map((w, i) => <FinanceMessage key={i} value={w} ko={ko}/>)}</div>}{results.length > 0 && <div className={styles.results}>{results.map(a => <div className={styles.result} key={a.id}><div><strong>{a.name}</strong><small>{a.symbol} · {a.exchange || l("거래소 미확인", "Exchange unknown")} · {a.currency === "XXX" ? l("통화 미확인", "Currency unknown") : a.currency} · {a.kind}</small></div>{btn(workspace.watchlist.some(x => x.id === a.id) ? l("추가됨", "Added") : l("관심 자산 추가", "Add to watchlist"), () => { void act({ type: "watchlist.add", asset: a }); }, workspace.watchlist.some(x => x.id === a.id))}</div>)}</div>}{workspace.watchlist.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr>{[l("자산", "Asset"), l("거래소 · 통화", "Exchange · currency"), l("보유", "Holding"), l("작업", "Actions")].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{workspace.watchlist.map(a => <tr key={a.id}><td><strong>{a.symbol}</strong><div className={styles.muted}>{a.name}</div></td><td>{a.exchange || "—"} · {a.currency === "XXX" ? l("통화 미확인", "Currency unknown") : a.currency}</td><td>{workspace.holdings.filter(h => h.assetId === a.id).reduce((sum, h) => sum + h.quantity, 0).toLocaleString()}</td><td><div className={styles.actions}>{onOpenResearch && btn(l("조사 이어가기", "Continue research"), () => { void Promise.resolve(onOpenResearch(a)).catch(() => setNotice(l("조사 작업을 열지 못했습니다.", "Could not open the research task."))); })}{btn(l("제거", "Remove"), () => { void act({ type: "watchlist.remove", assetId: a.id }); }, workspace.holdings.some(h => h.assetId === a.id))}</div></td></tr>)}</tbody></table></div> : <div className={styles.empty}>{l("검색하거나 CSV를 가져와 관심 자산을 추가하세요.", "Search or import a CSV to add your assets.")}</div>}</section>}
    {tab === "reports" && <section><div className={styles.toolbar}><div className={styles.actions}><select className={`${styles.select} ${styles.reportPicker}`} aria-label={l("보고서 선택", "Choose report")} value={archiveOpen?"":report?.id || ""} disabled={archiveOpen} onChange={e => setReportId(e.target.value)}>{!workspace.reports.length && <option value="">{l("저장된 보고서 없음", "No saved reports")}</option>}{workspace.reports.map(r => <option value={r.id} key={r.id}>{r.title}</option>)}</select>{!archiveOpen&&btn(l("현재 화면으로 새 보고서", "New report from view"), makeReport, !dashboard)}</div>{report && <div className={styles.actions}>{!archivedReport&&btn(editing ? l("편집 완료", "Done editing") : l("문서 편집", "Edit document"), () => setEditing(v => !v))}{btn(l("Markdown 저장", "Save Markdown"), exportReport, false, true)}</div>}</div>{archivePanel}{report ? <article className={styles.report}><div className={styles.eyebrow}>{archivedReport?l("보관 원본 · 읽기 전용","Archived original · read only"):l("고정 자료 · 리서치 초안", "Frozen data · research draft")}</div>{reportEditing ? <label className={styles.label}>{l("보고서 제목", "Report title")}<DraftField value={report.title} label={l("보고서 제목", "Report title")} onCommit={title => { if (title.trim())
        void act({ type: "report.update", reportId: report.id, patch: { title } }); }}/></label> : <h2 className={styles.reportTitle}>{report.title}</h2>}<p className={styles.muted}>{date(report.createdAt)} · {l("자료 판본", "Data revision")} {report.sourceRevision} · {l("대시보드 변경과 독립된 고정 결과", "Frozen results, independent of dashboard edits")}</p>{report.reviewPending && <div className={styles.notice}>{l("서술 검토가 필요한 초안입니다. 숫자·조건·근거와 문장이 일치하는지 확인하세요.", "This draft needs narrative review. Check that its text matches the figures, conditions and evidence.")}{!archivedReport&&btn(l("문장 검토 완료 표시", "Mark narrative reviewed"), () => { void act({ type: "report.update", reportId: report.id, patch: { reviewPending: false } }, l("사용자 검토 표시를 저장했습니다. 자동 사실 검증 결과가 아닙니다.", "Saved your review mark. This is not an automated fact check.")); })}</div>}<div className={styles.actions}>{!archivedReport&&(report.dashboardSnapshot ? btn(l("새 자료로 별도 버전 만들기", "Create a refreshed version"), () => { void dispatch({ type: "report.refresh", reportId: report.id }).then(saved => { setReportId(saved.reports[saved.reports.length - 1].id); setNotice(l("기존 문장과 보고서를 보존하고 새 버전을 만들었습니다.", "Preserved the original report and text in a new version.")); }).catch(() => setNotice(l("보고서를 갱신하지 못했습니다.", "Could not refresh the report."))); }) : btn(l("원자료를 다시 조회", "Retrieve source data again"), () => { setDataResult(null); setTab("sources"); }))}</div>{report.sections.map((section, index) => <section className={`${styles.reportSection} ${selectedSection === section.id ? styles.selected : ""}`} key={section.id} onClick={() => setSelectedSection(section.id)}><div className={styles.cardHead}>{reportEditing ? <DraftField value={financeStatus(section.title,ko)} label={l("섹션 제목", "Section title")} onCommit={title => { if (title.trim())
        void act({ type: "report.section.update", reportId: report.id, sectionId: section.id, patch: { title } }); }}/> : <h3>{financeStatus(section.title,ko)}</h3>}<span className={styles.badge}>{section.projection ? l("고정 관측", "Frozen data") : l("서술", "Narrative")}</span></div>{reportEditing ? <DraftField multiline value={financeMessage(section.narrative,ko)} label={l("섹션 본문", "Section narrative")} onCommit={narrative => { void act({ type: "report.section.update", reportId: report.id, sectionId: section.id, patch: { narrative } }); }}/> : section.narrative ? <FinanceBriefText value={financeMessage(section.narrative,ko)} ko={ko}/> : section.kind === 'summary' ? <p className={styles.muted}>{l("문서 편집에서 핵심 판단과 확인할 가정을 작성하세요.", "Write your conclusions and assumptions in Edit document.")}</p> : null}{section.projection && <>{section.widget?<Projection widget={section.widget} projection={section.projection} ko={ko}/>:<><DataTable projection={section.projection}/>{section.projection.warnings.map((warning,i)=><FinanceMessage key={i} value={warning} ko={ko}/>)}</>}<p className={styles.cardMeta}>{l("관측 기준", "As of")} {date(section.projection.asOf)} · {l("출처", "Sources")} {section.projection.sourceIds.length}</p></>}{reportEditing && <div className={styles.cardControls}>{btn(l("위로", "Up"), () => { void act({ type: "report.section.move", reportId: report.id, sectionId: section.id, index: index - 1 }); }, index === 0)}{btn(l("아래로", "Down"), () => { void act({ type: "report.section.move", reportId: report.id, sectionId: section.id, index: index + 1 }); }, index === report.sections.length - 1)}{btn(l("섹션 숨기기", "Hide section"), () => { void act({ type: "report.section.remove", reportId: report.id, sectionId: section.id }); })}</div>}</section>)}</article> : <div className={styles.empty}>{l("대시보드의 조건과 자료를 고정한 보고서를 만드세요. 제목·서술·섹션 순서를 직접 편집할 수 있습니다.", "Create a frozen report from your dashboard. Edit the title, narrative and section order.")}</div>}</section>}
    {tab === "sources" && <section>{onArchives&&btn(l("참조없는 출처 보관","Archive unreferenced sources"),()=>{setArchiveSelection([]);setArchivePreview({revision:workspace.revision,reportIds:[]});})}<h2 className={styles.sectionHeading}>{l("숫자의 출처와 기준", "Where the numbers come from")}</h2><p className={styles.muted}>{l("관측 기준과 가져온 시각을 구분합니다. 파일을 가져온 시각이 가격을 관측한 시각을 의미하지는 않습니다.", "Observation time and retrieval time are distinct. An import timestamp is not a price timestamp.")}</p>{onConnectData&&<details className={styles.importPanel}><summary>{l("가격·뉴스 공급자 연결", "Connect a price and news provider")}</summary><p className={styles.muted}>{l("미국 기업 공시는 SEC 공개 자료에서, 가격·뉴스는 연결한 공급자의 지원 범위에서 조회합니다. 주식·ETF의 지원 시장·지표·호출 한도와 이용 조건을 확인하세요.", "US company filings use public SEC sources. Prices and news depend on the connected provider. Check its markets, metrics, request limits and usage terms.")}</p><a className={styles.link} href="https://www.alphavantage.co/" target="_blank" rel="noopener noreferrer">{l("Alpha Vantage 공식 안내", "Alpha Vantage official information")}</a><form onSubmit={e=>{e.preventDefault();if(!onConnectData||!providerKey.trim()||connecting)return;setConnecting(true);void onConnectData(providerKey.trim()).then(()=>{setProviderKey("");setNotice(l("공급자 키를 저장했습니다. 다음 자료 조회에서 연결과 지원 범위를 확인하세요.","Provider key saved. The next data query will verify access and coverage."));}).catch(()=>setNotice(l("키를 저장하지 못했습니다. 저장 연결을 확인하세요.","Could not save the key. Check the secure-storage connection."))).finally(()=>setConnecting(false));}}><label className={styles.label} style={{marginTop:12}}>{l("API 키 · 화면에만 임시 보관", "API key · temporary input only")}<input className={styles.input} type="password" autoComplete="new-password" maxLength={512} value={providerKey} onChange={e=>setProviderKey(e.target.value)} disabled={connecting} /></label><div className={styles.actions} style={{marginTop:10}}><button className={styles.button} disabled={connecting||!providerKey.trim()}>{connecting?l("저장 중…","Saving…"):l("키 저장","Save key")}</button></div></form><p className={styles.muted}>{l("기존 키는 표시하지 않으며, 키 입력을 작업 문서·대화·내보내기에 포함하지 않습니다.","Existing keys are never displayed. Key input is excluded from workspace documents, AI requests and exports.")}</p></details>}<div className={styles.importPanel}><h3>{l("연결된 자료 조회", "Query connected data")}</h3><p className={styles.muted}>{l("공식 펀드 편입 내역·NAV와 거래소 가격을 구분합니다. NAV를 현재 매매 가격이나 계좌 평가 가격으로 자동 반영하지 않습니다. 일반 주식·ETF 시세와 과거 가격은 연결한 공급자의 시장·권한 범위를 따릅니다.","Official fund holdings and NAV are distinct from exchange prices. NAV is never automatically used as a market quote or account valuation. Stock and ETF quotes and history depend on provider coverage and entitlements.")}</p><p className={styles.muted}>{l("자산과 별개로 공식 계정(@handle)이나 키워드를 지정할 수 있습니다. SNS 글은 작성자의 주장으로 취급하며 기업 공시와 구분합니다.","Specify an author (@handle) or keyword independently of the asset. Social posts are attributed claims, separate from company filings.")}</p><label className={styles.label}>{l("검색어 또는 계정 · 비우면 선택 자산","Query or author · empty uses selected asset")}<input className={styles.input} value={dataQueryText} onChange={e=>setDataQueryText(e.target.value)} placeholder={l("예: @federalreserve.gov 또는 조사 키워드","e.g. @federalreserve.gov or research keyword")}/></label><form onSubmit={e => { e.preventDefault(); void queryData(); }}><label className={styles.label}>{l("조회할 자산", "Asset to retrieve")}<select className={styles.select} value={dataAssetId || (workspace.watchlist.length === 1 ? workspace.watchlist[0].id : "")} onChange={e => { queryAbort.current?.abort(); setQuerying(false); setDataResult(null); setDataAssetId(e.target.value); }}><option value="">{l("관심 자산을 선택하세요", "Choose a saved asset")}</option>{workspace.watchlist.map(asset => <option key={asset.id} value={asset.id}>{asset.symbol} · {asset.name} · {asset.exchange}</option>)}</select></label><div className={styles.actions} style={{ marginTop: 12 }}><select className={styles.select} value={dataMetric} onChange={e => { queryAbort.current?.abort(); setQuerying(false); setDataResult(null); setDataMetric(e.target.value); }} aria-label={l("자료 종류", "Data category")}>{[["price", l("가격", "Prices")], ["news", l("뉴스", "News")], ["filings", l("공시", "Filings")], ["social", l("공식 계정 글", "Author posts")], ["social_search",l("SNS 키워드 검색","Social keyword search")], ["company_facts",l("기업 재무 원자료","Company facts")], ["macro_news",l("거시 뉴스","Macro news")], ["treasury_yields",l("국채 수익률","Treasury yields")], ["etf_holdings", l("ETF 편입", "ETF holdings")],["nav",l("공식 펀드 NAV · 거래가격 아님","Official fund NAV · not a market quote")]].map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select><button className={`${styles.button} ${styles.primary}`} disabled={!onQueryData || querying || dataSaving || (!dataQueryText.trim()&&!dataAssetId&&workspace.watchlist.length!==1&&!["social","macro_news","treasury_yields"].includes(dataMetric))}>{querying ? l("조회 중…", "Querying…") : l("자료 조회", "Retrieve data")}</button>{querying && btn(l("중지", "Stop"), () => { queryAbort.current?.abort(); setQuerying(false); })}</div></form>{dataResult && <div className={styles.importPreview}>{lastDataRequest&&<div className={styles.evidenceChips}><span className={styles.badge}>{lastDataRequest.query||l("공식 기본 자료","Official default feed")}</span>{lastDataRequest.metrics.map(metric=><span className={styles.badge} key={metric}>{financeStatus(metric,ko)}</span>)}<span className={styles.badge}>{lastDataRequest.period}</span></div>}{onQueryAndSave&&dataResult.rows.length>0&&btn(l("다시 조회해 출처 저장","Retrieve again and save sources"),()=>{void persistDataResult("sources");},dataSaving||querying)}{dataResult.rows.length>0&&btn(onQueryAndSave?l("다시 조회해 보고서 저장","Retrieve again and save report"):l("조회 결과를 보고서로 저장","Save result as report"),()=>{void (onQueryAndSave?persistDataResult("report"):saveDataReport());},dataSaving||querying)}<span className={styles.badge}>{financeStatus(dataResult.status,ko)}</span>{dataResult.providers?.map(provider=><section className={styles.receipt} key={provider.id}><div className={styles.cardHead}><h3>{provider.label}</h3><span className={styles.badge}>{financeStatus(provider.status,ko)}</span></div><strong className={styles.muted}>{l("지원 범위","Coverage")}</strong><FinanceMessage value={provider.coverage} ko={ko}/><strong className={styles.muted}>{l("이용·재배포 조건","Usage and redistribution")}</strong><FinanceMessage value={provider.rights} ko={ko}/>{provider.sourceUrls.filter(url=>/^https?:\/\//i.test(url)).map(url=><p key={url}><a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>)}</section>)}<p className={styles.muted}>{l("관측", "As of")}: {date(dataResult.asOf)} · {l("조회", "Retrieved")}: {date(dataResult.retrievedAt)}</p>{dataResult.columns.length > 0 && <DataTable projection={{ columns: dataResult.columns, rows: dataResult.rows, status: dataResult.status === "ok" ? "ready" : dataResult.status === "partial" ? "partial" : "empty", warnings: dataResult.warnings, asOf: dataResult.asOf, sourceIds: [] }}/>}{!dataResult.rows.length && <p className={styles.muted}>{l("확인된 결과 행이 없습니다. 연결 범위와 안내를 확인하세요.", "No verified result rows. Check coverage and source notices.")}</p>}{dataResult.warnings.map((w, i) => <FinanceMessage key={i} value={w} ko={ko}/>)}{dataResult.sourceUrls.filter(url => /^https?:\/\//i.test(url)).map(url => <p key={url}><a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>)}</div>}{!onQueryData && <p className={styles.muted}>{l("자료 조회 실행 경로가 연결되지 않았습니다.", "The data-query runtime is not connected.")}</p>}</div><div className={styles.list}>{workspace.sources.map(s => <article key={s.id} className={styles.listItem}><div className={styles.cardHead}><h3>{financeStatus(s.name,ko)}</h3><span className={styles.badge}>{financeStatus(s.status,ko)}</span></div><dl className={styles.metaGrid}><div><dt>{l("관측 기준", "Observation time")}</dt><dd>{date(s.asOf)}</dd></div><div><dt>{l("가져온 시각", "Retrieved")}</dt><dd>{date(s.retrievedAt)}</dd></div><div><dt>{l("연결 방식", "Source type")}</dt><dd>{financeStatus(s.kind,ko)}</dd></div><div><dt>{l("자료 식별자", "Source ID")}</dt><dd>{s.id}</dd></div></dl>{s.note && <FinanceMessage value={s.note} ko={ko}/>}{s.url && /^https?:\/\//i.test(s.url) && <a className={styles.link} href={s.url} target="_blank" rel="noopener noreferrer">{l("원문 열기", "Open original source")}</a>}</article>)}</div>{!workspace.sources.length && <div className={styles.empty}>{l("아직 보관한 출처가 없습니다. CSV를 가져오거나 조회 결과를 보고서로 저장하면 출처와 시각이 여기에 남습니다.", "No saved sources yet. Import a CSV or save a query result as a report to retain its provenance.")}</div>}</section>}
    {tab === "monitors" && <section><div className={styles.toolbar}><h2 className={styles.sectionHeading}>{l("모니터링과 실행 상태", "Monitoring and execution")}</h2><div className={styles.actions}>{btn(l("자동화 실행 이력", "Automation run history"), () => navigate("/automation"))}{btn(l("모니터링 초안 추가", "Add monitor draft"), () => { void act({ type: "monitor.upsert", monitor: { id: crypto.randomUUID(), name: l("새 점검 조건", "New check"), query: "", assetIds: [], status: "draft", lastCheckedAt: null, nextCheckAt: null, note: l("아직 실행하지 않은 점검 초안입니다.", "A draft check that has not been executed.") } }); })}</div></div><p className={styles.muted}>{l("초안 저장은 감시 시작을 의미하지 않습니다. 실행 주체·마지막 확인·다음 실행이 확인되는 경우만 실행 상태를 표시합니다.", "Saving a draft does not start monitoring. Execution status requires an executor and check receipts.")}</p><div className={styles.list}>{workspace.monitors.map(m => <article key={m.id} className={styles.listItem}><div className={styles.cardHead}><DraftField disabled={m.status === 'active'} value={m.name} label={l("모니터링 이름", "Monitor name")} onCommit={name => { if (name.trim())
        void act({ type: "monitor.upsert", monitor: { ...m, name } }); }}/><span className={styles.badge}>{financeStatus(m.status,ko)}</span></div><label className={styles.label}>{l("확인할 질문·조건", "Question or condition")}<DraftField disabled={m.status === 'active'} multiline value={m.query} label={l("모니터링 조건", "Monitoring condition")} onCommit={query => { void act({ type: "monitor.upsert", monitor: { ...m, query } }); }}/></label><dl className={styles.metaGrid}><div><dt>{l("마지막 확인", "Last checked")}</dt><dd>{date(m.lastCheckedAt)}</dd></div><div><dt>{l("다음 실행", "Next check")}</dt><dd>{date(m.nextCheckAt)}</dd></div></dl><p className={styles.muted}>{m.note}</p>{m.status === 'active' && <p className={styles.muted}>{l("조건을 편집하려면 실행을 먼저 일시정지하세요.", "Pause execution before editing its conditions.")}</p>}<label className={styles.label}>{l("점검할 자산", "Assets to check")}<select className={styles.select} value={m.assetIds[0] || ""} disabled={m.status === 'active'} onChange={e => { void act({ type: "monitor.upsert", monitor: { ...m, assetIds: e.target.value ? [e.target.value] : [] } }); }}><option value="">{l("자산 선택", "Choose asset")}</option>{workspace.watchlist.map(a => <option value={a.id} key={a.id}>{a.symbol} · {a.exchange}</option>)}</select></label><div className={styles.actions} style={{ marginTop: 12 }}>{onScheduleMonitor && <><label className={styles.label}>{l("실행 일정", "Schedule")}<select className={styles.select} value={financeMonitorScheduleValue(m,monitorSchedules)} disabled={m.status==='active'||scheduling===m.id} aria-label={l("실행 일정", "Execution schedule")} onChange={e=>setMonitorSchedules(current=>({...current,[m.id]:e.target.value}))}><option value="daily-09:00">{l("매일 오전 9시 · 현지 시간", "Daily at 09:00 · local time")}</option><option value="weekday-09:00">{l("평일 오전 9시 · 현지 시간", "Weekdays at 09:00 · local time")}</option><option value="hourly">{l("매시간", "Hourly")}</option><option value="every-5m">{l("5분마다 · 앱 실행 중", "Every 5 minutes · while app is running")}</option></select></label>{btn(scheduling === m.id ? l("등록 중…", "Registering…") : l("자동화로 등록", "Schedule automation"), () => { setScheduling(m.id); void onScheduleMonitor(m, financeMonitorScheduleValue(m,monitorSchedules)).then(() => { setMonitorSchedules(current=>{const next={...current};delete next[m.id];return next;});setNotice(l("실행 등록 결과를 확인했습니다. 자동화 화면에서 일정과 실행 이력을 확인하세요.", "Checked the scheduling result. Review the schedule and run history in Automations.")); void store.reload(); }).catch(() => setNotice(l("자동화를 등록하지 못했습니다. 초안은 유지됩니다.", "Could not schedule automation. The draft is preserved."))).finally(() => setScheduling("")); }, !!scheduling || m.status === 'active' || !m.query.trim() || !financeMonitorScheduleValue(m,monitorSchedules).trim())}</>}{btn(l("예약 일시정지", "Pause schedule"), () => { if (onPauseMonitor) {
        void onPauseMonitor(m).then(() => store.reload()).catch(() => setNotice(l("실행을 일시정지하지 못했습니다. 실제 상태를 다시 확인하세요.", "Could not pause execution. Check the actual run status.")));
    }
    else {
        void act({ type: "monitor.upsert", monitor: { ...m, status: "paused", nextCheckAt: null } });
    } }, m.status === 'paused' || m.status === 'draft' || (m.status === 'active' && !onPauseMonitor))}{onOpenResearch && m.assetIds[0] && workspace.watchlist.find(a => a.id === m.assetIds[0]) && btn(l("조사 작업으로 이어가기", "Continue as a research task"), () => { const asset = workspace.watchlist.find(a => a.id === m.assetIds[0]); if (asset)
        void onOpenResearch(asset); })}{btn(l("초안 제거", "Remove draft"), () => { void act({ type: "monitor.remove", monitorId: m.id }); }, m.status === 'active')}</div><FinanceMonitorReceipts monitor={m} ko={ko} onRun={onRunMonitor} onLoad={onMonitorRuns} onOpenReport={id=>{void openMonitorReport(id);}}/></article>)}</div>{!workspace.monitors.length && <div className={styles.empty}>{l("저장된 모니터링이 없습니다. 먼저 확인할 조건을 초안으로 남길 수 있습니다.", "No monitors saved. Start by drafting the condition you want to check.")}</div>}</section>}
    {aiReceipt&&<section className={styles.receipt} aria-label={l("AI 실행과 화면 변경 영수증","AI execution and screen change receipt")}><h3>{l("방금 요청한 작업","Your latest request")}</h3><span className={styles.badge}>{financeStatus(aiReceipt.status||"ok",ko)}</span><div className={styles.evidenceChips}><span className={styles.badge}>{aiReceipt.savedRevision===null?l("답변만 · 저장 변경 없음","Answer only · no saved changes"):`${l("저장됨","Saved")} v${aiReceipt.savedRevision}`}</span>{aiReceipt.runtime&&<span className={styles.badge}>{aiReceipt.runtime.kind} · {aiReceipt.runtime.model||l("모델 미확인","Model unspecified")}</span>}<span className={styles.badge}>{aiReceipt.operations.length} {l("개 변경 제안","proposed changes")}</span></div><FinanceMessage value={aiReceipt.message} ko={ko}/>{aiReceipt.operations.length>0&&<details><summary className={styles.muted}>{l("적용 요청 내역","Requested changes")}</summary><ul>{aiReceipt.operations.map((operation,index)=><li key={index} className={styles.muted}>{financeStatus(operation.type,ko)}</li>)}</ul></details>}<p className={styles.muted}>{l("AI가 작성한 문장과 실제 자료 조회·저장 결과를 구분해 확인하세요.","Distinguish generated text from actual data retrieval and save receipts.")}</p></section>}<section className={styles.composer} aria-label={l("Finance AI", "Finance AI")}><div className={styles.composerHead}><strong>{l("이 화면에서 AI와 함께", "Work with AI on this screen")}</strong><span className={styles.badge}>{busy ? l("요청 처리 중", "Request running") : onAIRequest ? l("현재 화면과 함께 요청", "Request with screen context") : l("AI 연결 필요", "AI connection needed")}</span></div><form className={styles.composerForm} onSubmit={e => { e.preventDefault(); void ask(); }}><textarea className={styles.input} aria-label={l("AI에게 요청", "Ask AI")} value={request} onChange={e => setRequest(e.target.value)} placeholder={l("예: 선택한 ETF를 비교하는 표를 추가하고, 확인되지 않은 자료는 표시해줘", "Add a comparison table for the selected ETFs and show missing data.")} disabled={busy}/>{busy ? <button key="finance-stop" type="button" className={styles.button} onClick={event => { event.preventDefault(); event.stopPropagation(); aiAbort.current?.abort(); aiAbort.current = null; setBusy(false); setNotice(aiApplying.current?l("요청을 중지했습니다. 이미 저장 중인 변경의 결과는 확인 후 되돌릴 수 있습니다.","Stopped the request. A change already being saved may finish; use Undo after its receipt."):l("요청을 중지했습니다. 새로 도착하는 AI 제안은 적용하지 않습니다.","Stopped the request. New AI proposals from it will not be applied.")); }}>{l("중지", "Stop")}</button> : <button key="finance-send" type="submit" className={`${styles.button} ${styles.primary}`} disabled={!onAIRequest || !request.trim() || !!archivedReport}>{l("요청하기", "Send request")}</button>}</form><div className={styles.context}><span className={styles.badge}>{l("현재 보기", "View")}: {financeStatus(tab,ko)}</span><span className={styles.badge}>{dashboard?.name || l("대시보드 없음", "No dashboard")}</span><span className={styles.badge}>{l("선택", "Selection")}: {widget?.title || l("전체 화면", "Whole view")}</span><span className={styles.badge}>v{workspace.revision}</span></div>{!onAIRequest && <p className={styles.muted}>{l("AI 실행 경로가 연결되면 현재 화면 상태로 요청할 수 있습니다. 직접 편집과 CSV 가져오기는 지금 사용할 수 있습니다.", "Connect an AI runtime to ask using the current screen state. Direct editing and CSV import are available now.")}</p>}</section>
  </main>;
}
