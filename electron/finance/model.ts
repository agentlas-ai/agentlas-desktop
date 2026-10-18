import { z } from 'zod';
import { applyFinanceOperations, createFinanceDashboard, createFinanceReport, createFinanceWidget, FINANCE_WIDGET_TYPES, validateFinanceOperation, type FinanceAIResult, type FinanceOperation, type FinanceWorkspace } from '../../shared/finance';
import { redactSecrets } from '../../shared/secret-patterns';
import { callConnectedModelDetailed } from '../system-agents/judgment';
import { financeEditPrompts } from './prompts';
import { registerDeclaredPromptModule } from '../runtime/prompt-order';

const kinds = ['create_dashboard', 'rename_dashboard', 'set_period', 'select_dashboard', 'add_widget', 'update_widget', 'remove_widget', 'move_widget', 'create_report', 'rename_report', 'edit_section', 'move_section'] as const;
const actionSchema = z.object({
  kind: z.enum(kinds), dashboardId: z.string().max(200).nullable(), widgetId: z.string().max(200).nullable(), reportId: z.string().max(200).nullable(), sectionId: z.string().max(200).nullable(),
  title: z.string().max(300).nullable(), widgetType: z.enum(FINANCE_WIDGET_TYPES).nullable(), chartType: z.enum(['line', 'bar', 'table']).nullable(), width: z.enum(['half', 'full']).nullable(),
  period: z.enum(['1M', '3M', '1Y', '5Y', 'all']).nullable(), assetIds: z.array(z.string().max(200)).max(100).nullable(), notes: z.string().max(20000).nullable(), index: z.number().int().min(0).max(100).nullable(), hidden: z.boolean().nullable(),
}).strict();
const resultSchema = z.object({ message: z.string().max(4000), actions: z.array(actionSchema).max(20) }).strict();
const nullableString = { type: ['string', 'null'] };
const nullableEnum = (values: readonly string[]) => ({ type: ['string', 'null'], enum: [...values, null] });
const properties = {
  kind: { type: 'string', enum: kinds }, dashboardId: nullableString, widgetId: nullableString, reportId: nullableString, sectionId: nullableString, title: nullableString,
  widgetType: nullableEnum(FINANCE_WIDGET_TYPES), chartType: nullableEnum(['line', 'bar', 'table']), width: nullableEnum(['half', 'full']), period: nullableEnum(['1M', '3M', '1Y', '5Y', 'all']),
  assetIds: { type: ['array', 'null'], items: { type: 'string' } }, notes: nullableString, index: { type: ['integer', 'null'] }, hidden: { type: ['boolean', 'null'] },
};
export const FINANCE_ACTION_OUTPUT_SCHEMA = { name: 'finance_screen_actions', schema: {
  type: 'object', additionalProperties: false, required: ['message', 'actions'], properties: { message: { type: 'string' }, actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } } },
} };
registerDeclaredPromptModule({ id: 'finance.edit.output-schema', revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'] });
function required(value: string | null): string { if (!value) throw new Error('finance_ai_missing_target'); return value; }
/** Model actions never carry market prices, holdings, evidence status, report snapshots, or IDs for new records. */
export function parseFinanceProposal(text: string, workspace: FinanceWorkspace): Pick<FinanceAIResult, 'message' | 'operations'> {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (clean.length > 100000) throw new Error('finance_ai_output_too_large');
  const parsed = resultSchema.parse(JSON.parse(clean));
  let current = workspace;
  const operations: FinanceOperation[] = [];
  for (const action of parsed.actions) {
    const dashboardId = action.dashboardId ?? current.activeDashboardId;
    let op: FinanceOperation;
    switch (action.kind) {
      case 'create_dashboard': op = { type: 'dashboard.add', dashboard: createFinanceDashboard(required(action.title)) }; break;
      case 'rename_dashboard': op = { type: 'dashboard.rename', dashboardId: required(dashboardId), name: required(action.title) }; break;
      case 'set_period': if (!action.period) throw new Error('finance_ai_missing_period'); op = { type: 'dashboard.update', dashboardId: required(dashboardId), patch: { period: action.period } }; break;
      case 'select_dashboard': op = { type: 'dashboard.select', dashboardId: required(dashboardId) }; break;
      case 'add_widget': {
        if (!action.widgetType) throw new Error('finance_ai_missing_widget_type');
        const widget = createFinanceWidget(action.widgetType, action.title ?? undefined);
        if (action.assetIds) widget.assetIds = action.assetIds;
        if (action.chartType) widget.chartType = action.chartType;
        if (action.width) widget.width = action.width;
        if (action.period) { widget.period = action.period; widget.periodMode = 'pinned'; }
        if (action.notes) widget.notes = action.notes;
        op = { type: 'widget.add', dashboardId: required(dashboardId), widget }; break;
      }
      case 'update_widget': {
        const patch: Extract<FinanceOperation, { type: 'widget.update' }>['patch'] = {};
        if (action.title !== null) patch.title = action.title;
        if (action.assetIds !== null) patch.assetIds = action.assetIds;
        if (action.chartType !== null) patch.chartType = action.chartType;
        if (action.width !== null) patch.width = action.width;
        if (action.period !== null) { patch.period = action.period; patch.periodMode = 'pinned'; }
        if (action.notes !== null) patch.notes = action.notes;
        if (action.hidden !== null) patch.hidden = action.hidden;
        op = { type: 'widget.update', dashboardId: required(dashboardId), widgetId: required(action.widgetId), patch }; break;
      }
      case 'remove_widget': op = { type: 'widget.remove', dashboardId: required(dashboardId), widgetId: required(action.widgetId) }; break;
      case 'move_widget': if (action.index === null) throw new Error('finance_ai_missing_index'); op = { type: 'widget.move', dashboardId: required(dashboardId), widgetId: required(action.widgetId), index: action.index }; break;
      case 'create_report': {
        const dashboard = current.dashboards.find(x => x.id === dashboardId);
        if (!dashboard) throw new Error('finance_dashboard_not_found');
        op = { type: 'report.add', report: createFinanceReport({ ...current, revision: workspace.revision }, dashboard, action.title ?? dashboard.name) }; break;
      }
      case 'rename_report': op = { type: 'report.update', reportId: required(action.reportId), patch: { title: required(action.title), reviewPending: true } }; break;
      case 'edit_section': op = { type: 'report.section.update', reportId: required(action.reportId), sectionId: required(action.sectionId), patch: { ...(action.title === null ? {} : { title: action.title }), ...(action.notes === null ? {} : { narrative: action.notes }) } }; break;
      case 'move_section': if (action.index === null) throw new Error('finance_ai_missing_index'); op = { type: 'report.section.move', reportId: required(action.reportId), sectionId: required(action.sectionId), index: action.index }; break;
    }
    operations.push(validateFinanceOperation(op));
    current = applyFinanceOperations(current, [op]);
    if (action.kind === 'edit_section') {
      const mark: FinanceOperation = { type: 'report.update', reportId: required(action.reportId), patch: { reviewPending: true } };
      operations.push(mark); current = applyFinanceOperations(current, [mark]);
    }
  }
  if (operations.length) applyFinanceOperations(workspace, operations);
  return { message: parsed.message, operations };
}
export async function interpretFinance(input: { request: string; screenContext: string; baseRevision: number; requestId?: string }, workspace: FinanceWorkspace, signal: AbortSignal, invoke = callConnectedModelDetailed): Promise<FinanceAIResult> {
  const base = { baseRevision: input.baseRevision, requestId: input.requestId };
  if (input.baseRevision !== workspace.revision) return { ...base, status: 'conflict', message: 'The Finance workspace changed. Reload it before applying this request.' };
  const selection = z.object({ dashboardId: z.string().max(200).nullable().optional(), selectedWidgetId: z.string().max(200).nullable().optional(), reportId: z.string().max(200).nullable().optional(), selectedSectionId: z.string().max(200).nullable().optional(), history:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().max(180)}).strict()).max(6).optional() }).strict().parse(JSON.parse(input.screenContext || '{}'));
  const selectedDashboard = workspace.dashboards.find(item => item.id === (selection.dashboardId ?? workspace.activeDashboardId));
  const selectedReport = workspace.reports.find(item => item.id === selection.reportId);
  if (selection.dashboardId && !selectedDashboard || selection.selectedWidgetId && !selectedDashboard?.widgets.some(item => item.id === selection.selectedWidgetId) || selection.reportId && !selectedReport || selection.selectedSectionId && !selectedReport?.sections.some(item => item.id === selection.selectedSectionId)) throw new Error('finance_selection_stale');
  const prompts = financeEditPrompts(workspace, selection, redactSecrets(input.request));
  if (prompts.input.length > 240000) return { ...base, status: 'unavailable', message: 'This workspace is too large for one edit request. Use direct controls.' };
  let proposal: ReturnType<typeof parseFinanceProposal> | undefined;
  const result = await invoke({ ...prompts, input: redactSecrets(prompts.input), signal, timeoutMs: 60000, requireNoTools: true, outputSchema: FINANCE_ACTION_OUTPUT_SCHEMA,
    accept: text => { try { proposal = parseFinanceProposal(text, workspace); return true; } catch { return false; } },
  });
  if (signal.aborted) return { ...base, status: 'cancelled', message: 'Request cancelled.' };
  if (!result.text) return { ...base, status: 'unavailable', message: 'No configured model returned a valid Finance edit. Check model settings or use direct controls.' };
  try { proposal = parseFinanceProposal(result.text, workspace); } catch { return { ...base, status: 'invalid_output', message: 'The model returned an unsupported edit. Nothing was changed.' }; }
  const receipt = result.runtimeReceipt;
  return { ...base, ...proposal, status: 'ok', ...(receipt ? { runtime: { kind: receipt.selection.kind, model: receipt.selection.model, execution: receipt.execution } } : {}) };
}
