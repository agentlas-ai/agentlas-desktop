import { createHash } from "node:crypto";

/** The signed poll of a registered Desktop (direct-work-capacity R5, poll v2; the service's side is web `companion-direct-work-auth.mjs` / `companion-direct-front-auth.mjs`).
 * v2 also signs `holding`: the commands this registration received and has not yet delivered a closing receipt for. The signed text carries sha256 of the list's JSON, so the
 * service reads a list only as signed; the list's form is checked there too (a list that is not strictly ascending / has a repeat / is longer than the cap makes the WHOLE poll
 * refused, even with a right signature), so the form is made in one place: here. */
export type CompanionPollLane = "direct" | "front";
export const COMPANION_POLL_HOLDING_MAX = 24;   // the service's HOLDING_MAX (the journal keeps at most 24 physical rows: direct-work-capacity R1)
const ROW_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const DOMAIN: Record<CompanionPollLane, string> = {
  direct: "agentlas.companion.desktop-direct.poll",
  front: "agentlas.companion.front-direct.poll",
};

/** true = a list the service accepts: an array of at most 24 command ids, strictly ascending by JS string order (UTF-16 code units; the ids are ASCII), so no repeat. */
export function isCompanionPollHolding(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > COMPANION_POLL_HOLDING_MAX) return false;
  for (let i = 0; i < value.length; i += 1) {
    const id: unknown = value[i];
    if (typeof id !== "string" || !ROW_ID.test(id)) return false;
    if (i > 0 && !((value[i - 1] as string) < id)) return false;
  }
  return true;
}

/** The exact UTF-8 bytes a poll signs: `[domain.v1, userId, deviceId, hostId, oneId, challenge]`, or with a holding list `[domain.v2, ..., challenge, sha256hex(JSON(holding))]`. */
export function companionPollBytes(lane: CompanionPollLane, value: { userId: string; deviceId: string; hostId: string; oneId: string; challenge: string }, holding?: readonly string[]): Buffer {
  const head = [value.userId, value.deviceId, value.hostId, value.oneId, value.challenge];
  if (holding === undefined) return Buffer.from(JSON.stringify([`${DOMAIN[lane]}.v1`, ...head]), "utf8");
  if (!isCompanionPollHolding(holding)) throw new TypeError("companion_poll_holding_invalid");
  return Buffer.from(JSON.stringify([`${DOMAIN[lane]}.v2`, ...head, createHash("sha256").update(JSON.stringify(holding), "utf8").digest("hex")]), "utf8");
}
