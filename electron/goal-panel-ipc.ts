/*
 * IPC for the goal panel (right-panel "목표" tab, One and Work). Reads re-read the ledger; edits are typed
 * (shared/goal-panel.ts parseGoalPanelEdit) and written only through the ledger writers in long-run/goal-panel.ts.
 * The renderer refreshes on store:changed {chat|long-run} — no polling.
 */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { editGoalPanel, readGoalPanel, requestGoalPanelShape } from "./long-run/goal-panel";
import { invocationService } from "./invocation/service";

export function registerGoalPanelIpc(deps: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  const ipcMain = deps.ipc;
  ipcMain.handle("goalPanel:view", (event, chatId: unknown) => { deps.assertTrustedSender(event); return typeof chatId === "string" && chatId ? readGoalPanel(chatId) : null; });
  ipcMain.handle("goalPanel:edit", (event, request: unknown) => { deps.assertTrustedSender(event);
    return editGoalPanel(request, { activeChatIds: () => invocationService.activeChatIds() }); });
  ipcMain.handle("goalPanel:shape", (event, chatId: unknown, expectedGoalId: unknown) => {
    deps.assertTrustedSender(event);
    if (typeof chatId !== "string" || !chatId) return { ok: false, code: "goal_control_binding_changed", view: null };
    const { done: _done, ...result } = requestGoalPanelShape(chatId, expectedGoalId);
    return result;
  });
}
