


















export const AGENT_DIALOG_BINDING = "__agentlasAgentDialog";

export type AgentDialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type AgentDialogReport = { type: AgentDialogType; message: string; defaultPrompt: string };

export const agentDialogInstallSource = `(() => {
  const binding = globalThis[${JSON.stringify(AGENT_DIALOG_BINDING)}];
  const key = Symbol.for("agentlas.agentDialogs");
  if (typeof binding !== "function" || window[key]) return false;
  const original = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const report = (type, message, defaultPrompt) => {
    try { binding(JSON.stringify({ type, message: String(message ?? "").slice(0, 4000), defaultPrompt: String(defaultPrompt ?? "").slice(0, 4000) })); } catch {}
  };
  window.alert = function alert(message) { report("alert", message, ""); };
  window.confirm = function confirm(message) { report("confirm", message, ""); return true; };
  window.prompt = function prompt(message, defaultValue) { report("prompt", message, defaultValue ?? ""); return defaultValue == null ? "" : String(defaultValue); };
  Object.defineProperty(window, key, { value: original, configurable: true });
  return true;
})()`;

export const agentDialogRestoreSource = `(() => {
  const key = Symbol.for("agentlas.agentDialogs");
  const original = window[key];
  if (!original) return false;
  window.alert = original.alert; window.confirm = original.confirm; window.prompt = original.prompt;
  delete window[key];
  return true;
})()`;

export function parseAgentDialogReport(payload: unknown): AgentDialogReport | null {
  if (typeof payload !== "string" || payload.length > 10_000) return null;
  try {
    const value = JSON.parse(payload) as Partial<AgentDialogReport>;
    if (value.type !== "alert" && value.type !== "confirm" && value.type !== "prompt") return null;
    return { type: value.type, message: String(value.message ?? ""), defaultPrompt: String(value.defaultPrompt ?? "") };
  } catch { return null; }
}
