import type { Actuator } from "./actuator";
import { DIALOG_CONTROL_ROLES, isRiskyMenuPath } from "./explore-policy";
import { normalizeLinuxTree, popupIdsOf, withoutChrome } from "./linux-ui";
import { normalizeWindowsTree } from "./windows-ui";
import { invokeMenuPath, resolveMenuPath, type MenuTarget } from "./menu-probe";
import type { Capability, CapabilityParameter } from "./types";

// Opens ONE dialog from a menu item that ends in an ellipsis, reads the shape of its controls, and closes it again with its Cancel
// button. The platform convention (an ellipsis means "asks for more before it acts") is what makes opening safe; the round trip is what
// makes the result evidence: the entry point worked and left nothing behind. Nothing is typed, no default button is pressed, and no
// control VALUE is ever read into anything kept (values are the owner's data: a file name in a Save panel, a printer name).
//
// Measured 2026-10-23 on System Information (real Cua Driver 0.38.0):
//  - a menu item that macOS keeps disabled while the app is behind another window is refused; the app has to be brought to the front
//    first, so exploration is only ever done while the owner is away, and the previous front app is restored afterwards;
//  - a sheet shows up inside the window's tree as an AXSheet AND as an extra, untitled window;
//  - the Escape key does not reach a sheet that is not the key window; pressing the sheet's Cancel button (AXPress) does.

export interface ElementRecord {
  element_index: number;
  parent_index?: number;
  depth?: number;
  role?: string;
  label?: string | null;
  value?: string | null;
  enabled?: boolean | null;
  actions?: string[];
  element_token?: string;
  // Linux (AT-SPI) only: a check/radio state, the app's tooltip, and where the element is on screen
  selected?: boolean;
  description?: string;
  frame?: { x: number; y: number; w: number; h: number };
}

export type ControlKind = "text" | "flag" | "choice" | "number" | "option";

export interface DialogControl {
  kind: ControlKind;
  role: string;
  label?: string;
  nth: number;
  enabled: boolean;
  // for a group of radio buttons: the captions of the group (static text, not data)
  options?: string[];
}

export interface DialogButton { label: string; role: string; nth: number }

export interface DialogShape {
  controls: DialogControl[];
  buttons: DialogButton[];
  cancel?: { label: string };
  truncated: boolean;
  // A window of its own with no Cancel button (Settings, Preferences): what is set in it applies at once. Only its value controls are described, no button.
  immediate?: true;
}

const CANCEL_WORDS = /^(cancel|abbrechen|annuler|cancelar|annulla|キャンセル|取消|取消し|취소|отмена)$/i;
const HELP_WORDS = /^(help|hilfe|aide|ayuda|aiuto|ヘルプ|帮助|도움말|справка|\?)$/i;

export function cleanLabel(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > 60) return undefined;
  // Internal identifiers the toolkit uses as a stand-in caption (_NS:13) say nothing to a person.
  if (/^_[A-Za-z]+:\d+$/.test(text)) return undefined;
  // Anything that reads like data rather than a caption: addresses, paths, long digit runs.
  if (/@|[\\/]|\d{6,}/.test(text)) return undefined;
  // A PascalCase identifier (ScalingStepper, PDPrintPanel) is a widget name, not a caption.
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(text) || /^[A-Z]{2,}[a-z]+[A-Za-z]*$/.test(text)) return undefined;
  return text;
}

export function isCancelButton(label: string | undefined): boolean {
  return !!label && CANCEL_WORDS.test(label.trim());
}

// Pure: elements of one dialog (the AXSheet subtree, or the whole tree of a separate panel window) -> its shape.
export function analyzeDialog(elements: readonly ElementRecord[], rootIndex?: number): DialogShape {
  const byIndex = new Map(elements.map((element) => [element.element_index, element]));
  const inside = (element: ElementRecord): boolean => {
    if (rootIndex === undefined) return true;
    let cursor: ElementRecord | undefined = element;
    for (let hops = 0; cursor && hops < 64; hops += 1) {
      if (cursor.element_index === rootIndex) return true;
      cursor = cursor.parent_index === undefined ? undefined : byIndex.get(cursor.parent_index);
    }
    return false;
  };
  const scope = elements.filter(inside).filter((element) => element.element_index !== rootIndex);
  const controls: DialogControl[] = [];
  const buttons: DialogButton[] = [];
  const nthByKey = new Map<string, number>();
  const nextNth = (role: string, label: string | undefined): number => {
    const key = `${role}|${label ?? ""}`;
    const n = nthByKey.get(key) ?? 0;
    nthByKey.set(key, n + 1);
    return n;
  };
  // Radio buttons that follow one another under one parent are one group; any other control in between starts a new one.
  const radioGroups: string[][] = [];
  let openGroup: { parent: number; options: string[] } | null = null;
  let cancel: { label: string } | undefined;
  for (const element of scope) {
    const role = element.role ?? "";
    if (!DIALOG_CONTROL_ROLES.has(role)) continue;
    if (role !== "AXRadioButton") openGroup = null;
    const secret = role === "AXSecureTextField";
    const rawLabel = cleanLabel(element.label);
    // A caption that is the same as the current value is the toolkit's fallback, not a caption (and may be the owner's data).
    const valueText = typeof element.value === "string" ? element.value.replace(/\s+/g, " ").trim() : undefined;
    const unlabeled = rawLabel === undefined || (valueText === rawLabel && role !== "AXRadioButton" && role !== "AXCheckBox" && role !== "AXButton");
    const label = unlabeled ? undefined : rawLabel;
    const enabled = element.enabled !== false;
    if (role === "AXButton" || role === "AXMenuButton") {
      if (!label) continue;
      if (isCancelButton(label)) { cancel = { label }; continue; }
      if (HELP_WORDS.test(label)) continue;
      buttons.push({ label, role, nth: nextNth(role, label) });
      continue;
    }
    if (secret) continue; // a secure field is never described, let alone filled
    if (role === "AXRadioButton") {
      const parent = element.parent_index ?? -1;
      if (!openGroup || openGroup.parent !== parent) {
        openGroup = { parent, options: [] };
        radioGroups.push(openGroup.options);
      }
      if (label) openGroup.options.push(label);
      continue;
    }
    const kind: ControlKind = role === "AXCheckBox" || role === "AXSwitch" ? "flag"
      : role === "AXPopUpButton" || role === "AXSegmentedControl" ? "choice"
      : role === "AXSlider" || role === "AXIncrementor" || role === "AXStepper" ? "number"
      : "text";
    controls.push({ kind, role, ...(label ? { label } : {}), nth: nextNth(role, label), enabled });
  }
  // An incrementor is the pair of arrows next to the text field that shows its value: keep the field, drop the arrows.
  const textLabels = new Set(controls.filter((control) => control.kind === "text" && control.label).map((control) => control.label));
  for (let i = controls.length - 1; i >= 0; i -= 1) {
    const control = controls[i];
    if (control.kind === "number" && control.label && textLabels.has(control.label)) controls.splice(i, 1);
  }
  for (const options of radioGroups) {
    if (options.length > 0) controls.push({ kind: "option", role: "AXRadioButton", nth: 0, enabled: true, options: [...options] });
  }
  return { controls, buttons, ...(cancel ? { cancel } : {}), truncated: false };
}

function parameterName(kind: ControlKind, counts: Map<ControlKind, number>): string {
  const n = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, n);
  return `${kind}_${n}`;
}

const MAX_IMMEDIATE_CONTROLS = 24;

// A window with no Cancel button applies what is set in it at once. Exploring only READS such a window and closes it with the window-close key, so it can
// be described: what its value controls are called is all that is kept. Its buttons are left out (each one applies at once: Reset, Delete, Sign out), a
// control without a caption is left out (a caller could not tell what it sets), and so is a control whose caption is risky (passwords, payment, accounts,
// messages, trash and deletion ...): it is never described, so it can never be set through Reach. A window with nothing left is not described.
export function immediateShape(shape: DialogShape): DialogShape | null {
  const controls = shape.controls
    .filter((control) => (control.kind === "option" ? (control.options ?? []).length > 0 : !!control.label))
    .filter((control) => !isRiskyMenuPath([...(control.label ? [control.label] : []), ...(control.options ?? [])]));
  if (controls.length === 0) return null;
  return { controls: controls.slice(0, MAX_IMMEDIATE_CONTROLS), buttons: [], truncated: controls.length > MAX_IMMEDIATE_CONTROLS, immediate: true };
}

// Pure: a verified dialog shape -> a typed, callable capability. Parameter names are positional (text_1, choice_2 ...) with the dialog's own
// caption as the description, because captions are in the owner's language and cannot be turned into identifiers reliably.
export function synthesizeDialogCapability(appKey: string, menuPath: readonly string[], shape: DialogShape, fingerprint: string, day: string, platform?: string): Capability {
  const counts = new Map<ControlKind, number>();
  const parameters: CapabilityParameter[] = [];
  const steps: Array<{ tool: string; args: Record<string, unknown> }> = [{ tool: "invoke_menu", args: { path: [...menuPath] } }];
  for (const control of shape.controls) {
    if (!control.enabled) continue;
    const name = parameterName(control.kind, counts);
    const type = control.kind === "flag" ? "boolean" : control.kind === "number" ? "number" : control.kind === "option" ? `enum:${(control.options ?? []).join("|")}` : "string";
    parameters.push({ name, type, required: false, ...(control.label ? { description: control.label } : {}) });
    if (control.kind === "option") {
      steps.push({ tool: "click", args: { target: { role: control.role, label: "${" + name + "}", nth: 0 }, when: name } });
    } else {
      steps.push({ tool: "set_value", args: { target: { role: control.role, ...(control.label ? { label: control.label } : {}), nth: control.nth }, value: "${" + name + "}", when: name } });
    }
  }
  const actions = shape.buttons.map((button) => button.label);
  if (shape.immediate) {
    // Nothing to press: what was set has applied. The window is closed the platform's way (the key that only closes it), aimed at the window.
    steps.push((platform ?? "darwin") === "darwin" ? { tool: "hotkey", args: { keys: ["cmd", "w"] } } : { tool: "press_key", args: { key: "escape" } });
  } else if (actions.length > 0) {
    parameters.push({ name: "action", type: `enum:${actions.join("|")}`, required: true, description: "which button of the dialog to press" });
    steps.push({ tool: "click", args: { target: { role: "AXButton", label: "${action}", nth: 0 } } });
  } else if (shape.cancel) {
    steps.push({ tool: "click", args: { target: { role: "AXButton", label: shape.cancel.label, nth: 0 } } });
  }
  return {
    id: `${appKey}#explored:dialog/${menuPath.join(">")}`,
    tier: "explored",
    source: { kind: "dialog-probe", ref: menuPath.join(" > ") },
    name: menuPath.join(" > "),
    suite: menuPath[0],
    kind: "command",
    granularity: "operation",
    traits: shape.immediate ? ["opens-dialog", "applies-immediately"] : ["opens-dialog"],
    ...(shape.immediate ? { description: "A settings window with no Cancel button: every value given here is applied as soon as it is set." } : {}),
    status: "verified",
    verification: "structural",
    body: { kind: "steps", steps },
    postconditions: [{ kind: "dialog-closed" }],
    parameters,
    // The dialog's own buttons decide what happens, and which one is pressed is the caller's choice: never classed beyond "unknown". A window with no
    // Cancel button has no such choice: what is given is applied, so it is a write.
    effect: shape.immediate ? { class: "write", basis: "structural" } : { class: "unknown", basis: "unverified" },
    boundFingerprint: fingerprint,
    evidence: { observations: 1, firstSeenDay: day, lastSeenDay: day },
  };
}

export type ProbeStatus = "ok" | "refused" | "no-dialog" | "stuck" | "unsafe" | "error";

export interface ProbeResult {
  status: ProbeStatus;
  code?: string;
  shape?: DialogShape;
  ms: number;
}

export interface ProbePorts {
  actuator: Actuator;
  target: MenuTarget;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  settleMs?: number;
  pollMs?: number;
}

// `windows` also carries each window's owner: on Windows a dialog does not have to belong to the app that opened it (the modern Print dialog is the
// shell's), so the windows of the whole desktop are watched there, and the owner says whose window a new one is.
export interface WindowFacts { windowIds: number[]; windows?: Array<{ id: number; pid: number; z?: number }>; sheet?: { index: number; elements: ElementRecord[] } }

// The window a probe or a run just caused: the one that is new, and whose it is. null: more than one foreign window appeared at once, so which one
// is ours cannot be told and nothing may be pressed in either.
export function newPanel(before: WindowFacts, after: WindowFacts, targetPid: number, platform?: string, ownerPid?: number): { id: number; pid: number } | "ambiguous" | undefined {
  if (platform !== "win32") {
    const id = after.windowIds.filter((candidate) => !before.windowIds.includes(candidate))[0];
    return id === undefined ? undefined : { id, pid: targetPid };
  }
  const added = (after.windows ?? []).filter((window) => !before.windowIds.includes(window.id));
  if (added.length === 0) return undefined;
  // Several windows of the app at once (a dialog and the message box it raised): the one on top is the one to deal with first.
  const own = added.filter((window) => window.pid === targetPid || (ownerPid !== undefined && window.pid === ownerPid)).sort((a, b) => (b.z ?? -1) - (a.z ?? -1) || a.id - b.id);
  if (own.length > 0) return own[0];
  // Once the dialog's owner is known, a window of anyone else that comes up later is a stranger's, never the dialog.
  if (ownerPid !== undefined) return undefined;
  return added.length === 1 ? added[0] : "ambiguous";
}

// The windows that count when a dialog is judged closed: the app's own, and the owner of the dialog it opened.
export const scopedIds = (facts: WindowFacts, pids: ReadonlyArray<number | undefined>): number[] =>
  (facts.windows ?? []).filter((window) => pids.includes(window.pid)).map((window) => window.id).sort((a, b) => a - b);

// The driver reads a window's tree within a time budget (1 s unless told otherwise) and says so in its text when it ran out: a panel with
// a long file list then loses the buttons at its end, Cancel included. Every read states its own budget and reports a cut tree as such.
export async function readTree(actuator: Actuator, target: MenuTarget, signal?: AbortSignal, budgetMs = 5000): Promise<{ elements: ElementRecord[]; partial: boolean; popupIds?: number[] } | null> {
  const state = await actuator.call("get_window_state", { pid: target.pid, window_id: target.windowId, include_screenshot: false, tree_format: "elements", max_elements: 2000, timeout_ms: budgetMs }, { signal, timeoutMs: budgetMs + 15_000 });
  const elements = state.structured?.elements;
  if (!state.ok || !Array.isArray(elements)) return null;
  // Linux names its roles its own way; everything below speaks the macOS role names.
  const records = actuator.platform === "linux" ? normalizeLinuxTree(elements as ElementRecord[])
    : actuator.platform === "win32" ? normalizeWindowsTree(elements as ElementRecord[])
    : (elements as ElementRecord[]);
  return { elements: records, partial: /PARTIAL TREE/.test(state.text ?? ""), ...(actuator.platform === "linux" ? { popupIds: popupIdsOf(state.structured) } : {}) };
}

// The elements of a dialog that is a window of its own. On Linux that window's tree also carries the main window's menu bar and tool bar
// (measured), so what belongs to the dialog is what is left once the main window's elements are taken away.
export async function readDialogTree(actuator: Actuator, dialog: MenuTarget, main: MenuTarget, signal?: AbortSignal, budgetMs = 5000): Promise<{ elements: ElementRecord[]; partial: boolean } | null> {
  const tree = await readTree(actuator, dialog, signal, budgetMs);
  if (!tree || actuator.platform !== "linux" || dialog.windowId === main.windowId) return tree;
  const chrome = await readTree(actuator, main, signal, budgetMs);
  return chrome ? { elements: withoutChrome(tree.elements, chrome.elements), partial: tree.partial || chrome.partial } : null;
}

export async function readElements(actuator: Actuator, target: MenuTarget, signal?: AbortSignal, budgetMs = 5000): Promise<ElementRecord[] | null> {
  return (await readTree(actuator, target, signal, budgetMs))?.elements ?? null;
}

// A dialog that shows the owner's own things - the files of an Open or Save panel, a list of contacts, a table of records - is never
// described: the names in it would become captions. Plain controls (fields, boxes, pop-ups, buttons) are what a dialog is made of;
// rows, outlines, tables and browsers are content.
const CONTENT_CONTAINERS = new Set(["AXOutline", "AXTable", "AXBrowser", "AXList", "AXCollection", "AXGrid"]);
export function listsContent(elements: readonly ElementRecord[], rootIndex?: number): boolean {
  const byIndex = new Map(elements.map((element) => [element.element_index, element]));
  const inside = (element: ElementRecord): boolean => {
    if (rootIndex === undefined) return true;
    let cursor: ElementRecord | undefined = element;
    for (let hops = 0; cursor && hops < 64; hops += 1) {
      if (cursor.element_index === rootIndex) return true;
      cursor = cursor.parent_index === undefined ? undefined : byIndex.get(cursor.parent_index);
    }
    return false;
  };
  let rows = 0;
  for (const element of elements) {
    if (!inside(element)) continue;
    const role = element.role ?? "";
    if (CONTENT_CONTAINERS.has(role)) return true;
    if (role === "AXRow") rows += 1;
  }
  return rows >= 2;
}

export async function observe(ports: ProbePorts): Promise<WindowFacts> {
  const desktop = ports.actuator.platform === "win32";
  const windows = (await ports.actuator.listWindows(desktop ? {} : { pid: ports.target.pid }, { signal: ports.signal })).filter((w) => !desktop || w.layer === 0);
  const tree = await readTree(ports.actuator, ports.target, ports.signal, 2000);
  const elements = tree?.elements ?? null;
  const sheet = elements?.find((element) => element.role === "AXSheet");
  // Popups (a tooltip under the pointer, an open menu) are not windows of the app's own: a dialog is closed when only they remain.
  const popups = new Set(tree?.popupIds ?? []);
  // A window that was closed is still listed for a while, but not on screen: only what is on screen counts as open.
  const shown = windows.filter((w) => w.onScreen !== false && !popups.has(w.windowId));
  return { windowIds: shown.map((w) => w.windowId).sort((a, b) => a - b), ...(desktop ? { windows: shown.map((w) => ({ id: w.windowId, pid: w.pid, ...(typeof w.zIndex === "number" ? { z: w.zIndex } : {}) })) } : {}), ...(sheet && elements ? { sheet: { index: sheet.element_index, elements } } : {}) };
}

export const sameIds = (a: number[], b: number[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

// Probes one menu item. Returns after the dialog is closed again, or says `stuck` when it could not be.
export async function probeDialog(ports: ProbePorts, menuPath: readonly string[]): Promise<ProbeResult> {
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const done = (result: Omit<ProbeResult, "ms">): ProbeResult => ({ ...result, ms: now() - started });
  if (isRiskyMenuPath(menuPath)) return done({ status: "unsafe", code: "risky_path" });
  const before = await observe(ports);
  if (before.sheet) return done({ status: "error", code: "dialog_already_open" }); // never start from a window that is not at rest
  // The owner may have come back while the window was being read: check once more, immediately before anything is pressed.
  if (ports.signal?.aborted) return done({ status: "error", code: "aborted" });

  // Only a path the live menu confirms is sent: the driver presses every item along it, and an item without a submenu would be executed.
  const resolved = await resolveMenuPath(ports.actuator, ports.target, menuPath, ports.signal, ports.sleep);
  if (resolved.status !== "ok") return done({ status: "refused", code: `menu_${resolved.status}` });
  if (!resolved.enabled) return done({ status: "refused", code: "menu_item_disabled" });
  if (ports.signal?.aborted) return done({ status: "error", code: "aborted" });
  const invoke = await invokeMenuPath(ports.actuator, ports.target, menuPath, ports.signal, ports.sleep);
  // A press the driver reports as failed may still have opened a dialog (a click it could not confirm): what appeared is looked at and closed
  // all the same, and the failure is what is reported.
  const invokeFailure = invoke.ok ? undefined : invoke.refusalCode ?? invoke.errorCode ?? "invoke_failed";

  let shape: DialogShape | undefined;
  // Set when the dialog turned out to be one that must not be described; it is still closed again.
  let refusal: { status: ProbeStatus; code: string } | undefined;
  let dismissWindow: number | undefined;
  let dismissPid: number | undefined;
  // A new window appeared but its tree was never readable.
  let unreadable = false;
  let after: WindowFacts = before;
  const deadline = now() + (ports.settleMs ?? 2500);
  while (now() < deadline && !ports.signal?.aborted) {
    await sleep(ports.pollMs ?? 250);
    after = await observe(ports);
    if (after.sheet) {
      // a sheet belongs to the window it is attached to: whatever window showed up first while it was attaching is not the one to close
      dismissWindow = undefined;
      unreadable = false;
      if (listsContent(after.sheet.elements, after.sheet.index)) refusal = { status: "unsafe", code: "lists_content" };
      else shape = analyzeDialog(after.sheet.elements, after.sheet.index);
      break;
    }
    const found = newPanel(before, after, ports.target.pid, ports.actuator.platform);
    // Several windows of other apps appeared at once: which one is ours cannot be told, so nothing is pressed in any of them.
    if (found === "ambiguous") return done({ status: "error", code: "ambiguous_windows" });
    if (found) {
      // A dialog that is a separate panel window: read that window's own tree. It is the window this probe opened, so it is the one to close
      // again even if its tree can never be read (some windows have no accessibility surface at all).
      dismissWindow = found.id;
      dismissPid = found.pid;
      unreadable = true;
      const panel = { pid: found.pid, windowId: found.id };
      const tree = await readDialogTree(ports.actuator, panel, ports.target, ports.signal);
      if (tree && tree.elements.length > (ports.actuator.platform === "linux" ? 0 : 1)) {
        unreadable = false;
        if (listsContent(tree.elements)) refusal = { status: "unsafe", code: "lists_content" };
        else if (tree.partial) refusal = { status: "error", code: "partial_tree" }; // a cut tree would describe a dialog with controls missing
        else {
          const analysed = analyzeDialog(tree.elements);
          // A window with no Cancel button applies what is set in it at once (Settings). It is only read here, never set, so its value controls can be
          // described (immediateShape); one with nothing to set, or a risky caption, is refused as before.
          if (!analysed.cancel) {
            const immediate = immediateShape(analysed);
            if (immediate) shape = immediate; else refusal = { status: "unsafe", code: "no_cancel" };
          } else shape = analysed;
        }
        break;
      }
    }
  }

  // Close it again, whatever happened. The Cancel button is pressed through its element token. A window that is not a sheet and has no Cancel
  // button (a Settings window) is closed with the window-close shortcut aimed at that window - it is the window this probe just opened, and the
  // app is in front. Escape is only the last resort.
  // The window that appeared while the dialog opened, as it is now: some windows are recreated under a new id a moment after they appear
  // (measured: Font Book's Resolve Duplicates), so the id seen first can already be gone.
  const desktop = ports.actuator.platform === "win32";
  const newestNow = async (): Promise<number | undefined> => {
    const windows = await ports.actuator.listWindows(desktop ? {} : { pid: ports.target.pid }, { signal: ports.signal }).catch(() => []);
    // on Windows only the dialog's owner counts: another app's window that came up meanwhile is not ours to close
    const fresh = windows.filter((window) => window.onScreen !== false && !before.windowIds.includes(window.windowId) && (!desktop || window.pid === (dismissPid ?? ports.target.pid)));
    if (fresh.length === 0) return undefined;
    // on Windows the window on top (a message box over its dialog) goes first; elsewhere the newest
    return desktop ? fresh.sort((a, b) => (b.zIndex ?? -1) - (a.zIndex ?? -1) || b.windowId - a.windowId)[0].windowId : Math.max(...fresh.map((window) => window.windowId));
  };
  const isClosed = (state: WindowFacts): boolean => !state.sheet && (desktop
    ? sameIds(scopedIds(state, [ports.target.pid, dismissPid]), scopedIds(before, [ports.target.pid, dismissPid]))
    : sameIds(state.windowIds, before.windowIds));
  // Cmd+W closes the window it is aimed at on macOS; on the other desktops the same chord would close the app if the key went to the wrong
  // window, so there the way out is the Cancel button, then Escape.
  const shortcutCloses = (ports.actuator.platform ?? "darwin") === "darwin";
  const tries = new Map<number, number>();
  const dismiss = async (): Promise<boolean> => {
    // a dialog and the message box it raised take one round each
    for (let attempt = 0; attempt < (desktop ? 8 : 5); attempt += 1) {
      const newest = await newestNow();
      const ownerPid = dismissWindow !== undefined ? (dismissPid ?? ports.target.pid) : ports.target.pid;
      const target = dismissWindow !== undefined ? { pid: ownerPid, windowId: newest ?? dismissWindow } : ports.target;
      const elements = target.windowId === ports.target.windowId ? await readElements(ports.actuator, target, ports.signal) : (await readDialogTree(ports.actuator, target, ports.target, ports.signal))?.elements ?? null;
      const cancel = elements?.find((element) => element.role === "AXButton" && isCancelButton(cleanLabel(element.label)) && element.element_token);
      // Each window has its own ladder (Cancel, the window shortcut, Escape in front, Escape in the background): a message box raised by the
      // dialog gets its own turn after the dialog on top of it is gone.
      const turn = tries.get(target.windowId) ?? 0;
      tries.set(target.windowId, turn + 1);
      if (cancel?.element_token && turn < 2) await ports.actuator.call("click", { pid: ownerPid, window_id: target.windowId, element_token: cancel.element_token }, { timeoutMs: 8000 });
      else if (shortcutCloses && dismissWindow !== undefined && turn < 3) await ports.actuator.call("hotkey", { pid: ownerPid, window_id: target.windowId, keys: ["cmd", "w"] }, { timeoutMs: 8000 });
      // A sheet without a Cancel button, or a window with no accessibility surface, refuses background keys; the one that reaches it is a
      // real key press with the window fronted (aimed at the window that holds the keyboard: the new one, else the one the sheet is on).
      else if (turn < 4) await ports.actuator.call("press_key", { pid: ownerPid, window_id: newest ?? target.windowId, key: "escape", delivery_mode: "foreground" }, { timeoutMs: 10_000 });
      else await ports.actuator.call("press_key", { pid: ownerPid, window_id: target.windowId, key: "escape" }, { timeoutMs: 8000 });
      await sleep(ports.settleMs ? Math.min(ports.settleMs, 700) : 700);
      const state = await observe(ports);
      if (isClosed(state)) return true;
    }
    return false;
  };

  const sawSomething = !!shape || !!refusal || !!after.sheet || !isClosed(after);
  if (!sawSomething) return invokeFailure ? done({ status: "refused", code: invokeFailure }) : done({ status: "no-dialog" });
  const closed = await dismiss();
  if (!closed) return done({ status: "stuck", code: "dialog_not_closed" });
  if (invokeFailure) return done({ status: "refused", code: invokeFailure });
  if (refusal) return done(refusal);
  if (!shape && unreadable) return done({ status: "error", code: "window_unreadable" });
  if (!shape) return done({ status: "no-dialog" });
  return done({ status: "ok", shape });
}
