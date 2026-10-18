import { z } from 'zod';
import { FINANCE_WIDGET_TYPES, FINANCE_MONITOR_RUN_TIMEOUT_MS, FinanceReportLanguageSchema, financeId, validateFinanceOperation, type FinanceOperation } from '../../shared/finance';
import type { HarnessCallContext } from '../harness/capability-ports';
import { FinanceReceiptReadSchema, FINANCE_RECEIPT_GROUPS, financeReceiptStore, type FinanceReceiptReference } from './receipts';
import { composeDeclaredPrompt, registerDeclaredPromptModule } from '../runtime/prompt-order';
import { FinanceComputeRequestSchema } from '../../shared/finance-compute';

type Outcome = { status: 'ok'; financeReceipt?: FinanceReceiptReference; data: unknown } | { status: 'refused' | 'unavailable'; reason: string; next?: string; data?: unknown };
type ToolContext = Pick<HarnessCallContext, 'chatId' | 'runId' | 'permission' | 'dryRun' | 'hostAccountBinding' | 'signal'>;
const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const queryShape = { query: z.string().max(2000), assetIds: z.array(id).max(10), metrics: z.array(z.string().min(1).max(80)).min(1).max(10), period: z.string().min(1).max(80) };
const inputSchemas = {
  load: z.object({}).strict(),
  'receipt.read': FinanceReceiptReadSchema,
  search: z.object({ query: z.string().min(1).max(200) }).strict(),
  'dashboard.feeds':z.object({}).strict(),
  calculate:z.object({request:FinanceComputeRequestSchema,period:z.enum(['1M','3M','1Y','5Y','all']).optional(),title:z.string().min(1).max(300).optional(),language:FinanceReportLanguageSchema.optional(),narrative:z.string().max(6000).optional(),chartTitle:z.string().min(1).max(300).optional(),metricsTitle:z.string().min(1).max(300).optional(),metricLabels:z.record(z.string().max(80),z.string().min(1).max(120)).refine(value=>Object.keys(value).length<=16).optional(),highlightMetricIds:z.array(z.string().min(1).max(80)).max(8).optional()}).strict(),
  'asset.add': z.object({ query: z.string().min(1).max(200), symbol: z.string().min(1).max(80).optional() }).strict(),
  query: z.object(queryShape).strict(),
  'query.save': z.object({ ...queryShape, mode: z.enum(['sources', 'report']), title: z.string().min(1).max(300).optional(), expectedRevision: revision.optional() }).strict(),
  apply: z.object({ operations: z.array(z.unknown()).min(1).max(40), expectedRevision: revision }).strict(),
  'report.create': z.object({ dashboardId: id.optional(), title: z.string().min(1).max(300).optional(), language: FinanceReportLanguageSchema.optional() }).strict(),
  'report.read': z.object({ reportId: id }).strict(),
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
};
type Action = keyof typeof inputSchemas;
const writes = new Set<Action>(['calculate','asset.add', 'query.save', 'apply', 'report.create', 'archives.create', 'archives.restore', 'monitor.create', 'monitor.update', 'monitor.run', 'monitor.schedule', 'monitor.pause']);
const editTypes = new Set<FinanceOperation['type']>(['watchlist.remove', 'dashboard.add', 'dashboard.rename', 'dashboard.update', 'dashboard.remove', 'dashboard.select', 'widget.add', 'widget.update', 'widget.remove', 'widget.move', 'report.update', 'report.remove', 'report.refresh', 'report.section.update', 'report.section.remove', 'report.section.move']);

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

/** No Electron import or provider-specific runner: the sealed host context and shared service own every effect. */
export async function callFinanceTool(action: Action, raw: Record<string, unknown>, ctx: ToolContext): Promise<Outcome> {
  if (writes.has(action) && ctx.dryRun) return { status: 'refused', reason: 'dry_run' };
  if (writes.has(action) && action !== 'monitor.pause' && ctx.permission !== 'write' && ctx.permission !== 'full') return { status: 'refused', reason: 'permission_read_only' };
  if (!ctx.hostAccountBinding) return { status: 'unavailable', reason: 'finance_account_binding_unavailable', next: 'Open an authenticated Agentlas session and start a new turn.' };
  try {
    const service = await import('./service');
    const finance = service.getFinanceService();
    const scope = await service.captureFinanceScope(ctx.hostAccountBinding);
    scope.assertCurrent();
    if (action === 'receipt.read') return { status: 'ok', data: financeReceiptStore().read(scope, ctx, FinanceReceiptReadSchema.parse(raw)) };
    let data: unknown;
    switch (action) {
      case 'load': inputSchemas.load.parse(raw); data = await finance.load(scope); break;
      case 'search': data = await finance.search(scope, inputSchemas.search.parse(raw)); break;
      case 'dashboard.feeds':inputSchemas['dashboard.feeds'].parse(raw);data=await finance.dashboardFeeds(scope,ctx.signal);break;
      case 'calculate':data=await finance.calculate(scope,inputSchemas.calculate.parse(raw),ctx.signal);break;
      case 'asset.add': data = await finance.addAsset(scope, inputSchemas['asset.add'].parse(raw)); break;
      case 'query': data = await finance.query(scope, inputSchemas.query.parse(raw)); break;
      case 'query.save': data = await finance.queryAndSave(scope, inputSchemas['query.save'].parse(raw)); break;
      case 'apply': {
        const args = inputSchemas.apply.parse(raw);
        data = await finance.apply(scope, { operations: financePluginOperations(args.operations), expectedRevision: args.expectedRevision }); break;
      }
      case 'report.create': data = await finance.createReport(scope, inputSchemas['report.create'].parse(raw)); break;
      case 'report.read': {
        const args = inputSchemas['report.read'].parse(raw);
        data = await finance.readReport(scope, args); break;
      }
      case 'archives.create': data = await finance.archives(scope, { action: 'create', ...inputSchemas['archives.create'].parse(raw) }); break;
      case 'archives.list': data = await finance.archives(scope, { action: 'list', ...inputSchemas['archives.list'].parse(raw) }); break;
      case 'archives.read': data = await finance.archives(scope, { action: 'read', ...inputSchemas['archives.read'].parse(raw) }); break;
      case 'archives.restore': data = await finance.archives(scope, { action: 'restore', ...inputSchemas['archives.restore'].parse(raw) }); break;
      case 'monitor.create': {
        const args = inputSchemas['monitor.create'].parse(raw);
        data = await finance.apply(scope, { expectedRevision: args.expectedRevision, operations: [{ type: 'monitor.upsert', monitor: { id: financeId('monitor'), name: args.name, query: args.query, assetIds: args.assetIds, status: 'draft', lastCheckedAt: null, nextCheckAt: null, note: '' } }] }); break;
      }
      case 'monitor.update': data = await finance.updateMonitor(scope, inputSchemas['monitor.update'].parse(raw), ctx.signal); break;
      case 'monitor.run': {
        const run = await finance.runMonitor(scope, { ...inputSchemas['monitor.run'].parse(raw), callerRunId: ctx.runId, callerChatId: ctx.chatId }, ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(FINANCE_MONITOR_RUN_TIMEOUT_MS)]) : undefined);
        scope.assertCurrent();
        if (run.status === 'failed' || run.status === 'cancelled') return { status: 'refused', reason: run.status === 'cancelled' ? 'finance_monitor_cancelled' : 'finance_monitor_failed', data: run, next: 'Inspect the saved run and source connection status before starting another run.' };
        if (run.status === 'running') return { status: 'unavailable', reason: 'finance_monitor_running', data: run };
        data = run; break;
      }
      case 'monitor.runs': data = await finance.monitorRuns(scope, inputSchemas['monitor.runs'].parse(raw)); break;
      case 'monitor.schedule': data = await finance.schedule(scope, inputSchemas['monitor.schedule'].parse(raw)); break;
      case 'monitor.pause': data = await finance.pause(scope, inputSchemas['monitor.pause'].parse(raw)); break;
    }
    scope.assertCurrent();
    let financeReceipt: FinanceReceiptReference;
    try { financeReceipt = financeReceiptStore().record(scope, ctx, `finance.${action}`, data, writes.has(action) ? 'saved-result' : ['load', 'report.read', 'monitor.runs', 'archives.read', 'archives.list'].includes(action) ? 'read-snapshot' : 'service-result'); }
    catch { scope.assertCurrent(); financeReceipt = { status: 'unavailable', reason: 'finance_receipt_not_recorded', operationOutcome: 'succeeded' }; }
    scope.assertCurrent();
    return { status: 'ok', financeReceipt, data };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 'refused', reason: 'finance_arguments_invalid', next: 'Read the operation schema and supply its exact fields.' };
    const message = error instanceof Error ? error.message : '';
    return { status: 'refused', reason: /^finance_[a-z0-9_]+$/.test(message) ? message : 'finance_operation_failed', next: 'Read the current Finance workspace and source status before retrying.' };
  }
}

const text = { type: 'string' };
const key = { type: 'string', minLength: 1, maxLength: 200 };
const rev = { type: 'integer', minimum: 0 };
const list = { type: 'array', items: key, maxItems: 10 };
const queryProperties = { query: text, assetIds: list, metrics: { type: 'array', items: text, minItems: 1, maxItems: 10 }, period: text };
const schema = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties });
const period = { enum: ['1M', '3M', '1Y', '5Y', 'all'] };
const reportLanguage = {type:'string',minLength:2,maxLength:80,pattern:'^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$'};
const widgetProperties = { id: key, type: { enum: [...FINANCE_WIDGET_TYPES] }, title: text, assetIds: {type:'array',items:key}, metric:text, chartType:{enum:['line','bar','table']}, width:{enum:['half','full']}, period, notes:text, periodMode:{enum:['inherit','pinned']}, hidden:{type:'boolean'}, priceBasis:{enum:['price','total_return']}, cashFlowMethod:{enum:['none','twr','mwr']} };
const widgetSchema = schema(['id','type','title','assetIds','metric','chartType','width','period','notes','priceBasis','cashFlowMethod'],widgetProperties);
const { id: _widgetId, ...widgetPatchProperties } = widgetProperties;
const opSchema = (type: string, required: string[], properties:Record<string,unknown>) => schema(['type',...required],{type:{const:type},...properties});
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
  opSchema('report.section.update',['reportId','sectionId','patch'],{reportId:key,sectionId:key,patch:schema([],{title:text,narrative:text,presentation:{enum:['narrative','chart','comparison','supporting']}})}),
  opSchema('report.section.remove',['reportId','sectionId'],{reportId:key,sectionId:key}),
  opSchema('report.section.move',['reportId','sectionId','index'],{reportId:key,sectionId:key,index:rev}),
] };
const descriptors: { action: Action; purpose: string; required: string[]; inputSchema: Record<string, unknown> }[] = [
  {action:'dashboard.feeds',purpose:'Retrieve enabled current Finance news, company filings, earnings and official economic calendar. Per-source coverage and failures remain explicit.',required:[],inputSchema:schema([],{})},
  {action:'calculate',purpose:'Fetch actual compatible price histories for saved assets, calculate historical minimum-variance or risk-parity allocation or bootstrap price scenarios, and save a chart artifact. European option inputs are an explicit assumption scenario, never observed option-market quotes. Rates, volatility and weights are fractions.',required:['request'],inputSchema:schema(['request'],{request:{oneOf:[
    schema(['kind','method','assetIds'],{kind:{const:'allocation'},method:{enum:['min_variance','risk_parity']},assetIds:list,minWeight:{type:'number',minimum:0,maximum:1},maxWeight:{type:'number',minimum:0,maximum:1},shrinkage:{type:'number',minimum:.01,maximum:1},periodsPerYear:{type:'integer',minimum:1,maximum:366}}),
    schema(['kind','assetIds'],{kind:{const:'forecast'},assetIds:{type:'array',items:key,minItems:1,maxItems:1},horizon:{type:'integer',minimum:1,maximum:252},paths:{type:'integer',minimum:200,maximum:2000},seed:{type:'integer',minimum:0,maximum:4294967295}}),
    schema(['kind','optionType','symbol','currency','spot','strike','rate','volatility','years'],{kind:{const:'option'},optionType:{enum:['call','put']},symbol:text,currency:{type:'string',pattern:'^[A-Z]{3}$'},spot:{type:'number',exclusiveMinimum:0},strike:{type:'number',exclusiveMinimum:0},rate:{type:'number',minimum:-.5,maximum:1},dividendYield:{type:'number',minimum:0,maximum:1},volatility:{type:'number',exclusiveMinimum:0,maximum:5},years:{type:'number',exclusiveMinimum:0,maximum:30}}),
  ]},period,title:text,language:reportLanguage,narrative:{type:'string',maxLength:6000},chartTitle:{type:'string',minLength:1,maxLength:300},metricsTitle:{type:'string',minLength:1,maxLength:300},metricLabels:{type:'object',maxProperties:16,additionalProperties:{type:'string',minLength:1,maxLength:120}},highlightMetricIds:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:80}}})},
  { action: 'receipt.read', purpose: 'Read a bounded field page from an immutable Finance observation in this authenticated chat. A prior snapshot is not current state or Goal verification. Continue with nextCursor index and offset; offsets count Unicode code points.', required: ['receiptId'], inputSchema: schema(['receiptId'], { receiptId: { type: 'string', format: 'uuid' }, group: { enum: [...FINANCE_RECEIPT_GROUPS] }, index: rev, offset: rev }) },
  { action: 'load', purpose: 'Read the authenticated Finance workspace, revision, dashboards, reports, sources and monitor state.', required: [], inputSchema: schema([], {}) },
  { action: 'search', purpose: 'Search actual provider asset metadata; returns coverage and connection warnings.', required: ['query'], inputSchema: schema(['query'], { query: text }) },
  { action: 'asset.add', purpose: 'Resolve one asset against the provider and persist it in the Finance watchlist.', required: ['query'], inputSchema: schema(['query'], { query: text, symbol: text }) },
  { action: 'query', purpose: 'Retrieve source data for saved assets, with observation times, provenance and coverage gaps.', required: ['query', 'assetIds', 'metrics', 'period'], inputSchema: schema(['query', 'assetIds', 'metrics', 'period'], queryProperties) },
  { action: 'query.save', purpose: 'Retrieve source data and save evidence or a frozen report in Finance.', required: ['query', 'assetIds', 'metrics', 'period', 'mode'], inputSchema: schema(['query', 'assetIds', 'metrics', 'period', 'mode'], { ...queryProperties, mode: { enum: ['sources', 'report'] }, title: text, expectedRevision: rev }) },
  { action: 'apply', purpose: 'Apply canonical dashboard/widget edits or draft report text at an expected Finance revision; provider data and reviewed status are host-owned.', required: ['operations', 'expectedRevision'], inputSchema: schema(['operations', 'expectedRevision'], { expectedRevision: rev, operations: { type: 'array', minItems: 1, maxItems: 40, items: editSchema } }) },
  { action: 'report.create', purpose: 'Freeze an existing Finance dashboard into a host-generated report snapshot.', required: [], inputSchema: schema([], { dashboardId: key, title: text, language:reportLanguage }) },
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
];
export const FINANCE_PORTS = descriptors.map(({ action, purpose, required, inputSchema }) => {
  composeDeclaredPrompt([{ id: `tool.finance.${action}.schema`, revision: ['calculate','apply','report.create'].includes(action)?2:1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(inputSchema) }]);
  return { operationId: `finance.${action}`, kind: writes.has(action) ? 'command' as const : 'query' as const, required, inputSchema,
    ...(action === 'monitor.pause' ? { terminalTargetKeys: ['monitorId'] as const } : {}),
    purpose: composeDeclaredPrompt([{ id: `tool.finance.${action}.description`, revision: 1, stability: 'fixed-policy', changeTriggers: ['release'], text: purpose }]),
    handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => callFinanceTool(action, args, ctx) };
});
for (const workflow of ['index', 'research', 'workspace', 'monitor']) registerDeclaredPromptModule({ id: `plugin.finance.skill.${workflow}`, revision: workflow === 'monitor' ? 3 : 2, stability: 'versioned-content', changeTriggers: ['release', 'skill-package'] });

/** Preserve the installed bytes and their hash while declaring the actual skill tool-result channel. */
export function composeFinanceSkillContent(skillId: string, content: string): string {
  const workflow = ['index', 'research', 'workspace', 'monitor'].find(name => skillId === `plugin:finance/${name}`);
  return workflow ? composeDeclaredPrompt([{ id: `plugin.finance.skill.${workflow}`, revision: workflow === 'monitor' ? 3 : 2, stability: 'versioned-content', changeTriggers: ['release', 'skill-package'], text: content }]) : content;
}
