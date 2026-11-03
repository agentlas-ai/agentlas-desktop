import type { Actuator } from "./actuator";
import { readElements } from "./dialog-probe";
import type { MenuTarget } from "./menu-probe";
import { toLearnElements, type LearnAction, type LearnDriver, type LearnElement } from "./learn";

// The Reach Actuator (the Cua Driver) as the screen the learned-capability replay works on. Element tokens never leave this closure: the replay
// sees roles, captions and indices, and every index is turned back into the driver's own token from the snapshot it came from.

export function actuatorLearnDriver(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): LearnDriver {
  let tokens = new Map<number, string>();
  const base = { pid: target.pid, window_id: target.windowId };
  const outcome = (o: { ok: boolean; refusalCode?: string; errorCode?: string }): { ok: boolean; code?: string } => ({ ok: o.ok, ...(o.ok ? {} : { code: o.refusalCode ?? o.errorCode ?? "driver_refused" }) });
  return {
    async snapshot(): Promise<LearnElement[] | null> {
      const records = await readElements(actuator, target, signal);
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
