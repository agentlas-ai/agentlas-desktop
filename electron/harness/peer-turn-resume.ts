import { peerChainOfRequest, type PeerChainMark } from "./peer-chain";
import type { McpInvocationRequest } from "../../shared/types";

/*
 * A turn another conversation's message opened that a restart cut short is continued once, inside its chain (Agentlas 2.0 N7, section P4).
 *
 * What exists already and is read here (no table, no column): the message's `invocation_steers` row (status `started`, kept 14 days) holds the
 * envelope the turn read, its chain mark, its permission and the run it opened (`drained_run_id`). What was missing is a "continued once" mark:
 * it is the row's own `recovery_reason`, written by one compare-and-set so that Main and the background service looking at the same moment start
 * the turn once. A turn that is cut again is not continued again (the sender sends again if it still needs the answer).
 *
 * Cut means the run's receipt has no terminal line (the process was killed) or ended with the host's own cause (app closed, update restart).
 * A completed, failed, cancelled or owner-stopped turn is never touched. Skipped, each with its machine reason: the conversation is gone or
 * archived, a turn of it lives, another run started in it since, the owner wrote in it since, the chain was stopped or has no row any more.
 * The continued turn carries the stored request unchanged (the envelope, the permission as it was, the chain mark) under a new run id with the
 * earlier-attempt line; permissions granted for "this task only" or "this once" lived in memory and are asked again.
 */

/** The `invocation_steers.recovery_reason` of a started row whose turn was continued (the mark that makes it once). */
export const PEER_TURN_RESUMED_REASON = "peer-turn-resumed";
/** A turn cut longer ago than this is not continued (the update ledger's own age limit). */
export const PEER_TURN_RESUME_MAX_AGE_MS = 24 * 60 * 60_000;

export interface PeerResumeCandidate {
  id: string;
  chatId: string;
  /** The run the message opened (the cut one). */
  drainedRunId: string;
  updatedAt: string;
  request: McpInvocationRequest;
  workspaceBinding?: unknown;
  executionContext?: unknown;
}
export interface PeerResumeReceipt { status: string; hostStopCause?: string | null; updatedAt: string }

export interface PeerResumePorts {
  now(): number;
  candidates(sinceIso: string, chatId?: string): PeerResumeCandidate[];
  chatUsable(chatId: string): boolean;
  /** A turn of this conversation lives (a lease anywhere, a run in this process). */
  chatLive(chatId: string): boolean;
  receipt(runId: string): PeerResumeReceipt | null;
  /** Another run started in the conversation after the cut one. */
  startedAfter(chatId: string, runId: string): boolean;
  /** The owner wrote in the conversation after this time. */
  ownerSpokeAfter(chatId: string, sinceIso: string): boolean;
  chain(chainId: string): "live" | "stopped" | "missing";
  /** The cut run leaves the chain's list of running turns. */
  clearLive(chain: PeerChainMark, runId: string, chatId: string): void;
  /** Compare-and-set: true for exactly one caller. */
  claim(rowId: string): boolean;
  /** Undo the claim of a start that was refused before anything ran. */
  unclaim(rowId: string): void;
  newRunId(): string;
  start(request: McpInvocationRequest, candidate: PeerResumeCandidate): void;
  log(line: string): void;
}

export interface PeerResumeReport { examined: number; resumed: number; skipped: Record<string, number> }

/** The cut of a receipt: no terminal line, or the host's own stop cause. Completed, failed, cancelled and waiting turns are not cut. */
export function peerTurnWasCut(receipt: PeerResumeReceipt | null): boolean {
  if (!receipt) return false;
  if (receipt.hostStopCause === "app_closed" || receipt.hostStopCause === "update_restart") return true;
  return receipt.status === "interrupted" && !receipt.hostStopCause;
}

export function resumeInterruptedPeerTurns(ports: PeerResumePorts, chatId?: string): PeerResumeReport {
  const report: PeerResumeReport = { examined: 0, resumed: 0, skipped: {} };
  const skip = (reason: string): void => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };
  const since = new Date(ports.now() - PEER_TURN_RESUME_MAX_AGE_MS).toISOString();
  let rows: PeerResumeCandidate[] = [];
  try { rows = ports.candidates(since, chatId); } catch (error) { ports.log(`[peer-resume] candidates unreadable: ${error instanceof Error ? error.message : "unknown"}`); return report; }
  for (const row of rows) {
    report.examined += 1;
    try {
      const chain = peerChainOfRequest(row.request);
      if (!chain) { skip("no_chain_mark"); continue; }
      const receipt = ports.receipt(row.drainedRunId);
      if (!peerTurnWasCut(receipt)) { skip(receipt ? "not_cut" : "no_receipt"); continue; }
      // The run is over whatever happens next: it no longer counts as a running turn of its chain (a Stop must not look for it).
      ports.clearLive(chain, row.drainedRunId, row.chatId);
      const state = ports.chain(chain.id);
      if (state === "stopped") { skip("chain_stopped"); continue; }
      if (state === "missing") { skip("chain_missing"); continue; }
      if (!ports.chatUsable(row.chatId)) { skip("chat_gone_or_archived"); continue; }
      if (ports.chatLive(row.chatId)) { skip("chat_live"); continue; }
      if (ports.startedAfter(row.chatId, row.drainedRunId)) { skip("run_started_since"); continue; }
      if (receipt && ports.ownerSpokeAfter(row.chatId, receipt.updatedAt)) { skip("owner_spoke_since"); continue; }
      if (!ports.claim(row.id)) { skip("claimed_by_another"); continue; }
      const runId = ports.newRunId();
      try {
        ports.start({ ...row.request, runId } as McpInvocationRequest, row);
      } catch (error) {
        ports.unclaim(row.id);
        skip("start_refused");
        ports.log(`[peer-resume] start refused chat=${row.chatId} code=${(error as { code?: string } | null)?.code ?? "none"}: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
        continue;
      }
      report.resumed += 1;
      ports.log(`[peer-resume] continued a peer turn cut by a restart chat=${row.chatId} chain=${chain.id} run=${runId}`);
    } catch (error) {
      skip("error");
      ports.log(`[peer-resume] row not examined: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return report;
}
