import { z } from 'zod';
import { assetByType, canvasExportHtml, isBaseCanvasBlock, type CanvasAssetBlock, type CanvasBlock, type CanvasView } from '../../shared/canvas';
import '../../shared/canvas/blocks/registry'; // every asset block is known before a card is drawn
import type { HarnessCallContext } from '../harness/capability-ports';
import { writeCanvasExportFile } from './export-file';
import { renderHtmlToPngInChromiumHelper } from '../science-host/chromium-print-client';

/**
 * ui.canvas.image: a card the conversation showed, saved as a PNG picture the owner keeps (the whole card, or one block of it).
 * A deck is not made here: the model designs its own decks with document.deck.build (the office plugin), and a picture saved here is one it can place
 * on a slide with addImage({ path }). The card is read back from the host's own record (finance/canvas-retained-card.ts), never taken from the model, so the picture is
 * what the owner saw. It is drawn by the owned Chromium helper process (science-host/chromium-print-client.ts), written under the generated-assets root the
 * conversation's outputs already read (export-file.ts) and handed to the run as an output (`produced`); nothing is stored in a database. A failure never
 * leaves a half file and never ends the answer: every refusal says what to do next. No electron import (the daemon loads the harness).
 */
export const CanvasImageInputSchema = z.object({
  instanceId: z.preprocess(value => (value === '' || value === null ? undefined : value), z.string().trim().min(1).max(120).optional()),
  block: z.preprocess(value => (value === '' || value === null ? undefined : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value), z.number().int().min(0).max(11).optional()),
  width: z.preprocess(value => (value === '' || value === null ? undefined : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value), z.number().int().min(320).max(1600).optional()),
}).strip();

export const canvasImageInputJsonSchema = { type: 'object', additionalProperties: false, properties: {
  instanceId: { type: 'string', maxLength: 120, description: 'A card this conversation showed; omit for the newest.' },
  block: { type: 'integer', minimum: 0, maximum: 11, description: 'Just this block of the card (0 is the first); omit for the whole card.' },
  width: { type: 'integer', minimum: 320, maximum: 1600, description: 'The picture\'s width in CSS pixels (default fits the block).' },
} };

/** A card the conversation showed, read back from the host's own record (the reader is finance/canvas-retained-card.ts, handed in as `deps.readCard`). */
export type RetainedCard = { ok: true; instanceId: string; turnId: string; view: CanvasView } | { ok: false; reason: string; next: string };
type Outcome = { status: 'ok'; data: unknown; produced?: readonly string[] } | { status: 'refused' | 'unavailable'; reason: string; next?: string; data?: unknown };
type Block = CanvasBlock | CanvasAssetBlock;
type Png = { ok: boolean; bytes?: Buffer; width?: number; height?: number; reason?: string };

/** What the port reaches outside itself; tests stand in for these. */
export interface CanvasImageDeps {
  readCard(ctx: HarnessCallContext, instanceId?: string): Promise<RetainedCard>;
  renderPng(html: string, options: { width: number; scale: 1 | 2; signal?: AbortSignal; timeoutMs: number }): Promise<Png>;
  writeFile(chatId: string, stem: string, extension: 'png', bytes: Buffer): string;
}
/** The real deps, given the reader of the host's record of a shown card. */
export const canvasImageDeps = (readCard: CanvasImageDeps['readCard']): CanvasImageDeps => ({ readCard, renderPng: (html, o) => renderHtmlToPngInChromiumHelper(html, o), writeFile: writeCanvasExportFile });

/** The helper's wait for one picture: under the gateway's 30 s reply wait, so a stuck draw is reported as unavailable, not as a lost call. */
export const IMAGE_RENDER_TIMEOUT_MS = 25_000;

const refused = (reason: string, next: string, data?: unknown): Outcome => ({ status: 'refused', reason, next, ...(data !== undefined ? { data } : {}) });
/** One block on its own card, across the whole width (it was a half or a third of the grid's row on the card). */
const alone = (view: CanvasView, block: Block): CanvasView => ({ ...view, chips: [], sources: [], blocks: [{ ...block, width: 'full' } as Block] });
/** A block drawn on its own: a slide at its 16:9 width, a thumbnail narrow, everything else at the card's. */
const widthFor = (block: Block, asked?: number): number => asked ?? (isBaseCanvasBlock(block) ? 960 : assetByType(block.type)?.frame === '16:9' ? 1280 : assetByType(block.type)?.frame === 'thumb' ? 640 : 960);

export async function callCanvasImage(raw: Record<string, unknown>, ctx: HarnessCallContext, deps: CanvasImageDeps): Promise<Outcome> {
  const parsed = CanvasImageInputSchema.safeParse(raw);
  if (!parsed.success) return refused('canvas_image_arguments_invalid', 'instanceId, block and width are all optional: send none for the newest card as one picture.', { issues: parsed.error.issues.slice(0, 4).map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  const { instanceId, block: blockIndex, width: askedWidth } = parsed.data;
  if (ctx.dryRun) return refused('dry_run', 'Nothing was written.');
  if (ctx.permission !== 'write' && ctx.permission !== 'full') return refused('write_permission_required', 'Saving a picture needs write permission in this conversation; tell the owner the card is shown and offer to save it once writing is allowed.');
  try {
    const card = await deps.readCard(ctx, instanceId);
    if (!card.ok) return refused(card.reason, card.next);
    const { view } = card;
    if (blockIndex !== undefined && blockIndex >= view.blocks.length) return refused('card_block_unknown', `The card has ${view.blocks.length} block${view.blocks.length === 1 ? '' : 's'} (0 to ${view.blocks.length - 1}).`);
    const picked = blockIndex !== undefined ? view.blocks[blockIndex] : undefined;
    const target = picked ? alone(view, picked) : view;
    const width = picked ? widthFor(picked, askedWidth) : (askedWidth ?? 960);
    const png = await deps.renderPng(canvasExportHtml(target, { chrome: !picked || isBaseCanvasBlock(picked) }), { width, scale: 2, signal: ctx.signal, timeoutMs: IMAGE_RENDER_TIMEOUT_MS });
    ctx.signal?.throwIfAborted();
    if (!png.ok || !png.bytes) return { status: 'unavailable', reason: 'canvas_picture_unavailable', next: 'The picture could not be drawn on this machine (a very tall card may need a smaller width). The card is still shown; give the same findings in the answer text.', data: { cause: String(png.reason ?? 'unknown').slice(0, 120) } };
    const path = deps.writeFile(ctx.chatId, picked ? `${view.title}-${blockIndex! + 1}` : view.title, 'png', png.bytes);
    return { status: 'ok', produced: [path], data: { path, bytes: png.bytes.length, width: png.width, height: png.height, next: 'The picture is saved in this conversation\'s outputs; name it in the answer. In a deck you design with document.deck.build, place it with addImage({ path }).' } };
  } catch (error) {
    ctx.signal?.throwIfAborted();
    return refused('canvas_image_failed', 'The picture could not be saved (the disk may be full or the folder unavailable). The card is still shown; say so and give the findings as text.', { cause: String((error as Error)?.message ?? error).replace(/\/[^\s'"]+/g, '[path]').slice(0, 120) });
  }
}
