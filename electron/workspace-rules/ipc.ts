import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isAppControlEvent } from "../app-control/ipc-registry";
import { getAuthSession } from "../auth";
import { getAgentById } from "../mcp/registry";
import { WORKSPACE_RULES_CHANNELS } from "../../shared/workspace-rules";
import { configureWorkspaceRules, workspaceRulesAddPicked, workspaceRulesCandidates, workspaceRulesClear, workspaceRulesGet, workspaceRulesOpenFile, workspaceRulesPickNotice, workspaceRulesSave } from "./service";

/*
 * The seven "My rules" channels (Agentlas 2.0 P4). Renderer only: an app-control caller is refused, the phone bridge and the One-window role do not know these names, and every one needs a trusted sender.
 * `get`, `candidates` read; `save`, `clear`, `addPicked` are the owner's writes to the rules file; `pickNotice` moves the "shown once" state forward; `openFile` asks the computer to open the rules file in its own editor (Desktop repair 6: no path goes to the renderer). No agent, tool or timer registers or calls any of them.
 */
export function registerWorkspaceRulesIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender(event: IpcMainInvokeEvent): unknown }): void {
  const guard = (event: IpcMainInvokeEvent): void => {
    if (isAppControlEvent(event)) throw new Error("workspace_rules_owner_renderer_required");
    input.assertTrustedSender(event);
  };
  const { ipc } = input;
  configureWorkspaceRules({
    accountLabel: () => { const session = getAuthSession(); return session.signedIn ? (session.email || session.name || "") : ""; },
    agentName: (agentId) => { if (!agentId) return ""; try { return getAgentById(agentId)?.name ?? agentId; } catch { return agentId; } },
  });
  ipc.handle(WORKSPACE_RULES_CHANNELS.get, (event) => { guard(event); return workspaceRulesGet(); });
  ipc.handle(WORKSPACE_RULES_CHANNELS.save, (event, value) => { guard(event); return workspaceRulesSave(value); });
  ipc.handle(WORKSPACE_RULES_CHANNELS.clear, (event, value) => { guard(event); return workspaceRulesClear(value); });
  ipc.handle(WORKSPACE_RULES_CHANNELS.candidates, (event) => { guard(event); return workspaceRulesCandidates(); });
  ipc.handle(WORKSPACE_RULES_CHANNELS.addPicked, (event, value) => { guard(event); return workspaceRulesAddPicked(value); });
  ipc.handle(WORKSPACE_RULES_CHANNELS.pickNotice, (event, value) => { guard(event); return workspaceRulesPickNotice(value); });
  ipc.handle(WORKSPACE_RULES_CHANNELS.openFile, (event) => { guard(event); return workspaceRulesOpenFile(); });
}
