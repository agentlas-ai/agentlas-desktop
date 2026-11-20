import type { IpcMain } from "electron";
import { HOME_TREE_CHANNELS } from "../../shared/home-tree";
import { getDb } from "../store/db";
import { homeLines, homeParticipants, homeRowsByIds, homeSearch, homeTree } from "./home-tree";
import { openMemberRoom } from "../one/agent-chat";
import { leadRoomWaiting, stopRoomConversation } from "../one/room-lead-runtime";

/*
 * Home tree reads. Reads only (home:openMember finds the member's 1:1 and makes it only when there is none). Not part of the phone bridge and not in the app-control catalog: the renderer is the
 * only caller, and an older phone never sees these channels, so no phone-visible response changes shape.
 */
export function registerHomeTreeIpc(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle(HOME_TREE_CHANNELS.tree, () => homeTree(getDb()));
  ipcMain.handle(HOME_TREE_CHANNELS.rowsByIds, (_event, ids: unknown) => homeRowsByIds(getDb(), ids));
  ipcMain.handle(HOME_TREE_CHANNELS.participants, (_event, chatId: unknown) => homeParticipants(getDb(), chatId));
  ipcMain.handle(HOME_TREE_CHANNELS.search, (_event, text: unknown) => homeSearch(getDb(), text));
  ipcMain.handle(HOME_TREE_CHANNELS.lines, (_event, ids: unknown) => homeLines(getDb(), ids));
  ipcMain.handle(HOME_TREE_CHANNELS.openMember, (_event, input: unknown) => openMemberRoom((input && typeof input === "object" ? input : {}) as { roomChatId?: unknown; agentId?: unknown }));
  ipcMain.handle(HOME_TREE_CHANNELS.roomWaiting, (_event, chatId: unknown) => (typeof chatId === "string" && chatId ? leadRoomWaiting(chatId) : { busy: false, held: [] }));
  ipcMain.handle(HOME_TREE_CHANNELS.stopRoom, async (_event, chatId: unknown) => ({ stopped: typeof chatId === "string" && chatId ? (await stopRoomConversation(chatId)).stopped : false }));
}
