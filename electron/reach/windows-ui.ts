import type { Actuator, ToolOutcome } from "./actuator";
import type { ElementRecord } from "./dialog-probe";
import { isPersonalMenu, sameLabel } from "./menu-text";
import type { MenuNode, MenuPathState, MenuScan, MenuScanOptions, MenuTarget } from "./menu-probe";

// What is different on Windows (UI Automation), measured on 2026-10-23 with the real Cua Driver 0.38.0 on Windows 11 ARM64 (build 26300, QEMU),
// against System Information (a classic Win32 menu bar) and Notepad:
//  - roles are UIA control types (Button, Edit, CheckBox, RadioButton, ComboBox, ListItem, MenuItem, TitleBar ...); the menu bar is `MenuItem`s that
//    hang from nothing and carry the action `expand`; the title bar's own system menu hangs from the TitleBar;
//  - a menu is OPEN only after it was expanded: its items then show up in the SAME window tree as more parentless `MenuItem`s (a flat list, below the
//    bar), a leaf with the action `invoke` only, a submenu with `expand` (Notepad's Zoom: `invoke` and `expand`), and a submenu opened on top shows its own
//    items in addition to the ones already there. Labels carry the accelerator after a tab ("Open...\tCtrl+O");
//  - `invoke_menu` expands a TOP-LEVEL menu without executing anything (the bar item has no leaf action), but it cannot find an item inside a classic
//    popup ("menu path segment 1 was not found", also for items that are there), and a failed call leaves the menu open. Items are therefore opened
//    and pressed by their element token: the click must be `delivery_mode: "foreground"` (a background click is a PostMessage that a popup ignores:
//    Notepad's Zoom closed the menu instead of opening it), which needs the app in front; the driver refuses when Windows will not let it
//    (`foreground_unavailable`, measured while the Search flyout held the foreground);
//  - Escape through PostMessage closes an open menu (one level per press);
//  - a dialog is a window of its own and does NOT have to belong to the app: the modern Print dialog is hosted by explorer.exe. Its tree holds only the
//    dialog; a combo box carries its current value as child elements (a text, a drop-down button, a list item) and the title bar a Close button.
// Everything above this file keeps working with the macOS role names: dialog trees are translated into them once, here.

const SETTLE_MS = 700;
const MAX_SETTLE_READS = 3;

export const cleanWindowsLabel = (raw: string | null | undefined): string => (raw ?? "").split("\t")[0].replace(/\s+/g, " ").trim();

const ROLE_MAP: Readonly<Record<string, string>> = {
  Button: "AXButton",
  CheckBox: "AXCheckBox",
  RadioButton: "AXRadioButton",
  ComboBox: "AXPopUpButton",
  Spinner: "AXIncrementor",
  Slider: "AXSlider",
  Edit: "AXTextField",
};

// Items of the owner's own (files, printers, rows of a grid) are content, whatever they are called.
const CONTENT_ROLES: ReadonlySet<string> = new Set(["List", "ListItem", "Tree", "TreeItem", "DataGrid", "DataItem", "Table", "HeaderItem", "Header", "Group-list"]);

const SECRET_CAPTION = /pass(word|code|phrase)|\bpin\b|secret|암호|비밀번호/i;

export function normalizeWindowsTree(elements: readonly ElementRecord[]): ElementRecord[] {
  const byIndex = new Map(elements.map((element) => [element.element_index, element]));
  const insideOwned = (element: ElementRecord): boolean => {
    // what a combo box carries inside itself (its text, its arrow, its list) and what the title bar carries (Close) is not a control of the dialog
    let cursor = element.parent_index === undefined || element.parent_index === null ? undefined : byIndex.get(element.parent_index);
    for (let hops = 0; cursor && hops < 32; hops += 1) {
      if (cursor.role === "ComboBox" || cursor.role === "TitleBar") return true;
      cursor = cursor.parent_index === undefined || cursor.parent_index === null ? undefined : byIndex.get(cursor.parent_index);
    }
    return false;
  };
  // A combo box can expose its drop-down arrow as a button next to it instead of inside it (Notepad's Page Setup): a button named Open or Close
  // that follows a combo box closely is the arrow, not an action of the dialog.
  const arrows = new Set<number>();
  for (const element of elements) {
    if (element.role !== "ComboBox") continue;
    for (const other of elements) {
      if (other.role === "Button" && /^(open|close|drop down|dropdown)$/i.test(cleanWindowsLabel(other.label)) && other.element_index > element.element_index && other.element_index <= element.element_index + 3) arrows.add(other.element_index);
    }
  }
  const out: ElementRecord[] = [];
  for (const element of elements) {
    if (insideOwned(element) || arrows.has(element.element_index)) continue;
    const raw = element.role ?? "";
    if (CONTENT_ROLES.has(raw)) { out.push({ ...element, role: "AXTable" }); continue; }
    const role = ROLE_MAP[raw];
    if (!role) { out.push(element); continue; }
    const caption = cleanWindowsLabel(element.label);
    if (role === "AXTextField" && SECRET_CAPTION.test(caption)) { out.push({ ...element, role: "AXSecureTextField" }); continue; }
    out.push({ ...element, role });
  }
  return out;
}

interface Context { actuator: Actuator; target: MenuTarget; signal?: AbortSignal; sleep: (ms: number) => Promise<void> }

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const noParent = (element: ElementRecord): boolean => element.parent_index === undefined || element.parent_index === null;
const showing = (element: ElementRecord): boolean => !!element.frame && element.frame.w > 0 && element.frame.h > 0;
const expandable = (element: ElementRecord): boolean => (element.actions ?? []).includes("expand");

async function read(ctx: Context): Promise<ElementRecord[] | null> {
  const state = await ctx.actuator.call("get_window_state", {
    pid: ctx.target.pid, window_id: ctx.target.windowId, include_screenshot: false, tree_format: "elements", max_elements: 800, timeout_ms: 10_000,
  }, { signal: ctx.signal, timeoutMs: 40_000 });
  const rows = state.structured?.elements;
  return state.ok && Array.isArray(rows) ? (rows as ElementRecord[]) : null;
}

const menuItemsOf = (elements: readonly ElementRecord[]): ElementRecord[] => elements.filter((element) => element.role === "MenuItem" && noParent(element) && showing(element));

const keyOf = (element: ElementRecord): string => `${cleanWindowsLabel(element.label)}|${element.frame?.x ?? ""}|${element.frame?.y ?? ""}`;

interface Bar { labels: Set<string>; keys: Set<string>; y: number }

function barFrom(elements: readonly ElementRecord[]): Bar | null {
  const items = menuItemsOf(elements).filter(expandable);
  if (items.length === 0) return null;
  // Nothing is open when the parentless items all expand and sit on one line: the bar.
  const y = Math.min(...items.map((item) => item.frame?.y ?? 0));
  const line = items.filter((item) => Math.abs((item.frame?.y ?? 0) - y) <= 4);
  return { labels: new Set(line.map((item) => cleanWindowsLabel(item.label))), keys: new Set(line.map(keyOf)), y };
}

// Items of the menus that are open: parentless menu items that are not the bar (below it).
function openItems(elements: readonly ElementRecord[], bar: Bar): ElementRecord[] {
  return menuItemsOf(elements).filter((element) => !bar.keys.has(keyOf(element)) && (element.frame?.y ?? 0) > bar.y + 4);
}

// A menu is open when parentless menu items that do not expand-and-sit-on-the-bar exist: closing sends Escape (one level per press), looking again each time.
async function closeAll(ctx: Context, bar: Bar): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const elements = await read(ctx);
    if (!elements) return false;
    if (openItems(elements, bar).length === 0) return true;
    await ctx.actuator.call("press_key", { pid: ctx.target.pid, window_id: ctx.target.windowId, key: "escape" }, { timeoutMs: 10_000 });
    await ctx.sleep(450);
  }
  const last = await read(ctx);
  return !!last && openItems(last, bar).length === 0;
}

type Level = { ok: true; elements: ElementRecord[]; items: ElementRecord[]; keys: Set<string> } | { ok: false; code: string };

// Opens the chain of menus (the top one by expanding it, each next one by pressing it as a user would) and returns what the last one added.
// Only an item that expands is ever pressed on the way: a command would be executed by the press.
async function openChain(ctx: Context, bar: Bar, chain: readonly string[]): Promise<Level> {
  let known = new Set<string>();
  let items: ElementRecord[] = [];
  let elements: ElementRecord[] = [];
  for (let depth = 0; depth < chain.length; depth += 1) {
    if (ctx.signal?.aborted) return { ok: false, code: "aborted" };
    if (depth === 0) {
      const opened = await ctx.actuator.call("invoke_menu", { pid: ctx.target.pid, window_id: ctx.target.windowId, path: [cleanWindowsLabel(chain[0])] }, { signal: ctx.signal, timeoutMs: 15_000 });
      if (!opened.ok) return { ok: false, code: opened.refusalCode ?? opened.errorCode ?? "expand_failed" };
    } else {
      const next = items.filter((item) => sameLabel(cleanWindowsLabel(item.label), cleanWindowsLabel(chain[depth])));
      if (next.length === 0) return { ok: false, code: "missing" };
      if (next.length > 1) return { ok: false, code: "ambiguous" };
      if (!expandable(next[0])) return { ok: false, code: "not_a_submenu" };
      if (next[0].enabled === false) return { ok: false, code: "disabled" };
      if (!next[0].element_token) return { ok: false, code: "no_token" };
      const pressed = await ctx.actuator.call("click", { pid: ctx.target.pid, window_id: ctx.target.windowId, element_token: next[0].element_token, delivery_mode: "foreground" }, { signal: ctx.signal, timeoutMs: 15_000 });
      if (!pressed.ok) return { ok: false, code: pressed.refusalCode ?? pressed.errorCode ?? "click_failed" };
    }
    await ctx.sleep(SETTLE_MS);
    let fresh: ElementRecord[] = [];
    for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt += 1) {
      const now = await read(ctx);
      if (!now) return { ok: false, code: "unreadable" };
      elements = now;
      fresh = openItems(now, bar).filter((item) => !known.has(keyOf(item)));
      if (fresh.length > 0 || attempt === MAX_SETTLE_READS - 1) break;
      await ctx.sleep(SETTLE_MS);
    }
    items = fresh;
    known = new Set(openItems(elements, bar).map(keyOf));
  }
  return { ok: true, elements, items, keys: known };
}

// The window the menu bar is in: the parentless menu items that expand, on one line.
export async function hasWindowsMenuBar(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): Promise<boolean> {
  const elements = await read({ actuator, target, signal, sleep: realSleep });
  return !!elements && barFrom(elements) !== null;
}

const FILE_NAME = /\.[A-Za-z0-9]{1,5}$/;

export async function enumerateWindowsMenus(actuator: Actuator, target: MenuTarget, options: MenuScanOptions = {}): Promise<MenuScan> {
  const maxDepth = options.maxDepth ?? 3;
  const maxItems = options.maxItemsPerLevel ?? 80;
  const maxNodes = options.maxNodes ?? 900;
  const ctx: Context = { actuator, target, signal: options.signal, sleep: options.sleep ?? realSleep };
  const skipped: string[] = [];
  const stopped = (): boolean => options.signal?.aborted === true || options.shouldStop?.() === true;
  let reads = 0;
  if (stopped()) return { nodes: [], reads, truncated: true, skipped };
  let first = await read(ctx);
  reads += 1;
  if (!first) return { nodes: [], reads, truncated: false, skipped: ["menu bar (unreadable)"] };
  let bar = barFrom(first);
  if (!bar) return { nodes: [], reads, truncated: false, skipped: ["menu bar (absent)"] };
  // A menu that is already open is not at rest: it is closed first (the bar found in an open state is only its menu bar items, which is the same set)
  if (openItems(first, bar).length > 0) {
    if (!(await closeAll(ctx, bar))) return { nodes: [], reads, truncated: true, skipped: ["menu bar (a menu is open)"], stuck: true };
    first = (await read(ctx)) ?? first;
    bar = barFrom(first) ?? bar;
  }
  const windows = await actuator.listWindows({ pid: target.pid }, { signal: options.signal }).catch(() => []);
  const titles = windows.map((window) => window.title.trim()).filter((title) => title.length >= 3);
  const namedAfterWindow = (label: string): boolean => titles.some((title) => title === label || title.startsWith(`${label} - `) || title.endsWith(` - ${label}`));
  const keep = (entries: readonly ElementRecord[]): ElementRecord[] => entries
    .filter((entry) => cleanWindowsLabel(entry.label) !== "" && !FILE_NAME.test(cleanWindowsLabel(entry.label)) && !namedAfterWindow(cleanWindowsLabel(entry.label)))
    .slice(0, maxItems);

  const nodes: MenuNode[] = [];
  let truncated = false;
  let counted = 0;
  let stuck = false;
  let topIndex = 0;
  const barEntries = menuItemsOf(first).filter((element) => bar!.keys.has(keyOf(element)));
  for (const top of barEntries) {
    if (stopped() || counted >= maxNodes) { truncated = true; break; }
    const label = cleanWindowsLabel(top.label);
    if (!label) continue;
    const here = topIndex;
    topIndex += 1;
    if (isPersonalMenu(label, 0, here)) { skipped.push(label); continue; }
    if (top.enabled === false) { nodes.push({ label, path: [label], leaf: false, enabled: false, children: [] }); continue; }
    const opened = await openChain(ctx, bar, [label]);
    reads += 3;
    if (!opened.ok) {
      skipped.push(`${label} (${opened.code})`);
      if (!(await closeAll(ctx, bar))) { stuck = true; break; }
      continue;
    }
    const entries = keep(opened.items);
    if (opened.items.length > maxItems) truncated = true;
    const closed = await closeAll(ctx, bar);
    if (!closed) { stuck = true; break; }
    const children: MenuNode[] = [];
    for (const entry of entries) {
      const entryLabel = cleanWindowsLabel(entry.label);
      if (stopped() || counted >= maxNodes) { truncated = true; break; }
      if (isPersonalMenu(entryLabel, 1, children.length)) { skipped.push(`${label} > ${entryLabel}`); continue; }
      counted += 1;
      let below: MenuNode[] = [];
      if (expandable(entry)) {
        if (maxDepth <= 2) truncated = true; // a submenu below the depth limit is not read
        else if (entry.enabled !== false) {
          const sub = await openChain(ctx, bar, [label, entryLabel]);
          reads += 4;
          if (sub.ok) {
            const items = keep(sub.items);
            if (items.some(expandable)) truncated = true; // a submenu below the depth limit is not read
            below = items.map((item) => ({ label: cleanWindowsLabel(item.label), path: [label, entryLabel, cleanWindowsLabel(item.label)], leaf: !expandable(item), enabled: item.enabled !== false, children: [] }));
            counted += below.length;
          } else skipped.push(`${label} > ${entryLabel} (${sub.code})`);
          if (!(await closeAll(ctx, bar))) stuck = true;
        }
      }
      children.push({ label: entryLabel, path: [label, entryLabel], leaf: !expandable(entry), enabled: entry.enabled !== false, children: below });
      if (stuck) break;
    }
    nodes.push({ label, path: [label], leaf: false, enabled: true, children });
    if (stuck) break;
  }
  if (stuck) skipped.push("menu bar (a menu would not close)");
  return { nodes, reads, truncated: truncated || stuck, skipped, ...(stuck ? { stuck: true } : {}) };
}

export async function resolveWindowsMenuPath(actuator: Actuator, target: MenuTarget, path: readonly string[], signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<MenuPathState> {
  const ctx: Context = { actuator, target, signal, sleep: sleep ?? realSleep };
  const start = await read(ctx);
  if (!start) return { status: "unreadable", code: "unreadable" };
  const bar = barFrom(start);
  if (!bar) return { status: "unreadable", code: "absent" };
  const topEntries = menuItemsOf(start).filter((element) => bar.keys.has(keyOf(element)) && sameLabel(cleanWindowsLabel(element.label), cleanWindowsLabel(path[0])));
  if (topEntries.length === 0) return { status: "missing" };
  if (topEntries.length > 1) return { status: "ambiguous" };
  if (path.length === 1) return { status: "ok", enabled: topEntries[0].enabled !== false };
  try {
    const chain = path.slice(0, -1);
    const opened = await openChain(ctx, bar, chain);
    if (!opened.ok) {
      if (opened.code === "missing" || opened.code === "not_a_submenu") return { status: opened.code };
      return { status: "unreadable", code: opened.code };
    }
    const found = opened.items.filter((entry) => sameLabel(cleanWindowsLabel(entry.label), cleanWindowsLabel(path[path.length - 1])));
    if (found.length === 0) return { status: "missing" };
    if (found.length > 1) return { status: "ambiguous" };
    return { status: "ok", enabled: found[0].enabled !== false };
  } finally {
    // Whatever happened, no menu is left open.
    await closeAll(ctx, bar).catch(() => false);
  }
}

// Presses the item at the end of the path the way a user would: the top menu is expanded, the submenus on the way and the item itself are pressed by
// their element token with the app in front. Only the caller decides which path (a command's path is only ever sent after resolveWindowsMenuPath).
export async function invokeWindowsMenuPath(actuator: Actuator, target: MenuTarget, path: readonly string[], signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<ToolOutcome> {
  const ctx: Context = { actuator, target, signal, sleep: sleep ?? realSleep };
  const fail = (code: string, text: string): ToolOutcome => ({ ok: false, text, refusalCode: code });
  const start = await read(ctx);
  if (!start) return fail("unreadable", "the window could not be read");
  const bar = barFrom(start);
  if (!bar) return fail("menu_path_unavailable", "this window has no menu bar");
  if (path.length === 0) return fail("menu_path_unavailable", "no path");
  const opened = await openChain(ctx, bar, path.length === 1 ? [path[0]] : path.slice(0, -1));
  if (!opened.ok) { await closeAll(ctx, bar).catch(() => false); return fail(opened.code === "missing" || opened.code === "not_a_submenu" ? "menu_path_unavailable" : opened.code, `menu path could not be opened (${opened.code})`); }
  if (path.length === 1) return { ok: true, text: "the top menu is open" };
  const leaf = opened.items.filter((entry) => sameLabel(cleanWindowsLabel(entry.label), cleanWindowsLabel(path[path.length - 1])));
  if (leaf.length !== 1 || !leaf[0].element_token) { await closeAll(ctx, bar).catch(() => false); return fail("menu_path_unavailable", leaf.length > 1 ? "the last item is ambiguous" : "the last item was not found"); }
  if (leaf[0].enabled === false) { await closeAll(ctx, bar).catch(() => false); return fail("menu_item_disabled", "the item is switched off"); }
  const pressed = await actuator.call("click", { pid: target.pid, window_id: target.windowId, element_token: leaf[0].element_token, delivery_mode: "foreground" }, { signal, timeoutMs: 15_000 });
  if (!pressed.ok) { await closeAll(ctx, bar).catch(() => false); return pressed; }
  return { ok: true, text: "pressed", ...(pressed.structured ? { structured: pressed.structured } : {}) };
}
