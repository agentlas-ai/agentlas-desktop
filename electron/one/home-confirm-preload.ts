/*
 * The preload of the confirmation window (home-confirm-window-real.ts) and of nothing else. It opens the three confirm channels, the three review-window channels (kind reviewWaiting) and the "two minutes ended" signal,
 * not the owner window's API (preload.ts is not loaded here). The sandbox lets a preload require only `electron`, so nothing is imported but its types.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { OneHomeConfirmBridge } from "../../shared/one-home-confirm";

const bridge: OneHomeConfirmBridge = {
  view: () => ipcRenderer.invoke("oneHome:confirmView"),
  approve: (requestId, answer) => ipcRenderer.invoke("oneHome:confirmApprove", answer === "no" ? { requestId, answer } : { requestId }),
  cancel: (requestId) => ipcRenderer.invoke("oneHome:confirmCancel", { requestId }),
  waiting: {
    list: (requestId) => ipcRenderer.invoke("oneHome:confirmWaitingList", { requestId }),
    item: (requestId, list, id) => ipcRenderer.invoke("oneHome:confirmWaitingItem", { requestId, list, id }),
    decide: (requestId, decision, selection) => ipcRenderer.invoke("oneHome:confirmWaitingDecide", { requestId, decision, selection }),
  },
  onExpired: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on("oneHomeConfirm:expired", wrapped);
    return () => { ipcRenderer.removeListener("oneHomeConfirm:expired", wrapped); };
  },
};
contextBridge.exposeInMainWorld("oneHomeConfirm", bridge);
