import type { Actuator, ToolOutcome } from "./actuator";
import { cleanLabel, readDialogTree, readElements, observe, newPanel, sameIds, scopedIds, isCancelButton, type ElementRecord } from "./dialog-probe";
import { invokeMenuPath, resolveMenuPath } from "./menu-probe";
import { bringAppForward, withForeground } from "./foreground";
import type { MenuTarget } from "./menu-probe";
import { opensAPanelByPurpose } from "./explore-policy";
import { MENU_COMMAND_TRAIT, type Capability } from "./types";

// Carries out an explored capability: the `steps` body, with the caller's parameters in place of the ${placeholders}. It brings the app
// forward (menus of an app that is behind another window are disabled), runs the steps one at a time, checks the postcondition, and if
// anything goes wrong it closes the dialog it opened with its Cancel button, so a failed call leaves the app as it found it.
//
// Only three driver tools are ever sent: invoke_menu, set_value and click. Targets are found by role, caption and position in the live
// tree, never by a stored element token (those go stale with every read).

export interface RunPorts {
  actuator: Actuator;
  target: MenuTarget;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  settleMs?: number;
}

export type RunCode =
  | "bad_parameters" | "unsupported_body" | "step_refused" | "element_not_found" | "postcondition_unsatisfied" | "aborted" | "not_in_foreground";

export interface RunResult {
  ok: boolean;
  code?: RunCode;
  message?: string;
  stepsRun: number;
  // true when the failure looks like the app's interface moved (a missing menu path or control): worth trying to repair
  repairable: boolean;
  postcondition?: "satisfied" | "unsatisfied" | "unknown";
}

const TOOLS = new Set(["invoke_menu", "set_value", "click", "hotkey", "press_key"]);
// A button that ANSWERS a question (OK, Continue, Agree, Yes, Allow ...) in the languages Agentlas ships in. A window that has one and no toolbar is a question put to the
// owner, whatever its size and whatever text it scrolls (independent review 4, S4: a license text with Agree / Disagree, a large confirmation with only Continue).
const ANSWER_BUTTON = /^(?:ok|okay|continue|agree|disagree|accept|decline|yes|no|allow|don.t allow|deny|got it|확인|계속|동의|동의 안 함|동의하지 않음|예|아니요|아니오|허용|허용 안 함|はい|いいえ|続ける|同意する|同意しない|許可|許可しない|好|好的|确定|確定|继续|繼續|同意|不同意|是|否|ja|nein|fortfahren|zustimmen|ablehnen|erlauben|oui|non|continuer|accepter|refuser|autoriser|sí|si|continuar|aceptar|rechazar|permitir|sì|continua|accetta|rifiuta|consenti|sim|não|nao|aceitar|recusar)$/i;
// what a document window holds and a message box does not
const DOCUMENT_ROLES: ReadonlySet<string> = new Set(["AXTextArea", "AXScrollArea", "AXWebArea", "AXOutline", "AXTable", "AXBrowser", "AXSplitGroup", "AXTabGroup", "AXToolbar", "AXList"]);

function placeholderName(value: unknown): string | null {
  const match = typeof value === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value) : null;
  return match ? match[1] : null;
}

function validateParameters(capability: Capability, params: Record<string, unknown>): string | null {
  const declared = new Map(capability.parameters.map((parameter) => [parameter.name, parameter]));
  for (const key of Object.keys(params)) if (!declared.has(key)) return `unknown parameter ${key.slice(0, 40)}`;
  for (const parameter of capability.parameters) {
    const value = params[parameter.name];
    if (value === undefined) { if (parameter.required) return `missing parameter ${parameter.name}`; continue; }
    if (parameter.type === "boolean" && typeof value !== "boolean") return `${parameter.name} must be true or false`;
    if (parameter.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${parameter.name} must be a number`;
    if (parameter.type === "string" && typeof value !== "string") return `${parameter.name} must be text`;
    if (typeof value === "string" && value.length > 2000) return `${parameter.name} is too long`;
    if (parameter.type.startsWith("enum:")) {
      const members = parameter.type.slice(5).split("|");
      if (typeof value !== "string" || !members.includes(value)) return `${parameter.name} must be one of: ${members.join(", ")}`;
    }
  }
  return null;
}

function findElement(elements: readonly ElementRecord[], role: string, label: string | undefined, nth: number): ElementRecord | undefined {
  let seen = 0;
  for (const element of elements) {
    if (element.role !== role || !element.element_token) continue;
    if (label !== undefined && cleanLabel(element.label) !== label) continue;
    if (seen === nth) return element;
    seen += 1;
  }
  return undefined;
}

// Windows: the value pattern is what `set_value` needs, and a classic edit control, a check box or a combo box often has none ("does not implement
// ValuePattern"; measured on Notepad's dialogs). A check box is toggled by pressing it when it is not already as asked; a text field is focused by a
// real click, emptied with End and Backspace (select-all is refused for XAML windows) and typed into with real key events - the app is in front
// while a capability runs. Nothing is typed unless the field was the one the capability names.
async function setValueOnWindows(ports: RunPorts, args: { pid: number; window_id: number; element_token: string; value: string }, element: ElementRecord): Promise<ToolOutcome> {
  const call = (tool: string, extra: Record<string, unknown>): Promise<ToolOutcome> => ports.actuator.call(tool, { pid: args.pid, window_id: args.window_id, ...extra }, { signal: ports.signal });
  const direct = await call("set_value", { element_token: args.element_token, value: args.value });
  if (direct.ok) return direct;
  if (element.role === "AXCheckBox") {
    const wanted = /^(true|1|yes|on)$/i.test(args.value);
    if ((element.selected === true) === wanted) return { ok: true, text: "already as asked" };
    return call("click", { element_token: args.element_token });
  }
  if (element.role === "AXTextField") {
    const focused = await call("click", { element_token: args.element_token, delivery_mode: "foreground" });
    if (!focused.ok) return focused;
    await call("press_key", { key: "end", delivery_mode: "foreground" });
    for (let i = 0, count = Math.min(120, (element.value ?? "").length + 2); i < count; i += 1) await call("press_key", { key: "backspace", delivery_mode: "foreground" });
    return call("type_text", { text: args.value, delivery_mode: "foreground" });
  }
  return direct;
}

export async function runSteps(ports: RunPorts, capability: Capability, params: Record<string, unknown>): Promise<RunResult> {
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fail = (code: RunCode, message: string, stepsRun: number, repairable = false): RunResult => ({ ok: false, code, message, stepsRun, repairable });
  if (capability.body?.kind !== "steps") return fail("unsupported_body", "this capability is not a step sequence", 0);
  const invalid = validateParameters(capability, params);
  if (invalid) return fail("bad_parameters", invalid, 0);
  const steps = capability.body.steps;
  if (steps.length === 0 || steps.length > 40 || steps.some((step) => !TOOLS.has(step.tool))) return fail("unsupported_body", "a step uses a tool Reach does not run", 0);

  const before = await observe({ actuator: ports.actuator, target: ports.target, signal: ports.signal });
  const front = await bringAppForward(ports.actuator, ports.target, ports.signal);
  if (!front.ok) return fail("not_in_foreground", "the app could not be brought to the front", 0);

  let run = 0;
  // A dialog is a sheet in the app's own window (its elements are in that window's tree) or a window of its own; the newest window that was
  // not there before the first step is the dialog's.
  const desktop = ports.actuator.platform === "win32";
  let knownOwner: number | undefined;
  const windowOfDialog = async (): Promise<{ panel?: MenuTarget; same: boolean; ambiguous?: boolean }> => {
    const state = await observe({ actuator: ports.actuator, target: ports.target, signal: ports.signal });
    // On Windows the dialog may belong to another process (the shell's Print dialog): the new window, and whose it is, comes from the whole desktop.
    const found = state.sheet ? undefined : newPanel(before, state, ports.target.pid, ports.actuator.platform, knownOwner);
    if (found && found !== "ambiguous") knownOwner = found.pid;
    return {
      ...(found && found !== "ambiguous" ? { panel: { pid: found.pid, windowId: found.id } } : {}),
      ...(found === "ambiguous" ? { ambiguous: true } : {}),
      same: !state.sheet && (desktop ? sameIds(scopedIds(state, [ports.target.pid, knownOwner]), scopedIds(before, [ports.target.pid, knownOwner])) : sameIds(state.windowIds, before.windowIds)),
    };
  };
  const elementsOf = async (panel: MenuTarget | undefined): Promise<ElementRecord[]> =>
    panel ? (await readDialogTree(ports.actuator, panel, ports.target, ports.signal))?.elements ?? [] : (await readElements(ports.actuator, ports.target, ports.signal)) ?? [];
  const cleanup = async (): Promise<void> => {
    const dialog = await windowOfDialog();
    if (dialog.same) return;
    const where = dialog.panel ?? ports.target;
    const elements = await elementsOf(dialog.panel);
    const cancel = elements.find((element) => element.role === "AXButton" && isCancelButton(cleanLabel(element.label)) && element.element_token);
    if (cancel?.element_token) await ports.actuator.call("click", { pid: (dialog.panel ?? ports.target).pid, window_id: where.windowId, element_token: cancel.element_token });
    // A window of its own with no Cancel button is closed the platform's way: Cmd+W on macOS (aimed at that window), Escape elsewhere.
    else if (dialog.panel) {
      if ((ports.actuator.platform ?? "darwin") === "darwin") await ports.actuator.call("hotkey", { pid: ports.target.pid, window_id: where.windowId, keys: ["cmd", "w"] });
      else await ports.actuator.call("press_key", { pid: where.pid, window_id: where.windowId, key: "escape", delivery_mode: "foreground" });
    }
    await sleep(500);
  };

  try {
    for (const step of steps) {
      if (ports.signal?.aborted) { await cleanup(); return fail("aborted", "the call was cancelled", run); }
      const when = typeof step.args.when === "string" ? step.args.when : undefined;
      if (when !== undefined && params[when] === undefined) continue;
      if (step.tool === "invoke_menu") {
        // the driver presses every item along a path, and an item without a submenu is executed: only a path the live menu confirms goes out
        const menuPath = Array.isArray(step.args.path) ? (step.args.path as string[]) : [];
        let live = await resolveMenuPath(ports.actuator, ports.target, menuPath, ports.signal, ports.sleep);
        // A toggle item (Show Tab Bar / Hide Tab Bar) is retitled when the app validates its menu, a moment after it was brought forward or changed:
        // measured on TextEdit, the command that undoes a toggle was called "gone" on the first look and found a second later. One more look before it is.
        if (live.status === "missing" && !ports.signal?.aborted) { await sleep(1200); live = await resolveMenuPath(ports.actuator, ports.target, menuPath, ports.signal, ports.sleep); }
        if (live.status !== "ok") return fail("step_refused", live.status === "unreadable" ? (live.code ?? "menu_unreadable") : "menu_path_unavailable", run, live.status !== "unreadable");
        if (!live.enabled) return fail("step_refused", "menu_item_disabled", run, false);
        const outcome = await invokeMenuPath(ports.actuator, ports.target, step.args.path as string[], ports.signal, ports.sleep);
        if (!outcome.ok) return fail("step_refused", outcome.refusalCode ?? outcome.errorCode ?? "invoke_menu failed", run, outcome.refusalCode === "menu_path_unavailable");
        run += 1;
        await sleep(ports.settleMs ?? 900);
        continue;
      }
      if (step.tool === "hotkey" || step.tool === "press_key") {
        // Only the keys that close a window: the closing step of a settings window that has no Cancel button (what was set has applied). Aimed at the
        // dialog's own window, and never sent when that window is not there (a miss must not close the app's main window).
        const keys = Array.isArray(step.args.keys) ? (step.args.keys as unknown[]).map((key) => String(key).toLowerCase()) : [];
        const closing = step.tool === "hotkey" ? keys.length === 2 && keys[0] === "cmd" && keys[1] === "w" : String(step.args.key ?? "").toLowerCase() === "escape";
        if (!closing) { await cleanup(); return fail("unsupported_body", "a key step is not a window-closing key", run); }
        const window = await windowOfDialog();
        if (!window.panel) return fail("element_not_found", "the window to close is not there", run, true);
        const closed = await ports.actuator.call(step.tool, step.tool === "hotkey"
          ? { pid: window.panel.pid, window_id: window.panel.windowId, keys: ["cmd", "w"] }
          : { pid: window.panel.pid, window_id: window.panel.windowId, key: "escape", delivery_mode: "foreground" }, { signal: ports.signal });
        if (!closed.ok) { await cleanup(); return fail("step_refused", closed.refusalCode ?? closed.errorCode ?? `${step.tool} failed`, run, false); }
        run += 1;
        await sleep(ports.settleMs ?? 400);
        continue;
      }
      const target = step.args.target as { role?: string; label?: string; nth?: number } | undefined;
      if (!target?.role) { await cleanup(); return fail("unsupported_body", "a step has no target", run); }
      const wantedLabel = placeholderName(target.label) ? String(params[placeholderName(target.label) as string] ?? "") : target.label;
      if (placeholderName(target.label) && params[placeholderName(target.label) as string] === undefined) { await cleanup(); return fail("bad_parameters", "the choice for this step was not given", run); }
      const dialog = await windowOfDialog();
      const elements = await elementsOf(dialog.panel);
      const element = findElement(elements, target.role, wantedLabel, target.nth ?? 0);
      if (!element?.element_token) { await cleanup(); return fail("element_not_found", `${target.role}${wantedLabel ? ` "${wantedLabel}"` : ""} is not in the dialog`, run, true); }
      const args: Record<string, unknown> = { pid: (dialog.panel ?? ports.target).pid, window_id: (dialog.panel ?? ports.target).windowId, element_token: element.element_token };
      if (step.tool === "set_value") {
        const placeholder = placeholderName(step.args.value);
        const raw = placeholder ? params[placeholder] : step.args.value;
        args.value = typeof raw === "string" ? raw : String(raw);
      }
      const outcome = step.tool === "set_value" && ports.actuator.platform === "win32"
        ? await setValueOnWindows(ports, args as { pid: number; window_id: number; element_token: string; value: string }, element)
        : await ports.actuator.call(step.tool, args, { signal: ports.signal });
      if (!outcome.ok) { await cleanup(); return fail("step_refused", outcome.refusalCode ?? outcome.errorCode ?? `${step.tool} failed`, run, false); }
      run += 1;
      await sleep(ports.settleMs ?? 400);
    }
    await sleep(ports.settleMs ?? 700);
    // A plain menu command is pressed without ever having been opened: if it turned out to open a dialog (File > Save on an untitled document asks where
    // to save; a conversion asks to confirm; an app-modal alert or a Windows Yes/No box comes up as a window of its own) it is closed again and the call is
    // refused, so no prompt is left that nobody can answer. A new document window is not a dialog and stays (File > New). A new window counts as a dialog
    // when it has a Cancel button, or has buttons and none of what a document window holds (text, scroll areas, outlines, tables, a toolbar).
    // (Independent review D5 and review 2 N2, 2026-10-24.)
    if (capability.traits?.includes(MENU_COMMAND_TRAIT)) {
      const firstStep = capability.body?.kind === "steps" ? capability.body.steps[0] : undefined;
      const purposeIsPanel = opensAPanelByPurpose(Array.isArray(firstStep?.args.path) ? (firstStep?.args.path as string[]) : []);
      const openedDialog = async (): Promise<MenuTarget | "unreadable" | null> => {
        const state = await observe({ actuator: ports.actuator, target: ports.target, signal: ports.signal });
        if (state.sheet) return ports.target;
        const found = newPanel(before, state, ports.target.pid, ports.actuator.platform, knownOwner);
        if (!found || found === "ambiguous") return null;
        const where = { pid: found.pid, windowId: found.id };
        const tree = await readDialogTree(ports.actuator, where, ports.target, ports.signal);
        const elements = tree?.elements ?? [];
        // a window that cannot be read cannot be told from an alert: it is not called a document and not closed - the call says there is a window it could not judge
        if (elements.length === 0) return "unreadable";
        if (elements.some((element) => element.role === "AXButton" && isCancelButton(cleanLabel(element.label) ?? ""))) return where;
        if (purposeIsPanel) return null; // About and Show <panel>: the panel is what was asked for
        // an answer button that sits on the window itself - not in its toolbar and not inside a web page, a text or a scroll area (independent review 5, T4: an editor or an
        // Electron page with an OK button on it is a document; a confirmation window with a toolbar and one OK is a question)
        const byIndex = new Map(elements.map((element) => [element.element_index, element]));
        const insideDocumentPart = (element: ElementRecord): boolean => {
          let parent = element.parent_index === undefined ? undefined : byIndex.get(element.parent_index);
          for (let hops = 0; parent && hops < 64; hops += 1) {
            if (DOCUMENT_ROLES.has(parent.role ?? "")) return true;
            parent = parent.parent_index === undefined ? undefined : byIndex.get(parent.parent_index);
          }
          return false;
        };
        if (elements.some((element) => element.role === "AXButton" && ANSWER_BUTTON.test(cleanLabel(element.label) ?? "") && !insideDocumentPart(element))) return where;
        if (!elements.some((element) => element.role === "AXButton") || elements.some((element) => DOCUMENT_ROLES.has(element.role ?? ""))) return null;
        // buttons and a message and nothing a document holds: a dialog if it is dialog-sized, a canvas app's document window if it is large
        const bounds = (await ports.actuator.listWindows({ pid: found.pid }, { signal: ports.signal }).catch(() => [])).find((window) => window.windowId === found.id)?.bounds;
        return bounds && (bounds.width > 700 || bounds.height > 450) ? null : where;
      };
      let dialog = await openedDialog();
      if (dialog === "unreadable") return { ...fail("postcondition_unsatisfied", "new_window_unreadable", run), postcondition: "unsatisfied" };
      if (dialog) {
        await cleanup();
        dialog = await openedDialog();
        if (dialog && dialog !== "unreadable") {
          // no Cancel button to press: the key that dismisses an alert, a sheet or a message box
          await ports.actuator.call("press_key", { pid: dialog.pid, window_id: dialog.windowId, key: "escape", delivery_mode: "foreground" }, { signal: ports.signal }).catch(() => undefined);
          await sleep(500);
          dialog = await openedDialog();
        }
        return { ...fail("postcondition_unsatisfied", dialog && dialog !== "unreadable" ? "opened_a_dialog_left_open" : "opened_a_dialog", run), postcondition: "unsatisfied" };
      }
    }
    let postcondition: "satisfied" | "unsatisfied" | "unknown" = "unknown";
    if (capability.postconditions?.some((item) => item.kind === "dialog-closed")) postcondition = (await windowOfDialog()).same ? "satisfied" : "unsatisfied";
    if (postcondition === "unsatisfied") { await cleanup(); return { ...fail("postcondition_unsatisfied", "the dialog is still open after the last step", run), postcondition }; }
    return { ok: true, stepsRun: run, repairable: false, postcondition };
  } catch (error) {
    await cleanup().catch(() => undefined);
    return fail("step_refused", error instanceof Error ? error.name : "error", run);
  }
}
