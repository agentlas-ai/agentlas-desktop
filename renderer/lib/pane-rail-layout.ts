/*
 * Where a Work conversation's right rail sits, as one rule (Space pane or the whole Work page).
 *
 *   beside - the pane holds the chat and the rail side by side: the chat keeps at least PANE_MIN_CHAT_COLUMN.
 *   over   - it does not: the rail lies over the pane instead of squeezing the chat to a sliver. It lies over the transcript only. The composer (and what
 *            sits with it: a decision card, a queued-message line) is never covered - the person can always type and send - so the rail stops where the
 * composer starts (RAIL_COMPOSER_CLEARANCE_VAR, the composer's measured height, read by TaskSidePanel.module.css).
 *
 * Pure numbers only: the measuring (ResizeObserver) is the caller's, and nothing here polls or stores.
 */

/** In a Space pane the chat keeps at least this much beside the rail; narrower and the rail lies over the chat. */
export const PANE_MIN_CHAT_COLUMN = 380;
/** The breathing room the side-by-side layout leaves right of the rail (the rail's margin). */
export const RAIL_SIDE_MARGIN_PX = 20;
/** The custom property the shell carries while its rail is open: the px between the shell's bottom edge and the top of the composer area. */
export const RAIL_COMPOSER_CLEARANCE_VAR = "--rail-composer-clearance";

/** Does the rail (`railWidth` px) fit beside the chat in a pane `paneWidth` px wide? false = it lies over the transcript. */
export function railLaysOver(paneWidth: number, railWidth: number): boolean {
  if (!Number.isFinite(paneWidth) || !Number.isFinite(railWidth)) return false;
  return paneWidth - (railWidth + RAIL_SIDE_MARGIN_PX) < PANE_MIN_CHAT_COLUMN;
}

/** The clearance to leave under a rail that lies over the transcript: the composer area's height, a whole non-negative number of px (0 when it is unknown). */
export function railComposerClearance(composerHeight: number): number {
  return Number.isFinite(composerHeight) && composerHeight > 0 ? Math.ceil(composerHeight) : 0;
}
