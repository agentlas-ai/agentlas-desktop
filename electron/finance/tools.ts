import { z } from 'zod';
import { FINANCE_WIDGET_TYPES, financeId, validateFinanceOperation, type FinanceOperation } from '../../shared/finance';
import type { HarnessCallContext } from '../harness/capability-ports';
import { composeDeclaredPrompt, registerDeclaredPromptModule } from '../runtime/prompt-order';

type Outcome = { status: 'ok'; data: unknown } | { status: 'refused' | 'unavailable'; reason: string; next?: string; data?: unknown };
type ToolContext = Pick<HarnessCallContext, 'chatId' | 'runId' | 'permission' | 'dryRun' | 'hostAccountBinding'>;
const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const queryShape = { query: z.string().max(2000), assetIds: z.array(id).max(10), metrics: z.array(z.string().min(1).max(80)).min(1).max(10), period: z.string().min(1).max(80) };
const inputSchemas = {
  load: z.object({}).strict(),
  search: z.object({ query: z.string().min(1).max(200) }).strict(),
  'asset.add': z.object({ query: z.string().min(1).max(200), symbol: z.string().min(1).max(80).optional() }).strict(),
  query: z.object(queryShape).strict(),
  'query.save': z.object({ ...queryShape, mode: z.enum(['sources', 'report']), title: z.string().min(1).max(300).optional(), expectedRevision: revision.optional() }).strict(),
  apply: z.object({ operations: z.array(z.unknown()).min(1).max(40), expectedRevision: revision }).strict(),
  'report.create': z.object({ dashboardId: id.optional(), title: z.string().min(1).max(300).optional() }).strict(),
  'report.read': z.object({ reportId: id }).strict(),
  'monitor.create': z.object({ name: z.string().min(1).max(300), query: z.string().min(1).max(2000), assetIds: z.array(id).min(1).max(10), expectedRevision: revision }).strict(),
  'monitor.run': z.object({ monitorId: id }).strict(),
  'monitor.runs': z.object({ monitorId: id }).strict(),
  'monitor.schedule': z.object({ monitorId: id, scheduleHuman: z.enum(['daily-09:00', 'weekday-09:00', 'hourly', 'every-5m']) }).strict(),
  'monitor.pause': z.object({ monitorId: id }).strict(),
};
type Action = keyof typeof inputSchemas;
const writes = new Set<Action>(['asset.add', 'query.save', 'apply', 'report.create', 'monitor.create', 'monitor.run', 'monitor.schedule', 'monitor.pause']);
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
    let data: unknown;
    switch (action) {
      case 'load': inputSchemas.load.parse(raw); data = await finance.load(scope); break;
      case 'search': data = await finance.search(scope, inputSchemas.search.parse(raw)); break;
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
        const workspace = await finance.load(scope);
        const report = workspace.reports.find(item => item.id === args.reportId);
        if (!report) throw new Error('finance_report_not_found');
        data = { report, workspaceRevision: workspace.revision }; break;
      }
      case 'monitor.create': {
        const args = inputSchemas['monitor.create'].parse(raw);
        data = await finance.apply(scope, { expectedRevision: args.expectedRevision, operations: [{ type: 'monitor.upsert', monitor: { id: financeId('monitor'), name: args.name, query: args.query, assetIds: args.assetIds, status: 'draft', lastCheckedAt: null, nextCheckAt: null, note: '' } }] }); break;
      }
      case 'monitor.run': {
        const run = await finance.runMonitor(scope, { ...inputSchemas['monitor.run'].parse(raw), callerRunId: ctx.runId, callerChatId: ctx.chatId });
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
    return { status: 'ok', data };
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
  opSchema('report.update',['reportId','patch'],{reportId:key,patch:schema([],{title:text,reviewPending:{const:true}})}),
  ...['report.remove','report.refresh'].map(type=>opSchema(type,['reportId'],{reportId:key})),
  opSchema('report.section.update',['reportId','sectionId','patch'],{reportId:key,sectionId:key,patch:schema([],{title:text,narrative:text})}),
  opSchema('report.section.remove',['reportId','sectionId'],{reportId:key,sectionId:key}),
  opSchema('report.section.move',['reportId','sectionId','index'],{reportId:key,sectionId:key,index:rev}),
] };
const descriptors: { action: Action; purpose: string; required: string[]; inputSchema: Record<string, unknown> }[] = [
  { action: 'load', purpose: 'Read the authenticated Finance workspace, revision, dashboards, reports, sources and monitor state.', required: [], inputSchema: schema([], {}) },
  { action: 'search', purpose: 'Search actual provider asset metadata; returns coverage and connection warnings.', required: ['query'], inputSchema: schema(['query'], { query: text }) },
  { action: 'asset.add', purpose: 'Resolve one asset against the provider and persist it in the Finance watchlist.', required: ['query'], inputSchema: schema(['query'], { query: text, symbol: text }) },
  { action: 'query', purpose: 'Retrieve source data for saved assets, with observation times, provenance and coverage gaps.', required: ['query', 'assetIds', 'metrics', 'period'], inputSchema: schema(['query', 'assetIds', 'metrics', 'period'], queryProperties) },
  { action: 'query.save', purpose: 'Retrieve source data and save evidence or a frozen report in Finance.', required: ['query', 'assetIds', 'metrics', 'period', 'mode'], inputSchema: schema(['query', 'assetIds', 'metrics', 'period', 'mode'], { ...queryProperties, mode: { enum: ['sources', 'report'] }, title: text, expectedRevision: rev }) },
  { action: 'apply', purpose: 'Apply canonical dashboard/widget edits or draft report text at an expected Finance revision; provider data and reviewed status are host-owned.', required: ['operations', 'expectedRevision'], inputSchema: schema(['operations', 'expectedRevision'], { expectedRevision: rev, operations: { type: 'array', minItems: 1, maxItems: 40, items: editSchema } }) },
  { action: 'report.create', purpose: 'Freeze an existing Finance dashboard into a host-generated report snapshot.', required: [], inputSchema: schema([], { dashboardId: key, title: text }) },
  { action: 'report.read', purpose: 'Read a saved Finance report and its evidence without refreshing its snapshot.', required: ['reportId'], inputSchema: schema(['reportId'], { reportId: key }) },
  { action: 'monitor.create', purpose: 'Create a draft research monitor for saved assets; creation does not enable a schedule.', required: ['name', 'query', 'assetIds', 'expectedRevision'], inputSchema: schema(['name', 'query', 'assetIds', 'expectedRevision'], { name: text, query: text, assetIds: list, expectedRevision: rev }) },
  { action: 'monitor.run', purpose: 'Run an existing Finance monitor and persist its actual result, evidence and briefing report.', required: ['monitorId'], inputSchema: schema(['monitorId'], { monitorId: key }) },
  { action: 'monitor.runs', purpose: 'Read actual Finance monitor runs and their report references.', required: ['monitorId'], inputSchema: schema(['monitorId'], { monitorId: key }) },
  { action: 'monitor.schedule', purpose: 'Enable an existing Finance monitor through the host scheduler.', required: ['monitorId', 'scheduleHuman'], inputSchema: schema(['monitorId', 'scheduleHuman'], { monitorId: key, scheduleHuman: { enum: ['daily-09:00', 'weekday-09:00', 'hourly', 'every-5m'] } }) },
  { action: 'monitor.pause', purpose: 'Pause future executions of the bound Finance monitor without requiring a view revision.', required: ['monitorId'], inputSchema: schema(['monitorId'], { monitorId: key }) },
];
export const FINANCE_PORTS = descriptors.map(({ action, purpose, required, inputSchema }) => {
  composeDeclaredPrompt([{ id: `tool.finance.${action}.schema`, revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(inputSchema) }]);
  return { operationId: `finance.${action}`, kind: writes.has(action) ? 'command' as const : 'query' as const, required, inputSchema,
    ...(action === 'monitor.pause' ? { terminalTargetKeys: ['monitorId'] as const } : {}),
    purpose: composeDeclaredPrompt([{ id: `tool.finance.${action}.description`, revision: 1, stability: 'fixed-policy', changeTriggers: ['release'], text: purpose }]),
    handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => callFinanceTool(action, args, ctx) };
});
for (const workflow of ['index', 'research', 'workspace', 'monitor']) registerDeclaredPromptModule({ id: `plugin.finance.skill.${workflow}`, revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'skill-package'] });

/** Preserve the installed bytes and their hash while declaring the actual skill tool-result channel. */
export function composeFinanceSkillContent(skillId: string, content: string): string {
  const workflow = ['index', 'research', 'workspace', 'monitor'].find(name => skillId === `plugin:finance/${name}`);
  return workflow ? composeDeclaredPrompt([{ id: `plugin.finance.skill.${workflow}`, revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'skill-package'], text: content }]) : content;
}
