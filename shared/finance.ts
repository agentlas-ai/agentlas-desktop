import { z } from "zod";
import { FinanceAnalystDraftSchema, FinanceAnalystRefSchema } from "./finance-analysts";
/** Shared service and MCP transport bound; a transport must outlive the service's terminal receipt. */
export const FINANCE_MONITOR_RUN_TIMEOUT_MS = 180000;

/** Finance is a local document domain. Quotes enter only through explicit data import. */
const id = z.string().min(1).max(200);
const text = z.string().max(20000);
const currency = z.string().regex(/^[A-Z]{3}$/);
const number = z.number().finite().min(-1e15).max(1e15);
const date = z.string().datetime({ offset: true });
const observationDate = z.union([date, z.string().date()]);
export const FINANCE_WIDGET_TYPES = ["watchlist", "holdings", "comparison", "chart", "allocation", "notes", "sources", "events"] as const;
export type FinanceWidgetType = typeof FINANCE_WIDGET_TYPES[number];
const AssetSchema = z.object({
  id, symbol: z.string().min(1).max(80), name: z.string().min(1).max(300),
  exchange: z.string().max(80), currency,
  kind: z.enum(["stock", "etf", "fund", "bond", "crypto", "commodity", "other"]),
}).strict();
export type FinanceAsset = z.infer<typeof AssetSchema>;
const HoldingSchema = z.object({ id, assetId: id, quantity: number.nonnegative(), averageCost: number.nonnegative().nullable(), currency, sourceId: id }).strict();
export type FinanceHolding = z.infer<typeof HoldingSchema>;
const QuoteSchema = z.object({ assetId: id, price: number.nonnegative(), currency, asOf: observationDate, sourceId: id, priceBasis: z.enum(["price", "total_return"]) }).strict();
export type FinanceQuote = z.infer<typeof QuoteSchema>;
const SourceSchema = z.object({
  id, name: z.string().min(1).max(300), kind: z.enum(["csv", "manual", "provider"]),
  status: z.enum(["connected", "imported", "unconnected", "error"]),
  asOf: observationDate.nullable(), retrievedAt: date, url: z.string().max(2000).url().refine(value => /^https?:\/\//i.test(value), "Only HTTP(S) source URLs are supported").nullable(),
  note: text,
}).strict();
export type FinanceSource = z.infer<typeof SourceSchema>;
const WidgetSchema = z.object({
  id, type: z.enum(FINANCE_WIDGET_TYPES), title: z.string().min(1).max(300),
  assetIds: z.array(id).max(10000), metric: z.string().max(200),
  chartType: z.enum(["line", "bar", "table"]), width: z.enum(["half", "full"]),
  period: z.enum(["1M", "3M", "1Y", "5Y", "all"]), notes: text,
  periodMode: z.enum(["inherit", "pinned"]).default("inherit"), hidden: z.boolean().default(false),
  priceBasis: z.enum(["price", "total_return"]), cashFlowMethod: z.enum(["none", "twr", "mwr"]),
}).strict();
export type FinanceWidget = z.infer<typeof WidgetSchema>;
const DashboardSchema = z.object({ id, name: z.string().min(1).max(300), period: z.enum(["1M", "3M", "1Y", "5Y", "all"]).default("1Y"), widgets: z.array(WidgetSchema).max(8000) }).strict();
export type FinanceDashboard = z.infer<typeof DashboardSchema>;
const ProjectionSchema = z.object({
  columns: z.array(z.string().max(300)).max(100),
  rows: z.array(z.array(z.union([text, number, z.null()])).max(100)).max(10000),
  status: z.enum(["ready", "partial", "empty", "unsupported"]), warnings: z.array(text).max(100),
  asOf: observationDate.nullable(), sourceIds: z.array(id).max(10000),
}).strict();
export type FinanceWidgetProjection = z.infer<typeof ProjectionSchema>;
export const FinanceReportLanguageSchema = z.string().min(2).max(80).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).refine(value=>{try{return Intl.getCanonicalLocales(value).length===1;}catch{return false;}}, "Invalid report language");
const ReportPresentationSchema = z.enum(["narrative", "chart", "comparison", "supporting"]);
const SectionSchema = z.object({ id, title: z.string().min(1).max(300), kind: z.enum(["summary", "widget", "narrative", "sources"]), presentation: ReportPresentationSchema.optional(), narrative: text, widget: WidgetSchema.nullable(), projection: ProjectionSchema.nullable() }).strict();
export type FinanceReportSection = z.infer<typeof SectionSchema>;
const ReportSchema = z.object({ id, language: FinanceReportLanguageSchema.optional(), title: z.string().min(1).max(300), createdAt: date, sourceRevision: z.number().int().nonnegative(), reviewPending: z.boolean(), sections: z.array(SectionSchema).max(100), dashboardSnapshot: DashboardSchema.nullable().default(null), parentReportId: id.nullable().default(null) }).strict();
export type FinanceReport = z.infer<typeof ReportSchema>;
const MonitorSchema = z.object({
  id, name: z.string().min(1).max(300), query: text, assetIds: z.array(id).max(10000),
  status: z.enum(["draft", "active", "paused", "unsupported", "error"]),
  lastCheckedAt: date.nullable(), nextCheckAt: date.nullable(), note: text,
  condition: z.enum(["price_above", "price_below", "price_change_pct"]).optional(), assetId: id.optional(), threshold: number.optional(),
  automationId: id.optional(),
  executionAvailability: z.literal("app-running").optional(), scheduleHuman: z.string().max(300).optional(),
}).strict();
export type FinanceMonitor = z.infer<typeof MonitorSchema>;
export const FINANCE_WORKSPACE_LIMITS = { reports: 200, sources: 1000 } as const;
const WorkspaceSchema = z.object({
  schemaVersion: z.literal(1), ownerScope: id.nullable().default(null), revision: z.number().int().nonnegative(), activeDashboardId: id.nullable(),
  watchlist: z.array(AssetSchema).max(10000), holdings: z.array(HoldingSchema).max(10000),
  quotes: z.array(QuoteSchema).max(20000), dashboards: z.array(DashboardSchema).max(100),
  reports: z.array(ReportSchema).max(FINANCE_WORKSPACE_LIMITS.reports), sources: z.array(SourceSchema).max(FINANCE_WORKSPACE_LIMITS.sources), monitors: z.array(MonitorSchema).max(1000),
}).strict();
export type FinanceWorkspace = z.infer<typeof WorkspaceSchema>;

export interface FinanceSearchResult { assets: FinanceAsset[]; provider: string; asOf: string | null; warnings: string[] }
export interface FinanceAIResult { message: string; operations?: FinanceOperation[]; baseRevision: number; status?: "ok" | "unavailable" | "invalid_output" | "cancelled" | "conflict"; requestId?: string; runtime?: { kind: string; model?: string; execution: string }; artifacts?:{reportId:string;title:string;kind:'chart'|'report'|'newsletter'}[];toolRuns?:{tool:string;status:'ok'|'failed';startedAt:string;errorCode?:string}[]; analystDraft?:import('./finance-analysts').FinanceAnalystDraft }
export const FinanceAskRequestSchema = z.object({
  request: z.string().min(1).max(20000).refine(value => !!value.trim()), screenContext: z.string().max(2000),
  baseRevision: z.number().int().nonnegative(), requestId: id.optional(),
  analystRefs: z.array(FinanceAnalystRefSchema).max(3).refine(items => new Set(items.map(item => item.id)).size === items.length).optional(),
  analystAuthoring: z.boolean().optional(), analystDraft: FinanceAnalystDraftSchema.optional(),
  analystHistory: z.array(z.object({role:z.enum(['user','assistant']),content:z.string().max(20000)}).strict()).max(6).optional(),
}).strict().refine(value => !value.analystDraft || value.analystAuthoring === true)
  .refine(value => !value.analystHistory || value.analystAuthoring === true)
  .refine(value => !value.analystAuthoring || !value.analystRefs?.length);
export type FinanceAskRequest = z.infer<typeof FinanceAskRequestSchema>;
export interface FinanceExportResult { ok: boolean; path?: string; error?: string; sha256?: string; bytes?: number; savedAt?: string; cancelled?: boolean }
export interface FinanceDataRequest { query: string; assetIds: string[]; metrics: string[]; period: string }
export interface FinanceDataConnectionRequest { action: "status" | "test" }
export interface FinanceDataConnectionResult {
  providerId: "alpha-vantage";
  credential: "present" | "missing" | "unknown";
  access: "not-tested" | "available" | "unavailable" | "error";
  checkedAt: string | null;
  probe: { symbol: "IBM"; metric: "price"; asOf: string } | null;
  errorCode?: string;
}
export interface FinanceDataResult {
  status: "ok" | "partial" | "unconnected" | "error";
  sourceUrls: string[]; asOf: string | null; retrievedAt: string;
  columns: string[]; rows: (string | number | null)[][]; warnings: string[];
  providers?: { id: string; label: string; status: "ok" | "partial" | "unavailable" | "error"; coverage: string; rights: string; sourceUrls: string[] }[];
}
export interface FinanceMonitorRun {
  id: string; monitorId: string; status: "running" | "succeeded" | "partial" | "failed" | "cancelled";
  startedAt: string; finishedAt: string | null; reportId: string | null;
  summary: string; warnings: string[]; error: string | null; sourceRevision: number;
}
export interface FinanceDataSaveRequest extends FinanceDataRequest { expectedRevision?: number; mode: "sources" | "report"; title?: string; reportId?: string }
/** An existing report is an explicit CAS append target, never an implicit new report. */
export const FinanceDataSaveRequestSchema = z.object({
  query: z.string().max(2000), assetIds: z.array(id).max(10), metrics: z.array(z.string().min(1).max(80)).min(1).max(10), period: z.string().min(1).max(80),
  expectedRevision: z.number().int().nonnegative().optional(), mode: z.enum(["sources", "report"]), title: z.string().min(1).max(300).optional(), reportId: id.refine(value=>!!value.trim()).optional(),
}).strict().refine(value=>value.reportId===undefined||(value.mode==="report"&&value.expectedRevision!==undefined), "An existing report requires report mode and expectedRevision");
export interface FinanceDataSaveResult {
  workspace: FinanceWorkspace; reportId?: string; sourceIds: string[]; message: string;
  dashboardActions?: { expectedRevision: number; sections: { sectionId: string; operations: FinanceOperation[] }[] };
}
export type FinanceArchiveRequest =
  | { action: "create"; expectedRevision: number; reportIds: string[] }
  | { action: "list"; cursor?: string; limit?: number }
  | { action: "read"; archiveId: string }
  | { action: "read"; reportId: string }
  | { action: "restore"; archiveId: string; reportIds?: string[]; expectedRevision: number };
export interface FinanceArchiveItem {
  archiveId: string; createdAt: string; sourceRevision: number; sha256: string;
  reportIds: string[]; reportTitles: string[]; reportCount: number; sourceCount: number;
}
export type FinanceArchiveResult =
  | { action: "create"; archiveId: string; workspace: FinanceWorkspace; reclaimed: { reports: number; sources: number }; sha256: string; warnings: string[] }
  | { action: "list"; items: FinanceArchiveItem[]; nextCursor: string | null }
  | { action: "read"; archiveId: string; workspaceSnapshot: FinanceWorkspace; reportIds: string[]; sha256: string; warnings: string[] }
  | { action: "restore"; archiveId: string; workspace: FinanceWorkspace; restored: { reports: number; sources: number }; warnings: string[] };
export interface FinanceMonitorRunsRequest { monitorId: string; cursor?: string; limit?: number }
export interface FinanceMonitorRunsResult {
  runs: FinanceMonitorRun[]; nextCursor?: string | null; snapshotSequence?: number;
  indexStatus?: "ready" | "building"; indexedCount?: number;
}
export interface FinanceAPI {
  planning?(input: import('./finance-planning').FinancePlanningRequest): Promise<import('./finance-planning').FinancePlanningResult>;
  portfolio?(input: import('./finance-portfolio').FinancePortfolioRequest): Promise<import('./finance-portfolio').FinancePortfolioResult>;
  analysts?(input: import('./finance-analysts').FinanceAnalystRequest): Promise<import('./finance-analysts').FinanceAnalystResult>;
  experience?(input: import('./finance-experience').FinanceExperienceRequest): Promise<import('./finance-experience').FinanceExperienceState>;
  worldMarkets?(): Promise<import('./finance-experience').FinanceWorldMarketsResult>;
  dashboardFeeds?(): Promise<import('./finance-feeds').FinanceDashboardFeedsResult>;
  load(): Promise<FinanceWorkspace>;
  save(input: { workspace: FinanceWorkspace; expectedRevision: number }): Promise<FinanceWorkspace>;
  search?(input: { query: string }): Promise<FinanceSearchResult>;
  ask?(input: FinanceAskRequest): Promise<FinanceAIResult>;
  cancelAsk?(input: { requestId: string }): Promise<{ cancelled: boolean }>;
  queryData?(input: FinanceDataRequest): Promise<FinanceDataResult>;
  dataConnection?(input: FinanceDataConnectionRequest): Promise<FinanceDataConnectionResult>;
  queryAndSave?(input: FinanceDataSaveRequest): Promise<FinanceDataSaveResult>;
  runMonitor?(input: { monitorId: string }): Promise<FinanceMonitorRun>;
  monitorRuns?(input: FinanceMonitorRunsRequest): Promise<FinanceMonitorRunsResult>;
  archives?(input: FinanceArchiveRequest): Promise<FinanceArchiveResult>;
  onChanged?(listener: (change: { ownerScope: string; revision: number }) => void): () => void;
  refreshQuotes?(): Promise<FinanceAIResult>;
  startResearch?(input: { assetId: string; question?: string }): Promise<{ chatId: string; intentId: string; status: string }>;
  scheduleMonitor?(input: { monitorId: string; scheduleHuman: string }): Promise<{ automationId: string; executionAvailability: "app-running"; status: "active" | "paused" }>;
  pauseMonitor?(input: { monitorId: string }): Promise<{ automationId: string; executionAvailability: "app-running"; status: "active" | "paused" }>;
  exportFile?(input: { filename: string; content: string; mimeType: string; ownerScope: string | null }): Promise<FinanceExportResult>;
}

export function financeId(prefix = "finance"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;
}
export function createFinanceWorkspace(): FinanceWorkspace {
  return { schemaVersion: 1, ownerScope: null, revision: 0, activeDashboardId: "finance-dashboard", watchlist: [], holdings: [], quotes: [], dashboards: [DashboardSchema.parse({id:"finance-dashboard",name:"Agentlas Finance",widgets:[]})], reports: [], sources: [], monitors: [] };
}
const widgetTitles: Record<FinanceWidgetType, string> = { watchlist: "Watchlist", holdings: "Holdings", comparison: "Compare", chart: "Chart", allocation: "Allocation", notes: "Notes", sources: "Sources", events: "Events" };
export function createFinanceWidget(type: FinanceWidgetType, title = widgetTitles[type]): FinanceWidget {
  return WidgetSchema.parse({ id: financeId("widget"), type, title, assetIds: [], metric: "price", chartType: "table", width: "half", period: "1Y", notes: "", priceBasis: "price", cashFlowMethod: "none" });
}
export function createFinanceDashboard(name = "My dashboard", widgets: FinanceWidget[] = []): FinanceDashboard {
  return DashboardSchema.parse({ id: financeId("dashboard"), name, widgets });
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`finance_duplicate_id:${label}`);
}
/** Reserved metric encoding; only an existing saved projection can resolve its evidence. */
export function financeEvidenceMetric(reportId: string, sectionId: string): string {
  try {
    for (const value of [reportId, sectionId]) {
      id.parse(value);
      if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    }
    const metric = `saved:${encodeURIComponent(reportId)}:${encodeURIComponent(sectionId)}`;
    if (metric.length > 200) throw new Error();
    return metric;
  } catch { throw new Error("finance_evidence_metric_invalid"); }
}
export function parseFinanceEvidenceMetric(metric: string): { reportId: string; sectionId: string } | null {
  if (!metric.startsWith("saved:")) return null;
  try {
    const parts = metric.slice(6).split(":");
    if (parts.length !== 2) throw new Error();
    const reportId = decodeURIComponent(parts[0]), sectionId = decodeURIComponent(parts[1]);
    if (financeEvidenceMetric(reportId, sectionId) !== metric) throw new Error();
    return { reportId, sectionId };
  } catch { throw new Error("finance_evidence_metric_invalid"); }
}
function evidenceProjection(ws: FinanceWorkspace, ref: { reportId: string; sectionId: string }): FinanceWidgetProjection | null {
  return ws.reports.find(report => report.id === ref.reportId)?.sections.find(section => section.id === ref.sectionId)?.projection ?? null;
}
export function validateFinanceWorkspace(value: unknown): FinanceWorkspace {
  const ws = WorkspaceSchema.parse(value);
  unique(ws.watchlist.map(x => x.id), "asset"); unique(ws.holdings.map(x => x.id), "holding");
  unique(ws.dashboards.map(x => x.id), "dashboard"); unique(ws.reports.map(x => x.id), "report");
  unique(ws.sources.map(x => x.id), "source"); unique(ws.monitors.map(x => x.id), "monitor");
  const assets = new Set(ws.watchlist.map(x => x.id));
  const sources = new Set(ws.sources.map(x => x.id));
  if (ws.activeDashboardId && !ws.dashboards.some(x => x.id === ws.activeDashboardId)) throw new Error("finance_dashboard_not_found");
  for (const dashboard of ws.dashboards) {
    unique(dashboard.widgets.map(x => x.id), "widget");
    for (const widget of dashboard.widgets) {
      unique(widget.assetIds, "widget_asset");
      if (widget.assetIds.some(assetId => !assets.has(assetId))) throw new Error("finance_widget_asset_reference");
      const ref = parseFinanceEvidenceMetric(widget.metric);
      if (ref && !evidenceProjection(ws, ref)) throw new Error("finance_evidence_reference_invalid");
    }
  }
  for (const monitor of ws.monitors) {
    if (monitor.assetIds.some(assetId => !assets.has(assetId)) || monitor.assetId && !assets.has(monitor.assetId)) throw new Error("finance_monitor_asset_reference");
  }
  for (const report of ws.reports) {
    unique(report.sections.map(x => x.id), "section");
    for (const section of report.sections) if (section.projection?.rows.some(row => row.length !== section.projection!.columns.length)) throw new Error("finance_projection_shape");
  }
  for (const holding of ws.holdings) {
    if (!assets.has(holding.assetId) || !sources.has(holding.sourceId)) throw new Error("finance_holding_reference");
    if (ws.watchlist.find(x => x.id === holding.assetId)?.currency !== holding.currency) throw new Error("finance_holding_currency_mismatch");
  }
  for (const quote of ws.quotes) {
    if (!assets.has(quote.assetId) || !sources.has(quote.sourceId)) throw new Error("finance_quote_reference");
    if (ws.watchlist.find(x => x.id === quote.assetId)?.currency !== quote.currency) throw new Error("finance_quote_currency_mismatch");
  }
  return ws;
}

/** One live canvas; historical report and archive snapshots stay literal. */
export function normalizeFinanceDashboard(value: FinanceWorkspace, preferredId?: string | null): FinanceWorkspace {
  const ws = validateFinanceWorkspace(value);
  if (!ws.dashboards.length) {
    const dashboard = createFinanceWorkspace().dashboards[0];
    return { ...ws, dashboards: [dashboard], activeDashboardId: dashboard.id };
  }
  const preferred=ws.dashboards.find(d=>d.id===(preferredId??ws.activeDashboardId))??ws.dashboards[0];
  const primary=preferred.widgets.length?preferred:ws.dashboards.find(d=>d.widgets.length)??preferred;
  if(ws.dashboards.length===1)return {...ws,activeDashboardId:primary.id};
  const widgets:FinanceWidget[]=[];const used=new Map<string,FinanceWidget>();
  for(const dashboard of [primary,...ws.dashboards.filter(d=>d.id!==primary.id)]) for(const original of dashboard.widgets) {
    const widget={...original,assetIds:[...original.assetIds]};
    if(dashboard.id!==primary.id&&widget.type==="chart"&&widget.periodMode!=="pinned"&&dashboard.period!==primary.period){widget.period=dashboard.period;widget.periodMode="pinned";}
    const collision=used.get(widget.id);
    if(collision&&JSON.stringify(collision)===JSON.stringify(widget))continue;
    if(collision){const base=widget.id.slice(0,160);let suffix=widgets.length;do{widget.id=`${base}-merged-${suffix++}`;}while(used.has(widget.id));}
    used.set(widget.id,widget);widgets.push(widget);
  }
  if(widgets.length>8000)throw new Error("finance_widget_capacity");
  return {...ws,dashboards:[{...primary,widgets}],activeDashboardId:primary.id};
}

export type FinanceOperation =
  | { type: "watchlist.add"; asset: FinanceAsset }
  | { type: "watchlist.remove"; assetId: string }
  | { type: "holdings.import"; assets: FinanceAsset[]; holdings: FinanceHolding[]; quotes?: FinanceQuote[]; sources?: FinanceSource[] }
  | { type: "quotes.import"; quotes: FinanceQuote[] }
  | { type: "dashboard.add"; dashboard: FinanceDashboard }
  | { type: "dashboard.rename"; dashboardId: string; name: string }
  | { type: "dashboard.update"; dashboardId: string; patch: { name?: string; period?: FinanceDashboard["period"] } }
  | { type: "dashboard.remove" | "dashboard.select"; dashboardId: string }
  | { type: "widget.add"; dashboardId: string; widget: FinanceWidget }
  | { type: "widget.update"; dashboardId: string; widgetId: string; patch: Partial<FinanceWidget> }
  | { type: "widget.remove"; dashboardId: string; widgetId: string }
  | { type: "widget.move"; dashboardId: string; widgetId: string; index: number }
  | { type: "report.add"; report: FinanceReport }
  | { type: "report.update"; reportId: string; patch: { title?: string; reviewPending?: boolean; language?: string } }
  | { type: "report.remove"; reportId: string }
  | { type: "report.refresh"; reportId: string }
  | { type: "report.section.update"; reportId: string; sectionId: string; patch: { title?: string; narrative?: string; presentation?: FinanceReportSection["presentation"] } }
  | { type: "report.section.remove"; reportId: string; sectionId: string }
  | { type: "report.section.move"; reportId: string; sectionId: string; index: number }
  | { type: "source.upsert"; source: FinanceSource }
  | { type: "monitor.upsert"; monitor: FinanceMonitor }
  | { type: "monitor.remove"; monitorId: string };

const operationSchemas: Record<FinanceOperation["type"], z.ZodTypeAny> = {
  "watchlist.add": z.object({ type: z.literal("watchlist.add"), asset: AssetSchema }).strict(),
  "watchlist.remove": z.object({ type: z.literal("watchlist.remove"), assetId: id }).strict(),
  "holdings.import": z.object({ type: z.literal("holdings.import"), assets: z.array(AssetSchema).max(10000), holdings: z.array(HoldingSchema).max(10000), quotes: z.array(QuoteSchema).max(20000).optional(), sources: z.array(SourceSchema).max(1000).optional() }).strict(),
  "quotes.import": z.object({ type: z.literal("quotes.import"), quotes: z.array(QuoteSchema).max(20000) }).strict(),
  "dashboard.add": z.object({ type: z.literal("dashboard.add"), dashboard: DashboardSchema }).strict(),
  "dashboard.rename": z.object({ type: z.literal("dashboard.rename"), dashboardId: id, name: z.string().min(1).max(300) }).strict(),
  "dashboard.update": z.object({ type: z.literal("dashboard.update"), dashboardId: id, patch: z.object({ name: z.string().min(1).max(300).optional(), period: z.enum(["1M", "3M", "1Y", "5Y", "all"]).optional() }).strict() }).strict(),
  "dashboard.remove": z.object({ type: z.literal("dashboard.remove"), dashboardId: id }).strict(),
  "dashboard.select": z.object({ type: z.literal("dashboard.select"), dashboardId: id }).strict(),
  "widget.add": z.object({ type: z.literal("widget.add"), dashboardId: id, widget: WidgetSchema }).strict(),
  "widget.update": z.object({ type: z.literal("widget.update"), dashboardId: id, widgetId: id, patch: WidgetSchema.omit({ id: true }).partial().strict() }).strict(),
  "widget.remove": z.object({ type: z.literal("widget.remove"), dashboardId: id, widgetId: id }).strict(),
  "widget.move": z.object({ type: z.literal("widget.move"), dashboardId: id, widgetId: id, index: z.number().int().nonnegative() }).strict(),
  "report.add": z.object({ type: z.literal("report.add"), report: ReportSchema }).strict(),
  "report.update": z.object({ type: z.literal("report.update"), reportId: id, patch: z.object({ title: z.string().min(1).max(300).optional(), reviewPending: z.boolean().optional(), language: FinanceReportLanguageSchema.optional() }).strict() }).strict(),
  "report.remove": z.object({ type: z.literal("report.remove"), reportId: id }).strict(),
  "report.refresh": z.object({ type: z.literal("report.refresh"), reportId: id }).strict(),
  "report.section.update": z.object({ type: z.literal("report.section.update"), reportId: id, sectionId: id, patch: z.object({ title: z.string().min(1).max(300).optional(), narrative: text.optional(), presentation: ReportPresentationSchema.optional() }).strict() }).strict(),
  "report.section.remove": z.object({ type: z.literal("report.section.remove"), reportId: id, sectionId: id }).strict(),
  "report.section.move": z.object({ type: z.literal("report.section.move"), reportId: id, sectionId: id, index: z.number().int().nonnegative() }).strict(),
  "source.upsert": z.object({ type: z.literal("source.upsert"), source: SourceSchema }).strict(),
  "monitor.upsert": z.object({ type: z.literal("monitor.upsert"), monitor: MonitorSchema }).strict(),
  "monitor.remove": z.object({ type: z.literal("monitor.remove"), monitorId: id }).strict(),
};
export function validateFinanceOperation(value: unknown): FinanceOperation {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string" || !Object.prototype.hasOwnProperty.call(operationSchemas, value.type)) throw new Error("finance_invalid_operation");
  return operationSchemas[value.type as FinanceOperation["type"]].parse(value) as FinanceOperation;
}
function requireItem<T extends { id: string }>(items: T[], itemId: string): T {
  const item = items.find(x => x.id === itemId); if (!item) throw new Error("finance_item_not_found"); return item;
}
function upsert<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex(x => x.id === item.id); if (index < 0) items.push(item); else items[index] = item;
}
function move<T extends { id: string }>(items: T[], itemId: string, index: number): void {
  if (index >= items.length) throw new Error("finance_invalid_position");
  const item = requireItem(items, itemId); items.splice(items.indexOf(item), 1); items.splice(index, 0, item);
}
function mergeQuotes(ws: FinanceWorkspace, quotes: FinanceQuote[]): void {
  for (const quote of quotes) {
    const index = ws.quotes.findIndex(x => x.assetId === quote.assetId && x.asOf === quote.asOf && x.priceBasis === quote.priceBasis && x.sourceId === quote.sourceId);
    if (index < 0) ws.quotes.push(quote); else ws.quotes[index] = quote;
  }
}
export function applyFinanceOperations(workspace: FinanceWorkspace, operations: readonly FinanceOperation[]): FinanceWorkspace {
  if (!operations.length || operations.length > 100) throw new Error("finance_invalid_batch_size");
  const next = validateFinanceWorkspace(workspace); // Zod produces a detached copy.
  for (const raw of operations) {
    const op = validateFinanceOperation(raw);
    switch (op.type) {
      case "watchlist.add": upsert(next.watchlist, op.asset); break;
      case "watchlist.remove":
        requireItem(next.watchlist, op.assetId);
        if (next.holdings.some(x => x.assetId === op.assetId)) throw new Error("finance_asset_has_holdings");
        if (next.dashboards.some(x => x.widgets.some(w => w.assetIds.includes(op.assetId))) || next.monitors.some(x => x.assetIds.includes(op.assetId) || x.assetId === op.assetId)) throw new Error("finance_asset_is_referenced");
        next.watchlist = next.watchlist.filter(x => x.id !== op.assetId); next.quotes = next.quotes.filter(x => x.assetId !== op.assetId); break;
      case "holdings.import":
        op.assets.forEach(x => upsert(next.watchlist, x)); op.holdings.forEach(x => upsert(next.holdings, x));
        op.sources?.forEach(x => upsert(next.sources, x)); mergeQuotes(next, op.quotes ?? []); break;
      case "quotes.import": mergeQuotes(next, op.quotes); break;
      case "dashboard.add":
        if (next.dashboards.some(x => x.id === op.dashboard.id)) throw new Error("finance_duplicate_dashboard");
        next.dashboards.push(op.dashboard); next.activeDashboardId = op.dashboard.id; break;
      case "dashboard.rename": requireItem(next.dashboards, op.dashboardId).name = op.name; break;
      case "dashboard.update": Object.assign(requireItem(next.dashboards, op.dashboardId), op.patch); break;
      case "dashboard.select": requireItem(next.dashboards, op.dashboardId); next.activeDashboardId = op.dashboardId; break;
      case "dashboard.remove":
        requireItem(next.dashboards, op.dashboardId); next.dashboards = next.dashboards.filter(x => x.id !== op.dashboardId);
        if (next.activeDashboardId === op.dashboardId) next.activeDashboardId = next.dashboards[0]?.id ?? null; break;
      case "widget.add": requireItem(next.dashboards, op.dashboardId).widgets.push(op.widget); break;
      case "widget.update": Object.assign(requireItem(requireItem(next.dashboards, op.dashboardId).widgets, op.widgetId), op.patch); break;
      case "widget.remove": {
        const dashboard = requireItem(next.dashboards, op.dashboardId); requireItem(dashboard.widgets, op.widgetId); dashboard.widgets = dashboard.widgets.filter(x => x.id !== op.widgetId); break;
      }
      case "widget.move": move(requireItem(next.dashboards, op.dashboardId).widgets, op.widgetId, op.index); break;
      case "report.add":
        if (next.reports.some(x => x.id === op.report.id)) throw new Error("finance_duplicate_report"); next.reports.push(op.report); break;
      case "report.update": Object.assign(requireItem(next.reports, op.reportId), op.patch); break;
      case "report.remove": requireItem(next.reports, op.reportId); next.reports = next.reports.filter(x => x.id !== op.reportId); break;
      case "report.refresh": {
        const previous = requireItem(next.reports, op.reportId);
        if (!previous.dashboardSnapshot) throw new Error("finance_report_requires_requery");
        const refreshed = ReportSchema.parse(previous);
        refreshed.id = financeId("report"); refreshed.parentReportId = previous.id;
        refreshed.createdAt = new Date().toISOString(); refreshed.sourceRevision = workspace.revision; refreshed.reviewPending = true;
        // Saved evidence is already literal; its source report need not remain active.
        // Other widgets recalculate without replacing titles, narratives, order, or pinned periods.
        refreshed.sections = refreshed.sections.map(section => {
          if (section.widget && parseFinanceEvidenceMetric(section.widget.metric)) return section;
          return { ...section, projection: section.widget ? projectFinanceWidget(next, section.widget) : section.kind === "sources" ? projectFinanceWidget(next, createFinanceWidget("sources")) : section.projection };
        });
        next.reports.push(refreshed); break;
      }
      case "report.section.update": Object.assign(requireItem(requireItem(next.reports, op.reportId).sections, op.sectionId), op.patch); break;
      case "report.section.remove": {
        const report = requireItem(next.reports, op.reportId); requireItem(report.sections, op.sectionId); report.sections = report.sections.filter(x => x.id !== op.sectionId); break;
      }
      case "report.section.move": move(requireItem(next.reports, op.reportId).sections, op.sectionId, op.index); break;
      case "source.upsert": upsert(next.sources, op.source); break;
      case "monitor.upsert":
        if (op.monitor.status === "active") throw new Error("finance_monitor_scheduler_unavailable"); upsert(next.monitors, op.monitor); break;
      case "monitor.remove": requireItem(next.monitors, op.monitorId); next.monitors = next.monitors.filter(x => x.id !== op.monitorId); break;
    }
  }
  // Check the final batch state: removing the referencing widget in the same batch is safe.
  for (const dashboard of next.dashboards) for (const widget of dashboard.widgets) {
    const ref = parseFinanceEvidenceMetric(widget.metric);
    if (ref && !evidenceProjection(next, ref) && operations.some(op =>
      op.type === "report.remove" && op.reportId === ref.reportId ||
      op.type === "report.section.remove" && op.reportId === ref.reportId && op.sectionId === ref.sectionId)) {
      throw new Error("finance_evidence_is_referenced");
    }
  }
  next.revision = workspace.revision + 1;
  return normalizeFinanceDashboard(validateFinanceWorkspace(next), workspace.activeDashboardId);
}
export function applyFinanceOperation(workspace: FinanceWorkspace, operation: FinanceOperation): FinanceWorkspace { return applyFinanceOperations(workspace, [operation]); }

export function latestFinanceQuote(ws: FinanceWorkspace, assetId: string, priceBasis: "price" | "total_return" = "price"): FinanceQuote | null {
  return ws.quotes.filter(x => x.assetId === assetId && x.priceBasis === priceBasis).sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf) || a.sourceId.localeCompare(b.sourceId))[0] ?? null;
}
export function effectiveFinanceWidget(dashboard: FinanceDashboard, widget: FinanceWidget): FinanceWidget {
  return { ...widget, assetIds: [...widget.assetIds], period: widget.periodMode === "pinned" ? widget.period : dashboard.period };
}
export function projectFinanceWidget(ws: FinanceWorkspace, widget: FinanceWidget): FinanceWidgetProjection {
  const ref = parseFinanceEvidenceMetric(widget.metric);
  if (ref) {
    const saved = evidenceProjection(ws, ref);
    if (!saved) throw new Error("finance_evidence_reference_invalid");
    // Parse creates a detached literal copy, preserving every recorded date, warning, and source ID.
    return ProjectionSchema.parse(saved);
  }
  const projection: FinanceWidgetProjection = { columns: [], rows: [], status: "empty", warnings: [], asOf: null, sourceIds: [] };
  const selected = ws.watchlist.filter(x => !widget.assetIds.length || widget.assetIds.includes(x.id));
  const quotes = selected.map(x => latestFinanceQuote(ws, x.id, widget.priceBasis)).filter((x): x is FinanceQuote => !!x);
  for (const quote of quotes) {
    if (ws.quotes.some(x => x.assetId === quote.assetId && x.asOf === quote.asOf && x.priceBasis === quote.priceBasis && x.price !== quote.price)) projection.warnings.push(`Conflicting sources for ${quote.assetId} at ${quote.asOf}; selected source ${quote.sourceId}.`);
  }
  projection.sourceIds = [...new Set(quotes.map(x => x.sourceId))];
  // A common timestamp is truthful only when all observations actually share it.
  const times = [...new Set(quotes.map(x => x.asOf))]; projection.asOf = times.length === 1 ? times[0] : null;
  if (times.length > 1) projection.warnings.push("Observations have different timestamps; see each row.");
  if (widget.type === "notes") { projection.columns = ["Note"]; projection.rows = widget.notes ? [[widget.notes]] : []; projection.sourceIds = []; projection.asOf = null; projection.warnings = []; }
  else if (widget.type === "sources") {
    projection.columns = ["Source", "Status", "Observed at", "Retrieved at"];
    projection.rows = ws.sources.map(x => [x.name, x.status, x.asOf, x.retrievedAt]); projection.sourceIds = ws.sources.map(x => x.id);
    const sourceTimes = [...new Set(ws.sources.map(x => x.asOf))];
    projection.asOf = sourceTimes.length === 1 ? sourceTimes[0] : null;
    projection.warnings = sourceTimes.length > 1 ? ["Sources have different or missing observation dates; see each row."] : [];
  }
  else if (widget.type === "events") { projection.status = "unsupported"; projection.sourceIds = []; projection.asOf = null; projection.warnings = ["No event provider is connected."]; return projection; }
  else if (widget.cashFlowMethod !== "none") { projection.status = "unsupported"; projection.warnings.push("TWR/MWR requires dated cash flows and valuation history; a quote snapshot cannot calculate it."); return projection; }
  else if (widget.type === "chart") {
    if (widget.metric !== "price") { projection.status = "unsupported"; projection.warnings.push(`Metric '${widget.metric}' has no connected historical data.`); return projection; }
    projection.columns = ["Observed at", "Symbol", "Currency", "Price", "Source"];
    const matching = ws.quotes.filter(x => selected.some(a => a.id === x.assetId) && x.priceBasis === widget.priceBasis);
    const end = Math.max(...matching.map(x => Date.parse(x.asOf)));
    const days = { "1M": 31, "3M": 93, "1Y": 366, "5Y": 1830, all: Infinity }[widget.period];
    const start = end - days * 86400000;
    const dated = matching.filter(x => Date.parse(x.asOf) >= start).sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf) || a.assetId.localeCompare(b.assetId) || a.sourceId.localeCompare(b.sourceId));
    const seen = new Set<string>();
    for (const quote of dated) {
      const key = `${quote.assetId}:${quote.asOf}`; if (seen.has(key)) continue; seen.add(key);
      const asset = selected.find(x => x.id === quote.assetId)!;
      projection.rows.push([quote.asOf, asset.symbol, quote.currency, quote.price, ws.sources.find(x => x.id === quote.sourceId)?.name ?? null]);
    }
    projection.sourceIds = [...new Set(dated.map(x => x.sourceId))];
    projection.asOf = dated[dated.length - 1]?.asOf ?? null;
    if (projection.rows.length) projection.warnings.push("Range ends at the last imported observation, not current market time. Gaps are not interpolated.");
    if (selected.some(asset => new Set(dated.filter(x => x.assetId === asset.id).map(x => x.asOf)).size < 2)) projection.warnings.push("Some assets have fewer than two observations; do not infer a trend.");
    if (new Set(dated.map(x => x.currency)).size > 1) projection.warnings.push("Different currencies must use separate series/scales; no implicit FX conversion.");
  }
  else if (widget.type === "holdings" || widget.type === "allocation") {
    if (widget.priceBasis !== "price") { projection.status = "unsupported"; projection.warnings.push("Market value requires an actual price. A total-return index is not a tradable valuation price."); return projection; }
    projection.columns = ["Asset", "Quantity", "Currency", "Average cost", "Price", "Market value", "Unrealized P&L", "Observed at"];
    for (const holding of ws.holdings.filter(x => selected.some(a => a.id === x.assetId))) {
      const asset = ws.watchlist.find(x => x.id === holding.assetId)!;
      const quote = latestFinanceQuote(ws, asset.id, "price");
      const price = quote?.currency === holding.currency ? quote.price : null;
      const value = price === null ? null : holding.quantity * price;
      const pnl = price === null || holding.averageCost === null ? null : holding.quantity * (price - holding.averageCost);
      projection.rows.push([asset.symbol, holding.quantity, holding.currency, holding.averageCost, price, value, pnl, quote?.asOf ?? null]);
      projection.sourceIds.push(holding.sourceId); if (quote) projection.sourceIds.push(quote.sourceId);
    }
    projection.warnings.push("Values remain in each holding's currency; no implicit FX conversion or cross-currency total.");
    if (widget.type === "allocation") projection.warnings.push("This is direct holding exposure. ETF look-through and portfolio weights are unavailable without complete compatible holdings and FX data.");
    if (projection.rows.some(x => x[4] === null)) projection.warnings.push("Some holdings have no compatible imported price. Missing values are not zero.");
  } else {
    projection.columns = ["Symbol", "Name", "Exchange", "Currency", "Price", "Observed at", "Source"];
    projection.rows = selected.map(asset => {
      const quote = latestFinanceQuote(ws, asset.id, widget.priceBasis);
      return [asset.symbol, asset.name, asset.exchange, asset.currency, quote?.currency === asset.currency ? quote.price : null, quote?.asOf ?? null, quote ? ws.sources.find(x => x.id === quote.sourceId)?.name ?? null : null];
    });
    if (widget.metric !== "price") projection.warnings.push(`Metric '${widget.metric}' has no connected data; only available price snapshots are shown.`);
    if (projection.rows.some(x => x[4] === null)) projection.warnings.push("Some assets have no compatible imported quote. Missing values are not zero.");
  }
  projection.sourceIds = [...new Set(projection.sourceIds)];
  projection.status = !projection.rows.length ? "empty" : projection.warnings.length ? "partial" : "ready";
  return projection;
}
export function createFinanceReport(ws: FinanceWorkspace, dashboard: FinanceDashboard, title = dashboard.name): FinanceReport {
  const report: FinanceReport = { id: financeId("report"), title, createdAt: new Date().toISOString(), sourceRevision: ws.revision, reviewPending: true, dashboardSnapshot: DashboardSchema.parse(dashboard), parentReportId: null, sections: [
    { id: financeId("section"), title: "Summary", kind: "summary", narrative: "", widget: null, projection: null },
    ...dashboard.widgets.filter(widget => !widget.hidden).map(widget => { const effective = effectiveFinanceWidget(dashboard, widget); return { id: financeId("section"), title: widget.title, kind: "widget" as const, narrative: "", widget: WidgetSchema.parse(effective), projection: projectFinanceWidget(ws, effective) }; }),
    { id: financeId("section"), title: "Sources and limitations", kind: "sources", narrative: "Sources and observation dates are listed below. Check missing values and source limitations before sharing.", widget: null, projection: projectFinanceWidget(ws, createFinanceWidget("sources")) },
  ] };
  return ReportSchema.parse(report);
}

export interface FinanceCsvImport { assets: FinanceAsset[]; holdings: FinanceHolding[]; quotes: FinanceQuote[]; sources: FinanceSource[]; errors: string[]; warnings: string[]; rowCount: number }
/** RFC 4180 quoting, BOM, CRLF, and quoted newlines. Reject malformed files rather than guessing. */
function csvRecords(input: string): string[][] {
  if (input.length > 2_000_000) throw new Error("finance_csv_too_large");
  const source = input.replace(/^\uFEFF/, "");
  const records: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let closed = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error("finance_csv_invalid_quote"); quoted = true;
    } else if (char === ",") { row.push(field); field = ""; closed = false; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field); if (row.some(x => x.trim())) records.push(row); row = []; field = ""; closed = false;
      if (records.length > 10001) throw new Error("finance_csv_too_many_rows");
    } else { if (closed && !/\s/.test(char)) throw new Error("finance_csv_trailing_quote_data"); if (!closed) field += char; }
  }
  if (quoted) throw new Error("finance_csv_unclosed_quote");
  row.push(field); if (row.some(x => x.trim())) records.push(row);
  if (records.length > 10001) throw new Error("finance_csv_too_many_rows");
  return records;
}
function stableAssetId(exchange: string, symbol: string, ccy: string): string { return `asset:${encodeURIComponent(exchange)}:${encodeURIComponent(symbol)}:${ccy}`; }
export function importFinanceCsv(input: string, options: { defaultCurrency?: string } = {}): FinanceCsvImport {
  const result: FinanceCsvImport = { assets: [], holdings: [], quotes: [], sources: [], errors: [], warnings: [], rowCount: 0 };
  let records: string[][];
  try { records = csvRecords(input); } catch (error) { result.errors.push(error instanceof Error ? error.message : "finance_csv_invalid"); return result; }
  if (!records.length) { result.errors.push("CSV is empty."); return result; }
  if (records.length === 1) { result.errors.push("CSV has headers but no data rows."); return result; }
  const aliases: Record<string, string> = { ticker: "symbol", 종목: "symbol", 티커: "symbol", 종목명: "name", 거래소: "exchange", 통화: "currency", 수량: "quantity", 평균단가: "average_cost", cost_basis: "average_cost", averagecost: "average_cost", price: "price", 현재가: "price", asof: "as_of", 기준시각: "as_of", 유형: "kind" };
  const headers = records[0].map(x => { const key = x.trim().toLowerCase().replace(/[ -]/g, "_"); return aliases[key] ?? key; });
  if (new Set(headers).size !== headers.length) { result.errors.push("Duplicate CSV columns."); return result; }
  if (!headers.includes("symbol")) { result.errors.push("Required column: symbol."); return result; }
  const unknown = headers.filter(x => !["symbol", "name", "exchange", "currency", "quantity", "average_cost", "price", "as_of", "kind", "price_basis"].includes(x));
  if (unknown.length) result.warnings.push(`Unused columns: ${unknown.join(", ")}`);
  const now = new Date().toISOString(); const sourceId = financeId("csv");
  const source: FinanceSource = { id: sourceId, name: "CSV import", kind: "csv", status: "imported", asOf: null, retrievedAt: now, url: null, note: "User-provided file; values are not independently verified market data." };
  const seen = new Set<string>();
  for (let index = 1; index < records.length; index++) {
    result.rowCount++;
    const row = records[index];
    if (row.length !== headers.length) { result.errors.push(`Row ${index + 1}: column count mismatch.`); continue; }
    const record: Record<string, string> = Object.create(null); headers.forEach((key, i) => { record[key] = row[i].trim(); });
    try {
      const symbol = record.symbol.toUpperCase(); const ccy = (record.currency || options.defaultCurrency || "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(ccy)) throw new Error("currency must be an explicit three-letter code");
      const exchange = (record.exchange || "").toUpperCase(); const assetId = stableAssetId(exchange, symbol, ccy);
      if (seen.has(assetId)) throw new Error("duplicate asset row; aggregate explicitly before import");
      const asset = AssetSchema.parse({ id: assetId, symbol, name: record.name || symbol, exchange, currency: ccy, kind: record.kind || "other" });
      const parseNumber = (value: string, label: string): number => {
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`${label} must be a nonnegative decimal without separators`);
        return number.nonnegative().parse(Number(value));
      };
      let holding: FinanceHolding | null = null; let quote: FinanceQuote | null = null;
      if (headers.includes("quantity")) {
        if (!record.quantity) throw new Error("quantity is missing, not zero");
        holding = HoldingSchema.parse({ id: `holding:${assetId}`, assetId, quantity: parseNumber(record.quantity, "quantity"), averageCost: record.average_cost ? parseNumber(record.average_cost, "average_cost") : null, currency: ccy, sourceId });
      }
      if (record.price) {
        if (!record.as_of) throw new Error("as_of requires an explicit date or timestamp with timezone when price is supplied");
        const asOf = observationDate.parse(record.as_of);
        quote = QuoteSchema.parse({ assetId, price: parseNumber(record.price, "price"), currency: ccy, asOf, sourceId, priceBasis: record.price_basis || "price" });
      }
      seen.add(assetId); result.assets.push(asset); if (holding) result.holdings.push(holding); if (quote) result.quotes.push(quote);
    } catch (error) { result.errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : "invalid values"}`); }
  }
  if (result.assets.length) result.sources.push(source);
  if (!result.quotes.length && result.assets.length) result.warnings.push("No dated quote snapshots were imported. Market values remain missing.");
  if (result.errors.length) result.warnings.push("Import is not committed. Resolve errors before applying these rows.");
  return result;
}
/** Escape CSV fields and neutralize spreadsheet formula execution on untrusted text. */
export function financeCsvCell(value: string | number | null): string {
  if (value === null) return "";
  let result = String(value);
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(result)) result = `'${result}`;
  return /[",\r\n]/.test(result) ? `"${result.replace(/"/g, '""')}"` : result;
}
export function exportFinanceCsv(value: FinanceWidgetProjection | FinanceWorkspace): string {
  if ("schemaVersion" in value) {
    const headers = ["symbol", "name", "exchange", "currency", "kind", "quantity", "average_cost", "price", "as_of", "price_basis"];
    const rows = value.watchlist.map(asset => {
      const holding = value.holdings.find(x => x.assetId === asset.id); const quote = latestFinanceQuote(value, asset.id);
      return [asset.symbol, asset.name, asset.exchange, asset.currency, asset.kind, holding?.quantity ?? null, holding?.averageCost ?? null, quote?.price ?? null, quote?.asOf ?? null, quote?.priceBasis ?? "price"];
    });
    return [headers, ...rows].map(row => row.map(financeCsvCell).join(",")).join("\r\n");
  }
  return [value.columns, ...value.rows].map(row => row.map(financeCsvCell).join(",")).join("\r\n");
}
