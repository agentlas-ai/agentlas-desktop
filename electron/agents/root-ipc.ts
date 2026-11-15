import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { AGENT_ROOT_CHANNELS } from "../../shared/agent-root";
import { clearAgentAvatar, setAgentAvatar } from "../one/avatar";
import type { OneTeamAgentAvatarInput } from "../../shared/one-org";
import { setRegistrationCharacter } from "./registration-character";
import { agentUsability } from "./usability";
import { agentFolderStatus, reconnectAgentRoot, setAgentDefinitionLocation } from "./relocate";
import { cancelAgentRootMove, getAgentRootMoveStatus, previewAgentRootMove, retireOldAgentRoot, setAsideUnreadableRootMoveJournal, settleAgentRootMove, startAgentRootMove } from "./root-move";

/*
 * Agent folder location and portrait. Renderer-only: not part of the phone bridge and not in the app-control catalog, so no phone-visible response
 * changes shape. Every handler returns a result object with a machine code instead of throwing; the screen (a later package) words the codes. The sender must be a
 * trusted renderer: a root move relocates every agent's memory, so a stray frame cannot start one.
 */
export function registerAgentRootIpc(ipcMain: Pick<IpcMain, "handle">, deps: { assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  const guard = (event: IpcMainInvokeEvent): void => { deps.assertTrustedSender(event); };
  ipcMain.handle(AGENT_ROOT_CHANNELS.status, (event) => { guard(event); return getAgentRootMoveStatus(); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.preview, (event, target: unknown) => { guard(event); return previewAgentRootMove(target); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.move, (event, target: unknown) => { guard(event); return startAgentRootMove(target); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.cancel, (event) => { guard(event); return cancelAgentRootMove(); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.retire, (event) => { guard(event); return retireOldAgentRoot({ force: true }); });
  // Desktop repair 6 (first run B10): the two ways out of a journal no code can settle. Neither deletes a folder: they close or rename the journal file. The renderer passes
  // only a choice word, never a path; anything else is the machine code `target_invalid`.
  ipcMain.handle(AGENT_ROOT_CHANNELS.settle, (event, choice: unknown) => { guard(event); return settleAgentRootMove(choice); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.setAsideJournal, (event) => { guard(event); return setAsideUnreadableRootMoveJournal(); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.reconnect, (event, target: unknown) => { guard(event); return reconnectAgentRoot(target); });
  ipcMain.handle(AGENT_ROOT_CHANNELS.folderStatus, (event, agentId: unknown) => { guard(event); return typeof agentId === "string" ? agentFolderStatus(agentId) : null; });
  ipcMain.handle(AGENT_ROOT_CHANNELS.setLocation, (event, input: unknown) => {
    guard(event);
    const value = (input && typeof input === "object" ? input : {}) as { agentId?: unknown; folder?: unknown };
    return setAgentDefinitionLocation(typeof value.agentId === "string" ? value.agentId : "", value.folder);
  });
  ipcMain.handle(AGENT_ROOT_CHANNELS.avatarSet, (event, input: unknown) => {
    guard(event);
    const value = (input && typeof input === "object" ? input : {}) as { agentId?: unknown; dataUrl?: unknown };
    return setAgentAvatar(typeof value.agentId === "string" ? value.agentId : "", value.dataUrl);
  });
  ipcMain.handle(AGENT_ROOT_CHANNELS.characterSet, (event, input: unknown) => {
    guard(event);
    const value = (input && typeof input === "object" ? input : {}) as { agentId?: unknown; avatar?: unknown };
    return setRegistrationCharacter(typeof value.agentId === "string" ? value.agentId : "", value.avatar as OneTeamAgentAvatarInput);
  });
  ipcMain.handle(AGENT_ROOT_CHANNELS.usability, (event, input: unknown) => {
    guard(event);
    const value = (input && typeof input === "object" ? input : {}) as { agentId?: unknown; slug?: unknown; source?: unknown };
    if (typeof value.agentId === "string") return agentUsability({ agentId: value.agentId });
    if (typeof value.slug === "string") return agentUsability({ slug: value.slug, source: value.source === "hub" || value.source === "cloud" ? value.source : "local" });
    return agentUsability({ agentId: "" });
  });
  ipcMain.handle(AGENT_ROOT_CHANNELS.avatarClear, (event, agentId: unknown) => { guard(event); return clearAgentAvatar(typeof agentId === "string" ? agentId : ""); });
}
