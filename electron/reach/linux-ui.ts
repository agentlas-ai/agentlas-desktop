import type { Actuator } from "./actuator";
import type { ElementRecord } from "./dialog-probe";
import { isPersonalMenu, sameLabel } from "./menu-text";
import type { MenuNode, MenuPathState, MenuScan, MenuScanOptions, MenuTarget } from "./menu-probe";

// What is different on a Linux desktop (accessibility through AT-SPI), measured on 2026-10-23 with the real Cua Driver 0.38.0 against Mousepad
// (GTK3) on X11 with a window manager:
//  - menus are CLOSED in the tree: a top-level `menu` lists no items until it is clicked; the click only opens it (nothing is executed),
//    the items then appear under it, and a submenu (`menu` inside a menu) opens the same way. So the menu bar is read by opening a menu,
//    reading it and closing it again, never by pressing an item. Only elements whose role is `menu` are ever clicked.
//  - the tree reports which popups are open (`popups`), and one real Escape key (foreground delivery; without a window manager the
//    driver refuses) closes them;
//  - a dialog is a separate top-level window, and its tree ALSO carries the main window's menu bar and tool bar: what belongs to the
//    dialog is what is left after the main window's own elements are taken away;
//  - a combo box is captioned with its current value, a list or table holds the owner's data (printers, files), roles have AT-SPI names;
//  - a menu may end with a list of the open documents (their names are the owner's data).
// Everything above this file keeps working with the macOS role names: the Linux tree is translated into them once, here.

const SETTLE_MS = 450;
const MAX_SETTLE_READS = 3;

const ROLE_MAP: Readonly<Record<string, string>> = {
  "push button": "AXButton",
  "toggle button": "AXCheckBox",
  "check box": "AXCheckBox",
  "radio button": "AXRadioButton",
  "combo box": "AXPopUpButton",
  "spin button": "AXIncrementor",
  "slider": "AXSlider",
  "text": "AXTextField",
  "entry": "AXTextField",
  "password text": "AXSecureTextField",
  "dialog": "AXSheet",
};

// Anything that holds items of the owner's own (files, printers, accounts, rows of a table) is content, whatever it is called.
const CONTENT_ROLES: ReadonlySet<string> = new Set([
  "table", "tree table", "tree", "list", "list box", "file chooser", "table cell", "table row", "table column header", "table row header",
  "list item", "tree item", "description list", "directory pane",
]);

const FILE_NAME = /\.[A-Za-z0-9]{1,5}$/;

export function normalizeLinuxElement(element: ElementRecord): ElementRecord {
  const raw = element.role ?? "";
  if (CONTENT_ROLES.has(raw)) return { ...element, role: "AXTable" };
  const role = ROLE_MAP[raw];
  if (!role) return element;
  // A combo box is captioned with the choice it currently shows, which is a value (and may be the owner's data), never a caption.
  if (role === "AXPopUpButton") return { ...element, role, label: null };
  return { ...element, role };
}

export function normalizeLinuxTree(elements: readonly ElementRecord[]): ElementRecord[] {
  return elements.map(normalizeLinuxElement);
}

const keyOf = (element: ElementRecord): string => `${element.role ?? ""}|${(element.label ?? "").replace(/\s+/g, " ").trim()}`;

// With some toolkit setups (measured with Mousepad) the tree of a dialog window ALSO holds the main window's own menu bar and tool bar; with
// others (Geany) it holds only the dialog. When most of the main window's elements are found in the dialog's tree, they are taken away,
// one for one, and what remains is the dialog's; otherwise the tree already is the dialog's. If some of the dialog's own controls look
// exactly like a main window one they are lost with it: a smaller description, never a wrong one.
const CHROME_COVERAGE = 0.6;
export function withoutChrome(dialog: readonly ElementRecord[], chrome: readonly ElementRecord[]): ElementRecord[] {
  if (chrome.length === 0) return [...dialog];
  const budget = new Map<string, number>();
  for (const element of chrome) budget.set(keyOf(element), (budget.get(keyOf(element)) ?? 0) + 1);
  const have = new Map<string, number>();
  for (const element of dialog) have.set(keyOf(element), (have.get(keyOf(element)) ?? 0) + 1);
  let covered = 0;
  for (const [key, count] of budget) covered += Math.min(count, have.get(key) ?? 0);
  if (covered / chrome.length < CHROME_COVERAGE) return [...dialog];
  return dialog.filter((element) => {
    const key = keyOf(element);
    const left = budget.get(key) ?? 0;
    if (left > 0) { budget.set(key, left - 1); return false; }
    return true;
  });
}

interface LinuxRead { elements: ElementRecord[]; popupIds: number[]; truncated: boolean }

// `baseline`: popups that were already there before this code touched anything (a tooltip under the pointer, say). They are not ours to close
// and do not count as an open menu.
interface Context { actuator: Actuator; target: MenuTarget; signal?: AbortSignal; sleep: (ms: number) => Promise<void>; baseline: Set<number> }

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function read(ctx: Context): Promise<LinuxRead | null> {
  const state = await ctx.actuator.call("get_window_state", {
    pid: ctx.target.pid, window_id: ctx.target.windowId, include_screenshot: false, tree_format: "elements", max_elements: 3000, timeout_ms: 10_000,
  }, { signal: ctx.signal, timeoutMs: 40_000 });
  const rows = state.structured?.elements;
  if (!state.ok || !Array.isArray(rows)) return null;
  return { elements: rows as ElementRecord[], popupIds: popupIdsOf(state.structured), truncated: state.structured?.truncated === true || /PARTIAL TREE/.test(state.text ?? "") };
}

// The windows the driver reports as popups of this window: open menus, and also tooltips.
export function popupIdsOf(structured: Record<string, unknown> | undefined): number[] {
  const popups = structured?.popups;
  return Array.isArray(popups) ? popups.flatMap((popup) => (typeof (popup as { window_id?: unknown })?.window_id === "number" ? [(popup as { window_id: number }).window_id] : [])) : [];
}

const ours = (ctx: Context, state: LinuxRead): number[] => state.popupIds.filter((id) => !ctx.baseline.has(id));

const noParent = (element: ElementRecord): boolean => element.parent_index === undefined || element.parent_index === null;
// An entry the toolkit keeps in the tree but does not show (the items of a submenu whose parent is switched off or hidden) has no place on
// screen. It is not part of the menu, and pressing it wedges the open menu (measured on Geany: the menu then ignores Escape).
const showing = (element: ElementRecord): boolean => !!element.frame && element.frame.w > 0 && element.frame.h > 0;
const ITEM_ROLES: ReadonlySet<string> = new Set(["menu item", "check menu item", "radio menu item", "menu"]);

// The menu bar's own entries: menus that hang from no other element (or from an element called a menu bar, where the toolkit shows one).
function topMenus(elements: readonly ElementRecord[]): ElementRecord[] {
  const bars = new Set(elements.filter((element) => element.role === "menu bar").map((element) => element.element_index));
  return elements.filter((element) => element.role === "menu" && showing(element) && (noParent(element) || bars.has(element.parent_index as number)));
}

function itemsOf(elements: readonly ElementRecord[], owner: ElementRecord): ElementRecord[] {
  return elements.filter((element) => element.parent_index === owner.element_index && ITEM_ROLES.has(element.role ?? "") && showing(element));
}

type Located = ElementRecord | "missing" | "ambiguous" | "not_a_submenu";

// The element a chain of captions leads to (File > New From Template), found again in every fresh read: element numbers change from read to read.
function locate(elements: readonly ElementRecord[], chain: readonly string[]): Located {
  let candidates = topMenus(elements);
  let current: ElementRecord | undefined;
  for (let depth = 0; depth < chain.length; depth += 1) {
    const found = candidates.filter((element) => sameLabel(element.label ?? "", chain[depth]));
    if (found.length === 0) return "missing";
    if (found.length > 1) return "ambiguous";
    current = found[0];
    if (depth < chain.length - 1) {
      if (current.role !== "menu") return "not_a_submenu";
      candidates = itemsOf(elements, current);
    }
  }
  return current ?? "missing";
}

// Escape closes what is open. It is only sent while a popup is open (an Escape in a window that has none could be taken by the app).
async function closeAll(ctx: Context): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await read(ctx);
    if (!state) return false;
    if (ours(ctx, state).length === 0) return true;
    await ctx.actuator.call("press_key", { pid: ctx.target.pid, window_id: ctx.target.windowId, key: "escape", delivery_mode: "foreground" }, { timeoutMs: 10_000 });
    await ctx.sleep(350);
  }
  const last = await read(ctx);
  return !!last && ours(ctx, last).length === 0;
}

type Opened = { ok: true; elements: ElementRecord[]; owner: ElementRecord; truncated: boolean } | { ok: false; code: string };

// Opens the menus along `chain`, one click each, and returns the last one's items. Only a `menu` is ever clicked: an item that is a command
// (a `menu item`) is executed by a click, so it ends the chain with `not_a_submenu`.
async function openChain(ctx: Context, chain: readonly string[]): Promise<Opened> {
  for (let depth = 0; depth < chain.length; depth += 1) {
    if (ctx.signal?.aborted) return { ok: false, code: "aborted" };
    const state = await read(ctx);
    if (!state) return { ok: false, code: "unreadable" };
    const found = locate(state.elements, chain.slice(0, depth + 1));
    if (typeof found === "string") return { ok: false, code: found };
    if (found.role !== "menu") return { ok: false, code: "not_a_submenu" };
    if (found.enabled === false) return { ok: false, code: "disabled" };
    if (!found.element_token) return { ok: false, code: "no_token" };
    const clicked = await ctx.actuator.call("click", { pid: ctx.target.pid, window_id: ctx.target.windowId, element_token: found.element_token }, { signal: ctx.signal, timeoutMs: 15_000 });
    if (!clicked.ok) return { ok: false, code: clicked.refusalCode ?? clicked.errorCode ?? "click_failed" };
    await ctx.sleep(SETTLE_MS);
  }
  for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt += 1) {
    const state = await read(ctx);
    if (!state) return { ok: false, code: "unreadable" };
    const owner = locate(state.elements, chain);
    if (typeof owner === "string") return { ok: false, code: owner };
    if (itemsOf(state.elements, owner).length > 0 || attempt === MAX_SETTLE_READS - 1) return { ok: true, elements: state.elements, owner, truncated: state.truncated };
    await ctx.sleep(SETTLE_MS);
  }
  return { ok: false, code: "unreadable" };
}

// A menu can end with the list of the documents the app has open; the names of those documents are the owner's data. The list is the last
// block of the menu (set apart by a gap where the separator is), every entry of it is a selectable check/radio item and none carries the
// app's own tooltip text. Such a block is left out, and so is any entry that is named like a file.
export function withoutDocumentList(entries: readonly ElementRecord[]): ElementRecord[] {
  const visible = entries.filter((entry) => (entry.label ?? "").trim() !== "");
  const groups: ElementRecord[][] = [];
  let previous: ElementRecord | undefined;
  for (const entry of visible) {
    const gap = previous?.frame && entry.frame ? entry.frame.y - (previous.frame.y + previous.frame.h) : 0;
    if (!previous || gap > 6) groups.push([]);
    groups[groups.length - 1].push(entry);
    previous = entry;
  }
  const last = groups[groups.length - 1];
  const looksLikeList = groups.length > 1 && !!last && last.every((entry) => entry.role === "menu item" && entry.selected !== undefined && !(entry.description ?? "").trim());
  const kept = looksLikeList ? visible.filter((entry) => !last.includes(entry)) : visible;
  return kept.filter((entry) => !FILE_NAME.test((entry.label ?? "").trim()));
}

function nodeOf(entry: ElementRecord, parentPath: readonly string[], children: MenuNode[]): MenuNode {
  const label = (entry.label ?? "").trim();
  return { label, path: [...parentPath, label], leaf: entry.role !== "menu", enabled: entry.enabled !== false, children };
}

export async function enumerateLinuxMenus(actuator: Actuator, target: MenuTarget, options: MenuScanOptions = {}): Promise<MenuScan> {
  const maxDepth = options.maxDepth ?? 3;
  const maxItems = options.maxItemsPerLevel ?? 80;
  const maxNodes = options.maxNodes ?? 900;
  const ctx: Context = { actuator, target, signal: options.signal, sleep: options.sleep ?? realSleep, baseline: new Set() };
  const skipped: string[] = [];
  const stopped = (): boolean => options.signal?.aborted === true || options.shouldStop?.() === true;
  let reads = 0;
  if (stopped()) return { nodes: [], reads, truncated: true, skipped };
  const first = await read(ctx);
  reads += 1;
  if (!first) return { nodes: [], reads, truncated: false, skipped: ["menu bar (unreadable)"] };
  // What is open now is not ours: it is neither closed nor counted as a menu this scan opened.
  for (const id of first.popupIds) ctx.baseline.add(id);
  const tops = topMenus(first.elements);
  if (tops.length === 0) return { nodes: [], reads, truncated: false, skipped: ["menu bar (absent)"] };
  const windows = await actuator.listWindows({ pid: target.pid }, { signal: options.signal }).catch(() => []);
  const titles = windows.map((window) => window.title.trim()).filter((title) => title.length >= 3);
  const namedAfterWindow = (label: string): boolean => titles.some((title) => title === label || title.startsWith(`${label} - `) || title.endsWith(` - ${label}`));

  let truncated = first.truncated;
  let counted = 0;
  let stuck = false;
  const nodes: MenuNode[] = [];
  let topIndex = 0;
  const fresh = (entries: readonly ElementRecord[]): ElementRecord[] => withoutDocumentList(entries).filter((entry) => !namedAfterWindow((entry.label ?? "").trim()));

  for (const top of tops) {
    if (stopped() || counted >= maxNodes) { truncated = true; break; }
    const label = (top.label ?? "").trim();
    if (!label) continue;
    const here = topIndex;
    topIndex += 1;
    if (isPersonalMenu(label, 0, here)) { skipped.push(label); continue; }
    const opened = await openChain(ctx, [label]);
    reads += 3;
    if (!opened.ok) {
      skipped.push(`${label} (${opened.code})`);
      if (!(await closeAll(ctx))) { stuck = true; break; }
      continue;
    }
    const entries = fresh(itemsOf(opened.elements, opened.owner)).slice(0, maxItems);
    if (itemsOf(opened.elements, opened.owner).length > maxItems) truncated = true;
    if (opened.truncated) truncated = true;
    const closed = await closeAll(ctx);
    if (!closed) { stuck = true; break; }

    const children: MenuNode[] = [];
    for (const entry of entries) {
      const entryLabel = (entry.label ?? "").trim();
      if (stopped() || counted >= maxNodes) { truncated = true; break; }
      if (isPersonalMenu(entryLabel, 1, children.length)) { skipped.push(`${label} > ${entryLabel}`); continue; }
      counted += 1;
      let below: MenuNode[] = [];
      if (entry.role === "menu") {
        if (maxDepth <= 2) truncated = true; // a submenu below the depth limit is not read
        else if (entry.enabled !== false) {
          const sub = await openChain(ctx, [label, entryLabel]);
          reads += 3;
          if (sub.ok) {
            const items = fresh(itemsOf(sub.elements, sub.owner)).slice(0, maxItems).filter((item) => !isPersonalMenu((item.label ?? "").trim(), 2, 0));
            if (items.some((item) => item.role === "menu")) truncated = true; // a submenu below the depth limit is not read
            below = items.map((item) => nodeOf(item, [label, entryLabel], []));
            counted += below.length;
          } else skipped.push(`${label} > ${entryLabel} (${sub.code})`);
          if (!(await closeAll(ctx))) { stuck = true; }
        }
      }
      children.push(nodeOf(entry, [label], below));
      if (stuck) break;
    }
    nodes.push({ label, path: [label], leaf: false, enabled: top.enabled !== false, children });
    if (stuck) break;
  }
  if (stuck) skipped.push("menu bar (a menu would not close)");
  return { nodes, reads, truncated: truncated || stuck, skipped, ...(stuck ? { stuck: true } : {}) };
}

// Does this window carry the app's menu bar?
export async function hasLinuxMenuBar(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): Promise<boolean> {
  const state = await read({ actuator, target, signal, sleep: realSleep, baseline: new Set() });
  return !!state && topMenus(state.elements).length > 0;
}

export async function resolveLinuxMenuPath(actuator: Actuator, target: MenuTarget, path: readonly string[], signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<MenuPathState> {
  const ctx: Context = { actuator, target, signal, sleep: sleep ?? realSleep, baseline: new Set() };
  const chain = path.slice(0, -1);
  const lastLabel = path[path.length - 1];
  try {
    const start = await read(ctx);
    if (!start) return { status: "unreadable", code: "unreadable" };
    for (const id of start.popupIds) ctx.baseline.add(id);
    if (chain.length === 0) {
      const state = start;
      const top = locate(state.elements, [lastLabel]);
      if (typeof top === "string") return { status: top === "not_a_submenu" ? "missing" : top };
      return { status: "ok", enabled: top.enabled !== false };
    }
    const opened = await openChain(ctx, chain);
    if (!opened.ok) {
      if (opened.code === "missing" || opened.code === "ambiguous" || opened.code === "not_a_submenu") return { status: opened.code };
      return { status: "unreadable", code: opened.code };
    }
    const found = itemsOf(opened.elements, opened.owner).filter((entry) => sameLabel(entry.label ?? "", lastLabel));
    if (found.length === 0) return { status: "missing" };
    if (found.length > 1) return { status: "ambiguous" };
    return { status: "ok", enabled: found[0].enabled !== false };
  } finally {
    // Whatever happened, no menu is left open.
    await closeAll(ctx).catch(() => false);
  }
}
