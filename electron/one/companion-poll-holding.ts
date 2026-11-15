import type Database from "better-sqlite3";
import { COMPANION_POLL_HOLDING_MAX, type CompanionPollLane } from "../../shared/companion-poll-holding";

/** direct-work-capacity R5: the list a signed poll sends as `holding` is read from ONE place - the durable rows of this Desktop's own store - on every poll. Nothing about a
 * task is remembered in memory for it, so a restart, a crash or a row written by the background service in the same file changes nothing about what is held.
 * Held = a command this registration received (the Work / front turn row exists) and whose closing receipt has not been delivered (no delivery row / confirmation row).
 * "Delivered" is exactly what the delivery lanes write: `one_companion_work_delivery` (recorded | existing | settled | HTTP 403 - companion-work-delivery.ts) and
 * `one_companion_front_delivery_acks` (companion-front-gui-runtime.ts `deliver`). Unstarted, running, ended-and-not-yet-delivered (a retry waiting too) are all held.
 * `null` = the store could not be read: the caller sends the v1 poll (it closes nothing on the service), never an empty list - an empty list is a statement that nothing is held. */
type Candidate = { id: string; live: boolean; seq: number };
const DIRECT_METHOD = "one.work-handoff.send.v1";
const FRONT_METHOD = "one.front-turn.send.v1";
// Request states of a Work that has not ended; a front turn row is live until it is `terminal`.
const WORK_LIVE = new Set(["stored", "dispatching", "accepted", "held"]);
const tableExists = (db: Database.Database, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export type PollHoldingTarget = { userId: string; deviceId: string; hostId: string; oneId: string };
/** A store, or the call that opens the current one (`getDb()` can throw while the store is being replaced: that is "cannot be read", not "empty"). */
export type PollStore = Database.Database | (() => Database.Database);
const open = (store: PollStore): Database.Database => (typeof store === "function" ? store() : store);

/** At most 24, strictly ascending: a service holds at most 24 physical rows (R1), so more than that cannot all be alive there. When more are undelivered (a delivery that
 * keeps failing while the service deleted the rows it closed), the ones that are not ended come first (an ended one that is dropped only costs the phone its result; a
 * running one that is dropped is closed by the service), then the newest. The returned `dropped` is the count left out. */
export function composeHolding(candidates: readonly Candidate[]): { holding: string[]; dropped: number } {
  const unique = new Map<string, Candidate>();
  for (const c of candidates) { const old = unique.get(c.id); if (!old || (c.live && !old.live)) unique.set(c.id, c); }
  const all = [...unique.values()].sort((a, z) => Number(z.live) - Number(a.live) || z.seq - a.seq);
  const kept = all.slice(0, COMPANION_POLL_HOLDING_MAX).map(c => c.id).sort((a, z) => (a < z ? -1 : a > z ? 1 : 0));
  return { holding: kept, dropped: all.length - kept.length };
}

const same = (b: Record<string, unknown>, t: PollHoldingTarget, method: string) =>
  b.method === method && b.userId === t.userId && b.deviceId === t.deviceId && b.hostId === t.hostId && b.oneId === t.oneId;
function parse(json: string): Record<string, unknown> | null { try { const v: unknown = JSON.parse(json); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; } }

let warnedDropped = 0;
function note(dropped: number): void {
  if (dropped > 0 && dropped !== warnedDropped) { warnedDropped = dropped; try { console.warn(`[companion-poll] ${dropped} held command(s) are not listed: more than ${COMPANION_POLL_HOLDING_MAX} are undelivered`); } catch { /* no log sink */ } }
}

/** The `holding` of a direct-work poll for this registration, or null when the store cannot be read. */
export function readDirectHolding(store: PollStore, target: PollHoldingTarget): string[] | null {
  try {
    const db = open(store);
    if (!tableExists(db, "one_companion_handoffs")) return [];
    const delivered = tableExists(db, "one_companion_work_delivery");
    const rows = db.prepare(`SELECT h.rowid AS seq,h.command_id,h.binding_json,r.state FROM one_companion_handoffs h LEFT JOIN one_supervisor_requests r ON r.command_id=h.command_id
      ${delivered ? "WHERE NOT EXISTS (SELECT 1 FROM one_companion_work_delivery d WHERE d.command_id=h.command_id)" : ""}`).all() as Array<{ seq: number; command_id: string; binding_json: string; state: string | null }>;
    const out: Candidate[] = [];
    for (const row of rows) { const b = parse(row.binding_json); if (b && b.commandId === row.command_id && same(b, target, DIRECT_METHOD)) out.push({ id: row.command_id, live: row.state === null || WORK_LIVE.has(row.state), seq: row.seq }); }
    const { holding, dropped } = composeHolding(out); note(dropped); return holding;
  } catch { return null; }
}

/** The `holding` of a front poll for this registration (the front's own turns), or null when the store cannot be read. */
export function readFrontHolding(store: PollStore, target: PollHoldingTarget): string[] | null {
  try {
    const db = open(store);
    if (!tableExists(db, "one_companion_front_turns")) return [];
    const acked = tableExists(db, "one_companion_front_delivery_acks");
    const rows = db.prepare(`SELECT t.rowid AS seq,t.command_id,t.binding_json,t.state FROM one_companion_front_turns t
      ${acked ? "WHERE NOT EXISTS (SELECT 1 FROM one_companion_front_delivery_acks a WHERE a.command_id=t.command_id AND a.run_id=t.run_id)" : ""}`).all() as Array<{ seq: number; command_id: string; binding_json: string; state: string }>;
    const out: Candidate[] = [];
    for (const row of rows) { const b = parse(row.binding_json); if (b && b.commandId === row.command_id && same(b, target, FRONT_METHOD)) out.push({ id: row.command_id, live: row.state !== "terminal", seq: row.seq }); }
    const { holding, dropped } = composeHolding(out); note(dropped); return holding;
  } catch { return null; }
}

/** Does this store already hold the command (R8's last line: a command received once is never claimed again)? A store that cannot be read answers false: the claim is idempotent on the service (`existing`). */
export function localHoldsCommand(store: PollStore, lane: CompanionPollLane, commandId: string): boolean {
  try {
    const db = open(store);
    const table = lane === "direct" ? "one_companion_handoffs" : "one_companion_front_turns";
    return tableExists(db, table) && !!db.prepare(`SELECT 1 FROM ${table} WHERE command_id=?`).get(commandId);
  } catch { return false; }
}

/** What one service answered to a v2 poll, per lane and origin (memory of the process; at most 8 entries - there is one service). "v1": a v2 poll was refused (403) while the
 * v1 poll of the same signature key and challenge was taken - an older service (before web W8b) that does not read `holding`; its polls stay v1 until the app restarts. */
const versions = new Map<string, "v1">();
export const pollVersion = {
  isV1(lane: CompanionPollLane, origin: string): boolean { return versions.get(`${lane}|${origin}`) === "v1"; },
  noteV1(lane: CompanionPollLane, origin: string): void { versions.delete(`${lane}|${origin}`); versions.set(`${lane}|${origin}`, "v1"); while (versions.size > 8) versions.delete(versions.keys().next().value as string); },
  reset(): void { versions.clear(); },
};
