/**
 * What a room's mention chips and pickers call a participant.
 *
 * A seat in the owner's organisation has a display name the owner chose ("Motiondirector"). The installed agent behind
 * it has its own name ("Agentlas Startup Founder Studio"). Rooms show the seat's name whenever it is set; the installed
 * agent's name is only the fallback for an agent that has no seat.
 */
export interface SeatNameSource { installedAgentId: string; displayName?: string | null; archivedAt?: string | null }

export function seatDisplayName(
  agentId: string,
  members: readonly SeatNameSource[] | null | undefined,
  installedAgentName: string,
): string {
  const seat = members?.find((member) => member.installedAgentId === agentId && !member.archivedAt);
  const chosen = seat?.displayName?.trim();
  return chosen ? chosen : installedAgentName;
}

/** The per-turn chip row only says something when it differs from the room's own roster. */
export function turnAgentsDifferFromRoster(turnAgentIds: readonly string[], rosterAgentIds: readonly string[] | null | undefined): boolean {
  if (!rosterAgentIds) return turnAgentIds.length > 0;
  if (turnAgentIds.length !== rosterAgentIds.length) return true;
  return turnAgentIds.some((id) => !rosterAgentIds.includes(id));
}
