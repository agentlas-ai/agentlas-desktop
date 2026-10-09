import { appendChatMessage } from "./chats";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { createCurrentTurnSteerStore } from "./current-turn-steer-core";

const store = createCurrentTurnSteerStore({
  getDb,
  appendUserMessage: (chatId, text) => appendChatMessage(chatId, "user", text),
  onChange: (chatId) => emitDesktopStoreChange({ entity: "chat", id: chatId }),
});

export const validateCurrentTurnSteer = store.validateCurrentTurnSteer;
export const existingCurrentTurnSteer = store.existingCurrentTurnSteer;
export const getCurrentTurnSteer = store.getCurrentTurnSteer;
export const claimCurrentTurnSteer = store.claimCurrentTurnSteer;
export const settleCurrentTurnSteer = store.settleCurrentTurnSteer;
export const takeCurrentTurnSteers = store.takeCurrentTurnSteers;
export const countPendingCurrentTurnSteers = store.countPendingCurrentTurnSteers;
