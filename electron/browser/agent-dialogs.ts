/*
 * ★JavaScript dialogs for agent-driven native browser guests.
 *
 * Electron's own JavaScriptDialogManager shows alert/confirm/prompt as native
 * message boxes and does not implement DevTools' HandleJavaScriptDialog: CDP
 * Page.handleJavaScriptDialog answers "No dialog is showing" while the native
 * box stays up and the page's renderer waits on it (measured 2026-09-29 in an
 * isolated app). An agent can never close it, and the box blocks the owner too.
 *
 * While an agent's CDP client is attached, the relay therefore replaces the
 * three page functions in the page's main world with non-blocking versions
 * that report through a Runtime binding. The relay turns each report into the
 * Page.javascriptDialogOpening / Page.javascriptDialogClosed events a CDP
 * client expects, so Playwright's dialog flow (and browser_handle_dialog) keeps
 * working. The page cannot wait for the agent's answer (the calls are
 * synchronous), so it receives the answer a person proceeding would give:
 * confirm() is true and prompt() returns its default text. Detaching restores
 * the page's original functions.
 */
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
