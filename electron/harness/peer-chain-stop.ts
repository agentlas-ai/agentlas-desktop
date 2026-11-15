import { markPeerChainStopped, peerChainIdForRun, peerChainRowExists, PEER_CHAIN_KEY_PREFIX, type PeerChainStopTargets } from "./peer-chain";

/*
 * The owner's Stop of a chain of messages between conversations (Agentlas 2.0 N6; the rule: pressing Stop in ANY conversation of the
 * chain stops the whole chain, and nothing else is looked at first).
 *
 *   1. mark the chain stopped (one row, unconditional: no holder, lease or live run is needed) - every later delivery is refused
 *   2. cancel what is lined up: every waiting message of the chain (invocation_steers rows whose request carries the chain)
 *   3. cancel what runs: the chain's live turns and its origin turn, wherever they are held (this process or the other one)
 *   4. stop the group-room requests the chain opened (their open-request rows carry the chain), here or in the other process
 *   5. read again: waiting messages of the chain are now 0, or the report says how many are left
 * A Stop that finds nothing (the owner stopped a turn that never sent a message) costs one keyed read.
 */

export interface PeerChainStopPorts {
  db: Parameters<typeof markPeerChainStopped>[0];
  /** Cancels a run wherever it is held; resolves with what was found. Never throws. */
  cancelRun(runId: string): Promise<"requested" | "already-requested" | "not-found" | "unavailable">;
  /** Cancels the chain's waiting messages. Returns how many. */
  cancelQueued(chainId: string): number;
  /** How many waiting messages of the chain remain (read after the cancel). */
  queuedLeft(chainId: string): number;
  /** The rooms whose open request belongs to this chain. */
  roomsOfChain(chainId: string): string[];
  /** Stops a room's request wherever it is held. Never throws. */
  stopRoom(roomChatId: string): Promise<boolean>;
}

export interface PeerChainStopReport { chainId: string; found: boolean; cancelledRuns: number; cancelledQueued: number; rooms: number; queuedLeft: number }

const stopping = new Set<string>();

export async function stopPeerChain(chainId: string, ports: PeerChainStopPorts): Promise<PeerChainStopReport> {
  const report: PeerChainStopReport = { chainId, found: false, cancelledRuns: 0, cancelledQueued: 0, rooms: 0, queuedLeft: 0 };
  // A cancel below can come back through the owner's Stop path (a run of the chain is a room's request, a room Stop ends its chain): once is enough.
  if (stopping.has(chainId)) return report;
  stopping.add(chainId);
  try {
    const targets: PeerChainStopTargets | null = markPeerChainStopped(ports.db, chainId);
    if (!targets) return report;
    report.found = true;
    try { report.cancelledQueued = ports.cancelQueued(chainId); } catch { /* read again below */ }
    const runs = [...new Set([targets.origin.runId, ...targets.live.map((live) => live.runId)].filter(Boolean))];
    for (const runId of runs) {
      try { const outcome = await ports.cancelRun(runId); if (outcome === "requested") report.cancelledRuns += 1; } catch { /* the others go on */ }
    }
    try {
      for (const room of ports.roomsOfChain(chainId)) { if (await ports.stopRoom(room)) report.rooms += 1; }
    } catch { /* the others go on */ }
    // A cancelled turn can settle and let a waiting message start in the same moment the first pass ran: once more, then read.
    try { report.cancelledQueued += ports.cancelQueued(chainId); } catch { /* read below */ }
    try { report.queuedLeft = ports.queuedLeft(chainId); } catch { report.queuedLeft = -1; }
    return report;
  } finally { stopping.delete(chainId); }
}

/** The chains a run belongs to: the one it started (the id is derived from its run id: one keyed read) and the ones that list it as a live turn. */
export function chainsOfRun(db: PeerChainStopPorts["db"], runId: string): string[] {
  const found = new Set<string>();
  const own = peerChainIdForRun(runId);
  if (peerChainRowExists(db, own)) found.add(own);
  try {
    const rows = db.prepare("SELECT key AS k FROM meta WHERE key LIKE ? AND instr(value, ?) > 0").all(`${PEER_CHAIN_KEY_PREFIX}%`, `"${runId}"`) as Array<{ k: string }>;
    for (const row of rows) found.add(row.k.slice(PEER_CHAIN_KEY_PREFIX.length));
  } catch { /* the keyed read above is what a chain's own origin needs */ }
  return [...found];
}

/** The owner's Stop of a run: stops every chain the run belongs to. Resolves when each chain's pass has finished. Never throws. */
export async function stopChainsOfRun(runId: string, ports: PeerChainStopPorts): Promise<PeerChainStopReport[]> {
  const reports: PeerChainStopReport[] = [];
  try { for (const id of chainsOfRun(ports.db, runId)) reports.push(await stopPeerChain(id, ports)); } catch { /* a Stop is never held up by this */ }
  return reports;
}
