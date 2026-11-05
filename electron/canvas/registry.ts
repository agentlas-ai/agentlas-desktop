import type { HarnessCallContext } from '../harness/capability-ports';
import type { CanvasLine } from '../../shared/canvas';

/**
 * Where a domain tells the result-card canvas (ui.canvas) what it knows. The canvas draws and checks cards; a domain registers only
 *  - its guides: for a guide topic, the card layouts (`type:width` slots in order) its method describes, and
 *  - its data adapter: how one chart series (metric, asset id or query) becomes a dated line.
 * Nothing about drawing or checking lives in a domain (one tool, one port).
 */
export type CanvasSeriesRequest = { metric: string; assetId?: string; query?: string; /** The label the card shows; always set by the canvas. */ label: string };

export interface CanvasDomain {
  /** Stable id; also the prefix of the card's warnings (`<id>_card_fitted_to_guide`). */
  id: string;
  /** Every guide topic this domain registers. */
  topics: readonly string[];
  /** The layouts of the card a guide describes; undefined for a topic this domain does not own, [] for a guide that sets none. */
  guides(topic: string): readonly string[] | undefined;
  /** One chart series as a dated line; null when it cannot be read (the card then names it as unavailable). */
  readSeries(series: CanvasSeriesRequest, period: string, signal: AbortSignal | undefined, ctx: HarnessCallContext): Promise<CanvasLine | null>;
}

const domains = new Map<string, CanvasDomain>();
export function registerCanvasDomain(domain: CanvasDomain): void { domains.set(domain.id, domain); }
export function canvasDomains(): readonly CanvasDomain[] { return [...domains.values()]; }
export function canvasGuideTopics(): string[] { return canvasDomains().flatMap(domain => [...domain.topics]); }
/** The domain that owns a guide topic. */
export function canvasDomainForGuide(topic: string | undefined): CanvasDomain | undefined {
  return topic ? canvasDomains().find(domain => domain.topics.includes(topic)) : undefined;
}
