// "The owner wrote the message that started this turn (or was added to it)" — a positive fact, minted where the owner's own words enter (Agentlas 2.0
// §12-3; repaired by the marker used to be missing at the personal agent's screen, at the owner's added directions and in a group room, and it
// broke the comparison of a steer with the turn the background service holds).
//
// Personal memory is the owner's. Only a turn that the owner started with a message of their own may add a line to it. The fact is NOT derived from a list of
// what a turn is not (an automation run, a ledger conversation, a synthesised answer, a mention chain, a cross-session message, a check-in, a restart resume,
// a hub call, a harness-opened turn, a team member's turn — a new kind of host-started turn would be missed by any such list). It is a marker the entry points
// of the owner's own channels set, and nothing else does:
//   - the desktop composer (ipc.ts startRendererInvocation; an app-control agent calling the same channel does NOT count),
//   - the owner's direction added to a chat (ipc.ts steerFromRenderer, a phone's `invoke.steer`; a decision/card answer picks an option and is not a message),
//   - the owner's text typed into a RUNNING turn (InvocationService.steerCurrentTurn -> noteOwnerSteer: the turn is then one the owner added a message to),
//   - the personal agent's screen (one/supervisor-service.ts send(): the reply turn answers a sealed owner message; the fact rides in the persisted dispatch
//     frame, so a start sent again after a refusal is byte-identical, and a frame written before this build has none),
//   - the paired phone's message (mobile-bridge/authority.ts one.invoke.start / invoke.start, not a card answer, not a Hub call),
//   - the paired Telegram chat's message, from the paired person only (telegram/connect.ts),
//   - a group room's turn that answers the owner's own line (one/room-lead-router.ts: the first turns of a request; a turn another member started with an `@` is not).
// The marker is Main-only like `hostRecovery`: it is not a field of the shared request type (the generated app-control schemas stay as they are), a window cannot
// send it (ipc.ts strips it), the steering projection leaves it out (native-owner-text.ts) and the comparison of a steer with the turn it joins ignores it
// (native-gui-owner.ts). A request the host builds again from an owner's (a login / permission / update successor) drops it (service.ts successorRequestFrom).
// At the point of use (mcp/client.ts) it is believed unless the turn is a host recovery, an Agent App or a team report.
import type { McpInvocationRequest } from "../../shared/types";

export type OwnerSpokeRequest = McpInvocationRequest & { ownerSpoke?: true };

/**
 * Sets the marker on a request the owner's own channel built. A system-authored prompt, an Agent App request or a team report is never the owner's words, unless
 * the caller says the turn ANSWERS a sealed owner message (`answersOwnerMessage`: the personal agent's reply turn and a group room's turn are system-origin by
 * design, and the host-composed prompt carries the owner's line).
 */
export function markOwnerSpoke<T extends McpInvocationRequest>(request: T, options: { answersOwnerMessage?: boolean } = {}): T {
  if (request.agentAppMode === true || request.oneTeamReportTurn === true) return request;
  if (request.promptOrigin === "system" && options.answersOwnerMessage !== true) return request;
  (request as OwnerSpokeRequest).ownerSpoke = true;
  return request;
}

/** The marker's request-sized copy, for a canonical form that must match the one a marked start computes. */
export function markedOwnerSpokeCopy<T extends McpInvocationRequest>(request: T): T {
  return markOwnerSpoke({ ...request });
}

// Runs the owner added a message to while they were running (InvocationService.steerCurrentTurn). Bounded: a long session never grows it.
const OWNER_STEERED_RUN_CAP = 256;
const ownerSteeredRuns = new Set<string>();
export function noteOwnerSteer(runId: string | null | undefined): void {
  if (typeof runId !== "string" || !runId) return;
  ownerSteeredRuns.delete(runId);
  ownerSteeredRuns.add(runId);
  while (ownerSteeredRuns.size > OWNER_STEERED_RUN_CAP) {
    const oldest = ownerSteeredRuns.values().next().value as string | undefined;
    if (oldest === undefined) break;
    ownerSteeredRuns.delete(oldest);
  }
}
export function ownerSteeredRun(runId: string | null | undefined): boolean { return typeof runId === "string" && ownerSteeredRuns.has(runId); }

/** The turn's `ownerSpoke`: the marker (or an owner direction added to the running turn), still true of this turn. */
export function ownerSpokeOfTurn(request: McpInvocationRequest, turn: { hostRecovery: boolean; hostNoticePurpose?: string | null }): boolean {
  // A host-written continuation (goal continuation, update resume, check-in, review) is never the owner's message. A host brief row (`one-dispatch-brief`: the
  // group room's turn that answers the owner's line, a delegated brief) is not a reason by itself: the marker is minted only where the owner's words enter.
  const hostContinuation = Boolean(turn.hostNoticePurpose) && turn.hostNoticePurpose !== "one-dispatch-brief";
  return ((request as OwnerSpokeRequest).ownerSpoke === true || ownerSteeredRun(request.runId))
    && request.agentAppMode !== true && request.oneTeamReportTurn !== true
    && !turn.hostRecovery && !hostContinuation;
}

/**
 * The owner's own words of this turn, or null when the prompt is not theirs. A prompt typed in a composer (promptOrigin other than "system") is the owner's text. The personal agent's reply turn is system-origin by design but
 * ANSWERS a sealed owner message and carries it as the whole prompt (one/supervisor-service.ts: `userPrompt: payload.text`), so it is the owner's text when the owner-spoke marker stands and no host notice composed the prompt.
 * A group room's turn is a host brief (`one-dispatch-brief`: the owner's line is only part of it), so it stays null: a quote could then match a word another member wrote.
 */
export function ownerWordsOfTurn(request: McpInvocationRequest, turn: { ownerSpoke: boolean; hostNoticePurpose?: string | null }): string | null {
  if (typeof request.userPrompt !== "string") return null;
  if (request.promptOrigin !== "system") return request.userPrompt;
  return turn.ownerSpoke && !turn.hostNoticePurpose ? request.userPrompt : null;
}
