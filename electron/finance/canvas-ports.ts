import { z } from 'zod';
import { CanvasInputSchema, type CanvasLine } from '../../shared/canvas';
import type { HarnessCallContext } from '../harness/capability-ports';
import type { FinanceNativePresentation } from '../../shared/finance-native-ui';
import { composeDeclaredPrompt } from '../runtime/prompt-order';
import { canvasInputJsonSchema } from './canvas-input-schema';
import { buildCanvasCard } from '../canvas/present';
import { presentCanvasCard } from './canvas-present';
import { canvasDomainForGuide, canvasDomains, canvasGuideTopics, type CanvasSeriesRequest } from '../canvas/registry';
import { canvasGuideReadInTurn, canvasRefusedInTurn, canvasSeriesReadInTurn, canvasTurnKey } from '../canvas/turn-state';
import { assetCatalogInputJsonSchema, readAssetCatalog } from '../canvas/catalog';
import { cardPlace } from '../canvas/place';
import { callCanvasImage, canvasImageDeps, canvasImageInputJsonSchema } from '../canvas/export';
import { readRetainedCard } from './canvas-retained-card';

/**
 * ui.canvas: the one port that draws a result card: the 12 figure blocks (kpis, bars, ranges, chart, leans, table, heatmap, allocation, timeline,
 * checklist, gauge, note) and the asset blocks (shared/canvas/blocks: documents, file thumbnails, charts, tables, diagrams, motion stills, slides,
 * read from ui.asset.catalog). It belongs to the agentlas-ui family (`ui.present` was taken by the result-view projection, so the card is `ui.canvas`). A domain
 * registers only its guides and its chart-series reader (registry.ts); finance.present is the Finance alias of the same implementation.
 * Scoped to the domains registered so far (Finance): a guide must name a registered topic, and nothing outside Finance reads series yet.
 */
const inputSchema = canvasInputJsonSchema({ type: 'string', maxLength: 40, description: 'A guide topic a domain registered; the host checks the blocks against its card layouts and sets their widths.' }, { assets: true });
composeDeclaredPrompt([{ id: 'tool.ui.canvas.schema', revision: 2, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(inputSchema) }]);
const purpose = composeDeclaredPrompt([{ id: 'tool.ui.canvas.description', revision: 4, stability: 'fixed-policy', changeTriggers: ['release'], text: 'Use when the answer is something to look at: show the owner a card under your answer text, composed from blocks; plain prose or a short list needs no card. Asset blocks need no sources: flowcharts and diagrams, charts and tables from numbers you hold, document pages, file thumbnails, slides, motion-graphic stills; ui.asset.catalog lists the types with a sample. Figure blocks: kpis, bars, ranges, chart (name its series; the host reads the numbers), leans, table, heatmap, allocation, timeline, checklist, gauge, note; use only what you read this turn or were given, naming sources when there are any. Pass guide when a domain guide set the card. Amounts are in full units.' }]);
composeDeclaredPrompt([{ id: 'tool.ui.asset.catalog.schema', revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(assetCatalogInputJsonSchema) }]);
composeDeclaredPrompt([{ id: 'tool.ui.canvas.image.schema', revision: 1, stability: 'versioned-content', changeTriggers: ['release', 'output-schema'], text: JSON.stringify(canvasImageInputJsonSchema) }]);
const imagePurpose = composeDeclaredPrompt([{ id: 'tool.ui.canvas.image.description', revision: 1, stability: 'fixed-policy', changeTriggers: ['release'], text: 'Save a card this conversation showed as a PNG picture the owner keeps: the whole card or one block of it (the newest card unless instanceId names another). It writes only into this conversation\'s outputs. For a deck, design it yourself with document.deck.build.' }]);
const catalogPurpose = composeDeclaredPrompt([{ id: 'tool.ui.asset.catalog.description', revision: 1, stability: 'fixed-policy', changeTriggers: ['release'], text: 'List the asset blocks a ui.canvas card can hold (documents, file thumbnails, charts, tables, diagrams, motion-graphic stills, slides) and read one: no argument lists the names by category, category gives one-line uses, type gives its fields and a sample, query finds types by words.' }]);

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
    const card = await buildCanvasCard(args, { guide, named, first, layouts: guide ? domain?.guides(guide) : undefined, warningPrefix: domain?.id ?? 'canvas', reads: canvasSeriesReadInTurn.get(key), refusedBefore: canvasRefusedInTurn.has(key), readSeries, signal: ctx.signal });
    const nativeUi = await presentCanvasCard(card, raw, ctx);
    if (nativeUi?.status !== 'presented') return { status: 'unavailable', reason: 'canvas_ui_not_presented', next: 'The card could not be shown. Give the same findings in the answer text.' };
    const where = await cardPlace(ctx.chatId) === 'panel' ? 'in the results panel beside this conversation' : 'under your answer';
    return { status: 'ok', nativeUi, data: { shown: true, warnings: card.warnings, next: `The card is shown ${where}. The answer text is the conclusion in one or two sentences; the card carries the figures and sources.` } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      if (ctx.runId) { canvasRefusedInTurn.add(canvasTurnKey(ctx)); if (canvasRefusedInTurn.size > 200) canvasRefusedInTurn.delete(canvasRefusedInTurn.values().next().value!); }
      const layout = error.issues.find(issue => issue.path.join('.') === 'blocks' || issue.path.join('.') === 'guide')?.message;
      return { status: 'refused', reason: 'canvas_arguments_invalid', next: layout ? `${layout} Call ui.canvas again now with those blocks; a chart needs only its series named: the host reads the numbers.` : 'Read the operation schema and supply its exact fields.', data: { issues: error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } };
    }
    ctx.signal?.throwIfAborted();
    return { status: 'refused', reason: 'canvas_operation_failed', next: 'The card could not be built. Give the same findings in the answer text.' };
  }
}

export const CANVAS_PORTS = [
  { operationId: 'ui.canvas', kind: 'query' as const, required: ['title', 'blocks'], inputSchema, purpose, handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => callCanvasPort(args, ctx) },
  { operationId: 'ui.canvas.image', kind: 'command' as const, required: [] as string[], inputSchema: canvasImageInputJsonSchema, purpose: imagePurpose, handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => callCanvasImage(args, ctx, canvasImageDeps(readRetainedCard)) },
  { operationId: 'ui.asset.catalog', kind: 'query' as const, required: [] as string[], inputSchema: assetCatalogInputJsonSchema, purpose: catalogPurpose, handler: async (args: Record<string, unknown>) => readAssetCatalog(args) },
];
