/**
 * What a turn read before it draws a card, shared by every port that draws one (ui.canvas and its alias finance.present): the host
 * checks the card against the first guide the turn read, and a guide card whose chart the model left out is drawn from the series the
 * turn read. Keyed by chat and run; bounded.
 */
export type CanvasSeriesRead = { assetId?: string; metric: string; query?: string; period?: string };
export const canvasGuideReadInTurn = new Map<string, string>();
export const canvasSeriesReadInTurn = new Map<string, CanvasSeriesRead[]>();
/** Turns whose card was already refused once for its layout or guide: the next card in that turn is drawn as sent (never a dead end). */
export const canvasRefusedInTurn = new Set<string>();
export const canvasTurnKey = (ctx: { chatId?: string; runId?: string }) => `${ctx.chatId ?? ''}\0${ctx.runId ?? ''}`;
