import { z } from 'zod';
import { CanvasInputSchema, type CanvasLine } from '../../shared/canvas';
import type { HarnessCallContext } from '../harness/capability-ports';
import type { FinanceNativePresentation } from '../../shared/finance-native-ui';
import { composeDeclaredPrompt } from '../runtime/prompt-order';
import { canvasInputJsonSchema } from './canvas-input-schema';
import { buildCanvasCard } from '../canvas/present';
import { presentCanvasCard } from './canvas-present';
import { canvasDomainForGuide, canvasDomains, canvasGuideTopics, type CanvasSeriesRequest } from '../canvas/registry';
import { canvasGuideReadInTurn, canvasSeriesReadInTurn, canvasTurnKey } from '../canvas/turn-state';

/**
 * ui.canvas: the one port that draws a result card (kpis, bars, ranges, chart, leans, table, heatmap, allocation, timeline, checklist, gauge,
 * note). It belongs to the agentlas-ui family (`ui.present` was taken by the result-view projection, so the card is `ui.canvas`). A domain
 * registers only its guides and its chart-series reader (registry.ts); finance.present is the Finance alias of the same implementation.
 * Scoped to the domains registered so far (Finance): a guide must name a registered topic, and nothing outside Finance reads series yet.
 */
const inputSchema = canvasInputJsonSchema({ type: 'string', maxLength: 40, description: 'A guide topic a domain registered; the host checks the blocks against its card layouts and sets their widths.' });
composeDeclaredPrompt([{ id: 'tool.ui.canvas.schema', revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(inputSchema) }]);
const purpose = composeDeclaredPrompt([{ id: 'tool.ui.canvas.description', revision: 1, stability: 'fixed-policy', changeTriggers: ['release'], text: 'Show the owner a result card under your answer text, composed from blocks: kpis, bars, ranges, chart (name its series; the host reads the numbers), leans, table, heatmap, allocation, timeline, checklist, gauge, note. Use only what you read this turn and give its sources. Pass guide when a domain guide set the card. Amounts are in full units.' }]);

const CanvasPortInputSchema = CanvasInputSchema.extend({ guide: z.preprocess(value => (typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : value), z.string().max(40).optional()) });

/** The shape of a port outcome (capability-ports.ts PortOutcome, which it does not export). */
type CanvasOutcome = { status: 'ok'; data: unknown; nativeUi?: FinanceNativePresentation } | { status: 'refused' | 'unavailable'; reason: string; next?: string; data?: unknown };

/** The card, built and shown. The Finance alias calls buildCanvasCard / presentCanvasCard with its own checks; this is the generic entry. */
export async function callCanvasPort(raw: Record<string, unknown>, ctx: HarnessCallContext): Promise<CanvasOutcome> {
  try {
    const { guide: named, ...args } = CanvasPortInputSchema.parse(raw);
    if (named && !canvasGuideTopics().includes(named)) throw new z.ZodError([{ code: 'custom', path: ['guide'], message: `guide ${named} is not registered. Registered topics: ${canvasGuideTopics().join(', ') || 'none'}.` }]);
    const key = canvasTurnKey(ctx), first = canvasGuideReadInTurn.get(key), guide = first ?? named, domain = canvasDomainForGuide(guide);
    // The guide's own domain reads the series first; another registered domain answers only for a series it can read.
    const readers = [domain, ...canvasDomains().filter(other => other !== domain)].filter((reader): reader is NonNullable<typeof reader> => !!reader);
    const readSeries = async (series: CanvasSeriesRequest, period: string): Promise<CanvasLine | null> => {
      for (const reader of readers) { const line = await reader.readSeries(series, period, ctx.signal, ctx); if (line) return line; }
      return null;
    };
    const card = await buildCanvasCard(args, { guide, named, first, layouts: guide ? domain?.guides(guide) : undefined, warningPrefix: domain?.id ?? 'canvas', reads: canvasSeriesReadInTurn.get(key), readSeries, signal: ctx.signal });
    const nativeUi = await presentCanvasCard(card, raw, ctx);
    if (nativeUi?.status !== 'presented') return { status: 'unavailable', reason: 'canvas_ui_not_presented', next: 'The card could not be shown. Give the same findings in the answer text.' };
    return { status: 'ok', nativeUi, data: { shown: true, warnings: card.warnings, next: 'The card is shown under your answer. The answer text is the conclusion in one or two sentences; the card carries the figures and sources.' } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const layout = error.issues.find(issue => issue.path.join('.') === 'blocks' || issue.path.join('.') === 'guide')?.message;
      return { status: 'refused', reason: 'canvas_arguments_invalid', next: layout ? `${layout} Call ui.canvas again now with those blocks; a chart needs only its series named: the host reads the numbers.` : 'Read the operation schema and supply its exact fields.', data: { issues: error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } };
    }
    ctx.signal?.throwIfAborted();
    return { status: 'refused', reason: 'canvas_operation_failed', next: 'The card could not be built. Give the same findings in the answer text.' };
  }
}

export const CANVAS_PORTS = [
  { operationId: 'ui.canvas', kind: 'query' as const, required: ['title', 'blocks', 'sources'], inputSchema, purpose, handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => callCanvasPort(args, ctx) },
];
