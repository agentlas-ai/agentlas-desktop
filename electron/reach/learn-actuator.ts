import type { Actuator } from "./actuator";
import { readElements, type ElementRecord } from "./dialog-probe";
import type { MenuTarget } from "./menu-probe";
import { toLearnElements, type LearnAction, type LearnDriver, type LearnElement } from "./learn";

// The Reach Actuator (the Cua Driver) as the screen the learned-capability replay works on. Element tokens never leave this closure: the replay
// sees roles, captions and indices, and every index is turned back into the driver's own token from the snapshot it came from.

// The driver's structured `elements` carry only addressable controls. Static text (a display, a result, a status caption) is in its markdown tree as a
// row without an index: `- AXStaticText = "15" (필드 편집)`, the value after `=` and the caption in parentheses (Cua Driver 0.38.0 on macOS, measured on
// Calculator: the structured read had 33 elements and no static text, the markdown had the display). The learning side reads the app through
// get_app_state, which shows these, so a replay that wants to judge a check on one has to read them too. They carry no token: never a target.
const STATIC_TEXT_ROW = /^\s*- AXStaticText(?: = ("(?:[^"\\]|\\.)*"))?(?: \(([^)]*)\))?\s*$/;

export function staticTextRecords(markdown: string, firstIndex: number): ElementRecord[] {
  const out: ElementRecord[] = [];
  for (const line of markdown.split("\n")) {
    const match = STATIC_TEXT_ROW.exec(line);
    if (!match || (match[1] === undefined && match[2] === undefined)) continue;
    let value: string | undefined;
    if (match[1] !== undefined) { try { const parsed: unknown = JSON.parse(match[1]); if (typeof parsed === "string") value = parsed; } catch { value = undefined; } }
    out.push({ element_index: firstIndex + out.length, role: "AXStaticText", ...(match[2] !== undefined ? { label: match[2] } : {}), ...(value !== undefined ? { value } : {}) });
    if (out.length >= 200) break;
  }
  return out;
}

async function readScreen(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): Promise<ElementRecord[] | null> {
  // Only the macOS driver's markdown is known; every other platform keeps the structured read it always had.
  if (actuator.platform !== undefined && actuator.platform !== "darwin") return readElements(actuator, target, signal);
  try {
    const state = await actuator.call("get_window_state", { pid: target.pid, window_id: target.windowId, include_screenshot: false, tree_format: "both", max_elements: 2000, timeout_ms: 5000 }, { signal, timeoutMs: 20_000 });
    const elements = state.structured?.elements;
    if (!state.ok || !Array.isArray(elements)) return readElements(actuator, target, signal);
    const records = elements as ElementRecord[];
    const markdown = typeof state.structured?.tree_markdown === "string" ? state.structured.tree_markdown : "";
    const next = records.reduce((max, record) => Math.max(max, record.element_index), -1) + 1;
    return markdown ? [...records, ...staticTextRecords(markdown, next)] : records;
  } catch {
    return readElements(actuator, target, signal);
  }
}

export function actuatorLearnDriver(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): LearnDriver {
  let tokens = new Map<number, string>();
  const base = { pid: target.pid, window_id: target.windowId };
  const outcome = (o: { ok: boolean; refusalCode?: string; errorCode?: string }): { ok: boolean; code?: string } => ({ ok: o.ok, ...(o.ok ? {} : { code: o.refusalCode ?? o.errorCode ?? "driver_refused" }) });
  return {
    async snapshot(): Promise<LearnElement[] | null> {
      const records = await readScreen(actuator, target, signal);
      if (!records) return null;
      tokens = new Map(records.filter((record) => record.element_token).map((record) => [record.element_index, record.element_token as string]));
      return toLearnElements(records);
    },
    async act(action: LearnAction): Promise<{ ok: boolean; code?: string }> {
      if (action.kind === "key") return outcome(await actuator.call("press_key", { ...base, key: action.key ?? "", delivery_mode: "foreground" }, { signal }));
      const token = action.element ? tokens.get(action.element.index) : undefined;
      if (!token) return { ok: false, code: "element_stale" };
      if (action.kind === "click") return outcome(await actuator.call("click", { ...base, element_token: token }, { signal }));
      if (action.kind === "set_value") return outcome(await actuator.call("set_value", { ...base, element_token: token, value: action.text ?? "" }, { signal }));
      // type: the field is focused by a real click, then the text goes in as key events
      const focused = await actuator.call("click", { ...base, element_token: token, delivery_mode: "foreground" }, { signal });
      if (!focused.ok) return outcome(focused);
      return outcome(await actuator.call("type_text", { text: action.text ?? "", delivery_mode: "foreground" }, { signal }));
    },
  };
}
