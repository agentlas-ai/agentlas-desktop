/**
 * The Goal custodian's half of a forwarded Alive action (NH21). The background service owns the Alive clock and
 * reserved the action; the window process owns Goal custody and runs the effect. Nothing the service sent is trusted
 * beyond the action id: the exact `executing` reservation, its packet, the life's epoch and the attachment are re-read
 * from the shared store, then the same GoalAlivePlayground.execute() runs with the custodian's own Goal deps.
 * execute() claims the action id durably before the side effect and settles a receipt, so a repeated or late request
 * replays that receipt: the effect happens at most once. No electron import.
 */
import type Database from "better-sqlite3";
import { AliveLifetimeStore } from "../alive-core/lifetime-store";
import type { AliveActionPacket, AliveActionResult } from "../alive-core/contracts";
import type { GoalAlivePlayground } from "./goal-playground";

export type CustodianActionAnswer = { ok: true; result: AliveActionResult } | { ok: false; error: string };
type Custodian = Pick<GoalAlivePlayground, "execute" | "refuse" | "actionStarted">;

export function executeCustodianAliveAction(input: {
  db: Database.Database;
  domain: unknown;
  actionId: unknown;
  /** True only while a live background service (not this process) holds the Alive domain. */
  ownerIsService(): boolean;
  playground(domain: "work" | "one"): Custodian;
  now?(): number;
}): CustodianActionAnswer {
  const { db } = input;
  const now = input.now ?? Date.now;
  if ((input.domain !== "work" && input.domain !== "one") || typeof input.actionId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.actionId)) {
    return { ok: false, error: "alive_action_request_invalid" };
  }
  const domain = input.domain, actionId = input.actionId;
  if (!input.ownerIsService()) return { ok: false, error: "alive_action_owner_mismatch" };
  const row = db.prepare("SELECT agent_id,control_epoch,status,packet_json FROM alive_actions WHERE action_id=?").get(actionId) as
    { agent_id: string; control_epoch: number; status: string; packet_json: string | null } | undefined;
  if (!row || row.status !== "executing" || !row.packet_json) return { ok: false, error: "alive_action_not_executing" };
  let packet: AliveActionPacket;
  try { packet = JSON.parse(row.packet_json) as AliveActionPacket; } catch { return { ok: false, error: "alive_action_packet_invalid" }; }
  if (!packet || packet.actionId !== actionId || packet.domain !== domain || !packet.scope || typeof packet.scope !== "object") {
    return { ok: false, error: "alive_action_packet_invalid" };
  }
  const custodian = input.playground(domain);
  // A dispatch that already started here is replayed through execute(): it replays a settled receipt, or its own run
  // fence decides whether the earlier attempt crossed (stale) or never reached the Goal. Never refused afterwards.
  const started = custodian.actionStarted(actionId);
  const recorded = { attachmentId: packet.attachmentId, agentId: row.agent_id, domain, status: "detached" as const, scope: packet.scope };
  const refuseOrReplay = (code: string): CustodianActionAnswer => ({ ok: true,
    result: started ? custodian.execute(recorded, packet, now()) : custodian.refuse(packet, code, now()) });
  const lives = new Set((db.prepare("SELECT agent_id FROM alive_organism_lives WHERE organism=?").all(domain) as Array<{ agent_id: string }>)
    .map((life) => life.agent_id));
  if (!lives.has(row.agent_id)) return refuseOrReplay("alive.action-life-unknown");
  const store = new AliveLifetimeStore(db, { initializeSchema: false, agentScope: (agentId) => lives.has(agentId) });
  const agent = store.get(row.agent_id);
  if (!agent || agent.status !== "enabled" || agent.controlEpoch !== row.control_epoch) return refuseOrReplay("alive.action-admission-changed");
  const attachment = store.attachments(row.agent_id).find((item) => item.attachmentId === packet.attachmentId && item.status === "attached");
  if (!attachment || attachment.domain !== domain || JSON.stringify(attachment.scope) !== JSON.stringify(packet.scope)) {
    return refuseOrReplay("alive.action-attachment-changed");
  }
  return { ok: true, result: custodian.execute(attachment, packet, now()) };
}
