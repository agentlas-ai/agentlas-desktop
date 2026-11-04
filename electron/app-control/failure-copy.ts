/*
 * What a model is told when an app operation's own handler refuses with nothing but an internal code.
 *
 * app.call / one_app_call run the screen's IPC handlers, and a handler's custody or ledger check throws a bare code
 * (`goal_control_binding_changed`, `trigger_event_reconciliation_conflict`, `[agentlas:code=alive-input-invalid] alive-input-invalid`, an
 * `ENOENT ... operation.json` with a private path). The model got exactly that, with no cause and no next step, and told the owner the
 * code (production failure_events: 14 such refusals in one day; chats.getGoalResumeReview with a stale expectedGoalId three
 * times in a row). Each code now carries what it means and the call that gets the model to the owner's goal; a code the table does not
 * name gets the generic line, so no bare code is the whole answer. Matching is on the exact code, never on prose. Pure: no host, no
 * Electron (the daemon relays Main's message, which is already this text).
 */

const BARE_CODE_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/;
const PREFIXED_RE = /^\[agentlas:code=([^\]\s]+)\]\s*(.*)$/s;

const GENERIC = "the app's own state check stopped this call, so it did not complete. This is not a mistake of the owner's. Read the current state with the matching read operation and repeat the call once; if it stops again, tell the owner in plain words what could not be done and that the app could not do it right now. Never show the owner the code.";

const KNOWN: Readonly<Record<string, string>> = {
  goal_control_binding_changed: "this chat's Goal is not the one the call named in expectedGoalId (it was replaced, finished, or this chat has none). Read chats.getGoalContext for the chat, pass the goalId it returns as expectedGoalId, or tell the owner there is no active Goal here.",
  trigger_event_reconciliation_conflict: "another process settled this trigger event first, so there is nothing left to reconcile. Read the result with automations.listRuns.",
  trigger_event_graph_reconciliation_required: "this trigger event holds a step whose outside effect is unconfirmed. Read automations.getGraphReconciliation, settle that step, then replay.",
  automation_graph_reconciliation_graph_drift: "the graph was edited after that run, so its saved checkpoints no longer fit it. There is nothing to reconcile: the next run starts fresh on the current graph.",
  automation_workspace_goal_association_untrusted: "goalId is the host's own link between an automation and a Goal and cannot be set by a call. Send the call without goalId; to follow a Goal use workspaceMode follow_goal with workspaceGoalId.",
  "alive-input-invalid": "the input does not match this operation's input_schema. Read app.operations with {operation} for the schema and send exactly those fields.",
  native_gui_original_renderer_required: "this action needs the app window the owner is looking at, which a background turn does not have. Ask the owner to do it on screen, or repeat it when their window is open.",
  one_graph_execution_unsettled: "the graph's previous run has not finished settling. Read the graph again with one_graph_inspect and repeat once it shows a finished run.",
};

/** The line to give the model for a handler's failure message, or null when the message already says what happened. */
export function explainAppOperationFailure(message: string): string | null {
  const text = String(message ?? "").trim();
  if (!text) return null;
  const prefixed = PREFIXED_RE.exec(text);
  const rest = prefixed ? prefixed[2].trim() : text;
  const code = prefixed ? prefixed[1] : BARE_CODE_RE.test(text) ? text : null;
  // A file the operation reads is gone: say so without the private path.
  if (/^ENOENT\b.*no such file or directory/i.test(rest)) {
    return "the file this operation reads no longer exists (it was deleted, moved, or never saved). Refresh the listing it came from and use a current id; do not repeat this call.";
  }
  if (!code) return null;
  // `[agentlas:code=X] X` repeats the code; `[agentlas:code=X] a sentence` is already a sentence.
  if (prefixed && rest && rest !== code) return null;
  if (!BARE_CODE_RE.test(code)) return null;
  return `${code}: ${KNOWN[code] ?? GENERIC}`;
}
