/**
 * Layout fit for the result-card canvas. A domain's guide describes its card as layouts: space-separated `type:width` slots in order
 * (e.g. "kpis:full chart:half bars:half"). These two functions check or fit a block list against such a list; they know nothing of any domain.
 */

/** The layout that these block types follow in order (at most one block left out, none added or reordered), as type:width; null when none does, undefined when no layouts are set. */
export function canvasLayout(layouts: readonly string[] | undefined, types: readonly string[]): string[] | null | undefined {
  if (!layouts?.length) return undefined;
  for (const layout of layouts) {
    const slots = layout.split(' ');
    let at = 0;
    const picked = types.map(type => { while (at < slots.length && !slots[at].startsWith(`${type}:`)) at++; return at < slots.length ? slots[at++] : null; });
    // At most one block may be left out (its data could not be read); a card missing more is not this guide's card.
    // A chart is never the one left out: its series are read by the host, so there is always something to draw.
    if (picked.every(Boolean) && picked.length >= slots.length - 1 && slots.every(slot => !slot.startsWith('chart:') || picked.includes(slot))) return picked as string[];
  }
  return null;
}

/** When the blocks are not one of the layouts as sent (extra blocks, another order), the card the layout describes that can be
 *  made from them: each layout slot takes the first unused block of its type; at most one slot may stay empty and never a chart.
 *  Returns the block indexes in layout order, their slots, and the blocks left out; null when no layout can be filled. */
export function canvasFit(layouts: readonly string[] | undefined, types: readonly string[]): { order: number[]; slots: string[]; dropped: number[] } | null | undefined {
  if (!layouts?.length) return undefined;
  let best: { order: number[]; slots: string[]; dropped: number[] } | null = null;
  for (const layout of layouts) {
    const slots = layout.split(' '), used = new Set<number>(), order: number[] = [], filled: string[] = [];
    for (const slot of slots) {
      const at = types.findIndex((type, i) => !used.has(i) && slot.startsWith(`${type}:`));
      if (at >= 0) { used.add(at); order.push(at); filled.push(slot); }
    }
    const chartsFilled = slots.every(slot => !slot.startsWith('chart:') || filled.includes(slot));
    if (filled.length >= slots.length - 1 && chartsFilled && (!best || filled.length > best.slots.length)) {
      best = { order, slots: filled, dropped: types.map((_, i) => i).filter(i => !used.has(i)) };
    }
  }
  return best;
}
