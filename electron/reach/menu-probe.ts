import type { Actuator, ToolOutcome } from "./actuator";
import { enumerateLinuxMenus, hasLinuxMenuBar, resolveLinuxMenuPath } from "./linux-ui";
import { enumerateWindowsMenus, hasWindowsMenuBar, invokeWindowsMenuPath, resolveWindowsMenuPath } from "./windows-ui";
import { isDirectMenuCommandPath, startsWithPath, systemInsertedPrefixes } from "./explore-policy";
import { isPersonalMenu, sameLabel } from "./menu-text";
import { MENU_COMMAND_TRAIT, type Capability } from "./types";

export { isPersonalMenu };

// Reads an app's menu bar without pressing anything. The window's accessibility tree carries the whole menu bar (menu bar items, their
// menus, the items and the submenus below them), so the menus are read from that tree in one call and nothing is ever invoked.
//
// This replaced an earlier scheme that asked `invoke_menu` for a path that cannot exist and read the items out of the refusal. Measured on
// System Information (2026-10-23, real driver) that was NOT read-only: to look below an item the driver presses it on the way, an item
// that has no submenu is then executed, and probing under "Quit" quit the app. Nothing here sends `invoke_menu` at all.

export interface MenuTarget { pid: number; windowId: number }

export interface MenuNode {
  label: string;
  path: string[];
  leaf: boolean;
  // false while the app has the item switched off (Save with no document); it can be pressed again later, so it stays on the map
  enabled: boolean;
  children: MenuNode[];
}

export interface MenuScan {
  nodes: MenuNode[];
  // accessibility reads made (one per scan)
  reads: number;
  truncated: boolean;
  skipped: string[];
  // true when a menu could not be closed again: the app is not at rest and nothing else may be pressed in it
  stuck?: boolean;
}

export interface MenuScanOptions {
  maxDepth?: number;
  maxItemsPerLevel?: number;
  maxNodes?: number;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const MENU_TREE_MAX_ELEMENTS = 3000;

interface TreeElement { element_index: number; parent_index?: number; role?: string; label?: string; enabled?: boolean }

interface MenuBar {
  bar: TreeElement;
  kids: (element: TreeElement, role: string) => TreeElement[];
  itemsOf: (owner: TreeElement) => TreeElement[];
  truncated: boolean;
}

// One read of the window's tree, scoped to the menu bar. "AXMenu" matches the menu bar, its items, the menus and their items; the driver
// returns those rows plus their ancestors. Nothing is pressed.
async function readMenuBar(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): Promise<{ ok: true; menu: MenuBar } | { ok: false; code: string }> {
  const state = await actuator.call("get_window_state", {
    pid: target.pid, window_id: target.windowId, include_screenshot: false, tree_format: "elements", query: "AXMenu", max_elements: MENU_TREE_MAX_ELEMENTS, timeout_ms: 10_000,
  }, { signal, timeoutMs: 40_000 });
  const rows = state.structured?.elements;
  if (!state.ok || !Array.isArray(rows)) return { ok: false, code: state.errorCode ?? state.refusalCode ?? "unreadable" };
  const elements = rows as TreeElement[];
  const childrenOf = new Map<number, TreeElement[]>();
  for (const element of elements) {
    if (element.parent_index === undefined) continue;
    const list = childrenOf.get(element.parent_index) ?? [];
    list.push(element);
    childrenOf.set(element.parent_index, list);
  }
  const kids = (element: TreeElement, role: string): TreeElement[] => (childrenOf.get(element.element_index) ?? []).filter((child) => child.role === role);
  const bar = elements.find((element) => element.role === "AXMenuBar");
  if (!bar) return { ok: false, code: "absent" };
  return {
    ok: true,
    menu: {
      bar, kids,
      itemsOf: (owner) => kids(owner, "AXMenu").flatMap((menu) => kids(menu, "AXMenuItem")),
      // A tree the driver cut short is a smaller map, never a wrong one: say so.
      truncated: elements.length >= MENU_TREE_MAX_ELEMENTS || state.structured?.truncated === true || /PARTIAL TREE|Tree truncated/i.test(state.text ?? ""),
    },
  };
}

export type SystemMenuProof = { ok: true; prefixes: string[][] } | { ok: false; code: string };

// Safety evidence is independent of the exploration map's depth/item/node budgets. The raw driver tree retains ALL top-level
// siblings and whether each owns a submenu; clipping a menu at 80 must never turn a system tail into an app-owned dialog.
// Only macOS injects this shape. Other platforms keep their existing menu navigation and need no extra driver read here.
export async function readSystemMenuProof(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): Promise<SystemMenuProof> {
  if (signal?.aborted) return { ok: false, code: "aborted" };
  if (actuator.platform === "linux" || actuator.platform === "win32") return { ok: true, prefixes: [] };
  try {
    const read = await readMenuBar(actuator, target, signal);
    if (!read.ok) return { ok: false, code: read.code };
    if (read.menu.truncated) return { ok: false, code: "menu_tree_truncated" };
    const { menu } = read;
    const tops = menu.kids(menu.bar, "AXMenuBarItem");
    if (tops.length === 0 || tops.some((top) => typeof top.label !== "string" || !top.label.trim())) return { ok: false, code: "menu_tree_unreadable" };
    const nodes = tops.map((top): MenuNode => {
      const path = [(top.label ?? "").trim()];
      const children = menu.itemsOf(top).filter((item) => (item.label ?? "").trim()).map((item): MenuNode => {
        const label = (item.label ?? "").trim();
        const childPath = [...path, label];
        const hasSubmenu = menu.kids(item, "AXMenu").length > 0;
        // The tail rule inspects submenu presence, not its captions or depth. A structural placeholder preserves that fact.
        return { label, path: childPath, leaf: !hasSubmenu, enabled: item.enabled !== false,
          children: hasSubmenu ? [{ label: "", path: childPath, leaf: true, enabled: true, children: [] }] : [] };
      });
      return { label: path[0], path, leaf: children.length === 0, enabled: top.enabled !== false, children };
    });
    return { ok: true, prefixes: systemInsertedPrefixes(nodes, "darwin") };
  } catch {
    return { ok: false, code: "menu_tree_unreadable" };
  }
}

export async function enumerateMenus(actuator: Actuator, target: MenuTarget, options: MenuScanOptions = {}): Promise<MenuScan> {
  if (actuator.platform === "linux") return enumerateLinuxMenus(actuator, target, options);
  if (actuator.platform === "win32") return enumerateWindowsMenus(actuator, target, options);
  const maxDepth = options.maxDepth ?? 3;
  const maxItems = options.maxItemsPerLevel ?? 80;
  const maxNodes = options.maxNodes ?? 900;
  const skipped: string[] = [];
  const stopped = (): boolean => options.signal?.aborted === true || options.shouldStop?.() === true;
  if (stopped()) return { nodes: [], reads: 0, truncated: true, skipped };
  const read = await readMenuBar(actuator, target, options.signal);
  if (!read.ok) {
    skipped.push(`menu bar (${read.code})`);
    return { nodes: [], reads: 1, truncated: false, skipped };
  }
  const { menu } = read;
  let truncated = menu.truncated;
  let counted = 0;
  const build = (entries: TreeElement[], parentPath: string[], depth: number): MenuNode[] => {
    const nodes: MenuNode[] = [];
    let index = 0;
    let taken = 0;
    for (const entry of entries) {
      const label = (entry.label ?? "").trim();
      if (!label) continue; // separators
      if (taken >= maxItems) { truncated = true; break; }
      if (stopped() || counted >= maxNodes) { truncated = true; break; }
      const path = [...parentPath, label];
      const here = index;
      index += 1;
      if (isPersonalMenu(label, depth, here)) { skipped.push(path.join(" > ")); continue; }
      taken += 1;
      counted += 1;
      const submenu = menu.itemsOf(entry);
      const children = submenu.length > 0 && depth + 1 < maxDepth ? build(submenu, path, depth + 1) : [];
      if (submenu.length > 0 && depth + 1 >= maxDepth) truncated = true; // a submenu below the depth limit is not read
      nodes.push({ label, path, leaf: submenu.length === 0, enabled: entry.enabled !== false, children });
    }
    return nodes;
  };
  const nodes = build(menu.kids(menu.bar, "AXMenuBarItem"), [], 0);
  return { nodes, reads: 1, truncated, skipped };
}

// The window that carries the app's menu bar. Not every window does: System Information's About window, for one, has none, and the
// first window the driver lists is not always the main one. Titled windows first, each tried by reading its tree.
export async function findMenuWindow(actuator: Actuator, pid: number, signal?: AbortSignal): Promise<MenuTarget | null> {
  if (!(pid > 0)) return null;
  const windows = (await actuator.listWindows({ pid }, { signal })).filter((window) => window.layer === 0 && window.onScreen);
  const ordered = [...windows.filter((window) => window.title.trim()), ...windows.filter((window) => !window.title.trim())];
  for (const window of ordered.slice(0, 6)) {
    const target = { pid, windowId: window.windowId };
    const found = actuator.platform === "linux" ? await hasLinuxMenuBar(actuator, target, signal)
      : actuator.platform === "win32" ? await hasWindowsMenuBar(actuator, target, signal)
      : (await readMenuBar(actuator, target, signal)).ok;
    if (found) return target;
  }
  return null;
}

export type MenuPathState =
  | { status: "ok"; enabled: boolean }
  | { status: "missing" | "ambiguous" | "not_a_submenu" | "unreadable"; code?: string };

// The driver presses every item along a path it is given, and an item without a submenu is executed by that press. So a stored path is
// only handed to `invoke_menu` after the live menu tree shows that every item before the last one has a submenu and the last one is there.
export async function resolveMenuPath(actuator: Actuator, target: MenuTarget, path: readonly string[], signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<MenuPathState> {
  if (path.length === 0) return { status: "missing" };
  if (actuator.platform === "linux") return resolveLinuxMenuPath(actuator, target, path, signal, sleep);
  if (actuator.platform === "win32") return resolveWindowsMenuPath(actuator, target, path, signal, sleep);
  const read = await readMenuBar(actuator, target, signal);
  if (!read.ok) return { status: "unreadable", code: read.code };
  const { menu } = read;
  let entries = menu.kids(menu.bar, "AXMenuBarItem");
  for (let depth = 0; depth < path.length; depth += 1) {
    const found = entries.filter((entry) => sameLabel(entry.label ?? "", path[depth]));
    if (found.length === 0) return { status: "missing" };
    if (found.length > 1) return { status: "ambiguous" };
    const entry = found[0];
    if (depth === path.length - 1) return { status: "ok", enabled: entry.enabled !== false };
    entries = menu.itemsOf(entry);
    if (entries.length === 0) return { status: "not_a_submenu" };
  }
  return { status: "missing" };
}

// Presses the item at the end of a path the live menu has confirmed (resolveMenuPath). macOS and Linux hand the path to the driver's invoke_menu; on
// Windows the driver cannot find items inside a classic popup menu, so the path is walked and pressed as a user would (windows-ui.ts).
export async function invokeMenuPath(actuator: Actuator, target: MenuTarget, path: readonly string[], signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<ToolOutcome> {
  if (actuator.platform === "win32") return invokeWindowsMenuPath(actuator, target, path, signal, sleep);
  return actuator.call("invoke_menu", { pid: target.pid, window_id: target.windowId, path: [...path] }, { signal, timeoutMs: 15_000 });
}

export function menuLeaves(nodes: readonly MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  const visit = (node: MenuNode): void => {
    if (node.leaf) out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

export function opensDialog(label: string): boolean {
  return label.endsWith("…") || label.endsWith("...");
}

// Structure-tier capabilities: "this menu command exists". Reading the menu bar presses nothing. An item that opens a dialog stays a candidate until
// the explorer has opened and read that dialog. A plain command (no ellipsis, a name that does no harm) is also carried out by pressing it: the body
// is the one step the runner already checks live (the path must be in the menu now and switched on), so it is usable at once - see isDirectMenuCommand.
export function menuCapabilities(appKey: string, nodes: readonly MenuNode[], platform: string = "darwin", options: { sensors?: boolean; systemPrefixes?: readonly (readonly string[])[] } = {}): Capability[] {
  const system = options.systemPrefixes ?? systemInsertedPrefixes(nodes, platform);
  return menuLeaves(nodes).map((leaf) => {
    const dialog = opensDialog(leaf.label);
    const direct = !dialog && isDirectMenuCommandPath(leaf.path, options) && !system.some((prefix) => startsWithPath(leaf.path, prefix));
    return {
      id: `${appKey}#structure:menu/${leaf.path.join(">")}`,
      tier: "structure" as const,
      source: { kind: "menu", ref: leaf.path.join(" > ") },
      name: leaf.path.join(" > "),
      suite: leaf.path[0],
      kind: "command" as const,
      granularity: "operation" as const,
      ...(dialog ? { traits: ["opens-dialog"] } : direct ? { traits: [MENU_COMMAND_TRAIT] } : {}),
      ...(direct ? { description: "Presses this item of the app's menu bar. What it does to the app is not known in advance; the call checks that the item is in the menu and switched on.", body: { kind: "steps" as const, steps: [{ tool: "invoke_menu", args: { path: [...leaf.path] } }] } } : {}),
      parameters: [],
      effect: { class: "unknown" as const, basis: "unverified" as const },
      status: "candidate" as const,
    };
  });
}
