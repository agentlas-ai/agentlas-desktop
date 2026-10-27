/** Final execution ceiling, applied after every caller-specific permission policy. */
export function effectiveInvocationPermission(
  permission: unknown,
  planMode: boolean | undefined,
): "read" | "write" | "full" {
  if (planMode === true) return "read";
  return permission === "write" || permission === "full" ? permission : "read";
}

export type OnePermissionSelection = "auto" | "read" | "write" | "full";

// Auto resolves to read (conversation) or write (task), so it sits between them: never wider than write,
// never narrower than read. Anything unrecognised counts as read.
const ONE_PERMISSION_RANK: Record<OnePermissionSelection, number> = { read: 0, auto: 1, write: 2, full: 3 };
function onePermissionSelection(value: unknown): OnePermissionSelection {
  return value === "auto" || value === "write" || value === "full" ? value : "read";
}

/**
 * The narrower of two One permission selections. A turn the host starts on its own (continuation, automatic
 * retry, clarification, decision answer) may keep the authority its source run had, but never more than the
 * owner's current permission chip: lowering the chip must take effect on the next system turn too.
 */
export function narrowerOnePermission(a: unknown, b: unknown): OnePermissionSelection {
  const left = onePermissionSelection(a), right = onePermissionSelection(b);
  return ONE_PERMISSION_RANK[left] <= ONE_PERMISSION_RANK[right] ? left : right;
}

/** The asking run as Main's receipt states it: its authority and whether it carried an owner message. */
export interface OwnerAnswerAskingRun {
  executionPermission?: unknown;
  /** Main's ledger marker: true = the run started from an owner message, false = a host-written turn. */
  ownerAuthored?: unknown;
}

/**
 * The authority of the turn an owner's tap on a question card starts.
 *
 * The tap is the owner's own input, like a typed message. When the question came from an owner turn, the answer keeps
 * that turn's authority under the chip as it is now (unchanged). When it came from a host-written turn (a teammate
 * report, a room follow-up, an observation or recovery episode), that turn's narrow authority was the host's choice for
 * its input, not the owner's: the answer takes the owner's chip, exactly as a typed message would. Yotube 2026-10-25
 * 07:23:41Z: a read-only teammate-notes turn (a003d2e1) asked "switch to execute permission?"; the owner tapped it with
 * the chip on Full access, and the answer turn (0e30dcb7) still ran read and was denied browser actions.
 * A receipt from an older Main keeps its original permission inheritance. Missing run authority closes to read.
 */
export function ownerAnswerOnePermission(chip: unknown, asking: OwnerAnswerAskingRun | null | undefined): OnePermissionSelection {
  if (!asking) return narrowerOnePermission(chip, "read");
  if (asking.ownerAuthored === false) return onePermissionSelection(chip);
  return narrowerOnePermission(chip, asking.executionPermission ?? "read");
}

/**
 * The same rule where no chip is in hand (an answer from the phone): the owner's own last turn stands in for the chip,
 * as it does for an owner's text whose turn went away (ipc invoke:steerCurrentTurn, latestOwnerReceipt).
 */
export function ownerAnswerExecutionPermission(
  asking: OwnerAnswerAskingRun | null | undefined,
  ownerLatest: { executionPermission?: unknown } | null | undefined,
): "read" | "write" | "full" {
  const execution = (value: unknown) => value === "write" || value === "full" ? value : "read";
  if (!asking) return "read";
  return execution(asking.ownerAuthored === false ? ownerLatest?.executionPermission : asking.executionPermission);
}
