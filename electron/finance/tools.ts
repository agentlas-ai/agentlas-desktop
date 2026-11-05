import { createHash } from 'node:crypto';
import { wasManagedOneConfigured } from '../managed-one/auth';
import { installManagedFinanceHostPolicy } from './cloud-provider';
import { z } from 'zod';
import { FINANCE_WIDGET_TYPES, FINANCE_MONITOR_RUN_TIMEOUT_MS, FINANCE_COMPANY_FACT_CONCEPTS, FinanceCompanyFactsOptionsSchema, FinanceReportLanguageSchema, FinanceDataSaveRequestSchema, financeId, validateFinanceOperation, type FinanceOperation } from '../../shared/finance';
import type { HarnessCallContext } from '../harness/capability-ports';
import { FinanceReceiptReadSchema, FINANCE_RECEIPT_GROUPS, financeReceiptStore, type FinanceReceiptReference } from './receipts';
import { composeDeclaredPrompt, registerDeclaredPromptModule } from '../runtime/prompt-order';
import { FinanceComputeRequestSchema } from '../../shared/finance-compute';
import { FINANCE_SOCIAL_SUPPORTED_PERIODS } from './providers/public-data';
import { FinanceAnalystDraftSchema, FinanceAnalystIdSchema, FinanceAnalystRefSchema, FinanceAnalystRevisionSchema } from '../../shared/finance-analysts';
import { FINANCE_NATIVE_VIEW, FinanceNativeResultSchema, type FinanceNativeResult, type FinanceNativePresentation } from '../../shared/finance-native-ui';
import { financeReportSourceRecords, type FinanceReportSourceRecord } from '../../shared/finance-report-presentation';
import type { UiInstanceView } from '../../shared/ui-instances';
import { financeQueryDrawsSeries } from '../../shared/finance-native-transcript';
import { FinanceCanvasInputSchema } from '../../shared/finance-canvas';
import { canvasLine, type CanvasLine } from '../../shared/canvas';
import { canvasInputJsonSchema } from './canvas-input-schema';
import { buildCanvasCard } from '../canvas/present';
import { presentCanvasCard } from './canvas-present';
import { registerCanvasDomain, type CanvasSeriesRequest } from '../canvas/registry';
import { CANVAS_PORTS } from './canvas-ports';
import { canvasGuideReadInTurn, canvasSeriesReadInTurn, canvasTurnKey, type CanvasSeriesRead } from '../canvas/turn-state';
import { FINANCE_GUIDES_REVISION, FINANCE_GUIDE_TOPICS, financeGuide, financeGuideMenu } from '../../shared/finance-guides';

type Outcome = { status: 'ok'; financeReceipt?: FinanceReceiptReference; nativeUi?: FinanceNativePresentation; /** Absolute paths of files this call wrote: host-only, handed to the run's outputs (harness/run-produced-files.ts), never in the result. */ produced?: readonly string[]; data: unknown } | { status: 'refused' | 'unavailable'; reason: string; next?: string; data?: unknown };
type ToolContext = Pick<HarnessCallContext, 'chatId' | 'runId' | 'permission' | 'dryRun' | 'hostAccountBinding' | 'signal' | 'commandId'>;
const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const queryShape = { query: z.string().max(2000), assetIds: z.array(id).max(10), metrics: z.array(z.string().min(1).max(80)).min(1).max(10), period: z.string().min(1).max(80), facts: FinanceCompanyFactsOptionsSchema.optional() };
const factsOnlyForCompanyFacts = (value: { metrics: string[]; facts?: unknown }) => value.facts === undefined || value.metrics.length === 1 && value.metrics[0] === 'company_facts';
/** An Analyst the model proposes: the stored skill's own fields, plus the exact current revision when it replaces an owner Analyst. */
const analystDraftInput = FinanceAnalystDraftSchema.extend({ id: FinanceAnalystIdSchema.refine(value => value.startsWith('custom-')).optional(), expectedRevision: FinanceAnalystRevisionSchema.optional() }).strict()
  .refine(value => (value.id === undefined) === (value.expectedRevision === undefined));
/** A guide topic the way a model writes it ("Earnings", "macro_regime", "risk") is the guide it names; a word that names no guide asks for the menu. */
const GUIDE_WORDS: Record<string, string> = { earnings: 'earnings-event', earning: 'earnings-event', results: 'earnings-event', filing: 'earnings-event', macro: 'macro-regime', economy: 'macro-regime', election: 'macro-regime', policy: 'macro-regime', fed: 'macro-regime', etf: 'etf-fund', fund: 'etf-fund', bonds: 'bond-rates', bond: 'bond-rates', rates: 'bond-rates', yields: 'bond-rates', fx: 'fx-commodity', currency: 'fx-commodity', currencies: 'fx-commodity', commodity: 'fx-commodity', commodities: 'fx-commodity', gold: 'fx-commodity', oil: 'fx-commodity', dividend: 'dividend-income', dividends: 'dividend-income', income: 'dividend-income', portfolio: 'portfolio-review', holdings: 'portfolio-review', risk: 'risk-drawdown', drawdown: 'risk-drawdown', volatility: 'risk-drawdown', compare: 'compare-assets', comparison: 'compare-assets', versus: 'compare-assets', theme: 'thematic-research', thematic: 'thematic-research', sector: 'thematic-research', screen: 'thematic-research', planning: 'planning-goal', plan: 'planning-goal', retirement: 'planning-goal', goal: 'planning-goal', savings: 'planning-goal', ownership: 'ownership-activity', insider: 'ownership-activity', insiders: 'ownership-activity', '13f': 'ownership-activity', holders: 'ownership-activity', activist: 'ownership-activity', claim: 'thesis-check', thesis: 'thesis-check', rumor: 'thesis-check', report: 'report-structure', stock: 'us-stock', company: 'us-stock', us: 'us-stock', korea: 'kr-stock', korean: 'kr-stock', kr: 'kr-stock', kospi: 'kr-stock', crypto: 'crypto', bitcoin: 'crypto', btc: 'crypto' };
export function financeGuideTopic(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if ((FINANCE_GUIDE_TOPICS as readonly string[]).includes(key)) return key;
  const word = key.split('-').find(part => GUIDE_WORDS[part]);
  return word ? GUIDE_WORDS[word] : undefined;
}
const inputSchemas = {
  load: z.object({}).strict(),
  'analyst.list': z.object({}).strict(),
  'analyst.read': FinanceAnalystRefSchema,
  'analyst.draft': analystDraftInput,
  'analyst.save': z.object({ draft: FinanceAnalystDraftSchema, id: FinanceAnalystIdSchema.optional(), expectedRevision: FinanceAnalystRevisionSchema.optional(), ownerScope: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  'receipt.read': FinanceReceiptReadSchema,
  search: z.object({ query: z.string().min(1).max(200) }).strict(),
  'dashboard.feeds':z.object({}).strict(),
  guide: z.object({ topic: z.preprocess(financeGuideTopic, z.enum(FINANCE_GUIDE_TOPICS as [string, ...string[]]).optional()) }).strip(),
  'portfolio.value':z.object({expectedRevision:revision.optional(),title:z.string().min(1).max(300).optional(),language:FinanceReportLanguageSchema.optional(),narrative:z.string().max(6000).optional()}).strict(),
  calculate:z.object({request:FinanceComputeRequestSchema,period:z.enum(['1M','3M','1Y','5Y','all']).optional(),title:z.string().min(1).max(300).optional(),language:FinanceReportLanguageSchema.optional(),narrative:z.string().max(6000).optional(),chartTitle:z.string().min(1).max(300).optional(),metricsTitle:z.string().min(1).max(300).optional(),metricLabels:z.record(z.string().max(80),z.string().min(1).max(120)).refine(value=>Object.keys(value).length<=16).optional(),highlightMetricIds:z.array(z.string().min(1).max(80)).max(8).optional()}).strict(),
  'asset.add': z.object({ query: z.string().min(1).max(200), symbol: z.string().min(1).max(80).optional() }).strict(),
  query: z.object(queryShape).strict().refine(factsOnlyForCompanyFacts),
  'query.save': FinanceDataSaveRequestSchema,
  apply: z.object({ operations: z.array(z.unknown()).min(1).max(40), expectedRevision: revision }).strict(),
  'portfolio.propose': z.object({ rows: z.array(z.unknown()).min(1).max(100), warnings: z.array(z.string().max(500)).max(20).optional() }).strict(),
  'report.create': z.object({ dashboardId: id.optional(), title: z.string().min(1).max(300).optional(), language: FinanceReportLanguageSchema.optional() }).strict(),
  'report.read': z.object({ reportId: id }).strict(),
  'report.export': z.object({ reportId: id }).strict(),
  'archives.create': z.object({ expectedRevision: revision, reportIds: z.array(id).max(200) }).strict(),
  'archives.list': z.object({ cursor: z.string().max(2000).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  'archives.read': z.union([z.object({ archiveId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), z.object({ reportId: id }).strict()]),
  'archives.restore': z.object({ archiveId: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: revision, reportIds: z.array(id).max(200).optional() }).strict(),
  'monitor.create': z.object({ name: z.string().min(1).max(300), query: z.string().min(1).max(2000), assetIds: z.array(id).min(1).max(10), expectedRevision: revision }).strict(),
  'monitor.update': z.object({ monitorId: id.refine(value=>!!value.trim()), expectedRevision: revision, patch: z.object({ name: z.string().min(1).max(300).refine(value=>!!value.trim()).optional(), query: z.string().min(1).max(2000).refine(value=>!!value.trim()).optional(), assetIds: z.array(id.refine(value=>!!value.trim())).min(1).max(10).refine(values=>new Set(values).size===values.length).optional() }).strict().refine(value=>Object.keys(value).length>0) }).strict(),
  'monitor.run': z.object({ monitorId: id }).strict(),
  'monitor.runs': z.object({ monitorId: id, cursor: z.string().min(1).max(2000).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  'monitor.schedule': z.object({ monitorId: id, scheduleHuman: z.enum(['daily-09:00', 'weekday-09:00', 'hourly', 'every-5m']) }).strict(),
  'monitor.pause': z.object({ monitorId: id }).strict(),
  present: FinanceCanvasInputSchema.extend({ guide: z.preprocess(financeGuideTopic, z.enum(FINANCE_GUIDE_TOPICS as [string, ...string[]]).optional()) }),
};
type Action = keyof typeof inputSchemas;
/** Pure reads (main-work recovery may repeat one that lost its answer). Managed provider reads are excluded below. */
const effectFreeReads = new Set<Action>(['load', 'search', 'query', 'analyst.list', 'analyst.read', 'receipt.read', 'report.read', 'archives.list', 'archives.read', 'monitor.runs']);
const writes = new Set<Action>(['report.export','analyst.save','portfolio.value','calculate','asset.add', 'query.save', 'apply', 'report.create', 'archives.create', 'archives.restore', 'monitor.create', 'monitor.update', 'monitor.run', 'monitor.schedule', 'monitor.pause']);
const editTypes = new Set<FinanceOperation['type']>(['watchlist.remove', 'dashboard.add', 'dashboard.rename', 'dashboard.update', 'dashboard.remove', 'dashboard.select', 'widget.add', 'widget.update', 'widget.remove', 'widget.move', 'report.update', 'report.remove', 'report.refresh', 'report.section.add', 'report.section.update', 'report.section.remove', 'report.section.move']);

/** Models edit presentation and draft prose; data import and source provenance stay with the provider service. */
export function financePluginOperations(values: unknown[]): FinanceOperation[] {
  const operations: FinanceOperation[] = [];
  for (const value of values) {
    const op = validateFinanceOperation(value);
    if (!editTypes.has(op.type)) throw new Error('finance_operation_not_model_authorable');
    if (op.type === 'report.update' && op.patch.reviewPending === false) throw new Error('finance_report_owner_review_required');
    operations.push(op);
    if (op.type.startsWith('report.') && 'reportId' in op && !['report.remove', 'report.refresh'].includes(op.type)) operations.push({ type: 'report.update', reportId: op.reportId, patch: { reviewPending: true } });
  }
  return operations;
}

/** Deterministic view projection from an actual service outcome. No model prose selects a component. */
export function financeNativeView(action:string,raw:Record<string,unknown>,data:unknown,sources?:readonly FinanceReportSourceRecord[]):FinanceNativeResult['view']|null {
  const value=data&&typeof data==='object'&&!Array.isArray(data)?data as Record<string,unknown>:{};
  // A card shows something to read: an empty search or a query that returned no rows (failure, unconnected source) stays a tool result the model reports.
  // Ticker candidates are what the model read to pick an asset, not an outcome for the owner; the phone never draws them either (shared/finance-native-transcript.ts).
  if(action==='search')return null;
  // The answer's own result card: drawn exactly as the model's checked figures and the host's own price reads made it.
  if(action==='present')return (value.view as FinanceNativeResult['view']|undefined)??null;
  // Holdings the assistant read are shown for the owner to edit and save; the card is the only place a save can happen.
  if(action==='portfolio.propose'){const proposal=data as import('./portfolio-proposal').FinancePortfolioProposal;return {kind:'holdings',draft:proposal.draft,baseRevision:proposal.baseRevision};}
  const workspace=value.workspace as import('../../shared/finance').FinanceWorkspace|undefined;
  const report=value.report??workspace?.reports.find(report=>report.id===value.reportId);
  if(['calculate','portfolio.value','query.save','report.create','report.read'].includes(action)&&report){
    const computed=value.computed as {coverage?:{positions:number;pricedPositions:number;missingPositions:number}}|undefined;
    // The provider records the report was built from travel with the card (it has no workspace). A result that carries no workspace (a read) gets them from the caller.
    const records=financeReportSourceRecords(report as import('../../shared/finance').FinanceReport,workspace?.sources??sources);
    return {kind:'report',report:report as import('../../shared/finance').FinanceReport,workspaceRevision:workspace?.revision??Number(value.workspaceRevision),...(computed?.coverage?{coverage:computed.coverage}:{}),...(records.length?{sources:records}:{})};
  }
  if(action==='portfolio.value'){
    const computed=value.computed as {status:'ok'|'partial'|'unavailable';coverage:{positions:number;pricedPositions:number;missingPositions:number}}|undefined;
    return computed?{kind:'portfolio',status:computed.status,coverage:computed.coverage}:null;
  }
  const queried=(action==='query'?data:value.result) as import('../../shared/finance').FinanceDataResult|undefined;
  if((action==='query'||action==='query.save'&&value.result)&&!queried?.rows?.length)return null;
  // A read (filings, news, company facts, keyword search, price rows) stays a tool result the model reports; only a series the owner can see drawn is a card.
  if(action==='query'&&!financeQueryDrawsSeries({metrics:Array.isArray(raw.metrics)?raw.metrics.map(String):[]},queried as import('../../shared/finance').FinanceDataResult))return null;
  if(action==='query'||action==='query.save'&&value.result)return {kind:'query',request:z.object(queryShape).omit({facts:true}).strict().parse({query:raw.query,assetIds:raw.assetIds,metrics:raw.metrics,period:raw.period}),result:(action==='query'?data:value.result) as import('../../shared/finance').FinanceDataResult};
  return null;
}

/** Only the newest proposal in a conversation can be saved; an open earlier one is closed so stale values are never the Save target. "Newest" is the
 * card's sequence and then its id, so two proposals made at the same moment leave exactly one open card. A cancel that loses a race on the card's
 * revision is tried again against the latest one. */
export async function supersedeHoldingsProposals(ctx:Pick<ToolContext,'chatId'|'runId'>,newest:{instanceId:string;sequence:number}):Promise<void>{
  const {listUiInstances,uiUpdate}=await import('../harness/ui-instances');
  const openProposal=(instance:UiInstanceView)=>instance.presentation.viewId===FINANCE_NATIVE_VIEW&&instance.state==='awaiting-input'&&instance.presentation.reason==='decision'&&!instance.closedAt;
  const newer=(instance:UiInstanceView)=>instance.sequence>newest.sequence||instance.sequence===newest.sequence&&instance.instanceId>newest.instanceId;
  for(const listed of await listUiInstances(ctx.chatId)){
    if(listed.instanceId===newest.instanceId||newer(listed)||!openProposal(listed))continue;
    let instance=listed;
    for(let attempt=0;attempt<3;attempt+=1){
      const outcome=await uiUpdate({instanceId:instance.instanceId,expectedRevision:instance.revision,state:'cancelled',reason:'result'},ctx);
      if(outcome.status==='ok'||(outcome as {reason?:string}).reason!=='stale_revision')break;
      const latest=(await listUiInstances(ctx.chatId)).find(item=>item.instanceId===instance.instanceId);
      if(!latest||!openProposal(latest))break;
      instance=latest;
    }
  }
}

async function reportReadSources(scope:import('./store').FinanceScope,data:unknown):Promise<FinanceReportSourceRecord[]|undefined>{
  const value=data as {report?:import('../../shared/finance').FinanceReport;archiveId?:string}|null;
  if(!value?.report)return undefined;
  try{return await (await import('./service')).getFinanceService().reportSources(scope,value.report,value.archiveId);}catch{return undefined;}
}

async function presentFinanceResult(action:Action,raw:Record<string,unknown>,data:unknown,ctx:ToolContext,scope:import('./store').FinanceScope):Promise<FinanceNativePresentation|undefined>{
  if(ctx.dryRun||ctx.chatId==='ui'||!ctx.runId)return undefined;
  if(!['search','query','query.save','calculate','portfolio.value','report.create','report.read','portfolio.propose','present'].includes(action))return undefined;
  // The answer's own result card is the canvas's presentation (electron/finance/canvas-present.ts), the same for ui.canvas.
  if(action==='present')return presentCanvasCard(data as Parameters<typeof presentCanvasCard>[0],raw,ctx,()=>scope.assertCurrent());
  try {
    scope.assertCurrent();ctx.signal?.throwIfAborted();
    const {nativePortOwnerScope,retainNativePortResult}=await import('../harness/tool-dispatch');
    // A read returns the report without its workspace: the provider records it names are looked up here, for the card only.
    const ownerScope=await nativePortOwnerScope(ctx),view=financeNativeView(action,raw,data,action==='report.read'?await reportReadSources(scope,data):undefined);
    if(!view)return undefined;
    const original=FinanceNativeResultSchema.parse({schemaVersion:'finance.native-result.v1',ownerScope,operationId:`finance.${action}`,view,operationResult:data});
    const retained=await retainNativePortResult(ctx,`finance.${action}`,raw,original,ownerScope);
    scope.assertCurrent();ctx.signal?.throwIfAborted();
    const {uiPresent,uiUpdate}=await import('../harness/ui-instances');
    const awaitingOwner=view.kind==='holdings';
    const presentation={...retained,structuredResultRef:retained.resultRef,viewId:FINANCE_NATIVE_VIEW,title:'Finance',
      fallbackText:awaitingOwner?'Finance holdings review: nothing is saved until the owner confirms':view.kind==='canvas'||view.kind==='earnings'||view.kind==='impact'?`Finance ${view.kind}`:'Finance',
      state:awaitingOwner?'awaiting-input':'ready',display:'inline',reason:awaitingOwner?'decision':'result'};
    // A report is built over several calls of one run; the owner sees one card that follows it, not a copy per call.
    const reportInstance=view.kind==='report'?`ui_finance_${createHash('sha256').update(JSON.stringify([ctx.chatId,ctx.runId,view.report.id])).digest('hex').slice(0,32)}`:null;
    let shown=await uiPresent(reportInstance?{...presentation,instanceId:reportInstance}:presentation,ctx);
    if(reportInstance&&shown.status==='refused'&&(shown as {reason?:string}).reason==='instance_exists')shown=await uiUpdate({instanceId:reportInstance,callId:retained.callId,resultRef:retained.resultRef,structuredResultRef:retained.resultRef,title:'Finance',fallbackText:'Finance',state:'ready',reason:'result'},ctx);
    if(shown.status!=='ok')return {status:'unavailable',reason:'finance_ui_not_presented'};
    const instance=(shown.data as {instance?:{instanceId?:string;sequence?:number}}).instance;
    if(!instance?.instanceId)return {status:'unavailable',reason:'finance_ui_not_presented'};
    // The new card is already shown and is the newest; an older card that could not be closed is closed by the next proposal. It is not a reason to say nothing was proposed.
    if(awaitingOwner&&typeof instance.sequence==='number')try{await supersedeHoldingsProposals(ctx,{instanceId:instance.instanceId,sequence:instance.sequence});}catch{/* see above */}
    return {status:'presented',...retained,instanceId:instance.instanceId};
  } catch { return {status:'unavailable',reason:'finance_ui_not_presented'}; }
}

/** Result sentence the host adds to a proposal: the card is the owner's, the save is never the model's. */
const PORTFOLIO_PROPOSAL_NOTE = 'The review card is shown to the owner and nothing is saved. Tell the owner to check the values and press Save holdings in the card; rows in needsAttention cannot be saved until the owner fills them in. Confirm with finance.load before treating the holdings as saved.';

/** A query that reached no provider data is not a success: the harness said "ok" while the failure sat one level down, where a model skims past it. */
const DATA_FAILURE = {
  error: { reason: 'finance_data_error', next: 'The data provider returned an error and no rows (see warnings). Tell the owner the data could not be retrieved. If another metric answers the question (rates: treasury_yields; company text: news or filings), try it; otherwise retry later. Do not present anything as retrieved Finance data.' },
  unconnected: { reason: 'finance_data_unconnected', next: 'No rows: the source for this metric is not connected, is switched off, or does not cover this request (see warnings). Tell the owner what could not be checked, or use another metric; do not present anything as retrieved Finance data.' },
} as const;
export function financeDataFailure(data: unknown): { reason: string; next: string } | null {
  const result = data && typeof data === 'object' ? data as { status?: unknown; rows?: unknown } : null;
  if (!result || (result.status !== 'error' && result.status !== 'unconnected')) return null;
  return Array.isArray(result.rows) && result.rows.length ? null : DATA_FAILURE[result.status];
}

/** The owner's screen language for the confirmation card's own words (title, button); the draft itself is shown as written. */
async function financeOwnerKorean(): Promise<boolean> { try { return (await import('../ui-locale')).currentUiLocale() === 'ko'; } catch { return false; } }

/**
 * Argument variations a model sends as a matter of course are accepted, so a call is never refused for form alone: a number written as text, a
 * different letter case for a fixed word, an optional field sent as null, and a field the operation does not have (dropped; the operation never
 * saw it). A value that is genuinely missing or wrong still fails the schema.
 */
const NUMERIC_ARGUMENTS = new Set(['expectedRevision', 'limit', 'minWeight', 'maxWeight', 'shrinkage', 'periodsPerYear', 'horizon', 'paths', 'seed', 'spot', 'strike', 'rate', 'dividendYield', 'volatility', 'years']);
const LOWERCASE_ARGUMENTS = new Set(['kind', 'method', 'optionType', 'scheduleHuman']);
const PERIOD_WORDS = ['1D', '1W', '7d', '1M', '3M', '1Y', '5Y', 'all', 'current'];
/** A period the way the sources spell it: "1y" and "1 Y" are 1Y, "ALL" and "max" are all; a word no source knows is returned as sent so that the source says so. */
export function canonicalFinancePeriod(value: string): string {
  const text = value.trim();
  if (PERIOD_WORDS.includes(text)) return text;
  const lower = text.toLowerCase().replace(/\s+/g, '');
  if (lower === 'max') return 'all';
  const found = PERIOD_WORDS.find(word => word.toLowerCase() === lower);
  if (found) return found;
  const months = /^(\d{1,2})(?:mo|month|months)$/.exec(lower); if (months) return `${Number(months[1])}M`;
  const years = /^(\d{1,2})(?:yr|year|years)$/.exec(lower); if (years) return `${Number(years[1])}Y`;
  return text;
}
export function tidyFinanceArguments(raw: Record<string, unknown>, action: string, top = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (top && value === null) continue;
    if (NUMERIC_ARGUMENTS.has(key) && typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) out[key] = Number(value);
    else if (LOWERCASE_ARGUMENTS.has(key) && typeof value === 'string') out[key] = value.trim().toLowerCase();
    else if (key === 'currency' && typeof value === 'string') out[key] = value.trim().toUpperCase();
    else if (key === 'period' && ['calculate', 'query', 'query.save'].includes(action) && typeof value === 'string') out[key] = canonicalFinancePeriod(value);
    else if (key === 'request' && top && value && typeof value === 'object' && !Array.isArray(value)) out[key] = tidyFinanceArguments(value as Record<string, unknown>, action, false);
    else out[key] = value;
  }
  return out;
}
export function parseArguments<T extends z.ZodTypeAny>(schema: T, raw: Record<string, unknown>, action: string): z.output<T> {
  const tidy = tidyFinanceArguments(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, action);
  let result = schema.safeParse(tidy);
  // Only a read drops a field it does not have: on a write, a stray field may mean the model meant something this call would then silently not do.
  if (!result.success && effectFreeReads.has(action as Action) && result.error.issues.length && result.error.issues.every(issue => issue.code === 'unrecognized_keys' && issue.path.length === 0)) {
    const extra = new Set(result.error.issues.flatMap(issue => (issue as unknown as { keys: string[] }).keys));
    result = schema.safeParse(Object.fromEntries(Object.entries(tidy).filter(([key]) => !extra.has(key))));
  }
  if (!result.success) throw result.error;
  return result.data;
}

/** No Electron import or provider-specific runner: the sealed host context and shared service own every effect. */
// The guide a turn read first: finance.present is checked against it, so the layout does not depend on the model naming the
// guide again or switching to another guide whose card fits what it wanted to draw (Codex). Keyed by chat and run; bounded.
const guideReadInTurn = canvasGuideReadInTurn;
// The series a turn read (price_history of an asset, a FRED series, an FX pair): a guide card whose chart the model left out is drawn
// from these, the same reads the answer rests on. Keyed like the guide; bounded.
type SeriesRead = CanvasSeriesRead & { metric: 'price_history' | 'macro_series' | 'fx_rates' };
// Both live in electron/canvas/turn-state.ts, shared with ui.canvas, so the two ports check a card against the same reads.
const seriesReadInTurn = canvasSeriesReadInTurn as Map<string, SeriesRead[]>;
function rememberSeriesRead(ctx: Pick<ToolContext, 'chatId' | 'runId'>, input: { metrics: string[]; assetIds?: string[]; query?: string; period?: string }): void {
  if (!ctx.runId) return;
  const metric = input.metrics[0];
  const reads: SeriesRead[] = metric === 'price_history' ? (input.assetIds ?? []).map(assetId => ({ assetId, metric, period: input.period }))
    : (metric === 'macro_series' || metric === 'fx_rates') && input.query?.trim() ? [{ metric, query: input.query.trim(), period: input.period }] : [];
  if (!reads.length) return;
  const key = turnKey(ctx), known = seriesReadInTurn.get(key) ?? [];
  for (const read of reads) if (!known.some(k => k.metric === read.metric && k.assetId === read.assetId && k.query === read.query)) known.push(read);
  seriesReadInTurn.delete(key); seriesReadInTurn.set(key, known.slice(0, 4));
  if (seriesReadInTurn.size > 200) seriesReadInTurn.delete(seriesReadInTurn.keys().next().value!);
}
const turnKey = canvasTurnKey;
/** A chart series of a card as the dated line finance.query read for it (price_history closes, a FRED or ECB series, an FX pair); null when nothing came back. */
async function readFinanceSeries(finance: ReturnType<typeof import('./service').getFinanceService>, scope: import('./store').FinanceScope, series: CanvasSeriesRequest, period: string, signal?: AbortSignal): Promise<CanvasLine | null> {
  const read = await finance.query(scope, { query: series.query ?? series.label, assetIds: series.metric === 'price_history' ? [series.assetId!] : [], metrics: [series.metric as 'price_history'], period: period as '1Y' }, signal);
  return read.status === 'ok' || read.status === 'partial' ? canvasLine(read, series.label) : null;
}
// Finance's part of the result-card canvas: its guides' layouts and its series reader. Drawing, checking and fitting are the canvas's.
const financeCanvasScopes = new WeakMap<object, Promise<import('./store').FinanceScope>>();
registerCanvasDomain({
  id: 'finance', topics: FINANCE_GUIDE_TOPICS, guides: topic => financeGuide(topic)?.layouts,
  readSeries: async (series, period, signal, ctx) => {
    const binding = ctx.hostAccountBinding;
    if (!binding) return null;
    let scope = financeCanvasScopes.get(ctx);
    if (!scope) {
      scope = (async () => { const service = await import('./service'); const made = await service.captureFinanceScope(binding); made.origin = 'agent'; made.assertCurrent(); await (await import('./experience')).requireFinanceConsent(made); made.assertCurrent(); return made; })();
      financeCanvasScopes.set(ctx, scope);
    }
    return readFinanceSeries((await import('./service')).getFinanceService(), await scope, series, period, signal);
  },
});
export async function callFinanceTool(action: Action, raw: Record<string, unknown>, ctx: ToolContext): Promise<Outcome> {
  if ((writes.has(action) || action === 'portfolio.propose' || action === 'analyst.draft') && ctx.dryRun) return { status: 'refused', reason: 'dry_run' };
  if (writes.has(action) && action !== 'monitor.pause' && ctx.permission !== 'write' && ctx.permission !== 'full') return { status: 'refused', reason: 'permission_read_only' };
  // An Analyst is saved only by the owner's press of the confirmation card finance.analyst.draft showed (harness/owner-confirm.ts), never by a model call.
  // A method guide is fixed host content: no account, no source, no receipt.
  if (action === 'guide') {
    try { const { topic } = parseArguments(inputSchemas.guide,raw,action); if (topic && ctx.runId && !guideReadInTurn.has(turnKey(ctx))) { guideReadInTurn.set(turnKey(ctx), topic); if (guideReadInTurn.size > 200) guideReadInTurn.delete(guideReadInTurn.keys().next().value!); } return { status: 'ok', data: topic ? { revision: FINANCE_GUIDES_REVISION, guide: financeGuide(topic) } : { revision: FINANCE_GUIDES_REVISION, topics: financeGuideMenu(), next: 'Call finance.guide again with one topic for its ordered tool steps, how to read the results, what the sources cannot tell and the shape of the answer.' } }; }
    catch (error) { if (error instanceof z.ZodError) return { status: 'refused', reason: 'finance_arguments_invalid', next: `Pass no argument for the topic list, or topic as one of: ${FINANCE_GUIDE_TOPICS.join(', ')}.` }; throw error; }
  }
  let ownerCard: { instanceId: string; chatId: string } | null = null;
  if (action === 'analyst.save') {
    const { ownerConfirmedAction } = await import('../harness/owner-confirm');
    ownerCard = await ownerConfirmedAction(ctx as HarnessCallContext, 'finance.analyst.save');
    if (!ownerCard) return { status: 'refused', reason: 'owner_action_required', next: 'Only the owner saves an Analyst, with the Save button of the card finance.analyst.draft shows.' };
    // The owner's surface carries no run binding: the press acts for the account signed in now, and the card's account must be that one.
    if (!ctx.hostAccountBinding) { try { ctx = { ...ctx, hostAccountBinding: (await import('../auth')).getAuthenticatedSessionBinding() }; } catch { /* refused below */ } }
  }
  if (!ctx.hostAccountBinding) return { status: 'unavailable', reason: 'finance_account_binding_unavailable', next: 'Open an authenticated Agentlas session and start a new turn.' };
  try {
    const service = await import('./service');
    const finance = service.getFinanceService();
    const scope = await service.captureFinanceScope(ctx.hostAccountBinding);
    // Writes made through a tool call are this app's own: a later call holding the revision from before them is not an owner's conflicting edit.
    scope.origin = 'agent';
    scope.assertCurrent();
    if(action!=='monitor.pause')await (await import('./experience')).requireFinanceConsent(scope);scope.assertCurrent();
    if (action === 'receipt.read') return { status: 'ok', data: financeReceiptStore().read(scope, ctx, parseArguments(FinanceReceiptReadSchema,raw,action)) };
    let data: unknown, produced: readonly string[] | undefined;
    switch (action) {
      case 'load': parseArguments(inputSchemas.load,raw,action); data = await finance.load(scope); break;
      case 'analyst.list': {parseArguments(inputSchemas['analyst.list'],raw,action);const result=await finance.analysts(scope,{action:'list'});data={items:result.items.map(({instructions:_,...item})=>item)};break;}
      case 'analyst.read': data=await finance.readAnalyst(scope,parseArguments(inputSchemas['analyst.read'],raw,action));break;
      case 'analyst.draft': {
        const {id:analystId,expectedRevision,...draft}=parseArguments(inputSchemas['analyst.draft'],raw,action);
        // A replacement names the owner's Analyst at its current revision; a stale or unknown one is refused before anything is shown.
        if(analystId){const current=(await finance.analysts(scope,{action:'list'})).items.find(item=>item.id===analystId);if(!current||current.origin!=='custom')throw new Error('finance_analyst_not_found');if(current.revision!==expectedRevision)throw new Error('finance_analyst_revision_conflict');}
        scope.assertCurrent();
        const {nativePortOwnerScope}=await import('../harness/tool-dispatch'),{presentOwnerConfirmation}=await import('../harness/owner-confirm');
        const ko=await financeOwnerKorean();
        const shown=await presentOwnerConfirmation(ctx as HarnessCallContext,{operationId:'finance.analyst.draft',title:ko?`Analyst 저장 확인 · ${draft.name}`:`Save Analyst · ${draft.name}`,
          body:`${draft.name}\n${draft.description}\n\n${draft.instructions}`,summary:ko?`Analyst 초안 「${draft.name}」: 저장 단추를 눌러야 저장됩니다.`:`Analyst draft "${draft.name}": saved only when you press Save.`,
          confirm:{label:ko?'Analyst 저장':'Save Analyst',operationId:'finance.analyst.save',fixedArgs:{draft,...(analystId?{id:analystId,expectedRevision}:{}),ownerScope:await nativePortOwnerScope(ctx as HarnessCallContext)}}});
        scope.assertCurrent();
        if(shown.status!=='presented')return {status:'unavailable',reason:shown.reason,next:'No confirmation card could be shown, so nothing was proposed. The owner can create the Analyst in Finance settings.'};
        data={saved:false,awaitingOwner:true,instanceId:shown.instanceId,name:draft.name,...(analystId?{replaces:analystId}:{})};break;
      }
      case 'analyst.save': {
        const args=parseArguments(inputSchemas['analyst.save'],raw,action);
        const {nativePortOwnerScope}=await import('../harness/tool-dispatch');
        if(await nativePortOwnerScope(ctx as HarnessCallContext)!==args.ownerScope)throw new Error('finance_analyst_owner_mismatch');
        const before=new Set((await finance.analysts(scope,{action:'list'})).items.map(item=>`${item.id}:${item.revision}`));
        const result=await finance.analysts(scope,{action:'save',draft:args.draft,...(args.id?{id:args.id,expectedRevision:args.expectedRevision}:{})});scope.assertCurrent();
        const saved=result.items.find(item=>item.origin==='custom'&&!before.has(`${item.id}:${item.revision}`)&&item.name===args.draft.name);
        data={saved:true,...(saved?{id:saved.id,revision:saved.revision,name:saved.name}:{name:args.draft.name})};
        const {settleOwnerConfirmation}=await import('../harness/owner-confirm');
        await settleOwnerConfirmation(ownerCard!,(await financeOwnerKorean())?`Analyst 「${args.draft.name}」을(를) 저장했습니다.`:`Saved Analyst "${args.draft.name}".`);
        break;
      }
      case 'search': data = await finance.search(scope, parseArguments(inputSchemas.search,raw,action), ctx.signal); break;
      case 'dashboard.feeds':parseArguments(inputSchemas['dashboard.feeds'],raw,action);data=await finance.dashboardFeeds(scope,ctx.signal);break;
      case 'portfolio.value':data=await finance.valuePortfolio(scope,parseArguments(inputSchemas['portfolio.value'],raw,action),ctx.signal);break;
      case 'calculate':data=await finance.calculate(scope,parseArguments(inputSchemas.calculate,raw,action),ctx.signal);break;
      case 'asset.add': data = await finance.addAsset(scope, parseArguments(inputSchemas['asset.add'],raw,action), ctx.signal); break;
      case 'query': { const input = parseArguments(inputSchemas.query,raw,action); data = await finance.query(scope, input, ctx.signal); if (data && typeof data === 'object' && ['ok','partial'].includes(String((data as { status?: unknown }).status))) rememberSeriesRead(ctx, input as { metrics: string[]; assetIds?: string[]; query?: string; period?: string }); break; }
      case 'portfolio.propose': data = { ...await finance.proposePortfolio(scope, parseArguments(inputSchemas['portfolio.propose'],raw,action)), note: PORTFOLIO_PROPOSAL_NOTE }; break;
      case 'query.save': data = await finance.queryAndSave(scope, parseArguments(inputSchemas['query.save'],raw,action), ctx.signal); break;
      case 'apply': {
        const args = parseArguments(inputSchemas.apply,raw,action);
        data = await finance.apply(scope, { operations: financePluginOperations(args.operations), expectedRevision: args.expectedRevision }); break;
      }
      case 'report.create': data = await finance.createReport(scope, parseArguments(inputSchemas['report.create'],raw,action)); break;
      case 'report.export': {
        // The report is read as it is saved; the file is written to the app's generated-assets folder and handed to this run's outputs. The workspace is not changed.
        const args = parseArguments(inputSchemas['report.export'],raw,action);
        const read = await finance.readReport(scope, args); scope.assertCurrent();
        const { exportFinanceReportFile } = await import('./report-export'), { financeScopeHash } = await import('./archive');
        const file = exportFinanceReportFile(financeScopeHash(scope), read.report);
        produced = [file.path];
        data = { reportId: args.reportId, file: { name: file.name, format: 'html', bytes: file.bytes, sha256: file.sha256, sections: file.sections, charts: file.charts, language: file.language }, note: 'The HTML report was written and is listed in this conversation\'s outputs. Tell the owner it is there; do not quote a file path. A chart the Finance screen draws with Vega appears in the file as the table of its saved rows.' };
        break;
      }
      case 'report.read': {
        const args = parseArguments(inputSchemas['report.read'],raw,action);
        data = await finance.readReport(scope, args); break;
      }
      case 'archives.create': data = await finance.archives(scope, { action: 'create', ...parseArguments(inputSchemas['archives.create'],raw,action) }); break;
      case 'archives.list': data = await finance.archives(scope, { action: 'list', ...parseArguments(inputSchemas['archives.list'],raw,action) }); break;
      case 'archives.read': data = await finance.archives(scope, { action: 'read', ...parseArguments(inputSchemas['archives.read'],raw,action) }); break;
      case 'archives.restore': data = await finance.archives(scope, { action: 'restore', ...parseArguments(inputSchemas['archives.restore'],raw,action) }); break;
      case 'monitor.create': {
        const args = parseArguments(inputSchemas['monitor.create'],raw,action);
        data = await finance.apply(scope, { expectedRevision: args.expectedRevision, operations: [{ type: 'monitor.upsert', monitor: { id: financeId('monitor'), name: args.name, query: args.query, assetIds: args.assetIds, status: 'draft', lastCheckedAt: null, nextCheckAt: null, note: '' } }] }); break;
      }
      case 'monitor.update': data = await finance.updateMonitor(scope, parseArguments(inputSchemas['monitor.update'],raw,action), ctx.signal); break;
      case 'monitor.run': {
        const run = await finance.runMonitor(scope, { ...parseArguments(inputSchemas['monitor.run'],raw,action), callerRunId: ctx.runId, callerChatId: ctx.chatId }, ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(FINANCE_MONITOR_RUN_TIMEOUT_MS)]) : undefined);
        scope.assertCurrent();
        if (run.status === 'failed' || run.status === 'cancelled') return { status: 'refused', reason: run.status === 'cancelled' ? 'finance_monitor_cancelled' : 'finance_monitor_failed', data: run, next: 'Inspect the saved run and source connection status before starting another run.' };
        if (run.status === 'running') return { status: 'unavailable', reason: 'finance_monitor_running', data: run };
        data = run; break;
      }
      case 'monitor.runs': data = await finance.monitorRuns(scope, parseArguments(inputSchemas['monitor.runs'],raw,action)); break;
      case 'monitor.schedule': data = await finance.schedule(scope, parseArguments(inputSchemas['monitor.schedule'],raw,action)); break;
      case 'monitor.pause': data = await finance.pause(scope, parseArguments(inputSchemas['monitor.pause'],raw,action)); break;
      case 'present': {
        const { guide: named, ...args } = parseArguments(inputSchemas.present,raw,action);
        // The turn's guide is the first one it read: later reads are related lookups, not a new answer type (Codex read the right guide,
        // then a second one whose card fit the table it wanted, and named that).
        const first = guideReadInTurn.get(turnKey(ctx)), guide = first ?? named;
        // The check, the fit, the chart fill and the series reads are the canvas's (electron/canvas/present.ts), the same for ui.canvas.
        // A card follows a method guide: with none named and none read in this turn there is no layout to hold it to.
        const reads = seriesReadInTurn.get(turnKey(ctx));
        data = await buildCanvasCard(args, { guide, named, first, layouts: guide ? financeGuide(guide)?.layouts : undefined, warningPrefix: 'finance', reads,
          noGuideMessage: `Call finance.guide with the topic that fits this answer first, or pass guide; its card says which blocks to use. Topics: ${FINANCE_GUIDE_TOPICS.join(', ')}.`,
          readSeries: (series, period) => readFinanceSeries(finance, scope, series, period, ctx.signal), signal: ctx.signal });
        break;
      }
    }
    scope.assertCurrent();
    if(action==='query'&&data&&typeof data==='object'&&'warnings'in data&&Array.isArray(data.warnings)&&data.warnings.includes('finance_social_period_invalid'))data={...data,supportedPeriods:[...FINANCE_SOCIAL_SUPPORTED_PERIODS]};
    let financeReceipt: FinanceReceiptReference;
    try { financeReceipt = financeReceiptStore().record(scope, ctx, `finance.${action}`, data, writes.has(action) ? 'saved-result' : ['load', 'report.read', 'monitor.runs', 'archives.read', 'archives.list'].includes(action) ? 'read-snapshot' : 'service-result'); }
    catch { scope.assertCurrent(); financeReceipt = { status: 'unavailable', reason: 'finance_receipt_not_recorded', operationOutcome: 'succeeded' }; }
    scope.assertCurrent();
    const dataFailure=action==='query'?financeDataFailure(data):null;
    if(dataFailure)return { status: 'unavailable', reason: dataFailure.reason, next: dataFailure.next, data };
    const nativeUi=await presentFinanceResult(action,raw,data,ctx,scope);
    if(action==='present'){
      const shown=(data as {view:{kind:string};warnings:string[]});
      if(nativeUi?.status!=='presented')return { status: 'unavailable', reason: 'finance_ui_not_presented', next: 'The card could not be shown. Give the same findings in the answer text.' };
      return { status: 'ok', financeReceipt, nativeUi, data: { shown: true, warnings: shown.warnings, next: 'The card is shown under your answer. The answer text is the conclusion in one or two sentences; the card carries the figures and sources.' } };
    }
    // The card is the whole effect of a proposal: without it nothing reached the owner.
    if(action==='portfolio.propose'&&nativeUi?.status!=='presented')return { status: 'unavailable', reason: 'finance_ui_not_presented', next: 'No review card could be shown, so nothing was proposed. The owner can add holdings from the Finance screen (photo or manual entry).' };
    return { status: 'ok', financeReceipt, ...(nativeUi?{nativeUi}:{}), ...(produced?{produced}:{}), data };
  } catch (error) {
    // A card refused for its layout says exactly what to send again: a refused card was often not sent again (Codex).
    const cardLayout = action === 'present' && error instanceof z.ZodError ? error.issues.find(issue => issue.path.join('.') === 'blocks' || issue.path.join('.') === 'guide')?.message : undefined;
    if (cardLayout) return { status: 'refused', reason: 'finance_arguments_invalid', next: `${cardLayout} Call finance.present again now with those blocks; a chart needs only its series named (metric macro_series with a FRED id, price_history with an asset id from finance.search, or fx_rates with BASE/QUOTE): the host reads the numbers.`, data: { issues: (error as z.ZodError).issues.slice(0, 8).map((issue: z.ZodIssue) => ({ path: issue.path.join('.'), message: issue.message })) } };
    if (error instanceof z.ZodError) return { status: 'refused', reason: 'finance_arguments_invalid', next: 'Read the operation schema and supply its exact fields.', ...(action === 'analyst.draft' || action === 'present' ? { data: { issues: error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } } : {}) };
    if (action === 'portfolio.propose' && error instanceof Error && error.message === 'finance_portfolio_rows_invalid') return { status: 'refused', reason: 'finance_portfolio_rows_invalid', data: { issues: (error as Error & { issues?: unknown }).issues ?? [] }, next: 'Fix the listed fields (null for anything not visible; unrecognized keys are refused) and call finance.portfolio.propose again. Nothing was shown to the owner.' };
    const message = error instanceof Error ? error.message : '';
    return { status: 'refused', reason: /^finance_[a-z0-9_]+$/.test(message) ? message : 'finance_operation_failed', ...(message==='finance_social_period_invalid'?{data:{supportedPeriods:[...FINANCE_SOCIAL_SUPPORTED_PERIODS]}}:{}), next: 'Read the current Finance workspace and source status before retrying.' };
  }
}

const text = { type: 'string' };
const key = { type: 'string', minLength: 1, maxLength: 200 };
const rev = { type: 'integer', minimum: 0 };
const list = { type: 'array', items: key, maxItems: 10 };
const queryMetrics = ['price', 'price_history', 'news', 'filings', 'company_facts', 'social', 'social_search', 'macro_news', 'treasury_yields', 'macro_series', 'fx_rates', 'news_search', 'etf_holdings', 'nav'];
const factsProperty = { type: 'object', additionalProperties: false, description: 'company_facts only. view summary: one observation per period, newest 3 years, 5 quarters, 4 year-to-date periods and 3 balance-sheet dates; full (default): up to 16 latest filings per concept. concepts: only these; revenue is the revenue series whichever US-GAAP revenue concept the filer used, dividends the dividend concepts.', properties: { view: { enum: ['summary', 'full'] }, concepts: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...FINANCE_COMPANY_FACT_CONCEPTS] } } } };
const queryProperties = { query: { ...text, description: 'Search words or a ticker. macro_series: one FRED series id (a wrong id answers with the supported list). fx_rates: BASE/QUOTE, for example USD/KRW. news_search: keywords in any language.' }, assetIds: list, metrics: { type: 'array', items: { enum: queryMetrics }, minItems: 1, maxItems: 1 }, period: { ...text, examples: [...FINANCE_SOCIAL_SUPPORTED_PERIODS] }, facts: factsProperty };
const schema = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties });
const period = { enum: ['1M', '3M', '1Y', '5Y', 'all'] };
const reportLanguage = {type:'string',minLength:2,maxLength:80,pattern:'^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$'};
const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra });
const holdingRow = schema(['name', 'symbol', 'currency', 'quantity'], {
  name: { type: 'string', maxLength: 300, description: 'Security name as shown. Never an account holder, account number or address.' },
  symbol: nullable('string', { maxLength: 80, description: 'Ticker or plan identifier exactly as shown; null if not visible, never inferred from the name.' }),
  exchange: nullable('string', { maxLength: 80, description: 'Listing venue as shown, else null.' }),
  currency: nullable('string', { pattern: '^[A-Z]{3}$', description: 'ISO 4217 code as shown, else null; never inferred from locale.' }),
  quantity: nullable('number', { minimum: 0, description: 'Units or shares held, not money; null if unclear.' }),
  averageCost: nullable('number', { minimum: 0, description: 'Cost per unit, not total cost; null if not shown.' }),
  price: nullable('number', { minimum: 0, description: 'Price per unit shown, not position value; null if not shown.' }),
  asOf: nullable('string', { description: 'Date of that price (YYYY-MM-DD) as shown; required when price is set.' }),
  notes: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 }, description: 'Short notes on anything unreadable or uncertain in this row.' },
});
const widgetProperties = { id: key, type: { enum: [...FINANCE_WIDGET_TYPES] }, title: text, assetIds: {type:'array',items:key}, metric:text, chartType:{enum:['line','bar','table']}, width:{enum:['half','full']}, period, notes:text, periodMode:{enum:['inherit','pinned']}, hidden:{type:'boolean'}, priceBasis:{enum:['price','total_return']}, cashFlowMethod:{enum:['none','twr','mwr']} };
const widgetSchema = schema(['id','type','title','assetIds','metric','chartType','width','period','notes','priceBasis','cashFlowMethod'],widgetProperties);
const { id: _widgetId, ...widgetPatchProperties } = widgetProperties;
const opSchema = (type: string, required: string[], properties:Record<string,unknown>) => schema(['type',...required],{type:{const:type},...properties});
/** The common chart contract (shared/chart-spec.ts): any producer's Vega-Lite spec, a chart tool's output or one written from computed values. */
const reportChart = { type: 'object', description: 'Vega-Lite spec with the values inline in data.values; no url, expressions or full Vega.' };
const editSchema = { oneOf: [
  opSchema('watchlist.remove',['assetId'],{assetId:key}),
  opSchema('dashboard.add',['dashboard'],{dashboard:schema(['id','name','widgets'],{id:key,name:text,period,widgets:{type:'array',items:widgetSchema,maxItems:80}})}),
  opSchema('dashboard.rename',['dashboardId','name'],{dashboardId:key,name:text}),
  opSchema('dashboard.update',['dashboardId','patch'],{dashboardId:key,patch:schema([],{name:text,period})}),
  ...['dashboard.remove','dashboard.select'].map(type=>opSchema(type,['dashboardId'],{dashboardId:key})),
  opSchema('widget.add',['dashboardId','widget'],{dashboardId:key,widget:widgetSchema}),
  opSchema('widget.update',['dashboardId','widgetId','patch'],{dashboardId:key,widgetId:key,patch:schema([],widgetPatchProperties)}),
  opSchema('widget.remove',['dashboardId','widgetId'],{dashboardId:key,widgetId:key}),
  opSchema('widget.move',['dashboardId','widgetId','index'],{dashboardId:key,widgetId:key,index:rev}),
  opSchema('report.update',['reportId','patch'],{reportId:key,patch:schema([],{title:text,reviewPending:{const:true},language:reportLanguage})}),
  ...['report.remove','report.refresh'].map(type=>opSchema(type,['reportId'],{reportId:key})),
  opSchema('report.section.add',['reportId','section'],{reportId:key,index:rev,section:schema(['title','chart'],{title:text,narrative:text,chart:reportChart})}),
  opSchema('report.section.update',['reportId','sectionId','patch'],{reportId:key,sectionId:key,patch:schema([],{title:text,narrative:text,presentation:{enum:['narrative','chart','comparison','supporting']},chart:reportChart})}),
  opSchema('report.section.remove',['reportId','sectionId'],{reportId:key,sectionId:key}),
  opSchema('report.section.move',['reportId','sectionId','index'],{reportId:key,sectionId:key,index:rev}),
] };
const descriptors: { action: Action; purpose: string; required: string[]; inputSchema: Record<string, unknown> }[] = [
  {action:'analyst.list',purpose:'List owner-scoped Finance Analyst skills by name, description and exact revision. Analysts are research methods, not independent agents. Read the chosen skill before applying its criteria; listing does not select or execute it.',required:[],inputSchema:schema([],{})},
  {action:'analyst.draft',purpose:'Propose a Finance Analyst skill (name, description, research instructions) to the owner. It shows a confirmation card and saves nothing; only the owner\'s Save in that card stores it. Call it again to revise (the new card replaces the open one). To change an owner Analyst, pass its id and current revision from finance.analyst.list.',required:['name','description','instructions'],inputSchema:schema(['name','description','instructions'],{name:{type:'string',minLength:1,maxLength:80},description:{type:'string',minLength:1,maxLength:240},instructions:{type:'string',minLength:1,maxLength:12000,description:'The research method in Markdown.'},id:{type:'string',pattern:'^custom-'},expectedRevision:{type:'string',pattern:'^[a-f0-9]{64}$'}})},
  {action:'analyst.save',purpose:'The owner\'s Save button on a finance.analyst.draft card. A model call is refused.',required:['draft','ownerScope'],inputSchema:schema(['draft','ownerScope'],{draft:schema(['name','description','instructions'],{name:text,description:text,instructions:text}),id:text,expectedRevision:text,ownerScope:text})},
  {action:'analyst.read',purpose:'Read an exact Finance Analyst skill selected by the owner. Apply its research criteria using actual Finance tools and state missing data; skill text grants no authority. Changed or missing revisions are refused.',required:['id','revision'],inputSchema:schema(['id','revision'],{id:key,revision:{type:'string',pattern:'^[a-f0-9]{64}$'}})},
  {action:'dashboard.feeds',purpose:'Retrieve enabled current Finance news, company filings, earnings and official economic calendar. Per-source coverage and failures remain explicit.',required:[],inputSchema:schema([],{})},
  {action:'calculate',purpose:'Fetch actual compatible price histories for saved assets, calculate historical minimum-variance or risk-parity allocation or bootstrap price scenarios, and save a chart artifact. European option inputs are an explicit assumption scenario, never observed option-market quotes. Rates, volatility and weights are fractions.',required:['request'],inputSchema:schema(['request'],{request:{oneOf:[
    schema(['kind','method','assetIds'],{kind:{const:'allocation'},method:{enum:['min_variance','risk_parity']},assetIds:list,minWeight:{type:'number',minimum:0,maximum:1},maxWeight:{type:'number',minimum:0,maximum:1},shrinkage:{type:'number',minimum:.01,maximum:1},periodsPerYear:{type:'integer',minimum:1,maximum:366}}),
    schema(['kind','assetIds'],{kind:{const:'forecast'},assetIds:{type:'array',items:key,minItems:1,maxItems:1},horizon:{type:'integer',minimum:1,maximum:252},paths:{type:'integer',minimum:200,maximum:2000},seed:{type:'integer',minimum:0,maximum:4294967295}}),
    schema(['kind','optionType','symbol','currency','spot','strike','rate','volatility','years'],{kind:{const:'option'},optionType:{enum:['call','put']},symbol:text,currency:{type:'string',pattern:'^[A-Z]{3}$'},spot:{type:'number',exclusiveMinimum:0},strike:{type:'number',exclusiveMinimum:0},rate:{type:'number',minimum:-.5,maximum:1},dividendYield:{type:'number',minimum:0,maximum:1},volatility:{type:'number',exclusiveMinimum:0,maximum:5},years:{type:'number',exclusiveMinimum:0,maximum:30}}),
  ]},period,title:text,language:reportLanguage,narrative:{type:'string',maxLength:6000},chartTitle:{type:'string',minLength:1,maxLength:300},metricsTitle:{type:'string',minLength:1,maxLength:300},metricLabels:{type:'object',maxProperties:16,additionalProperties:{type:'string',minLength:1,maxLength:120}},highlightMetricIds:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:80}}})},
  { action: 'receipt.read', purpose: 'Read a bounded field page from an immutable Finance observation in this authenticated chat. A prior snapshot is not current state or Goal verification. Continue with nextCursor index and offset; offsets count Unicode code points.', required: ['receiptId'], inputSchema: schema(['receiptId'], { receiptId: { type: 'string', format: 'uuid' }, group: { enum: [...FINANCE_RECEIPT_GROUPS] }, index: rev, offset: rev }) },
  { action: 'load', purpose: 'Read the authenticated Finance workspace, revision, dashboards, reports, sources and monitor state.', required: [], inputSchema: schema([], {}) },
  { action: 'portfolio.value', purpose: 'Refresh actual saved holdings prices and freeze complete per-currency portfolio values as a chart report. Missing or incompatible prices remain explicit; currencies are never converted or aggregated.', required: [], inputSchema: schema([], { expectedRevision: rev, title: text, language: reportLanguage, narrative: {type:'string',maxLength:6000} }) },
  { action: 'portfolio.propose', purpose: 'Show the owner an editable review of holdings you read from their photo or pasted text: one row per position, unknown fields null and never guessed. Nothing is saved: only the owner\'s Save in that card stores them in Finance, replacing (not adding to) the quantity of an asset already held. Tell the owner to review and save, and check finance.load before treating them as saved.', required: ['rows'], inputSchema: schema(['rows'], { rows: { type: 'array', minItems: 1, maxItems: 100, items: holdingRow }, warnings: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } } }) },
  { action: 'guide', purpose: 'Method guides for Finance research by asset type and situation (a U.S. or Korean stock, an ETF, rates, crypto, FX and commodities, the macro backdrop, an earnings event, dividends, a portfolio review, risk, a comparison, a theme, a claim to check, the finished report). No topic lists them; a topic returns the ordered tool steps with metric and period, how to read the results, what the sources cannot tell, and the shape of the answer. Fixed host content, no account data.', required: [], inputSchema: schema([], { topic: { enum: FINANCE_GUIDE_TOPICS } }) },
  { action: 'search', purpose: 'Search actual provider asset metadata; returns coverage and connection warnings.', required: ['query'], inputSchema: schema(['query'], { query: text }) },
  { action: 'asset.add', purpose: 'Resolve one asset against the provider and persist it in the Finance watchlist.', required: ['query'], inputSchema: schema(['query'], { query: text, symbol: text }) },
  { action: 'query', purpose: 'Retrieve source data for one asset (an ID finance.search returned, or a saved one) and one metric per call, with observation times, provenance and coverage gaps. No asset is needed for social_search, macro_news, treasury_yields, macro_series (FRED series), fx_rates (ECB reference rates) and news_search (news in any language); none of these needs a key. For the method of a kind of analysis, call finance.guide first.', required: ['query', 'assetIds', 'metrics', 'period'], inputSchema: schema(['query', 'assetIds', 'metrics', 'period'], queryProperties) },
  { action: 'query.save', purpose: 'Retrieve source data and save evidence or a frozen report in Finance. With reportId, append host-retrieved supporting evidence to that active report while preserving its existing prose and data; report mode and the current expectedRevision are required.', required: ['query', 'assetIds', 'metrics', 'period', 'mode'], inputSchema: { ...schema(['query', 'assetIds', 'metrics', 'period', 'mode'], { ...queryProperties, mode: { enum: ['sources', 'report'] }, title: text, expectedRevision: rev, reportId: { ...key, pattern: '\\S' } }), allOf: [{ if: { required: ['reportId'] }, then: { required: ['expectedRevision'], properties: { mode: { const: 'report' } } } }] } },
  { action: 'apply', purpose: 'Apply canonical dashboard/widget edits or draft report text at an expected Finance revision; provider data and reviewed status are host-owned.', required: ['operations', 'expectedRevision'], inputSchema: schema(['operations', 'expectedRevision'], { expectedRevision: rev, operations: { type: 'array', minItems: 1, maxItems: 40, items: editSchema } }) },
  { action: 'report.create', purpose: 'Freeze an existing Finance dashboard into a host-generated report snapshot.', required: [], inputSchema: schema([], { dashboardId: key, title: text, language:reportLanguage }) },
  { action: 'report.export', purpose: 'Write a saved Finance report (active or archived) as one self-contained HTML file in this conversation\'s outputs: the report\'s own text, charts drawn from its saved dated series, key figures, a notice. It changes nothing in the Finance workspace. Read the report (finance.report.read) and write its summary (finance.apply) first.', required: ['reportId'], inputSchema: schema(['reportId'], { reportId: key }) },
  { action: 'report.read', purpose: 'Read a saved Finance report and its evidence without refreshing its snapshot.', required: ['reportId'], inputSchema: schema(['reportId'], { reportId: key }) },
  { action: 'archives.create', purpose: 'Preserve a verified full edition, then remove selected active reports and unreferenced sources at an expected revision. An empty selection archives only unused sources.', required: ['expectedRevision', 'reportIds'], inputSchema: schema(['expectedRevision', 'reportIds'], { expectedRevision: rev, reportIds: { type: 'array', items: key, maxItems: 200, uniqueItems: true } }) },
  { action: 'archives.list', purpose: 'Read a bounded page of preserved Finance editions without changing active material.', required: [], inputSchema: schema([], { cursor: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
  { action: 'archives.read', purpose: 'Read a preserved Finance edition by archive ID or archived report ID without restoring it.', required: [], inputSchema: { oneOf: [schema(['archiveId'], { archiveId: { type: 'string', pattern: '^[a-f0-9]{64}$' } }), schema(['reportId'], { reportId: key })] } },
  { action: 'archives.restore', purpose: 'Restore selected preserved reports and required sources at an expected revision. Omitting report IDs also restores sources removed by that edition; conflicting contents and capacity are refused.', required: ['archiveId', 'expectedRevision'], inputSchema: schema(['archiveId', 'expectedRevision'], { archiveId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, expectedRevision: rev, reportIds: { type: 'array', items: key, maxItems: 200, uniqueItems: true } }) },
  { action: 'monitor.create', purpose: 'Create a draft research monitor for saved assets; creation does not enable a schedule.', required: ['name', 'query', 'assetIds', 'expectedRevision'], inputSchema: schema(['name', 'query', 'assetIds', 'expectedRevision'], { name: text, query: text, assetIds: list, expectedRevision: rev }) },
  { action: 'monitor.update', purpose: 'Edit an existing draft or paused research monitor by ID, preserving its history and schedule metadata. Pause active schedules and wait for running checks before editing.', required: ['monitorId', 'expectedRevision', 'patch'], inputSchema: schema(['monitorId', 'expectedRevision', 'patch'], { monitorId: { ...key, pattern: '\\S' }, expectedRevision: rev, patch: { ...schema([], { name: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' }, query: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, assetIds: { ...list, minItems: 1, uniqueItems: true, items: { ...key, pattern: '\\S' } } }), minProperties: 1 } }) },
  { action: 'monitor.run', purpose: 'Run an existing Finance monitor and persist its actual result, evidence and briefing report.', required: ['monitorId'], inputSchema: schema(['monitorId'], { monitorId: key }) },
  { action: 'monitor.runs', purpose: 'Read a bounded snapshot page of actual Finance monitor runs and their report references, or explicit index-building progress.', required: ['monitorId'], inputSchema: schema(['monitorId'], { monitorId: key, cursor: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
  { action: 'monitor.schedule', purpose: 'Enable an existing Finance monitor through the host scheduler.', required: ['monitorId', 'scheduleHuman'], inputSchema: schema(['monitorId', 'scheduleHuman'], { monitorId: key, scheduleHuman: { enum: ['daily-09:00', 'weekday-09:00', 'hourly', 'every-5m'] } }) },
  { action: 'monitor.pause', purpose: 'Pause future executions of the bound Finance monitor without requiring a view revision.', required: ['monitorId'], inputSchema: schema(['monitorId'], { monitorId: key }) },
  { action: 'present', purpose: 'Show the owner a result card under your answer text; an answer that reports figures, from Finance or the web, ends with one call after your reads. Compose it from blocks: kpis (headline figures with prior values), bars (one or two series per row), ranges (low–high bands), chart (the host reads and draws the series), leans (direction rows with a reason), table, heatmap, allocation, timeline, checklist, gauge, note. Use only what you read this turn and give its sources. Amounts are in full units (481000000, not 481) or text like "481.0M". A 12-column grid: widths full, two_thirds, half, third.', required: ['title', 'blocks', 'sources'], inputSchema: canvasInputJsonSchema({ enum: FINANCE_GUIDE_TOPICS, description: 'The finance.guide topic whose card these blocks follow; the host checks them against its layouts and sets their widths.' }) },
];
const managedFinanceHostAtImport=wasManagedOneConfigured();
const FINANCE_ACTION_PORTS = descriptors.map(({ action, purpose, required, inputSchema }) => {
  composeDeclaredPrompt([{ id: `tool.finance.${action}.schema`, revision: action==='query.save'?7:action==='query'?6:action==='apply'?3:action==='present'?3:['calculate','report.create','portfolio.propose'].includes(action)?2:1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(inputSchema) }]);
  return { operationId: `finance.${action}`, kind: writes.has(action) ? 'command' as const : 'query' as const, required, inputSchema,
    ...(action === 'monitor.pause' ? { terminalTargetKeys: ['monitorId'] as const, terminalUnderReadPermission: true as const } : {}),
    ...(action === 'monitor.run' ? { callTimeoutMs: FINANCE_MONITOR_RUN_TIMEOUT_MS } : {}),
    // The provider client accepts requests only after these actual Managed metadata are latched below.
    ...(managedFinanceHostAtImport&&['search','query','asset.add','query.save'].includes(action)?{callTimeoutMs:60000}:{}),
    ...(effectFreeReads.has(action)&&!(managedFinanceHostAtImport&&['search','query'].includes(action)) ? { effectFreeRead: true as const } : {}),
    purpose: composeDeclaredPrompt([{ id: `tool.finance.${action}.description`, revision: action === 'query.save' ? 2 : action === 'present' ? 4 : action === 'query' ? 4 : 1, stability: 'fixed-policy', changeTriggers: ['release'], text: purpose }]),
    handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => callFinanceTool(action, args, ctx) };
});
// ui.canvas (electron/finance/canvas-ports.ts) is registered here until electron/harness/capability-ports.ts spreads CANVAS_PORTS itself (that file was being edited by another session).
export const FINANCE_PORTS = [...FINANCE_ACTION_PORTS, ...CANVAS_PORTS];
installManagedFinanceHostPolicy(FINANCE_PORTS);
// analyst r2 (2026-10-28): the retired analyst_draft name corrected to the declared finance.analyst.draft; first registered here (its bytes reached the model through skill.read unregistered).
const FINANCE_SKILL_REVISION: Record<string, number> = { index: 13, research: 6, workspace: 3, monitor: 3, analyst: 2 };
registerDeclaredPromptModule({ id: 'tool.finance.guide.content', revision: FINANCE_GUIDES_REVISION, stability: 'versioned-content', changeTriggers: ['release'] });
for (const workflow of ['index', 'research', 'workspace', 'monitor', 'analyst']) registerDeclaredPromptModule({ id: `plugin.finance.skill.${workflow}`, revision: FINANCE_SKILL_REVISION[workflow], stability: 'versioned-content', changeTriggers: ['release', 'skill-package'] });

/** Preserve the installed bytes and their hash while declaring the actual skill tool-result channel. */
export function composeFinanceSkillContent(skillId: string, content: string): string {
  const workflow = ['index', 'research', 'workspace', 'monitor', 'analyst'].find(name => skillId === `plugin:finance/${name}`);
  return workflow ? composeDeclaredPrompt([{ id: `plugin.finance.skill.${workflow}`, revision: FINANCE_SKILL_REVISION[workflow], stability: 'versioned-content', changeTriggers: ['release', 'skill-package'], text: content }]) : content;
}
