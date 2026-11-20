/**
 * Space's layout model (Agentlas 2.0 decision; F-D4: no tabs, 2x2): up to four panes, one conversation each,
 * plus the left list's pins and order. Pure functions over plain data - no React, no storage - so every rule here can be run
 * and checked without a window.
 *
 * It is SCREEN state, not conversation state: it lives in the one `homeLayout` UI preference (a localStorage key), never
 * in the database. Nothing here reads or writes a conversation; a pane only remembers which chat it shows. A chat that is not
 * in a pane is not lost: it is in the left list.
 *
 * Shape (F-D4 keeps the stored shape of the tab era, `v: 1`, so an app from before it reads a new value without breaking: it
 * sees four panes of one tab each): `space.panes[]` in reading order - 1 = one pane, 2 = side by side, 3 = two on top and one
 * across the bottom, 4 = 2x2. Each pane holds exactly one tab and `active` is that tab. The column line is the ratio of
 * `panes[0].weight : panes[1].weight`; the bottom panes repeat it so the line is one line through both rows. The rows are
 * always equal (a row ratio would add a field to `HomeLayout`, and that type feeds the generated app-control schema).
 *
 * Limits (each one cuts what a stored value or a bug could grow to; opening past one is refused out loud - no pane is ever
 * closed for the person):  panes <= 4, one chat per pane, pins <= 100, ordered ids <= 2000 over <= 200 groups.
 *
 * Reading is forgiving: a damaged, unknown-version or oversized value never throws - what is valid is kept, the rest
 * is cut, and no value at all gives the plain start (no panes, nothing pinned). An OLD value (several tabs in a pane, four
 * panes in a row) is converted by the same function: each pane keeps its active tab, the other tabs only leave the layout
 * (their conversations are untouched and stay in the list), and the panes read in order as 2x2.
 */

export const SPACE_MAX_PANES = 4;
export const SPACE_MAX_TABS_PER_PANE = 1;
export const SPACE_MAX_TABS_TOTAL = SPACE_MAX_PANES;
export const SPACE_WEIGHT_TOTAL = 1000;
/** The column line never goes closer than this share (of 1000, of the row) to either side by a drag or a keyboard step. */
export const SPACE_MIN_WEIGHT = 150;
/** The least width one pane is drawn at: two columns need `2 x this`; a narrower Space is one column. */
export const SPACE_MIN_PANE_PX = 300;
/** The least height one pane is drawn at: two rows need `2 x this`; a shorter Space holds two panes side by side, never more at once. */
export const SPACE_MIN_PANE_HEIGHT_PX = 260;
export const HOME_PINNED_MAX = 100;
export const HOME_ORDER_IDS_MAX = 2000;
export const HOME_ORDER_GROUPS_MAX = 200;

export type SpaceTabKind = "room" | "work";
export interface SpaceTab { chatId: string; kind: SpaceTabKind }
export interface SpacePane { id: string; weight: number; active: string | null; tabs: SpaceTab[] }
export interface SpaceState { focus: string | null; panes: SpacePane[] }
export interface HomeLayout {
  v: 1;
  space: SpaceState;
  /** Chat ids, in the order they were pinned (first = top). */
  pinned: string[];
  /** Per list group (`groupKeyOf`), the ids the person moved to the front, first = top. */
  order: Record<string, string[]>;
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value) && !BAD_KEYS.has(value);

export function emptyHomeLayout(): HomeLayout {
  return { v: 1, space: { focus: null, panes: [] }, pinned: [], order: {} };
}

/** The group a list row belongs to for ordering: `<projectId|none>:<chats|work>`. */
export function groupKeyOf(projectId: string | null | undefined, kind: "solo" | "group" | "work"): string {
  return `${projectId || "none"}:${kind === "work" ? "work" : "chats"}`;
}

// ---------------------------------------------------------------- weights: one column line

/** The share (0..1) of the left column, from `panes[0]` and `panes[1]`; 1/2 when there is no pair or the numbers cannot be trusted. Never outside [min, 1 - min]. */
export function columnSplit(panes: readonly { weight: number }[]): number {
  if (panes.length < 2) return 0.5;
  const a = panes[0].weight, b = panes[1].weight;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0.5;
  const min = SPACE_MIN_WEIGHT / SPACE_WEIGHT_TOTAL;
  return Math.min(1 - min, Math.max(min, a / (a + b)));
}

/**
 * How far the column line may go at a Space `width` px wide: neither column is drawn narrower than `SPACE_MIN_PANE_PX` (the same least width `paneCapacity`
 * counts panes with), and never closer than `SPACE_MIN_WEIGHT` to either side. A Space too narrow for two columns pins the line in the middle (it is one column
 * there and no line is drawn). An unknown width keeps only the weight floor.
 */
export function columnShareBounds(width: number): { min: number; max: number } {
  const floor = SPACE_MIN_WEIGHT / SPACE_WEIGHT_TOTAL;
  if (!Number.isFinite(width) || width <= 0) return { min: floor, max: 1 - floor };
  const min = Math.max(floor, Math.min(0.5, SPACE_MIN_PANE_PX / width));
  return { min, max: 1 - min };
}

/** `share` inside `columnShareBounds(width)`: what a drag, a key and the drawn grid all use, so the line, its value and its keys never disagree. */
export function clampColumnShare(share: number, width: number): number {
  const { min, max } = columnShareBounds(width);
  if (!Number.isFinite(share)) return 0.5;
  return Math.min(max, Math.max(min, share));
}

/**
 * Writes the weights of `panes` from one column share. Whole numbers summing to exactly 1000: 1 pane = 1000; 2 panes = left/right;
 * 3 panes = the top pair at 4/5 of the total and the bottom pane (across the whole width) at 1/5; 4 panes = the pair twice (each pair half the total).
 * Reading them back through `columnSplit` gives the same share to within one weight point.
 */
export function applyColumnSplit(panes: SpacePane[], share: number): void {
  const n = panes.length;
  if (n === 0) return;
  if (n === 1) { panes[0].weight = SPACE_WEIGHT_TOTAL; return; }
  const left = Math.min(1 - SPACE_MIN_WEIGHT / SPACE_WEIGHT_TOTAL, Math.max(SPACE_MIN_WEIGHT / SPACE_WEIGHT_TOTAL, share));
  const pairTotal = n === 2 ? SPACE_WEIGHT_TOTAL : n === 3 ? 800 : 500;
  const a = Math.max(1, Math.round(pairTotal * left));
  const b = Math.max(1, pairTotal - a);
  panes[0].weight = a; panes[1].weight = b;
  if (n === 3) panes[2].weight = SPACE_WEIGHT_TOTAL - a - b;
  if (n === 4) { panes[2].weight = a; panes[3].weight = SPACE_WEIGHT_TOTAL - a - b - a; }
}

// ---------------------------------------------------------------- reading

function readTab(raw: unknown): SpaceTab | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isSafeId(record.chatId)) return null;
  return { chatId: record.chatId, kind: record.kind === "work" ? "work" : "room" };
}

function readIds(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (ids.length >= max) break;
    if (isSafeId(item) && !seen.has(item)) { seen.add(item); ids.push(item); }
  }
  return ids;
}

/** Any stored value -> a valid layout. Never throws. An old value (tabs, four in a row) is converted here, in memory; the next write stores the new shape in one `setItem`. */
export function normalizeHomeLayout(raw: unknown): HomeLayout {
  const layout = emptyHomeLayout();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return layout;
  const record = raw as Record<string, unknown>;
  // A version this code does not know is dropped, not guessed at.
  if (record.v !== 1) return layout;

  layout.pinned = readIds(record.pinned, HOME_PINNED_MAX);

  if (record.order && typeof record.order === "object" && !Array.isArray(record.order)) {
    let budget = HOME_ORDER_IDS_MAX;
    for (const [key, value] of Object.entries(record.order as Record<string, unknown>)) {
      if (Object.keys(layout.order).length >= HOME_ORDER_GROUPS_MAX || budget <= 0) break;
      if (!isSafeId(key)) continue;
      const ids = readIds(value, budget);
      if (ids.length) { layout.order[key] = ids; budget -= ids.length; }
    }
  }

  const space = record.space;
  if (space && typeof space === "object" && !Array.isArray(space)) {
    const spaceRecord = space as Record<string, unknown>;
    const seenChats = new Set<string>();
    const seenPanes = new Set<string>();
    const panes: SpacePane[] = [];
    const rawPanes = Array.isArray(spaceRecord.panes) ? spaceRecord.panes : [];
    for (const rawPane of rawPanes) {
      if (panes.length >= SPACE_MAX_PANES) break;
      if (!rawPane || typeof rawPane !== "object") continue;
      const paneRecord = rawPane as Record<string, unknown>;
      // The old model: several tabs, one of them active. The pane keeps the active one (else the first valid one); the others leave the layout.
      const valid = (Array.isArray(paneRecord.tabs) ? paneRecord.tabs : []).map(readTab).filter((tab): tab is SpaceTab => tab !== null);
      const chosen = valid.find((tab) => tab.chatId === paneRecord.active) ?? valid[0];
      if (!chosen || seenChats.has(chosen.chatId)) continue; // a pane without a chat is not a pane
      seenChats.add(chosen.chatId);
      let id = isSafeId(paneRecord.id) && !seenPanes.has(paneRecord.id) ? paneRecord.id : null;
      if (!id) id = nextPaneId(seenPanes);
      seenPanes.add(id);
      panes.push({ id, weight: typeof paneRecord.weight === "number" ? paneRecord.weight : 0, active: chosen.chatId, tabs: [chosen] });
    }
    applyColumnSplit(panes, columnSplit(panes));
    layout.space = {
      panes,
      focus: panes.some((pane) => pane.id === spaceRecord.focus) ? (spaceRecord.focus as string) : (panes[0]?.id ?? null),
    };
  }
  return layout;
}

function nextPaneId(taken: ReadonlySet<string>): string {
  for (let n = 1; n < 100; n++) if (!taken.has(`p${n}`)) return `p${n}`;
  return `p${Date.now()}`;
}

// ---------------------------------------------------------------- Space operations

/** `replace-pane`: the chat takes the pane `paneId` (default: the focused one) - what the left list's click does. `new-pane`: a new pane after the last one, when there is room. */
export type OpenHow = "replace-pane" | "new-pane";
export interface OpenRef { chatId: string; kind: SpaceTabKind }

const clone = (layout: HomeLayout): HomeLayout => ({ ...layout, space: { ...layout.space, panes: layout.space.panes.map((pane) => ({ ...pane, tabs: pane.tabs.map((tab) => ({ ...tab })) })) } });

export function findTab(space: SpaceState, chatId: string): { pane: number; tab: number } | null {
  for (let pane = 0; pane < space.panes.length; pane++) {
    const tab = space.panes[pane].tabs.findIndex((item) => item.chatId === chatId);
    if (tab >= 0) return { pane, tab };
  }
  return null;
}

export const openChatIds = (space: SpaceState): string[] => space.panes.flatMap((pane) => pane.tabs.map((tab) => tab.chatId));
export const totalTabs = (space: SpaceState): number => space.panes.reduce((count, pane) => count + pane.tabs.length, 0);

/** Drops empty panes, fixes `active` and `focus`, and writes the column weights again. Every operation ends here. */
function settle(layout: HomeLayout, preferredFocus?: string | null, shareOverride?: number): HomeLayout {
  const share = shareOverride ?? columnSplit(layout.space.panes);
  const panes = layout.space.panes.filter((pane) => pane.tabs.length > 0);
  for (const pane of panes) { pane.tabs = pane.tabs.slice(0, 1); pane.active = pane.tabs[0].chatId; }
  applyColumnSplit(panes, share);
  const wanted = preferredFocus ?? layout.space.focus;
  layout.space = { panes, focus: panes.some((pane) => pane.id === wanted) ? wanted : (panes[0]?.id ?? null) };
  return layout;
}

/**
 * How many panes a Space `width` x `height` px holds (1..4): two columns need 2 x 300 px, two rows 2 x 260 px. A narrower Space is one column (one new
 * pane at most; the panes already open are still drawn, stacked, and the Space scrolls); a shorter one holds two panes side by side.
 * Unknown sizes (0, NaN) hold all four.
 */
export function paneCapacity(width: number, height?: number): number {
  if (!Number.isFinite(width) || width <= 0) return SPACE_MAX_PANES;
  if (width < 2 * SPACE_MIN_PANE_PX) return 1;
  if (height === undefined || !Number.isFinite(height) || height <= 0) return SPACE_MAX_PANES;
  return height >= 2 * SPACE_MIN_PANE_HEIGHT_PX ? SPACE_MAX_PANES : 2;
}

/**
 * What stops a chat from opening in a new pane. Nothing in Space ever closes a pane the person did not close: when there is no room the open does NOT
 * happen, and this says why. `full` = four panes are open, `narrow` = the window holds fewer panes than are open now (`capacity`).
 */
export interface RoomBlock { reason: "full" | "narrow"; paneId: string; capacity: number }
export interface SpaceLimits {
  /** Panes the window can show (`paneCapacity`); default 4. */
  maxPanes?: number;
}

function targetIndex(space: SpaceState, paneId?: string): number {
  return Math.max(0, space.panes.findIndex((pane) => pane.id === (paneId ?? space.focus)));
}

function blockForNewPane(space: SpaceState, limits: SpaceLimits): RoomBlock | null {
  const maxPanes = Math.max(1, Math.min(SPACE_MAX_PANES, limits.maxPanes ?? SPACE_MAX_PANES));
  if (space.panes.length < maxPanes) return null;
  const paneId = space.panes[targetIndex(space)]?.id ?? "";
  return { reason: space.panes.length >= SPACE_MAX_PANES ? "full" : "narrow", paneId, capacity: maxPanes };
}

/** Would `openInSpace` with these arguments be refused for lack of room? (null = it will open) */
export function openBlock(source: HomeLayout, ref: OpenRef, how: OpenHow = "replace-pane", _paneId?: string, limits: SpaceLimits = {}): RoomBlock | null {
  const space = source.space;
  if (!isSafeId(ref.chatId) || space.panes.length === 0 || findTab(space, ref.chatId)) return null;
  return how === "new-pane" ? blockForNewPane(space, limits) : null;
}

/**
 * The New chat start screen asks for a pane of its own, like a chat opened with `new-pane`: refused for lack of room when no more panes fit. The start is
 * the one request with no chat id yet, so it is asked here instead of through `openBlock`. No pane open = the start fills the Space (never refused).
 */
export function newChatBlock(source: HomeLayout, limits: SpaceLimits = {}): RoomBlock | null {
  return source.space.panes.length === 0 ? null : blockForNewPane(source.space, limits);
}

/** A refusal notice is a statement about the layout as it was: once a pane has closed (or the window grew) so that one more fits, it no longer holds and must go. */
export function blockStillApplies(paneCount: number, capacity: number): boolean {
  return paneCount >= Math.max(1, Math.min(SPACE_MAX_PANES, capacity));
}

/**
 * The pane the New chat start covers when no pane is free: the one it was first drawn over (`remembered`) while that pane is still open, else the focused one,
 * else the first. Following the focus instead made the cover jump to whatever pane the person clicked next, over a conversation they were reading.
 */
export function coverPaneId(panes: readonly { id: string }[], focus: string | null, remembered: string | null): string | null {
  if (panes.length === 0) return null;
  if (remembered && panes.some((pane) => pane.id === remembered)) return remembered;
  return panes.some((pane) => pane.id === focus) ? focus : panes[0].id;
}

/**
 * Opens a chat in Space. A chat that is already open is only brought forward (never opened twice); no pane yet makes the first one;
 * `replace-pane` puts it in the pane (the chat that was there only leaves the layout - it stays in the left list); `new-pane` makes
 * the next pane when there is room and otherwise changes nothing (`openBlock` says why).
 */
export function openInSpace(source: HomeLayout, ref: OpenRef, how: OpenHow = "replace-pane", paneId?: string, limits: SpaceLimits = {}): HomeLayout {
  if (!isSafeId(ref.chatId)) return source;
  const layout = clone(source);
  const space = layout.space;
  const existing = findTab(space, ref.chatId);
  if (existing) return settle(layout, space.panes[existing.pane].id);
  const tab: SpaceTab = { chatId: ref.chatId, kind: ref.kind === "work" ? "work" : "room" };
  if (space.panes.length === 0) {
    space.panes.push({ id: "p1", weight: SPACE_WEIGHT_TOTAL, active: tab.chatId, tabs: [tab] });
    return settle(layout, "p1");
  }
  if (how === "new-pane") {
    if (blockForNewPane(space, limits)) return source;
    const id = nextPaneId(new Set(space.panes.map((pane) => pane.id)));
    // From one pane to two the line starts in the middle; later panes keep the line where it is.
    const share = space.panes.length === 1 ? 0.5 : undefined;
    space.panes.push({ id, weight: 1, active: tab.chatId, tabs: [tab] });
    return settle(layout, id, share);
  }
  const pane = space.panes[targetIndex(space, paneId)];
  pane.tabs = [tab];
  pane.active = tab.chatId;
  return settle(layout, pane.id);
}

export function setFocus(source: HomeLayout, paneId: string): HomeLayout {
  if (source.space.focus === paneId || !source.space.panes.some((pane) => pane.id === paneId)) return source;
  return { ...source, space: { ...source.space, focus: paneId } };
}

/** Closing a pane only changes the layout - the conversation and any run in it are untouched. */
export function closeTab(source: HomeLayout, chatId: string): HomeLayout {
  const found = findTab(source.space, chatId);
  return found ? closePane(source, source.space.panes[found.pane].id) : source;
}

export function closePane(source: HomeLayout, paneId: string): HomeLayout {
  const layout = clone(source);
  const before = layout.space.panes.length;
  const share = columnSplit(source.space.panes); // the line stays where it was when the panes shift into the freed place
  layout.space.panes = layout.space.panes.filter((pane) => pane.id !== paneId);
  return layout.space.panes.length === before ? source : settle(layout, undefined, share);
}

export function closeOtherPanes(source: HomeLayout, paneId: string): HomeLayout {
  const layout = clone(source);
  const keep = layout.space.panes.filter((pane) => pane.id === paneId);
  if (keep.length === 0 || keep.length === layout.space.panes.length) return source;
  layout.space.panes = keep;
  return settle(layout, paneId, 0.5);
}

/** Closes every pane whose chat is gone (deleted, archived, hidden) - the restore and the live cleanup use this. */
export function dropChats(source: HomeLayout, gone: ReadonlySet<string>): HomeLayout {
  let layout = source;
  for (const chatId of openChatIds(source.space)) if (gone.has(chatId)) layout = closeTab(layout, chatId);
  return layout;
}

/** Re-labels a pane's screen (a room opens in the chat view, a work session in the Work view) from what the store says it is. */
export function relabelTabs(source: HomeLayout, kinds: ReadonlyMap<string, SpaceTabKind>): HomeLayout {
  let changed = false;
  const layout = clone(source);
  for (const pane of layout.space.panes) for (const tab of pane.tabs) {
    const kind = kinds.get(tab.chatId);
    if (kind && kind !== tab.kind) { tab.kind = kind; changed = true; }
  }
  return changed ? layout : source;
}

export type MoveTarget =
  | { type: "replace"; paneId: string }
  | { type: "new-pane" };

/** Would `placeTab` with these arguments be refused for lack of room? (null = it will be placed) */
export function placeBlock(source: HomeLayout, ref: OpenRef, target: MoveTarget, limits: SpaceLimits = {}): RoomBlock | null {
  const space = source.space;
  if (!isSafeId(ref.chatId) || space.panes.length === 0 || findTab(space, ref.chatId)) return null;
  return target.type === "new-pane" ? blockForNewPane(space, limits) : null;
}

/** A drop: the chat takes the pane it was dropped on (`replace`), or opens in a new pane (`new-pane`). A chat that is already open is only brought forward. */
export function placeTab(source: HomeLayout, ref: OpenRef, target: MoveTarget, limits: SpaceLimits = {}): HomeLayout {
  if (!isSafeId(ref.chatId)) return source;
  if (target.type === "new-pane") return openInSpace(source, ref, "new-pane", undefined, limits);
  return openInSpace(source, ref, "replace-pane", target.paneId, limits);
}

/**
 * The column line: moves the share of the left column by `delta` weight points (positive = the left column grows). Panes only share a column line from two
 * panes on. With the Space's `width` the line stops where a column would be narrower than `SPACE_MIN_PANE_PX`, and a stored line already past that point
 * is first read back to it - so one arrow press always moves what is drawn.
 */
export function resizeColumns(source: HomeLayout, delta: number, width?: number): HomeLayout {
  const panes = source.space.panes;
  if (panes.length < 2 || !Number.isFinite(delta)) return source;
  const shown = width === undefined ? columnSplit(panes) : clampColumnShare(columnSplit(panes), width);
  return setColumnSplit(source, shown + delta / SPACE_WEIGHT_TOTAL, width);
}

/** The line's end positions as weights: `min` and `max` (used by Home / End on the line). */
export function columnLineEnds(width: number): { min: number; max: number } {
  const { min, max } = columnShareBounds(width);
  return { min: min * SPACE_WEIGHT_TOTAL, max: max * SPACE_WEIGHT_TOTAL };
}

/** Sets the column line from a share 0..1 (a finished drag; `width` = the Space's px width keeps both columns at least `SPACE_MIN_PANE_PX`). Within one weight point of the same value nothing changes. */
export function setColumnSplit(source: HomeLayout, share: number, width?: number): HomeLayout {
  const panes = source.space.panes;
  if (panes.length < 2 || !Number.isFinite(share)) return source;
  const layout = clone(source);
  applyColumnSplit(layout.space.panes, width === undefined ? share : clampColumnShare(share, width));
  return layout.space.panes.every((pane, index) => pane.weight === panes[index].weight) ? source : layout;
}

// ---------------------------------------------------------------- pins and order (the left list)

export function togglePin(source: HomeLayout, chatId: string): HomeLayout {
  if (!isSafeId(chatId)) return source;
  if (source.pinned.includes(chatId)) return { ...source, pinned: source.pinned.filter((id) => id !== chatId) };
  // The newest pin goes to the bottom of the pinned block; at the cap the oldest pin leaves.
  const pinned = [...source.pinned, chatId].slice(-HOME_PINNED_MAX);
  return { ...source, pinned };
}

function capOrder(order: Record<string, string[]>): Record<string, string[]> {
  const keys = Object.keys(order);
  const next: Record<string, string[]> = {};
  let budget = HOME_ORDER_IDS_MAX;
  // The most recently written group is last in insertion order; it keeps priority.
  for (const key of keys.slice(-HOME_ORDER_GROUPS_MAX).reverse()) {
    if (budget <= 0) break;
    const ids = order[key].slice(0, budget);
    if (ids.length) { next[key] = ids; budget -= ids.length; }
  }
  return Object.fromEntries(Object.entries(next).reverse());
}

/** "Move to top": the chat goes first in its group's order. */
export function moveToTop(source: HomeLayout, groupKey: string, chatId: string): HomeLayout {
  if (!isSafeId(chatId) || !isSafeId(groupKey)) return source;
  const rest = (source.order[groupKey] ?? []).filter((id) => id !== chatId);
  const { [groupKey]: _old, ...others } = source.order;
  return { ...source, order: capOrder({ ...others, [groupKey]: [chatId, ...rest] }) };
}

/** A drop in the list: `chatId` goes right before `beforeId` in the group's order (`null` = to the end of the moved ones). */
export function moveBefore(source: HomeLayout, groupKey: string, chatId: string, beforeId: string | null, visibleOrder: readonly string[]): HomeLayout {
  if (!isSafeId(chatId) || !isSafeId(groupKey) || chatId === beforeId) return source;
  // The drop is relative to what is on screen: freeze the shown order into the stored one, then move.
  const shown = visibleOrder.filter((id) => id !== chatId);
  const at = beforeId === null ? shown.length : shown.indexOf(beforeId);
  if (at < 0) return source;
  shown.splice(at, 0, chatId);
  const { [groupKey]: _old, ...others } = source.order;
  return { ...source, order: capOrder({ ...others, [groupKey]: shown.slice(0, HOME_ORDER_IDS_MAX) }) };
}

/** Removes ids that no longer exist from the pins and the order (the caller says which ids are certainly gone). */
export function pruneListState(source: HomeLayout, gone: ReadonlySet<string>): HomeLayout {
  if (gone.size === 0) return source;
  const pinned = source.pinned.filter((id) => !gone.has(id));
  let changed = pinned.length !== source.pinned.length;
  const order: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(source.order)) {
    const kept = ids.filter((id) => !gone.has(id));
    if (kept.length !== ids.length) changed = true;
    if (kept.length) order[key] = kept; else changed = true;
  }
  return changed ? { ...source, pinned, order } : source;
}

/** Sorts rows for one group: pinned first (in pin order), then the moved ones (in their order), then the rest as given. */
export function sortRowsForGroup<T extends { id: string }>(rows: readonly T[], pinned: readonly string[], order: readonly string[] | undefined): T[] {
  if (!pinned.length && !(order && order.length)) return [...rows];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const placed = new Set<string>();
  const out: T[] = [];
  const take = (id: string) => { const row = byId.get(id); if (row && !placed.has(id)) { placed.add(id); out.push(row); } };
  pinned.forEach(take);
  (order ?? []).forEach(take);
  for (const row of rows) if (!placed.has(row.id)) out.push(row);
  return out;
}

/** The layout is a screen preference: equal content writes nothing. */
export const sameLayout = (a: HomeLayout, b: HomeLayout): boolean => JSON.stringify(a) === JSON.stringify(b);
