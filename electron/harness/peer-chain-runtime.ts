import { getDb } from "../store/db";
import { stopChainsOfRun, stopPeerChain, type PeerChainStopPorts, type PeerChainStopReport } from "./peer-chain-stop";
import { cancelQueuedSteersOfChain, countQueuedSteersOfChain } from "../store/invocation-steers";
import { openLeadRequests } from "../runtime/session-scope";

/*
 * Production wiring of the Stop of a chain of messages between conversations (harness/peer-chain-stop.ts). Lazy requires: this file is
 * loaded from the owner's Stop path and from the room router's cancel, both of which must stay cheap and must never throw.
 */

export function productionPeerChainStopPorts(): PeerChainStopPorts {
  return {
    db: getDb(),
    async cancelRun(runId) {
      try {
        // The same cancel the window and the phone use, without the teammate-job bookkeeping: this process or the other one, wherever the run is held.
        const control = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control"); // eslint-disable-line @typescript-eslint/no-require-imports
        return await control.cancelInvocationOwnerRun(runId, { dispatchBookkeeping: false });
      } catch { return "unavailable"; }
    },
    cancelQueued: cancelQueuedSteersOfChain,
    queuedLeft: countQueuedSteersOfChain,
    roomsOfChain: (chainId) => openLeadRequests(getDb()).filter((entry) => entry.chain === chainId).map((entry) => entry.chatId),
    async stopRoom(roomChatId) {
      try { return await (require("../one/room-lead-runtime") as typeof import("../one/room-lead-runtime")).stopLeadRoomWhereHeld(roomChatId); } // eslint-disable-line @typescript-eslint/no-require-imports
      catch { return false; }
    },
  };
}

/** The owner's Stop of a run: every chain of messages between conversations that run belongs to stops. Never throws. */
export function stopPeerChainsOfRun(runId: string): Promise<PeerChainStopReport[]> {
  try { return stopChainsOfRun(runId, productionPeerChainStopPorts()); } catch { return Promise.resolve([]); }
}
export function stopPeerChainById(chainId: string): Promise<PeerChainStopReport> {
  return stopPeerChain(chainId, productionPeerChainStopPorts());
}
