import { canvasFit, canvasLayout, type CanvasBlock, type CanvasChart, type CanvasInput, type CanvasLine, type CanvasView } from '../../shared/canvas';
import '../../shared/canvas/blocks/registry'; // the host knows every asset block before it builds a card (the renderer loads them on demand)
import type { HarnessCallContext } from '../harness/capability-ports';
import type { CanvasSeriesRead } from './turn-state';
import type { CanvasSeriesRequest } from './registry';

export interface CanvasBuildOptions {
  /** The guide that governs the card (the first one the turn read, else the one named); undefined when none. */
  guide: string | undefined;
  /** The guide the call named, and the first one the turn read: only for the refusal text when they differ. */
  named?: string;
  first?: string;
  /** The guide's layouts (undefined: no guide, or a guide that sets none). */
  layouts: readonly string[] | undefined;
  /** Set when a card should follow a guide: the warning text when there is none. The card is drawn as sent either way. */
  noGuideMessage?: string;
  /** True once this turn's card was refused for its layout or guide: this one is drawn as sent, the rule in the warnings. */
  refusedBefore?: boolean;
  /** Prefix of the card's warnings (the domain id of the guide, `canvas` without one). */
  warningPrefix: string;
  /** The series the turn read: a guide card with no chart is given one drawn from these. */
  reads?: readonly CanvasSeriesRead[];
  readSeries(series: CanvasSeriesRequest, period: string): Promise<CanvasLine | null>;
  signal?: AbortSignal;
}

/**
 * The one implementation of "check this card against a guide, read its chart series, build the view". finance.present and ui.canvas both
 * call it. The blocks follow one of the guide's layouts in order (one may be left out, none added) and take its widths; a card that is not
 * the guide's as sent is fitted to it when it can be (what is left out is named in the warnings); otherwise it is drawn as sent with the guide mismatch in the warnings.
 * A chart's series are never the model's: each one is read through the domain's adapter, or named as unavailable.
 */
export async function buildCanvasCard(input: Omit<CanvasInput, 'guide'>, o: CanvasBuildOptions): Promise<{ view: CanvasView; warnings: string[] }> {
  const args = { ...input }, { guide } = o;
  // No card is refused for want of a source: figures the owner gave have none, and a refusal only ever blocked the card. The sources a card is given are shown with it.
  // Never a dead end: a card the guide cannot govern is drawn as sent and the guide's rule rides in the warnings. A refusal here was
  // read as "answer without a card" (Codex run 9: 11 of 20 card-less answers were a refused card that was never sent again).
  const unguided: string[] = [];
  // A card with no guide to follow is drawn as sent and the warning says what to do next time: a refusal for want of a guide was
  // answered with no card at all too often, and a resend costs a card's worth of output.
  if (!guide && o.noGuideMessage) unguided.push(`${o.warningPrefix}_card_without_guide: ${o.noGuideMessage}`);
  let layout = canvasLayout(o.layouts, args.blocks.map(block => block.type));
  // Not the guide's card as sent (extra blocks, another order): the host draws the guide's card from what was sent rather than
  // refusing it, since a refused card was often not sent again (Codex, 18 answers ended without a card). What the
  // card leaves out is named in the warnings so the answer text can carry it.
  let fitted: string[] = [];
  let chartFromReads = false;
  if (layout === null) {
    let blocks = args.blocks, fit = canvasFit(o.layouts, blocks.map(block => block.type));
    // The guide's card has a chart and none was sent: draw the series this turn read (never the model's numbers).
    const reads = o.reads;
    if (!fit && reads?.length && !blocks.some(block => block.type === 'chart')) {
      const period = (['1M', '3M', '1Y', '5Y', 'all'] as const).find(p => p === reads[0].period) ?? '1Y';
      const chart = { type: 'chart' as const, series: reads.slice(0, 3).map(read => ({ metric: read.metric, ...(read.assetId ? { assetId: read.assetId } : {}), ...(read.query ? { query: read.query } : {}) })), period, annotations: [] as { date: string; label: string }[] };
      const withChart = [...blocks, chart as unknown as typeof blocks[number]];
      const fitted2 = canvasFit(o.layouts, withChart.map(block => block.type));
      if (fitted2) { blocks = withChart; fit = fitted2; chartFromReads = true; }
    }
    if (fit) { fitted = fit.dropped.map(i => blocks[i].type); args.blocks = fit.order.map(i => blocks[i]); layout = fit.slots; }
  }
  if (layout === null) {
    unguided.push(`${o.warningPrefix}_card_not_guide_layout: ${o.first && o.named && o.named !== o.first ? `this answer's guide is ${o.first}, the one this turn read first. ` : ''}The ${guide} card is ${o.layouts!.join(' or ')} (type:width, in this order); this one was drawn as sent (${args.blocks.map(block => block.type).join(' ')}). Next time send the guide's blocks.`);
    layout = undefined;
  }
  if (layout) args.blocks = args.blocks.map((block, i) => ({ ...block, width: layout![i].split(':')[1] as CanvasChart['width'] }));
  const warnings: string[] = [...unguided, ...(fitted.length ? [`${o.warningPrefix}_card_fitted_to_guide: ${guide} card; left out ${fitted.join(', ')}. Say what they showed in the answer text.`] : [])];
  if (chartFromReads) warnings.push(`${o.warningPrefix}_card_chart_from_reads: the guide card's chart shows the series this turn read.`);
  // A chart's series are never the model's: the host reads each one and draws those, or names what it could not read.
  const blocks: CanvasBlock[] = [];
  for (const block of args.blocks) {
    if (block.type !== 'chart') { blocks.push(block); continue; }
    const period = block.from && Date.now() - Date.parse(`${block.from}T00:00:00Z`) > 25 * 864e5 && block.period === '1M' ? '3M' : block.period;
    const lines: CanvasChart['lines'] = [], missing: string[] = [];
    for (const series of block.series) {
      const label = series.label ?? series.query ?? series.assetId ?? series.metric;
      try {
        const line = await o.readSeries({ metric: series.metric, ...(series.assetId ? { assetId: series.assetId } : {}), ...(series.query ? { query: series.query } : {}), label }, period);
        if (line) lines.push(block.from ? { ...line, points: line.points.filter((point, i, all) => point.date >= block.from! || all[i + 1]?.date >= block.from!) } : line); else missing.push(label);
      } catch { o.signal?.throwIfAborted(); missing.push(label); }
    }
    if (missing.length) warnings.push(`${o.warningPrefix}_chart_series_unavailable: ${missing.join(', ')}`);
    blocks.push({ type: 'chart', ...(block.title ? { title: block.title } : {}), ...(block.width ? { width: block.width as CanvasChart['width'] } : {}), mode: (block.mode as 'level' | 'change' | undefined) ?? (lines.length > 1 ? 'change' : 'level'), lines, annotations: block.annotations, missing });
  }
  return { view: { kind: 'canvas', ...args, ...(layout ? { guide } : {}), blocks } as CanvasView, warnings };
}
